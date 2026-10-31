/**
 * tool-names.js · 工具名常量
 *
 * 单独成文件是为了打断依赖链：trace.js 要判断"这条日志是不是我们的"，
 * 但如果它 import tools.js，就会连带 import extensions.js（浏览器的 ESM），
 * 日志格式化这类纯逻辑也就没法在 node 里单独跑。
 *
 * 工具名只在这里写一次，tools.js 从这里取，trace.js 也从这里取。
 */

export const TOOL_NAMES = Object.freeze({
    DESC_READ: 'desc_read',
    DESC_WRITE: 'desc_write',
    LORE_READ: 'lore_read',
    LORE_WRITE: 'lore_write',
});

const THRIVE_TOOLS = new Set(Object.values(TOOL_NAMES));

/**
 * 这个工具是不是本插件的。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isThriveTool(name) {
    return THRIVE_TOOLS.has(String(name ?? ''));
}
