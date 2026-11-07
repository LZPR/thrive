/**
 * ui/settings/basics.js · 「基本设置」组里与当前对话相关的两个开关
 *
 * 只有两件事：新对话默认开不开、要不要显示徽章。当前对话的开 / 关本身不在这里——
 * 那是浮动面板里的开关，设置页只显示一行只读状态（见 ui/status.js）。
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
