/**
 * prompt-order.js · 提示词卡片的 id 与顺序
 *
 * 这是一层叶子模块：不 import 任何东西，store.js（做设置迁移）和 prompt.js
 * （拼注入文本）都能安全地引用它，不会绕出环。
 *
 * 顺序表里有一张不注入的卡：`anchor`（「其它提示词」）。它不是提示词，
 * 而是一道分界线——排在它前面的卡片进系统提示词区（IN_PROMPT，落在 main 之后），
 * 排在它后面的卡片进对话尾部（IN_CHAT depth 0）。拖动它等于整体换边。
 *
 * `compact` 卡也不参与注入：压缩指令只在工具返回里追加，列在这里只是为了
 * 和其它提示词放在同一处编辑、同一处看状态。
 */

export const CARD_ID = Object.freeze({
    /** 工具指令：工具常驻时说明哪些工具不可用，支持 {{工具名}} 宏 */
    TOOL: 'tool',
    /** 学习块 · 通用段 */
    COMMON: 'common',
    /** 学习块 · 主动模式段 */
    ACTIVE: 'active',
    /** 学习块 · 被动模式段 */
    PASSIVE: 'passive',
    /** 分界线：插件以外原本的提示词（主提示词 / 世界书 / 角色卡 / 聊天记录） */
    ANCHOR: 'anchor',
    /** 超限时的压缩指令：不注入，只附在工具返回里 */
    COMPACT: 'compact',
});

/**
 * 默认顺序：分界线在最上面，所有插件提示词都在尾部。
 *
 * 这与 v0.19 的默认（学习块注入尾部）一致，所以老用户升级后行为不变；
 * 工具指令也放在尾部——它每开关一次就变一段，放头部会让 system 前缀跟着失效。
 */
export const DEFAULT_PROMPT_ORDER = Object.freeze([
    CARD_ID.ANCHOR,
    CARD_ID.COMMON,
    CARD_ID.ACTIVE,
    CARD_ID.PASSIVE,
    CARD_ID.TOOL,
    CARD_ID.COMPACT,
]);

/** 旧设置 blockPosition=head 迁移过来的顺序：插件提示词整体挪到分界线上方 */
export const HEAD_PROMPT_ORDER = Object.freeze([
    CARD_ID.COMMON,
    CARD_ID.ACTIVE,
    CARD_ID.PASSIVE,
    CARD_ID.TOOL,
    CARD_ID.ANCHOR,
    CARD_ID.COMPACT,
]);

const ALL_IDS = Object.freeze(Object.values(CARD_ID));
const KNOWN = new Set(ALL_IDS);

/**
 * 规范顺序表：去重、丢掉不认识的 id、补齐缺的卡。
 *
 * 补齐的卡插在压缩指令之前（它天然是最后一张），分界线缺失时补在最前面——
 * 缺了分界线就没法判断头部/尾部分界，按"全部尾部"处理最安全。
 *
 * @param {unknown} raw
 * @returns {string[]} 一定是完整、合法的顺序表
 */
export function normalizeOrder(raw) {
    const input = Array.isArray(raw) ? raw : [];
    const order = [];

    for (const id of input) {
        if (KNOWN.has(id) && !order.includes(id)) {
            order.push(id);
        }
    }

    if (!order.includes(CARD_ID.ANCHOR)) {
        order.unshift(CARD_ID.ANCHOR);
    }

    const compactIndex = order.indexOf(CARD_ID.COMPACT);
    const insertAt = compactIndex >= 0 ? compactIndex : order.length;

    for (const id of ALL_IDS) {
        if (!order.includes(id)) {
            order.splice(insertAt, 0, id);
        }
    }

    return order;
}

/**
 * 按分界线切成头部 / 尾部两组。顺序在组内保留。
 * @param {string[]} order 已经过 normalizeOrder 的顺序表
 * @returns {{ head: string[], tail: string[] }}
 */
export function splitByAnchor(order) {
    const list = normalizeOrder(order);
    const index = list.indexOf(CARD_ID.ANCHOR);
    return {
        head: list.slice(0, index),
        tail: list.slice(index + 1),
    };
}

/** 这张卡是不是排在分界线前面（进系统提示词区） */
export function isHeadCard(order, id) {
    return splitByAnchor(order).head.includes(id);
}
