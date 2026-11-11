/**
 * Thrive · 学习模式 —— 入口
 *
 * 当前架构（v0.33，ADR-050）：**对话与学习分离**。
 *
 *   聊天请求里没有插件提示词、也没有插件工具；学习在另一场独立会话里跑，
 *   会话带着提示词卡片编译出的预设、当前对话记录、以及那十个真实工具。
 *
 * 这个入口只做四件事：
 *   1. 初始化：设置、界面（设置页 / 徽章 / 浮动面板 / 三个独立窗口）、斜杠命令
 *   2. 判据：角色回复完之后评估"该不该学一次"，命中就异步起一场会话
 *   3. 事件：切对话时收拾正在跑的那一场、世界书 / 角色卡变化时重画界面
 *   4. 命令：`/thrive on|off|learn|stop|status|panel|compress|prompt`
 *
 * 历史（只留对现在还有约束力的）：
 *   · 工具的实现按"读得越少，能写的越少"分四级守卫（src/tools.js）
 *   · 世界书写入先落虚拟世界书，用户点保存才进真实世界书（src/draft.js，ADR-047）
 *   · 描述改动先暂存成 patch，面板里确认后才落盘（src/patch.js）
 *   · 一次性会话框架：独立消息栈 + 直连传输 + 会话私有工具（src/session*.js，ADR-049）
 */

import { getContext } from '../../../extensions.js';
import { evaluateAuto, describeTrigger } from './src/auto-learn.js';
import { requestCompressScan } from './src/compress.js';
import { clearLearningQueue, startLearning, stopLearning } from './src/learning.js';
import {
    ensureSettings,
    isChatAvailable,
    isEnabled,
    isLearningActive,
    resetReads,
    saveChat,
    setEnabled,
} from './src/store.js';
import {
    bindCompressRefresh,
    describeStatus,
    initBadge,
    initCompressPanel,
    initDraftWindow,
    initPanel,
    initPromptWindow,
    initSettingsPanel,
    initTeachWindow,
    openCompressPanel,
    openPanel,
    openPromptWindow,
    refreshBadgeOnly,
    refreshUI,
} from './src/ui.js';

const LOG = '[Thrive]';
const COMMAND_ACTIONS = ['on', 'off', 'learn', 'stop', 'status', 'panel', 'compress', 'prompt'];

/**
 * 现取 context。
 *
 * 不要缓存 getContext() 的返回值：切换聊天时 ST 会把 `chat_metadata` 整体替换成
 * 新对象（script.js: `chat_metadata = chatHeader?.chat_metadata ?? {}`），
 * 而 getContext() 返回的是一个持有该引用的字面量对象。缓存下来的 ctx 会一直
 * 指向旧对话的元数据，表现为"徽章显示的是上一个对话的状态"。
 */
function context() {
    return getContext();
}

async function init() {
    console.log(`${LOG} 启动 v0.36.0 · 目标内容拆描述/注入 · 规则共用 · 工具列表`);

    // 设置项必须最先补齐：后面所有读取都依赖默认值存在
    ensureSettings(context());

    await initSettingsPanel();
    await initBadge();
    initPanel();
    initCompressPanel();
    initDraftWindow();
    initPromptWindow();
    initTeachWindow();
    bindCompressRefresh();
    await initSlashCommand();
    bindEvents();

    refreshUI(context());

    /*
     * 首次检查延后一点：ST 启动时世界书列表还在陆续加载，太早扫会读到一半。
     * refreshUI 里已经排过一次（去抖 250ms），这里只是兜一个更晚的时机，
     * 两次结果一样时不会重画。
     */
    requestCompressScan(context(), 1200);
}

/* ---------------------------------------------------------------- 斜杠命令 */

/**
 * 注册 `/thrive ...`。
 *
 * 名字只用 `thrive` 这一个前缀，不和 ST 内置命令重名；没写动作时按 status 处理，
 * 因为"随手敲一下看现在什么状态"是最常见的用法。
 *
 * 注册失败不致命：ST 版本换了 slash-command 的导出路径时，扩展其余部分照常工作。
 * 所以这里用动态 import —— 静态 import 一个不存在的路径会让整个入口模块加载失败。
 */
