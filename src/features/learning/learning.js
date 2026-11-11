/**
 * learning.js · 触发一次学习
 *
 * 学习的全部流程都在这里，而且**不在聊天轮次里**：
 *
 *   1. 把当前对话记录合并成一条"目标内容"（超出字数上限时从最早的消息往前截）
 *   2. 用提示词卡片编译出预设（目标内容 + 自建提示词）
 *   3. 另起一场会话，工具是那十个真实的世界书 / 角色描述工具
 *   4. 结束后把结果写回对话状态（上次学习、基线），聊天里一个字都不加
 *
 * 目标内容有两个来源：对话记录，或者用户自己写的一段话（"教授"）。后者跳过
 * 对话、也不记基线——教一次不代表这一段聊天已经被学过了。
 *
 * 触发是异步的：调用方拿到 `{ ok, promise }` 就走，不必等它跑完。这也是"对话与
 * 学习分离"的实际含义——模型在另一场会话里工作，用户继续聊天。
 *
 * 三条硬约定：
 *   - 同时只允许一场（session.js 有互斥，这里提前判一次，好给出人话）
 *   - 切换对话由 index.js 直接中止会话：工具走的是"当前对话"，跑到一半换了场
 *     就可能写进另一个角色身上
 *   - 结果永远以摘要形式落盘（几轮、几次工具、成功与否），不存会话全文
 */

import { hintFor } from '../../shared/diagnostics.js';
import { notifyLearning } from '../../shared/events.js';
import { TRIGGER, intervalProgress, lastRound, parseKeywords, countMessages, visibleMessages } from './auto-learn.js';
import { readLimits } from '../../core/limits.js';
import { buildPreset, getLearningMessage } from '../prompts/prompt.js';
import { abortActiveSession, isSessionRunning, runSession } from '../session/session.js';
import { createSessionTools } from '../session/session-tools.js';
import {
    beginLearn,
    ensureSettings,
    finishLearn,
    getLastLearnRun,
    getLearningRunning,
    isChatAvailable,
    isEnabled,
    markLearningRunning,
    resetReads,
    saveChat,
} from '../settings/index.js';
import { fnv1a } from '../../shared/util.js';

const LOG = '[Thrive]';

/** 单条消息最多带多少字。再长的段落对"提炼设定"没有额外价值，只会挤掉别的消息 */
const MAX_ONE_MESSAGE = 4000;

/** 截断时至少给最新那一条留这么多字，否则目标内容可能是空的 */
const MIN_KEEP = 200;

/** 教授时最多写多少字。这不是对话记录，是"我要教的这件事"，超过这个量该拆成几次 */
export const TEACH_MAX_CHARS = 6000;

/** 一次最多带几张图。再多的注意力摊薄，图之间互相干扰 */
export const TEACH_MAX_IMAGES = 4;

/**
 * 当前对话记录 → 目标内容。
 *
 * 合并成一段纯文本（`名字：内容`，空行分隔），因为目标内容在预设里是**一条消息**：
 * 模型要看到的是一个整体，而不是几十条它以为是"正在进行的对话"的消息。
 * 系统消息（工具日志之类）不算，它们不是谁说过的话。
 *
 * 超出字数上限时从最早的消息往前丢，并在开头说明丢了多少——让模型知道自己看的
 * 是后半段，不要把"没看到"当成"没发生过"。
 *
 * @param {object} ctx
 * @param {{ limitChars?: number }} [options]
 * @returns {{ text: string, count: number, omitted: number, chars: number }}
 */
export function buildChatTarget(ctx, { limitChars = 6000 } = {}) {
    const cap = Math.max(MIN_KEEP, Math.round(Number(limitChars) || 6000));
    const nameUser = String(ctx?.name1 ?? '').trim() || '用户';
    const nameChar = String(ctx?.name2 ?? '').trim() || '角色';
    const messages = visibleMessages(ctx);

    const lines = [];
    let used = 0;
    let omitted = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const text = String(message.mes ?? '').trim();
        if (!text) {
            continue;
        }

        const who = message.is_user ? nameUser : nameChar;
        const body = text.length > MAX_ONE_MESSAGE
            ? `${text.slice(0, MAX_ONE_MESSAGE)}…（后略）`
            : text;
        const line = `${who}：${body}`;
        const remain = cap - used;

        if (line.length > remain) {
            // 最新那一条总要留一点：否则可能一条都放不进去
            if (lines.length === 0 && remain >= MIN_KEEP) {
                lines.push(`${line.slice(0, remain)}…（后略）`);
                used = cap;
            }
            omitted = i + 1;
            break;
        }

        lines.push(line);
        used += line.length + 2;

        if (used >= cap) {
            omitted = i;
            break;
        }
    }

    lines.reverse();

    const head = omitted > 0 ? `（更早的 ${omitted} 条消息没有包含）` : '';
    return {
        text: [head, ...lines].filter(Boolean).join('\n\n'),
        count: lines.length,
        omitted,
        chars: used,
    };
}

