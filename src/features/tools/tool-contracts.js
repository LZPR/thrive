/** tool-contracts.js · Internal tools module; public entry: index.js. */

import { BOOK_SEEN, bookReadKey, clearReadHash, clearReadKeysByPrefix, getReadHash, getState, lorePatternPrefix, loreReadKey, loreSeenKey, setReadHash } from '../../store.js';

import { isBookScanned } from '../../targets.js';

import { hintFor } from '../../diagnostics.js';

import { fnv1a } from '../../util.js';

const LOG = '[Thrive]';

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

export { LOG, registerLoreWrite, canReplace, applyReadNotes, applyBookNotes, bookNote, normalizeKeys, normalizeLogic, errorResult };
