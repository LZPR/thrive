/**
 * desc.js · 「统一使用世界书」模式下的角色描述存储
 *
 * 旧的 card 模式把描述写在角色卡的 `description` 字段里（targets.js 的
 * saveDescription / cardDescription）。这个模式换了个落点：
 *
 *   角色描述 = 「与角色同名的世界书」里一条标题为 `【角色描述】` 的**常驻**条目
 *
 * 为什么是常驻：ST 的世界书只扫关键词，而"人物描述"必须每轮都在，否则角色会
 * 忘掉自己是谁。为什么塞进世界书而不是另建一份文件：世界书本身就是"一本可以
 * 存很多条目、各自带条件"的容器，插件没必要再维护第二套存储与第二套界面。
 *
 * 三条约束，别在别处再判一遍：
 *   1. 条目对模型侧的 lore_* 工具不可见、不可改（targets.js 用 isReservedEntry 过滤，
 *      tools.js 的 lore 工具用 isReservedTitle 直接拒绝）；
 *   2. 每次写入都校正 `constant = true` / `disable = false` —— 这两个字段是"描述"这个
 *      语义的基础，用户或别的插件改掉之后必须被掰回来；
 *   3. 书怎么选只有一个顺序（见 resolveDescTarget），不允许各调用点各猜一套。
 *
 * 这里只做"存哪里、怎么存"，不判断该不该写（模块开关、长度上限、先读后写、
 * 读取登记都在 tools.js）。
 */

import { DESC_ENTRY_TITLE, DESC_ENTRY_TITLES, DESC_FORMAT, DESC_STORAGE, descBookName, isReservedEntry } from './desc-entry.js';
import { ensureDraft, layerFor, rollbackEmptyDraft } from './draft.js';
import { descriptionView } from './patch.js';
import {
    descStorageMode,
    ensureSettings,
    isWorldbookDesc,
    rememberLoreBackup,
} from '../settings/index.js';
import {
    clampEntryPosition,
    findLoreEntry,
    getActiveCharacter,
    isBookScanned,
    loadBook,
    nextLoreUid,
    persistBook,
} from './index.js';
import { normalizeEol } from '../../shared/util.js';

/*
 * 存储模式与书名推导住在 desc-entry.js、模式判定住在 store.js（它们要读对话状态），
 * 这里只做转发，让界面与工具继续从"描述域"拿这两样东西。
 *
 *   DESC_STORAGE / descBookName   desc-entry.js（零依赖，targets.js 也用它）
 *   descStorageMode / isWorldbookDesc   store.js（按对话，见 ADR-044）
 */
export { DESC_STORAGE, descBookName, descStorageMode, isWorldbookDesc };

