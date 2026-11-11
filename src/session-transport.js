/**
 * session-transport.js · 会话唯一的 ST 耦合点
 *
 * 全部 session 模块里只有这一个碰 ST 的内部实现。它的上游（`session.js`）
 * 只认 `{ ok, data } | { ok: false, error, detail }`，不认 SillyTavern。
 *
 * 两条路，二选一，由设置项 `connectionProfile` 决定：
 *
 *   · 空（默认）—— 跟着**当前聊天设置**走：`createGenerationParameters` 造 payload，
 *     直接 POST 到 `/api/backends/chat-completions/generate`。
 *   · 指定了连接配置 —— 跟着**那一份连接**走：交给 ST 的
 *     `ConnectionManagerRequestService`，它负责把 profile 的 api / 模型 / 密钥 /
 *     代理 / 端点映射成请求。预设**不随行**（`includePreset: false`）：那是聊天那边
 *     的提示词，我们的会话有自己编译的一份。这条路只在会话开始时读一次设置。
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
 * **不再问"工具调用可不可用"**：会话的 `tools` 由我们自己写进 payload，
 * ST 那个「启用函数调用」开关只管它自己的聊天请求。用户把开关关掉照样能学，
 * 所以这里只确认"这条路真的能发出去"。
 *
 * @param {object} ctx getContext() 的返回值，调用时现取
 * @param {{ profileId?: string }} [options] 指定连接配置时走 profile 那条路
 * @returns {Promise<{ ok: true, st: object|null } | { ok: false, error: string, detail?: string }>}
 */
export async function probeTransport(ctx, { profileId = '' } = {}) {
    if (!ctx) {
        return { ok: false, error: 'SESSION_NOT_CONFIGURED', detail: '拿不到 SillyTavern 的上下文' };
    }

    if (profileId) {
        return probeProfile(ctx, profileId);
    }

    const loaded = await loadST();
    if (!loaded.ok) {
        return loaded;
    }

    return { ok: true, st: loaded.st };
}

/**
 * 检查指定的连接配置还能不能用。
 *
 * 三种失败分开报：服务不在（ST 版本或扩展被停用）、配置没了（被删了 / 换了设备）、
 * 配置不是聊天补全（带不了工具）。
 *
 * @param {object} ctx
 * @param {string} profileId
 */
function probeProfile(ctx, profileId) {
    const service = ctx.ConnectionManagerRequestService;

    if (!service || typeof service.sendRequest !== 'function' || typeof service.getProfile !== 'function') {
        return {
            ok: false,
            error: 'SESSION_PROFILE_UNAVAILABLE',
            detail: '这个 SillyTavern 没有连接配置服务（Connection Manager）',
        };
    }

    if (Array.isArray(ctx.extensionSettings?.disabledExtensions)
        && ctx.extensionSettings.disabledExtensions.includes('connection-manager')) {
        return {
            ok: false,
            error: 'SESSION_PROFILE_UNAVAILABLE',
            detail: '「连接配置」扩展被停用了',
        };
    }

    let profile;
    try {
        profile = service.getProfile(profileId);
    } catch (err) {
        return {
            ok: false,
            error: 'SESSION_PROFILE_MISSING',
            detail: `选中的连接配置不在了：${err?.message ?? err}`,
        };
    }

    let supported = true;
    try {
        supported = typeof service.isProfileSupported === 'function' ? service.isProfileSupported(profile) : true;
    } catch {
        // 判定接口抛错就当"支持"，真的不行会在请求那一步报出来
        supported = true;
    }

    if (!supported) {
        return {
            ok: false,
            error: 'SESSION_PROFILE_UNSUPPORTED',
            detail: `连接配置「${profile?.name || profileId}」不是聊天补全（Chat Completion），带不了工具`,
        };
    }

    return { ok: true, st: null };
}

