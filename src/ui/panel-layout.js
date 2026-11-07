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
/**
 * 没拖过时面板底边离视口底部的距离。
 *
 * 这是**兜底值**：正常会去量发送区（`#send_form`）的实际高度。写死 88 是照着桌面端
 * 定的，竖屏手机上发送区会高出一大截，照着 88 摆就会压在输入框上面。
 */
const DEFAULT_BOTTOM_GAP = 88;
/** 面板再怎么挤也要留下这么高（标题栏 + 一行内容），否则连「收起」都点不到 */
const PANEL_MIN_VISIBLE = 160;

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
 * 视口尺寸。用 innerWidth/innerHeight 而不是 visualViewport：
 * 面板是 absolute 定位在初始包含块里的，坐标口径必须和它一致（见下面 pinPanel 的说明）。
 */
function viewportSize() {
    return {
        width: Number(window.innerWidth) || 0,
        height: Number(window.innerHeight) || 0,
    };
}

/**
 * 发送区（输入框那一排）在视口里占掉多少高度。
 *
 * 面板默认贴在右下角，让出的空隙是照着"桌面端发送区大约这么高"估的。竖屏手机上
 * 输入框会折行、按钮会换行，发送区高出一大截，按估的值摆就会和它叠在一起。
 * 所以能量就量：拿发送区顶边算实际要让出多少。
 *
 * 三个回落条件，都是为了别量出一个荒谬的值把面板压成一条缝：
 *   - 找不到发送区（没有对话、ST 还没画完）
 *   - 顶边在视口外或贴在最上面（被滚走了 / 拿到了别的容器）
 *   - 占掉超过视口 40%（正常发送区不可能这么高，多半是量错了对象）
 *
 * @param {number} vh 视口高度
 */
function bottomGap(vh) {
    const form = document.getElementById('send_form');
    const rect = form?.getBoundingClientRect?.();

    if (rect && rect.height > 0 && rect.top > vh * 0.2 && rect.top < vh) {
        const gap = Math.round(vh - rect.top + PANEL_MARGIN);
        if (gap < vh * 0.4) {
            return gap;
        }
    }

    return DEFAULT_BOTTOM_GAP;
}

/**
 * 把当前设置铺到面板上。
 *
 * 面板只有"开着 / 关着"两种状态，关着时整块 display:none，所以宽度与最大高度
 * 不需要分情况处理——收起态不再存在（那条横杠的职责已经交给徽章）。
 *
 * 三条约束按顺序成立，任何一条被违反都会表现为"面板错位叠在别的东西上"：
 *   1. 宽度不超过视口（竖屏手机 92vw 也可能顶出边框）
 *   2. 没拖过时底边让开发送区（`bottomGap`），高度上限再扣掉这块，于是顶边不会跑到屏幕外
 *   3. 拖过时坐标夹回视口，高度上限按"顶边到视口底部还剩多少"重算
 *
 * @param {HTMLElement} [panel]
 */
export function applyPanelLayout(panel = document.getElementById(PANEL_ID)) {
    if (!panel || dragSession) {
        // 拖动中不要按设置回摆，否则面板会在指针底下跳回旧位置
        return;
    }

    const layout = readPanelLayout(ensureSettings(getContext()));
    const view = viewportSize();

    panel.style.opacity = String(layout.opacity);

    // 宽度写成具体像素而不是 `min(…, 92vw)`：夹取要和下面的坐标夹取用同一口径，
    // 交给 CSS 算的话，这里就拿不到"面板实际多宽"，右边距会算错
    const width = Math.round(Math.max(160, Math.min(layout.width, view.width - PANEL_MARGIN * 2)));
    panel.style.width = `${width}px`;

    if (layout.pinned) {
        pinPanel(panel, layout.x, layout.y, width);
        return;
    }

    // 没拖过：贴着右下角，往上让出发送区
    const gap = bottomGap(view.height);
    const available = Math.max(PANEL_MIN_VISIBLE, view.height - gap - PANEL_MARGIN);
    panel.style.maxHeight = `${Math.round(Math.min(layout.height, available))}px`;
    panel.style.left = 'auto';
    panel.style.top = 'auto';
    panel.style.right = `${PANEL_MARGIN * 2}px`;
    panel.style.bottom = `${gap}px`;
}

