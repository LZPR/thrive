/**
 * Thrive · 学习模式 —— 入口
 *
 * 当前进度（Step 17）：
 *   1. 扩展能被 ST 加载
 *   2. 对话级开关（chat_metadata.thrive.enabled）+ 输入框旁的方块徽章（只开关浮动面板，
 *      主动 / 被动两个开关在面板里，待确认改动在徽章角上带计数）
 *   3. 开启时注入学习块，关闭时彻底清空
 *   4. 工具：世界书 lore_list / lore_read / lore_add / lore_append / lore_replace /
 *      lore_rewrite，角色描述 desc_read / desc_append / desc_replace / desc_rewrite
 *   5. 描述改动先暂存成 patch；世界书写入留快照，面板里可恢复
 *   6. 工具日志：当轮压成一行纯文本，下一条消息起移出上下文
 *   7. 环境诊断（设置页顶部 + 徽章置灰）+ `/thrive on|off|passive|once|status|panel`
 *   8. 被动学习：条数 / 关键词任一命中就"借"一轮，回复完自动关闭（src/passive.js）
 *   9. 超长时的压缩指令可配（src/compact.js）
 *  10. 字数上限 / 返回条数 / 记录槽位 / 日志长度等数值全部可配（src/limits.js）
 *  11. 设置项按用途分成六组折叠，默认全收起（settings.html + style.css）
 *  12. 界面按块拆分：src/ui/ 下一块界面一个文件，src/ui.js 只做门面（src/ui/*.js）
 *  13. 提示词卡片：拖动排序、按分界线分头部/尾部注入、弹窗编辑（src/prompt-order.js）
 *  14. 工具常驻：开关模式不再改变 tools 数组，改用「工具指令」的宏说明哪些不可用（src/tool-state.js）
 */

import { getContext } from '../../../extensions.js';
import { syncFromContext } from './src/prompt.js';
import {
    clearPending,
    ensureSettings,
    isChatAvailable,
    isEnabled,
    isPending,
    markPendingUsed,
    resetReads,
    saveChat,
    setEnabled,
} from './src/store.js';
import { armManual, consumePending, evaluatePassive } from './src/passive.js';
import { registerTools } from './src/tools.js';
import { compressToolTrace, pruneToolTraces } from './src/trace.js';
import { diagnoseEnvironment, formatDiagnosis } from './src/diagnostics.js';
import {
    describeStatus,
    initBadge,
    initPanel,
    initSettingsPanel,
    openPanel,
    refreshBadgeOnly,
    refreshUI,
} from './src/ui.js';

const LOG = '[Thrive]';
const COMMAND_ACTIONS = ['on', 'off', 'status', 'panel', 'passive', 'once'];

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
    console.log(`${LOG} 启动 v0.20 · 工具常驻 + 提示词卡片`);

    // 设置项必须最先补齐：后面所有读取都依赖默认值存在
    ensureSettings(context());

    // 工具只注册一次，之后靠 shouldRegister 门控（ADR-001）
    registerTools(context());

    await initSettingsPanel();
    await initBadge();
    initPanel();
    await initSlashCommand();
    bindEvents();

    const ctx = context();
    syncFromContext(ctx);
    refreshUI(ctx);
}

/* ---------------------------------------------------------------- 斜杠命令 */

