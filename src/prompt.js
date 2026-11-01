/**
 * prompt.js · 学习块文本与注入
 *
 * 一件事：把学习块按 settings.blockPosition 塞进 ST 的扩展提示词，
 * 关闭模式时清空。除此之外不改动任何输入。
 *
 * 学习块由三段组成，注入时**拼**成一段：
 *
 *     通用提示词（common）+ 当前运行模式的提示词（active 或 passive）
 *
 * 三段各自可编辑、各自「留空 = 用默认文本」。当前用哪一段模式提示词由
 * store.getLearningMode 决定：主动开着就算主动，即使还挂着一个待学记号——
 * 两条路径重合时主动优先，和"主动开着时被动不触发"是同一条规则。
 *
 * "开着"只有一个判据 —— store.js 的 isLearningActive：主动开关开着，或者被动学习
 * 刚刚挂了一次待学习。注入与工具注册都走它，不会出现"块进去了、工具没注册"的半开状态。
 *
 * 两个反直觉点：
 *   1. ST 不会替尾部注入（IN_CHAT）做宏替换，头部（IN_PROMPT）路径行为又不一样，
 *      所以两种位置统一由这里先 substituteParams，保证表现一致。
 *   2. 关闭时不是"不设置"，而是显式写入空串：getExtensionPrompt 会过滤掉空 value，
 *      这样条目彻底不出现，请求体与没装插件时一致。
 */

import { ensureSettings, getLearningMode, getPending, LEARNING_MODE } from './store.js';

/** 扩展提示词里的键名，全局唯一即可 */
export const BLOCK_KEY = 'thrive_block';

/** 与 ST 的 extension_prompt_types 对应，避免为了三个常量去 import script.js */
const IN_PROMPT = 0;
const IN_CHAT = 1;
const NONE = -1;

/** 与 extension_prompt_roles.SYSTEM 对应 */
const ROLE_SYSTEM = 0;

export const BLOCK_POSITIONS = Object.freeze({
    TAIL: 'tail',
    HEAD: 'head',
    NONE: 'none',
});

const VALID_POSITIONS = new Set(Object.values(BLOCK_POSITIONS));

/**
 * 默认通用段。**主动与被动都带这一份**，写的全是与"这轮学多少"无关的东西：
 * 工具层与正文层怎么分工、写到哪里、怎么写、守什么规矩。
 *
 * 刻意不含任何动态内容（条数、模块名、待办数），保证整场对话这段文本恒定。
 * 原则：点到为止，只给判断标准，不写"具体该怎么做"的例子——留余量给模型。
 */
export const DEFAULT_BLOCK_COMMON = `【学习模式】

你现在同时处在两个层面，互不干扰：
· 工具层：调用工具时冷静、精确，用陈述句描述事实。参数里不扮演角色、不写台词、不加情绪修饰。
· 正文层：所有回复仍以 {{char}} 的身份与口吻进行。不要提及本段、不要复述工具调用、不要说「我已经记住了」这类出戏的话。

将 {{user}} 说的话视为对设定的补充或修正，优先接受并落实。

写到哪里：
· 世界书 —— 客观的、大而重的：某个东西是什么样的，某件事该怎么做。
· 角色描述 —— 主观的、小而轻：{{char}} 喜欢什么、性格如何、怎么看 {{user}}。

怎么写：
· 角色描述要像原有人设文字一样自然，不要用列表、小标题或笔记痕迹。
· 用 {{char}} 和 {{user}} 指代角色，避免“你”“我”等代词。`;

/** 默认主动段：常开的那一种，倾向多问多记，宁可记小而不要漏 */
export const DEFAULT_BLOCK_ACTIVE = `【主动模式】
请像学生一样积极学习，主动追问并记录。`;

/**
 * 默认被动段：借来的一轮，倾向少动工具。
 * "只在这一轮有效"由 getOnceNotice() 按实际原因补，这里不写死，免得手动触发时说法不准。
 */
export const DEFAULT_BLOCK_PASSIVE = `【被动模式】
请记录过往内容中的关键部分，没有值得记忆的就正常继续。`;

/**
 * 三段的元信息：界面与设置读写都按这张表走，加一段只改这里。
 * `part` 同时是 DOM id 的后缀（`thrive_block_<part>` / `_count` / `_reset`）。
 */
export const BLOCK_TEXT_PARTS = Object.freeze([
    {
        part: 'common',
        settingKey: 'blockCommon',
        defaultValue: DEFAULT_BLOCK_COMMON,
        label: '通用提示词',
    },
    {
        part: 'active',
        settingKey: 'blockActive',
        defaultValue: DEFAULT_BLOCK_ACTIVE,
        label: '主动模式提示词',
    },
    {
        part: 'passive',
        settingKey: 'blockPassive',
        defaultValue: DEFAULT_BLOCK_PASSIVE,
        label: '被动模式提示词',
    },
]);

const PART_BY_KEY = new Map(BLOCK_TEXT_PARTS.map(item => [item.part, item]));

/** 注入位置兜底：手改过 settings.json 存了非法值时按尾部处理 */
export function normalizePosition(position) {
    return VALID_POSITIONS.has(position) ? position : BLOCK_POSITIONS.TAIL;
}

/**
 * 某一段实际生效的文本。空 = 用默认（这样默认文本随版本更新，settings.json 也不用存五百字）。
 * @param {object} settings
 * @param {'common'|'active'|'passive'} part
 */
export function getPartText(settings, part) {
    const meta = PART_BY_KEY.get(part) ?? PART_BY_KEY.get('common');
    const text = typeof settings?.[meta.settingKey] === 'string' ? settings[meta.settingKey] : '';
    return text.trim() ? text : meta.defaultValue;
}

