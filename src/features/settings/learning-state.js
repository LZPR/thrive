/** learning-state.js · Internal settings module; public entry: index.js. */

import { normalizeLastRun } from './normalization.js';

import { getState, saveChat } from './chat-store.js';

/* ------------------------------------------------------------------ 学习 */
/*
 * 学习的"状态"放在这里，"什么时候该触发一次"放在 auto-learn.js：
 * store 只管读写，不引入消息扫描，避免 store ↔ auto-learn 互相 import。
 */

/** 学习的对话状态（可直接改，改完记得 saveChat） */
function getLearn(ctx) {
    return getState(ctx).learn;
}

/**
 * 更换学习模式总开关并落盘。
 *
 * 这就是唯一的开关：开着时按判据自动触发，或者手动触发；关着时一次都不会自己学。
 * 没有"主动 / 被动"之分，也没有"只借这一轮"的临时记号——学习本来就在另一场
 * 会话里跑，不存在"借聊天的一轮"这回事（ADR-050）。
 *
 * @param {object} ctx
 * @param {boolean} enabled
 */
function setEnabled(ctx, enabled) {
    const state = getState(ctx);
    state.enabled = Boolean(enabled);
    saveChat(ctx);
    return state;
}

/**
 * 记下"这一次学的是哪一段"：基线推到当前条数、记下所依据的那条用户消息。
 *
 * 在**触发时**就写，不等会话跑完：跑到一半又来了新消息时，基线不该把它算进
 * 下一次的进度里（那几条会在下一轮重新被看到）。
 *
 * @param {object} ctx
 * @param {{ total?: number, hash?: string }} info
 * @returns {object} learn 状态
 */
function beginLearn(ctx, { total = null, hash = '' } = {}) {
    const state = getState(ctx);
    const count = Number(total);

    if (Number.isFinite(count) && count >= 0) {
        state.learn.baseline = Math.floor(count);
    }
    state.learn.lastHash = String(hash ?? '');

    return state.learn;
}

/**
 * 记下一次学习的结果。只写内存，落盘交给调用方。
 * @param {object} ctx
 * @param {object} result `{ ok, stopped, rounds, toolCalls, chars, ms, error, hint }`
 * @returns {object} learn 状态
 */
function finishLearn(ctx, result = null) {
    const state = getState(ctx);
    state.learn.lastRun = normalizeLastRun({ at: Date.now(), ...(result ?? {}) });
    return state.learn;
}

/** 最近一次学习的结果；没学过时返回 null */
function getLastLearnRun(ctx) {
    const run = getState(ctx).learn.lastRun;
    return run ? { ...run } : null;
}

/**
 * 运行时标记：此刻有没有一场学习会话在跑。
 *
 * 它是**进程级**的，不随对话切换重置：会话只活在一次异步调用里，不落在任何
 * 对话上。工具层靠它判断"现在是不是学习时间"——聊天请求里已经没有任何插件
 * 工具，会话工具是唯一的入口。
 */
let runningLearn = null;

/**
 * 标记学习会话开始 / 结束。传 null 表示结束。
 * @param {{ reason?: string, startedAt?: number }|null} info
 */
function markLearningRunning(info = null) {
    runningLearn = info
        ? { reason: String(info.reason ?? ''), startedAt: Number(info.startedAt) || Date.now() }
        : null;
    return runningLearn;
}

/** 正在跑的那一场的简述；空闲时 null */
function getLearningRunning() {
    return runningLearn ? { ...runningLearn } : null;
}

/**
 * 工具层问的"现在能不能写"。
 *
 * 以前它表示"学习模式开着"，现在表示"有一场学习会话正在跑"：聊天里既没有
 * 提示词也没有工具，模型只有在这个窗口里才可能调用它们。
 */
function isLearningActive() {
    return Boolean(runningLearn);
}

export { getLearn, setEnabled, beginLearn, finishLearn, getLastLearnRun, markLearningRunning, getLearningRunning, isLearningActive };