/** 角色卡上绑定的主世界书（`character.data.extensions.world`），空串 = 没绑 */
export function boundBookName(character) {
    const value = character?.data?.extensions?.world;
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 上一次真正解析到的书名。
 *
 * 面板是同步渲染的，没法每次都 load 一遍世界书；这个缓存只在
 * "解析成功"时更新，用来在界面上显示确切的落点（比如角色改名之后书名仍是旧的那个）。
 * 换角色时不复用 —— 缓存里带着头像文件名，对不上就退回同名推导。
 */
let resolved = { avatar: '', book: '' };

function rememberResolved(character, book) {
    resolved = { avatar: String(character?.avatar ?? ''), book: String(book ?? '') };
}

function cachedBook(character) {
    const avatar = String(character?.avatar ?? '');
    return avatar && resolved.avatar === avatar ? resolved.book : '';
}

/**
 * 解析"这次该读写哪本书"。
 *
 * 顺序是固定的，三条都有理由：
 *   1. 角色绑定书里已经有保留条目 → 用它。角色改名 / 书改名之后，这是唯一还能找回
 *      原来那本书的线索；不先用它，改名就会凭空再建一本空书，描述看起来"丢了"。
 *   2. 与角色同名的书 → 用它（含"这本书里还没有条目"的情况，由调用方决定要不要建条目）。
 *   3. 只有 `create` 才建书：`saveWorldInfo` 对不存在的文件会直接写出一份新的，
 *      所以要建就显式建，不能靠写条目顺手带出来。
 *
 * @param {object} ctx
 * @param {{ create?: boolean, format?: string }} [options]
 * @returns {Promise<{ ok: true, book: string, data: object, found: object|null, createdBook: boolean }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function resolveDescTarget(ctx, options = {}) {
    const create = options.create === true;
    const character = getActiveCharacter(ctx);
    const metadata = ctx.chatMetadata;
    const chatId = ctx.getCurrentChatId?.();

    if (!character) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前没有选中角色，请让用户先在角色列表里选一个。',
        };
    }

    if (typeof ctx.loadWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'NO_BOOK',
            hint: '当前 ST 没有向扩展暴露 loadWorldInfo，读不到世界书。',
        };
    }

    const book = await resolveBook(ctx, character, create);
    if (!book.ok) {
        return book;
    }
    if (ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId || getActiveCharacter(ctx)?.avatar !== character.avatar) {
        return { ok: false, error: 'TOOL_UNAVAILABLE', hint: '对话或角色已切换，请在当前对话重试。' };
    }

    rememberResolved(character, book.book);

    return {
        ok: true,
        book: book.book,
        data: book.data,
        found: findLoreEntry(book.data, descriptionTitle(options.format), { includeReserved: true }),
        createdBook: book.created,
    };
}

/** @returns {Promise<{ ok: true, book: string, data: object, created: boolean } | { ok: false, error: string, hint?: string }>} */
async function resolveBook(ctx, character, create) {
    /*
     * 0. 同一个角色上次解析到的那本书。
     *    没有这一步的话，每次 desc_read 都要先把"角色绑定的那本书"整本读一遍来确认
     *    里面有没有保留条目 —— 绑着一本大设定书时，这个代价很实在。
     */
    const cached = cachedBook(character);
    if (cached) {
        const loaded = await loadBook(ctx, cached);
        if (loaded.ok && Object.values(loaded.data.entries ?? {}).some(isReservedEntry)) {
            return { ok: true, book: loaded.book, data: loaded.data, created: false };
        }
    }

    // 1. 绑定书（只认"里面有保留条目"这一种，避免把普通条目书误当描述书）
    const bound = boundBookName(character);
    if (bound) {
        const loaded = await loadBook(ctx, bound);
        if (loaded.ok && Object.values(loaded.data.entries ?? {}).some(isReservedEntry)) {
            return { ok: true, book: loaded.book, data: loaded.data, created: false };
        }
    }

    // 2/3. 同名书 → 必要时新建
    const wanted = descBookName(character);
    if (!wanted) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前角色没有名字，无法据此确定世界书名。请让用户先给角色起名。',
        };
    }

    const existing = matchBookName(listNames(ctx), wanted);
    if (existing) {
        const loaded = await loadBook(ctx, existing);
        if (!loaded.ok) {
            return loaded;
        }
        return { ok: true, book: loaded.book, data: loaded.data, created: false };
    }

    if (!create) {
        return {
            ok: false,
            error: 'NO_DESC_BOOK',
            hint: `「${wanted}」这本书还不存在。第一次写入描述时会自动创建它。`,
        };
    }

    return createBook(ctx, wanted);
}

/**
 * 建一本空书。
 *
 * 不能直接用 `createNewWorldInfo`：它没有挂到 ST 的 context 上。所以走同一条
 * 服务端接口（`/api/worldinfo/edit` 对不存在的文件会直接新建），再用
 * `updateWorldInfoList` 把 `world_names` 拉新。
 *
 * 建完必须回到列表里确认真实名字：服务端会 sanitize 文件名，算出来的名字和
 * 落盘的名字可能差一两个字符。用"前后差集"找新出现的那本，比按字符串猜可靠。
 */
async function createBook(ctx, name) {
    if (typeof ctx.saveWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: '当前 ST 没有向扩展暴露 saveWorldInfo，建不了世界书。',
        };
    }

    // 兜底：净化口径和服务端可能还差一点点，真撞上已有书名就别写那份空模板
    const collision = matchBookName(listNames(ctx), name);
    if (collision) {
        const loaded = await loadBook(ctx, collision);
        return loaded.ok
            ? { ok: true, book: loaded.book, data: loaded.data, created: false }
            : loaded;
    }

    const before = new Set(listNames(ctx).map(normalizeName));

    try {
        await ctx.saveWorldInfo(name, { entries: {} }, true);
    } catch (err) {
        console.debug('[Thrive] 创建世界书失败', name, err);
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `创建世界书「${name}」失败：${err?.message ?? err}。可以让用户先手动在「世界书」面板里新建一本。`,
        };
    }

    try {
        await ctx.updateWorldInfoList?.();
    } catch (err) {
        console.debug('[Thrive] updateWorldInfoList 失败', err);
    }

    const names = listNames(ctx);
    const created = names.find(item => !before.has(normalizeName(item)))
        ?? matchBookName(names, name);

    if (!created) {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `世界书「${name}」没有出现在列表里，写入目标不可用。可以让用户手动新建一次。`,
        };
    }

    const loaded = await loadBook(ctx, created);
    if (!loaded.ok) {
        return loaded;
    }

    return { ok: true, book: loaded.book, data: loaded.data, created: true };
}

