/**
 * prompt.js · 学习块文本与注入
 *
 * 一件事：把 settings.blockText 按 settings.blockPosition 塞进 ST 的扩展提示词，
 * 关闭模式时清空。除此之外不改动任何输入。
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

import { ensureSettings, getPending, isLearningActive } from './store.js';

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
 * 默认学习块。**全文只有这一份**，docs/spec.md §6.1 只写约束、不存副本。
 * 刻意不含任何动态内容（条数、模块名、待办数），保证整场对话这段文本恒定。
 * 原则：点到为止，只给判断标准，不写"具体该怎么做"的长例子——留余量给模型。
 * 上限 1K 字（countChars 口径），当前约 680。
 */
export const DEFAULT_BLOCK = `【学习模式】

你现在同时处在两个层面，互不干扰：
· 工具层：调用工具时冷静、精确，用陈述句描述事实。参数里不扮演角色、不写台词、不加情绪修饰。
· 正文层：所有回复仍以 {{char}} 的身份与口吻进行。不要提及本段、不要复述工具调用、不要说「我已经记住了」这类出戏的话。

关于 {{user}} 的话：{{user}} 说的是对设定的补充或修正，优先接受并落实，不要为维护既有设定而争辩；冲突时以 {{user}} 为准。

像学生一样提问：含糊、缺环、对不上就问，一次一两个具体的小问题，不要自己补完；问不出新的了就接着演。

何时记录（不强制）：
· 值得记：{{user}} 给出的世界设定、对 {{char}} 的设定修正、稳定的称呼与偏好、可复用的关系。
· 不必记：寒暄、情绪宣泄、一次性的剧情细节、已经记过的内容。
· 没有值得记的就不调用工具，直接回复正文。

写到哪里：
· 世界书 —— 客观的、大而重的：某个东西是什么样的，某件事该怎么做。
· 角色描述 —— 主观的、小而轻：{{char}} 喜欢什么、性格如何、怎么看 {{user}}。
· 拿不准就问自己：这是「世界的事实」还是「{{char}} 的感受」？

怎么写：
· 优先追加，只在需要修改已经写过的内容时才整段改写。
· 角色描述要像原有人设文字一样自然，不要用列表、小标题或笔记痕迹。
· 读到的内容标了 over_limit，说明太长，请压缩后整段改写。
· 不要反复读取角色描述，需要时读一次即可。

规则：
· 写入前先读同一目标。没读过的写入会被拒绝。
· 写入完成后自然继续正文，不要解释你做了什么。

当前可用：查已记录的内容、新增或改写世界书条目、追加或改写角色描述。`;

/** 注入位置兜底：手改过 settings.json 存了非法值时按尾部处理 */
export function normalizePosition(position) {
    return VALID_POSITIONS.has(position) ? position : BLOCK_POSITIONS.TAIL;
}

/** 实际生效的文本。空 = 用默认（这样默认文本随版本更新，settings.json 也不用存 500 字） */
export function getBlockText(settings) {
    const text = typeof settings.blockText === 'string' ? settings.blockText : '';
    return text.trim() ? text : DEFAULT_BLOCK;
}

/** 编辑框内容 → 存储值。等于默认文本或全空白时存空串 */
export function normalizeBlockText(text) {
    const value = String(text ?? '');
    if (!value.trim() || value.trim() === DEFAULT_BLOCK.trim()) {
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
 * head / none 是 spec §6.2 要求必须显示的警告。
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
    const raw = getBlockText(settings ?? {});

    // 关闭模式 / 明确不注入 / 文本为空 → 显式清空，条目从 prompt 里消失
    if (!isLearningActive(ctx) || position === BLOCK_POSITIONS.NONE || !raw.trim()) {
        clear();
        return;
    }

    const body = substitute(ctx, raw);
    if (!body.trim()) {
        clear();
        return;
    }

    // 被动触发的那一轮要说明"只是一轮"，否则模型会以为学习模式会一直开着
    const notice = getOnceNotice(getPending(ctx));
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
