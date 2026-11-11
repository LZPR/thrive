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

/**
 * 一张图按多少 token 估。
 *
 * 不能按 base64 长度算：一张 1024×768 的 JPEG 编码后 30 万字符，除 3 就是十万 token，
 * 预算判定会立刻判"装不下"，而真实开销是一千上下（OpenAI 的 512px 切块口径）。
 * 宁可高估一点：低估会撞接口报溢出，高估只是提前收手。
 */
export const IMAGE_TOKENS = 1100;

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
 * 一条带图的用户消息。
 *
 * 图片按 OpenAI 的多模态写法挂在同一条消息里：`content` 变成
 * `[{type:'text'}, {type:'image_url'}]` 的块数组。为什么不用"一条文本 + 一条只有图"：
 * 图离开文字就会被当成另一件事，而"这张图就是刚才那段话说到的角色"正是教授时要表达的。
 *
 * 图必须是 data URL（`data:image/…;base64,…`）：会话不落盘、不引用 ST 的
 * `user/images/` 目录，路径形式的图在任何一步都可能失效。
 *
 * 没有图时退回普通文本消息——`content` 一旦是数组，绕过 ST 的地方就要多认一种形状，
 * 能不进入那条分支就不进入。
 *
 * @param {string} text
 * @param {string[]} images data URL 列表
 * @returns {object}
 */
export function userWithImages(text, images = []) {
    const urls = (Array.isArray(images) ? images : [])
        .map(url => String(url ?? '').trim())
        .filter(url => url.startsWith('data:image/'));

    if (urls.length === 0) {
        return userText(text);
    }

    const body = String(text ?? '');
    const parts = [];
    if (body.trim()) {
        parts.push(Object.freeze({ type: 'text', text: body }));
    }
    for (const url of urls) {
        parts.push(Object.freeze({ type: 'image_url', image_url: Object.freeze({ url }) }));
    }

    return Object.freeze({ role: 'user', content: Object.freeze(parts) });
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
            content: Array.isArray(message.content) ? message.content.slice() : (message.content ?? null),
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
 * 图片例外：base64 的长度与真实开销完全不成比例，所以先把 data URL 换成一个
 * 固定占位串再算字节，然后按张数补 `IMAGE_TOKENS`。
 *
 * @param {object[]} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
    let images = 0;

    const shadow = toChat(messages).map(message => {
        if (!Array.isArray(message.content)) {
            return message;
        }

        const content = message.content.map(part => {
            if (part?.type !== 'image_url') {
                return part;
            }
            images += 1;
            return { type: 'image_url', image_url: { url: 'data:image;base64,IMAGE' } };
        });

        return { ...message, content };
    });

    return Math.ceil(utf8Bytes(JSON.stringify(shadow)) / 3) + images * IMAGE_TOKENS;
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
 *   7. 只有 user 消息的 `content` 可以是块数组，且块只能是 text / image_url，
 *      image_url 必须是 data URL（见 `partsProblem`）
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
            // 唯一允许的非字符串：user 消息的多模态块数组（带图）
            if (message.role !== 'user' || !Array.isArray(message.content)) {
                return bad(`${at}的 content 既不是字符串也不是合法的多模态数组`);
            }
            const parts = partsProblem(message.content);
            if (parts) {
                return bad(`${at}${parts}`);
            }
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
        if (!hasContent(message.content)) {
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
 * 多模态块数组的形状检查。只认 OpenAI 的两种块：`text` 与 `image_url`。
 *
 * 认不出的块不放过：发出去之后接口只会回一句"content 格式不对"，那时候已经
 * 分不清是哪一条消息的问题了。
 *
 * @param {unknown[]} content
 * @returns {string} 有问题时的说明，没问题返回空串
 */
function partsProblem(content) {
    if (content.length === 0) {
        return '的 content 是空数组';
    }

    for (const part of content) {
        if (!part || typeof part !== 'object') {
            return '的 content 里有不是对象的块';
        }
        if (part.type === 'text') {
            if (typeof part.text !== 'string') {
                return '的文本块没有 text 字符串';
            }
            continue;
        }
        if (part.type === 'image_url') {
            const url = part.image_url?.url;
            if (typeof url !== 'string' || !url.startsWith('data:image/')) {
                return '的图片块不是 data URL（会话不引用外部图片路径）';
            }
            continue;
        }
        return `的 content 里有不认识的块类型「${part.type}」`;
    }

    return '';
}

/** 字符串内容或块数组里到底有没有东西 */
function hasContent(content) {
    if (Array.isArray(content)) {
        return content.some(part => part?.type === 'image_url'
            || (typeof part?.text === 'string' && part.text.trim()));
    }
    return Boolean(String(content ?? '').trim());
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
