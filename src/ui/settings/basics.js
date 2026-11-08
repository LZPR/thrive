/**
 * ui/settings/basics.js · 「基本设置」组里与"新对话长什么样"相关的开关
 *
 * 三件事：新对话开不开学习模式、新对话开不开被动学习、要不要显示徽章。都跨对话一致；
 * 当前对话的开 / 关、被动判据与记录全在浮动面板里（ADR-043 / ADR-044）。
 */

import { getContext } from '../../../../../../extensions.js';
import { refreshUI } from '../refresh.js';
import { ensureSettings } from '../../store.js';
import { byId, syncCheckbox } from './common.js';

export function bindBasicsControls() {
    byId('thrive_enabled_by_default')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).enabledByDefault = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
    });

    /*
     * 只改"新对话的初值"，不动当前这一场：被动开关是对话级的（ADR-044），
     * 勾一下就把眼前的对话拨过去会很突兀——那件事在浮动面板里做。
     */
    byId('thrive_passive_by_default')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).passiveByDefault = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
    });

    byId('thrive_show_badge')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).showBadge = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        // 徽章就在聊天区里，改完立刻显示 / 隐藏
        refreshUI(ctx);
    });
}

/** @param {object} settings */
export function syncBasicsControls(settings) {
    syncCheckbox('thrive_enabled_by_default', settings.enabledByDefault);
    syncCheckbox('thrive_passive_by_default', settings.passiveByDefault);
    syncCheckbox('thrive_show_badge', settings.showBadge);
}
