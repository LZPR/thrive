/** read-tracker.js · Internal settings module; public entry: index.js. */

import { fnv1a } from '../../shared/util.js';

import { getState } from './chat-store.js';

/* ------------------------------------------------------------------ 读取登记 */

/**
 * reads 的键，四类：
 *
 *   desc                                  角色描述全文的哈希（整段重写的前置）
 *   seen:desc                             看过描述这件事本身（任意视图；追加的前置）
 *   pat:desc:<flags>:<h>                  某个正则预读命中过（替换的前置）
 *   book:<name>                           看过这本书（新建条目的前置）
 *   lore:<book>|<title>                   条目全文的哈希（整段重写的前置）
 *   seen:lore:<book>|<title>              目录里见过这条标题（追加的前置）
 *   pat:lore:<book>|<title>:<flags>:<h>   某条目的某个正则预读命中过
 *
 * 分四级的理由：读得越少，能做的写入必须越少。只看过标题就允许整段覆盖，
 * "先读后写"就只是一句口号。写在 tools.js 里的守卫顺序与本表一一对应。
 */
const READ_KEY_DESC = 'desc';

/** 看过角色描述（任意视图，含正则命中） */
const DESC_SEEN = 'seen:desc';

/** 用户每发一条消息就清空：工具调用（含 ST 的递归续生成）都算同一轮 */
function resetReads(ctx) {
    getState(ctx).reads = {};
}

/** 本轮有没有读过该目标；返回读取时记录的内容哈希 */
function getReadHash(ctx, key) {
    const reads = getState(ctx).reads;
    const hash = reads?.[key];
    return typeof hash === 'string' && hash ? hash : null;
}

/** 登记"本轮读过，内容是这个哈希" */
function setReadHash(ctx, key, hash) {
    getState(ctx).reads[key] = String(hash);
}

/**
 * 作废一条读取登记。
 *
 * 用于"插件替用户改了内容"之后（比如从快照恢复）：装作读过等于骗过版本校验，
 * 下一次写入就会基于模型没见过的文本覆盖磁盘。作废之后模型必须重新读一次。
 */
function clearReadHash(ctx, key) {
    const reads = getState(ctx).reads;
    if (reads && Object.hasOwn(reads, key)) {
        delete reads[key];
        return true;
    }
    return false;
}

/**
 * 世界书读取登记的键：`lore:<book>|<title>`。
 * 书名与标题都可能含 `|`，所以只用第一个 `|` 分隔，解析时按后者处理。
 */
function loreReadKey(book, title) {
    return `lore:${String(book ?? '')}|${String(title ?? '')}`;
}

/**
 * 书级标记：`book:<name>`。
 *
 * 条目级的键回答"这条正文我读过没有"；新建条目时那条记录压根不存在，
 * 条目级无从校验，所以再加一个书级标记回答"这本书本轮看过没有"。
 * 少了它，场景 1（书里还没有这条 → 读完发现没有 → 新建）会永远卡在
 * READ_REQUIRED：读完一本书但一无所获，在 reads 里留不下任何痕迹。
 */
function bookReadKey(book) {
    return `book:${String(book ?? '')}`;
}

/** 书级标记的值：只需存在，不参与比对 */
const BOOK_SEEN = 'seen';

/**
 * 某个条目的"标题见过"标记：`seen:lore:<book>|<title>`。
 *
 * 与 `loreReadKey` 分开是因为授权的动作不同：见过标题只允许**追加**，
 * 整段改写还得读过全文。两者共用一个键就会出现"看了一眼目录就能覆盖全文"。
 */
function loreSeenKey(book, title) {
    return `seen:lore:${String(book ?? '')}|${String(title ?? '')}`;
}

/**
 * 正则预读标记：`pat:desc:<flags>:<hash>` / `pat:lore:<book>|<title>:<flags>:<hash>`。
 *
 * 存 pattern 的哈希而不是 pattern 本身：reads 会随聊天记录落盘，没必要把
 * 用户/模型写的正则原文也存一份。
 */
function descPatternKey(flags, pattern) {
    return `pat:desc:${normalizeFlags(flags)}:${fnv1a(pattern)}`;
}

function lorePatternKey(book, title, flags, pattern) {
    return `pat:lore:${String(book ?? '')}|${String(title ?? '')}:${normalizeFlags(flags)}:${fnv1a(pattern)}`;
}

/** 前缀要按同一套规则生成，否则清不掉 */
function descPatternPrefix() {
    return 'pat:desc:';
}

function lorePatternPrefix(book, title) {
    return `pat:lore:${String(book ?? '')}|${String(title ?? '')}:`;
}

/**
 * flags 规范化：只留顺序稳定的 i/m/s/u。
 *
 * 与 regex.js 的 normalizeFlags 同义，但 store 不能反过来依赖 regex（正则模块是
 * 纯函数，不该知道读取登记的存在）。两边都做一次，是为了让"读"和"写"用同一个键。
 */
function normalizeFlags(raw) {
    const allowed = 'imsug'.split('');
    const chars = String(raw ?? '').toLowerCase().split('');
    return Array.from(new Set(chars.filter(char => allowed.includes(char)))).sort().join('');
}

/**
 * 删掉某一类读取登记（按前缀）。
 *
 * 用在"插件替模型改了内容"之后：正文变了，之前预读过的正则命中位置和数量
 * 都可能不再成立，继续留着等于默许它按旧的认知去替换。
 */
function clearReadKeysByPrefix(ctx, prefix) {
    const reads = getState(ctx).reads;
    if (!reads) {
        return 0;
    }

    const wanted = String(prefix ?? '');
    if (!wanted) {
        return 0;
    }

    let removed = 0;
    for (const key of Object.keys(reads)) {
        if (key.startsWith(wanted)) {
            delete reads[key];
            removed++;
        }
    }
    return removed;
}

export { READ_KEY_DESC, DESC_SEEN, resetReads, getReadHash, setReadHash, clearReadHash, loreReadKey, bookReadKey, BOOK_SEEN, loreSeenKey, descPatternKey, lorePatternKey, descPatternPrefix, lorePatternPrefix, clearReadKeysByPrefix };
