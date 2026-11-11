/** normalization.js · Internal settings module; public entry: index.js. */

import { DESC_STORAGE } from '../../desc-entry.js';

import { readLimit } from '../../limits.js';

import { CARD_ID, isPinnedCard } from '../../prompt-order.js';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * patch 的最小形状校验。
 *
 * `status` 只判"是不是字符串"而不校验枚举值：新版本加了状态之后，
 * 老聊天文件里的 patch 至少还能被丢弃，不会因为不认识就被悄悄清掉。
 */
function isPatchState(patch) {
    return isPlainObject(patch)
        && typeof patch.before === 'string'
        && typeof patch.after === 'string'
        && typeof patch.status === 'string';
}

/**
 * 世界书快照 / 写入记录保留条数。
 * 一份快照同时充当"已写入"列表里的一行，所以这个数字既是备份槽位数，也是面板条数。
 *
 * 具体条数由设置项 `loreBackupLimit` 决定（limits.js 里默认 10）；
 * 这里只在读状态与写入时取一次，不缓存——用户改完设置下一笔写入就生效。
 */
function loreBackupLimit(settings) {
    return readLimit(settings, 'loreBackupLimit');
}

/**
 * 规范一条世界书快照。
 *
 * 记录与快照是同一份数据：`before` 是写入前的正文（新建时为空串），
 * 面板靠 `action` 决定按钮是"恢复写入前"还是"撤销新建"。
 * 老对话里的快照只有 `{ book, title, before, at }`，这里按 before 是否为空推断 action，
 * 并补一个稳定的 id（`restore` 用它定位，不用下标——下标会随新写入整体前移）。
 *
 * `layer` 说明这份快照记的是**哪一层**的写入：
 *   `disk`  写进了真实世界书（保存缓冲区之后、或缓冲区出现之前的那些旧记录）
 *   `draft` 只写进了虚拟世界书，真实世界书当时一个字都没动
 * 恢复要按层走：拿缓冲区里的 before 去覆盖磁盘，等于凭空造出一份用户没同意过的内容。
 * 老记录一律当 `disk`（那时候还没有缓冲区）。
 *
 * @returns {object|null} 形状完全不认识时返回 null，由调用方丢掉
 */
function normalizeLoreBackup(raw, index) {
    if (!isPlainObject(raw)) {
        return null;
    }

    const before = typeof raw.before === 'string' ? raw.before : '';
    const at = Number(raw.at) > 0 ? Number(raw.at) : 0;
    const action = raw.action === 'created' || raw.action === 'rewritten'
        ? raw.action
        : (before ? 'rewritten' : 'created');

    return {
        // 补出来的 id 必须可重复：每次 getState 都会跑一遍规范化，
        // 用随机数会让"刚点下恢复"和"重绘后面板拿到的 id"对不上
        id: typeof raw.id === 'string' && raw.id ? raw.id : `b${at}-${index}`,
        book: String(raw.book ?? ''),
        title: String(raw.title ?? ''),
        action,
        layer: raw.layer === 'draft' ? 'draft' : 'disk',
        before,
        beforeKeys: Array.isArray(raw.beforeKeys) ? raw.beforeKeys.map(String) : [],
        chars: Number(raw.chars) > 0 ? Number(raw.chars) : 0,
        at,
        restoredAt: Number(raw.restoredAt) > 0 ? Number(raw.restoredAt) : null,
    };
}

/**
 * 规范虚拟世界书。
 *
 * 就地改写并返回**同一个对象**（理由同 normalizePassive）：每次 getState 都会跑一遍，
 * 每次返回新对象的话，调用方手里那个引用会在下一次 getState 之后变成孤儿，
 * 刚写进去的条目就凭空消失了。
 *
 * `entries` 是整本书的副本，**不在这里深拷贝**——getState 每次工具调用都会走一遍，
 * 拷贝一本两百条的书不是"顺手"的成本。写入方自己保证传进来的是副本。
 *
 * @param {unknown} raw
 * @returns {object|null} 形状不认识（没有书名 / 没有条目表）就当没有缓冲区
 */
function normalizeDraft(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    raw.book = String(raw.book ?? '').trim();
    if (!raw.book) {
        return null;
    }

    if (!isPlainObject(raw.entries)) {
        raw.entries = {};
    }
    if (!isPlainObject(raw.touched)) {
        raw.touched = {};
    }
    if (typeof raw.baseHash !== 'string') {
        raw.baseHash = '';
    }

    const created = Number(raw.createdAt);
    raw.createdAt = Number.isFinite(created) && created > 0 ? created : Date.now();

    const updated = Number(raw.updatedAt);
    raw.updatedAt = Number.isFinite(updated) && updated > 0 ? updated : raw.createdAt;

    return raw;
}

