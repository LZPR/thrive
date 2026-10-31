/**
 * util.js · 无依赖的小工具
 *
 * 三个东西都很克制：哈希只用来判断"内容变没变"，截断只用于工具返回，
 * 拼接只处理"要不要加空行"。不做任何格式化、清洗或语义处理。
 */

/**
 * FNV-1a 32 位，按 UTF-16 码元迭代。
 *
 * 用途仅是变更检测（读到的内容还是不是当初那份），不做安全用途。
 * 不用 crypto 是因为它异步，而读登记需要同步写进 chat_metadata。
 *
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
export function fnv1a(text) {
    const str = String(text ?? '');
    let hash = 0x811c9dc5;

    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        // Math.imul 保证 32 位乘法不丢精度，>>> 0 转回无符号
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
}

/**
 * 按字符数截断，返回是否需要提示截断。
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncate(text, maxChars) {
    const str = String(text ?? '');
    const limit = Number(maxChars);

    if (!Number.isFinite(limit) || limit <= 0 || str.length <= limit) {
        return { text: str, truncated: false };
    }

    return { text: str.slice(0, limit), truncated: true };
}

/** 是否为空或全空白 */
export function isBlank(text) {
    return !String(text ?? '').trim();
}

/**
 * HTML 转义。只用于把"模型写出来的文本"塞进面板——它可能带尖括号，
 * 直接拼进 innerHTML 会被当成标签。
 * @param {string} text
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 统一换行符为 `\n`。
 *
 * ST 的角色编辑面板保存时会把 textarea 里的换行写成 CRLF（写进角色卡的就是 `\r\n`），
 * 而浏览器里 textarea.value 读出来又是 LF。只要不统一，同一段文本在"盘上"和"框里"
 * 就不是同一串字节——哈希对不上（误判 STALE_READ / CONFLICT）、内容没变也被当成改过。
 * 所以在读取角色描述、计算哈希、比较文本之前都先过一遍。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeEol(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n');
}

/**
 * 追加段落：当前文本 + 一个空行 + 新内容。
 * 当前文本为空（或全空白）时不加空行；顺手削掉 base 尾部的空白，
 * 否则反复 append 会攒出一串空行。
 * @param {string} base
 * @param {string} addition
 */
export function appendParagraph(base, addition) {
    const head = String(base ?? '').replace(/\s+$/, '');
    const tail = String(addition ?? '').trim();

    if (!head) {
        return tail;
    }
    if (!tail) {
        return head;
    }

    return `${head}\n\n${tail}`;
}
