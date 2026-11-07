/**
 * ui/refresh.js · 刷新编排 + 面板开关
 *
 * 界面有七块要看同一份状态：设置页的控件、设置页那行状态、设置页的被动提示、
 * 设置页顶部的环境诊断、世界书下拉、徽章、面板。它们各自在哪个文件里实现，
 * 这里不 import——各自把刷新函数登记到下面的表里。
 *
 * 为什么不直接 import：settings / panel / badge 在"绑定改了状态"时都要叫 refreshUI，
 * 反过来 refreshUI 又要调它们的刷新函数，直接互相 import 就是环。用一张登记表打平。
 */

import { getContext } from '../../../../../extensions.js';
import { getCompressSnapshot, requestCompressScan } from '../compress.js';
import { diagnoseEnvironment } from '../diagnostics.js';
import { COMPRESS_EVENT } from '../events.js';
import { syncFromContext } from '../prompt.js';
import {
    ensureSettings,
    getPending,
    getState,
    hasAnyModule,
    isChatAvailable,
    isEnabled,
    saveChat,
    setEnabled,
} from '../store.js';
import { COMPRESS_ID, isPanelOpen, markPanelOpen, toast } from './shared.js';

/* ------------------------------------------------------------ 分区登记表 */

/**
 * 键是"一块界面"，值是把当前状态刷进这块界面的函数；界面自己登记（各文件末尾），
 * 刷新时按这张表逐个刷。默认是空操作：node 里跑纯逻辑用例时没有任何界面，
 * 整条链路在这里断掉，省得每处都判断 document 在不在。
 *
 * 签名统一是 view 对象，分区自己挑要用的字段——加一块界面不用改别人的参数表。
 */
const SURFACES = {
    /** 设置页：各控件按现状回填 */
    controls: () => {},
    /** 设置页：顶部的环境诊断 */
    diagnostics: () => {},
    /** 设置页：「当前对话」那一行 */
    status: () => {},
    /** 设置页：被动学习那段说明 */
    passiveHint: () => {},
    /** 设置页：世界书下拉的选项 */
    books: () => {},
    /** 聊天区：徽章 */
    badge: () => {},
    /** 聊天区：浮动面板 */
    panel: () => {},
    /** 聊天区：压缩面板 */
    compressPanel: () => {},
    /** 浮动面板标题栏上那颗压缩按钮（条数角标与高亮） */
    compressEntry: () => {},
};

/**
 * 登记一块界面的刷新函数。重复登记以最后一次为准。
 * @param {Record<string, (view: object) => void>} patch
 */
export function registerSurfaces(patch) {
    for (const [name, fn] of Object.entries(patch)) {
        if (!(name in SURFACES)) {
            // 拼错名字会让那块界面永远不刷新，宁可吵一句
            console.warn(`[Thrive] 未知的界面分区：${name}`);
            continue;
        }
        SURFACES[name] = fn;
    }
}

/**
 * 把一份状态交给一块界面。
 * @param {string} name
 * @param {object} view
 */
function paint(name, view) {
    SURFACES[name](view);
}

/* -------------------------------------------------------------- 面板开关 */

/**
 * 开 / 关浮动面板。
 *
 * 徽章点击（走 PANEL_TOGGLE_EVENT）、`/thrive panel`、「收起」按钮、
 * 设置页的「立即触发一次」——都从这里走，保证"面板开着没有"只有一份状态，
 * 不会出现徽章说开着、面板却没了。
 *
 * 放在刷新编排里而不是 panel.js：它要同时重画面板与徽章，是两处界面的协调动作。
 *
 * @param {boolean} open
 * @param {object} [ctx]
 */
export function setPanelOpen(open, ctx = getContext()) {
    markPanelOpen(open);
    paint('panel', { ctx });
    // 面板可见性变了，徽章的 aria-expanded 与 tooltip 末行要跟上；
    // 顺带把设置页那行状态也刷一遍，代价很小
    refreshBadgeOnly(ctx);
}

/* ------------------------------------------------------------------ 刷新 */

/**
 * 把当前对话的状态同步到徽章与面板。切换聊天后必须调用。
 * @param {object} [ctx]
 */
