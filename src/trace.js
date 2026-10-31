/**
 * trace.js · 工具日志的压缩与清理
 *
 * ST 每完成一轮工具调用会往 chat 里塞一条 `is_system` 消息：
 *   mes  = 一整块 <details><pre><code>{JSON}</code></pre></details>
 *   extra.tool_invocations = 结构化数组（同一批调用）
 *
 * 这两样都会进上下文——`script.js` 的 `coreChat` 过滤条件是
 * `!x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations))`，
 * 所以日志会随对话线性膨胀（ADR-013）。
 *
 * 分两步治，且都只做最小改动：
 *   1. 压缩：TOOL_CALLS_PERFORMED 时把 mes 换成几行纯文本。看得懂、去掉 HTML 与完整 JSON，
 *      不动 extra.tool_invocations —— 第 2 步要靠它认出这些消息。
 *   2. 清理：MESSAGE_SENT 时删掉"上一条用户消息之前"的 extra.tool_invocations。
 *      字段没了，ST 自己的过滤条件就会把这些消息排除在上下文外，而消息与 mes 仍在，
 *      界面上照常显示。
 *
 * 只处理"全部由 Thrive 工具构成"的日志消息。混着别的插件的调用时不碰：
 * 替别人决定日志长什么样（甚至把它们的调用记录一起删掉）不是本插件该做的事。
 */

import { readLimit } from './limits.js';
import { isThriveTool } from './tool-names.js';

/** 结果里的短字符串原样保留；超过这个长度只留长度，别把一整段描述塞进日志 */
const SHORT_STRING_MAX = 40;

const PREFIX = '[thrive]';

/**
 * 压缩一条刚产出的工具日志消息。
 *
 * @param {object} ctx getContext() 的返回值（只用 ctx.chat）
 * @param {Array<object>} invocations ST 传进来的调用列表
 * @param {object} [settings] extension_settings.thrive（取日志截断字数）
 * @returns {boolean} 是否真的改写了
 */
export function compressToolTrace(ctx, invocations, settings) {
    if (!Array.isArray(invocations) || invocations.length === 0) {
        return false;
    }

    if (!invocations.every(isThriveCall)) {
        return false;
    }

    const target = findTraceMessage(ctx?.chat, invocations);
    if (!target) {
        return false;
    }

    target.mes = buildTraceText(invocations, settings);
    return true;
}

/**
 * 把上一轮及更早的工具日志移出上下文。
 *
 * "上一条用户消息之前"= 刚发出的这条用户消息之前的全部消息。
 * 当轮的日志在这条消息之后，因此不受影响。
 *
 * @param {object} ctx
 * @returns {number} 处理掉的消息条数
 */
export function pruneToolTraces(ctx) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) {
        return 0;
    }

    const boundary = lastUserIndex(chat);
    if (boundary <= 0) {
        return 0;
    }

    let pruned = 0;
    for (let index = 0; index < boundary; index++) {
        const message = chat[index];
        const list = message?.extra?.tool_invocations;

        if (!message?.is_system || !Array.isArray(list)) {
            continue;
        }
        if (!list.every(isThriveCall)) {
            continue;
        }

        // 只删这一个字段：mes 留着，界面照常显示
        delete message.extra.tool_invocations;
        pruned++;
    }

    return pruned;
}

/**
 * 一行一条调用：`[thrive] lore_write → {"ok":true,...}`。
 * 失败用 ✗ 而不是 →，扫一眼就能看出哪次没成。
 *
 * @param {Array<object>} invocations
 * @param {object} [settings]
 * @returns {string}
 */
export function buildTraceText(invocations, settings) {
    return invocations.map(invocation => formatLine(invocation, settings)).join('\n');
}

/**
 * 单条调用 → 一行文本（不含换行）。
 * @param {object} invocation
 * @param {object} [settings]
 * @returns {string}
 */
export function formatLine(invocation, settings) {
    const name = String(invocation?.name ?? 'tool');
    const mark = invocation?.error === true ? '✗' : '→';
    const body = summarize(rawResult(invocation));

    return clip(`${PREFIX} ${name} ${mark} ${body}`, readLimit(settings, 'traceMaxChars'));
}

/* ------------------------------------------------------------------ 内部 */

function isThriveCall(invocation) {
    return isThriveTool(invocation?.name);
}

function lastUserIndex(chat) {
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index]?.is_user) {
            return index;
        }
    }
    return -1;
}

/**
 * 找到刚 push 进去的那条工具消息。
 *
 * 正常情况是数组引用相等（`extra.tool_invocations` 就是 ST 传进来的那个数组）；
 * 万一被别的插件先 clone 过，退回"最后一条工具消息 + 名字序列一致"。
 */
function findTraceMessage(chat, invocations) {
    if (!Array.isArray(chat)) {
        return null;
    }

    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message?.is_system && message.extra?.tool_invocations === invocations) {
            return message;
        }
    }

    const wanted = names(invocations);
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        const list = message?.extra?.tool_invocations;
        if (!message?.is_system || !Array.isArray(list)) {
            continue;
        }
        if (names(list) === wanted) {
            return message;
        }
    }

    return null;
}

function names(list) {
    return list.map(item => String(item?.name ?? '')).join('|');
}

function rawResult(invocation) {
    const value = invocation?.result;
    if (typeof value === 'string') {
        return value;
    }
    if (value === null || value === undefined) {
        return '';
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * 把工具返回压成一句摘要。
 *
 * 我们的工具都返回 JSON 对象，但字段差别很大：`desc_read` 带整篇描述，
 * `lore_read` 带条目正文数组。这里不按工具写死字段，而是按"值的形状"处理：
 * 短标量原样留，短字符串原样留，长字符串只留长度，数组只留条数，对象只留占位。
 * 于是 `{"ok":true,"chars":1234,"text":"…"}` 变成
 * `{"ok":true,"chars":1234,"text":"…(1234 字)"}`，一眼能看出发生了什么，
 * 又不至于把两千字带进上下文。
 */
function summarize(text) {
    const raw = String(text ?? '');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return raw;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return raw;
    }

    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (value === null || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
        } else if (typeof value === 'string') {
            out[key] = value.length > SHORT_STRING_MAX ? `…(${value.length} 字)` : value;
        } else if (Array.isArray(value)) {
            // 只留条数：条目正文可能上千字，进日志没有意义
            out[key] = `${value.length} 项`;
        } else if (typeof value === 'object') {
            out[key] = '{…}';
        }
    }

    try {
        return JSON.stringify(out);
    } catch {
        return raw;
    }
}

/**
 * 截断到一行。
 *
 * 上限来自设置项 `traceMaxChars`（默认 200）：日志留在上下文里的目的只是
 * "看得出这轮调了什么"，不是复述工具返回值，所以超长只留开头加省略号。
 */
function clip(text, max) {
    const value = String(text ?? '');
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
