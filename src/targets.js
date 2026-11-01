/**
 * targets.js · 目标解析与写入
 *
 * 插件的能力边界在这里收口：工具参数里没有"角色 id""书名"这类字段，
 * 目标永远由插件根据当前选中的角色和设置解析出来。
 *
 * 两条路径：角色描述（读 + 写）、世界书（读 + 写）。
 */

import { appendParagraph, normalizeEol } from './util.js';

/**
 * 当前选中的角色。没有选中时返回 null。
 * @param {object} ctx getContext() 的返回值
 */
export function getActiveCharacter(ctx) {
    const index = ctx?.characterId;
    if (index === undefined || index === null || index === '') {
        return null;
    }
    const character = ctx.characters?.[index];
    return character ?? null;
}

/**
 * 把描述写进角色卡。
 *
 * 只提交 `description` —— `merge-attributes` 是深合并，多带一个字段就多改一处
 * （ADR-015：不返回也不写入 personality / scenario / first_mes / mes_example）。
 *
 * @param {object} ctx
 * @param {object} character 当前角色对象
 * @param {string} text 新的描述全文
 * @returns {Promise<{ ok: true } | { ok: false, error: string, hint?: string }>}
 */
export async function saveDescription(ctx, character, text) {
    if (!character?.avatar) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前角色没有头像文件名，无法定位角色卡文件。请让用户先重新选一次角色。',
        };
    }

    let response;
    try {
        response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: ctx.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                avatar: character.avatar,
                description: String(text ?? ''),
            }),
        });
    } catch (err) {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `写入请求没有发出去（${err?.message ?? err}）。可以让用户检查 ST 服务是否在运行。`,
        };
    }

    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json();
            if (body?.message) {
                message = body.message;
            }
        } catch {
            // 响应不是 JSON，就用状态码
        }
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `角色卡写入被服务端拒绝：${message}`,
        };
    }

    return { ok: true };
}

/**
 * 写入成功后同步内存里的角色对象，以及角色编辑面板里的文本框。
 *
 * 内存同步是必须的：下一步生成的 system 提示词直接从 `characters[chid].description` 取。
 *
 * 文本框同步是必须的，而且比想象中更关键：ST 的编辑面板保存时提交的是**表单里的值**，
 * 不是内存里的对象。如果面板开着、里面还是旧文本，用户随手一点保存，就会把刚写进去的
 * 内容整段覆盖回去（实测踩过：写入成功、一分钟后又变回原样，真值只能从 patch.after 里捞）。
 *
 * 所以这里不再靠 `offsetParent === null` 判断"面板开没开"——面板收起时 textarea 依然
 * 留着上一次的值，等用户打开时 ST 不一定重新填充。改为看内容：
 *   - 框里还等于写入前的原文 → 用户没动过，直接同步（隐藏着也同步，省得以后拿旧的覆盖）
 *   - 框里已经被改过 → 绝不覆盖（会冲掉用户正在敲的字），交给调用方提示
 *   - 框里显示的是另一个角色 → 不动
 *
 * @param {object} character 当前角色对象（会被原地修改）
 * @param {string} text 刚写入的全文
 * @param {string|null} [previousText] 写入前角色卡上的原文，用来判断"用户动没动过"
 * @returns {{ synced: boolean, reason: string }}
 */
