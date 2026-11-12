/**
 * desc-entry.js · 角色描述保留条目的标识与存储模式
 *
 * 「统一使用世界书」模式把角色描述存成世界书里的一条常驻条目。
 * 这条条目有两个特殊身份，必须在**所有**入口用同一个判据识别，不能各写一份字符串：
 *   1. 它是插件自己的数据，模型侧的 lore_* 工具既不该看见它，也不该改它；
 *   2. 恢复快照 / 压缩扫描 / 面板渲染需要认出它，而不是把它当普通条目处理。
 *
 * 单独成文件是为了打断循环依赖：targets.js 要过滤它、还要在统一模式下算出"可写书就是这个
 * 角色同名书"，desc.js 要读写它，而 desc.js 反过来要用 targets.js 的读写原语。
 * 这里零依赖，三边都能直接 import。
 *
 * 存储模式也放在这里：它现在按**对话**保存（chat_metadata），store.js 建对话状态时要用这个
 * 枚举，而 store.js 不能反过来 import desc.js。
 */

/** 条目标题。带全角方括号，尽量不和人手写的标题撞名；
 * `lore_add` 会用 isReservedTitle 拦住同名新建。
 *
 * 注意：改这个常量等于换一条新条目 —— 老条目里的内容不会被自动搬过来。
 * 真要改就得连带写迁移，所以把它当格式常量看待。
 */
export const DESC_ENTRY_TITLE = '【角色描述】';
export const DESC_FORMAT = Object.freeze({
    TEXT: 'text',
    PLIST: 'plist',
    ALI_CHAT: 'alichat',
});
export const DESC_ENTRY_TITLES = Object.freeze({
    [DESC_FORMAT.TEXT]: DESC_ENTRY_TITLE,
    [DESC_FORMAT.PLIST]: '【角色描述 · PLists】',
    [DESC_FORMAT.ALI_CHAT]: '【角色描述 · Ali:Chat】',
});

/** 缺字段沿用自然文本；显式空数组表示不使用任何描述工具。 */
export function normalizeDescFormats(value) {
    return Array.isArray(value)
        ? Object.values(DESC_FORMAT).filter(format => value.includes(format))
        : [DESC_FORMAT.TEXT];
}

/** 存储模式：'card'（角色卡，默认）/ 'worldbook'（世界书条目） */
export const DESC_STORAGE = Object.freeze({
    CARD: 'card',
    WORLDBOOK: 'worldbook',
});

/**
 * 角色对应的世界书名。
 *
 * 直接用角色名：用户的心智模型是"这本书就是这个角色"，而且改名之后书还在那儿。
 *
 * 净化口径要跟服务端一致：`/api/worldinfo/edit` 用 sanitize-filename 落盘，它把非法字符
 * **直接删掉**（不是替换成下划线）。所以这里也删，否则"算出来的名字"和"落盘的名字"
 * 会对不上，创建完还要靠差集去猜——万一撞上同名的旧书，那份空模板会把旧书覆盖掉。
 *
 * @param {object|null} character
 * @returns {string} 空串 = 角色没有名字，不能拿来当书名
 */
export function descBookName(character) {
    return String(character?.name ?? '')
        // 控制字符与 Windows 不允许出现在文件名里的字符
        // eslint-disable-next-line no-control-regex -- Match host filename sanitization, including control characters.
        .replace(/[\u0000-\u001F\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .trim();
}

/**
 * 这个标题是不是保留给角色描述的。
 * @param {unknown} title
 * @returns {boolean}
 */
export function isReservedTitle(title) {
    return Object.values(DESC_ENTRY_TITLES).includes(String(title ?? '').trim());
}

/**
 * 这条条目是不是保留条目（按 comment 判定，与写入时的 upsert 主键一致）。
 * @param {object|null} entry
 * @returns {boolean}
 */
export function isReservedEntry(entry) {
    return isReservedTitle(entry?.comment);
}
