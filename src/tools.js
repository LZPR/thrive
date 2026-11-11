/**
 * tools.js · 十个工具的定义与实现
 *
 * v0.33 起它们**不再注册给聊天**（ADR-050）。学习发生在独立会话里，会话自己
 * 带着一份 tools 数组发请求；聊天请求里既没有插件提示词也没有插件工具。
 *
 * 所以这里只做一件事：维护一张定义表（名字 / 描述 / 参数 / 实现），
 * 由 session-tools.js 取走。表在第一次被取时建一次，之后复用。
 *
 * 十个工具按"读得越少，能写的越少"分四级守卫（见 store.js 的 reads 键表）：
 *
 *   目录 l/list  → 新建 add
 *   见过标题     → 追加 append
 *   预读同一正则 → 替换 replace
 *   读过全文     → 整段重写 rewrite
 *
 * 之所以不做一个万能 write：参数一多，模型就要在一个调用里同时决定"改哪条、
 * 怎么改、要不要新建"，错一步就是一次内容事故；拆开之后每个工具只回答一个问题，
 * 守卫也能按"它到底看到了多少"精确地放行。
 *
 * 工具只在学习会话跑着的时候可用（store.isLearningActive）。这既是"聊天里没有
 * 这套工具"的自然结果，也挡住了会话结束后残留的调用。
 */

import { getContext } from './platform/sillytavern/context.js';
import {
    BOOK_SEEN,
    bookReadKey,
    clearReadHash,
    clearReadKeysByPrefix,
    DESC_SEEN,
    descPatternKey,
    descPatternPrefix,
    ensureSettings,
    getReadHash,
    getState,
    isLearningActive,
    lorePatternKey,
    lorePatternPrefix,
    loreReadKey,
    loreSeenKey,
    READ_KEY_DESC,
    rememberLoreBackup,
    saveChat,
    setReadHash,
} from './store.js';
import { readLimits } from './limits.js';
import {
    appendLoreEntry,
    createLoreEntry,
    findLoreEntry,
    getActiveCharacter,
    getWritableBook,
    isBookScanned,
    listLore,
    loadWritableBook,
    locateLoreEntry,
    replaceLoreEntry,
} from './targets.js';
import {
    diskDescription,
    getPatch,
    PATCH_STATUS,
    stagePatch,
} from './patch.js';
import { isWorldbookDesc, readDescription, writeDesc } from './desc.js';
import { isReservedTitle } from './desc-entry.js';
import { ensureDraft, layerFor, rollbackEmptyDraft } from './draft.js';
import { compilePattern, replaceIn, scan } from './regex.js';
import { TOOL_NAMES } from './tool-names.js';
import { hintFor } from './diagnostics.js';
import { appendParagraph, fnv1a, isBlank, truncate } from './util.js';

const LOG = '[Thrive]';

export { TOOL_NAMES };

/** 工具定义表。`{ name, description, parameters, action }`，action 永不 throw */
const DEFS = [];

let built = false;

function define(def) {
    DEFS.push(def);
}

/**
 * 取全部工具定义。第一次调用时建表，之后原样复用。
 *
 * 每个 `action` 都返回 ST 形状的 `{ ok, error?, hint? }`；session-tools.js 负责把它
 * 序列化成工具消息的正文（并保证非空——`role:'tool'` 的内容空掉会让整条消息消失）。
 *
 * @returns {Array<{ name: string, description: string, parameters: object, action: Function }>}
 */
export function getToolDefs() {
    if (!built) {
        buildLoreTools();
        buildDescTools();
        built = true;
    }
    return DEFS.slice();
}

/**
 * 这组工具此刻可不可用。
 *
 * 两个条件：学习会话正在跑（否则连调用入口都没有），世界书工具还要求选了可写书。
 * 描述工具两种存储模式都有，换的只是落点。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isToolAvailable(name) {
    if (!isLearningActive()) {
        return false;
    }

    const key = String(name ?? '');
    if (key.startsWith('lore_')) {
        return Boolean(getWritableBook(getContext()));
    }
    return true;
}

/* ------------------------------------------------------------ 世界书工具 */

