/**
 * ui/settings/common.js · 设置页各模块共用的小工具
 *
 * 只放"每块都要用一次"的东西：取元素、回填勾选框、写状态提示、防抖落盘。
 * 任何一块设置自己的逻辑都不该往这里堆——那是同级各文件的事。
 *
 * 这里有一条写文案的约定，改界面时照着走：
 *   - 「这是什么、为什么这么设计」→ 放 settings.html 里那个「?」的展开块
 *   - 「现在是什么状态、哪里不对」→ 用下面的 paintHint 写进可见的小字
 */

/** 编辑防抖：内存里已经是新值，只把落盘推迟一点 */
export const SAVE_DELAY = 300;

let saveTimer = null;

/**
 * 排一次落盘。
 *
 * 关键词输入框与提示词编辑弹窗共用一个定时器：这两个地方都在"打字"，同一个人不会
 * 同时打两处，合并成一个既够用又不会在短时间内写两次盘。
 *
 * @param {object} ctx
 * @param {() => void} [after] 落盘之后再做的事（比如重算注入）
 */
export function scheduleSave(ctx, after) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        ctx.saveSettingsDebounced?.();
        after?.();
    }, SAVE_DELAY);
}

/** @param {string} id */
export function byId(id) {
    return document.getElementById(id);
}

/**
 * 回填一个勾选框。值没变就不动——正在点的那一下不该被重绘打断。
 * @param {string} id
 * @param {unknown} value
 */
export function syncCheckbox(id, value) {
    const el = byId(id);
    if (el && el.checked !== Boolean(value)) {
        el.checked = Boolean(value);
    }
}

/**
 * 写一段"现在是什么状态"的提示。
 *
 * 空串表示此刻没什么要说的——直接收起来，不留一行空白。
 * 这条规则让设置页在一切正常时是安静的：只有真的出了状况才多出一行字。
 *
 * @param {string} id
 * @param {string} text
 * @param {boolean} [warn] 是不是需要用户处理的状态
 */
export function paintHint(id, text, warn = false) {
    const el = byId(id);
    if (!el) {
        return;
    }

    const content = String(text ?? '').trim();
    el.textContent = content;
    el.classList.toggle('thrive-hint--warn', Boolean(warn) && Boolean(content));
    el.classList.toggle('displayNone', !content);
}
