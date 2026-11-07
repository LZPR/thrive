/**
 * events.js · 界面之间、以及业务模块到界面的事件
 *
 * patch 变化、写入记录变化、快照被恢复——面板都得重绘一次。这些写入口分散在
 * patch.js / store.js / targets.js 里，谁都不该依赖界面层，所以统一发一个
 * document 事件，由 ui/ 下订阅它的那一处处理。
 *
 * 徽章点击也走这里：徽章与面板是两个文件，徽章不该 import 面板，面板也不该
 * 反过来 import 徽章。
 *
 * 单独成文件是为了不制造 store.js ↔ patch.js 的循环 import。
 */

export const PANEL_EVENT = 'thrive:panel';

/** 被动学习"挂上 / 结算"时广播，界面据此刷新徽章并弹提示 */
export const PASSIVE_EVENT = 'thrive:passive';

/** 徽章被点了：请求开 / 关浮动面板。谁开谁关由刷新编排决定 */
export const PANEL_TOGGLE_EVENT = 'thrive:panel-toggle';

/**
 * 超长内容的扫描结果变了。
 *
 * 扫描是异步的（要读世界书），而徽章、浮动面板入口、设置页那行、压缩面板都是
 * 同步渲染的——中间必须有一份"最近一次结果"，并且结果变了要有人通知它们重画。
 * compress.js 只负责广播，谁订阅谁自己刷。
 */
export const COMPRESS_EVENT = 'thrive:compress';

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
 * 由 passive.js 在触发/结算时发；ui/badge.js 订阅它去弹 toast、刷徽章。
 * 走事件而不是直接调用：passive.js 不该知道界面长什么样，
 * 反过来界面又要 import passive.js（设置页的进度提示），直接互相 import 会成环。
 *
 * @param {object|null} [detail] `{ fired, reason, keyword }`
 */
export function notifyPassive(detail = null) {
    dispatch(PASSIVE_EVENT, detail);
}

/** 请求开 / 关浮动面板（徽章点击就是这一下）。 */
export function notifyPanelToggle() {
    dispatch(PANEL_TOGGLE_EVENT, null);
}

function dispatch(name, detail) {
    try {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
        // 没有 document，或 CustomEvent 不可用：界面事件只在浏览器里有意义
    }
}