export function applyDescriptionLocally(character, text, previousText = null) {
    if (!character) {
        return { synced: false, reason: 'no-character' };
    }

    const next = normalizeEol(text);
    character.description = next;

    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return { synced: false, reason: 'no-editor' };
    }

    // 编辑面板正在编辑别的角色：不要动别人的输入框
    const nameField = document.getElementById('character_name_pole');
    if (nameField && character.name && nameField.value && nameField.value !== character.name) {
        return { synced: false, reason: 'other-character' };
    }

    const current = normalizeEol(textarea.value);
    const focused = document.activeElement === textarea;

    /*
     * 只有"正在这个框里打字、而且内容已经和写入前不一样"才不覆盖——
     * 其余情况一律同步：
     *   - 框是隐藏的/面板收起了：里面的值迟早会被 ST 的自动保存（输入任意字段、
     *     切聊天都会触发 saveCharacterDebounced）整份提交上去，留着旧的等于埋雷
     *   - 框是可见的但没聚焦：不算在编辑
     * 以前靠 `offsetParent === null` 判断"面板没开"，并拿原始字符串和框里的值比对，
     * 两处都错：隐藏的框照样会被自动保存提交；框里的换行是 LF、盘上是 CRLF，永远不相等。
     */
    const untouched = previousText === null
        ? !focused
        : current === normalizeEol(previousText);

    if (focused && !untouched) {
        return { synced: false, reason: 'edited' };
    }

    // 焦点在这个框里时（用户没改过内容）整段替换会把光标顶到末尾；记一下位置再放回去，
    // 免得用户刚把光标点到某句话中间就被弹走
    const selection = focused && Number.isFinite(textarea.selectionStart)
        ? [textarea.selectionStart, textarea.selectionEnd]
        : null;
    textarea.value = next;
    if (selection) {
        const clamp = pos => Math.min(pos, next.length);
        textarea.setSelectionRange(clamp(selection[0]), clamp(selection[1]));
    }
    // 框里原本是别的文本（用户改过但已经失焦）：同步是对的，但要如实告诉调用方"覆盖了未保存的改动"
    return { synced: true, reason: untouched ? 'ok' : 'overwrote-edited' };
}

/**
 * 把已写入的描述直接推进编辑框，不管框里现在是什么。
 *
 * 只有用户主动点面板上的「填入编辑框」才会走到这里 —— 那是"我知道会覆盖我刚才敲的字"
 * 的显式同意。写入路径自己不用它：那边碰到用户改过的框一律不动（见 applyDescriptionLocally）。
 *
 * @param {object|null} character
 * @param {string} text
 * @returns {{ synced: boolean, reason: string }}
 */
export function refreshDescriptionEditor(character, text) {
    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return { synced: false, reason: 'no-editor' };
    }

    const next = normalizeEol(text);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    textarea.value = next;

    if (document.activeElement === textarea && Number.isFinite(start)) {
        const clamp = pos => Math.min(pos, next.length);
        textarea.setSelectionRange(clamp(start), clamp(end));
    }

    if (character) {
        character.description = next;
    }

    return { synced: true, reason: 'forced' };
}

/* ------------------------------------------------------------------ 世界书 */

/*
 * 读取侧的数值上限（返回几条、每条给多少字、总览列几个标题、多少条开始提醒合并）
 * 都在 limits.js 里定义，设置页可调；这里只负责按传进来的那套值裁剪。
 */

/** 可写世界书名；空串表示未就绪 */
export function getWritableBook(settings) {
    return String(settings?.writableBook ?? '').trim();
}

/**
 * 当前角色"绑定了但不属于可写目标"的其他书。
 *
 * 只认文件型的绑定：`character.data.extensions.world`（角色自带）与
 * `chat_metadata.world_info`（聊天级）。卡内嵌的 `character_book` 没有独立文件，
 * loadWorldInfo 用名字取不到，所以既不可写也不参与读取（spec §11.1）。
 */
export function getBoundBookNames(ctx) {
    const names = [];
    const character = getActiveCharacter(ctx);

    const characterWorld = character?.data?.extensions?.world;
    if (typeof characterWorld === 'string' && characterWorld.trim()) {
        names.push(characterWorld.trim());
    }

    const chatWorld = ctx?.chatMetadata?.world_info;
    if (typeof chatWorld === 'string' && chatWorld.trim()) {
        names.push(chatWorld.trim());
    }

    return names;
}

/**
 * 本次实际要读的书列表，可写书永远排第一。
 * @returns {{ writable: string, books: string[] }}
 */
export function resolveReadBooks(ctx, settings) {
    const writable = getWritableBook(settings);
    const books = [];

    const push = name => {
        const value = String(name ?? '').trim();
        if (value && !books.includes(value)) {
            books.push(value);
        }
    };

    push(writable);
    if (settings?.readScope === 'bound') {
        getBoundBookNames(ctx).forEach(push);
    }

    return { writable, books };
}