/**
 * 规范自建提示词表。
 *
 * 老版本没有这些键，手改过 settings.json 的可能只有半个对象——一律补成
 * `{ id, name, content, role, enabled }`，认不出的条目直接丢。
 * 只返回内容真的变了才替换原数组，免得每次 ensureSettings 都换一个新引用，
 * 界面手里那个"正在编辑的这条"变成孤儿。
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeCustomPrompts(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const source = raw;
    const out = [];
    const seen = new Set();

    for (const item of source) {
        if (!isPlainObject(item)) {
            continue;
        }

        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);

        out.push({
            id,
            name: typeof item.name === 'string' && item.name.trim() ? item.name : '未命名提示词',
            content: typeof item.content === 'string' ? item.content : '',
            role: item.role === 1 || item.role === 2 ? item.role : 0,
            enabled: item.enabled !== false,
        });
    }

    const same = out.length === source.length && out.every((item, index) => {
        const before = source[index];
        return isPlainObject(before)
            && before.id === item.id
            && before.name === item.name
            && before.content === item.content
            && before.role === item.role
            && before.enabled === item.enabled;
    });

    return same ? raw : out;
}

/**
 * 停用的内置卡：只认认识的 id、去重，并且丢掉注入位。
 *
 * 注入位不能停用（`setPromptEnabled` 会拒），所以老设置里万一带了它，这里顺手
 * 清掉——留着一条永远不生效的停用记录，只会让人以为它真的被关了。
 */
function normalizeDisabledCards(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const known = new Set(Object.values(CARD_ID).filter(id => !isPinnedCard(id)));
    const source = raw;
    const out = [];

    for (const id of source) {
        if (typeof id === 'string' && known.has(id) && !out.includes(id)) {
            out.push(id);
        }
    }

    return out.length === source.length && out.every((id, index) => id === source[index]) ? raw : out;
}

/** 内置卡的角色覆盖：只留认识的、可改角色的卡，值只留 1/2（0 是默认，存不存一样） */
function normalizePromptRoles(raw) {
    if (!isPlainObject(raw)) {
        return {};
    }

    const known = new Set(Object.values(CARD_ID).filter(id => !isPinnedCard(id)));
    const out = {};
    for (const [id, role] of Object.entries(raw)) {
        if (known.has(id) && (role === 1 || role === 2)) {
            out[id] = role;
        }
    }

    const before = Object.keys(raw).filter(id => raw[id] === 1 || raw[id] === 2);
    const after = Object.keys(out);
    const same = before.length === after.length && after.every(id => raw[id] === out[id]);
    return same ? raw : out;
}

/**
 * 学习的对话状态。
 *
 *   baseline  上一次真正学过时的可见消息条数；-1 = 还没初始化
 *   lastHash  上一次学习所依据的那条用户消息的哈希，避免同一句话反复触发
 *   lastRun   最近一次学习会话的结果，面板靠它显示"上次学习"那一行
 *
 * baseline 存"条数快照"而不是"已累计几条"：用户删消息、编辑消息之后，
 * 用差值算出来的进度会自动跟上，不会因为我们自己记了个计数器而永远对不上。
 */
const LEARN_BASELINE_NONE = -1;

/** 最近一次学习结果：形状不认识或没有时间戳就当没有 */
function normalizeLastRun(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) {
        return null;
    }

    const count = value => (Number(value) >= 0 ? Math.floor(Number(value)) : 0);

    return {
        at,
        ok: raw.ok === true,
        stopped: typeof raw.stopped === 'string' ? raw.stopped : '',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        rounds: count(raw.rounds),
        toolCalls: count(raw.toolCalls),
        chars: count(raw.chars),
        ms: count(raw.ms),
        error: typeof raw.error === 'string' ? raw.error : '',
        hint: typeof raw.hint === 'string' ? raw.hint : '',
    };
}

function createLearnState() {
    return { baseline: LEARN_BASELINE_NONE, lastHash: '', lastRun: null };
}

/**
 * 规范 learn 状态。就地改写并返回同一个对象：getState 每次都会调它，
 * 每次换新对象的话，调用方手里那个引用会在下一次 getState 之后变成孤儿。
 */
function normalizeLearn(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const baseline = Number(source.baseline);

    source.baseline = Number.isFinite(baseline) && baseline >= 0
        ? Math.floor(baseline)
        : LEARN_BASELINE_NONE;
    source.lastHash = typeof source.lastHash === 'string' ? source.lastHash : '';
    source.lastRun = normalizeLastRun(source.lastRun);

    return source;
}

/** 存储模式归一：手改过的聊天文件写成 'worldBook' 也当 worldbook 认 */
function normalizeDescStorage(value) {
    return value === DESC_STORAGE.WORLDBOOK ? DESC_STORAGE.WORLDBOOK : DESC_STORAGE.CARD;
}

export { isPlainObject, isPatchState, loreBackupLimit, normalizeLoreBackup, normalizeDraft, normalizeCustomPrompts, normalizeDisabledCards, normalizePromptRoles, LEARN_BASELINE_NONE, normalizeLastRun, createLearnState, normalizeLearn, normalizeDescStorage };
