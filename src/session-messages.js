/**
 * session-messages.js · 一次性会话的消息层
 *
 * 为什么不用 ST 的 `Message` / `MessageCollection`：那套东西的价值全部建立在
 * "每条消息都有精确 token 数"上，而它的计数方式是每条消息发一次
 * `POST /api/tokenizers/openai/count`（`countTokensOpenAIAsync` 即使收到数组也是
 * 循环逐条发，不合并）。一场三到五轮、每轮两三个工具的会话要为此付十几次串行往返，
 * 还会把消息写进当前 chatId 的 tokenCache、给 ST 的全局 counts 留一个 `undefined: NaN` 键。
 *
 * 所以这里只保留它真正要对齐的东西：`getChat()` 的序列化规则（字段与过滤条件，
 * `openai.js:3830-3845`），其余自建。
 *
 * 设计取向是**让违规无法构造**，而不是事后检测违规：消息只能由四个工厂产出，
 * 工厂内部就把协议不变式钉死。`assertProtocol` 只是开发期自检，用来在改工厂时
 * 立刻发现漏项，不是唯一防线。
 */

/** 工具返回空内容时的占位。`role:'tool'` 的消息一旦内容为空，整条会被下游当成"没有这条" */
export const EMPTY_TOOL_TEXT = '（工具没有返回内容）';

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/* ------------------------------------------------------------------ 工厂 */

/**
 * 一条系统消息。预设里的规则段走这里。
 *
 * @param {string} text
 * @returns {object}
 */
export function systemText(text) {
    return Object.freeze({ role: 'system', content: String(text ?? '') });
}

/**
 * 一条用户消息。
 *
 * 空白文本不算合法输入：`toChat()` 会把它丢掉，留下一段没人说的对话。
 * 调用方（`sendUserMessage`）负责先拦，这里只保证内容一定是字符串。
 *
 * @param {string} text
 * @returns {object} 冻结的消息对象
 */
export function userText(text) {
    return Object.freeze({ role: 'user', content: String(text ?? '') });
}

/**
 * 一条助手消息，可能带工具调用。
 *
 * 带 `tool_calls` 时 `content` 固定为 `null`：OpenAI 只认 `null` 或省略，
 * 空串会被部分兼容层当成"模型回了空话"，反而丢掉这一轮。
 *
 * 返回的 `tool_calls` 是**归一化之后**的那一份（补 id、去重、arguments 转字符串），
 * 调用方应当直接遍历它来执行工具——`tool_result` 的 `tool_call_id` 因此天然对得上。
 *
 * @param {string|null} content
 * @param {Array<{id?: string, name: string, arguments?: unknown}>|null} toolCalls
 * @returns {object}
 */
export function assistantReply(content, toolCalls = null) {
    const calls = normalizeToolCalls(toolCalls);
    const text = content === null || content === undefined ? '' : String(content);

    return Object.freeze({
        role: 'assistant',
        content: calls ? null : text,
        ...(calls ? { tool_calls: calls } : {}),
    });
}

/**
 * 一条工具结果。
 *
 * `toolCallId` 会被下游当成 `tool_call_id`（不是内部标签），它必须与某条
 * assistant 的 `tool_calls[].id` 完全一致，否则下一轮必然 400。
 * 内容为空时兜底成一句占位，理由见 `EMPTY_TOOL_TEXT`。
 *
 * 刻意不加 `name`：部分兼容层见到 tool 消息带 name 会直接拒绝。
 *
 * @param {string} toolCallId
 * @param {string} text
 * @returns {object}
 */
export function toolResult(toolCallId, text) {
    const body = text === null || text === undefined ? '' : String(text);

    return Object.freeze({
        role: 'tool',
        content: body.trim() ? body : EMPTY_TOOL_TEXT,
        tool_call_id: String(toolCallId ?? '').trim(),
    });
}

/* -------------------------------------------------------------- 序列化 */

/**
 * 消息数组 → 请求体的 `messages`。
 *
 * 过滤条件与 ST 的 `getChat()` 一致：空内容且没有工具调用的消息不发出去
 * （`openai.js:4115` 的 `if (message.content || message.tool_calls)`）。
 *
 * @param {object[]} messages
 * @returns {object[]} 新数组，元素是新对象；修改返回值不影响会话
 */
export function toChat(messages) {
    const out = [];

    for (const message of messages ?? []) {
        if (!message) {
            continue;
        }
        if (!message.content && !message.tool_calls?.length) {
            continue;
        }

        const wire = {
            role: message.role,
            content: message.content ?? null,
        };

        // tool_call_id 只属于 tool 消息；其余角色带上它是协议错误
        if (message.role === 'tool') {
            wire.tool_call_id = message.tool_call_id;
        }
        if (message.tool_calls?.length) {
            wire.tool_calls = message.tool_calls;
        }

        out.push(wire);
    }

    return out;
}

/**
 * 粗估整段消息的 token 数。
 *
 * 按 UTF-8 字节数除 3：中文 1 字 ≈ 3 字节 ≈ 1 token，英文 ≈ 0.33 token/字符，
 * 两边都落在真实值附近。纯本地、零往返，只用于"明显装不下时提前拦"——
 * 精确计数要发请求，那正是这一层要避免的东西。
 *
 * @param {object[]} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
    return Math.ceil(utf8Bytes(JSON.stringify(toChat(messages))) / 3);
}

/* -------------------------------------------------------------- 自检 */

