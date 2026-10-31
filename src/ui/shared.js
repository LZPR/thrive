/**
 * ui/shared.js · 界面模块共用的常量、提示、确认弹窗与面板开关状态
 *
 * 只有"谁都要用"的东西放这里。具体某一处界面的逻辑不该塞进来——
 * 那是 settings / panel / badge / status 各自的活。
 */

import { getContext } from '../../../../../extensions.js';

export const LOG = '[Thrive]';
export const BADGE_ID = 'thrive_badge';
export const PANEL_ID = 'thrive_panel';

/** 统一提示。没有 toastr 时退到 console，node 里跑也不会炸 */
export function toast(message) {
    if (globalThis.toastr?.info) {
        globalThis.toastr.info(message);
    } else {
        console.info(`${LOG} ${message}`);
    }
}

/**
 * 确认弹窗。拿不到 callPopup 时按"确认"处理——
 * 按钮本身就是一次明确动作，卡在弹窗里反而像没反应。
 *
 * 面板与设置页都要用（拒绝改动 / 换书），所以放在共用件里。
 *
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export async function askConfirm(message) {
    const ctx = getContext();

    try {
        if (typeof ctx.callPopup === 'function') {
            const choice = await ctx.callPopup(message, 'confirm');
            return choice === true || choice === 1;
        }
    } catch (err) {
        console.warn(`${LOG} 确认弹窗失败，按确认处理`, err);
    }

    return true;
}

/**
 * 面板开着没有。
 *
 * 它同时被三处读：面板自己（决定画不画）、徽章（aria-expanded 与 tooltip 末行）、
 * 刷新编排（要不要顺手重画面板）。谁都不该拿着别人模块里的变量写，所以放这儿。
 */
let panelOpen = false;

export function isPanelOpen() {
    return panelOpen;
}

/**
 * 只改状态，不刷界面。
 *
 * 刷界面统一走 refresh.js 的 setPanelOpen —— 否则"状态改了没重画"和
 * "重画了状态没改"会各出一半。
 */
export function markPanelOpen(open) {
    panelOpen = Boolean(open);
}