function buildLoreTools() {
    define({
        name: TOOL_NAMES.LORE_LIST,
        displayName: '列出世界书条目',
        description: '列出当前可写世界书里已启用的条目，只给标题，不给正文。'
            + '用 pattern 可以按标题或触发关键词过滤。'
            + '这是写之前了解这本书已有什么的第一步；要看某条的正文用 lore_read。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '正则表达式，匹配标题或触发关键词。省略则列出全部。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
                limit: {
                    type: 'number',
                    description: '最多返回几条标题。省略用设置里的默认值。',
                },
            },
        },
        action: guardAction(TOOL_NAMES.LORE_LIST, handleLoreList),
        formatMessage: params => (isBlank(params?.pattern) ? '浏览世界书目录' : `筛选世界书：${params.pattern}`),
    });

    define({
        name: TOOL_NAMES.LORE_READ,
        displayName: '读取世界书条目',
        description: '读取一条世界书条目的正文。给 pattern 则只返回命中的片段，不返回全文。'
            + '整段重写（lore_rewrite）之前必须先读到全文；追加或替换前先确认正文里已有什么。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，与 lore_list 里显示的完全一致。',
                },
                pattern: {
                    type: 'string',
                    description: '正则表达式。给了就只返回命中片段及其位置，不返回全文。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
            },
            required: ['title'],
        },
        action: guardAction(TOOL_NAMES.LORE_READ, handleLoreRead),
        formatMessage: params => `读取世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_ADD,
        displayName: '新建世界书条目',
        description: '新建一条世界书条目。标题已存在时返回 TITLE_EXISTS，不会覆盖。'
            + '新建前先看目录，避免写出内容重复的条目。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，同书内唯一。用短的专有名词，不要写成句子。',
                },
                content: {
                    type: 'string',
                    description: '条目正文，完整内容。',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '触发关键词，至少 1 个。没有关键词的条目永远不会被触发。',
                },
                logic: {
                    type: 'string',
                    enum: ['any', 'all', 'not_all', 'not_any'],
                    description: '关键词组合方式，省略表示 any（任一命中）。',
                },
            },
            required: ['title', 'content', 'keys'],
        },
        action: guardAction(TOOL_NAMES.LORE_ADD, handleLoreAdd),
        formatMessage: params => `新建世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_APPEND,
        displayName: '追加世界书条目',
        description: '在已有条目正文末尾追加内容，或追加触发关键词，原文一个字都不动。'
            + '只给 content 只加正文，只给 keys 只加关键词。'
            + '只要目录里见过这条标题就能调用，不需要先读全文。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，必须已存在。',
                },
                content: {
                    type: 'string',
                    description: '追加到正文末尾的内容，与原文之间自动空一行。',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '追加的触发关键词。已存在的自动跳过，超过上限的截断。',
                },
            },
            required: ['title'],
        },
        action: guardAction(TOOL_NAMES.LORE_APPEND, handleLoreAppend),
        formatMessage: params => `追加世界书条目：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_REPLACE,
        displayName: '正则替换世界书正文',
        description: '用正则替换条目正文里的片段，未被匹配的部分原样保留。'
            + '替换前先用 lore_read 带同一个 pattern 看一眼会命中什么。'
            + '0 处匹配、或多处匹配而 replace_all=false 时直接拒绝并返回命中情况，不会猜。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题。',
                },
                pattern: {
                    type: 'string',
                    description: '要匹配的正则，与预读时用的完全一致。',
                },
                replacement: {
                    type: 'string',
                    description: '替换成的文本，支持 $1 引用捕获组；空串表示删掉这段匹配。',
                },
                replace_all: {
                    type: 'boolean',
                    description: '是否替换所有匹配。默认 false，此时出现多处匹配会拒绝。',
                },
                flags: {
                    type: 'string',
                    description: 'i / m / s / u，可连写。不支持 g（由 replace_all 控制）。',
                },
            },
            required: ['title', 'pattern', 'replacement'],
        },
        action: guardAction(TOOL_NAMES.LORE_REPLACE, handleLoreReplace),
        formatMessage: params => `替换世界书正文：${params?.title ?? ''}`,
    });

    define({
        name: TOOL_NAMES.LORE_REWRITE,
        displayName: '整段重写世界书正文',
        description: '用新正文整段替换条目正文，用于压缩过长条目或重排结构。'
            + '只改正文：标题、关键词、触发方式一律保持原样，要改关键词用 lore_append。'
            + '改写前必须先读到全文。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题。',
                },
                content: {
                    type: 'string',
                    description: '新的正文全文，不是片段。',
                },
            },
            required: ['title', 'content'],
        },
        action: guardAction(TOOL_NAMES.LORE_REWRITE, handleLoreRewrite),
        formatMessage: params => `重写世界书正文：${params?.title ?? ''}`,
    });
}

/* ------------------------------------------------------------ 描述工具 */

function buildDescTools() {
    define({
        name: TOOL_NAMES.DESC_READ,
        displayName: '读取角色描述',
        description: '读取当前角色的描述。省略 pattern 返回全文与字数；给 pattern 只返回命中片段。'
            + '写入前先读：追加和替换至少要知道描述里已有什么，整段重写必须读到全文。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '正则表达式。给了就只返回命中片段及其位置，不返回全文。',
                },
                flags: {
                    type: 'string',
                    description: 'i 忽略大小写、m 多行、s 让 . 匹配换行，可连写如 im。不支持 g。',
                },
            },
        },
        action: guardAction(TOOL_NAMES.DESC_READ, handleDescRead),
        formatMessage: params => (isBlank(params?.pattern) ? '读取角色描述' : `检索角色描述：${params.pattern}`),
    });

    define({
        name: TOOL_NAMES.DESC_APPEND,
        displayName: '追加角色描述',
        description: '在角色描述末尾追加一段，原文不动。'
            + '只放角色自身的经历、外貌、认知与态度，不放世界设定。',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '要追加的内容，与原文之间自动空一行。',
                },
            },
            required: ['text'],
        },
        action: guardAction(TOOL_NAMES.DESC_APPEND, handleDescAppend),
        formatMessage: () => '追加角色描述',
    });

    define({
        name: TOOL_NAMES.DESC_REPLACE,
        displayName: '正则替换角色描述',
        description: '用正则替换角色描述里的片段，未被匹配的部分原样保留。'
            + '替换前先用 desc_read 带同一个 pattern 看一眼会命中什么。'
            + '0 处匹配、或多处匹配而 replace_all=false 时直接拒绝。',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '要匹配的正则，与预读时用的完全一致。',
                },
                replacement: {
                    type: 'string',
                    description: '替换成的文本，支持 $1 引用捕获组；空串表示删掉这段匹配。',
                },
                replace_all: {
                    type: 'boolean',
                    description: '是否替换所有匹配。默认 false，此时出现多处匹配会拒绝。',
                },
                flags: {
                    type: 'string',
                    description: 'i / m / s / u，可连写。不支持 g（由 replace_all 控制）。',
                },
            },
            required: ['pattern', 'replacement'],
        },
        action: guardAction(TOOL_NAMES.DESC_REPLACE, handleDescReplace),
        formatMessage: params => `替换角色描述：${params?.pattern ?? ''}`,
    });

    define({
        name: TOOL_NAMES.DESC_REWRITE,
        displayName: '整段重写角色描述',
        description: '用新文本整段重写角色描述，用于压缩或整体重排。'
            + '重写前必须先用 desc_read 读到全文。',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '新的描述全文，不是片段。',
                },
            },
            required: ['text'],
        },
        action: guardAction(TOOL_NAMES.DESC_REWRITE, handleDescRewrite),
        formatMessage: () => '整段重写角色描述',
    });
}

/**
 * 工具调用前的守卫：定义表里有不等于现在能用。
 *
 * 会话结束后模型可能还留着一轮递归（或者别处误调），这里统一拒绝并给一句话，
 * 比让它反复试别的工具好。
 *
 * @param {string} name
 * @param {(params: object) => Promise<object>} handler
 */
function guardAction(name, handler) {
    return async params => {
        if (!isToolAvailable(name)) {
            return errorResult('TOOL_UNAVAILABLE');
        }
        return handler(params);
    };
}

/* --------------------------------------------------------------- lore_list */

async function handleLoreList(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }
    if (!getWritableBook(ctx)) {
        return errorResult('NO_BOOK', '还没有选择可写书，请让用户在浮动面板里选一本。');
    }

    const listed = await listLore(ctx);
    if (!listed.ok) {
        return errorResult(listed.error, listed.hint);
    }

    const limits = readLimits(settings);
    const enabled = listed.items.filter(item => item.disabled !== true);

    let picked = enabled;
    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }
        // 只看标题和关键词：目录不扫正文，那是 lore_read 的活
        picked = enabled.filter(item => compiled.regex.test(item.title)
            || item.keys.some(key => compiled.regex.test(key)));
    }

    const wanted = Number(params?.limit);
    const cap = Number.isFinite(wanted) && wanted > 0
        ? Math.min(Math.trunc(wanted), limits.listLimit)
        : limits.listLimit;
    const shown = picked.slice(0, cap);

    const payload = {
        ok: true,
        book: listed.book,
        total: listed.items.length,
        enabled: enabled.length,
        truncated: picked.length > shown.length,
        titles: shown.map(item => item.title),
    };

    const disabledCount = listed.items.length - enabled.length;
    if (disabledCount > 0) {
        payload.disabled_count = disabledCount;
    }

    if (payload.truncated) {
        payload.hint = `还有 ${picked.length - shown.length} 条没列出。用 pattern 缩小范围，或把设置里的目录上限调大。`;
    }

    // 条目多到一定程度就该提醒合并：这是模型自己能做的动作，不替它对用户说话
    const merge = listed.items.length > limits.softEntryCount
        ? `这本书已经有 ${listed.items.length} 条，考虑合并重复条目。`
        : '';
    if (merge) {
        payload.note = [payload.note, merge].filter(Boolean).join(' ');
    }

    applyBookNotes(ctx, listed.book, payload);
    registerDirectoryRead(ctx, listed.book, shown);

    console.debug(`${LOG} lore_list`, {
        book: listed.book,
        total: payload.total,
        shown: shown.length,
        filtered: !isBlank(pattern),
    });

    return payload;
}

/** 目录读过 = 新建条目的前置。只登记真正列出来的那些标题 */
function registerDirectoryRead(ctx, book, shown) {
    setReadHash(ctx, bookReadKey(book), BOOK_SEEN);
    for (const item of shown) {
        setReadHash(ctx, loreSeenKey(book, item.title), BOOK_SEEN);
    }
}

/* --------------------------------------------------------------- lore_read */

async function handleLoreRead(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }
    if (!getWritableBook(ctx)) {
        return errorResult('NO_BOOK', '还没有选择可写书，请让用户在浮动面板里选一本。');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', 'title 是必填的。要浏览这本书有什么，用 lore_list。');
    }

    const located = await locateLoreEntry(ctx, title);
    if (!located.ok) {
        return errorResult(located.error, located.hint);
    }

    const { book, found } = located;
    const full = String(found.entry.content ?? '');
    const limits = readLimits(settings);

    // 见过标题，追加就放行了 —— 但仍然不登记全文，整段重写还得真读到全文
    setReadHash(ctx, loreSeenKey(book, title), BOOK_SEEN);

    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }

        const hit = scan(full, compiled, {
            window: limits.matchWindow,
            maxMatches: limits.maxMatches,
        });

        // 命中 0 处不登记：没有"会替换掉什么"可看，替换本来就该先改 pattern
        if (hit.count > 0) {
            setReadHash(ctx, lorePatternKey(book, title, compiled.flags, compiled.source), String(hit.count));
        }

        const payload = { ok: true, book, title, count: hit.count, matches: hit.matches };
        if (hit.truncated) {
            payload.truncated = true;
            payload.hint = `命中 ${hit.count} 处，只列了前 ${hit.matches.length} 处。pattern 写得更具体一些。`;
        } else if (hit.count === 0) {
            payload.hint = '这条里没有命中。换一个关键词，或去掉 pattern 读全文。';
        }
        applyReadNotes(ctx, book, payload);
        return payload;
    }

    const cut = truncate(full, limits.maxReadChars);
    const payload = {
        ok: true,
        book,
        title,
        chars: full.length,
        keys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        content: cut.text,
    };

    if (found.entry.disable === true) {
        // 停用条目照实显示：内容是存在的，只是生成时不会触发
        payload.disabled = true;
    }

    if (cut.truncated) {
        // 截断过就不登记全文：拿半截文本去重写，后半段会被冲掉
        payload.truncated = true;
        payload.note = `正文 ${full.length} 字，这里只返回了前 ${limits.maxReadChars} 字。`
            + '整段重写需要完整正文，请改用 lore_replace 做局部修改，或让用户把上限调大。';
    } else {
        setReadHash(ctx, loreReadKey(book, title), fnv1a(full));
    }

    /*
     * 软提醒不再出现在返回里。
     *
     * 以前这里会附 over_limit + 一段压缩指令，让模型自己把条目压短——结果是它在
     * 完全不了解上下文的情况下把设定压成摘要，而用户根本不知道发生过什么。
     * 现在"该压哪条、压到什么程度"只在压缩面板里由用户判断（见 compress.js），
     * 模型侧只剩硬上限：写不进去就是写不进去。
     */

    applyReadNotes(ctx, book, payload);

    console.debug(`${LOG} lore_read`, {
        book,
        title,
        chars: full.length,
        truncated: Boolean(cut.truncated),
    });

    return payload;
}

/* ---------------------------------------------------------------- lore_add */

async function handleLoreAdd(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空：它既是同书内的唯一标识，也会显示在世界书列表里。请用短的专有名词。');
    }
    if (title.length > limits.titleMaxChars) {
        return errorResult('TITLE_TOO_LONG', `标题 ${title.length} 字，超过 ${limits.titleMaxChars} 字上限。请精简成一个短的专有名词。`);
    }

    // 保留守卫要排在"读到书"之前：这是目标不对，不是书读不到
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;

    // 守卫一：先看目录。看不见目录就新建，等于闭着眼睛往书里塞重复条目
    if (!getReadHash(ctx, bookReadKey(book))) {
        return errorResult('READ_REQUIRED', `本轮还没看过「${book}」的目录。先调用 lore_list 确认里面已有什么，避免写出重复条目。`);
    }

    if (findLoreEntry(data, title)) {
        return errorResult('TITLE_EXISTS', `「${title}」已经存在。要改正文用 lore_rewrite，要补内容用 lore_append。`);
    }

    const content = String(params?.content ?? '').trim();
    if (isBlank(content)) {
        return errorResult('EMPTY_CONTENT', '正文为空。世界书条目不能写成空内容，否则等同于删除。');
    }
    if (content.length > limits.hardLimitEntry) {
        return errorResult('TOO_LONG',
            `正文 ${content.length} 字，超过单条上限 ${limits.hardLimitEntry} 字。这次没有写入：请精简到上限以内，或者拆成两条分别新建。`);
    }

    const normalized = normalizeKeys(params?.keys);
    if (normalized.keys.length === 0) {
        return errorResult('NO_KEYS', '新建条目至少要给 1 个关键词，否则它永远不会被触发，等于写进黑洞。');
    }

    const keys = normalized.keys.slice(0, limits.maxKeywords);
    const droppedKeys = normalized.keys.length - keys.length;
    const logic = normalizeLogic(params?.logic);

    // 守卫全过完了，才开缓冲区：被 READ_REQUIRED 挡住的写入不该留下一块空壳
    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await createLoreEntry(ctx, settings, book, data, { title, content, keys, logic });
    if (!written.ok) {
        console.debug(`${LOG} lore_add 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'created',
        layer: layerFor(ctx, book),
        before: '',
        beforeKeys: [],
        chars: written.content.length,
    });
    // 新建：正文就是模型自己写的，算读过
    registerLoreWrite(ctx, book, title, written, { fullText: true });
    saveChat(ctx);

    const notes = [bookNote(ctx, book)];

    if (droppedKeys > 0) {
        notes.push(`关键词超过上限 ${limits.maxKeywords} 个，已只保留前 ${limits.maxKeywords} 个。`);
    }

    console.debug(`${LOG} lore_add`, { book, title, chars: written.content.length, keys: written.keys.length });

    return {
        ok: true,
        title,
        uid: written.uid,
        action: 'created',
        chars: written.content.length,
        keys: written.keys.length,
        note: notes.filter(Boolean).join(' '),
    };
}

