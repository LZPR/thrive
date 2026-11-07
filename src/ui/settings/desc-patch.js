/**
 * ui/settings/desc-patch.js · 「描述改动先暂存」这个开关
 *
 * 独立成文件是因为它被两处用到：设置页的勾选框，以及浮动面板每次重绘都要更新
 * 这一行小字（面板里能写入 / 丢弃 diff，改完得让设置页跟上）。谁都能 import 它，
 * 它只依赖 refresh.js 与 store.js，不会成环。
 */

import { getContext } from '../../../../../../extensions.js';
import { getPatch, isUnresolved } from '../../patch.js';
import { ensureSettings } from '../../store.js';
import { setPanelOpen } from '../refresh.js';
import { PANEL_ID, toast } from '../shared.js';
import { byId, paintHint, syncCheckbox } from './common.js';

export function bindPatchControls() {
    const toggle = byId('thrive_patch_enabled');
    if (!toggle) {
        return;
    }

    toggle.addEventListener('change', function () {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const enabled = Boolean(this.checked);

        // spec §10：有 pending 时不允许静默丢弃。这里不弹"要不要一起丢掉"，
        // 只把开关拨回去——丢弃必须发生在面板里，用户得亲眼看一遍 diff
        if (!enabled && isUnresolved(getPatch(ctx))) {
            this.checked = true;
            toast('还有一份待处理的描述改动：请先在浮动面板里写入或丢弃');
            setPanelOpen(true, ctx);
            byId(PANEL_ID)?.scrollIntoView({ block: 'nearest' });
            return;
        }

        settings.patchEnabled = enabled;
        ctx.saveSettingsDebounced?.();
        updatePatchHint(ctx, settings);

        if (!enabled) {
            toast('之后的描述改动会直接写入角色卡');
        }
    });
}

/** @param {object} settings */
export function syncPatchCheck(settings) {
    syncCheckbox('thrive_patch_enabled', settings.patchEnabled);
}

/**
 * 暂存状态那一行。
 *
 * 默认（开着、没有待处理）不写任何字：checkbox 勾着就是"会暂存"，再复述一遍只是噪音。
 * 只有两种需要用户动手的情况才出声——关掉了，或者有一份 diff 等着处理。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updatePatchHint(ctx, settings) {
    if (settings.patchEnabled === false) {
        paintHint('thrive_patch_hint', '已关闭：改动直接落盘，只能靠上一版快照回退。', true);
        return;
    }

    if (isUnresolved(getPatch(ctx))) {
        paintHint('thrive_patch_hint', '有一份待处理改动，去浮动面板里写入或丢弃。', true);
        return;
    }

    paintHint('thrive_patch_hint', '');
}
