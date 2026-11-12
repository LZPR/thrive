/**
 * prompt-order.js · 预设卡片的 id 与顺序
 *
 * 这里定义的是**学习会话的预设**，不再往聊天请求里注入任何东西。顺序就是消息的
 * 先后：排在前面的先发出去，角色不同的相邻卡片各自成一条消息。
 *
 * 三张内置卡，组成目标内容区块：
 *
 *   targetDesc  目标内容[开始]。可改、可停用、可删除。
 *   target      **注入位**。没有正文，运行时把真实内容填进来（学习 = 当前对话
 *               记录，压缩 = 那条超长条目）。不可编辑、不可停用、不可删除。
 *   targetEnd   目标内容[结束]。可改、可停用、可删除。
 *               边界卡和注入位作为整体固定在预设末尾，确保目标内容始终夹在两者之间。
 *
 * 顺序表里还可以有用户自建的提示词 id（`customPrompts` 里那些）。它们对这里来说
 * 是"不认识的 id"，所以 normalizeOrder 需要调用方把当前存在的自建 id 一起传进来
 * ——自建提示词被删掉之后，留在顺序表里的那个 id 要能自动消失。
 *
 * 这是一层叶子模块：不 import 任何东西，store.js（做设置迁移）和 prompt.js
 * （拼预设）都能安全地引用它，不会绕出环。
 */

export const CARD_ID = Object.freeze({
    DESC_TEXT: 'descText',
    DESC_PLIST: 'descPList',
    DESC_ALICHAT: 'descAliChat',
    /** 目标内容的开始标记：可改、可停用、可删 */
    TARGET_DESC: 'targetDesc',
    /** 目标内容的注入位：没有正文，不可编辑 / 停用 / 删除，永远在最后 */
    TARGET: 'target',
    /** 目标内容的结束标记：可改、可停用、可删 */
    TARGET_END: 'targetEnd',
});
export const DESCRIPTION_CARDS = Object.freeze({
    [CARD_ID.DESC_TEXT]: 'text',
    [CARD_ID.DESC_PLIST]: 'plist',
    [CARD_ID.DESC_ALICHAT]: 'alichat',
});

export function isConditionalCard(id) {
    return Object.hasOwn(DESCRIPTION_CARDS, id);
}
export const LEGACY_RULES_ID = 'rules';

/** 默认顺序：目标内容始终位于可编辑的开始、结束标记之间 */
export const DEFAULT_PROMPT_ORDER = Object.freeze([
    ...Object.keys(DESCRIPTION_CARDS),
    CARD_ID.TARGET_DESC,
    CARD_ID.TARGET,
    CARD_ID.TARGET_END,
]);

/**
 * 注入位。
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
 * 规范顺序表：去重、丢掉不认识的 id，并把边界卡与注入位固定为末尾区块。
 *
 * 与上一版的差别有两条，都是为了"描述可删、注入必须在"：
 *   - `targetDesc` / `targetEnd` 不自动补回，删除即表示不用该标记。
 *   - `target` 一定存在。边界标记（若仍存在）分别紧贴在其前后。
 *
 * 自建提示词位于目标内容区块之前，避免规则被误认为目标材料的一部分。
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
        // 目标区块的顺序由末尾统一固定
        if ([CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END].includes(id)) {
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

    // 用途卡不可删除；保留用户已有次序，只在目标区块前补回缺失的卡。
    for (const id of Object.keys(DESCRIPTION_CARDS)) {
        if (!order.includes(id)) order.push(id);
    }

    if (input.includes(CARD_ID.TARGET_DESC)) order.push(CARD_ID.TARGET_DESC);
    order.push(CARD_ID.TARGET);
    if (input.includes(CARD_ID.TARGET_END)) order.push(CARD_ID.TARGET_END);
    return order;
}
