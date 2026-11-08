/**
 * ui/settings/desc-patch.js · 「描述改动先暂存」这个开关
 *
 * 设置页里剩下的只是"要不要暂存"这个跨对话一致的选择。暂存出来的那一份 diff、
 * 有没有待处理，都只属于当前对话——那些在浮动面板里看，这一页不跟着对话变（ADR-043）。
 */

import { getContext } from '../../../../../../extensions.js';
import { isWorldbookDesc } from '../../desc.js';
import { getPatch, isUnresolved } from '../../patch.js';
import { ensureSettings } from '../../store.js';
import { setPanelOpen } from '../refresh.js';
import { PANEL_ID, toast } from '../shared.js';
import { byId, paintHint } from './common.js';

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
        updatePatchHint(settings);

        if (!enabled) {
            toast('之后的描述改动会直接写入角色卡');
        }
    });
}

/** @param {object} settings */
export function syncPatchCheck(settings) {
    const el = byId('thrive_patch_enabled');
    if (!el) {
        return;
    }

    // 统一模式没有 patch 这回事：置灰而不是隐藏，用户能看出"这个开关还在，只是不管用了"
    const unified = isWorldbookDesc(settings);
    el.disabled = unified;
    const wanted = unified ? false : Boolean(settings.patchEnabled);
    if (el.checked !== wanted) {
        el.checked = wanted;
    }
}

/**
 * 暂存状态那一行。
 *
 * 默认（开着、没有待处理）不写任何字：checkbox 勾着就是"会暂存"，再复述一遍只是噪音。
 * 只有两种跨对话一致的情况才出声——关掉了，或者当前是统一模式（这个开关不管用）。
 * "有一份待处理改动"属于当前对话，那由浮动面板说，这一页不跟着对话变。
 *
 * @param {object} settings
 */
export function updatePatchHint(settings) {
    if (isWorldbookDesc(settings)) {
        paintHint('thrive_patch_hint', '统一模式下不做暂存：描述直接写进世界书条目，也不提供 diff。', false);
        return;
    }

    if (settings.patchEnabled === false) {
        paintHint('thrive_patch_hint', '已关闭：改动直接落盘，只能靠上一版快照回退。', true);
        return;
    }

    paintHint('thrive_patch_hint', '');
}
