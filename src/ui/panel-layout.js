/**
 * ui/panel-layout.js · 面板的位置、尺寸、透明度与拖拽
 *
 * 单独一个文件是因为两个地方都要动它：设置页的滑块（改了就立刻套用）与面板自己
 * （内容换了高度、窗口变了、拖动落盘）。面板的绘制与交互不需要知道这些细节。
 *
 * 所有写入只经 applyPanelLayout 一个出口——拖动改 left、滑块改 width，两条路径
 * 各写一套迟早会打架，谁也不知道该以谁为准。
 */

import { getContext } from '../../../../../extensions.js';
import { DEFAULT_SETTINGS, ensureSettings } from '../store.js';
import { PANEL_ID } from './shared.js';

/**
 * 拖动会话：{ pointerId, offsetX, offsetY, moved }，按下标题栏时建立，松手清空。
 * 放在模块级是因为 move / up 两个监听器都要看它。
 */
let dragSession = null;

/** 浮动面板的尺寸/透明度取值范围，设置页的滑块与这里的夹取必须一致 */
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 900;
const PANEL_MIN_HEIGHT = 200;
const PANEL_MAX_HEIGHT = 900;
const PANEL_MIN_OPACITY = 0.3;
/** 拖动时面板与视口边缘留的空隙：全贴边会让边框看不清，也不好再抓起来 */
const PANEL_MARGIN = 8;

/* -------------------------------------------------------------- 面板布局 */

/**
 * 面板的位置、尺寸、透明度都由设置决定，统一走 applyPanelLayout 写到行内样式。
 *
 * 为什么不做成拖拽 + 设置各写一套：两条路径写同一个 DOM 迟早会打架
 * （拖动改了 left，滑块改了 width，谁也不知道该以谁为准）。这里只有一个出口。
 */

/** 数字夹取。设置文件被手改过时也能拿到能用的值。 */
function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.min(Math.max(num, min), max);
}

/**
 * 从设置里读出一份可用的布局。
 * 位置用 -1 表示"还没拖过"，此时走 CSS 里的右下角。
 */
function readPanelLayout(settings) {
    const x = Number(settings.panelX);
    const y = Number(settings.panelY);
    const pinned = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0;

    return {
        pinned,
        x: pinned ? x : -1,
        y: pinned ? y : -1,
        width: Math.round(clampNumber(settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, DEFAULT_SETTINGS.panelWidth)),
        height: Math.round(clampNumber(settings.panelHeight, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, DEFAULT_SETTINGS.panelHeight)),
        opacity: clampNumber(settings.panelOpacity, PANEL_MIN_OPACITY, 1, DEFAULT_SETTINGS.panelOpacity),
    };
}

/**
 * 把当前设置铺到面板上。
 *
 * 面板只有"开着 / 关着"两种状态，关着时整块 display:none，所以宽度与最大高度
 * 不需要分情况处理——收起态不再存在（那条横杠的职责已经交给徽章）。
 *
 * @param {HTMLElement} [panel]
 */
export function applyPanelLayout(panel = document.getElementById(PANEL_ID)) {
    if (!panel || dragSession) {
        // 拖动中不要按设置回摆，否则面板会在指针底下跳回旧位置
        return;
    }

    const layout = readPanelLayout(ensureSettings(getContext()));

    panel.style.opacity = String(layout.opacity);
    // 再叠一个 vw/vh 上限：窗口窄于设置值时不该顶出屏幕
    panel.style.width = `min(${layout.width}px, 92vw)`;
    panel.style.maxHeight = `min(${layout.height}px, calc(100vh - 24px))`;

    if (layout.pinned) {
        pinPanel(panel, layout.x, layout.y);
        return;
    }

    // 没拖过：交回 CSS 的右下角，顺手清掉之前拖出来的行内位置
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
}

/**
 * 把面板摆到（文档坐标下的）某个位置，并夹在视口内。
 *
 * 面板是 absolute 定位在初始包含块里的，style.left 用的是文档坐标；
 * getBoundingClientRect() 给的是视口坐标，两者差一个滚动量——ST 页面不滚动，
 * 但这里仍然换算，免得哪天外面套了一层可滚动的容器就整块跑偏。
 *
 * @param {HTMLElement} panel
 * @param {number} left 文档坐标
 * @param {number} top 文档坐标
 */
function pinPanel(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - rect.width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - rect.height - PANEL_MARGIN);

    const viewX = clampNumber(left - window.scrollX, PANEL_MARGIN, maxLeft, PANEL_MARGIN);
    const viewY = clampNumber(top - window.scrollY, PANEL_MARGIN, maxTop, PANEL_MARGIN);

    panel.style.left = `${Math.round(viewX + window.scrollX)}px`;
    panel.style.top = `${Math.round(viewY + window.scrollY)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

/**
 * 拖动。按下标题栏开始，移动时把面板跟到指针位置，松手落盘。
 *
 * move/up 挂在 document 上而不是面板上：指针一快就会离开面板，
 * 挂在面板上需要 setPointerCapture，而它在某些嵌入环境里不可靠。
 */
export function bindDrag() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    panel.addEventListener('pointerdown', event => {
        if (event.button > 0) {
            return;
        }
        // 只有标题栏能抓：正文里要能选词、复制 diff，整块可拖会把它变成"一拖就动"
        if (!event.target.closest('.thrive-panel__bar')) {
            return;
        }
        // 按钮、链接、输入控件照常点击，不要变成拖动
        if (event.target.closest('[data-thrive-action], button, a, input, textarea, select')) {
            return;
        }

        const rect = panel.getBoundingClientRect();
        dragSession = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            // 只是点了一下标题栏、没真的挪动时别把默认的右下角变成固定坐标
            moved: false,
        };

        panel.classList.add('thrive-panel--dragging');
        document.body.classList.add('thrive-panel-dragging');
        event.preventDefault();
    });

    document.addEventListener('pointermove', event => {
        if (!dragSession || event.pointerId !== dragSession.pointerId) {
            return;
        }

        const current = document.getElementById(PANEL_ID);
        if (!current) {
            return;
        }

        pinPanel(
            current,
            event.clientX + window.scrollX - dragSession.offsetX,
            event.clientY + window.scrollY - dragSession.offsetY,
        );
        dragSession.moved = true;
        event.preventDefault();
    });

    const finish = event => {
        if (!dragSession || event.pointerId !== dragSession.pointerId) {
            return;
        }

        const moved = dragSession.moved;
        dragSession = null;
        document.body.classList.remove('thrive-panel-dragging');

        const current = document.getElementById(PANEL_ID);
        if (!current) {
            return;
        }
        current.classList.remove('thrive-panel--dragging');

        if (!moved) {
            return;
        }

        const x = Number.parseFloat(current.style.left);
        const y = Number.parseFloat(current.style.top);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }

        // 位置按屏幕记住，不按对话：换个聊天面板还在原地
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        settings.panelX = Math.round(x);
        settings.panelY = Math.round(y);
        ctx.saveSettingsDebounced?.();
    };

    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
}