/**
 * 目标内容的另一种来源：用户自己写的一段话（+ 若干张图）。
 *
 * 这是"教授"：跳过对话记录，直接告诉模型某个东西是什么、某个人物怎么样。
 * 与对话对应的那套东西（基线、轮数进度、这一轮用户消息的哈希）一概不碰——
 * 教一次不等于"这一段的聊天已经被学过了"，下次该按条数触发时还是要触发。
 *
 * 图不进预设（预设是纯文本的 run 列表），而是挂在开场白那条 user 消息上；
 * 目标内容里留一句"图在下面那条消息"，否则模型只看到一段话说"这是个角色"，
 * 完全不知道还有图可看。
 *
 * @param {{ text?: string, images?: string[] }|null} teach
 * @returns {{ ok: true, text: string, images: string[] } | { ok: false, error: string, hint: string }}
 */
export function buildTeachTarget(teach = null) {
    const raw = String(teach?.text ?? '').trim();
    const images = (Array.isArray(teach?.images) ? teach.images : [])
        .map(url => String(url ?? '').trim())
        .filter(url => url.startsWith('data:image/'))
        .slice(0, TEACH_MAX_IMAGES);

    if (!raw && images.length === 0) {
        return { ok: false, error: 'TEACH_EMPTY', hint: '写一句要教的东西，或者附一张图。' };
    }

    const body = raw.length > TEACH_MAX_CHARS ? raw.slice(0, TEACH_MAX_CHARS) : raw;
    const text = body
        || '（这次没有文字，材料就是下面这条消息里的图片。）';
    const note = images.length > 0 ? `\n\n（附了 ${images.length} 张图，在下面这条消息里。）` : '';

    return { ok: true, text: `${text}${note}`, images };
}

/**
 * 一次最多排多少场。
 *
 * 学习本身有判据兜着，这个上限只防"手动连点"与"关键词连续命中"把队排到天边。
 * 到了上限就不再收，而不是静默丢掉最新的——用户至少知道刚才那一下没生效。
 */
export const MAX_QUEUE = 6;

/**
 * 等待中的任务，**只活在内存里**（ADR-052）。
 *
 * 不落盘：排队是"我马上还要学一次"，进程重启后重放它没有意义，反而可能把旧内容
 * 当成新任务再写一遍。每个任务带着它所属的 `chatId`，切换对话时整队清掉。
 *
 * 项的形状：`{ reason, teach: { text, images }|null, chatId, at, ctx }`
 */
const queue = [];

/** 正在从队列里取下一场：防止"自然结束"与"手动停止"同时驱动一次出队 */
let pumping = false;

/**
 * 现在排队等着的任务（给面板与 `/thrive status` 看）。
 * @returns {Array<{ reason: string, teach: object|null, chatId: string, at: number }>}
 */
export function getLearningQueue() {
    return queue.map(({ ctx, ...rest }) => ({ ...rest }));
}

/**
 * 清空队列。切换对话时调用：排队的任务写的是"那个对话"的世界书，换场就没意义了。
 * @returns {number} 丢掉了几场
 */
export function clearLearningQueue() {
    const dropped = queue.length;
    queue.length = 0;
    return dropped;
}

/**
 * 开始一次学习。同步做完所有检查，跑起来之后立刻返回。
 *
 * 两种目标来源共用同一条链路：
 *   · 默认：当前对话记录（`buildChatTarget`），走过判据、记基线
 *   · `teach`：用户自己写的一段话 + 可选图片（`buildTeachTarget`），不记基线
 *
 * **同时只跑一场，其余排队**（ADR-052）。已经有会话在跑时，这一场进队列并立刻返回
 * `{ ok: true, queued: N }`——没有 promise，进度靠 `LEARNING_EVENT` 广播。
 *
 * @param {object} ctx 现取的 context
 * @param {{ reason?: string, teach?: { text?: string, images?: string[] }|null }} [options]
 * @returns {{ ok: true, promise: Promise<object>, queued: 0 }
 *          | { ok: true, queued: number }
 *          | { ok: false, error: string, hint: string }}
 */
