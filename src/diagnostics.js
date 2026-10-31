/**
 * diagnostics.js · 环境诊断 + 错误文案目录
 *
 * 诊断只回答一件事：为什么工具没生效、该去哪改。
 *
 * 结论一律以 `ctx.isToolCallingSupported()` 为准（ADR-020）。只有它返回 false 时
 * 才去读 `oai_settings` 的内部字段细分原因——这是"帮用户定位"的补充信息，
 * 不是第二份可用性判定。任何一步读不到就降级成"判断不了"，不抛错：
 * ST 升级改了字段名时，诊断区不该把整个设置面板带崩。
 */

/** 细分原因的代号。`OK` 之外都表示工具当前不可用。 */
export const DIAG_CODES = Object.freeze({
    OK: 'OK',
    /** 判断不了：ST 没暴露接口，或读内部字段时出错 */
    UNKNOWN: 'UNKNOWN',
    /** 不是 chat completion 后端 */
    TEXT_COMPLETION: 'TEXT_COMPLETION',
    /** 函数调用开关没开 */
    FUNCTION_CALLING: 'FUNCTION_CALLING',
    /** 提示词后处理会移除工具消息 */
    POST_PROCESSING: 'POST_PROCESSING',
    /** 设置都对，但模型/来源不支持 tools */
    MODEL: 'MODEL',
});

/**
 * ST 1.19 允许的后处理模式白名单（`tool-calling.js` 里 `isToolCallingSupported` 的同名单）。
 * 空串就是 NONE。`merge` / `semi` / `strict` / `single` 会把历史工具调用删掉，工具等于白调。
 */
const POST_PROCESSING_ALLOWED = new Set(['', 'merge_tools', 'semi_tools', 'strict_tools']);

/** 后端名字是给用户看的，用户只认得面板上那两行字 */
const MAIN_API_LABELS = Object.freeze({
    openai: 'Chat Completion',
    textgenerationwebui: 'Text Completion',
    kobold: 'KoboldAI',
    koboldhorde: 'AI Horde',
    novel: 'NovelAI',
});

function ok() {
    return {
        ok: true,
        code: DIAG_CODES.OK,
        reason: '当前连接支持函数调用，工具可以正常发出。',
        fix: '',
    };
}

function fail(code, reason, fix) {
    return { ok: false, code, reason, fix };
}

/**
 * 判断不了时的统一答案。
 *
 * 不猜：猜错会让用户去改一个本来就对的设置，比"我不知道"更糟。
 */
function unknown(reason) {
    return fail(
        DIAG_CODES.UNKNOWN,
        reason,
        '按顺序检查三处：Chat Completion 连接 → 「启用函数调用」→ 提示词后处理。',
    );
}

/**
 * 问 ST 要结论。
 * @returns {boolean|null} null = 拿不到结论（接口不存在或调用抛错）
 */
function readSupport(ctx) {
    if (typeof ctx?.isToolCallingSupported !== 'function') {
        return null;
    }

    try {
        return Boolean(ctx.isToolCallingSupported());
    } catch (err) {
        console.debug('[Thrive] isToolCallingSupported 抛错', err);
        return null;
    }
}

/**
 * 环境诊断。
 *
 * @param {object} ctx getContext() 的返回值，调用方现取
 * @returns {{ ok: boolean, code: string, reason: string, fix: string }}
 */
export function diagnoseEnvironment(ctx) {
    if (!ctx) {
        return unknown('拿不到 SillyTavern 的上下文，判断不了工具调用是否可用。');
    }

    const supported = readSupport(ctx);
    if (supported === true) {
        return ok();
    }
    if (supported === null) {
        return unknown('这个 SillyTavern 没有暴露工具可用性接口，判断不了具体状态。');
    }

    // 到这里结论已经确定：工具不可用。下面只是把"为什么"说细一点。
    try {
        // ctx.chatCompletionSettings 就是 oai_settings；ctx.mainApi 是 main_api 的快照
        const settings = ctx.chatCompletionSettings ?? {};
        const mainApi = String(ctx.mainApi ?? settings.main_api ?? '');

        if (mainApi !== 'openai') {
            const label = MAIN_API_LABELS[mainApi] ?? (mainApi || '未知');
            return fail(
                DIAG_CODES.TEXT_COMPLETION,
                '需要 chat completion 连接，当前是文本补全。',
                `到「AI 响应配置 → 聊天补全来源」把接口换成 Chat Completion（现在是 ${label}）。`,
            );
        }

        if (!settings.function_calling) {
            return fail(
                DIAG_CODES.FUNCTION_CALLING,
                '「启用函数调用」没有勾上，ST 不会把工具发给模型。',
                '到「AI 响应配置」勾选「启用函数调用」（Continue Postfix 折叠块下面）。'
                + '套用预设会覆盖它，换过预设后要重新确认。',
            );
        }

        const post = settings.custom_prompt_post_processing ?? '';
        if (!POST_PROCESSING_ALLOWED.has(String(post))) {
            return fail(
                DIAG_CODES.POST_PROCESSING,
                '当前后处理模式会移除工具消息，请换成 None 或带 `_tools` 的模式。',
                `到「AI 响应配置 → 提示词后处理」把「${post}」改成 None / merge_tools / semi_tools / strict_tools。`,
            );
        }

        return fail(
            DIAG_CODES.MODEL,
            '当前模型不支持工具调用（部分来源会按模型能力判定）。',
            '换一个支持 tools 的模型或来源；OpenRouter 之类的来源看模型是否声明了 tools 能力。',
        );
    } catch (err) {
        console.warn('[Thrive] 细分诊断失败', err);
        return unknown('工具调用不可用，但判断不了具体原因。');
    }
}