/**
 * 注册 `/thrive on|off|status|panel`。
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
                + '`passive` 切换被动学习、`once` 让下一轮临时学一次、'
                + '`status` 看主动/被动/模块/可写书/待确认、`panel` 打开浮动面板（模式开关 + 记录）。不写动作等于 `status`。',
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
            const diag = diagnoseEnvironment(ctx);
            if (!diag.ok) {
                return report(`工具调用不可用，开了也没有工具可用：${formatDiagnosis(diag)}`);
            }
            if (settings.moduleWorldbook === false && settings.moduleDescription === false) {
                return report('两个模块都关着，请先在扩展设置里开启至少一个');
            }
            if (!isChatAvailable(ctx)) {
                return report('请先打开一个对话');
            }
            if (isEnabled(ctx)) {
                return report('这个对话本来就是开启状态');
            }

            setEnabled(ctx, true);
            syncFromContext(ctx);
            refreshUI(ctx);
            return report('学习模式已开启（只作用于当前对话）');
        }

        case 'off': {
            if (!isEnabled(ctx)) {
                return report('这个对话本来就是关闭状态');
            }
            setEnabled(ctx, false);
            syncFromContext(ctx);
            refreshUI(ctx);
            return report('学习模式已关闭（只作用于当前对话）');
        }

        case 'panel': {
            openPanel(ctx);
            return report('面板已打开：模式开关在最上面，记录在下面');
        }

        /*
         * 被动学习是全局开关（判据也在设置页里配），所以这里不区分对话；
         * 但已经挂上的待学习是对话级的，关掉时一并清掉。
         */
        case 'passive': {
            if (!isChatAvailable(ctx)) {
                return report('请先打开一个对话');
            }

            const diag = diagnoseEnvironment(ctx);
            if (!diag.ok) {
                return report(`工具调用不可用：${formatDiagnosis(diag)}`);
            }

            settings.passiveEnabled = settings.passiveEnabled !== true;
            ctx.saveSettingsDebounced?.();

            if (!settings.passiveEnabled && clearPending(ctx)) {
                saveChat(ctx);
            }

            syncFromContext(ctx);
            refreshUI(ctx);

            const hasRule = Number(settings.passiveInterval) > 0 || String(settings.passiveKeywords).trim();
            return report(settings.passiveEnabled
                ? (hasRule
                    ? '被动学习已开启（命中判据后下一轮临时学一次）'
                    : '被动学习已开启，但还没配间隔或关键词，不会触发')
                : '被动学习已关闭（主动开关不受影响）');
        }

        case 'once': {
            if (!isChatAvailable(ctx)) {
                return report('请先打开一个对话');
            }

            if (settings.moduleWorldbook === false && settings.moduleDescription === false) {
                return report('两个模块都关着，请先在扩展设置里开启至少一个');
            }

            const diag = diagnoseEnvironment(ctx);
            if (!diag.ok) {
                return report(`工具调用不可用：${formatDiagnosis(diag)}`);
            }
            if (isPending(ctx)) {
                return report('已经有一次待学习了，下一条消息就会用掉它');
            }
            if (!armManual(ctx)) {
                return report('没能挂上待学习');
            }

            saveChat(ctx);
            syncFromContext(ctx);
            refreshUI(ctx);
            return report('已挂上：下一条消息会临时开启学习模式，回复结束后自动关闭');
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

function bindEvents() {
    const ctx = context();
    const events = ctx.eventSource;
    const types = ctx.eventTypes ?? ctx.event_types;

    if (!events || !types) {
        console.warn(`${LOG} 拿不到 eventSource / eventTypes，聊天切换与注入同步会失效`);
        return;
    }

    // 状态是对话级的：切换聊天要重取状态，并立刻重算注入
    events.on(types.CHAT_CHANGED, () => {
        const next = context();
        syncFromContext(next);
        refreshUI(next);
    });

    // 以下两个时机都紧跟"构建提示词之前"，都调用一次；函数幂等，谁先到都无所谓。
    // MESSAGE_SENT 在消息入栈后、Generate 之前触发，作为主时机；
    // GENERATION_STARTED 兜住"重新生成""续写"这类不经过 MESSAGE_SENT 的路径。
    events.on(types.MESSAGE_SENT, () => {
        const next = context();

        // 先清日志：此刻刚发的用户消息已在栈尾，它之前的就是"上一轮及更早"。
        // 必须在构建提示词之前改完，否则这一轮请求里还带着旧日志
        if (ensureSettings(next).dropTraces !== false) {
            const pruned = pruneToolTraces(next);
            if (pruned > 0) {
                // MESSAGE_SENT 之前 ST 已经存过一次盘，改动得自己落盘
                saveChat(next);
                console.debug(`${LOG} 已把 ${pruned} 条工具日志移出上下文`);
            }
        }

        /*
         * 被动学习：用户刚发的这条消息本身可能就命中了关键词。
         *
         * 放在这里（而不是等角色回复完）是因为它必须赶在构建提示词之前：
         * 用户说"记住，北境在南边"，想记的时候就是这一轮，不是下一轮。
         */
        if (evaluatePassive(next, 'user').fired) {
            saveChat(next);
        }

        // 用户发一条消息 = 新一轮：作废上一轮的读取登记，写入必须重新先读
        resetReads(next);
        syncFromContext(next);
        refreshBadgeOnly(next);
    });

    events.on(types.GENERATION_STARTED, (_type, _options, dryRun) => {
        // dryRun 是摘要、翻译之类的静默生成，不该塞学习块
        if (dryRun) {
            return;
        }

        const next = context();
        // 记一笔"这次待学习真的进了生成"：结算时靠它区分真学习轮与静默生成
        if (isPending(next)) {
            markPendingUsed(next);
        }
        syncFromContext(next);
    });

    /*
     * 角色回复落盘 = 这一轮学完了。
     *
     * 结算放在这里而不是 GENERATION_ENDED：那个事件在"点了停止"时也会发，
     * 生成被中断时其实什么都没学到，把待学习扣掉等于白白浪费一次。
     * 而 MESSAGE_RECEIVED 只在真的有一条角色消息入栈时才有。
     */
    if (types.MESSAGE_RECEIVED) {
        events.on(types.MESSAGE_RECEIVED, (messageId, type) => {
            // 开场白不是"这一轮学完了"
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

            // 先结算：这一轮学完了，立刻关掉临时学习
            const consumed = consumePending(next);
            // 再判断要不要挂下一次（关键词出现在角色回复里同样算命中）
            const evaluation = evaluatePassive(next, 'assistant');

            if (consumed || evaluation.fired) {
                saveChat(next);
                syncFromContext(next);
            }
            refreshBadgeOnly(next);
        });
    }

    // 工具调用刚产生、还没渲染：此刻改写 mes，addOneMessage 用到的就是新文本
    if (types.TOOL_CALLS_PERFORMED) {
        events.on(types.TOOL_CALLS_PERFORMED, invocations => {
            try {
                const next = context();
                if (!compressToolTrace(next, invocations, ensureSettings(next))) {
                    return;
                }
                console.debug(`${LOG} 工具日志已压缩`, invocations.map(item => item?.name));
            } catch (err) {
                // 压不压得动都不该影响这一轮生成：真出错就退回 ST 原生日志
                console.warn(`${LOG} 工具日志压缩失败`, err);
            }
        });
    }

    // 用户在世界书面板里勾选/取消勾选，会改变"写进去的条目会不会生效"，
    // 面板上的"未激活"提示必须跟着变，否则它会一直停在旧状态
    if (types.WORLDINFO_SETTINGS_UPDATED) {
        events.on(types.WORLDINFO_SETTINGS_UPDATED, () => {
            refreshUI(context());
        });
    }

    /*
     * 角色卡被保存（角色编辑器点了保存、世界书页签改了绑定）。
     * 这是"面板说已写入、编辑器里却没有"的关键时机：编辑器提交的是表单里的旧文本，
     * 保存会把插件刚写进去的描述盖回去。这里立刻重算一次，面板好把漂移状态说出来。
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
