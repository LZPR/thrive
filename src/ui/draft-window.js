/**
 * ui/draft-window.js · 虚拟世界书窗口
 *
 * 第三个独立窗口（前两个是浮动面板与压缩侧栏），入口只有一处：浮动面板标题栏上
 * 那颗书页图标。它回答一个问题——**模型这几笔到底改了什么，值不值得留。**
 *
 * 窗口是**对外只读**的：条目名、触发条件、正文差异都只能看。要改内容，让模型改，
 * 或者干脆丢弃重来。唯一两个动作都属于用户：保存到真实世界书、丢弃。
 *
 * 为什么不做成"第二本世界书编辑器"：能就地改的话，缓冲区里就会出现一处不是模型写的、
 * 也不是世界书编辑器写的内容，第三套真值。而且真要做编辑，判重、关键词校验、长度
 * 上限每一条都得在这里再实现一遍——那些规则本来只在工具那条路径上。
 *
 * 只显示**会被记录下来的参数**：标题、关键词与组合方式、正文、常驻 / 停用。
 * order、position、probability 这些工具从来不碰，摆出来只会让人以为它们可能变。
 */

import { getContext } from '../../../../../extensions.js';
import { buildDiffRows } from '../diff.js';
import { PANEL_EVENT } from '../events.js';
import { summarizeDraft } from '../draft.js';
import { buildDraftView, commitDraft, discardDraft } from '../targets.js';
import { escapeHtml } from '../util.js';
import { refreshUI, registerSurfaces } from './refresh.js';
import { DRAFT_ID, LOG, askConfirm, toast } from './shared.js';

/** 上次渲染用的签名：内容没变就不重建 DOM（重绘会把滚动位置弹回顶部） */
let signature = null;

/** 未改动的条目默认收起：一屏应该先看到"变了什么"，而不是整本书 */
let showSame = false;

/** 保存 / 丢弃进行中 */
let busy = false;

/** 异步重绘的代次：连点两下时只让最后一次的结果落地 */
let viewToken = 0;

/** 拖动会话 */
let drag = null;

/* ------------------------------------------------------------------ 挂载 */