/**
 * 一行结论，给徽章点击提示与 `/thrive status` 用。
 * @param {{ ok: boolean, reason: string, fix: string }} diag
 */
export function formatDiagnosis(diag) {
    if (!diag || diag.ok) {
        return '';
    }
    return diag.fix ? `${diag.reason}${diag.fix}` : diag.reason;
}

/* -------------------------------------------------------------- 错误文案目录 */

/**
 * 每个错误码的兜底 hint。
 *
 * 调用点自己的 hint 更具体（带书名、字数），优先用调用点的；这里保证的是
 * "任何一条错误回到模型面前时都有下一步动作"，不会出现裸的 `{ ok: false, error }`。
 * `tools.js` 的 errorResult 在拿不到 hint 时回落到这张表。
 *
 * 文案边界（spec §11.5）：只说模型自己能做的动作，不替它对用户讲话。
 */
export const ERROR_HINTS = Object.freeze({
    // —— 工具契约里的通用码（spec §7）
    NO_CHAR: '当前没有选中角色。请让用户先在角色列表里选一个，再重试。',
    NO_BOOK: '还没有选择可写书。请让用户到扩展设置里选一本，再重试。',
    MODULE_DISABLED: '这个模块已关闭，不能写这一类内容；现在只能记另一类，不要改道写进别的目标。',
    READ_REQUIRED: '本轮还没读过这个目标。先调用对应的读取工具，拿到当前内容再写。',
    STALE_READ: '内容在你读取之后被改动过。请重新读取拿最新正文，不要重试原来的参数。',
    NO_KEYS: '新建条目至少要给 1 个关键词，否则它永远不会被触发。补上 keys 再写。',
    EMPTY_CONTENT: '正文是空的。如果要追加，请给出具体文字。',
    // 兜底只说事实：具体怎么压由设置里的压缩指令给，这里不写第二份
    TOO_LONG: '超过长度上限。请压缩后重新提交更短的内容。',
    TITLE_TOO_LONG: '标题太长。请精简成一个短的专有名词。',

    // —— 实现中补的错误码（README「工具」一节有清单）
    INVALID_TITLE: '标题不能为空：它既是同书内的唯一标识，也会显示在世界书列表里。',
    INVALID_MODE: 'mode 只能是 append（追加到末尾）或 rewrite（提交完整全文）。',
    WRITE_FAILED: '写盘没有成功。可以让用户确认 SillyTavern 还在运行，然后重试一次。',
    PATCH_CONFLICT: '角色描述有一份冲突的改动等着用户处理。这一轮先不要再写描述，继续正文即可。',
    ENTRY_GONE: '条目已经不在书里（被删除或改名），没有可恢复的位置。',
    INVALID_BACKUP: '这条快照缺少书名或标题，定位不到条目。',

    // —— 只在插件内部/面板里流转，不会到模型面前
    NO_PATCH: '没有待确认的描述改动。',
    CONFLICT: '磁盘上的描述在暂存之后被改动过。面板里只能选择强制覆盖或拒绝。',
    NO_BACKUP: '还没有可恢复的上一版。',
    PATCH_PENDING: '还有一份待确认的描述改动，先在面板里接受或拒绝，再恢复上一版。',
    NO_CHANGE: '当前描述已经和上一版一致，不需要恢复。',
});

/**
 * 取一个错误码的兜底 hint。
 * @param {string} code
 * @returns {string} 认不出的错误码返回空串，由调用方决定是否只回 code
 */
export function hintFor(code) {
    return ERROR_HINTS[String(code ?? '')] ?? '';
}