/**
 * 这本书会不会被 ST 扫描到 —— 决定写进去的条目有没有机会进入上下文。
 *
 * 三条路都能让一本书进入扫描范围：
 *   1. 角色自带（`character.data.extensions.world`）
 *   2. 聊天级绑定（`chat_metadata.world_info`）
 *   3. 世界书面板里被手动勾选（`#world_info` 的 option 值是 `world_names` 的下标）
 *
 * 第 3 条没有公开 API，`selected_world_info` 只在 change 事件里重建，所以只能读 DOM。
 * 前三者之外，条目写得再对也只是躺在文件里。
 *
 * @param {object} ctx
 * @param {string} book
 * @returns {boolean|null} null = 判断不了（面板还没渲染 / 书单拿不到），调用方按"未确认"处理
 */
export function isBookScanned(ctx, book) {
    const name = String(book ?? '').trim();
    if (!name) {
        return null;
    }

    // 绑定的书不需要手动激活，ST 每次都会带上
    if (getBoundBookNames(ctx).includes(name)) {
        return true;
    }

    const select = document.getElementById('world_info');
    if (!select || !select.options || select.options.length === 0) {
        return null;
    }

    const names = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
    if (!Array.isArray(names) || names.length === 0) {
        return null;
    }

    // 多选框：selectedOptions 就是当前勾选的那几本，option.value 是下标
    const selected = Array.from(select.selectedOptions ?? []);
    return selected.some(option => names[Number(option.value)] === name);
}

/* ------------------------------------------------------ 世界书 · 目录 */

/**
 * 列出可写书里的条目，只取标题。
 *
 * 目录的信息量要小：模型问"这本书里有什么"，一串标题就够回答。把关键词和
 * 正文一起端上去，一次目录就能吃掉几千 token，而它多半只是想确认
 * "这条写没写过"。
 *
 * 只列可写书：目录的用途是写之前先看看，而写只能落到可写书。绑定书塞进来
 * 只会让模型以为那些条目可改（ADR-018 的读范围只作用于 lore_read）。
 *
 * @param {object} ctx
 * @param {object} settings
 * @returns {Promise<{ ok: true, book: string, items: Array<{ title: string, uid: number, disabled: boolean }> }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function listLore(ctx, settings) {
    const loaded = await loadWritableBook(ctx, settings);
    if (!loaded.ok) {
        return loaded;
    }

    const items = Object.values(loaded.data.entries)
        .filter(Boolean)
        .map(entry => ({
            title: entryTitle(entry),
            uid: uidOf(entry),
            disabled: entry.disable === true,
            // 只在目录过滤时用得上（按关键词找条目），不往返回里带：目录只给标题
            keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
        }))
        // 按 uid 排：新建的条目落在末尾，模型能看出"这是最近写的那条"
        .sort((a, b) => a.uid - b.uid);

    return { ok: true, book: loaded.book, items };
}

/**
 * 定位一条条目：可写书优先，`readScope=bound` 时再找角色绑定的书（只读）。
 *
 * 写路径不走这里 —— 写只认可写书。读路径需要它，是因为"这条设定是不是已经
 * 记在别处"常常要去绑定的书里看一眼；看到了就得告诉模型那本不可写，否则它会
 * 拿着刚读到的标题去 append，然后收到一个莫名其妙的 NOT_FOUND。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string} title
 * @returns {Promise<{ ok: true, book: string, writable: boolean, data: object,
 *                     found: { key: string, uid: number, entry: object } }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function locateLoreEntry(ctx, settings, title) {
    const wanted = String(title ?? '').trim();
    if (!wanted) {
        return {
            ok: false,
            error: 'INVALID_TITLE',
            hint: '标题是空串。标题既是同书内的唯一标识，也是定位条目的唯一方式。',
        };
    }

    if (typeof ctx.loadWorldInfo !== 'function') {
        return noBook('当前 ST 没有向扩展暴露 loadWorldInfo，读不到世界书。');
    }

    const { writable, books } = resolveReadBooks(ctx, settings);
    const loaded = [];

    for (const name of books) {
        const one = await loadBook(ctx, name);
        if (one.ok) {
            loaded.push({ name, data: one.data });
        }
    }

    // 可写书读不到 = 书被删了/改名了。这时找不到条目不是"这条不存在"，
    // 而是整个目标没了，得说清楚
    if (!loaded.some(item => item.name === writable)) {
        return noBook(`读不到可写书「${writable}」，它可能已被删除或改名。请让用户重新选择。`);
    }

    for (const item of loaded) {
        const found = findLoreEntry(item.data, wanted);
        if (found) {
            return {
                ok: true,
                book: item.name,
                writable: item.name === writable,
                data: item.data,
                found,
            };
        }
    }

    return {
        ok: false,
        error: 'NOT_FOUND',
        hint: `可写书里没有标题为「${wanted}」的条目。先用 lore_list 看现有标题，标题必须与列表里完全一致。`,
    };
}

function noBook(hint) {
    return { ok: false, error: 'NO_BOOK', hint };
}

function uidOf(entry) {
    const uid = Number(entry?.uid);
    return Number.isFinite(uid) ? uid : 0;
}

/**
 * 条目标题：优先 comment（写入时也用它做 upsert 主键），
 * 其次第一个关键词，最后退回 uid —— 至少让模型能区分彼此。
 */
