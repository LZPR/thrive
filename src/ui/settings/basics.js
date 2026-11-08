/**
 * ui/settings/basics.js · 「基本设置」组里与当前对话相关的两个开关
 *
 * 只有两件事：新对话开不开、要不要显示徽章。这两项都跨对话一致；当前对话的开 / 关、
 * 被动判据与记录全在浮动面板里，这一页不跟着对话变（ADR-043）。
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
    syncCheckbox('thrive_show_badge', settings.showBadge);
}
