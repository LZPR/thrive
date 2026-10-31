/**
 * passive.js · 被动学习
 *
 * 主动学习靠用户点徽章；被动学习靠两条自动判据，任一命中就"挂一次学习"，
 * 下一轮对话临时打开学习模式，那一轮回复完立刻关掉（两条是 or 关系，可以都配）：
 *
 *   1. 条数：距离上次学习已经过了 N 条可见消息（0 = 不用这条判据）
 *   2. 关键词：最近一轮的 User / Assistant 消息命中关键词
 *      （只看聊天消息本身，世界书 / 作者注释 / 预设里的字不算）
 *
 * 几条刻意的取舍：
 *   - **只扫聊天消息**。世界书条目、作者注释、预设都在提示词里，但它们不是"这一轮
 *     用户或角色说了什么"，拿它们当触发源会让学习在完全无关的时候被拽起来。
 *   - **主动开着就不触发**，并且把进度归零。否则关掉主动的瞬间会立刻炸一次，
 *     看起来像开关自己亮了。
 *   - **同一轮不重复触发**。结算时记下这一轮用户消息的哈希，关键词在 AI 的复述里
 *     再出现一次也不会连着开两轮。
 *   - 触发只改内存状态，落盘交给调用方（和 store.js 的其余部分一致）。
 */

import { fnv1a } from './util.js';
import { notifyPassive } from './events.js';
import {
    clearPending,
    ensureSettings,
    getPassive,
    getPending,
    isChatAvailable,
    isEnabled,
    PASSIVE_BASELINE_NONE,
    setPending,
} from './store.js';

/** 判据：条数 / 关键词 / 用户手动点「现在触发一次」 */
export const TRIGGER = Object.freeze({
    INTERVAL: 'interval',
    KEYWORD: 'keyword',
    MANUAL: 'manual',
});

/** 关键词分隔符：中英文逗号、分号、换行、竖线都当分隔符 */
const KEYWORD_SEPARATORS = /[,，;；\n\r|]+/;

/** 单个关键词的长度上限，防止整段贴进来变成一个巨大的 includes */
const KEYWORD_MAX_CHARS = 40;

/**
 * 解析关键词设置。
 * 去空白、去重、按长度截断；空串直接返回空数组（= 不启用关键词判据）。
 * @param {string} text
 * @returns {string[]}
 */
export function parseKeywords(text) {
    const seen = new Set();
    const list = [];

    for (const raw of String(text ?? '').split(KEYWORD_SEPARATORS)) {
        const key = raw.trim().slice(0, KEYWORD_MAX_CHARS);
        if (!key) {
            continue;
        }
        // 大小写不敏感，所以去重也按小写算
        const lower = key.toLowerCase();
        if (seen.has(lower)) {
            continue;
        }
        seen.add(lower);
        list.push(key);
    }

    return list;
}

/**
 * 可见消息（排除工具日志这类 is_system 的系统消息）。
 * 被动学习的"条数"和"最近一轮"都只在这个集合里算。
 * @param {object} ctx
 * @returns {object[]}
 */
function visibleMessages(ctx) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    return chat.filter(mes => mes && !mes.is_system && typeof mes.mes === 'string');
}

/** 可见消息条数。条数判据的进度就用它和 baseline 的差值算 */
export function countMessages(ctx) {
    return visibleMessages(ctx).length;
}

/**
 * 最近一轮的 User 与 Assistant 文本。
 *
 * 两个槽位各自取"最后一条"：用户刚发完一条时最后一条是 User，AI 刚回复完时
 * 最后一条是 Assistant，两种时机都能同时拿到这一轮的两边。
 *
 * @param {object} ctx
 * @returns {{ user: string, assistant: string }}
 */