async function initSlashCommand() {
    try {
        const [{ SlashCommandParser }, { SlashCommand }, { ARGUMENT_TYPE, SlashCommandArgument }] = await Promise.all([
            import('../../../slash-commands/SlashCommandParser.js'),
            import('../../../slash-commands/SlashCommand.js'),
            import('../../../slash-commands/SlashCommandArgument.js'),
        ]);

        if (typeof SlashCommandParser?.addCommandObject !== 'function'
            || typeof SlashCommand?.fromProps !== 'function') {
            console.warn(`${LOG} 拿不到 SlashCommand，斜杠命令未注册`);
            return;
        }

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'thrive',
            helpString: '学习模式：`/thrive on` 开启、`off` 关闭（都只作用于当前对话）、'
                + '`learn` 立刻学一次（不等判据）、`stop` 中止正在跑的那一场、'
                + '`compress` 打开压缩面板（超长条目与角色描述）、'
                + '`prompt` 打开提示词编辑器（预设卡片、顺序、角色、导入预设）、'
                + '`status` 看开关 / 判据 / 学习中 / 可写书 / 待确认、`panel` 打开浮动面板。'
                + '不写动作等于 `status`。',
            returns: '一行状态说明',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '动作',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: COMMAND_ACTIONS,
                }),
            ],
            callback: (_named, action) => runThriveCommand(action),
        }));
    } catch (err) {
        console.warn(`${LOG} 斜杠命令注册失败`, err);
    }
}

/**
 * 命令执行体。
 *
 * 每个分支都把话说完（做了什么 / 为什么没做），并且同时 toast + 返回：
 * 直接在输入框里敲命令时 ST 不展示返回值，只返回给 STscript 调用方（`/thrive status |`）。
 *
 * @param {string} [raw]
 * @returns {string}
 */
function runThriveCommand(raw) {
    const action = String(raw ?? '').trim().toLowerCase() || 'status';
    const ctx = context();
    const settings = ensureSettings(ctx);

    switch (action) {
        case 'on': {
            if (!isChatAvailable(ctx)) {
                return report('请先打开一个对话');
            }
            if (isEnabled(ctx)) {
                return report('这个对话本来就是开启状态');
            }

            setEnabled(ctx, true);
            refreshUI(ctx);
            return report(`学习模式已开启（只作用于当前对话）· ${describeRules(settings)}`);
        }

        case 'off': {
            if (!isEnabled(ctx)) {
                return report('这个对话本来就是关闭状态');
            }
            setEnabled(ctx, false);
            refreshUI(ctx);
            return report(isLearningActive()
                ? '学习模式已关闭；正在跑的那一场不受影响（要停就 `/thrive stop`）'
                : '学习模式已关闭（只作用于当前对话）');
        }

        case 'learn': {
            const started = startLearning(ctx, { reason: 'manual' });
            if (!started.ok) {
                return report(`没能开始学习：${started.hint}`);
            }

            // 排上队时没有 promise：那一场要等前面跑完，进度走事件广播
            started.promise?.catch(err => console.error(`${LOG} 学习异常`, err));
            return report(started.queued > 0
                ? `已排队（第 ${started.queued} 位）：前面那一场跑完接着学`
                : '学习已开始：在独立会话里跑，不会影响当前聊天；结束后另弹一条摘要');
        }

        case 'stop': {
            return report(stopLearning()
                ? '已发出中止：这一场与排队的那几场都停了；已经写进去的内容不会撤回'
                : '现在没有在跑的学习');
        }

        case 'panel': {
            openPanel(ctx);
            return report('面板已打开：学习模式开关在最上面');
        }

        /*
         * 压缩面板是独立窗口，和浮动面板互不遮挡——要处理超长内容时不必先把
         * 浮动面板收起来。它的数据每次打开都现扫，所以这里不做任何前置检查：
         * 没选可写书、读不到书，都会在面板里写清楚。
         */
        case 'compress': {
            if (!openCompressPanel(ctx)) {
                return report('压缩面板还没挂载，刷新页面再试');
            }
            return report('压缩面板已打开：超长条目与角色描述都在里面');
        }

        /*
         * 提示词编辑器也是独立窗口。它不需要对话：预设是一份跨对话的设置，
         * 在没有对话的分支里也能打开。
         */
        case 'prompt': {
            if (!openPromptWindow(ctx)) {
                return report('提示词窗口还没挂载，刷新页面再试');
            }
            return report('提示词编辑器已打开：预设卡片 / 顺序 / 角色 / 导入预设');
        }

        case 'status':
            return report(describeStatus(ctx));

        default:
            return report(`未知动作「${action}」：可用 ${COMMAND_ACTIONS.join(' / ')}`);
    }
}

/** 一条命令结果：先显示在界面上，再原样返回给 STscript */
function report(message) {
    if (globalThis.toastr?.info) {
        globalThis.toastr.info(message);
    } else {
        console.info(`${LOG} ${message}`);
    }
    return message;
}