/**
 * 列出可选的连接配置，给设置页那个下拉用。
 *
 * 只读 `extension_settings.connectionManager.profiles`——那是 ST「连接配置」扩展自己
 * 存下来的列表，`ConnectionManagerRequestService.getProfile` 也是在这张表里找。
 *
 * 只留聊天补全（`mode === 'cc'`）的几份：文本补全的配置带不了 `tools`，选中之后每一场
 * 会话都会以 `SESSION_PROFILE_UNSUPPORTED` 失败，不如一开始就不让它出现在选项里。
 *
 * @param {object} ctx
 * @returns {Array<{ id: string, name: string, model: string }>}
 */
export function listConnectionProfiles(ctx) {
    const raw = ctx?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .filter(profile => profile && profile.id && (profile.mode === undefined || profile.mode === 'cc'))
        .map(profile => ({
            id: String(profile.id),
            name: String(profile.name || profile.model || profile.id),
            model: String(profile.model || ''),
        }));
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
 *   profileId?: string,
 * }} req `profileId` 非空时改走连接配置那条路（ST 的 ConnectionManagerRequestService）
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string, detail?: string }>}
 */
export async function requestOnce(ctx, req) {
    const { messages, tools, sampling = null, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, profileId = '' } = req ?? {};

    if (profileId) {
        return requestViaProfile(ctx, { messages, tools, signal, timeoutMs, profileId });
    }

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

/**
 * 通过 ST 的某一份**连接配置**发一次请求。
 *
 * 交给 `ConnectionManagerRequestService` 而不是自己拼 payload：profile 里的
 * api / 模型 / 预设 / 密钥 / 代理 / 自定义端点各有各的映射规则，抄一遍必然漂。
 * 代价是采样参数完全由那份配置决定——这里不覆盖，也覆盖不了。
 *
 * `extractData: false` 是关键：默认会把响应解析成 `{ content, reasoning }`，
 * 工具调用在那一步就丢了。要的是原始 JSON，交给 `readReply` 去读。
 *
 * @param {object} ctx
 * @param {{ messages: object[], tools: object[], signal: AbortSignal|null, timeoutMs: number, profileId: string }} req
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string, detail?: string }>}
 */
async function requestViaProfile(ctx, { messages, tools, signal, timeoutMs, profileId }) {
    const service = ctx?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        return { ok: false, error: 'SESSION_PROFILE_UNAVAILABLE', detail: '拿不到连接配置服务' };
    }

    // 上限继承当前聊天设置：profile 里没有 max_tokens 这一项，不传就由后端默认
    const configured = Number(ctx?.chatCompletionSettings?.openai_max_tokens);
    const maxTokens = Number.isFinite(configured) && configured > 0 ? configured : undefined;

    console.debug(
        `[Thrive] 会话请求 · 连接配置 ${profileId}`
        + ` tools=${Array.isArray(tools) ? tools.length : 0} messages=${Array.isArray(messages) ? messages.length : 0}`,
    );

    const gate = withTimeout(signal, timeoutMs);

    try {
        const data = await service.sendRequest(
            profileId,
            messages,
            maxTokens,
            /*
             * includePreset: false —— 这是隔离契约的一部分：那份配置的预设（系统提示 +
             * 提示词列表）属于"聊天那边"的提示词，我们的会话有自己编译出来的一份，
             * 两套一起发只会让模型同时收到两条互相打架的规则（ADR-049 / ADR-052）。
             * 配置里真正影响能不能发出去的（api / 端点 / 密钥 / 模型）照旧生效。
             */
            { stream: false, extractData: false, includePreset: false, includeInstruct: false, signal: gate.signal },
            { tools: Array.isArray(tools) ? tools : [], tool_choice: 'auto' },
        );

        if (!data || typeof data !== 'object') {
            return { ok: false, error: 'SESSION_DRIFT', detail: '连接配置没有返回 JSON' };
        }
        if (data.error) {
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

        // 服务层把真正的错误包在 cause 里（`new Error('API request failed', { cause })`）
        const inner = err?.cause?.message ?? err?.cause?.error?.message;
        return {
            ok: false,
            error: 'SESSION_TRANSPORT',
            detail: shorten(inner || err?.message || String(err), 300),
        };
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
