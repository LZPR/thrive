/**
 * session.js · 一次性内部会话的门面
 *
 * 五步，每步一个函数，可以单独替换、单独验证：
 *
 *   openSession     体检 + 建对象（不计数、不发请求）
 *   applyPreset     预设 → 消息（由 prompt.js 的卡片编译而来）
 *   sendUserMessage 追加一条用户消息（学习用的开场白）
 *   runLoop         请求 → 解析 → 执行工具 → 再请求，直到结束
 *   closeSession    收尾 + 记一笔（幂等）
 *
 * `runSession` 是组合体，把五步串起来并处理 "已经开始一场" 的互斥。学习由
 * learning.js 调用它；斜杠命令与自检也走同一条路。
 *
 * 三条硬约定：
 *   1. 跨模块只传普通对象与 session，`runLoop` 不知道预设从哪来，`applyPreset` 不知道模型
 *   2. 每个函数都返回 `{ ok, ... }`，**永不 throw**（`runSession` 里唯一一个兜底 catch）
 *   3. 所有 ST 耦合都在 `session-transport.js`，这里只认 `deps.request`
 *
 * 会话不显示、不落盘、不写 chat_metadata：它只活在这个对象里，结束后由调用方
 * 决定记什么（learning.js 只往对话状态里写"结果摘要"）。全文进控制台摘要，
 * `logTranscript({ full: true })` 才打全文。
 */

import { hintFor } from '../../shared/diagnostics.js';
import {
    assertProtocol,
    assistantReply,
    estimateTokens,
    systemText,
    toChat,
    toolResult,
    userText,
    userWithImages,
} from './session-messages.js';
import { compilePreset } from './session-preset.js';
import { readReply } from './session-provider.js';
import { createSessionTools, executeTool, toOpenAITools } from './session-tools.js';
import { DEFAULT_TIMEOUT_MS, probeTransport, requestOnce } from '../../platform/sillytavern/transport.js';
import { createId } from '../../shared/util.js';

const LOG = '[Thrive]';

/** 轮数上限的硬边界。再高就不是"一次性会话"，是失控循环 */
const MAX_ROUNDS = 10;
const DEFAULT_ROUNDS = 5;

/** 估算值到这个比例就先停下，不要等 API 报溢出 */
const BUDGET_RATIO = 0.9;

/** 上下文读不到时的回落值。宁可给个小数字提前拦，也不要 NaN 让判断永远为假 */
const FALLBACK_CONTEXT = 8192;

/**
 * 默认采样覆盖。
 *
 * 只写 `temperature`：让学习结果稳定一点。其余采样参数全部继承 ST 设置——
 * 会话用的就是用户配好的那个后端与模型，那不是"污染"，是"就应该用这个"。
 * 覆盖时会跳过 payload 里不存在的键（o1 / gpt-5 被 ST 删掉了 temperature）。
 */
const DEFAULT_SAMPLING = Object.freeze({ temperature: 0.3 });

/** 正在跑的那一场（用于互斥与中止） */
let active = null;

/** 连接初始化同样占用会话槽位；取消标记在初始化完成后、发请求前检查。 */
let starting = null;

/** 最近跑完的那一场（`/thrive session log` 用） */
let last = null;

/* ------------------------------------------------------------------ 五步 */

/**
 * 第一步：体检 + 建对象。
 *
 * 只做三件事：问 ST 工具能不能用、读出上下文与轮数上限、把会话对象摆好。
 * 不碰消息、不发请求，所以这一步失败一定是环境问题，不是内容问题。
 *
 * @param {{
 *   ctx: object,
 *   deps?: { probe?: Function, request?: Function, sampling?: object }|null,
 *   preset?: object|null,
 *   maxRounds?: number|null,
 *   profileId?: string,
 * }} options
 * @returns {Promise<{ ok: true, session: object } | { ok: false, error: string, hint: string, detail?: string }>}
 */
