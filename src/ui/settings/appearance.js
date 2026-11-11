/**
 * ui/settings/appearance.js · 「面板与窗口」组
 *
 * 两件不相干但都属"环境偏好"的事：浮动面板长什么样、压缩面板的入口。
 * 放在一组是因为都不会改变学习行为——调错了不影响写进去的内容。
 *
 * 旧工具日志那一段随 v0.33 一起删了：学习不在聊天请求里跑，聊天里也不再写工具日志，
 * 「把旧日志移出上下文」这件事已经没有对象可作用（ADR-050）。
 */

import { getContext } from '../../../../../../extensions.js';
import { ensureSettings, DEFAULT_SETTINGS } from '../../store.js';
import { openCompressPanel } from '../compress-panel.js';
import { applyPanelLayout } from '../panel-layout.js';
import { toast } from '../shared.js';
import { byId } from './common.js';

export function bindAppearanceControls() {
    bindPanelLayoutControls();
    bindCompressEntry();
}

/** @param {object} settings */
export function syncAppearanceControls(settings) {
    syncPanelLayoutControls(settings);
}

/* -------------------------------------------------------------- 面板布局 */

function bindPanelLayoutControls() {
    bindRange('thrive_panel_width', 'panelWidth', value => `${Math.round(value)} px`);
    bindRange('thrive_panel_height', 'panelHeight', value => `${Math.round(value)} px`);
    bindRange('thrive_panel_opacity', 'panelOpacity', value => `${Math.round(value * 100)}%`);

    byId('thrive_panel_reset')?.addEventListener('click', () => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);

        settings.panelX = DEFAULT_SETTINGS.panelX;
        settings.panelY = DEFAULT_SETTINGS.panelY;
        settings.panelWidth = DEFAULT_SETTINGS.panelWidth;
        settings.panelHeight = DEFAULT_SETTINGS.panelHeight;
        settings.panelOpacity = DEFAULT_SETTINGS.panelOpacity;

        ctx.saveSettingsDebounced?.();
        syncPanelLayoutControls(settings);
        applyPanelLayout();
        toast('面板已回到右下角，大小与不透明度恢复默认');
    });
}

/**
 * 滑块：拖动时立刻生效（input），松手才落盘（change）——每次 20px 都存一次盘没有意义。
 * @param {string} id 滑块 id，数值标签约定为 `${id}_value`
 * @param {'panelWidth'|'panelHeight'|'panelOpacity'} key
 * @param {(value: number) => string} format
 */
function bindRange(id, key, format) {
    const input = byId(id);
    if (!input) {
        return;
    }

    const label = byId(`${id}_value`);

    const commit = persist => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const value = Number(input.value);
        if (!Number.isFinite(value)) {
            return;
        }

        settings[key] = value;
        if (label) {
            label.textContent = format(value);
        }
        applyPanelLayout();

        if (persist) {
            ctx.saveSettingsDebounced?.();
        }
    };

    input.addEventListener('input', () => commit(false));
    input.addEventListener('change', () => commit(true));
}

function syncPanelLayoutControls(settings) {
    syncRange('thrive_panel_width', settings.panelWidth, value => `${Math.round(value)} px`);
    syncRange('thrive_panel_height', settings.panelHeight, value => `${Math.round(value)} px`);
    syncRange('thrive_panel_opacity', settings.panelOpacity, value => `${Math.round(value * 100)}%`);
}

/* -------------------------------------------------------------- 压缩入口 */

/**
 * 压缩面板的入口。放在这一组是因为它和浮动面板一样，是"打开一个窗口"的动作，
 * 与上面那些"改一个数字"的滑块分开读。
 *
 * 不做高亮、不做动效、不写条数：提醒的位置在浮动面板标题栏上，设置页不是常看的地方。
 * 改内容也只在压缩侧栏里做，设置页不该出现第二处能改正文的地方。
 */
function bindCompressEntry() {
    byId('thrive_compress_open')?.addEventListener('click', () => {
        if (!openCompressPanel(getContext())) {
            toast('压缩面板还没挂载，刷新页面再试');
        }
    });
}

function syncRange(id, value, format) {
    const input = byId(id);
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return;
    }

    // 正在拖这根滑块时不要回写 value，否则手上的滑块会被设回旧值、跳一下
    if (input && document.activeElement !== input) {
        input.value = String(num);
    }

    const label = byId(`${id}_value`);
    if (label) {
        label.textContent = format(num);
    }
}