/* ------------------------------------------------------------- lore_append */

async function handleLoreAppend(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要追加必须先说明追加到哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。先用 lore_list 看现有标题，或改用 lore_add 新建。`);
    }

    // 守卫：目录里见过这条标题就够 —— 追加不破坏原文，只要确认目标真实存在
    if (!getReadHash(ctx, loreSeenKey(book, title))) {
        return errorResult('READ_REQUIRED', `本轮还没确认过「${title}」存在。先调用 lore_list（或带 pattern 的 lore_read）看到这条标题再追加。`);
    }

    const content = String(params?.content ?? '');
    const keys = normalizeKeys(params?.keys).keys;

    if (isBlank(content) && keys.length === 0) {
        return errorResult('EMPTY_CONTENT', 'content 和 keys 都是空的。要追加正文就给 content，要加触发词就给 keys。');
    }

    const before = String(found.entry.content ?? '');
    const beforeKeys = Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await appendLoreEntry(ctx, book, data, found, {
        content,
        keys,
        maxKeywords: limits.maxKeywords,
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_append 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before,
        beforeKeys,
        chars: written.content.length,
    });
    // 追加：正文是插件拼的，模型没见过拼完的全文
    registerLoreWrite(ctx, book, title, written, { fullText: false });
    saveChat(ctx);

    const notes = [bookNote(ctx, book)];

    if (written.addedChars === 0) {
        notes.push('正文没有变化（content 为空）。');
    }
    if (written.skippedKeys.length > 0) {
        notes.push(`已有这些关键词，跳过：${written.skippedKeys.join('、')}。`);
    }

    console.debug(`${LOG} lore_append`, {
        book,
        title,
        addedChars: written.addedChars,
        addedKeys: written.addedKeys.length,
    });

    return {
        ok: true,
        title,
        added_chars: written.addedChars,
        added_keys: written.addedKeys,
        skipped_keys: written.skippedKeys,
        chars: written.content.length,
        keys: written.keys.length,
        note: notes.filter(Boolean).join(' '),
    };
}

/* ------------------------------------------------------------ lore_replace */

async function handleLoreReplace(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要替换必须说明改哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const compiled = compilePattern(params?.pattern, params?.flags, limits.patternMaxChars);
    if (!compiled.ok) {
        return errorResult(compiled.error, compiled.hint);
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。先用 lore_list 看现有标题。`);
    }

    // 守卫：同一个 pattern 预读过。预读本身就是"看清会替换掉什么"，比任何叮嘱都有效
    const patternKey = lorePatternKey(book, title, compiled.flags, compiled.source);
    if (!canReplace(ctx, patternKey, loreReadKey(book, title), String(found.entry.content ?? ''))) {
        return errorResult('READ_REQUIRED', `本轮还没看过「${title}」的正文。先 lore_read（带同一个 pattern 最省）确认会命中什么，再替换。`);
    }

    const current = String(found.entry.content ?? '');
    const replaced = replaceIn(current, compiled, params?.replacement, params?.replace_all === true, {
        window: limits.matchWindow,
    });

    if (!replaced.ok) {
        const failed = errorResult(replaced.error, replaced.hint);
        if (Number.isFinite(replaced.count)) {
            failed.count = replaced.count;
        }
        if (Array.isArray(replaced.matches)) {
            failed.matches = replaced.matches;
        }
        return failed;
    }

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await replaceLoreEntry(ctx, book, data, found, replaced.text, {
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_replace 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before: current,
        beforeKeys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        chars: written.content.length,
    });
    // 替换：合成后的正文模型没读过
    registerLoreWrite(ctx, book, title, written, { fullText: false });
    saveChat(ctx);

    console.debug(`${LOG} lore_replace`, {
        book,
        title,
        replaced: replaced.replaced,
        before: written.beforeChars,
        after: written.afterChars,
    });

    return {
        ok: true,
        title,
        replaced: replaced.replaced,
        before_chars: written.beforeChars,
        after_chars: written.afterChars,
        sample: replaced.sample,
        note: bookNote(ctx, book),
    };
}