export function entryTitle(entry) {
    const comment = String(entry?.comment ?? '').trim();
    if (comment) {
        return comment;
    }

    const firstKey = Array.isArray(entry?.key) ? String(entry.key[0] ?? '').trim() : '';
    return firstKey || `条目 #${uidOf(entry)}`;
}


/* ----------------------------------------------------------- 世界书 · 写入 */

/** `logic` 参数 → `selectiveLogic` */
const SELECTIVE_LOGIC = Object.freeze({ any: 0, not_all: 1, not_any: 2, all: 3 });

/*
 * 标题上限（默认 60 字）也走 limits.js 的 `titleMaxChars`：comment 会显示在
 * 世界书列表里，太长就没法一眼扫过去，但"多长算太长"由用户自己定。
 */

/**
 * 取可写书的数据。
 *
 * 每次写入前都重新 load 一次：`saveWorldInfo` 把对象按引用放进缓存，
 * 保存之后再动同一个对象会造成"内存里改了、盘上没改"的分叉
 * （spec §11.2）。所以这里只拿副本、用完不再碰。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export async function loadWritableBook(ctx, settings) {
    const book = getWritableBook(settings);
    if (!book) {
        return noBook('还没有选择可写书。请让用户到扩展设置里选一本。');
    }

    return loadBook(ctx, book);
}

/**
 * 按书名取一份世界书数据。
 *
 * 与 loadWritableBook 的区别只在"书名从哪来"：从快照恢复时，记录里的书
 * 可能已经不是当前的可写书（用户中途换过书），但那条记录仍然得能恢复。
 *
 * @param {object} ctx
 * @param {string} book
 */
export async function loadBook(ctx, book) {
    const name = String(book ?? '').trim();
    if (!name) {
        return noBook('没有指定世界书。');
    }

    if (typeof ctx.loadWorldInfo !== 'function') {
        return noBook('当前 ST 没有向扩展暴露 loadWorldInfo，改不到世界书。');
    }

    let data = null;
    try {
        data = await ctx.loadWorldInfo(name);
    } catch (err) {
        console.debug('[Thrive] loadWorldInfo 失败', name, err);
    }

    // loadWorldInfo 对不存在的书名**不返回 null**：1.19 会给出一个空 entries 的对象，
    // 于是 `data != null` 这条判断放过了"书已被删除/改名"的情况，接着 saveWorldInfo
    // 还会把文件重新创建出来——用户看到的是"写成功了"，实际写到一本刚被凭空造出来的书里。
    // 书名清单才是"这本书存在"的判据（getWorldInfoNames 是 world_names 的副本）。
    const names = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : null;
    if (Array.isArray(names) && !names.includes(name)) {
        return noBook(`读不到世界书「${name}」，它可能已被删除或改名。请让用户重新选择。`);
    }

    if (!data || typeof data !== 'object') {
        return noBook(`读不到世界书「${name}」，它可能已被删除或改名。请让用户重新选择。`);
    }

    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    return { ok: true, book: name, data };
}