/** 判据的一句话摘要，给 on 的回复用 */
function describeRules(settings) {
    const rules = [];
    const interval = Math.max(0, Math.floor(Number(settings.learnInterval) || 0));
    if (interval > 0) {
        rules.push(`每 ${interval} 条`);
    }
    if (String(settings.learnKeywords ?? '').trim()) {
        rules.push('关键词');
    }
    return rules.length ? `判据：${rules.join(' + ')}` : '还没配判据，开着也不会自动学（可以手动 `/thrive learn`）';
}

function bindEvents() {
    const ctx = context();
    const events = ctx.eventSource;
    const types = ctx.eventTypes ?? ctx.event_types;

    if (!events || !types) {
        console.warn(`${LOG} 拿不到 eventSource / eventTypes，聊天切换与自动学习会失效`);
        return;
    }

    /*
     * 状态是对话级的：切换聊天要重取状态。
     *
     * 正在跑的学习必须先停下：工具走的是"当前对话"（可写书、读取登记都在
     * chat_metadata 上），跑到一半换场就可能把这一场的内容写进另一个角色。
     */
    events.on(types.CHAT_CHANGED, () => {
        /*
         * 排队的那几场写的是上一个对话的世界书，换场之后跑它等于把内容塞到另一个
         * 角色身上。出队时本来也会按 chatId 丢掉，这里直接清空是为了让面板立刻
         * 不显示旧对话的"排队 N"。
         */
        const dropped = clearLearningQueue();
        if (dropped > 0) {
            console.info(`${LOG} 切换对话，丢掉 ${dropped} 场排队的任务`);
        }

        if (isLearningActive()) {
            console.info(`${LOG} 切换对话，正在跑的学习已中止`);
            stopLearning();
        }

        const next = context();
        refreshUI(next);
    });

    // 用户发一条消息 = 新一轮：作废上一场的读取登记，学习要重新读才能写
    events.on(types.MESSAGE_SENT, () => {
        const next = context();
        resetReads(next);
        refreshBadgeOnly(next);
    });

    /*
     * 角色回复落盘 = 这一轮结束了，是判断"该不该学一次"的时候。
     *
     * 只在这里判（不在 MESSAGE_SENT）：学习是独立会话，不必抢在生成之前；
     * 放在回复之后，既不会和正在生成的聊天抢后端，也保证这一轮两边都已经在记录里。
     */
    if (types.MESSAGE_RECEIVED) {
        events.on(types.MESSAGE_RECEIVED, (messageId, type) => {
            // 开场白不是"这一轮结束了"
            if (type === 'first_message') {
                return;
            }

            const next = context();
            const index = Number.isInteger(messageId) ? messageId : next.chat?.length - 1;
            const message = next.chat?.[index];

            // 工具日志这类系统消息、以及用户消息都不算"角色回复"
            if (!message || message.is_system || message.is_user) {
                return;
            }

            const evaluation = evaluateAuto(next, 'assistant');
            if (evaluation.fire) {
                const started = startLearning(next, { reason: evaluation.reason });

                if (started.ok) {
                    console.info(started.queued > 0
                        ? `${LOG} 自动学习已排队（第 ${started.queued} 位，${describeTrigger(evaluation)}）`
                        : `${LOG} 自动学习已触发（${describeTrigger(evaluation)}）`);
                    started.promise?.catch(err => console.error(`${LOG} 学习异常`, err));
                } else {
                    console.warn(`${LOG} 没能开始自动学习：${started.hint}`);
                }
            } else {
                // 基线可能刚被对齐（第一次评估 / 删过消息），落一次盘省得下次重算
                saveChat(next);
            }

            refreshBadgeOnly(next);

            /*
             * 这一轮可能刚写进一条长条目（也可能刚把一条写超了）。重扫一次，
             * 好在下一轮开始之前就把"该压缩了"标出来。
             */
            requestCompressScan(next, 500);
        });
    }

    // 用户在世界书面板里勾选/取消勾选，会改变"写进去的条目会不会生效"，
    // 面板上的"未激活"提示必须跟着变
    if (types.WORLDINFO_SETTINGS_UPDATED) {
        events.on(types.WORLDINFO_SETTINGS_UPDATED, () => {
            refreshUI(context());
        });
    }

    /*
     * 角色卡被保存（角色编辑器点了保存、世界书页签改了绑定）。
     * 这是"面板说已写入、编辑器里却没有"的关键时机：编辑器提交的是表单里的旧文本，
     * 保存会把插件刚写进去的描述盖回去。这里立刻重算一次，好把漂移状态说出来。
     */
    if (types.CHARACTER_EDITED) {
        events.on(types.CHARACTER_EDITED, () => {
            refreshUI(context());
        });
    }
}

jQuery(async () => {
    try {
        await init();
    } catch (err) {
        console.error(`${LOG} 初始化失败`, err);
    }
});