export async function openSession({ ctx, deps = null, preset = null, maxRounds = null, tools = null, profileId = '' } = {}) {
    const probe = typeof deps?.probe === 'function' ? deps.probe : probeTransport;
    const probed = await probe(ctx, { profileId });

    if (!probed.ok) {
        return { ok: false, error: probed.error, hint: composeHint(probed.error, probed.detail), detail: probed.detail };
    }

    const limits = readLimits(ctx, maxRounds);

    /*
     * 用哪一份连接在这里就定下来：一场会话从头到尾只走一条路，中途改设置
     * 不该让同一场会话前几轮用 A、后几轮用 B。
     */
    const request = typeof deps?.request === 'function'
        ? deps.request
        : (innerCtx, req) => requestOnce(innerCtx, { ...req, profileId });

    const session = {
        id: createId('sess'),
        state: 'open',
        ctx,
        st: probed.st ?? null,
        deps: { request },
        messages: [],
        tools: Array.isArray(tools) ? tools : createSessionTools(),
        sampling: deps?.sampling ?? DEFAULT_SAMPLING,
        abort: new AbortController(),
        limits,
        profileId: String(profileId ?? ''),
        stats: { rounds: 0, toolCalls: 0, sawTools: false, startedAt: Date.now(), ms: 0 },
        transcript: [],
        presetId: String(preset?.id ?? ''),
        lastReply: '',
        lastError: null,
    };

    if (limits.fallbackContext) {
        record(session, { kind: 'note', text: `读不到上下文上限，按 ${FALLBACK_CONTEXT} 估算` });
    }

    return { ok: true, session };
}

/**
 * 第二步：把预设填进会话。
 *
 * 预设编译成"有序 run 列表"后逐段转成消息。同一角色的相邻段**不合并**：
 * 用户是自己排的顺序，合并之后"我把它放在这一条之后"就不再是字面上的意思了；
 * 这里只负责把已经排好的顺序照抄成 messages。
 *
 * @param {object} session
 * @param {object|null} [preset]
 * @returns {{ ok: true, added: number } | { ok: false, error: string, hint: string, detail?: string }}
 */
export function applyPreset(session, preset = null) {
    if (!usable(session, 'open')) {
        return { ok: false, error: 'SESSION_PROTOCOL', hint: composeHint('SESSION_PROTOCOL', '会话不在可填充状态') };
    }

    const compiled = compilePreset(session.ctx, preset);
    if (!compiled.ok) {
        return { ok: false, error: compiled.error, hint: composeHint(compiled.error, compiled.detail), detail: compiled.detail };
    }

    for (const run of compiled.runs) {
        const message = fromRun(run);
        if (message) {
            session.messages.push(message);
        }
    }

    session.presetId = compiled.id || session.presetId;

    const check = assertProtocol(session.messages);
    if (!check.ok) {
        return { ok: false, error: 'SESSION_PROTOCOL', hint: composeHint('SESSION_PROTOCOL', check.reason), detail: check.reason };
    }

    return { ok: true, added: compiled.runs.length };
}

/**
 * 第三步：追加一条用户消息。
 *
 * 空消息直接拒：`toChat()` 会把它过滤掉，等于这次请求少了一句话，
 * 而错误会以"模型答非所问"的形式出现，极难归因。
 *
 * `images` 是 data URL 列表（教授时可以附图）。有图时这条消息的 `content`
 * 变成多模态块数组，图片与文字同条发出去。
 *
 * @param {object} session
 * @param {string} text
 * @param {{ images?: string[]|null }} [options]
 * @returns {{ ok: true, chars: number, images: number } | { ok: false, error: string, hint: string, detail?: string }}
 */
export function sendUserMessage(session, text, { images = null } = {}) {
    if (!usable(session, 'open')) {
        return { ok: false, error: 'SESSION_PROTOCOL', hint: composeHint('SESSION_PROTOCOL', '会话不在可发送状态') };
    }

    const body = String(text ?? '');
    const list = Array.isArray(images) ? images : [];

    if (!body.trim() && list.length === 0) {
        return { ok: false, error: 'SESSION_PROTOCOL', hint: composeHint('SESSION_PROTOCOL', '用户消息是空的'), detail: '用户消息是空的' };
    }

    session.messages.push(userWithImages(body, list));
    return { ok: true, chars: body.length, images: list.length };
}

/**
 * 第四步：跑到结束。
 *
 * 循环里每一轮都重新序列化整段消息（不做增量），因为工具结果会插在中间，
 * 增量的收益抵不上状态出错的风险；会话本身只有十几条消息。
 *
 * 终止条件四选一，性质不同，所以用 `stopped` 单独回报：
 *   no_tool_calls  正常结束（`ok: true`）
 *   rounds         撞轮数上限，结果可能不完整
 *   aborted        用户中止
 *   fatal          工具报告致命错误
 *
 * @param {object} session
 * @param {{ maxRounds?: number|null }} [options]
 * @returns {Promise<object>}
 */