/**
 * 按标题找条目。标题取 `comment`，比较前两边都 trim。
 *
 * 同书内理论上标题唯一，实际手写完可以重名 —— 取 uid 最小的那条，
 * 之后所有改写都落在它身上，不会每次换一条。
 *
 * @returns {{ key: string, uid: number, entry: object } | null}
 */
export function findLoreEntry(data, title) {
    const wanted = String(title ?? '').trim();
    if (!wanted) {
        return null;
    }

    let found = null;

    for (const [key, entry] of Object.entries(data?.entries ?? {})) {
        if (!entry) {
            continue;
        }
        if (String(entry.comment ?? '').trim() !== wanted) {
            continue;
        }

        const uid = Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : Number(key);
        if (!found || uid < found.uid) {
            found = { key, uid, entry };
        }
    }

    return found;
}

/** 下一个可用 uid：现有数字 uid 的最大值 + 1；空书从 0 开始（与 ST 一致） */
function nextLoreUid(data) {
    const uids = Object.values(data?.entries ?? {})
        .map(entry => Number(entry?.uid))
        .filter(uid => Number.isFinite(uid));

    return uids.length ? Math.max(...uids) + 1 : 0;
}

function clampEntryPosition(value) {
    const position = Number(value);
    if (!Number.isFinite(position)) {
        return 0;
    }
    return Math.min(3, Math.max(0, Math.trunc(position)));
}

/**
 * 新建条目。固定值就定义在这里（spec 不抄清单），其余字段照 ST 1.19 的条目模板补齐。
 *
 * `triggers` 容易被漏掉，但 1.19 的部分生成类型会读它，
 * 缺字段的条目会静默不生效，所以必须显式写空数组。
 */