/* ------------------------------------------------------------ lore_rewrite */

async function handleLoreRewrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要重写必须说明改哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。整段重写不会新建条目，要新建用 lore_add。`);
    }

    const current = String(found.entry.content ?? '');
    const recorded = getReadHash(ctx, loreReadKey(book, title));

    if (!recorded) {
        return errorResult('READ_REQUIRED', `本轮还没读过「${title}」的全文。先 lore_read（不带 pattern）拿到完整正文，再整段重写。`);
    }
    if (fnv1a(current) !== recorded) {
        return errorResult('STALE_READ', `「${title}」在你读取之后被改动过（可能是用户或其他窗口改的）。请重新 lore_read 拿最新正文，不要重试原来的参数。`);
    }

    const content = String(params?.content ?? '').trim();
    if (isBlank(content)) {
        return errorResult('EMPTY_CONTENT', '正文为空。空条目等于删除，不做。');
    }
    if (content.length > limits.hardLimitEntry) {
        return errorResult('TOO_LONG',
            `正文 ${content.length} 字，超过单条上限 ${limits.hardLimitEntry} 字。这次没有写入：请精简到上限以内再整段重写，或者改用 lore_replace 只改其中一段。`);
    }

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await replaceLoreEntry(ctx, book, data, found, content, {
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_rewrite 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before: current,
        beforeKeys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        chars: written.content.length,
    });
    // 整段重写：模型提交的就是全文
    registerLoreWrite(ctx, book, title, written, { fullText: true });
    saveChat(ctx);

    console.debug(`${LOG} lore_rewrite`, {
        book,
        title,
        before: written.beforeChars,
        after: written.afterChars,
    });

    return {
        ok: true,
        title,
        before_chars: written.beforeChars,
        after_chars: written.afterChars,
        note: bookNote(ctx, book),
    };
}

/* --------------------------------------------------------------- desc_read */

async function handleDescRead(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const limits = readLimits(settings);
    // 两种模式在这里合流：card 模式返回 patch 视图（暂存期间是 after），
    // worldbook 模式返回世界书条目的正文
    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const text = view.text;

    // 看过描述这件事本身：追加的前置。哪怕只是查了一个词，模型也算知道"这里有什么"
    setReadHash(ctx, DESC_SEEN, BOOK_SEEN);

    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }

        const hit = scan(text, compiled, {
            window: limits.matchWindow,
            maxMatches: limits.maxMatches,
        });

        if (hit.count > 0) {
            setReadHash(ctx, descPatternKey(compiled.flags, compiled.source), String(hit.count));
        }

        const payload = { ok: true, count: hit.count, matches: hit.matches };
        if (hit.truncated) {
            payload.truncated = true;
            payload.hint = `命中 ${hit.count} 处，只列了前 ${hit.matches.length} 处。pattern 写得更具体一些。`;
        } else if (hit.count === 0) {
            payload.hint = '描述里没有命中。换一个关键词，或去掉 pattern 读全文。';
        }
        if (view.staged) {
            payload.staged = true;
            payload.note = '这份内容还没写入角色卡，用户确认后才会落盘。';
        }
        return payload;
    }

    // 全文必读且不截断：描述有硬上限，写入侧就是按这份全文算的字数。
    // 只给半截会让模型基于半截改写，后半段被冲掉
    setReadHash(ctx, READ_KEY_DESC, fnv1a(text));

    const chars = text.length;
    const payload = { ok: true, chars, text };

    /*
     * 软提醒不再进返回（见 lore_read 里的说明）。硬上限仍然只在写入侧拦：
     * 读多少字不影响任何东西，读回来是为了让模型有完整正文可用。
     */

    if (view.staged) {
        payload.staged = true;
        payload.note = '这份内容还没写入角色卡，用户确认后才会落盘；在此之前 prompt 里仍是原描述。';
    }

    console.debug(`${LOG} desc_read`, { chars, staged: view.staged });

    return payload;
}

/* ------------------------------------------------------------- desc_append */

async function handleDescAppend(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    if (!getReadHash(ctx, DESC_SEEN)) {
        return errorResult('READ_REQUIRED', '本轮还没读过角色描述。先调用 desc_read（带 pattern 查一下也行），确认里面已有什么再追加。');
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;

    // 读过全文的话顺手做一次变更检测：内容变了，模型对"末尾是什么"的认知就不成立了
    const recorded = getReadHash(ctx, READ_KEY_DESC);
    if (recorded && fnv1a(base) !== recorded) {
        return errorResult('STALE_READ', '角色描述在你读取之后被改动过。请重新调用 desc_read 拿到最新内容，不要重试原来的参数。');
    }

    const text = String(params?.text ?? '');
    if (isBlank(text)) {
        return errorResult('EMPTY_CONTENT', '写入内容为空。如果要追加，请给出具体文字。');
    }

    const next = appendParagraph(base, text);
    const hardLimit = limits.hardLimitDesc;
    if (next.length > hardLimit) {
        return errorResult('TOO_LONG',
            `追加后共 ${next.length} 字，超过上限 ${hardLimit} 字。这次没有写入：请少追加一些，或改用 desc_replace 顺手删掉一段再写。`);
    }

    const committed = await commitDescription(ctx, { next, fullText: false });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_append`, { added: next.length - base.length, chars: next.length, staged: committed.staged });

    return {
        ...committed,
        added: next.length - base.length,
        chars: next.length,
    };
}

