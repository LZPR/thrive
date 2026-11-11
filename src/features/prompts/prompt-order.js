/**
 * prompt-order.js · 预设卡片的 id 与顺序
 *
 * 这里定义的是**学习会话的预设**，不再往聊天请求里注入任何东西。顺序就是消息的
 * 先后：排在前面的先发出去，角色不同的相邻卡片各自成一条消息。
 *
 * 三张内置卡，分两半（ADR-053、ADR-054）：
 *
 *   rules       通用提示词。这场会话里你是谁、擅长什么、按什么标准判断。
 *               每一场都带，与学什么、压什么无关，所以排在**最前面**——模型先知道
 *               自己是谁，再读到要干什么。
 *   targetDesc  描述行。默认「以下是目标内容：」，可以改、可以停用、也可以删掉。
 *   target      **注入位**。没有正文，运行时把真实内容填进来（学习 = 当前对话
 *               记录，压缩 = 那条超长条目）。不可编辑、不可停用、不可删除，
 *               而且永远排在最后——它代表"这一场要看的东西"，不是一段可写的文字。
 *
 * 为什么"通用 / 特化"要分成两处：列表里的是每一场都成立的定位（你是谁），
 * 开场白里的是这一场才成立的做法（产出走哪、写到哪、怎么写）。混在一起的时候，
 * 换一种任务就得把同一段定位再抄一遍，改一次要改两处（见 ADR-054）。
 *
 * 顺序表里还可以有用户自建的提示词 id（`customPrompts` 里那些）。它们对这里来说
 * 是"不认识的 id"，所以 normalizeOrder 需要调用方把当前存在的自建 id 一起传进来
 * ——自建提示词被删掉之后，留在顺序表里的那个 id 要能自动消失。
 *
 * 这是一层叶子模块：不 import 任何东西，store.js（做设置迁移）和 prompt.js
 * （拼预设）都能安全地引用它，不会绕出环。
 */

export const CARD_ID = Object.freeze({
    /** 通用提示词：这一场里你是谁，所有任务共用 */
    RULES: 'rules',
    /** 目标内容的描述行：可改、可停用、可删 */
    TARGET_DESC: 'targetDesc',
    /** 目标内容的注入位：没有正文，不可编辑 / 停用 / 删除，永远在最后 */
    TARGET: 'target',
});

/** 默认顺序：先通用提示词，再描述行，最后注入位 */
export const DEFAULT_PROMPT_ORDER = Object.freeze([
    CARD_ID.RULES,
    CARD_ID.TARGET_DESC,
    CARD_ID.TARGET,
]);

/**
 * 钉死在末尾的卡。
 *
 * 注入位代表"这一场要看的东西"，它后面再跟一条规则会让模型把要求和材料读反；
 * 而且它没有正文，拖动它本身也没有意义。所以它不可拖，位置也不参与排序。
 */
export const PINNED_CARDS = Object.freeze([CARD_ID.TARGET]);

/** @type {Set<string>} */
const BUILTIN = new Set(Object.values(CARD_ID));

/** 这张 id 是不是内置卡（内置卡不能删，只能停用——注入位两者都不行） */
export function isBuiltinCard(id) {
    return BUILTIN.has(id);
}

/** 这张卡是不是钉在末尾、只能由插件摆位置的那种 */
export function isPinnedCard(id) {
    return PINNED_CARDS.includes(id);
}

/**
 * 规范顺序表：去重、丢掉不认识的 id、把注入位摆到最后。
 *
 * 与上一版的差别有两条，都是为了"描述可删、注入必须在"：
 *   - `targetDesc` **不再自动补**。用户删掉它就是删掉了，不该每次重排都长回来；
 *     想要回来走「默认顺序」。
 *   - `target` 一定存在，而且一定在最后。
 *
 * 自建提示词插在注入位**之前**：注入位是这一场要看的东西，它和随后那条
 * User 消息应当挨在一起；规则类的东西插在两者中间会把它隔开。
 *
 * @param {unknown} raw
 * @param {string[]} [extraIds] 当前存在的自建提示词 id
 * @returns {string[]} 一定是完整、合法的顺序表
 */
export function normalizeOrder(raw, extraIds = []) {
    const input = Array.isArray(raw) ? raw : [];
    const extras = (Array.isArray(extraIds) ? extraIds : [])
        .filter(id => typeof id === 'string' && id && !BUILTIN.has(id));
    const known = new Set([...BUILTIN, ...extras]);
    const order = [];

    for (const id of input) {
        // 注入位最后单独摆，这里先跳过
        if (id === CARD_ID.TARGET) {
            continue;
        }
        if (known.has(id) && !order.includes(id)) {
            order.push(id);
        }
    }

    const missingExtra = extras.filter(id => !order.includes(id));
    if (missingExtra.length) {
        order.push(...missingExtra);
    }

    order.push(CARD_ID.TARGET);
    return order;
}
