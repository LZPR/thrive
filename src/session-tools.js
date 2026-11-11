/**
 * session-tools.js · 会话私有的工具表
 *
 * 会话的 `tools` 从不进 `ToolManager`、不走 `ctx.registerFunctionTool`：它只出现在
 * 这一次会话的请求体里。这样聊天请求里一个插件工具都没有（ADR-050），
 * 会话自己又永远拿得到完整的一套。
 *
 * 工具实现就是 tools.js 里那十个（世界书 / 角色描述读写）。这里只做两件事：
 *
 *   1. 把定义表翻译成会话要的形状：`{ name, description, parameters, run }`
 *   2. 执行一次调用，并把结果收成一条**非空**的工具消息正文
 *
 * `execution` 的边界很窄：解析参数、找工具、兜住异常、序列化。业务判断全在
 * 工具自己的实现里，这一层不认识世界书也不认识角色描述。
 */

import { getToolDefs } from './tools.js';

/**
 * 造一组会话工具。
 *
 * tools.js 里的定义用 `action`；这里统一包成 `run`，因为会话只认 `run(args, session)`，
 * 而 `session` 只给确有的工具用（世界书工具不需要 scratch）。
 *
 * @param {{ defs?: Array<object> }} [options] 传 defs 可以换一套（自检 / 测试用）
 * @returns {Array<{ name: string, description: string, parameters: object, run: Function }>}
 */
export function createSessionTools({ defs = null } = {}) {
    const source = Array.isArray(defs) ? defs : getToolDefs();

    return source.map(def => ({
        name: String(def.name ?? ''),
        description: String(def.description ?? ''),
        parameters: def.parameters ?? { type: 'object', properties: {} },
        /**
         * 执行体。收到的就是模型给的参数对象，返回任意可序列化的结果；
         * `executeTool` 负责把它变成工具消息的正文。
         */
        run: (args, session) => (typeof def.run === 'function'
            ? def.run(args, session)
            : def.action(args, session)),
    }));
}

/**
 * 转成请求体里的 `tools`（OpenAI 形状）。
 *
 * 服务端负责再转 Claude / Gemini（`chat-completions.js:289-300` / `565-600`），
 * 所以这里只产出一种形状，不需要 provider 适配。
 *
 * @param {Array<object>} tools
 * @returns {Array<object>}
 */
export function toOpenAITools(tools) {
    return (tools ?? []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
    }));
}

/**
 * 按名字找工具。
 * @param {Array<object>} tools
 * @param {string} name
 * @returns {object|null}
 */
export function findTool(tools, name) {
    const wanted = String(name ?? '');
    return (tools ?? []).find(tool => tool.name === wanted) ?? null;
}

/**
 * 执行一次工具调用。**永不 throw**，返回的 `text` 保证非空。
 *
 * `text` 非空是硬要求：`role:'tool'` 的消息内容一旦为空，整条会被下游当成不存在，
 * `tool_call_id` 跟着消失，下一轮必然 400。
 *
 * 工具实现返回的通常是 `{ ok: true, ... }` 这种结构化对象（ST 那边也是这么交的），
 * 这里统一序列化成 JSON；只有自带 `text` 的（自检工具）才原样使用。
 *
 * @param {Array<object>} tools
 * @param {{ id: string, name: string, arguments?: unknown }} call
 * @param {object} session 工具可以用 `session.scratch` 存自己的状态
 * @returns {{ ok: boolean, text: string, fatal: boolean, error?: string }}
 */
export async function executeTool(tools, call, session) {
    const name = String(call?.name ?? '').trim();
    const tool = findTool(tools, name);

    if (!tool) {
        return soft('UNKNOWN_TOOL', `没有「${name}」这个工具。可用：${(tools ?? []).map(item => item.name).join(' / ')}`);
    }

    const args = parseArgs(call?.arguments);
    if (!args.ok) {
        return soft('ARGS_NOT_JSON', `参数不是合法 JSON 对象：${args.detail}。重新按 schema 给参数，不要传字符串套字符串。`);
    }

    try {
        return shape(await tool.run(args.value, session));
    } catch (err) {
        // 工具自己炸了：当成软错误喂回模型，让它换个做法，而不是整场会话中断
        return soft('TOOL_CRASHED', `工具自身报错：${err?.message ?? err}`);
    }
}

/* ------------------------------------------------------------------ 内部 */

/** 工具返回值 → 会话要的形状 */
function shape(output) {
    const value = output ?? {};

    // 自检工具直接给 text；真实工具给的是普通对象
    if (typeof value.text === 'string') {
        return {
            ok: value.ok !== false,
            fatal: value.fatal === true,
            text: value.text.trim() ? value.text : json({ ok: true, note: '（没有更多内容）' }),
            ...(value.ok === false ? { error: 'TOOL_REPORTED_ERROR' } : {}),
        };
    }

    return {
        ok: value.ok !== false,
        fatal: value.fatal === true,
        text: json(value),
        ...(value.ok === false ? { error: String(value.error ?? 'TOOL_REPORTED_ERROR') } : {}),
    };
}

function soft(error, hint) {
    return { ok: false, fatal: false, error, text: json({ ok: false, error, hint }) };
}

function json(value) {
    try {
        const text = JSON.stringify(value);
        // undefined / 函数之类序列化后是 undefined，兜底成一句可读的
        return typeof text === 'string' && text ? text : json({ ok: true });
    } catch {
        return '{"ok":false,"error":"SERIALIZE_FAILED"}';
    }
}

/** 参数解析：字符串按 JSON 解，对象原样用，空值当空对象 */
function parseArgs(raw) {
    if (raw === null || raw === undefined || raw === '') {
        return { ok: true, value: {} };
    }
    if (typeof raw === 'object') {
        return { ok: true, value: raw };
    }

    try {
        const parsed = JSON.parse(String(raw));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, value: parsed };
        }
        return { ok: false, detail: '解出来不是对象' };
    } catch (err) {
        return { ok: false, detail: err?.message ?? String(err) };
    }
}
