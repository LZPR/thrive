/**
 * compact.js · 超过长度上限时发给模型的那段压缩指令
 *
 * 只有一个职责：给出"该压缩了"的提示词。字数、阈值、append 会不会被拒这类**事实**
 * 由调用点自己补在前面——事实随目标（角色描述 / 世界书条目）而变，而"为什么压、
 * 压完留下什么态度"两边共用，所以只有这一段做成可配置。
 *
 * 为什么默认文本这么短：规则写得越细，模型越照着套模板去砍，最后压出来的是一份
 * 摘要而不是它自己的记忆。这里只交代目的与底线（别把丢掉的东西当成还记得），
 * 具体留哪句、删哪句交给它自己判断。
 *
 * 空串 = 用默认文本（和 blockText 同一套约定），默认文本随版本更新时老用户也能拿到新版。
 */

/** 编辑框的参考上限，超过只提醒、不截断 */
export const COMPACT_PROMPT_LIMIT = 500;

/**
 * 默认压缩指令。三段：目的 → 会丢东西（要承认）→ 怎么压自己定。
 * 上限 500 字（countChars 口径），当前约 90。
 */
export const DEFAULT_COMPACT_PROMPT = `超出上限的内容需要压短才能继续保留，否则之后的补充会一直被拒绝。

压缩一定会丢细节，这是预期之内的：压完之后，让内容里承认自己有事记不清了，不要把没保住的细节当成还记得。`;

/** 实际生效的文本。空 = 用默认 */
export function getCompactPrompt(settings) {
    const text = typeof settings?.compactPrompt === 'string' ? settings.compactPrompt : '';
    return text.trim() ? text : DEFAULT_COMPACT_PROMPT;
}

/** 编辑框内容 → 存储值。等于默认文本或全空白时存空串 */
export function normalizeCompactPrompt(text) {
    const value = String(text ?? '');
    if (!value.trim() || value.trim() === DEFAULT_COMPACT_PROMPT.trim()) {
        return '';
    }
    return value;
}

/**
 * 拼出真正发下去的 hint：调用点的事实一句 + 配置的压缩指令。
 *
 * @param {object} settings extension_settings.thrive
 * @param {string} fact 具体事实（多少字、超了哪个阈值、append 还能不能写）
 * @returns {string}
 */
export function compactHint(settings, fact) {
    const head = String(fact ?? '').trim();
    const body = getCompactPrompt(settings ?? {}).trim();
    return head ? `${head}\n${body}` : body;
}