function buildNewLoreEntry(settings, fields) {
    return {
        uid: fields.uid,
        key: fields.keys,
        keysecondary: [],
        comment: fields.title,
        content: fields.content,
        // ADR-008：常驻锁死 false，模型无权设置
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: SELECTIVE_LOGIC[fields.logic] ?? SELECTIVE_LOGIC.any,
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

/**
 * 新建条目。
 *
 * 与改写分开，是为了不再有 upsert：upsert 的隐含语义是"找不到就新建"，模型把
 * 标题打错一个字就会静默多出一条重复条目，而它自己并不知道。分开之后，
 * 标题不存在就是 NOT_FOUND，模型必须回头看一眼目录再决定。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string} book
 * @param {object} data
 * @param {{ title: string, content: string, keys: string[], logic?: string }} fields
 */
export async function createLoreEntry(ctx, settings, book, data, fields) {
    if (typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const uid = nextLoreUid(data);
    const entry = buildNewLoreEntry(settings, { ...fields, uid });
    // entries 以字符串 uid 为键，数字键会被 JS 转成字符串但顺序会跑到前面去
    data.entries[String(uid)] = entry;

    return commitEntry(ctx, book, data, entry, 'created');
}

/**
 * 追加：正文接在末尾，关键词合并去重。
 *
 * 这是唯一"模型不需要先读全文"的写路径 —— 它只提供增量，合成由这里做。
 * 合成的基准是盘上的完整正文，所以模型手里那半截文本永远冲不掉后半段。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ key: string, uid: number, entry: object }} found
 * @param {{ content?: string, keys?: string[], maxKeywords: number, hardLimit: number }} fields
 */
export async function appendLoreEntry(ctx, book, data, found, fields) {
    if (typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const before = String(found.entry.content ?? '');
    const beforeKeys = Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];
    const content = String(fields.content ?? '').trim();

    const next = content ? appendParagraph(before, content) : before;
    if (next.length > fields.hardLimit) {
        return {
            ok: false,
            error: 'TOO_LONG',
            hint: `追加后正文 ${next.length} 字，超过单条上限 ${fields.hardLimit} 字。改用 lore_replace 精简已有内容，或把要加的这条另建一条。`,
        };
    }

    const merged = mergeKeys(beforeKeys, fields.keys, fields.maxKeywords);

    found.entry.content = next;
    found.entry.key = merged.keys;
    data.entries[found.key] = found.entry;

    const result = await commitEntry(ctx, book, data, found.entry, 'appended');
    if (!result.ok) {
        return result;
    }

    return {
        ...result,
        addedChars: next.length - before.length,
        addedKeys: merged.added,
        skippedKeys: merged.skipped,
    };
}

/**
 * 用新正文替换条目正文（replace 与 rewrite 共用后半段）。
 *
 * 只动 `content`：标题是定位键，关键词是触发方式，压缩正文时都不该被顺手改掉
 * （ADR-008 / ADR-015）。要加关键词走 append。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ key: string, uid: number, entry: object }} found
 * @param {string} content 新的正文
 * @param {{ hardLimit: number }} options
 */
export async function replaceLoreEntry(ctx, book, data, found, content, options) {
    if (typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const before = String(found.entry.content ?? '');
    const next = String(content ?? '');

    if (!next.trim()) {
        return {
            ok: false,
            error: 'EMPTY_CONTENT',
            hint: '替换后正文是空的。空条目等于删除，不做；要精简就保留可读的残句。',
        };
    }

    if (next.length > options.hardLimit) {
        return {
            ok: false,
            error: 'TOO_LONG',
            hint: `正文 ${next.length} 字，超过单条上限 ${options.hardLimit} 字。再压一压。`,
        };
    }

    found.entry.content = next;
    data.entries[found.key] = found.entry;

    const result = await commitEntry(ctx, book, data, found.entry, 'rewritten');
    if (!result.ok) {
        return result;
    }

    return { ...result, beforeChars: before.length, afterChars: next.length };
}

/** 三种写法的公共收尾：落盘 → 返回统一形状 */
async function commitEntry(ctx, book, data, entry, action) {
    const saved = await persistBook(ctx, book, data, { uid: entry.uid });
    if (!saved.ok) {
        return saved;
    }

    return {
        ok: true,
        action,
        uid: entry.uid,
        content: String(entry.content ?? ''),
        keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
    };
}

/**
 * 合并关键词：保留原顺序，追加没出现过的，按上限截断。
 *
 * 去重是必需的：同一批关键词写两遍，条目在世界书里看起来会像"重点强调"，
 * 实际只是把触发词表撑长。
 */
function mergeKeys(existing, incoming, maxKeywords) {
    const keys = Array.isArray(existing) ? existing.map(String) : [];
    const added = [];
    const skipped = [];

    for (const raw of Array.isArray(incoming) ? incoming : []) {
        const key = String(raw ?? '').trim();
        if (!key) {
            continue;
        }
        if (keys.includes(key)) {
            skipped.push(key);
            continue;
        }
        keys.push(key);
        added.push(key);
    }

    const limit = Math.max(1, Number(maxKeywords) || 1);
    const truncated = keys.length > limit;

    return {
        keys: keys.slice(0, limit),
        added: added.slice(0, Math.max(0, limit - (keys.length - added.length))),
        skipped,
        truncated,
    };
}

function noSaveApi() {
    return {
        ok: false,
        error: 'WRITE_FAILED',
        hint: '当前 ST 没有向扩展暴露 saveWorldInfo，写不进世界书。',
    };
}

/**
 * 从快照把一条世界书条目恢复成写入前的样子。
 *
 * 两种情况分开处理，因为"写入前"的形态不同：
 *   - `rewritten`：写回 content / key / comment，其余字段一律不动
 *     （用户手调过的 position、depth 之类不该被这次撤销带走）
 *   - `created`：写入前这条根本不存在，所以恢复 = 从书里删掉它
 *
 * 删除只在用户主动点面板按钮时发生，不是工具能力（ADR-011 约束的是模型）。
 *
 * @param {object} ctx
 * @param {object} backup store.js 里的快照记录
 * @returns {Promise<{ ok: true, action: 'restored'|'deleted'|'gone', book: string, title: string }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function restoreLoreEntry(ctx, backup) {
    const book = String(backup?.book ?? '').trim();
    const title = String(backup?.title ?? '').trim();

    if (!book || !title) {
        return {
            ok: false,
            error: 'INVALID_BACKUP',
            hint: '这条快照缺少书名或标题，定位不到条目。',
        };
    }

    if (typeof ctx.saveWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: '当前 ST 没有向扩展暴露 saveWorldInfo，改不到世界书。',
        };
    }

    const loaded = await loadBook(ctx, book);
    if (!loaded.ok) {
        return loaded;
    }

    const { data } = loaded;
    const found = findLoreEntry(data, title);

    if (!found) {
        if (backup.action === 'created') {
            // 已经是"写入前"的样子了：条目不在书里
            return { ok: true, action: 'gone', book, title };
        }
        return {
            ok: false,
            error: 'ENTRY_GONE',
            hint: `条目「${title}」已经不在「${book}」里了（可能被手动删除或改了标题），没有可恢复的位置。`,
        };
    }

    if (backup.action === 'created') {
        delete data.entries[found.key];
    } else {
        found.entry.content = String(backup.before ?? '');
        found.entry.comment = title;
        // 快照里没有关键词（极老的记录）就保持现状，别把 key 清空成死条目（ADR-009）
        if (Array.isArray(backup.beforeKeys) && backup.beforeKeys.length > 0) {
            found.entry.key = backup.beforeKeys.map(String);
        }
        data.entries[found.key] = found.entry;
    }

    const saved = await persistBook(ctx, book, data, { uid: found?.uid });
    if (!saved.ok) {
        return saved;
    }

    return {
        ok: true,
        action: backup.action === 'created' ? 'deleted' : 'restored',
        book,
        title,
    };
}

/**
 * 落盘：saveWorldInfo(name, data, true) → 刷新世界书列表 → 刷新世界书编辑器。
 *
 * `immediately = true` 是硬要求：默认走 debounce，用户切走对话或关页面时
 * 那几百毫秒的窗口足够丢掉一次写入，而这条路径没有别的重试机会。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ uid?: number }} [options] 刚写入的那条，刷新后拿来定位
 */
async function persistBook(ctx, book, data, options = {}) {
    try {
        await ctx.saveWorldInfo(book, data, true);
    } catch (err) {
        console.debug('[Thrive] saveWorldInfo 失败', book, err);
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `写入世界书「${book}」失败：${err?.message ?? err}。可以让用户检查 ST 服务是否在运行。`,
        };
    }

    // 列表没刷新的话，设置面板里的选择器还是旧的，用户会以为没写进去
    try {
        await ctx.updateWorldInfoList?.();
    } catch (err) {
        console.debug('[Thrive] updateWorldInfoList 失败', err);
    }

    // 编辑器开着这本书就必须跟着刷新，否则它手里那份旧拷贝迟早把整本书写回去
    const editor = await refreshWorldEditor(ctx, book, options.uid);

    return { ok: true, editor };
}

/* -------------------------------------------------- 世界书编辑器同步 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 世界书编辑器当前开在哪本书上。
 *
 * 只能读 DOM —— 没有公开 API 能问"编辑器开着哪本"。注意 option 的 value 是
 * `world_names` 的下标，而 option 列表最前面还有一个空占位项：拿 value 当下标去取
 * option 会差一位，所以直接读选中项的文字。
 */
function isWorldEditorShowing(book) {
    const select = document.getElementById('world_editor_select');
    if (!select) {
        return false;
    }
    const label = String(select.selectedOptions?.[0]?.textContent ?? '').trim();
    return label !== '' && label === book;
}

/** 世界书列表当前在第几页；拿不到就当第 1 页 */
function readCurrentPage() {
    const $ = globalThis.jQuery;
    if (!$) {
        return 1;
    }
    try {
        return Number($('#world_info_pagination').pagination('getCurrentPageNum')) || 1;
    } catch {
        return 1;
    }
}

function goToPage(page) {
    const $ = globalThis.jQuery;
    if (!$ || !(page > 1)) {
        return;
    }
    try {
        $('#world_info_pagination').pagination('go', page);
    } catch {
        // 分页还没初始化，忽略
    }
}

/** 刚写的那条在列表里的元素（不在当前页/被搜索过滤掉时为 null） */
function findLoreEntryElement(uid) {
    if (!Number.isFinite(uid)) {
        return null;
    }
    const list = document.getElementById('world_popup_entries_list');
    return list?.querySelector(`.world_entry[uid="${uid}"]`) ?? null;
}

/** 闪一下边框，让用户一眼看到刚才写的是哪条 */
function flashLoreEntry(el) {
    try {
        el.animate?.(
            [
                { outline: '2px solid rgba(120, 200, 255, 0.95)', outlineOffset: '2px' },
                { outline: '2px solid rgba(120, 200, 255, 0)', outlineOffset: '2px' },
            ],
            { duration: 1600, easing: 'ease-out' },
        );
    } catch {
        // 没有 Web Animations 就算了
    }
}

/**
 * 把世界书编辑器刷到磁盘上的最新内容。
 *
 * 为什么非要整块重绘：`worldInfoCache` 是 `StructuredCloneMap({ cloneOnGet: true })`，
 * `loadWorldInfo` 每次返回的都是**深拷贝**。编辑器渲染时拿到自己那份拷贝，之后任何一次
 * 输入（改标题、改 Order、切禁用……）都会拿它把**整本书**写回去。所以插件写进去的条目，
 * 会在用户下一次碰编辑器时被整本回滚 —— 比角色描述那条路径更狠（那边只回滚一个字段）。
 * 实测：写入成功后只改一下 order，刚写的正文就变回旧内容了。
 *
 * 重绘是唯一能让编辑器拿到新拷贝的办法（回调闭包里那份拿不到，`updateEditor` 也是拿它
 * 重画）。代价是 ST 的 change 处理器会清掉搜索词、跳回第一页，所以这里尽量还原。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {number|undefined} uid 刚写入的条目
 * @returns {Promise<{ refreshed: boolean, reason?: string, focused?: boolean }>}
 */
async function refreshWorldEditor(ctx, book, uid) {
    if (!isWorldEditorShowing(book)) {
        return { refreshed: false, reason: 'not-open' };
    }
    if (typeof ctx.reloadWorldInfoEditor !== 'function') {
        return { refreshed: false, reason: 'no-api' };
    }

    const searchEl = document.getElementById('world_info_search');
    const searchText = String(searchEl?.value ?? '');
    const page = readCurrentPage();
    const uidNum = Number(uid);

    /*
     * 条目正文的编辑区是懒加载的：抽屉展开时才创建，收起时会整个销毁。
     * 重绘后抽屉一律是收起的，用户刚在改的那条会突然合上，所以先记下它原本是展开的。
     * 顺带记下旧节点：重绘会整块换新节点，用引用比较才能确定"新内容已经上屏"。
     */
    const oldEl = findLoreEntryElement(uidNum);
    const oldContent = oldEl?.querySelector('.inline-drawer-content');
    const wasExpanded = Boolean(
        oldEl?.querySelector('.inline-drawer-icon.up')
        || (oldContent && oldContent.style.display !== 'none'),
    );

    try {
        ctx.reloadWorldInfoEditor(book);
    } catch (err) {
        console.debug('[Thrive] 刷新世界书编辑器失败', err);
        return { refreshed: false, reason: 'failed' };
    }

    /*
     * 重绘是异步的（`reloadEditor` 只是 trigger('change')，真正的重画在后面的 await 里）。
     * 只等"列表里有元素"是不够的：trigger 返回时旧的还没被清掉，会立刻命中。
     * 所以有旧节点就等它被换掉，没有就给它一个 tick 的时间。
     */
    if (oldEl) {
        for (let i = 0; i < 40; i += 1) {
            const el = findLoreEntryElement(uidNum);
            if (el && el !== oldEl) {
                break;
            }
            await sleep(25);
        }
    } else {
        await sleep(80);
    }

    if (searchText && searchEl) {
        // reloadEditor 的 change 处理器会把搜索框清空，这里放回去
        searchEl.value = searchText;
        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(350); // 搜索是防抖的，等过滤跑完再定位条目
    } else {
        goToPage(page);
        await sleep(page > 1 ? 200 : 0);
    }

    const entryEl = findLoreEntryElement(uidNum);
    if (entryEl) {
        if (wasExpanded) {
            // 交回给 ST 自己的点击处理器：它会用新拷贝重建抽屉内容并展开
            entryEl.querySelector('.inline-drawer-toggle')?.click();
            await sleep(300);
        }
        try {
            entryEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
            // 老浏览器不认平滑滚动
        }
        flashLoreEntry(entryEl);
    }

    return { refreshed: true, focused: Boolean(entryEl) };
}
