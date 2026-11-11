/**
 * auto-learn.js · 什么时候该学一次
 *
 * 只回答"现在要不要触发"，不负责发起会话（那是 learning.js 的事）：
 * 判据是纯函数，能单独验，也不会把 store 和网络层缠在一起。
 *
 * 两条判据，任一命中就触发一次（or 关系，可以只配一条）：
 *
 *   1. 条数：距离上次学习已经过了 N 条可见消息（0 = 不用这条判据）
 *   2. 关键词：最近一轮的 User / Assistant 消息命中关键词
 *
 * 几条刻意的取舍：
 *   - **只在角色回复完之后判**。学习是独立会话，不必抢在生成之前；放在回复之后
 *     既不会和正在生成的聊天抢同一个后端，也保证这一轮的两边都已经落进记录。
 *   - **只扫聊天消息**。世界书条目、作者注释、预设都在提示词里，但它们不是"这一轮
 *     用户或角色说了什么"，拿它们当触发源会让学习在完全无关的时候被拽起来。
 *   - **同一轮不重复触发**。记下这一轮用户消息的哈希，关键词在 AI 的复述里
 *     再出现一次也不会连着学两遍。
 *   - 触发只改内存状态，落盘交给调用方（和 store.js 的其余部分一致）。
 */

import {
    ensureSettings,
    getLearn,
    isChatAvailable,
    isEnabled,
    LEARN_BASELINE_NONE,
} from '../settings/index.js';
import { fnv1a } from '../../shared/util.js';

/** 触发原因：条数 / 关键词 / 手动「立刻学一次」/ 手动「教授」 */
export const TRIGGER = Object.freeze({
    INTERVAL: 'interval',
    KEYWORD: 'keyword',
    MANUAL: 'manual',
    TEACH: 'teach',
});

/** 关键词分隔符：中英文逗号、分号、换行、竖线都当分隔符 */
const KEYWORD_SEPARATORS = /[,，;；\n\r|]+/;

/** 条数判据的上限。再大就不是"定期抽查"，是"永远不会触发" */
export const LEARN_INTERVAL_MAX = 500;

/** 单个关键词的长度上限，防止整段贴进来变成一个巨大的 includes */
const KEYWORD_MAX_CHARS = 40;

/**
 * 条数判据的夹取：空 / 非数字 / 负数都当 0（= 不用这条判据），超过上限收到上限。
 * @param {unknown} value
 * @returns {number}
 */
export function clampInterval(value) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num <= 0) {
        return 0;
    }
    return Math.min(num, LEARN_INTERVAL_MAX);
}

/**
 * 解析关键词设置。去空白、去重、按长度截断；空串直接返回空数组。
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
 * 条数与"最近一轮"都只在这个集合里算。
 * @param {object} ctx
 * @returns {object[]}
 */
export function visibleMessages(ctx) {
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
 * 两个槽位各自取"最后一条"：角色刚回复完时最后一条是 Assistant，它上面那条
 * 通常就是这一轮的 User，两个槽位因此能同时拿到这一轮的两边。
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
 * 在若干段文本里找命中的关键词。大小写不敏感的子串匹配。
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
    return { fire: false, reason: '', keyword: '', total: 0, since: 0, interval: 0, remaining: 0 };
}

/**
 * 评估一次该不该学。
 *
 * @param {object} ctx 现取的 context
 * @param {'user'|'assistant'} [stage] 当前处在哪一侧。条数判据只在一轮结束时结算，
 *        所以调用方应当只在角色回复完之后问。
 * @returns {{ fire: boolean, reason: string, keyword: string, total: number,
 *             since: number, interval: number, remaining: number }}
 */
export function evaluateAuto(ctx, stage = 'assistant') {
    const result = emptyResult();
    const settings = ensureSettings(ctx);
    const learn = getLearn(ctx);

    if (!isChatAvailable(ctx)) {
        result.reason = 'NO_CHAT';
        return result;
    }

    const total = countMessages(ctx);
    result.total = total;

    // 基线：第一次评估、或用户删掉了一批消息（baseline 跑到总数前面）时重新对齐
    if (learn.baseline === LEARN_BASELINE_NONE || learn.baseline > total) {
        learn.baseline = total;
    }

    const interval = clampInterval(settings.learnInterval);
    result.interval = interval;
    result.since = Math.max(0, total - learn.baseline);
    result.remaining = interval > 0 ? Math.max(0, interval - result.since) : 0;

    if (!isEnabled(ctx)) {
        result.reason = 'OFF';
        return result;
    }

    const round = lastRound(ctx);
    const userHash = round.user ? fnv1a(round.user) : '';

    // 这一轮刚学完。AI 把关键词复述一遍不该再学一遍
    if (userHash && userHash === learn.lastHash) {
        result.reason = 'JUST_LEARNED';
        return result;
    }

    const keywords = parseKeywords(settings.learnKeywords);
    if (keywords.length > 0) {
        const hit = findKeywordHit([round.user, round.assistant], keywords);
        if (hit) {
            result.fire = true;
            result.reason = TRIGGER.KEYWORD;
            result.keyword = hit;
            return result;
        }
    }

    if (stage === 'assistant' && interval > 0 && result.since >= interval) {
        result.fire = true;
        result.reason = TRIGGER.INTERVAL;
        return result;
    }

    result.reason = 'IDLE';
    return result;
}

/**
 * 条数进度：给面板与徽章的"还差 N 条"用；学习模式关着也算，
 * 用户可以先看进度再决定开不开。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function intervalProgress(ctx, settings) {
    const interval = clampInterval(settings?.learnInterval);
    const learn = getLearn(ctx);
    const total = countMessages(ctx);
    const since = learn.baseline === LEARN_BASELINE_NONE || learn.baseline > total
        ? 0
        : total - learn.baseline;

    return { interval, since, remaining: interval > 0 ? Math.max(0, interval - since) : 0 };
}

/**
 * 触发原因，一句话：给徽章 tooltip、面板提示、toast 用。
 * @param {{ reason?: string, keyword?: string }} trigger
 */
export function describeTrigger(trigger) {
    if (!trigger) {
        return '';
    }

    switch (trigger.reason) {
        case TRIGGER.INTERVAL:
            return '按消息条数触发';
        case TRIGGER.KEYWORD:
            return trigger.keyword ? `关键词「${trigger.keyword}」` : '关键词触发';
        case TRIGGER.MANUAL:
            return '手动触发';
        case TRIGGER.TEACH:
            return '手动教授';
        default:
            return '自动触发';
    }
}
