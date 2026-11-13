/** Description tools use only the selected description book; each format owns a reserved entry. */

import { DESC_ENTRY_TITLE, DESC_ENTRY_TITLES, DESC_FORMAT, DESC_STORAGE, descBookName } from './desc-entry.js';
import { ensureDraft, layerFor, rollbackEmptyDraft } from './draft.js';
import { descriptionView } from './patch.js';
import {
    descStorageMode,
    ensureSettings,
    isWorldbookDesc,
    rememberLoreBackup,
} from '../settings/index.js';
import { clampEntryPosition, findLoreEntry, nextLoreUid } from './lore-entry.js';
import { getActiveCharacter } from './character-target.js';
import { createBook, loadBook, persistBook } from './lore-repository.js';
import { getDescriptionBook, isBookScanned, prepareBookRead } from './target-selection.js';
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

/** Resolve the configured description destination without falling back to another book. */
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

    const book = await resolveBook(ctx, create);
    if (!book.ok) {
        return book;
    }
    if (ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId || getActiveCharacter(ctx)?.avatar !== character.avatar) {
        return { ok: false, error: 'TOOL_UNAVAILABLE', hint: '对话或角色已切换，请在当前对话重试。' };
    }

    return {
        ok: true,
        book: book.book,
        data: book.data,
        found: findLoreEntry(book.data, descriptionTitle(options.format), { includeReserved: true }),
        createdBook: book.created,
    };
}

/** @returns {Promise<{ ok: true, book: string, data: object, created: boolean } | { ok: false, error: string, hint?: string }>} */
async function resolveBook(ctx, create) {
    const wanted = getDescriptionBook(ctx);
    if (!wanted) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前角色没有名字，无法据此确定世界书名。请让用户先给角色起名。',
        };
    }

    const existing = (ctx.getWorldInfoNames?.() ?? []).find(name => name === wanted);
    if (existing) {
        prepareBookRead(ctx, existing);
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

/** Explicit structural operation; normal tool reads never create a book or entry. */
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
    const destination = getDescriptionBook(ctx);

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
        || getActiveCharacter(ctx)?.avatar !== avatar || getDescriptionBook(ctx) !== destination
        || options.guard?.() === false) {
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
        rollbackEmptyDraft(ctx, target.book);
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
        uid: found.uid,
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
    const book = getDescriptionBook(ctx);

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
export async function syncDescEntries(ctx, formats, options = {}) {
    const metadata = ctx.chatMetadata;
    const avatar = getActiveCharacter(ctx)?.avatar;
    const chatId = ctx.getCurrentChatId?.();
    const target = await resolveDescTarget(ctx, { create: formats.length > 0 && options.create !== false });
    if (!target.ok) {
        return target.error === 'NO_DESC_BOOK' && (!formats.length || options.create === false) ? { ok: true, book: '' } : target;
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
