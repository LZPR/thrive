/**
 * events.js · 面板重绘事件
 *
 * patch 变化、写入记录变化、快照被恢复——面板都得重绘一次。这些写入口分散在
 * patch.js / store.js / targets.js 里，谁都不该依赖 ui.js，所以统一发一个
 * document 事件，由 ui.js 订阅。
 *
 * 单独成文件是为了不制造 store.js ↔ patch.js 的循环 import。
 */

export const PANEL_EVENT = 'thrive:panel';

/** 被动学习"挂上 / 结算"时广播，界面据此刷新徽章并弹提示 */
export const PASSIVE_EVENT = 'thrive:passive';

/**
 * 通知面板重绘。非浏览器环境（node 里跑纯逻辑用例）没有 document，忽略即可。
 * @param {unknown} [detail] 仅用于调试，面板不依赖它
 */
export function notifyPanel(detail = null) {
    dispatch(PANEL_EVENT, detail);
}

/**
 * 通知被动学习状态变化。
 *
 * 由 passive.js 在触发/结算时发；ui.js 订阅它去弹 toast、刷徽章。
 * 走事件而不是直接调用：passive.js 不该知道界面长什么样，
 * 反过来 ui.js 又要 import passive.js（设置页的进度提示），直接互相 import 会成环。
 *
 * @param {object|null} [detail] `{ fired, reason, keyword }`
 */
export function notifyPassive(detail = null) {
    dispatch(PASSIVE_EVENT, detail);
}

function dispatch(name, detail) {
    try {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
        // 没有 document，或 CustomEvent 不可用：重绘只在浏览器里有意义
    }
}