export function lastRound(ctx) {
    const messages = visibleMessages(ctx);

    let user = '';
    let assistant = '';
    let hasUser = false;
    let hasAssistant = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const mes = messages[i];
        if (mes.is_user) {
            if (!hasUser) {
                user = mes.mes;
                hasUser = true;
            }
        } else if (!hasAssistant) {
            assistant = mes.mes;
            hasAssistant = true;
        }

        if (hasUser && hasAssistant) {
            break;
        }
    }

    return { user, assistant };
}

/**
 * 在若干段文本里找命中的关键词。
 * 大小写不敏感的子串匹配：中文用不上正则，英文也不该因为大小写漏掉。
 *
 * @param {Array<string|undefined>} texts
 * @param {string[]} keywords
 * @returns {string} 命中的关键词（原样），没命中返回空串
 */
export function findKeywordHit(texts, keywords) {
    if (!keywords.length) {
        return '';
    }

    const haystack = texts
        .filter(text => typeof text === 'string' && text)
        .join('\n')
        .toLowerCase();

    if (!haystack) {
        return '';
    }

    for (const keyword of keywords) {
        if (haystack.includes(keyword.toLowerCase())) {
            return keyword;
        }
    }

    return '';
}

/** 空的评估结果，字段固定，省得调用方到处判 undefined */
function emptyResult() {
    return { fired: false, reason: '', keyword: '', total: 0, since: 0, interval: 0, remaining: 0 };
}

/**
 * 评估一次是否该触发，该触发就挂上（不落盘）。
 *
 * @param {object} ctx 现取的 context
 * @param {'user'|'assistant'} stage 当前处在哪一侧：
 *        user      —— 用户刚发出一条消息（关键词可命中，条数不结算）
 *        assistant —— 角色刚回复完（两条判据都结算）
 * @returns {{ fired: boolean, reason: string, keyword: string, total: number,
 *             since: number, interval: number, remaining: number }}
 */
export function evaluatePassive(ctx, stage = 'assistant') {
    const result = emptyResult();
    const settings = ensureSettings(ctx);
    const passive = getPassive(ctx);

    if (!isChatAvailable(ctx)) {
        result.reason = 'NO_CHAT';
        return result;
    }

    const total = countMessages(ctx);
    result.total = total;

    // 基线：第一次评估、或用户删掉了一批消息（baseline 跑到总数前面）时重新对齐
    if (passive.baseline === PASSIVE_BASELINE_NONE || passive.baseline > total) {
        passive.baseline = total;
    }

    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    result.interval = interval;
    result.since = Math.max(0, total - passive.baseline);
    result.remaining = interval > 0 ? Math.max(0, interval - result.since) : 0;

    if (settings.passiveEnabled !== true) {
        result.reason = 'DISABLED';
        return result;
    }

    // 两个模块都关着时没有可写的地方：注入了学习块也没有工具可用，
    // 只会让模型干说一句"我记住了"。和主动开关的兜底保持同一个判断。
    if (settings.moduleWorldbook === false && settings.moduleDescription === false) {
        result.reason = 'NO_MODULE';
        return result;
    }

    if (isEnabled(ctx)) {
        // 主动已经开着：不重复触发，进度归零，免得关掉主动后立刻补一次
        passive.baseline = total;
        result.reason = 'ACTIVE';
        return result;
    }

    if (passive.pending) {
        result.reason = 'PENDING';
        return result;
    }

    const round = lastRound(ctx);
    const userHash = round.user ? fnv1a(round.user) : '';

    // 这一轮刚学完。AI 把关键词复述一遍不该再开一轮
    if (userHash && userHash === passive.lastLearnedUserHash) {
        result.reason = 'JUST_LEARNED';
        return result;
    }

    const keywords = parseKeywords(settings.passiveKeywords);
    if (keywords.length > 0) {
        const hit = findKeywordHit([round.user, round.assistant], keywords);
        if (hit) {
            return arm(ctx, { reason: TRIGGER.KEYWORD, keyword: hit, total, interval, since: result.since });
        }
    }

    if (stage === 'assistant' && interval > 0 && result.since >= interval) {
        return arm(ctx, { reason: TRIGGER.INTERVAL, total, interval, since: result.since });
    }

    result.reason = 'IDLE';
    return result;
}

