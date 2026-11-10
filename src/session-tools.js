/**
 * session-tools.js · 会话私有的工具表
 *
 * 和主对话那 10 个工具（`src/tools.js`）**没有任何关系**：不进 `ToolManager`、
 * 不走 `ctx.registerFunctionTool`，只在这一次请求的 `tools` 字段里出现。
 * 这样开关学习模式不会改动主对话请求头部的 `tools` 数组，前缀缓存不受影响；
 * 反过来，会话也不受"学习模式开没开"的门控。
 *
 * 这一版的三个工具都是自检用的存根，不碰世界书、不碰角色卡：
 *   stub_read   读一条内置事实，顺手发一个本场专属 ticket
 *   stub_write  必须带着那个 ticket 才能写 —— 模型猜不到它，所以物理上必须先读后写
 *   stub_boom   主动制造一个致命错误，用来走通"循环停下"的分支
 *
 * `stub_write` 的 ticket 不是防呆，是**让"多轮"成为结构事实**：只要它写成功了，
 * 第二轮请求里就必然带着第一轮的 tool 消息，不必依赖对模型行为的软断言。
 */

import { createId } from './util.js';

/** 内置事实表。真实实现里这里会换成世界书读取 */
const STUB_FACTS = Object.freeze({
    北境: Object.freeze({
        title: '北境',
        body: '北境常年积雪，南面是灰石山脉，首府白港；当地人用盐和毛皮换取南方的铁器。',
    }),
    灰石山脉: Object.freeze({
        title: '灰石山脉',
        body: '灰石山脉横在北境与南方之间，山口只有三处，冬季全部封闭。',
    }),
});

const STUB_KEYS = Object.keys(STUB_FACTS);

/**
 * 造一组会话工具。
 *
 * @returns {Array<{name: string, description: string, parameters: object, run: (args: object, session: object) => {ok?: boolean, text: string, fatal?: boolean}}>}
 */
export function createSessionTools() {
    return [
        {
            name: 'stub_read',
            description: '读取一条内置事实。返回 title、body 与一个 ticket；写之前必须先读。',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: `要读的条目名，可用：${STUB_KEYS.join('、')}` },
                },
                required: ['key'],
            },
            run(args, session) {
                const key = String(args?.key ?? '').trim();

                if (!STUB_FACTS[key]) {
                    return {
                        ok: false,
                        text: json({
                            ok: false,
                            error: 'STUB_NO_KEY',
                            hint: `没有「${key || '空'}」这一条。可用的 key：${STUB_KEYS.join(' / ')}`,
                        }),
                    };
                }

                const fact = STUB_FACTS[key];
                return {
                    ok: true,
                    text: json({ ok: true, title: fact.title, body: fact.body, ticket: session?.scratch?.ticket ?? '' }),
                };
            },
        },

        {
            name: 'stub_write',
            description: '把内容写入本场会话的暂存区。必须带上 stub_read 返回的 ticket。',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '标题' },
                    body: { type: 'string', description: '正文' },
                    ticket: { type: 'string', description: 'stub_read 返回的那个 ticket，原样带上' },
                },
                required: ['title', 'body', 'ticket'],
            },
            run(args, session) {
                const scratch = session?.scratch ?? { ticket: '', writes: [] };
                const ticket = String(args?.ticket ?? '').trim();

                if (!ticket || ticket !== scratch.ticket) {
                    return {
                        ok: false,
                        text: json({
                            ok: false,
                            error: 'STUB_TICKET',
                            hint: 'ticket 不对或没带。先调用 stub_read 拿到 ticket，再把这个值原样传回来。',
                        }),
                    };
                }

                const title = String(args?.title ?? '').trim();
                if (!title) {
                    return { ok: false, text: json({ ok: false, error: 'STUB_TITLE', hint: '标题不能为空。' }) };
                }

                scratch.writes.push({ title, body: String(args?.body ?? '') });
                return { ok: true, text: json({ ok: true, count: scratch.writes.length, latest: title }) };
            },
        },

        {
            name: 'stub_boom',
            description: '自检用：主动报一个致命错误，让工具循环立刻停下。',
            parameters: {
                type: 'object',
                properties: {
                    fatal: { type: 'boolean', description: '传 false 表示只是普通返回，不致命' },
                },
            },
            run(args) {
                if (args?.fatal === false) {
                    return { ok: true, text: json({ ok: true, note: '没有致命化，循环应当继续。' }) };
                }
                return {
                    ok: false,
                    fatal: true,
                    text: json({ ok: false, error: 'STUB_FATAL', hint: '这一场由 stub_boom 主动终止，属于自检预期行为。' }),
                };
            },
        },
    ];
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
 * @param {Array<object>} tools
 * @param {{ id: string, name: string, arguments?: unknown }} call
 * @param {object} session 工具可以用 `session.scratch` 存自己的状态
 * @returns {{ ok: boolean, text: string, fatal: boolean, error?: string }}
 */
export function executeTool(tools, call, session) {
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
        const result = tool.run(args.value, session) ?? {};
        const text = String(result.text ?? '');
        return {
            ok: result.ok !== false,
            fatal: result.fatal === true,
            text: text.trim() ? text : json({ ok: false, error: 'EMPTY_RESULT', hint: '工具没有返回内容。' }),
            ...(result.ok === false ? { error: 'TOOL_REPORTED_ERROR' } : {}),
        };
    } catch (err) {
        // 工具自己炸了：当成软错误喂回模型，让它换个做法，而不是整场会话中断
        return soft('TOOL_CRASHED', `工具自身报错：${err?.message ?? err}`);
    }
}

/* ------------------------------------------------------------------ 内部 */

function soft(error, hint) {
    return { ok: false, fatal: false, error, text: json({ ok: false, error, hint }) };
}

function json(value) {
    try {
        return JSON.stringify(value);
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

/** 本场会话的随机 ticket。放这里是因为只有工具用得上它 */
export function createScratch() {
    return { ticket: createId('tk'), writes: [] };
}