export function startLearning(ctx, { reason = 'manual', teach = null } = {}) {
    if (!isChatAvailable(ctx)) {
        return { ok: false, error: 'NO_CHAT', hint: '请先打开一个对话。' };
    }

    // 教授的内容在入队时就定型：它就是用户此刻写下的那段话，不该等轮到它再说
    const taught = teach ? buildTeachTarget(teach) : null;
    if (taught && !taught.ok) {
        return taught;
    }

    const task = {
        reason: taught ? TRIGGER.TEACH : reason,
        teach: taught ? { text: taught.text, images: taught.images } : null,
        chatId: readChatId(ctx),
        at: Date.now(),
        ctx,
    };

    if (isSessionRunning()) {
        if (queue.length >= MAX_QUEUE) {
            return { ok: false, error: 'SESSION_QUEUE_FULL', hint: hintFor('SESSION_QUEUE_FULL') };
        }

        queue.push(task);
        console.info(`${LOG} 已排队（第 ${queue.length} 位，${describeQueueItem(task.reason)}）`);
        notifyLearning({ running: true, reason: getLearningRunning()?.reason ?? '', queued: queue.length });
        return { ok: true, queued: queue.length };
    }

    return launch(ctx, task);
}

/**
 * 真正开一场。同步部分（读目标、编预设、记基线）在这里，异步部分交给 `runLearning`。
 *
 * 会话结束后**一定要**再调一次 `pump()`：排队的那几场就是靠这一行接着往下走的。
 *
 * @param {object} ctx
 * @param {{ reason: string, teach: { text: string, images: string[] }|null, chatId: string, at: number }} task
 * @returns {{ ok: true, promise: Promise<object>, queued: 0 } | { ok: false, error: string, hint: string }}
 */
function launch(ctx, task) {
    const plan = prepare(ctx, task);
    if (!plan.ok) {
        return plan;
    }

    // 跑完（不管成没成）都去看一眼队列：排队的那几场就是靠这一行接着往下走的
    const promise = runLearning(ctx, plan).finally(() => pump());

    return { ok: true, promise, queued: 0 };
}

/**
 * 同步准备：目标内容 → 预设 → 基线与运行标记。
 *
 * 教授不走 `beginLearn`：它读的不是对话记录，记了基线等于把这一段聊天标记成
 * "已经学过"，而实际上一句都没看过。
 *
 * @param {object} ctx
 * @param {{ reason: string, teach: { text: string, images: string[] }|null }} task
 * @returns {object}
 */
function prepare(ctx, task) {
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);
    const target = task.teach
        ? task.teach.text
        : buildChatTarget(ctx, { limitChars: limits.learnHistoryChars }).text;

    if (!target.trim()) {
        return { ok: false, error: 'NO_TARGET', hint: '这个对话还没有可学的内容（没有可见消息）。' };
    }

    const preset = buildPreset(settings, { target });
    if (preset.runs.length === 0) {
        return {
            ok: false,
            error: 'SESSION_NO_PRESET',
            hint: '预设是空的：目标内容没有内容可发，描述行与自建提示词也都被停用了。',
        };
    }

    if (!task.teach) {
        /*
         * 基线与哈希在**开始前**就写：跑到一半又来了新消息时，那几条不算进"已经学过的
         * 那一段"，下一轮会重新看到它们。落盘在这里做一次，结束后再存一次结果。
         */
        const round = lastRound(ctx);
        beginLearn(ctx, {
            total: countMessages(ctx),
            hash: round.user ? fnv1a(round.user) : '',
        });
        // 读取登记是"这一轮读过什么"：学习是新一轮，必须重新读才能写
        resetReads(ctx);
        saveChat(ctx);
    }

    markLearningRunning({ reason: task.reason });
    notifyLearning({ running: true, reason: task.reason, queued: queue.length });

    return {
        ok: true,
        reason: task.reason,
        settings,
        limits,
        preset,
        images: task.teach ? task.teach.images : null,
        // 连接配置在这时候读一次就定下来：一场会话从头到尾只走一条路
        profileId: String(settings.connectionProfile ?? ''),
    };
}

/**
 * 从队列里取下一场。只有"没有会话在跑"时才会真的动手。
 *
 * 属于别的对话的任务直接丢掉：它写的是那个对话的世界书，换场之后跑它等于把内容
 * 塞到另一个角色身上。
 */
function pump() {
    if (pumping || isSessionRunning()) {
        return;
    }

    pumping = true;
    try {
        while (queue.length > 0) {
            const task = queue.shift();

            if (!isChatAvailable(task.ctx) || readChatId(task.ctx) !== task.chatId) {
                console.info(`${LOG} 排队的任务已不属于当前对话，丢掉（${describeQueueItem(task.reason)}）`);
                continue;
            }

            const started = launch(task.ctx, task);
            if (started.ok) {
                return;
            }

            console.warn(`${LOG} 排队的学习没能开始：${started.hint}`);
            // 排到队又要报一句：用户看不到控制台。摘要形状与跑完一场时一致
            notifyLearning({
                running: false,
                reason: task.reason,
                result: { ok: false, stopped: 'error', reason: task.reason, error: started.error, hint: started.hint, rounds: 0, toolCalls: 0 },
            });
        }
    } finally {
        pumping = false;
    }
}

