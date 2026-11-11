/**
 * prompt-order.js · 预设卡片的 id 与顺序
 *
 * 这里定义的是**学习会话的预设**，不再往聊天请求里注入任何东西。顺序就是消息的
 * 先后：排在前面的先发出去，角色不同的相邻卡片各自成一条消息。
 *
 * 两张内置卡：
 *
 *   learning  会话规则。告诉模型它在一场独立会话里、产出只走工具、写到哪、怎么写。
 *   target    目标内容。卡片正文只是那句描述（默认「以下是目标内容：」），真正的
 *             内容由 learning.js 在编译预设时追加在后面——学习是当前对话记录，
 *             将来压缩是那几条超长内容。
 *
 * `target` 的"内容"每次都不同，所以能改的只有描述那一行；正文由运行时注入。
 *
 * 顺序表里还可以有用户自建的提示词 id（`customPrompts` 里那些）。它们对这里来说
 * 是"不认识的 id"，所以 normalizeOrder 需要调用方把当前存在的自建 id 一起传进来
 * ——自建提示词被删掉之后，留在顺序表里的那个 id 要能自动消失。
 *
 * 这是一层叶子模块：不 import 任何东西，store.js（做设置迁移）和 prompt.js
 * （拼预设）都能安全地引用它，不会绕出环。
 */

export const CARD_ID = Object.freeze({
    /** 会话规则：做什么、产出方式、写到哪里、怎么写 */
    LEARNING: 'learning',
    /** 目标内容：描述行 + 运行时注入的正文 */
    TARGET: 'target',
});

/** 默认顺序：规则在前，内容在后，紧接着是学习用的 User 消息 */
export const DEFAULT_PROMPT_ORDER = Object.freeze([
    CARD_ID.LEARNING,
    CARD_ID.TARGET,
]);

const BUILTIN = new Set(Object.values(CARD_ID));

/** 这张 id 是不是内置卡（内置卡不能删，只能停用） */
export function isBuiltinCard(id) {
    return BUILTIN.has(id);
}

/**
 * 规范顺序表：去重、丢掉不认识的 id、补齐缺的内置卡。
 *
 * 自建提示词插在目标内容**之前**：目标内容是这一场要看的东西，它和随后那条
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
        if (known.has(id) && !order.includes(id)) {
            order.push(id);
        }
    }

    // 内置卡缺了就补：规则在最前，目标内容在最后
    if (!order.includes(CARD_ID.LEARNING)) {
        order.unshift(CARD_ID.LEARNING);
    }
    if (!order.includes(CARD_ID.TARGET)) {
        order.push(CARD_ID.TARGET);
    }

    const missingExtra = extras.filter(id => !order.includes(id));
    if (missingExtra.length) {
        const targetAt = order.indexOf(CARD_ID.TARGET);
        order.splice(targetAt >= 0 ? targetAt : order.length, 0, ...missingExtra);
    }

    return order;
}