/**
 * 挂上一次待学习。
 *
 * 挂上时把 baseline 推到当前条数：下一次条数判据从这一刻重新数起，
 * 否则"关键词触发"和"条数触发"会互相把对方的进度推得更早。
 */
function arm(ctx, { reason, keyword = '', total, interval = 0, since = 0 }) {
    const result = emptyResult();
    result.total = total;
    result.interval = interval;
    result.since = since;

    if (!setPending(ctx, { reason, keyword })) {
        result.reason = 'PENDING';
        return result;
    }

    getPassive(ctx).baseline = total;
    result.fired = true;
    result.reason = reason;
    result.keyword = keyword;
    result.remaining = interval;

    // 只广播，不改界面：界面在 ui.js 里订阅，避免 passive ↔ ui 互相 import
    notifyPassive({ ...result });

    return result;
}

/**
 * 手动挂一次（设置页的「现在触发一次」、`/thrive once`）。
 * 不受被动开关限制——用户明确要求了，就给他一轮。
 *
 * @param {object} ctx
 * @returns {object|null} 挂上返回 pending 详情，已经挂着返回 null
 */
export function armManual(ctx) {
    if (!isChatAvailable(ctx)) {
        return null;
    }

    const total = countMessages(ctx);
    const passive = getPassive(ctx);
    if (passive.baseline === PASSIVE_BASELINE_NONE || passive.baseline > total) {
        passive.baseline = total;
    }

    if (!setPending(ctx, { reason: TRIGGER.MANUAL })) {
        return null;
    }

    passive.baseline = total;
    const pending = getPending(ctx);
    notifyPassive({ fired: true, reason: TRIGGER.MANUAL, keyword: '', total, interval: 0, since: 0, remaining: 0 });
    return pending;
}

/**
 * 结算：这一轮学完了，立刻关掉临时学习。
 *
 * 只有 `pending.used` 为真才结算——也就是这一次待学习真的进入过一次非 dryRun 生成。
 * 这样摘要、翻译、重新渲染这类静默生成不会把用户等的那一轮学习吃掉。
 *
 * @param {object} ctx
 * @returns {boolean} 是否真的结算了（调用方据此决定要不要落盘）
 */
export function consumePending(ctx) {
    const passive = getPassive(ctx);
    const pending = passive.pending;
    if (!pending || !pending.used) {
        return false;
    }

    const round = lastRound(ctx);
    passive.lastLearnedUserHash = round.user ? fnv1a(round.user) : '';
    passive.baseline = countMessages(ctx);
    passive.pending = null;

    notifyPassive({ fired: false, reason: 'consumed' });
    return true;
}

/** 用户主动取消待学习（徽章上再点一下被动、或切到主动模式时） */
export function disarm(ctx) {
    return clearPending(ctx);
}

/** 待学习的原因，一句话：给徽章 title / 设置页提示用 */
export function describePending(pending) {
    if (!pending) {
        return '';
    }

    switch (pending.reason) {
        case TRIGGER.INTERVAL:
            return '按消息条数触发';
        case TRIGGER.KEYWORD:
            return pending.keyword ? `关键词「${pending.keyword}」` : '关键词触发';
        case TRIGGER.MANUAL:
            return '手动触发';
        default:
            return '自动触发';
    }
}

/** 条数进度：给设置页那句"已累计 x / N 条"用；总开关关着也算，用户可以先看进度再决定 */
export function intervalProgress(ctx, settings) {
    const interval = Math.max(0, Math.floor(Number(settings?.passiveInterval) || 0));
    const passive = getPassive(ctx);
    const total = countMessages(ctx);
    const since = passive.baseline === PASSIVE_BASELINE_NONE || passive.baseline > total
        ? 0
        : total - passive.baseline;

    return { interval, since, remaining: interval > 0 ? Math.max(0, interval - since) : 0 };
}