/** 队列项的短说明，给控制台与面板用 */
function describeQueueItem(reason) {
    return reason === TRIGGER.TEACH ? '教授' : '学这段对话';
}

/** 当前对话的 id；拿不到时返回空串（比较时自然不相等，任务会被丢掉） */
function readChatId(ctx) {
    try {
        return String(ctx?.getCurrentChatId?.() ?? '');
    } catch {
        return '';
    }
}

/**
 * 跑完一场，把结果写回状态。**永不 throw**。
 *
 * @param {object} ctx
 * @param {{ reason: string, settings: object, limits: object, preset: object, images?: string[]|null, profileId?: string }} plan
 * @returns {Promise<object>} 摘要（同时已经写进对话状态）
 */
async function runLearning(ctx, { reason, settings, limits, preset, images = null, profileId = '' }) {
    const attached = Array.isArray(images) ? images : [];
    let result;

    try {
        result = await runSession({
            ctx,
            preset: { id: 'learn', name: '学习', runs: preset.runs },
            userMessage: getLearningMessage(settings),
            images: attached,
            maxRounds: limits.learnRounds,
            tools: createSessionTools(),
            profileId,
        });
    } catch (err) {
        // runSession 自己会兜住异常；到这里说明是它之外的东西炸了
        console.error(`${LOG} 学习会话异常`, err);
        result = { ok: false, stopped: 'error', error: 'SESSION_CRASHED', hint: String(err?.message ?? err), rounds: 0, toolCalls: 0 };
    }

    const summary = {
        ok: result?.ok === true,
        stopped: String(result?.stopped ?? ''),
        reason,
        rounds: Number(result?.rounds) || 0,
        toolCalls: Number(result?.toolCalls) || 0,
        images: attached.length,
        chars: String(result?.reply ?? '').trim().length,
        ms: Number(result?.ms) || 0,
        error: String(result?.error ?? ''),
        hint: String(result?.hint ?? ''),
    };

    markLearningRunning(null);
    finishLearn(ctx, summary);
    saveChat(ctx);

    console.debug(`${LOG} 学习结束 · ${describeLearnRun(summary)}`);
    notifyLearning({ running: false, reason, result: summary });

    return summary;
}

/**
 * 中止正在跑的那一场（`/thrive stop`、切换对话时用）。
 *
 * **连排队的一起停**：只停当前那一场的话，`pump()` 会立刻开下一场，用户按的
 * "停止"看起来就像没生效——屏幕上还在"学习中"，只是换了个任务。
 *
 * @returns {boolean} 有没有一场在跑（队列单独被清空时也返回 false）
 */
export function stopLearning() {
    clearLearningQueue();
    return abortActiveSession();
}

/** 有没有一场学习正在跑 */
export function isLearningRunning() {
    return Boolean(getLearningRunning());
}

/**
 * 面板与徽章要的一份状态。
 *
 * @param {object} ctx
 * @param {object} settings
 * @returns {{
 *   enabled: boolean, running: object|null, last: object|null,
 *   interval: number, since: number, remaining: number, keywordCount: number,
 * }}
 */
export function getLearningView(ctx, settings) {
    const progress = intervalProgress(ctx, settings);
    const chatId = readChatId(ctx);

    return {
        enabled: isEnabled(ctx),
        running: getLearningRunning(),
        last: getLastLearnRun(ctx),
        interval: progress.interval,
        since: progress.since,
        remaining: progress.remaining,
        keywordCount: parseKeywords(settings.learnKeywords).length,
        // 只数属于这个对话的：别的对话的任务出队时会被丢掉，没有理由显示在这儿
        queued: queue.filter(item => item.chatId === chatId).length,
    };
}

/**
 * 一次结果的摘要，给面板与 toast 用。只说结果，不解释过程。
 * @param {object|null} run
 * @returns {string}
 */
export function describeLearnRun(run) {
    if (!run) {
        return '还没学过';
    }

    // 教授与"学这一段聊天"是两件事，摘要的开头就该分开
    const lead = run.reason === TRIGGER.TEACH ? '上次教授' : '上次学习';

    if (!run.ok) {
        const label = run.stopped === 'rounds'
            ? '撞到轮数上限'
            : run.stopped === 'aborted'
                ? '已中止'
                : '未完成';
        const why = String(run.hint || run.error || '').trim();
        return `${lead}${label}${why ? `：${why}` : ''}`;
    }

    if (run.toolCalls === 0) {
        return `${lead}：没有调用工具（没有值得记的内容）`;
    }

    const rounds = run.rounds > 0 ? ` · ${run.rounds} 轮` : '';
    return `${lead}：${run.toolCalls} 次工具调用${rounds}`;
}