/** 书名清单；拿不到时返回空数组（判据与 targets 一致：它是 world_names 的副本） */
function listNames(ctx) {
    try {
        const names = ctx.getWorldInfoNames?.();
        return Array.isArray(names) ? names.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * 在清单里找"就是这一本"的书名。
 * 不区分大小写与变音符号 —— ST 自己建书时也用同一套比较口径，
 * 严格相等会把「张三」和「张三」当成两本。
 */
function matchBookName(names, wanted) {
    const key = normalizeName(wanted);
    return names.find(name => normalizeName(name) === key) ?? '';
}

function normalizeName(name) {
    return String(name ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .trim();
}

/**
 * 保证"书 + 条目"都存在，条目内容保持原样。
 *
 * 切换到统一模式时用它：即使一个字都没写，世界书里也得先有一条常驻条目，
 * 用户才能看见"描述去哪儿了"。内容为空是允许的（常驻 + 空正文不会注入任何东西）。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, book: string, created: boolean } | { ok: false, error: string, hint?: string }>}
 */
export async function ensureDescEntry(ctx, format = DESC_FORMAT.TEXT) {
    const target = await resolveDescTarget(ctx, { create: true, format });
    if (!target.ok) {
        return target;
    }

    if (target.found) {
        return { ok: true, book: target.book, created: target.createdBook };
    }

    const entry = buildDescEntry(ensureSettings(ctx), {
        uid: nextLoreUid(target.data),
        content: '',
        title: descriptionTitle(format),
    });
    target.data.entries[String(entry.uid)] = entry;

    const saved = await persistBook(ctx, target.book, target.data, { uid: entry.uid });
    if (!saved.ok) {
        return saved;
    }

    return { ok: true, book: target.book, created: true };
}

/**
 * 读当前角色的描述正文。
 *
 * 书或条目不存在**不是错误**：统一模式下刚切过来的那一刻就是这样，读回空串
 * 才是实话（模型看到 0 字，就知道还没人写过）。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, book: string, text: string, missing: boolean }
 *          | { ok: false, error: string, hint?: string, text: string }>}
 */
export async function readDesc(ctx, format = DESC_FORMAT.TEXT) {
    const target = await resolveDescTarget(ctx, { create: false, format });
    if (!target.ok) {
        return { ...target, text: '' };
    }

    if (!target.found) {
        return { ok: true, book: target.book, text: '', missing: true };
    }

    return {
        ok: true,
        book: target.book,
        text: normalizeEol(String(target.found.entry.content ?? '')),
        missing: false,
    };
}

/**
 * 读"模型此刻该看到的那份描述"，两种模式合一个入口。
 *
 * card 模式多一层 patch 语义：暂存期间返回 `after`（模型按暂存版继续叠），
 * 磁盘未动 —— 这份视图由 patch.js 负责，这里只转发。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, book: string, text: string, staged: boolean, missing: boolean }
 *          | { ok: false, error: string, hint?: string, text: string }>}
 */
export async function readDescription(ctx) {
    if (!isWorldbookDesc(ctx)) {
        const view = descriptionView(ctx);
        return { ok: true, book: '', text: view.text, staged: view.staged, missing: false };
    }

    const read = await readDesc(ctx);
    if (!read.ok) {
        /*
         * 书还没建不算错误：统一模式下刚选了一个新角色就是这样（第一次写入才建书）。
         * 对"读"来说，没有书和没有内容是一回事；把它报成错误会让第一笔追加永远写不进去
         * —— 追加要先读基准，读到错误就停了。
         */
        if (read.error === 'NO_DESC_BOOK') {
            return { ok: true, book: '', text: '', staged: false, missing: true };
        }
        return read;
    }

    return { ...read, staged: false };
}

/**
 * 把描述写进条目（不存在就建）。
 *
 * 每次写前重新 load：`saveWorldInfo` 会把对象按引用塞进缓存，拿旧对象继续改
 * 会出现"内存改了、盘上没改"的分叉。
 *
 * 只动 `content` 与那两个语义字段；`comment`（定位键）、`key`、`order`、`position`
 * 一律保持用户在世界上编辑器里调过的样子。
 *
 * @param {object} ctx
 * @param {string} text
 * @param {string} [format]
 * @param {{ expectedText?: string, guard?: () => boolean }} [options]
 * @returns {Promise<{ ok: true, book: string, chars: number, beforeChars: number, action: 'created'|'rewritten' }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function writeDesc(ctx, text, format = DESC_FORMAT.TEXT, options = {}) {
    const next = normalizeEol(String(text ?? ''));
    const metadata = ctx.chatMetadata;
    const chatId = ctx.getCurrentChatId?.();
    const avatar = getActiveCharacter(ctx)?.avatar;

    const title = descriptionTitle(format);
    const target = await resolveDescTarget(ctx, { create: true, format });
    if (!target.ok) {
        return target;
    }

    const loaded = await loadBook(ctx, target.book);
    if (!loaded.ok) {
        return loaded;
    }
    if (ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId
        || getActiveCharacter(ctx)?.avatar !== avatar || options.guard?.() === false) {
        return { ok: false, error: 'TOOL_UNAVAILABLE', hint: '对话或描述方式已切换，请重新读取。' };
    }
    const existing = findLoreEntry(loaded.data, title, { includeReserved: true });
    if (options.expectedText !== undefined && String(existing?.entry.content ?? '') !== options.expectedText) {
        return { ok: false, error: 'STALE_READ', hint: '条目在读取后发生变化，请重新读取再修改。' };
    }

    /*
     * 这本书有缓冲区时，描述条目也得落在缓冲区里。
     *
     * 它是同一本书里的一条，没有理由例外：描述走磁盘而 lore_* 走缓冲区的话，
     * 缓冲区里那份书的副本就不完整了，保存时会拿旧内容把刚写的描述盖回去。
     * `loaded.data` 此刻还是改动之前的样子，所以这里也是算指纹的正确时机。
     */
    const drafted = ensureDraft(ctx, target.book, loaded.data);
    if (!drafted.ok) {
        return drafted;
    }

    let found = findLoreEntry(loaded.data, title, { includeReserved: true });
    let action = 'rewritten';

    if (!found) {
        const entry = buildDescEntry(ensureSettings(ctx), {
            uid: nextLoreUid(loaded.data),
            content: '',
            title,
        });
        loaded.data.entries[String(entry.uid)] = entry;
        found = { key: String(entry.uid), uid: entry.uid, entry };
        action = 'created';
    }

    const before = String(found.entry.content ?? '');
    const beforeKeys = Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];

    found.entry.content = next;
    // 语义校正：常驻 + 启用。用户在世界书里手动改过也要掰回来
    found.entry.constant = true;
    found.entry.disable = false;
    loaded.data.entries[found.key] = found.entry;

    const saved = await persistBook(ctx, target.book, loaded.data, { uid: found.uid });
    if (!saved.ok) {
        // 缓冲区是这一笔才开出来的、又被拒了：收掉，别留一块空壳挡住真实世界书
        rollbackEmptyDraft(ctx);
        return saved;
    }

    /*
     * 复用世界书的快照：描述在这里就是一条普通条目，撤销走面板「已写入 → 恢复写入前」。
     * 不往 backups.desc 里放 —— 那个槽位属于 card 模式，两套混着存会让"恢复上一版"
     * 变成猜"这份快照属于哪个模式"。
     *
     * `layer` 说明这份快照记的是缓冲区还是真实世界书，恢复时按层走（ADR-047）。
     */
    rememberLoreBackup(ctx, {
        book: target.book,
        title,
        action,
        layer: layerFor(ctx, target.book),
        before,
        beforeKeys,
        chars: next.length,
    });

    return {
        ok: true,
        book: target.book,
        chars: next.length,
        beforeChars: before.length,
        action,
    };
}

/**
 * 启停保留条目。
 *
 * 切回 card 模式时用它：条目停用但内容保留（`disable = true`），这样它不会再被
 * ST 注入，也不会和角色卡上的描述打架；哪天切回来，内容还在原地。
 *
 * @param {object} ctx
 * @param {boolean} enabled
 * @returns {Promise<{ ok: true, changed: boolean, book?: string } | { ok: false, error: string, hint?: string }>}
 */
export async function setDescEntryEnabled(ctx, enabled, format = DESC_FORMAT.TEXT) {
    const target = await resolveDescTarget(ctx, { create: false, format });
    // 书都还没建：停用是空操作，不该把切换流程卡住
    if (!target.ok || !target.found) {
        return { ok: true, changed: false };
    }

    const loaded = await loadBook(ctx, target.book);
    if (!loaded.ok) {
        return { ok: true, changed: false };
    }

    const found = findLoreEntry(loaded.data, descriptionTitle(format), { includeReserved: true });
    if (!found) {
        return { ok: true, changed: false };
    }

    const nextDisable = !enabled;
    if (found.entry.disable === nextDisable && found.entry.constant === true) {
        return { ok: true, changed: false, book: target.book };
    }

    found.entry.disable = nextDisable;
    found.entry.constant = true;
    loaded.data.entries[found.key] = found.entry;

    const saved = await persistBook(ctx, target.book, loaded.data, { uid: found.uid });
    if (!saved.ok) {
        return saved;
    }

    return { ok: true, changed: true, book: target.book };
}

/**
 * 面板同步渲染用的快照：只给"存在哪、通不通"，不给正文。
 * 正文要 load 世界书，是异步的；界面每帧都读一遍不划算，而且说明文字里也用不到。
 *
 * @param {object} ctx
 * @returns {{ mode: string, book: string, title: string, active: boolean|null }}
 */
export function getDescTargetSnapshot(ctx) {
    const character = getActiveCharacter(ctx);
    const book = cachedBook(character) || descBookName(character);

    return {
        mode: descStorageMode(ctx),
        book,
        title: DESC_ENTRY_TITLE,
        active: book ? isBookScanned(ctx, book) : null,
    };
}

/**
 * 保留条目模板。
 *
 * 与 targets.js 的 buildNewLoreEntry 有意分开：那边的 `constant: false` 是 ADR-008
 * 对"模型新建条目"的约束，这里恰恰相反 —— 常驻是这个功能的定义。共用一份模板
 * 迟早会有人把两边的语义调成一样。
 */
function buildDescEntry(settings, fields) {
    return {
        uid: fields.uid,
        // 常驻条目不需要关键词；显式给空数组，避免"缺 key 字段"被别的工具当成异常
        key: [],
        keysecondary: [],
        comment: fields.title ?? DESC_ENTRY_TITLE,
        content: String(fields.content ?? ''),
        constant: true,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: clampEntryPosition(settings?.entryPosition),
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ignoreBudget: false,
        triggers: [],
    };
}

function descriptionTitle(format = DESC_FORMAT.TEXT) {
    const title = DESC_ENTRY_TITLES[format];
    if (!title) throw new Error(`Unknown description format: ${format}`);
    return title;
}

/** 仅为启用的方式创建条目；切换方式/落点时保留已有正文并同步常驻状态。 */
export async function syncDescEntries(ctx, formats) {
    const metadata = ctx.chatMetadata;
    const avatar = getActiveCharacter(ctx)?.avatar;
    const chatId = ctx.getCurrentChatId?.();
    const target = await resolveDescTarget(ctx, { create: formats.length > 0 });
    if (!target.ok) {
        return target.error === 'NO_DESC_BOOK' && !formats.length ? { ok: true, book: '' } : target;
    }
    let changed = false;
    for (const format of Object.values(DESC_FORMAT)) {
        const enabled = formats.includes(format);
        const title = descriptionTitle(format);
        let found = findLoreEntry(target.data, title, { includeReserved: true });
        if (!found && enabled) {
            const entry = buildDescEntry(ensureSettings(ctx), {
                uid: nextLoreUid(target.data), content: '', title,
            });
            target.data.entries[String(entry.uid)] = entry;
            found = { entry };
            changed = true;
        }
        if (found && (found.entry.disable !== !enabled || found.entry.constant !== true)) {
            found.entry.disable = !enabled;
            found.entry.constant = true;
            changed = true;
        }
    }
    if (ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId || getActiveCharacter(ctx)?.avatar !== avatar) {
        return { ok: false, error: 'TOOL_UNAVAILABLE', hint: '对话或角色已切换，请在当前对话重试。' };
    }
    if (changed) {
        const saved = await persistBook(ctx, target.book, target.data);
        if (!saved.ok) return saved;
    }
    return { ok: true, book: target.book };
}