export async function runLoop(session, { maxRounds = null } = {}) {
    if (!usable(session, 'open', 'running')) {
        return stop(session, 'error', 'SESSION_PROTOCOL', '会话不在可运行状态');
    }

    session.state = 'running';
    const cap = clampRounds(maxRounds ?? session.limits.maxRounds);

    while (session.stats.rounds < cap) {
        if (session.abort.signal.aborted) {
            return stop(session, 'aborted', 'SESSION_ABORTED');
        }

        const estimated = estimateTokens(session.messages);
        const ceiling = Math.round(session.limits.contextTokens * BUDGET_RATIO);
        if (estimated > ceiling) {
            return stop(session, 'error', 'SESSION_BUDGET_EXCEEDED', `估算 ${estimated} token，阈值 ${ceiling}`);
        }

        const round = session.stats.rounds;
        const sent = await session.deps.request(session.ctx, {
            messages: toChat(session.messages),
            tools: toOpenAITools(session.tools),
            sampling: session.sampling,
            signal: session.abort.signal,
            timeoutMs: session.limits.timeoutMs,
        });

        if (!sent.ok) {
            const stopped = sent.error === 'SESSION_ABORTED' ? 'aborted' : 'error';
            return stop(session, stopped, sent.error, sent.detail);
        }

        const reply = readReply(sent.data, { idPrefix: `${session.id}_r${round}` });
        if (!reply.ok) {
            return stop(session, 'error', reply.error, reply.detail);
        }

        /*
         * 没有工具调用 = 这一轮说完了。
         *
         * 正文可以是空的：学习只认工具产出，"没什么值得记的"本来就该什么都不写。
         * 空正文不塞进消息栈（空 assistant 消息在下一次请求里会被丢掉，白白多一条）。
         */
        if (reply.toolCalls.length === 0) {
            if (reply.content.trim()) {
                session.messages.push(assistantReply(reply.content));
                session.lastReply = reply.content;
            }

            session.stats.rounds += 1;
            record(session, { kind: 'assistant', chars: reply.content.length });
            return { ok: true, stopped: 'no_tool_calls', ...summary(session) };
        }

        const assistant = assistantReply(null, reply.toolCalls);
        session.messages.push(assistant);
        session.stats.sawTools = true;
        if (reply.content.trim()) {
            session.lastReply = reply.content;
        }
        record(session, { kind: 'assistant', toolCalls: assistant.tool_calls.length });

        /*
         * 遍历的是**归一化之后**的那份 tool_calls（不是 reply.toolCalls）：
         * 补 id、去重都发生在工厂里，工具结果拿到的 tool_call_id 因此不可能对不上。
         */
        let fatal = false;
        for (const call of assistant.tool_calls) {
            const out = await executeTool(
                session.tools,
                { id: call.id, name: call.function.name, arguments: call.function.arguments },
                session,
            );

            session.stats.toolCalls += 1;
            fatal = fatal || out.fatal;

            session.messages.push(toolResult(call.id, out.text));
            record(session, { kind: 'tool', name: call.function.name, ok: out.ok, fatal: out.fatal, text: out.text });
        }

        session.stats.rounds += 1;

        const check = assertProtocol(session.messages);
        if (!check.ok) {
            return stop(session, 'error', 'SESSION_PROTOCOL', check.reason);
        }

        if (fatal) {
            return stop(session, 'fatal', 'SESSION_TOOL_FATAL');
        }
    }

    return stop(session, 'rounds', 'SESSION_ROUND_LIMIT', `上限 ${cap} 轮`);
}

/**
 * 第五步：收尾。幂等。
 *
 * 只改内存状态、不清内容——调用方（斜杠命令、`/thrive session log`）还要读它。
 *
 * @param {object} session
 * @param {string} [reason] 收尾原因，只用于排查
 * @returns {object|null} 传进来的那个 session
 */
export function closeSession(session, reason = 'done') {
    if (!session) {
        return null;
    }
    if (session.state === 'closed') {
        return session;
    }

    // aborted / failed 是更有信息量的终态，不被 closed 覆盖
    if (session.state !== 'aborted' && session.state !== 'failed') {
        session.state = 'closed';
    }

    session.stats.ms = Date.now() - session.stats.startedAt;
    session.closedAs = String(reason);

    if (active === session) {
        active = null;
    }
    last = session;

    return session;
}

/* ------------------------------------------------------------ 组合体 */