export function refreshUI(ctx = getContext()) {
    const settings = ensureSettings(ctx);

    // 没有可写模块时整个扩展无从谈起：对话里还开着就顺手关掉，
    // 否则徽章亮着"学习"、模型却一个工具都看不到。
    // 放在这里也兜住"手改 settings.json 把两个模块都关了"的情况。
    if (!hasAnyModule(settings) && isEnabled(ctx)) {
        setEnabled(ctx, false);
        syncFromContext(ctx);
        toast('两个模块都关着，学习模式已自动关闭');
    }

    // 被动学习的待学习同理：留着它只会在徽章上闪一个永远不会生效的「待学」
    if (!hasAnyModule(settings) && getPending(ctx)) {
        getState(ctx).passive.pending = null;
        saveChat(ctx);
    }

    const available = isChatAvailable(ctx);
    // 每次都现算：用户可能刚在 ST 面板里改了函数调用开关，缓存下来的结论会撒谎
    const diag = diagnoseEnvironment(ctx);

    const view = { ctx, settings, available, diag };
    paint('diagnostics', view);
    paint('badge', view);
    paint('status', view);
    paint('controls', view);
    paint('panel', view);

    // 换角色/换对话后，选项上的"角色自带/卡内嵌"标注会变，重新铺一遍
    void paint('books', view);

    /*
     * 顺手排一次"哪些内容超长"的检查。扫描要读世界书，所以去抖；
     * 结果变了会发 COMPRESS_EVENT，各入口自己重画（见 bindCompressRefresh）。
     */
    requestCompressScan(ctx);
}

/**
 * 只刷徽章与"当前对话"那一行，不重建世界书下拉。
 *
 * 每发一条消息都要跑一次被动学习评估，评估完徽章得立刻变（否则"待学"要等到
 * 下次打开设置页才看见）。走 refreshUI 会顺带重建下拉列表，没必要。
 *
 * @param {object} [ctx]
 */
export function refreshBadgeOnly(ctx = getContext()) {
    const settings = ensureSettings(ctx);
    const available = isChatAvailable(ctx);
    const diag = diagnoseEnvironment(ctx);

    const view = { ctx, settings, available, diag };
    paint('badge', view);
    paint('status', view);
    paint('passiveHint', view);

    /*
     * 面板里也有这两个开关与「待学」提示。开着就顺手同步一次——
     * 否则被动学习在发消息时触发了，徽章的灯在闪、面板里却还写着"都没开"。
     * 关着的时候 refreshPanel 会直接返回，不会白算。
     */
    if (isPanelOpen()) {
        paint('panel', view);
    }
}

/* ------------------------------------------------------------ 压缩结果广播 */

/**
 * 压缩扫描结果变了：刷浮动面板标题栏上那颗按钮，以及压缩侧栏自己。
 *
 * 由 compress.js 广播、这里订阅，是因为"结果变了该重画什么"属于界面编排，
 * 扫描那一边不该知道有几个窗口在看着它。
 *
 * @param {object} [snapshot]
 */
export function refreshCompressEntry(snapshot = getCompressSnapshot()) {
    const view = { ctx: getContext(), snapshot };
    paint('compressEntry', view);
    paint('compressPanel', view);
}

/** 闪烁用的定时器：连续来几次新条目时只保留最后一次，别叠成一个长亮 */
let flashTimer = 0;

/**
 * 让标题栏那颗压缩按钮闪几下。
 *
 * 只在浮动面板开着时调用：按钮就在面板标题栏里，面板关着时它根本不在屏幕上。
 * 重绘会重建 DOM，所以这个函数必须在 refreshCompressEntry 之后调。
 */
function flashCompressEntry() {
    const button = document.querySelector('#thrive_panel [data-thrive-action="open-compress"]');
    if (!button) {
        return;
    }

    clearTimeout(flashTimer);
    button.classList.remove('is-flash');
    // 读一次布局强制重排：连续两次新增时，class 不重新生效动画就不会重播
    void button.offsetWidth;
    button.classList.add('is-flash');

    flashTimer = setTimeout(() => {
        button.classList.remove('is-flash');
    }, 2600);
}

/**
 * 订阅压缩事件。由 index.js 在初始化时调一次。
 *
 * 徽章与浮动面板顶部都带"几条超长"，它们走 refreshBadgeOnly 一起刷——
 * 那里面本来就包括"面板开着就顺手重画"，不用再单独调一次。
 */
export function bindCompressRefresh() {
    document.addEventListener(COMPRESS_EVENT, event => {
        refreshCompressEntry();
        refreshBadgeOnly(getContext());

        const added = event?.detail?.added ?? [];
        if (added.length === 0) {
            return;
        }

        /*
         * 压缩侧栏正开着：用户已经在处理了，闪烁与提示都是打扰。
         * 浮动面板开着：按钮就在标题栏上，闪两下比弹 toast 轻，也不挡内容。
         * 两个都关着：按钮看不见，只能弹一句告诉用户去哪儿处理。
         */
        if (isCompressPanelVisible()) {
            return;
        }

        const head = added.length === 1 ? `「${added[0]}」` : `「${added[0]}」等 ${added.length} 条`;

        if (isPanelOpen()) {
            flashCompressEntry();
            return;
        }

        toast(`${head}超过软提醒，可以在压缩面板里处理（/thrive compress）`);
    });
}

/** 压缩面板现在开着没有。放在这里判断，是为了不把 compress-panel 再 import 进来 */
function isCompressPanelVisible() {
    const panel = document.getElementById(COMPRESS_ID);
    return Boolean(panel) && !panel.classList.contains('displayNone');
}