/**
 * 把面板摆到（文档坐标下的）某个位置，并夹在视口内。
 *
 * 面板是 absolute 定位在初始包含块里的，style.left 用的是文档坐标；
 * getBoundingClientRect() 给的是视口坐标，两者差一个滚动量——ST 页面不滚动，
 * 但这里仍然换算，免得哪天外面套了一层可滚动的容器就整块跑偏。
 *
 * 高度上限按顶边重算：存下来的坐标可能是横屏时拖的，转到竖屏后底边已经贴到
 * 视口底部，那时剩下的地方只够这么高。先夹坐标、再按新坐标算高度，两件事必须同序，
 * 否则会出现"坐标夹进来了、高度还是旧的大值"，面板下半截挂到屏幕外。
 *
 * 收的是**坐标**而不是一份 layout：拖动时手里只有指针位置，没有 layout。
 * 早先这里收 `(panel, layout, view, width)` 四个参数，拖动那边按三个参数调，
 * `view` 拿到的是个数字，`view.width` 就是 undefined → 夹取结果 NaN →
 * `style.left = "NaNpx"`（浏览器直接忽略），面板拖一下就跳到左上角 (8, 8)。
 *
 * @param {HTMLElement} panel
 * @param {number} x 目标左边缘（文档坐标）
 * @param {number} y 目标上边缘（文档坐标）
 * @param {number} [width] 已夹过的面板宽度；不传就量当前的
 */
function pinPanel(panel, x, y, width = 0) {
    const layout = readPanelLayout(ensureSettings(getContext()));
    const view = viewportSize();
    const boxWidth = width > 0
        ? width
        : Math.round(panel.getBoundingClientRect().width) || PANEL_MIN_WIDTH;

    const maxLeft = Math.max(PANEL_MARGIN, view.width - boxWidth - PANEL_MARGIN);
    // 顶边最多摆到"只剩标题栏可见"，再往下就只能看到一条上边框
    const maxTop = Math.max(PANEL_MARGIN, view.height - PANEL_MIN_VISIBLE - PANEL_MARGIN);

    const viewX = clampNumber(x - window.scrollX, PANEL_MARGIN, maxLeft, PANEL_MARGIN);
    const viewY = clampNumber(y - window.scrollY, PANEL_MARGIN, maxTop, PANEL_MARGIN);

    const available = Math.max(PANEL_MIN_VISIBLE, view.height - viewY - PANEL_MARGIN);
    panel.style.maxHeight = `${Math.round(Math.min(layout.height, available))}px`;
    panel.style.left = `${Math.round(viewX + window.scrollX)}px`;
    panel.style.top = `${Math.round(viewY + window.scrollY)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

/**
 * 视口一变就重摆一次。
 *
 * 要接三种事件，它们各自解决一种"错位"：
 *   - resize：窗口缩小 / 移动端地址栏收起，会连发好几次，合并成一次
 *   - orientationchange：横竖屏切换。事件触发时 innerHeight 往往还是旧值，得等一拍
 *   - visualViewport.resize：软键盘弹出/收起只改可视区，不改 layout viewport，
 *     这条不接的话，竖屏下键盘一弹面板就被压在键盘底下
 *
 * 只改行内样式、不回写设置：转回横屏时还要回到用户拖的那个位置。
 */
export function bindPanelRelayout() {
    const relayout = () => {
        const panel = document.getElementById(PANEL_ID);
        if (!panel || panel.classList.contains('displayNone')) {
            return;
        }
        applyPanelLayout(panel);
    };

    let timer = 0;
    const schedule = delay => {
        clearTimeout(timer);
        timer = setTimeout(relayout, delay);
    };

    window.addEventListener('resize', () => schedule(60));
    window.addEventListener('orientationchange', () => schedule(150));
    window.visualViewport?.addEventListener('resize', () => schedule(60));
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