/**
 * 跑一场完整的自检会话。给斜杠命令用。
 *
 * 五步串起来，处理互斥，兜住未预料的异常。**永远返回结果对象，不抛**。
 *
 * @param {{
 *   ctx: object,
 *   preset?: object|null,
 *   userMessage?: string|null,
 *   images?: string[]|null,
 *   maxRounds?: number|null,
 *   deps?: object|null,
 *   profileId?: string,
 * }} options
 * @returns {Promise<object>}
 */
export async function runSession({
    ctx,
    preset = null,
    userMessage = null,
    images = null,
    maxRounds = null,
    deps = null,
    tools = null,
    profileId = '',
} = {}) {
    if (active || starting) {
        return {
            ok: false,
            stopped: 'error',
            error: 'SESSION_BUSY',
            hint: hintFor('SESSION_BUSY'),
            rounds: 0,
            toolCalls: 0,
            sawTools: false,
            reply: '',
        };
    }

    // 体检要 await（惰性 import），这段窗口也必须在互斥里，否则连点两次会建出两场
    const opening = { cancelled: false };
    starting = opening;
    let opened;
    try {
        opened = await openSession({ ctx, deps, preset, maxRounds, tools, profileId });
    } finally {
        starting = null;
    }

    if (!opened.ok) {
        return {
            ok: false,
            stopped: 'error',
            error: opened.error,
            hint: opened.hint,
            rounds: 0,
            toolCalls: 0,
            sawTools: false,
            reply: '',
        };
    }

    const session = opened.session;
    active = session;

    try {
        if (opening.cancelled) {
            return stop(session, 'aborted', 'SESSION_ABORTED');
        }
        const prepared = applyPreset(session, preset);
        if (!prepared.ok) {
            return stop(session, 'error', prepared.error, prepared.detail);
        }

        const sent = sendUserMessage(session, userMessage ?? '', { images });
        if (!sent.ok) {
            return stop(session, 'error', 'SESSION_NO_MESSAGE', '开场白是空的');
        }

        const result = await runLoop(session, { maxRounds });
        console.debug(`${LOG} 会话结束 · ${describeResult(result)}`);
        return result;
    } catch (err) {
        console.error(`${LOG} 会话异常`, err);
        return stop(session, 'error', 'SESSION_CRASHED', err?.message ?? String(err));
    } finally {
        closeSession(session);
    }
}

/**
 * 中止正在跑的那一场。
 * @returns {boolean} 真的发出了中止
 */
export function abortActiveSession() {
    if (!active) {
        if (starting) {
            starting.cancelled = true;
            return true;
        }
        return false;
    }

    try {
        const reason = typeof DOMException === 'function'
            ? new DOMException('用户中止', 'AbortError')
            : undefined;
        if (reason) {
            active.abort.abort(reason);
        } else {
            active.abort.abort();
        }
    } catch (err) {
        console.warn(`${LOG} 中止会话失败`, err);
        return false;
    }

    return true;
}

/** 有没有正在跑的会话 */
export function isSessionRunning() {
    return Boolean(active || starting);
}

/* ------------------------------------------------------------ 观察 */

/**
 * 一行摘要，给斜杠命令的返回值用。
 * @param {object} result `runLoop` / `runSession` 的返回值
 * @returns {string}
 */
export function describeResult(result) {
    if (!result) {
        return '没有会话结果';
    }

    const rounds = Number(result.rounds) || 0;
    const toolCalls = Number(result.toolCalls) || 0;
    const chars = String(result.reply ?? '').trim().length;

    if (result.ok) {
        const tools = toolCalls > 0 ? `${toolCalls} 次工具调用` : '0 次工具调用（模型没有调用）';
        return `内部会话完成：${rounds} 轮 · ${tools} · 回复 ${chars} 字`;
    }

    const label = {
        rounds: '撞轮数上限',
        aborted: '已中止',
        fatal: '工具致命错误',
        error: '出错',
    }[result.stopped] ?? '未完成';

    return `内部会话未完成（${label}）：${result.error || '未知'} · ${result.hint || ''}`.trim();
}

/**
 * 打印整场会话。
 *
 * 默认只打摘要（role + 长度 / 工具名），因为会话内容很可能是用户的世界书原文，
 * 不该无缘无故留在控制台里。要看全文用 `/thrive session log`。
 *
 * @param {object|null} [session] 省略时打印最近一场
 * @param {{ full?: boolean }} [options]
 */
