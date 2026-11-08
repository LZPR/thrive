/**
 * desc-entry.js · 角色描述保留条目的标识
 *
 * 「统一使用世界书」模式把角色描述存成世界书里的一条常驻条目。
 * 这条条目有两个特殊身份，必须在**所有**入口用同一个判据识别，不能各写一份字符串：
 *   1. 它是插件自己的数据，模型侧的 lore_* 工具既不该看见它，也不该改它；
 *   2. 恢复快照 / 压缩扫描 / 面板渲染需要认出它，而不是把它当普通条目处理。
 *
 * 单独成文件是为了打断循环依赖：targets.js 要过滤它，desc.js 要读写它，
 * 而 desc.js 反过来要用 targets.js 的读写原语。这里零依赖，两边都能直接 import。
 */

/**
 * 条目标题。带全角方括号，尽量不和人手写的标题撞名；
 * `lore_add` 会用 isReservedTitle 拦住同名新建。
 *
 * 注意：改这个常量等于换一条新条目 —— 老条目里的内容不会被自动搬过来。
 * 真要改就得连带写迁移，所以把它当格式常量看待。
 */
export const DESC_ENTRY_TITLE = '【角色描述】';

/**
 * 这个标题是不是保留给角色描述的。
 * @param {unknown} title
 * @returns {boolean}
 */
export function isReservedTitle(title) {
    return String(title ?? '').trim() === DESC_ENTRY_TITLE;
}

/**
 * 这条条目是不是保留条目（按 comment 判定，与写入时的 upsert 主键一致）。
 * @param {object|null} entry
 * @returns {boolean}
 */
export function isReservedEntry(entry) {
    return isReservedTitle(entry?.comment);
}
