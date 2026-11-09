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
 * `compact` 卡也不参与注入：压缩指令只在压缩面板里用，列在这里只是为了
 * 和其它提示词放在同一处编辑、同一处看状态。
 *
 * 除了这六张内置卡，顺序表里还可以有用户自建的提示词 id（`customPrompts` 里那些）。
 * 它们对这里来说是"不认识的 id"，所以 normalizeOrder 需要调用方把当前存在的自建 id
 * 一起传进来——自建提示词被删掉之后，留在顺序表里的那个 id 要能自动消失。
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
    /** 压缩面板用的压缩指令：不注入 */
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

/** 补齐顺序表时用：缺哪张卡就按默认顺序插到压缩指令之前 */
const FILL_ORDER = Object.freeze(DEFAULT_PROMPT_ORDER.filter(id => id !== CARD_ID.ANCHOR));

const BUILTIN = new Set(ALL_IDS);

/** 这张 id 是不是内置卡（内置卡不能删，只能停用） */
export function isBuiltinCard(id) {
    return BUILTIN.has(id);
}

/**
 * 规范顺序表：去重、丢掉不认识的 id、补齐缺的卡。
 *
 * 补齐的卡插在压缩指令之前（它天然是最后一张），分界线缺失时补在最前面——
 * 缺了分界线就没法判断头部/尾部分界，按"全部尾部"处理最安全。
 *
 * @param {unknown} raw
 * @param {string[]} [extraIds] 当前存在的自建提示词 id；缺了会被补到压缩指令之前
 * @returns {string[]} 一定是完整、合法的顺序表
 */
export function normalizeOrder(raw, extraIds = []) {
    const input = Array.isArray(raw) ? raw : [];
    const extras = (Array.isArray(extraIds) ? extraIds : [])
        .filter(id => typeof id === 'string' && id && !BUILTIN.has(id));
    const known = new Set([...ALL_IDS, ...extras]);
    const order = [];

    for (const id of input) {
        if (known.has(id) && !order.includes(id)) {
            order.push(id);
        }
    }

    if (!order.includes(CARD_ID.ANCHOR)) {
        order.unshift(CARD_ID.ANCHOR);
    }

    // 内置卡按默认顺序整块补进去，而不是一张一张 splice 到同一个下标（那样会反过来）
    const missingBuiltin = FILL_ORDER.filter(id => !order.includes(id));
    if (missingBuiltin.length) {
        const compactIndex = order.indexOf(CARD_ID.COMPACT);
        const insertAt = compactIndex >= 0 ? compactIndex : order.length;
        order.splice(insertAt, 0, ...missingBuiltin);
    }

    // 自建提示词排在内置卡之后、压缩指令之前：新加的一条默认落在列表末尾
    const missingExtra = extras.filter(id => !order.includes(id));
    if (missingExtra.length) {
        const compactIndex = order.indexOf(CARD_ID.COMPACT);
        const insertAt = compactIndex >= 0 ? compactIndex : order.length;
        order.splice(insertAt, 0, ...missingExtra);
    }

    return order;
}

/**
 * 按分界线切成头部 / 尾部两组。顺序在组内保留。
 * 传进来的顺序表应当已经过 normalizeOrder；缺分界线时按"全部尾部"处理。
 *
 * @param {string[]} order
 * @returns {{ head: string[], tail: string[] }}
 */
export function splitByAnchor(order) {
    const list = Array.isArray(order) ? order : [];
    const index = list.indexOf(CARD_ID.ANCHOR);

    if (index < 0) {
        return { head: [], tail: list.slice() };
    }

    return {
        head: list.slice(0, index),
        tail: list.slice(index + 1),
    };
}

/** 这张卡是不是排在分界线前面（进系统提示词区） */
export function isHeadCard(order, id) {
    return splitByAnchor(order).head.includes(id);
}