/* ------------------------------------------------------------ desc_replace */

async function handleDescReplace(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    const compiled = compilePattern(params?.pattern, params?.flags, limits.patternMaxChars);
    if (!compiled.ok) {
        return errorResult(compiled.error, compiled.hint);
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;

    // 守卫：这个 pattern 预读过，或者这一轮读过全文。都没有就是闭着眼睛改字
    if (!canReplace(ctx, descPatternKey(compiled.flags, compiled.source), READ_KEY_DESC, base)) {
        return errorResult('READ_REQUIRED', '本轮还没看过描述里对应的内容。先 desc_read（带同一个 pattern 最省）确认会命中什么，再替换。');
    }
    const replaced = replaceIn(base, compiled, params?.replacement, params?.replace_all === true, {
        window: limits.matchWindow,
    });

    if (!replaced.ok) {
        const failed = errorResult(replaced.error, replaced.hint);
        if (Number.isFinite(replaced.count)) {
            failed.count = replaced.count;
        }
        if (Array.isArray(replaced.matches)) {
            failed.matches = replaced.matches;
        }
        return failed;
    }

    const hardLimit = limits.hardLimitDesc;
    if (replaced.text.length > hardLimit) {
        return errorResult('TOO_LONG',
            `替换后共 ${replaced.text.length} 字，超过上限 ${hardLimit} 字。这次没有写入：把替换内容写短一些，或分几次局部替换。`);
    }

    const committed = await commitDescription(ctx, { next: replaced.text, fullText: false });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_replace`, {
        replaced: replaced.replaced,
        before: base.length,
        after: replaced.text.length,
        staged: committed.staged,
    });

    return {
        ...committed,
        replaced: replaced.replaced,
        before_chars: base.length,
        chars: replaced.text.length,
        sample: replaced.sample,
    };
}

/* ------------------------------------------------------------ desc_rewrite */

async function handleDescRewrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;
    const recorded = getReadHash(ctx, READ_KEY_DESC);

    if (!recorded) {
        return errorResult('READ_REQUIRED', '本轮还没读过角色描述全文。先调用 desc_read（不带 pattern），再按读到的内容整段重写。');
    }
    if (fnv1a(base) !== recorded) {
        return errorResult('STALE_READ', '角色描述在你读取之后被改动过。请重新调用 desc_read 拿到最新内容，不要重试原来的参数。');
    }

    const text = String(params?.text ?? '');
    if (isBlank(text)) {
        return errorResult('EMPTY_CONTENT', '写入内容为空。整段重写要给出完整的新描述。');
    }

    const next = text.trim();
    const hardLimit = limits.hardLimitDesc;
    if (next.length > hardLimit) {
        return errorResult('TOO_LONG',
            `正文 ${next.length} 字，超过上限 ${hardLimit} 字。这次没有写入：整段重写必须一次给到上限以内，否则先用 desc_replace 删掉一部分。`);
    }

    const committed = await commitDescription(ctx, { next, fullText: true });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_rewrite`, {
        before: base.length,
        after: next.length,
        staged: committed.staged,
    });

    return {
        ...committed,
        before_chars: base.length,
        chars: next.length,
    };
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 三个描述写入共用的前置：学习模式开着、有角色、没有冲突的 patch。
 *
 * 顺序不可调（spec §8）：先判"能不能写"，再判"读没读过"，最后才是参数。
 * 反过来的话，模型会因为参数错误而一直发现不了自己漏了读取。
 */
function checkDescriptionWrite(ctx) {
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return errorResult('NO_CHAR', '当前没有选中角色，请让用户先在角色列表里选一个。');
    }

    // worldbook 模式没有 patch，也就不存在"冲突待处理"这件事
    if (isWorldbookDesc(ctx)) {
        return { ok: true };
    }

    // 冲突是用户没做完的决定：这时的磁盘值和 patch.before 都不代表"现在的样子"，
    // 再合进一笔，谁覆盖谁就没有答案了（spec §10）
    if (getPatch(ctx)?.status === PATCH_STATUS.CONFLICT) {
        return errorResult('PATCH_CONFLICT', '角色描述有一份冲突的改动等着用户处理（暂存之后磁盘被改过）。'
            + '这一轮不要再写描述，继续正文即可；用户处理完再写。');
    }

    return { ok: true };
}

