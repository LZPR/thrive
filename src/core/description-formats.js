/**
 * 可逆的描述文本格式。只接受完整可识别的正文；无法解析时拒绝修改，避免覆盖手工内容。
 * PLists 使用方括号、分类冒号、分号及逗号；括号内逗号属于同一属性。
 * Ali:Chat 使用访谈式示例，每组 <START> 后跟 {{user}} / {{char}} 两段。
 */

/** @param {string} message @returns {never} */
function invalid(message) {
    throw new Error(message);
}

/** 在引号及属性括号外分割。JSON 引号可保护分类/属性里的分隔符。 */
function split(text, separator) {
    const parts = [];
    let start = 0;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === '(') depth++;
        else if (char === ')') {
            if (--depth < 0) invalid('属性括号不完整');
        } else if (char === separator && depth === 0) {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    if (quoted || depth) invalid('引号或属性括号不完整');
    parts.push(text.slice(start).trim());
    return parts;
}

function decode(value) {
    const text = value.trim();
    if (!text) invalid('分类和属性不能为空');
    const decoded = text.startsWith('"') ? JSON.parse(text) : text;
    if (typeof decoded !== 'string' || !decoded.trim()) invalid('分类和属性必须是非空文字');
    return decoded;
}

function encode(value) {
    const text = String(value);
    // 保留常见的 trait(descriptor, descriptor) 写法；其余复杂值使用可逆 JSON 引号。
    try {
        if (text.trim() === text && !/[";:[\]\n\r\\]/.test(text) && split(text, ',').length === 1) return text;
    } catch { /* 不完整括号作为普通文字编码 */ }
    return JSON.stringify(text);
}

/** @param {string} text @returns {Record<string, string[]>} */
export function parsePList(text) {
    const body = String(text ?? '').trim();
    if (!body) return {};
    if (!body.startsWith('[') || !body.endsWith(']')) invalid('PLists 正文必须用方括号包围');
    const result = Object.create(null);
    const inside = body.slice(1, -1).trim();
    if (!inside) return {};
    for (const category of split(inside, ';')) {
        const fields = split(category, ':');
        if (fields.length !== 2) invalid('每个分类需要一个冒号');
        const key = decode(fields[0]);
        if (Object.hasOwn(result, key)) invalid('分类重复');
        result[key] = fields[1] ? split(fields[1], ',').map(decode) : [];
    }
    return result;
}

/** @param {Record<string, string[]>} value @returns {string} */
export function serializePList(value) {
    const categories = Object.entries(value).map(([key, traits]) =>
        `${encode(key)}: ${traits.map(encode).join(', ')}`);
    return categories.length ? `[${categories.join('; ')}]` : '';
}

const CONTROL_LINE = /^(?:<START>\s*|\{\{(?:user|char)\}\}:.*)$/m;

/** @param {string} value @returns {string} */
export function validateDialogue(value) {
    if (typeof value !== 'string' || !value.trim()) invalid('问答必须是非空文字');
    if (CONTROL_LINE.test(value.replace(/\r\n?/g, '\n'))) invalid('问答正文不能包含独立的 <START> 或发言者标记行');
    return value.replace(/\r\n?/g, '\n').trim();
}

/** @param {string} text @returns {{ question: string, answer: string }[]} */
export function parseAliChat(text) {
    const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!body) return [];
    if (!body.startsWith('<START>\n')) invalid('Ali:Chat 正文必须以 <START> 开始');
    return body.slice('<START>\n'.length).split('\n<START>\n').map(block => {
        const match = /^\{\{user\}\}: ([\s\S]*?)\n\{\{char\}\}: ([\s\S]*)$/.exec(block);
        if (!match) invalid('Ali:Chat 每组需要 {{user}} 问题和 {{char}} 回答');
        return { question: validateDialogue(match[1]), answer: validateDialogue(match[2]) };
    });
}

/** @param {{ question: string, answer: string }[]} items @returns {string} */
export function serializeAliChat(items) {
    return items.map(({ question, answer }) =>
        `<START>\n{{user}}: ${validateDialogue(question)}\n{{char}}: ${validateDialogue(answer)}`).join('\n');
}