/**
 * 拼出这一轮真正要注入的文本：通用 + 当前模式那段。
 *
 * 两段都可能是空（用户写成空行、或宏替换后为空），用空行隔开、空段丢掉，
 * 不做去重——三段本来就是各写各的，重合的句子以模式段为准是个语言问题，
 * 不是文本处理问题（顺序把模式段放在后面，模型读到的最后一句是它）。
 *
 * @param {object} settings
 * @param {'active'|'passive'|null} mode null = 学习模式没开，返回空串
 */
export function composeBlockText(settings, mode) {
    if (!mode) {
        return '';
    }

    const common = getPartText(settings, 'common');
    const specific = getPartText(settings, mode);

    return [common, specific]
        .map(part => String(part ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

/**
 * 编辑框内容 → 存储值。等于该段默认文本或全空白时存空串。
 * @param {string} text
 * @param {'common'|'active'|'passive'} part 判断"是否等于默认"用哪一段的默认值
 */
export function normalizeBlockText(text, part = 'common') {
    const meta = PART_BY_KEY.get(part) ?? PART_BY_KEY.get('common');
    const value = String(text ?? '');
    if (!value.trim() || value.trim() === meta.defaultValue.trim()) {
        return '';
    }
    return value;
}

/**
 * 被动学习那一轮的追加说明。
 *
 * 不加这一段，模型看不出"学习模式只是这一轮开着"，容易写出"以后我会一直记着"这类
 * 出戏的话；加了之后它至少知道这个机会是临时的，该趁现在把值得记的记下来。
 *
 * 摘要类生成（dryRun）不注入学习块，所以这段也只会出现在真正会写内容的轮次里。
 *
 * @param {{ reason: string, keyword?: string }|null} pending
 * @returns {string} 没有待学习时返回空串
 */
export function getOnceNotice(pending) {
    if (!pending) {
        return '';
    }

    let why = '自动触发';
    if (pending.reason === 'interval') {
        why = '距上次学习已经过了设定的消息条数';
    } else if (pending.reason === 'keyword') {
        why = pending.keyword ? `消息里出现了关键词「${pending.keyword}」` : '消息命中了关键词';
    } else if (pending.reason === 'manual') {
        why = '用户手动触发';
    }

    return `【本轮为自动触发】这一轮的学习模式是被动学习临时打开的（${why}），只在这一轮有效，回复结束就关闭。`
        + '先看这一轮有没有值得长期保留的信息：有就按上面的规矩记下来，没有就照常继续，不必勉强写。';
}

/** 字数统计口径：不计空白，和 spec 里「约 930 字」对得上 */
export function countChars(text) {
    return String(text ?? '').replace(/\s/g, '').length;
}

/**
 * 注入位置对应的提示文案。
 * head / none 是 spec §6.3 要求必须显示的警告。
 */
export function getPositionHint(position) {
    switch (normalizePosition(position)) {
        case BLOCK_POSITIONS.HEAD:
            return {
                level: 'warn',
                text: '此模式每次开关都会让整段系统提示词重新计费，也会让前缀缓存失效。',
            };
        case BLOCK_POSITIONS.NONE:
            return {
                level: 'warn',
                text: '模型会看到工具但没有任何使用说明，可能乱写。请自行把学习块放进预设。',
            };
        default:
            return {
                level: 'muted',
                text: '注入在消息数组末尾，不改变前缀，开关只影响尾部几段。',
            };
    }
}

/**
 * 把当前状态同步进 ST 的扩展提示词表。幂等，可以随便多次调用。
 * @param {object} ctx getContext() 的返回值，需在使用时现取
 * @param {object} settings extension_settings.thrive
 */
export function syncInjection(ctx, settings) {
    if (typeof ctx?.setExtensionPrompt !== 'function') {
        return;
    }

    const clear = () => ctx.setExtensionPrompt(BLOCK_KEY, '', NONE, 0);

    const position = normalizePosition(settings?.blockPosition);
    const mode = getLearningMode(ctx);

    // 关闭模式 / 明确不注入 / 拼出来是空 → 显式清空，条目从 prompt 里消失
    if (!mode || position === BLOCK_POSITIONS.NONE) {
        clear();
        return;
    }

    const raw = composeBlockText(settings ?? {}, mode);
    if (!raw.trim()) {
        clear();
        return;
    }

    const body = substitute(ctx, raw);
    if (!body.trim()) {
        clear();
        return;
    }

    // 被动触发的那一轮要说明"只是一轮"，否则模型会以为学习模式会一直开着
    const notice = mode === LEARNING_MODE.PASSIVE ? getOnceNotice(getPending(ctx)) : '';
    const text = notice ? `${body}\n\n${notice}` : body;

    const positionCode = position === BLOCK_POSITIONS.HEAD ? IN_PROMPT : IN_CHAT;

    // depth 0 = 消息数组最末位；role SYSTEM；scan false（学习块不参与世界书关键词扫描）
    ctx.setExtensionPrompt(BLOCK_KEY, text, positionCode, 0, false, ROLE_SYSTEM);
}

/** 现取 context + settings 后同步，供事件回调直接用 */
export function syncFromContext(ctx) {
    syncInjection(ctx, ensureSettings(ctx));
}

function substitute(ctx, text) {
    try {
        const replaced = ctx.substituteParams?.(text);
        return String(replaced ?? text);
    } catch (err) {
        console.error('[Thrive] 宏替换失败，按原文注入', err);
        return text;
    }
}
