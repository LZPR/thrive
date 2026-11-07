/**
 * ui/compress-panel.js · 压缩面板（左侧常驻侧栏）
 *
 * 这是"超长内容"唯一的处理入口：列出超过软提醒的世界书条目与角色描述，用户可以
 * 就地改、也可以勾选后走智能压缩（待接线）。它和浮动面板是两个东西——浮动面板
 * 回答"现在是什么状态"，这里处理"哪段内容太长了"。
 *
 * 形态是贴窗口左边的侧栏，不是浮在中间的弹窗：这个窗口不能拖（拖拽只给浮动面板做了），
 * 浮在中间既挡聊天区又挪不走。位置写死在 CSS 里，宽度跟着视口走，开合只是切 display。
 *
 * 三块职责：
 *   - 渲染：整块重画，但**编辑中的那一行不重画**（会把正在敲的字冲掉）
 *   - 交互：勾选、展开编辑、保存、关闭、重新扫描
 *   - 数据：一切以 compress.js 的快照为准，自己不缓存正文
 *
 * 入口在浮动面板标题栏（图标 + 条数，超长时点亮、新增时闪烁）与设置页「数值与上限」
 * 组的按钮上，两处都调 openCompressPanel。
 */

import { getContext } from '../../../../../extensions.js';
import {
    getCompressSnapshot,
    refreshCompressState,
    saveManualEdit,
    smartCompress,
} from '../compress.js';
import { ensureSettings } from '../store.js';
import { escapeHtml, truncate } from '../util.js';
import { refreshCompressEntry, registerSurfaces } from './refresh.js';
import { COMPRESS_ID, LOG, toast } from './shared.js';

/** 预览给多少字：够看出这条在说什么，又不至于把列表撑成一堵墙 */
const PREVIEW_CHARS = 180;

/** 当前展开编辑的那条：`{ id, value }`；null = 没有在编辑 */
let openEditor = null;

/** 勾选的条目 id。只影响"将来批量处理"，现在不改任何内容 */
let picked = new Set();

/** 重绘签名：内容没变就不碰 DOM（否则每次广播都会把滚动位置弹回顶部） */
let signature = null;

/* ------------------------------------------------------------------ 挂载 */

