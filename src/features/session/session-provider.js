/**
 * session-provider.js · 把各家形状的工具响应收成一种
 *
 * ST 的服务端只负责**请求侧**转换（OpenAI 形状的 `tools` / `tool` 消息会被转成
 * Claude 的 `tool_use` / `tool_result`），响应侧不做归一化——
 * `tool-calling.js:707` 的 `#getToolCallsFromData` 要分别处理四种形状就是证据。
 *
 * 所以这一层只做"读"：把响应读成 `{ content, toolCalls }`。这一版只认 OpenAI 形状，
 * 其余三种明确报 `SESSION_PROVIDER_UNSUPPORTED` 并说出实际是什么形状，
 * 不静默丢工具调用——静默丢的表现是"模型不听话"，最难查。
 *
 * 新增一种形状 = 在 ADAPTERS 里加一个函数，其余调用方不用改。
 */

export const SHAPES = Object.freeze({
    OPENAI: 'openai',
    CLAUDE: 'claude',
    GEMINI: 'gemini',
    COHERE: 'cohere',
    UNKNOWN: 'unknown',
});

/** 给用户看的形状名 */
const SHAPE_LABELS = Object.freeze({
    [SHAPES.OPENAI]: 'OpenAI 兼容',
    [SHAPES.CLAUDE]: 'Claude',
    [SHAPES.GEMINI]: 'Gemini / Vertex',
    [SHAPES.COHERE]: 'Cohere',
    [SHAPES.UNKNOWN]: '认不出的',
});

/**
 * 判断这份响应是哪种形状。
 *
 * 顺序即优先级：OpenAI 有 `choices`，Claude 顶层有 `content[]`（块带 `type`），
 * Gemini 有 `responseContent.parts` 或 `candidates`，Cohere 是 `message` 对象。
 *
 * @param {unknown} data
 * @returns {string} SHAPES 之一
 */
export function detectShape(data) {
    if (!data || typeof data !== 'object') {
        return SHAPES.UNKNOWN;
    }

    // 空数组也算 OpenAI 形状：200 但 choices 为空是"模型没说话"，不是"来源不支持"
    if (Array.isArray(data.choices)) {
        return SHAPES.OPENAI;
    }
    if (Array.isArray(data.content) && data.content.some(block => typeof block?.type === 'string')) {
        return SHAPES.CLAUDE;
    }
    if (Array.isArray(data.responseContent?.parts) || Array.isArray(data.candidates)) {
        return SHAPES.GEMINI;
    }
    if (data.message && typeof data.message === 'object') {
        return SHAPES.COHERE;
    }

    return SHAPES.UNKNOWN;
}

/**
 * 读一次响应。
 *
 * 失败时只回错误码与 `detail`，hint 由调用方统一拼（那样才能带上"第几轮"这类上下文）。
 *
 * @param {unknown} data 请求的原始 JSON
 * @param {{ idPrefix?: string }} [options] 工具调用缺 id 时用它补
 * @returns {{ ok: true, content: string, toolCalls: Array<{id: string, name: string, arguments: unknown}>, finishReason: string }
 *          | { ok: false, error: string, detail?: string }}
 */
export function readReply(data, { idPrefix = 'call' } = {}) {
    const shape = detectShape(data);

    if (shape !== SHAPES.OPENAI) {
        return {
            ok: false,
            error: 'SESSION_PROVIDER_UNSUPPORTED',
            detail: SHAPE_LABELS[shape] ?? shape,
        };
    }

    const choice = pickChoice(data);
    if (!choice) {
        return { ok: false, error: 'SESSION_EMPTY_REPLY' };
    }

    const message = choice.message && typeof choice.message === 'object' ? choice.message : {};
    const content = readContent(message.content);
    const toolCalls = readToolCalls(message, idPrefix);

    if (!content.trim() && toolCalls.length === 0) {
        return { ok: false, error: 'SESSION_EMPTY_REPLY' };
    }

    return {
        ok: true,
        content,
        toolCalls,
        finishReason: String(choice.finish_reason ?? ''),
    };
}

/* ------------------------------------------------------------------ 内部 */

/** 取下标 0 的那条；没有 index 字段时退回第一条 */
function pickChoice(data) {
    const list = Array.isArray(data?.choices) ? data.choices : [];
    return list.find(choice => choice?.index === 0) ?? list[0] ?? null;
}

/** content 可能是字符串，也可能是 `[{ type:'text', text }]` 这样的块数组 */
function readContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : String(part?.text ?? '')))
            .filter(Boolean)
            .join('');
    }
    return '';
}

/**
 * 读工具调用。
 *
 * 兼容两种写法：`message.tool_calls[]`（现行）与 `message.function_call`（老的单个）。
 * `arguments` 原样交出去，由消息层统一转成字符串——那里才知道协议要求。
 *
 * @returns {Array<{id: string, name: string, arguments: unknown}>}
 */
function readToolCalls(message, prefix) {
    const raw = Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : (message?.function_call ? [message.function_call] : []);

    const seen = new Set();
    const out = [];

    for (let i = 0; i < raw.length; i++) {
        const call = raw[i];
        // 老格式把 name/arguments 直接挂在对象上，没有 function 这层包装
        const fn = call?.function ?? call;
        const name = String(fn?.name ?? '').trim();

        if (!name) {
            continue;
        }

        const base = String(call?.id ?? '').trim() || `${prefix}_${i}`;
        let id = base;
        for (let n = 2; seen.has(id); n++) {
            id = `${base}_${n}`;
        }
        seen.add(id);

        out.push({ id, name, arguments: fn?.arguments });
    }

    return out;
}