/**
 * 描述写完之后的读取登记。
 *
 * 与世界书同一条规则：整段重写提交的就是全文，算读过；追加和替换合成的正文
 * 模型没读过，只留"看过描述"，并把旧的全文哈希清掉。
 */
function registerDescWrite(ctx, next, fullText) {
    setReadHash(ctx, DESC_SEEN, BOOK_SEEN);

    if (fullText) {
        setReadHash(ctx, READ_KEY_DESC, fnv1a(next));
    } else {
        clearReadHash(ctx, READ_KEY_DESC);
    }

    clearReadKeysByPrefix(ctx, descPatternPrefix());
}

/**
 * 描述写入的收尾。两种存储模式各走一条，但都要做同一件事：
 * 把读取登记推到新版本 —— 不这么做，同一次回复里的第二笔写入会被自己的
 * STALE_READ 挡住（ADR-007）。
 *
 * card 模式：恒走暂存，用户确认后才落盘（ADR-005 / ADR-046）。直写那条路已经没有了：
 *   它唯一的用途是"关掉暂存"，而那个开关不存在了，描述又每轮都在 system 前缀里，
 *   合并成一笔才值钱。
 * worldbook 模式：直接写进世界书条目，没有暂存也没有 diff（ADR-042）。
 *   不碰角色卡、不碰角色编辑框、不写 backups.desc —— 那条快照槽位属于 card 模式，
 *   世界书的撤销走 backups.lore（面板「已写入 → 恢复写入前」）。
 */