export function initDraftWindow() {
    if (document.getElementById(DRAFT_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${DRAFT_ID}" class="thrive-draft displayNone" role="dialog"
            aria-label="虚拟世界书"></div>`,
    );

    const win = document.getElementById(DRAFT_ID);
    if (!win) {
        console.warn(`${LOG} 虚拟世界书窗口创建失败`);
        return;
    }

    // 内容整块重绘，事件挂在外壳上
    win.addEventListener('click', onClick);
    win.addEventListener('pointerdown', onPointerDown);

    // 生成过程中工具在写缓冲区：这笔改动要立刻出现在窗口里
    document.addEventListener(PANEL_EVENT, () => {
        if (isDraftWindowOpen()) {
            void refreshDraftWindow(getContext());
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isDraftWindowOpen()) {
            closeDraftWindow();
        }
    });

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
}

export function isDraftWindowOpen() {
    const win = document.getElementById(DRAFT_ID);
    return Boolean(win) && !win.classList.contains('displayNone');
}

/**
 * 打开窗口。
 *
 * 每次打开都重算一遍：窗口关着的时候模型可能又写了好几笔，拿上次那份渲染只会
 * 让用户对着过期的 diff 做决定。
 *
 * @param {object} [ctx]
 * @returns {boolean}
 */
export function openDraftWindow(ctx = getContext()) {
    const win = document.getElementById(DRAFT_ID);
    if (!win) {
        toast('虚拟世界书窗口还没挂载，刷新页面再试');
        return false;
    }

    win.classList.remove('displayNone');
    signature = null;
    void refreshDraftWindow(ctx);
    return true;
}

export function closeDraftWindow() {
    const win = document.getElementById(DRAFT_ID);
    if (!win) {
        return;
    }

    win.classList.add('displayNone');
    signature = null;
    // 拖动留下的行内坐标一并清掉：下次打开回到默认落点
    win.style.left = '';
    win.style.top = '';
    win.style.transform = '';
}

/** 关掉窗口没关缓冲区：它一直在那儿，直到用户保存或丢弃 */

/* ------------------------------------------------------------------ 重绘 */

/**
 * 按当前状态重画。
 * @param {object} [ctx]
 */
export async function refreshDraftWindow(ctx = getContext()) {
    const win = document.getElementById(DRAFT_ID);
    if (!win || !isDraftWindowOpen()) {
        signature = null;
        return;
    }

    const token = ++viewToken;
    let view;
    try {
        view = await buildDraftView(ctx);
    } catch (err) {
        console.warn(`${LOG} 读取虚拟世界书失败`, err);
        view = { ok: false, error: 'READ_FAILED', hint: '读不出虚拟世界书的内容，详情见控制台。' };
    }

    // 期间又开了另一次重绘：这次的结果可能已经过期
    if (token !== viewToken || !isDraftWindowOpen()) {
        return;
    }

    const next = JSON.stringify([
        view.ok,
        view.exists,
        view.book,
        view.diskChanged,
        view.writable,
        showSame,
        (view.items ?? []).map(item => [
            item.uid,
            item.status,
            item.bufferTouched,
            item.before.length,
            item.after.length,
            item.keys.join('|'),
            item.keysBefore.join('|'),
            item.logic,
        ]),
    ]);
    if (next === signature) {
        return;
    }
    signature = next;

    const scrollTop = win.querySelector('.thrive-draft__body')?.scrollTop ?? 0;
    win.innerHTML = renderWindow(view);
    const body = win.querySelector('.thrive-draft__body');
    if (body && scrollTop > 0) {
        body.scrollTop = scrollTop;
    }
}

/**
 * 整块渲染。
 * @param {object} view buildDraftView 的结果
 */
function renderWindow(view) {
    return `
        ${renderBar(view)}
        <div class="thrive-draft__body">${renderBody(view)}</div>
        ${renderFoot(view)}`;
}

function renderBar(view) {
    const book = view.book ? `「${view.book}」` : '';
    const counts = view.counts ?? { added: 0, changed: 0, removed: 0, total: 0 };
    const pieces = [];
    if (counts.added > 0) {
        pieces.push(`新增 ${counts.added}`);
    }
    if (counts.changed > 0) {
        pieces.push(`改写 ${counts.changed}`);
    }
    if (counts.removed > 0) {
        pieces.push(`移除 ${counts.removed}`);
    }

    const summary = view.exists
        ? (pieces.length > 0 ? pieces.join(' · ') : '没有改动')
        : '空的';

    return `
        <div class="thrive-draft__bar" title="按住可拖动窗口">
            <i class="fa-solid fa-book-open thrive-draft__icon" aria-hidden="true"></i>
            <span class="thrive-draft__title">虚拟世界书</span>
            <span class="thrive-draft__meta">${escapeHtml([book, summary].filter(Boolean).join(' · '))}</span>
            <div class="menu_button thrive-draft__close" data-act="close"
                title="关闭窗口（Esc）。缓冲区本身还在，改动不会丢">关闭</div>
        </div>`;
}

function renderBody(view) {
    const notices = [];

    if (view.ok === false) {
        notices.push(`<div class="thrive-draft__notice thrive-draft__notice--warn">`
            + `${escapeHtml(view.hint ?? view.error)}</div>`);
    } else if (view.exists === false) {
        return `<div class="thrive-draft__empty">
            <i class="fa-solid fa-feather-pointed" aria-hidden="true"></i>
            <span>虚拟世界书是空的。模型下一次往世界书写东西时，改动会先落在这里。</span>
        </div>`;
    }

    if (view.diskChanged) {
        notices.push(`<div class="thrive-draft__notice thrive-draft__notice--warn">
            真实世界书在这本缓冲区开出来之后被改动过（可能你在世界书编辑器里改的）。
            保存会把整本换成下面这份，那些改动会被覆盖——差多少可以对照每一条的 diff。
        </div>`);
    }

    if (view.writable && view.book && view.writable !== view.book) {
        notices.push(`<div class="thrive-draft__notice">
            这一场对话的可写书现在是「${escapeHtml(view.writable)}」，工具会写到那本去；
            这块缓冲区还停在「${escapeHtml(view.book)}」，保存前先确认要的是哪一本。
        </div>`);
    }

    if (view.ok === false) {
        return notices.join('');
    }

    const changed = view.changed ?? [];
    const same = (view.items ?? []).filter(item => item.status === 'same');

    if (changed.length === 0) {
        notices.push(`<div class="thrive-draft__notice">这本书和真实世界书一字不差，没有可保存的改动。</div>`);
    }

    const rows = [
        ...changed.map(item => renderEntry(item)),
        same.length > 0 ? renderSameGroup(same) : '',
    ].filter(Boolean);

    return `${notices.join('')}<div class="thrive-draft__list">${rows.join('')}</div>`;
}

function renderSameGroup(same) {
    const label = `${same.length} 条未改动`;

    if (!showSame) {
        return `<div class="menu_button thrive-draft__more" data-act="toggle-same"
            title="这些条目和真实世界书一样，点开可以核对">${escapeHtml(label)}</div>`;
    }

    return `${same.map(item => renderEntry(item)).join('')}
        <div class="menu_button thrive-draft__more" data-act="toggle-same" title="收起未改动的条目">收起${escapeHtml(label)}</div>`;
}

/**
 * 一条条目。
 *
 * diff 只画正文：关键词、标题这类短字段的变化用"加号 / 减号"标在旁边比逐字 diff 好读。
 * 未改动的条目不画 diff（那是满满一屏"什么都没变"）。
 */
function renderEntry(item) {
    const status = item.status;
    /*
     * 「改写」是工具改的；「磁盘已变」是这一条在真实世界书那边被改过、缓冲区还停在旧版本，
     * 保存会把那边的新内容盖回去。两者都表现为差异，但一个是"要保存的"，一个是"会被覆盖的"。
     */
    const tagKind = status === 'changed' && !item.bufferTouched ? 'disk' : status;
    const tag = {
        added: '新增',
        changed: '改写',
        disk: '磁盘已变',
        removed: '将被移除',
        same: '未改动',
    }[tagKind] ?? '';
    const keys = status === 'removed' ? item.keysBefore : item.keys;
    const logic = status === 'removed' ? item.logicBefore : item.logic;

    const keyChips = keys.length > 0
        ? keys.map(key => `<span class="thrive-draft__key">${escapeHtml(key)}</span>`).join('')
        : '<span class="thrive-draft__key thrive-draft__key--none">无关键词</span>';

    const keyDelta = renderKeyDelta(item);
    const flags = [
        item.constant ? '<span class="thrive-draft__flag">常驻</span>' : '',
        item.disabled ? '<span class="thrive-draft__flag thrive-draft__flag--off">停用</span>' : '',
    ].filter(Boolean).join('');

    const rows = status === 'same' ? [] : buildDiffRows(item.before, item.after);

    return `
        <article class="thrive-draft__entry thrive-draft__entry--${status}">
            <div class="thrive-draft__entry-head">
                <span class="thrive-draft__entry-title">${escapeHtml(item.title || '（无标题）')}</span>
                <span class="thrive-draft__tag thrive-draft__tag--${tagKind}">${escapeHtml(tag)}</span>
            </div>
            <div class="thrive-draft__keys">
                <span class="thrive-draft__keys-label">触发</span>
                ${keyChips}
                <span class="thrive-draft__logic">${escapeHtml(logic)}</span>
                ${keyDelta}
                ${flags}
            </div>
            ${rows.length > 0 ? renderDiff(rows) : ''}
        </article>`;
}

/** 关键词的增删：只在真的变了的时候出现 */
function renderKeyDelta(item) {
    if (item.status !== 'changed') {
        return '';
    }

    const added = item.keys.filter(key => !item.keysBefore.includes(key));
    const removed = item.keysBefore.filter(key => !item.keys.includes(key));
    if (added.length === 0 && removed.length === 0) {
        return '';
    }

    return [
        ...added.map(key => `<span class="thrive-draft__key-delta thrive-draft__key-delta--add">+${escapeHtml(key)}</span>`),
        ...removed.map(key => `<span class="thrive-draft__key-delta thrive-draft__key-delta--del">−${escapeHtml(key)}</span>`),
    ].join('');
}

function renderDiff(rows) {
    const html = rows.map(row => {
        if (row.type === 'fold') {
            return `<div class="thrive-diff__row thrive-diff__row--fold">⋯ ${row.count} 行未改动</div>`;
        }

        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
        const text = row.text === '' ? '&nbsp;' : escapeHtml(row.text);

        return `<div class="thrive-diff__row thrive-diff__row--${row.type}">`
            + `<span class="thrive-diff__sign">${sign}</span>`
            + `<span class="thrive-diff__text">${text}</span>`
            + '</div>';
    });

    return `<div class="thrive-diff">${html.join('')}</div>`;
}

/**
 * 页脚。两个动作都是用户的：模型没有任何路径能触发它们。
 *
 * 「保存」在有改动时才是主按钮；一块空缓冲区只留「丢弃」——保存空的东西没有意义。
 */
function renderFoot(view) {
    const changed = view.ok !== false && view.exists ? (view.changed ?? []).length : 0;
    const hint = changed > 0
        ? '保存 = 把整本换成上面这份，真实世界书里未列出的条目会被移除；每条都会留一份可恢复的快照。'
        : '这里没有会写进真实世界书的动作。';

    const discard = `<div class="menu_button thrive-draft__ghost" data-act="discard"
        title="丢掉这块缓冲区，真实世界书保持原样">丢弃缓冲区</div>`;

    const save = changed > 0
        ? `<div class="menu_button thrive-draft__save" data-act="save"
            title="写进真实世界书；写入前会再确认一次">保存到真实世界书</div>`
        : '';

    return `
        <div class="thrive-draft__foot">
            <small class="thrive-draft__hint">${escapeHtml(hint)}</small>
            ${discard}
            ${save}
        </div>`;
}

/* ------------------------------------------------------------------ 交互 */

function onClick(event) {
    const trigger = event.target.closest('[data-act]');
    const action = trigger?.dataset.act;
    if (!action) {
        return;
    }

    switch (action) {
        case 'close':
            closeDraftWindow();
            break;
        case 'toggle-same':
            showSame = !showSame;
            signature = null;
            void refreshDraftWindow();
            break;
        case 'save':
            void saveAndReport();
            break;
        case 'discard':
            void discardAndReport();
            break;
        default:
            break;
    }
}

/**
 * 保存到真实世界书。
 *
 * 确认文案分两种：磁盘没动过时说"要把这几条写进去"；动过时必须说清"会覆盖你在
 * 编辑器里改的东西"——那一步是不可逆的（除了逐条恢复），不该和普通保存共用一句话。
 */
async function saveAndReport() {
    if (busy) {
        return;
    }

    const ctx = getContext();
    const win = document.getElementById(DRAFT_ID);
    const info = summarizeDraft(ctx);

    if (!info.exists) {
        toast('虚拟世界书已经空了');
        void refreshDraftWindow(ctx);
        return;
    }

    // 文档里的现算一遍：用户可能刚刚在世界书编辑器里保存过
    let view = null;
    try {
        view = await buildDraftView(ctx);
    } catch (err) {
        console.warn(`${LOG} 保存前读取差异失败`, err);
    }

    const changed = view?.ok && view.exists ? view.changed.length : info.touched;
    if (changed === 0) {
        toast('这本书和真实世界书一字不差，不用保存');
        return;
    }

    const diskChanged = Boolean(view?.ok && view.diskChanged);
    const message = diskChanged
        ? `「${info.book}」在缓冲区开出来之后被改动过。保存会把整本换成缓冲区这份，`
            + `那些改动会被覆盖（${changed} 条变化，每条都会留一份可恢复的快照）。确定吗？`
        : `把 ${changed} 条变化写进「${info.book}」？真实世界书里没有列在下面的条目会被移除，`
            + '每条都会留一份可恢复的快照。';

    if (!(await askConfirm(message))) {
        return;
    }

    busy = true;
    win?.classList.add('thrive-draft--busy');

    try {
        const result = await commitDraft(ctx, { force: diskChanged });

        if (!result.ok) {
            toast(result.hint ?? `保存失败：${result.error}`);
            signature = null;
            await refreshDraftWindow(ctx);
            return;
        }

        toast(result.action === 'empty'
            ? '没有可保存的改动，缓冲区已清空'
            : `已写进「${result.book}」：${result.written} 条变化${result.removed > 0 ? `，移除 ${result.removed} 条` : ''}`);

        refreshUI(ctx);
        closeDraftWindow();
    } finally {
        busy = false;
        win?.classList.remove('thrive-draft--busy');
    }
}

/** 丢弃：有改动才确认，空缓冲区直接收掉 */
async function discardAndReport() {
    if (busy) {
        return;
    }

    const ctx = getContext();
    const info = summarizeDraft(ctx);
    if (!info.exists) {
        closeDraftWindow();
        return;
    }

    if (info.touched > 0) {
        const confirmed = await askConfirm(
            `丢弃后这 ${info.touched} 条改动就没了，真实世界书保持原样。确定丢弃吗？`,
        );
        if (!confirmed) {
            return;
        }
    }

    busy = true;
    const win = document.getElementById(DRAFT_ID);
    win?.classList.add('thrive-draft--busy');

    try {
        const result = discardDraft(ctx);
        if (!result.ok) {
            toast(result.hint ?? `丢弃失败：${result.error}`);
            return;
        }

        toast('已丢弃缓冲区，真实世界书没有变化');
        refreshUI(ctx);
        closeDraftWindow();
    } finally {
        busy = false;
        win?.classList.remove('thrive-draft--busy');
    }
}

/* ------------------------------------------------------------------ 拖动 */

/**
 * 拖动窗口。按在标题栏上才开始，按钮与正文里的选区照旧。
 *
 * 没有做位置记忆：它是个临时窗口，用完就关；记下来反而多一个"为什么它在这儿"。
 */
function onPointerDown(event) {
    const win = document.getElementById(DRAFT_ID);
    if (!win || event.button > 0 || !event.target.closest('.thrive-draft__bar')) {
        return;
    }
    if (event.target.closest('[data-act], button, a')) {
        return;
    }

    const rect = win.getBoundingClientRect();
    // 默认落点是 transform 居中：第一次动它时先换算成确定的 left/top，否则一拖就跳
    win.style.transform = 'none';
    win.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    win.style.top = `${Math.round(rect.top + window.scrollY)}px`;

    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    win.classList.add('thrive-draft--dragging');
    document.body.classList.add('thrive-panel-dragging');
    event.preventDefault();
}

function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
        return;
    }

    const win = document.getElementById(DRAFT_ID);
    if (!win) {
        return;
    }

    const width = win.getBoundingClientRect().width || 480;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 80);

    const left = Math.min(Math.max(event.clientX - drag.offsetX, 8), maxLeft);
    const top = Math.min(Math.max(event.clientY - drag.offsetY, 8), maxTop);

    win.style.left = `${Math.round(left + window.scrollX)}px`;
    win.style.top = `${Math.round(top + window.scrollY)}px`;
    event.preventDefault();
}

function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
        return;
    }

    drag = null;
    document.getElementById(DRAFT_ID)?.classList.remove('thrive-draft--dragging');
    document.body.classList.remove('thrive-panel-dragging');
}

/*
 * 登记给刷新编排：换对话、切落点、开关模式都可能把这本缓冲区换掉或换书。
 * 刷新是异步的（要读真实世界书那份来比），所以这里吞掉异常——窗口画不出来
 * 不该把整条刷新链路带断。
 */
registerSurfaces({
    draftWindow: ({ ctx }) => {
        void refreshDraftWindow(ctx).catch(err => console.warn(`${LOG} 刷新虚拟世界书窗口失败`, err));
    },
});