/**
 * 协议自检。开发期用：`runLoop` 每轮追加完消息后跑一次。
 *
 * 六条不变式（与 ST `getChat()` 的契约对应）：
 *   1. role 只能是 system / user / assistant / tool
 *   2. tool 消息必须有非空 `tool_call_id`，且不重复
 *   3. `tool_call_id` 必须能在它之前某条 assistant 的 `tool_calls[].id` 里找到
 *   4. `${tool_calls[].function.arguments}` 必须是字符串
 *   5. `tool_calls[].id` 非空、同一轮内唯一
 *   6. tool 消息不带 `name`；`name` / `content` 的类型必须干净
 *
 * @param {object[]} messages
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertProtocol(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const open = new Set();      // 已经发出、还没被 tool 消息回应的 tool_call id
    const answered = new Set();  // 已经被回应过的 tool_call id

    for (let i = 0; i < list.length; i++) {
        const message = list[i];
        const at = `第 ${i + 1} 条`;

        if (!message || typeof message !== 'object') {
            return bad(`${at}不是对象`);
        }
        if (!ROLES.has(message.role)) {
            return bad(`${at}的 role 是「${message.role}」`);
        }
        if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') {
            return bad(`${at}的 content 不是字符串`);
        }
        if (message.name !== undefined) {
            return bad(`${at}带了 name（本版不产生这个字段）`);
        }

        if (message.role === 'tool') {
            const id = String(message.tool_call_id ?? '').trim();
            if (!id) {
                return bad(`${at}是 tool 消息但没有 tool_call_id`);
            }
            if (!open.has(id)) {
                return bad(`${at}的 tool_call_id「${id}」没有对应的助手工具调用`);
            }
            if (answered.has(id)) {
                return bad(`${at}的 tool_call_id「${id}」重复回应`);
            }
            if (!String(message.content ?? '').trim()) {
                return bad(`${at}是 tool 消息但内容为空（会被下游丢掉）`);
            }
            open.delete(id);
            answered.add(id);
            continue;
        }

        if (message.tool_calls !== undefined) {
            if (message.role !== 'assistant') {
                return bad(`${at}带 tool_calls 但不是 assistant`);
            }
            if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
                return bad(`${at}的 tool_calls 不是非空数组`);
            }
            if (message.content !== null) {
                return bad(`${at}带 tool_calls 但 content 不是 null`);
            }

            const seen = new Set();
            for (const call of message.tool_calls) {
                const id = String(call?.id ?? '').trim();
                if (!id) {
                    return bad(`${at}有一个 tool_call 没有 id`);
                }
                if (seen.has(id)) {
                    return bad(`${at}里 tool_call id「${id}」重复`);
                }
                if (typeof call?.function?.arguments !== 'string') {
                    return bad(`${at}的 tool_call「${id}」arguments 不是字符串`);
                }
                seen.add(id);
                open.add(id);
            }
            continue;
        }

        // 到这里是普通的 user / assistant 消息：空内容发不出去，等于白占一条
        if (!String(message.content ?? '').trim()) {
            return bad(`${at}是空消息`);
        }
    }

    return { ok: true };
}

/* -------------------------------------------------------------- 内部 */

function bad(reason) {
    return { ok: false, reason };
}

/**
 * 工具调用归一化：补 id、去重、arguments 转字符串，并冻结。
 *
 * id 缺失时补成 `call_<下标>`；同一轮里撞 id 就往后加序号。能补是因为
 * 这里产出的就是唯一事实来源——调用方遍历它去执行工具，不会另造一份。
 *
 * @param {Array<{id?: string, name: string, arguments?: unknown}>|null} list
 * @returns {ReadonlyArray<object>|null}
 */
function normalizeToolCalls(list) {
    if (!Array.isArray(list) || list.length === 0) {
        return null;
    }

    const seen = new Set();
    const out = [];

    for (let i = 0; i < list.length; i++) {
        const call = list[i];
        if (!call || typeof call !== 'object') {
            continue;
        }

        const name = String(call.name ?? '').trim();
        if (!name) {
            continue;
        }

        const base = String(call.id ?? '').trim() || `call_${i}`;
        let id = base;
        for (let n = 2; seen.has(id); n++) {
            id = `${base}_${n}`;
        }
        seen.add(id);

        out.push(Object.freeze({
            id,
            type: 'function',
            function: Object.freeze({
                name,
                arguments: stringifyArgs(call.arguments),
            }),
        }));
    }

    return out.length ? Object.freeze(out) : null;
}

/** 参数一律转成字符串：OpenAI 要求 `arguments` 是 JSON 文本，不是对象 */
function stringifyArgs(args) {
    if (typeof args === 'string') {
        return args;
    }
    if (args === null || args === undefined) {
        return '{}';
    }

    try {
        return JSON.stringify(args);
    } catch {
        // 循环引用之类：宁可给一个空对象，也不要让整个会话因为一条参数炸掉
        return '{}';
    }
}

/** UTF-8 字节数。不用 TextEncoder，避免为一次估算引入依赖与编码差异 */
function utf8Bytes(text) {
    const str = String(text ?? '');
    let bytes = 0;

    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            bytes += 4;
            i += 1;
        } else {
            bytes += 3;
        }
    }

    return bytes;
}