export function initCompressPanel() {
    if (document.getElementById(COMPRESS_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${COMPRESS_ID}" class="thrive-compress displayNone" role="dialog"
            aria-label="Thrive 压缩面板"></div>`,
    );

    const panel = document.getElementById(COMPRESS_ID);
    if (!panel) {
        console.warn(`${LOG} 压缩面板创建失败`);
        return;
    }

    // 内容整块重绘，所以事件挂在窗口外壳上
    panel.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);

    // 键盘：Esc 关窗口。挂在 document 上——焦点可能在任何一行里
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isCompressPanelOpen()) {
            closeCompressPanel();
        }
    });
}

export function isCompressPanelOpen() {
    const panel = document.getElementById(COMPRESS_ID);
    return Boolean(panel) && !panel.classList.contains('displayNone');
}

/**
 * 打开面板。每次打开都重扫一遍：面板里显示的必须是**此刻盘上**的内容，
 * 而快照可能是十分钟前那个聊天里扫出来的。
 *
 * 面板平时是关着的，重扫是异步的，所以这里先按旧快照画一次（打开就有东西看），
 * 扫描回来再经 COMPRESS_EVENT 重画。
 *
 * @param {object} [ctx]
 */
export function openCompressPanel(ctx = getContext()) {
    const panel = document.getElementById(COMPRESS_ID);
    if (!panel) {
        toast('压缩面板还没挂载，刷新页面再试');
        return false;
    }

    panel.classList.remove('displayNone');
    signature = null;
    refreshCompressPanel(ctx, true);
    // 贴左边的常驻侧栏，不做 scrollIntoView：那会去滚页面，侧栏本身不动
    void refreshCompressState(ctx);
    return true;
}

export function closeCompressPanel() {
    const panel = document.getElementById(COMPRESS_ID);
    if (!panel) {
        return;
    }

    // 关掉就等于放弃这次编辑：不提示，因为草稿从来没离开过这个窗口
    openEditor = null;
    panel.classList.add('displayNone');
    signature = null;
}

/* ------------------------------------------------------------------ 重绘 */

/**
 * 按当前快照重画。
 *
 * 编辑中直接返回：扫描是异步的，随时可能回来一次（比如刚生成完一条回复），
 * 而重建 DOM 会把 textarea 连同光标一起扔掉。等用户保存或取消时再重画。
 *
 * @param {object} [ctx]
 * @param {boolean} [force] 编辑中也要重画（展开 / 收起编辑框时用）
 */
export function refreshCompressPanel(ctx = getContext(), force = false) {
    const panel = document.getElementById(COMPRESS_ID);
    if (!panel || !isCompressPanelOpen()) {
        signature = null;
        return;
    }

    if (openEditor && !force) {
        return;
    }

    const snapshot = getCompressSnapshot();

    // 勾选集合跟着内容走：条目被删掉 / 被压到阈值以下之后，它的 id 不该留在里面
    const alive = new Set(snapshot.items.map(item => item.id));
    for (const id of [...picked]) {
        if (!alive.has(id)) {
            picked.delete(id);
        }
    }

    const signatureNext = JSON.stringify([
        snapshot.error,
        snapshot.book,
        snapshot.descPending,
        snapshot.items.map(item => [item.id, item.chars, item.level]),
    ]);
    if (signatureNext === signature) {
        return;
    }
    signature = signatureNext;

    /*
     * 重画会重建整块 DOM，滚动位置跟着回到顶部。面板里这种重画是常事（扫描结果、
     * 保存后重算），用户正翻到第五条第 "保存" 完一下子跳回开头就很难受了。
     */
    const scrollTop = panel.querySelector('.thrive-compress__body')?.scrollTop ?? 0;
    panel.innerHTML = renderPanel(snapshot);
    const body = panel.querySelector('.thrive-compress__body');
    if (body && scrollTop > 0) {
        body.scrollTop = scrollTop;
    }
    updatePickedLabel(panel);
}

function renderPanel(snapshot) {
    const { items } = snapshot;

    return `
        <div class="thrive-compress__bar">
            <i class="fa-solid fa-compress thrive-compress__icon" aria-hidden="true"></i>
            <span class="thrive-compress__title">压缩</span>
            <span class="thrive-compress__bar-meta">${escapeHtml(summaryText(snapshot))}</span>
            <div class="menu_button thrive-compress__close" data-act="close"
                title="关闭窗口（Esc）。已经勾选或编辑中的内容不会被保存">关闭</div>
        </div>
        <div class="thrive-compress__body">
            ${renderLimits(snapshot)}
            ${renderNotices(snapshot)}
            ${items.length > 0 ? `<div class="thrive-compress__list">${items.map(renderItem).join('')}</div>` : renderEmpty(snapshot)}
        </div>
        <div class="thrive-compress__foot">
            <div class="menu_button thrive-compress__ghost" data-act="pick-all"
                title="全部勾选 / 全部取消">全选</div>
            <span class="thrive-compress__picked">${escapeHtml(pickedText())}</span>
            <div class="menu_button thrive-compress__smart" data-act="smart" data-state="todo"
                title="智能压缩还没接线：点它只会说明原因，不会改动内容">智能压缩所选（待实现）</div>
            <div class="menu_button thrive-compress__ghost" data-act="rescan"
                title="重新读一遍世界书与角色描述，按当前上限重算">重新扫描</div>
        </div>
        <div class="thrive-compress__tip">
            勾选目前只是标记，方便你分几批处理；真正改内容要靠每行的「编辑」。
        </div>`;
}

/**
 * 标题右侧那句话：几条、几条超硬上限。
 *
 * 书名不在这里：侧栏只有四百来字宽，标题 + 条数 + 书名 + 关闭按钮挤一行，
 * 被省略号吃掉的正好是书名。它挪到下面的口径行独占一行（见 renderLimits）。
 */
function summaryText(snapshot) {
    const count = snapshot.items.length;
    if (count === 0) {
        return '没有超长内容';
    }
    const hard = snapshot.items.filter(item => item.level === 'hard').length;
    return `${count} 条超过软提醒${hard > 0 ? ` · ${hard} 条超硬上限` : ''}`;
}

/** 顶部那行口径：软提醒用来列表，硬上限用来拒绝写入 */
function renderLimits(snapshot) {
    const { limits } = snapshot;
    const book = snapshot.book
        ? `<span class="thrive-compress__book">可写书「${escapeHtml(snapshot.book)}」</span>`
        : '';

    if (!limits.entrySoft && !limits.descSoft) {
        return book ? `<div class="thrive-compress__limits">${book}</div>` : '';
    }

    return `<div class="thrive-compress__limits">
        ${book}
        <span>软提醒：条目 ${limits.entrySoft} 字 · 描述 ${limits.descSoft} 字</span>
        <span>硬上限：${limits.entryHard} / ${limits.descHard} 字</span>
        <small>超过软提醒才列在这里；硬上限仍然拒绝模型的写入，与这里无关。</small>
    </div>`;
}

function renderNotices(snapshot) {
    const notes = [];

    if (snapshot.error) {
        notes.push(`<div class="thrive-compress__notice thrive-compress__notice--warn">${escapeHtml(snapshot.error)}</div>`);
    }

    if (snapshot.descPending) {
        notes.push(`<div class="thrive-compress__notice">有一份待确认的描述改动还没应用，它不计入这里的统计——`
            + '下面算的是角色卡上现在那份。</div>');
    }

    return notes.join('');
}

function renderEmpty(snapshot) {
    return `<div class="thrive-compress__empty">
        <i class="fa-solid fa-check" aria-hidden="true"></i>
        <span>${snapshot.error ? '世界书那部分没读到，可写模块里没有超长内容。'
            : '现在没有需要压缩的内容：所有条目标题下的正文都在软提醒之内。'}</span>
    </div>`;
}

function renderItem(item) {
    const editing = openEditor?.id === item.id;
    const value = editing ? openEditor.value : item.text;
    const checked = picked.has(item.id);
    const isDesc = item.kind === 'desc';

    const meta = isDesc
        ? `角色描述 · ${item.chars} 字（软 ${item.soft} / 硬 ${item.hard}）`
        : `世界书「${item.book}」 · ${item.chars} 字（软 ${item.soft} / 硬 ${item.hard}）`;

    const tag = item.level === 'hard' ? '超硬上限' : '超软提醒';

    return `
        <article class="thrive-compress__item thrive-compress__item--${item.level}${checked ? ' is-picked' : ''}"
            data-item="${escapeHtml(item.id)}" data-kind="${item.kind}">
            <div class="thrive-compress__row">
                <label class="thrive-compress__pick" data-act="pick"
                    title="勾选（不影响内容，只用于批量标记）">
                    <input type="checkbox" ${checked ? 'checked' : ''}>
                </label>
                <span class="thrive-compress__item-title">${escapeHtml(item.title)}</span>
                <span class="thrive-compress__tag">${tag}</span>
                <div class="menu_button thrive-compress__edit" data-act="edit"
                    title="就地改这段正文">${editing ? '编辑中' : '编辑'}</div>
            </div>
            <div class="thrive-compress__item-meta">${escapeHtml(meta)}</div>
            ${editing ? '' : `<div class="thrive-compress__preview">${escapeHtml(previewOf(item.text))}</div>`}
            <div class="thrive-compress__editor${editing ? '' : ' displayNone'}"
                data-hard="${item.hard}" data-soft="${item.soft}">
                <textarea class="text_pole thrive-block-text" rows="10" spellcheck="false"
                    aria-label="${escapeHtml(item.title)} 的正文">${escapeHtml(value)}</textarea>
                <div class="thrive-compress__editor-foot">
                    <span class="thrive-compress__count">${escapeHtml(countText(value, item))}</span>
                    <div class="menu_button thrive-compress__ghost" data-act="cancel">取消</div>
                    <div class="menu_button thrive-compress__save" data-act="save">保存</div>
                </div>
            </div>
        </article>`;
}

function previewOf(text) {
    const cut = truncate(String(text ?? ''), PREVIEW_CHARS);
    return cut.truncated ? `${cut.text} …` : cut.text;
}

function countText(value, item) {
    const chars = String(value ?? '').length;
    return `${chars} / ${item.hard} 字（软 ${item.soft}）`;
}

function pickedText() {
    return picked.size > 0 ? `已选 ${picked.size} 条` : '未勾选';
}

/* ------------------------------------------------------------------ 交互 */

function onClick(event) {
    const trigger = event.target.closest('[data-act]');
    if (!trigger) {
        return;
    }

    const action = trigger.dataset.act;
    const panel = document.getElementById(COMPRESS_ID);
    const row = trigger.closest('[data-item]');
    const id = row?.dataset.item ?? '';

    switch (action) {
        case 'close':
            closeCompressPanel();
            break;

        case 'pick':
            // 自己接管勾选：label 的默认行为会把 checkbox 翻一次，我们又手动改一次，
            // 两者叠加就会「点了没反应」
            event.preventDefault();
            togglePick(id);
            break;

        case 'pick-all':
            togglePickAll();
            break;

        case 'edit':
            beginEdit(id);
            break;

        case 'cancel':
            openEditor = null;
            signature = null;
            refreshCompressPanel();
            break;

        case 'save':
            void save(id, panel);
            break;

        case 'smart':
            reportSmartCompress();
            break;

        case 'rescan':
            toast('正在重新读取世界书与角色描述…');
            void refreshCompressState(getContext()).then(() => {
                signature = null;
                refreshCompressPanel();
            });
            break;

        default:
            break;
    }
}

/** 编辑框里打字：只更新草稿与字数，不重绘 */
function onInput(event) {
    if (!openEditor || event.target.tagName !== 'TEXTAREA') {
        return;
    }

    openEditor.value = event.target.value;

    const editor = event.target.closest('.thrive-compress__editor');
    const label = editor?.querySelector('.thrive-compress__count');
    if (!editor || !label) {
        return;
    }

    const hard = Number(editor.dataset.hard) || 0;
    const soft = Number(editor.dataset.soft) || 0;
    const chars = event.target.value.length;

    label.textContent = `${chars} / ${hard} 字（软 ${soft}）`;
    label.classList.toggle('thrive-count--warn', hard > 0 && chars > hard);
}

function togglePick(id) {
    if (!id) {
        return;
    }

    if (picked.has(id)) {
        picked.delete(id);
    } else {
        picked.add(id);
    }

    // 只改这一行和页脚，不整块重绘——重绘会连带把别的行的滚动位置弹回去
    const panel = document.getElementById(COMPRESS_ID);
    const row = panel?.querySelector(`[data-item="${cssEscape(id)}"]`);
    row?.classList.toggle('is-picked', picked.has(id));
    const box = row?.querySelector('.thrive-compress__pick input');
    if (box) {
        box.checked = picked.has(id);
    }
    updatePickedLabel(panel);
}

function togglePickAll() {
    const items = getCompressSnapshot().items;
    const all = items.length > 0 && items.every(item => picked.has(item.id));
    picked = all ? new Set() : new Set(items.map(item => item.id));

    const panel = document.getElementById(COMPRESS_ID);
    for (const item of items) {
        const row = panel?.querySelector(`[data-item="${cssEscape(item.id)}"]`);
        row?.classList.toggle('is-picked', picked.has(item.id));
        const box = row?.querySelector('.thrive-compress__pick input');
        if (box) {
            box.checked = picked.has(item.id);
        }
    }
    updatePickedLabel(panel);
}

function updatePickedLabel(panel = document.getElementById(COMPRESS_ID)) {
    const label = panel?.querySelector('.thrive-compress__picked');
    if (label) {
        label.textContent = pickedText();
    }
}

/**
 * 展开某一条的编辑框。
 *
 * 已经在编辑另一条时不让切换：那会把没保存的改动直接丢掉，而面板里没有任何
 * "草稿还在"的提示。说一句话比默默丢弃强。
 */
function beginEdit(id) {
    if (!id) {
        return;
    }

    if (openEditor?.id === id) {
        return;
    }

    if (openEditor) {
        toast('先把正在编辑的那条保存或取消');
        return;
    }

    const item = getCompressSnapshot().items.find(entry => entry.id === id);
    if (!item) {
        toast('这条内容已经不在列表里了，重新扫描一次');
        signature = null;
        refreshCompressPanel();
        return;
    }

    openEditor = { id, value: item.text };
    signature = null;
    refreshCompressPanel(getContext(), true);

    // 重画之后焦点落到这一条的编辑框上，省一次点击
    const area = document.getElementById(COMPRESS_ID)?.querySelector(`[data-item="${cssEscape(id)}"] textarea`);
    area?.focus();
}

async function save(id, panel) {
    if (!openEditor || openEditor.id !== id) {
        return;
    }

    const item = getCompressSnapshot().items.find(entry => entry.id === id);
    if (!item) {
        toast('这条内容已经不在列表里了，重新扫描一次');
        openEditor = null;
        signature = null;
        refreshCompressPanel();
        return;
    }

    panel?.classList.add('thrive-compress--busy');

    try {
        const result = await saveManualEdit(getContext(), item, openEditor.value);

        if (!result.ok) {
            toast(result.hint ?? `保存失败：${result.error}`);
            return;
        }

        openEditor = null;
        signature = null;
        picked.delete(id);

        toast(item.kind === 'desc'
            ? `角色描述已压到 ${result.chars} 字`
            : `「${item.title}」已压到 ${result.chars} 字（原 ${result.beforeChars} 字）`);

        // 重扫：这条可能已经低于软提醒，不该继续留在列表里
        await refreshCompressState(getContext());
        refreshCompressPanel();
        refreshCompressEntry();
    } finally {
        panel?.classList.remove('thrive-compress--busy');
    }
}

/**
 * 智能压缩（占位）。真正接线之前，这里只把"为什么不能点"说清楚，
 * 以及说明勾选目前只影响标记。
 */
function reportSmartCompress() {
    const ctx = getContext();
    const items = getCompressSnapshot().items.filter(item => picked.has(item.id));
    const result = smartCompress(ctx, ensureSettings(ctx), items);
    toast(result.hint);
}

/** id 里可能带引号、竖线、空格——拼进选择器前先转义 */
function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}

/* 登记给刷新编排：扫描结果变了就按新快照重画 */
registerSurfaces({
    compressPanel: ({ ctx }) => refreshCompressPanel(ctx),
});