async function commitDescription(ctx, { next, fullText }) {
    if (isWorldbookDesc(ctx)) {
        const written = await writeDesc(ctx, next);
        if (!written.ok) {
            console.debug(`${LOG} 描述写入失败`, written.error);
            return written;
        }

        registerDescWrite(ctx, next, fullText);
        // writeDesc 里记了世界书快照（chat_metadata），得落一次盘
        saveChat(ctx);

        return {
            ok: true,
            staged: false,
            applied: true,
            note: `已写入世界书「${written.book}」的【角色描述】条目，最迟下一轮生效。`,
        };
    }

    const disk = diskDescription(ctx);
    stagePatch(ctx, { before: disk, after: next });
    registerDescWrite(ctx, next, fullText);
    // 正文变了，之前预读过的正则命中位置都可能不再成立
    clearReadKeysByPrefix(ctx, descPatternPrefix());

    return {
        ok: true,
        staged: true,
        note: '已暂存，用户确认后才写入角色卡。在此之前你的续写仍按原描述进行。',
    };
}

/**
 * 世界书写完之后统一登记。
 *
 * `fullText` 区分了"模型见过全文"和"模型只给了增量"：
 *   - 新建 / 整段重写：新正文就是模型自己写的那份，登记全文哈希（ADR-007 的自写视为已读）
 *   - 追加 / 替换：正文档是插件合成的，模型没见过合成后的全文 —— 这时只留"见过标题"，
 *     并把旧的全文哈希**清掉**。不清的话，下一次整段重写会拿着一个它从没读过的版本号放行。
 *
 * 无论哪种，都要作废该条目上所有 pattern 预读：正文变了，命中位置不再成立。
 */
