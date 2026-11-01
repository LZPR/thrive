/**
 * tool-names.js · 工具名常量
 *
 * 单独成文件是为了打断依赖链：trace.js 要判断"这条日志是不是我们的"，
 * 但如果它 import tools.js，就会连带 import extensions.js（浏览器的 ESM），
 * 日志格式化这类纯逻辑也就没法在 node 里单独跑。
 *
 * 工具名只在这里写一次，tools.js 从这里取，trace.js 也从这里取。
 *
 * 命名规则：`<目标>_<动词>`，动词只有五个 —— read / list / add / append /
 * replace / rewrite。读一律叫 read，不再有 get：同一个动作在一组工具里出现
 * 两种叫法，模型会多花一步去分辨它们是不是同一件事。
 */

export const TOOL_NAMES = Object.freeze({
    // —— 角色描述
    DESC_READ: 'desc_read',
    DESC_APPEND: 'desc_append',
    DESC_REPLACE: 'desc_replace',
    DESC_REWRITE: 'desc_rewrite',

    // —— 世界书
    LORE_LIST: 'lore_list',
    LORE_READ: 'lore_read',
    LORE_ADD: 'lore_add',
    LORE_APPEND: 'lore_append',
    LORE_REPLACE: 'lore_replace',
    LORE_REWRITE: 'lore_rewrite',
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
