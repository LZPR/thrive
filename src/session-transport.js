/**
 * session-transport.js · 会话唯一的 ST 耦合点
 *
 * 全部六个 session 模块里，只有这一个碰 ST 的内部实现。它的上游（`session.js`）
 * 只认 `{ ok, data } | { ok: false, error, detail }`，不认 SillyTavern。
 *
 * 为什么直连而不是 `sendOpenAIRequest` + 事件钩子：
 *
 *   - 钩子要等到 `CHAT_COMPLETION_SETTINGS_READY` 才能改 payload，而那条事件是
 *     **全局**的：别的扩展只要在我们之后注册，就能把 tools 覆盖掉。窗口虽小，
 *     但失败表现是"模型莫名不调工具"，最难查。
 *   - `createGenerationParameters` 之后就没人再动 payload 了，我们自己持有它，
 *     可以原样打日志——出问题时能直接看到发出去的是什么。
 *
 * 代价是要自己处理非流式响应与错误（约 25 行）。ST 的 quota / moderation 检查
 * 只负责弹 toastr，信息本身都在 `data.error` 里，这里直接带进 detail，不丢。
 *
 * 静态 import 一律不用：ST 升级改了路径时，只让这一个模块报
 * `SESSION_NOT_CONFIGURED`，不会把整个插件入口带崩（与斜杠命令同一套理由）。
 */

const OPENAI_MODULE = '../../../../openai.js';
const SCRIPT_MODULE = '../../../../../script.js';

/** ST 的聊天补全端点。quiet 走的就是它 */
const ENDPOINT = '/api/backends/chat-completions/generate';

/** 单次请求的超时。挂住的请求会一直占着会话，必须有上限 */
export const DEFAULT_TIMEOUT_MS = 60_000;

let cache = null;
let loading = null;

/**
 * 惰性加载 ST 的模块。结果缓存一次，失败也缓存（避免每轮都重试 import）。
 *
 * @returns {Promise<{ ok: true, st: object } | { ok: false, error: string, detail?: string }>}
 */
export async function loadST() {
    if (cache) {
        return cache;
    }
    if (!loading) {
        loading = doLoad();
    }
    cache = await loading;
    return cache;
}

async function doLoad() {
    try {
        const [openai, script] = await Promise.all([
            import(OPENAI_MODULE),
            import(SCRIPT_MODULE),
        ]);

        const missing = ['createGenerationParameters', 'getChatCompletionModel', 'oai_settings']
            .filter(key => !openai?.[key]);

        if (missing.length > 0) {
            return { ok: false, error: 'SESSION_NOT_CONFIGURED', detail: `openai.js 缺少 ${missing.join('、')}` };
        }
        if (typeof script?.getRequestHeaders !== 'function') {
            return { ok: false, error: 'SESSION_NOT_CONFIGURED', detail: 'script.js 没有导出 getRequestHeaders' };
        }

        return {
            ok: true,
            st: {
                createGenerationParameters: openai.createGenerationParameters,
                getChatCompletionModel: openai.getChatCompletionModel,
                // 导出的是 live binding，用户在界面上改采样参数后这里读到的就是新值
                oai_settings: openai.oai_settings,
                getRequestHeaders: script.getRequestHeaders,
            },
        };
    } catch (err) {
        return {
            ok: false,
            error: 'SESSION_NOT_CONFIGURED',
            detail: err?.message ?? String(err),
        };
    }
}

/**
 * 出发前体检。
 *
 * 工具能不能用一律问 ST（ADR-020）。这里传 `'normal'` 而不是 `'quiet'`：
 * `canPerformToolCalls` 把 quiet 列进了黑名单，用 quiet 问必然得到 false，
 * 那是 ST 对"主对话静默生成"的限制，与我们的会话无关。
 *
 * @param {object} ctx getContext() 的返回值，调用时现取
 * @returns {Promise<{ ok: true, st: object } | { ok: false, error: string, detail?: string }>}
 */
export async function probeTransport(ctx) {
    if (!ctx) {
        return { ok: false, error: 'SESSION_NOT_CONFIGURED', detail: '拿不到 SillyTavern 的上下文' };
    }

    const loaded = await loadST();
    if (!loaded.ok) {
        return loaded;
    }

    const ask = typeof ctx.canPerformToolCalls === 'function'
        ? () => ctx.canPerformToolCalls('normal')
        : (typeof ctx.isToolCallingSupported === 'function' ? () => ctx.isToolCallingSupported() : null);

    if (ask) {
        try {
            if (!ask()) {
                return { ok: false, error: 'SESSION_TOOLS_UNSUPPORTED' };
            }
        } catch (err) {
            return { ok: false, error: 'SESSION_DRIFT', detail: `工具可用性接口抛错：${err?.message ?? err}` };
        }
    }

    return { ok: true, st: loaded.st };
}