function registerLoreWrite(ctx, book, title, written, { fullText }) {
    setReadHash(ctx, loreSeenKey(book, title), BOOK_SEEN);
    setReadHash(ctx, bookReadKey(book), BOOK_SEEN);

    if (fullText) {
        setReadHash(ctx, loreReadKey(book, title), fnv1a(written.content));
    } else {
        clearReadHash(ctx, loreReadKey(book, title));
    }

    clearReadKeysByPrefix(ctx, lorePatternPrefix(book, title));
}

/**
 * 替换的放行条件：同一 pattern 预读过，**或者**这一轮已经读过全文。
 *
 * 读过全文当然包含了"看清会替换掉什么"，没必要因为它没走 pattern 那一趟就再罚一次；
 * 反过来，只有 pattern 命中也够——那正是局部编辑需要的全部信息。
 */
function canReplace(ctx, patternKey, fullKey, current) {
    if (getReadHash(ctx, patternKey)) {
        return true;
    }
    const recorded = getReadHash(ctx, fullKey);
    return Boolean(recorded) && fnv1a(current) === recorded;
}

/**
 * 读侧的两条附注：换书提醒（ADR-017）与"这本书没激活"（ADR-021）。
 *
 * 读的范围只剩可写书（ADR-046），所以没有"读到只读的那本"这种附注了——
 * 能读到的条目就是能改的那条。
 */
function applyReadNotes(ctx, book, payload) {
    const notes = [];

    if (isBookScanned(ctx, book) === false) {
        notes.push('这本书当前没有激活，写进去的条目生成时不会触发。');
    }

    const state = getState(ctx);
    if (state.lastBook !== null && state.lastBook !== book) {
        notes.push('可写书已切换，这里没有之前那本书的内容，不要重复记录。');
        payload.switched = true;
    }
    state.lastBook = book;

    if (notes.length > 0) {
        payload.note = [payload.note, ...notes].filter(Boolean).join(' ');
    }
}

function applyBookNotes(ctx, book, payload) {
    if (isBookScanned(ctx, book) === false) {
        payload.note = ['这本书当前没有激活，写进去的条目生成时不会触发。', payload.note]
            .filter(Boolean)
            .join(' ');
    }
}

/** 写入后的那条附注：只说事实，不给模型组织台词 */
function bookNote(ctx, book) {
    return isBookScanned(ctx, book) === false
        ? `已写入「${book}」，但这本书当前没有激活。`
        : '已写入。同一次回复的续写可能已经读到它；最迟下一轮生效。';
}

/**
 * 关键词归一：去空白、去空串、去重，保持原顺序。
 * @param {unknown} raw
 */
function normalizeKeys(raw) {
    if (!Array.isArray(raw)) {
        return { keys: [] };
    }

    const keys = [];
    for (const item of raw) {
        const key = String(item ?? '').trim();
        if (!key || keys.includes(key)) {
            continue;
        }
        keys.push(key);
    }

    return { keys };
}

function normalizeLogic(raw) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return ['any', 'all', 'not_all', 'not_any'].includes(value) ? value : '';
}

/*
 * 各处理函数开头那句 isLearningActive 是"工具已经在跑"时的二次校验：
 * 学习模式可能在生成途中被关掉，而 guardAction 是在调用前判的。
 */

function errorResult(error, hint) {
    // 兜底用统一目录：任何一条错误回到模型面前时都得有下一步动作，
    // 不能因为某个分支漏写 hint 就丢出一个裸的 { ok: false, error }
    const text = hint || hintFor(error);
    return text ? { ok: false, error, hint: text } : { ok: false, error };
}
