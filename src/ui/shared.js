/**
 * ui/shared.js · 界面模块共用的常量、提示、确认弹窗与面板开关状态
 *
 * 只有"谁都要用"的东西放这里。具体某一处界面的逻辑不该塞进来——
 * 那是 settings / panel / badge / status 各自的活。
 */

import { getContext } from '../../../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../../../popup.js';

export const LOG = '[Thrive]';
export const BADGE_ID = 'thrive_badge';
export const PANEL_ID = 'thrive_panel';
/** 压缩面板：与浮动面板是两个独立窗口，各有各的 id 与开关状态 */
export const COMPRESS_ID = 'thrive_compress';
/** 虚拟世界书：第三个独立窗口，入口在浮动面板标题栏 */
export const DRAFT_ID = 'thrive_draft';
/** 提示词编辑器：第四个独立窗口，入口在设置页「提示词」折叠块 */
export const PROMPT_WINDOW_ID = 'thrive_prompts';
/** 教授：第五个独立窗口，入口在浮动面板的学习分区 */
export const TEACH_ID = 'thrive_teach';

/** 统一提示。没有 toastr 时退到 console，node 里跑也不会炸 */
export function toast(message) {
    if (globalThis.toastr?.info) {
        globalThis.toastr.info(message);
    } else {
        console.info(`${LOG} ${message}`);
    }
}

/**
 * 确认弹窗。
 *
 * 用 ST 新的 `callGenericPopup`（POPUP_TYPE.CONFIRM）而不是旧的 `callPopup`：
 * 旧接口那套 `#dialogue_popup` 在现在的主题下按钮会被压成"一个字一行"，
 * 中文尤其明显（是 / 取消 竖着排）。新弹窗的按钮宽度跟着文字走。
 *
 * 按钮文案默认「确定 / 取消」，删除这类破坏性动作用 `okButton: '删除'`
 * 把动作写进按钮里，别让人只看正文猜。
 *
 * 新接口拿不到（版本不同）时退回旧接口；两个都没有就按"确认"处理——
 * 按钮本身就是一次明确动作，卡在弹窗里反而像没反应。
 *
 * @param {string} message
 * @param {{ okButton?: string, cancelButton?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function askConfirm(message, { okButton = '确定', cancelButton = '取消' } = {}) {
    try {
        const result = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton, cancelButton });
        return result === POPUP_RESULT.AFFIRMATIVE;
    } catch (err) {
        console.warn(`${LOG} 通用确认弹窗失败，退回旧接口`, err);
    }

    try {
        const ctx = getContext();
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