/**
 * 发一次请求。
 *
 * `sampling` 只在 payload 里**已存在该键**时才覆盖：o1 / gpt-5 这类模型被 ST
 * 特意删掉了 `temperature`、把 `max_tokens` 改名成 `max_completion_tokens`，
 * 无脑写回就是一次必定的 400。
 *
 * @param {object} ctx
 * @param {{
 *   messages: object[],
 *   tools: object[],
 *   sampling?: object|null,
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number,
 * }} req
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string, detail?: string }>}
 */
export async function requestOnce(ctx, req) {
    const { messages, tools, sampling = null, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = req ?? {};

    const loaded = await loadST();
    if (!loaded.ok) {
        return loaded;
    }
    const st = loaded.st;

    let payload;
    try {
        const settings = st.oai_settings;
        const model = st.getChatCompletionModel(settings);
        const built = await st.createGenerationParameters(settings, model, 'quiet', messages);
        payload = built?.generate_data;
    } catch (err) {
        return { ok: false, error: 'SESSION_TRANSPORT', detail: `构造请求失败：${err?.message ?? err}` };
    }

    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'SESSION_DRIFT', detail: 'createGenerationParameters 没有给出 payload' };
    }
    // 这两条是整条传输路径赖以成立的前提：quiet 必须是非流式，否则拿不到原始 JSON
    if (payload.type !== 'quiet') {
        return { ok: false, error: 'SESSION_DRIFT', detail: `payload.type 是「${payload.type}」` };
    }
    if (payload.stream !== false) {
        return { ok: false, error: 'SESSION_DRIFT', detail: 'quiet 请求竟然是流式' };
    }

    // quiet 下 ST 自己不会写 tools（canPerformToolCalls 排除 quiet），这里是我们唯一写入点
    payload.tools = Array.isArray(tools) ? tools : [];
    payload.tool_choice = 'auto';

    for (const [key, value] of Object.entries(sampling ?? {})) {
        if (key in payload) {
            payload[key] = value;
        }
    }

    console.debug(
        `[Thrive] 会话请求 · type=${payload.type} stream=${payload.stream}`
        + ` tools=${payload.tools.length} messages=${Array.isArray(messages) ? messages.length : 0}`,
    );

    const gate = withTimeout(signal, timeoutMs);

    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: st.getRequestHeaders(),
            body: JSON.stringify(payload),
            signal: gate.signal,
        });

        if (!response.ok) {
            const body = await safeText(response);
            return {
                ok: false,
                error: 'SESSION_TRANSPORT',
                detail: `HTTP ${response.status}：${shorten(body, 300)}`,
            };
        }

        const data = await response.json();
        if (data?.error) {
            return { ok: false, error: 'SESSION_TRANSPORT', detail: `接口返回错误：${shorten(errorText(data), 300)}` };
        }

        return { ok: true, data };
    } catch (err) {
        if (gate.timedOut()) {
            return { ok: false, error: 'SESSION_TIMEOUT', detail: `超过 ${Math.round(Number(timeoutMs) / 1000)} 秒没有回应` };
        }
        if (err?.name === 'AbortError') {
            return { ok: false, error: 'SESSION_ABORTED' };
        }
        return { ok: false, error: 'SESSION_TRANSPORT', detail: err?.message ?? String(err) };
    } finally {
        gate.cancel();
    }
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 给一次请求套上超时，并转发外部的中止信号。
 *
 * 用内层 controller 而不是 `AbortSignal.timeout`：需要区分"超时"与"用户中止"，
 * 两者的错误码不同（一个可以重试，一个不该重试）。
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {number} ms
 */
function withTimeout(signal, ms) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;

    const forward = () => {
        try {
            controller.abort(signal?.reason);
        } catch {
            controller.abort();
        }
    };

    if (signal) {
        if (signal.aborted) {
            forward();
        } else {
            signal.addEventListener('abort', forward, { once: true });
        }
    }

    if (Number.isFinite(ms) && ms > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            try {
                controller.abort();
            } catch {
                // 已经中止过了，无所谓
            }
        }, ms);
    }

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                signal?.removeEventListener('abort', forward);
            } catch {
                // 没有 removeEventListener 就算了，一次性监听器本来也会自己摘
            }
        },
    };
}

async function safeText(response) {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

/** `data.error` 可能是字符串、`{ message }` 或 `{ message, code }` */
function errorText(data) {
    const error = data?.error;
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        const message = error.message ?? error.msg ?? '';
        const code = error.code ?? error.type ?? '';
        return [code, message].filter(Boolean).join(' · ') || JSON.stringify(error);
    }
    return String(error ?? '未知错误');
}

function shorten(text, max) {
    const str = String(text ?? '').replace(/\s+/g, ' ').trim();
    return str.length > max ? `${str.slice(0, max)}…` : str;
}