export function logTranscript(session = last, { full = false } = {}) {
    if (!session) {
        console.info(`${LOG} 还没有跑过内部会话`);
        return;
    }

    console.group(
        `${LOG} 会话 ${session.id} · ${session.state} · ${session.stats.rounds} 轮`
        + ` / ${session.stats.toolCalls} 次工具调用 · ${session.messages.length} 条消息`,
    );

    for (const message of session.messages) {
        console.log(`${label(message)}: ${full ? String(message.content ?? '') : preview(message)}`);
    }

    if (session.transcript.length > 0) {
        console.table(session.transcript);
    }

    console.groupEnd();
}

/* ------------------------------------------------------------------ 内部 */

function usable(session, ...states) {
    return Boolean(session) && states.includes(session.state);
}

/** 预设 run → 消息。角色到工厂的映射只在这里 */
function fromRun(run) {
    const text = String(run?.text ?? '');
    if (!text.trim()) {
        return null;
    }

    switch (run.role) {
        case 'system':
            return systemText(text);
        case 'user':
            return userText(text);
        case 'assistant':
            return assistantReply(text);
        default:
            return null;
    }
}

/**
 * 收一次失败。
 *
 * 终态在这里定：中止是 aborted，其余都算 failed。
 *
 * @returns {object} 与 `runLoop` 成功时同形的结果对象
 */
function stop(session, stopped, error, detail = '') {
    if (session) {
        session.state = stopped === 'aborted' ? 'aborted' : 'failed';
        session.lastError = { error, detail: String(detail ?? '') };
    }

    return {
        ok: false,
        stopped,
        error,
        hint: composeHint(error, detail),
        ...(session ? summary(session) : { rounds: 0, toolCalls: 0, sawTools: false, reply: '' }),
    };
}

function summary(session) {
    return {
        sessionId: session.id,
        rounds: session.stats.rounds,
        toolCalls: session.stats.toolCalls,
        sawTools: session.stats.sawTools,
        messageCount: session.messages.length,
        ms: Date.now() - session.stats.startedAt,
        reply: session.lastReply,
    };
}

/** 错误码的兜底 hint + 本次的具体细节 */
function composeHint(code, detail = '') {
    const base = hintFor(code);
    const extra = String(detail ?? '').trim();

    if (!extra) {
        return base;
    }
    return base ? `${base}（${extra}）` : extra;
}

function record(session, entry) {
    session.transcript.push({ round: session.stats.rounds + 1, ...entry });
}

function clampRounds(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return DEFAULT_ROUNDS;
    }
    return Math.min(MAX_ROUNDS, Math.max(1, Math.round(num)));
}

/**
 * 从 ST 设置里读上下文与轮数上限。
 *
 * `openai_max_context` 没加载时是 0 或 undefined，直接拿去比大小会让预算判定
 * 永远为假（NaN 参与比较），所以这里必须给出一个确定的数字。
 */
function readLimits(ctx, maxRounds) {
    const settings = ctx?.chatCompletionSettings ?? {};
    const context = Number(settings.openai_max_context);
    const recurse = Number(settings.tool_call_recurse_limit);

    const known = Number.isFinite(context) && context > 0;

    return {
        maxRounds: clampRounds(maxRounds ?? (Number.isFinite(recurse) && recurse > 0 ? recurse : DEFAULT_ROUNDS)),
        contextTokens: known ? context : FALLBACK_CONTEXT,
        fallbackContext: !known,
        timeoutMs: DEFAULT_TIMEOUT_MS,
    };
}

function label(message) {
    const id = message.tool_call_id ? `(${message.tool_call_id})` : '';
    return `${message.role}${id}`;
}

function preview(message) {
    if (message.tool_calls?.length) {
        return `→ ${message.tool_calls.map(call => call.function.name).join(', ')}`;
    }

    // 带图的消息：正文和"几张图"分开说，否则整条会打成一串 base64
    if (Array.isArray(message.content)) {
        const text = message.content
            .filter(part => part?.type === 'text')
            .map(part => String(part.text ?? '').replace(/\s+/g, ' ').trim())
            .join(' ');
        const images = message.content.filter(part => part?.type === 'image_url').length;
        const head = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        return [head, `${images} 张图`].filter(Boolean).join(' · ');
    }

    const text = String(message.content ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= 80) {
        return text;
    }
    return `${text.slice(0, 80)}…（${text.length} 字）`;
}
