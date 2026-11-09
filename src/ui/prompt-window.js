/**
 * ui/prompt-window.js · 提示词编辑器（独立窗口）
 *
 * 第四个独立窗口（面板 / 压缩侧栏 / 虚拟世界书之后），入口只有一处：设置页
 * 「提示词」折叠块里的按钮。标题栏也能拖，Esc 关闭。
 *
 * 它替掉了设置页里那一列只能拖、只能改正文的卡片。这里能做的事：
 *   · 新增 / 删除 / 改名自建提示词（内置卡不能删，只能停用）
 *   · 逐条启用 / 停用（停用只影响注入，正文留着）
 *   · 逐条选角色（系统 / 用户 / 助手）——注入时按角色切成不同的段
 *   · 拖动排序；「其它提示词」是分界线，拖它等于把卡片整体送进系统区或尾部
 *   · 导入 SillyTavern 预设（有损，规则见 prompt-import.js）
 *
 * 为什么独立成窗口而不是加厚设置页：一张提示词动辄几百字，设置页那条 480px
 * 的栏里连正文都看不全；而且导入要预览"进来多少条、跳过了什么"，这需要一个
 * 能摊开的地方。设置页只留一个入口与一行摘要。
 *
 * 与压缩面板的编辑约法一致：同一时刻只展开一条，切走 / 关闭窗口就放弃未保存的
 * 内容（不弹二次确认），因为草稿从来没离开过这个窗口。
 */

import { getContext } from '../../../../../extensions.js';
import {
    PROMPT_ROLE,
    PROMPT_CARD_META,
    addCustomPrompt,
    buildInjection,
    countChars,
    deleteCustomPrompt,
    findCustomPrompt,
    getCardSettingKey,
    getCardState,
    getCardText,
    getCustomPrompts,
    getPromptName,
    getPromptOrder,
    getPromptRole,
    isCustomPrompt,
    isPromptEnabled,
    resetPromptText,
    roleLabel,
    setPromptEnabled,
    setPromptRole,
    setPromptText,
    syncFromContext,
} from '../prompt.js';
import { CARD_ID, isHeadCard, normalizeOrder } from '../prompt-order.js';
import { applyPresetImport, importErrorMessage, parseStPreset } from '../prompt-import.js';
import { ensureSettings } from '../store.js';
import { escapeHtml, fnv1a, truncate } from '../util.js';
import { refreshUI, registerSurfaces } from './refresh.js';
import { LOG, PROMPT_WINDOW_ID, askConfirm, toast } from './shared.js';

/** 状态角标文案 */
const STATE_LABEL = Object.freeze({
    on: '生效中',
    idle: '未生效',
    cond: '条件触发',
});

/** 名称 / 正文预览截断长度 */
const PREVIEW_CHARS = 90;

/** 当前展开编辑的那条：`{ id, name, text, role, isNew, dirty }`；null = 没在编辑 */
let editing = null;

/** 重绘签名：内容没变就不碰 DOM（重绘会把滚动位置弹回顶部） */
let signature = null;

/** jQuery UI 拖动会话中：这段时间不整块重绘 */
let dragging = false;

/** 打开文件选择框时先记下"谁点的"，导入完成后好把焦点还回去 */
let importBusy = false;

/** 拖动窗口的状态 */
let drag = null;

/* ------------------------------------------------------------------ 挂载 */

export function initPromptWindow() {
    if (document.getElementById(PROMPT_WINDOW_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${PROMPT_WINDOW_ID}" class="thrive-prompts displayNone" role="dialog"
            aria-label="Thrive 提示词编辑器">
            <div class="thrive-prompts__bar" title="按住可拖动窗口">
                <i class="fa-solid fa-table-list thrive-prompts__icon" aria-hidden="true"></i>
                <span class="thrive-prompts__title">提示词</span>
                <span class="thrive-prompts__meta"></span>
                <div class="menu_button thrive-prompts__act" data-act="add" title="新建一条提示词">新增</div>
                <div class="menu_button thrive-prompts__act" data-act="import"
                    title="从 SillyTavern 预设 JSON 有损导入：保留正文、角色、启用状态与顺序">导入预设</div>
                <div class="menu_button thrive-prompts__close" data-act="close"
                    title="关闭窗口（Esc）。未保存的编辑会丢弃">关闭</div>
            </div>
            <div class="thrive-prompts__body"></div>
            <div class="thrive-prompts__foot">
                <small class="thrive-prompts__hint"></small>
                <div class="menu_button thrive-prompts__ghost" data-act="reset-order"
                    title="内置卡回到默认顺序；自建提示词接在尾部">默认顺序</div>
            </div>
            <input id="thrive_prompts_file" class="displayNone" type="file"
                accept=".json,application/json" aria-hidden="true">
        </div>`,
    );

    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win) {
        console.warn(`${LOG} 提示词窗口创建失败`);
        return;
    }

    win.addEventListener('click', onClick);
    win.addEventListener('input', onInput);
    win.addEventListener('change', onChange);
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('pointerdown', onPointerDown);
    win.querySelector('#thrive_prompts_file')?.addEventListener('change', onFilePicked);

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isPromptWindowOpen()) {
            return;
        }
        if (editing) {
            // 正在编辑时 Esc 先收编辑框，窗口留着——和"关掉整个窗口"分开
            event.stopPropagation();
            cancelEditing();
            return;
        }
        closePromptWindow();
    });
}

export function isPromptWindowOpen() {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    return Boolean(win) && !win.classList.contains('displayNone');
}

/**
 * 打开窗口。
 * @param {object} [ctx]
 * @returns {boolean}
 */
export function openPromptWindow(ctx = getContext()) {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win) {
        toast('提示词窗口还没挂载，刷新页面再试');
        return false;
    }

    win.classList.remove('displayNone');
    editing = null;
    signature = null;
    renderWindow(ctx, true);
    return true;
}

export function closePromptWindow() {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win) {
        return;
    }

    editing = null;
    signature = null;
    win.classList.add('displayNone');
    // 拖动留下的行内坐标一并清掉：下次打开回到默认落点
    win.style.left = '';
    win.style.top = '';
    win.style.transform = '';
}

/* ------------------------------------------------------------------ 重绘 */

/**
 * 按当前状态重画。
 *
 * 编辑中直接返回：刷新是随时可能发生的（切模式、发消息、设置页改了一项），
 * 重建 DOM 会把正在敲的字和光标一起扔掉。收编辑框时再强制画一次。
 *
 * @param {object} [ctx]
 * @param {boolean} [force]
 */
export function refreshPromptWindow(ctx = getContext(), force = false) {
    renderWindow(ctx, force);
}

function renderWindow(ctx, force = false) {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win || !isPromptWindowOpen()) {
        signature = null;
        return;
    }

    if (editing && !force) {
        return;
    }

    const settings = ensureSettings(ctx);
    const view = buildView(ctx, settings);
    const next = signatureOf(view);
    if (!force && next === signature) {
        return;
    }
    signature = next;

    const body = win.querySelector('.thrive-prompts__body');
    const scrollTop = body?.scrollTop ?? 0;
    if (body) {
        body.innerHTML = renderBody(view);
    }

    const meta = win.querySelector('.thrive-prompts__meta');
    if (meta) {
        meta.textContent = view.meta;
        meta.classList.toggle('thrive-prompts__meta--off', view.injectOff);
    }

    const hint = win.querySelector('.thrive-prompts__hint');
    if (hint) {
        hint.textContent = view.footHint;
    }

    if (body && scrollTop > 0) {
        body.scrollTop = scrollTop;
    }

    initSortable();
}

/**
 * 视图数据。渲染与签名都用这一份，避免两处各算一遍、算得还不一样。
 */
function buildView(ctx, settings) {
    const order = getPromptOrder(settings);
    const injection = buildInjection(ctx, settings);
    const items = order.map(id => {
        const anchor = id === CARD_ID.ANCHOR;
        const custom = isCustomPrompt(settings, id);
        const meta = PROMPT_CARD_META[id];
        const status = getCardState(ctx, settings, id);
        const text = getCardText(settings, id);
        const chars = countChars(text);
        const side = isHeadCard(order, id) ? 'head' : 'tail';

        return {
            id,
            anchor,
            custom,
            kind: anchor ? 'anchor' : (custom ? 'custom' : 'builtin'),
            name: getPromptName(settings, id),
            hint: custom
                ? '自建提示词 · 按列表顺序注入'
                : (meta?.hint ?? ''),
            state: status.state,
            note: status.note,
            role: getPromptRole(settings, id),
            enabled: isPromptEnabled(settings, id),
            editable: anchor ? false : (custom || Boolean(meta?.editable)),
            deletable: custom,
            canReset: Boolean(getCardSettingKey(id)),
            chars,
            side,
            // 只在签名里用：正文变了要重画行尾的预览与字数
            digest: fnv1a(text),
            preview: previewOf(text),
        };
    });

    const enabled = items.filter(item => !item.anchor && item.enabled).length;
    const contentItems = items.filter(item => !item.anchor);

    const meta = settings.promptInject === false
        ? `自动注入已关闭 · 共 ${contentItems.length} 条 · 启用 ${enabled} 条`
        : `共 ${contentItems.length} 条 · 启用 ${enabled} 条 · `
            + `系统区 ${countChars(injection.head)} 字 / 尾部 ${countChars(injection.tail)} 字`;

    const footHint = editing
        ? 'Ctrl+Enter 保存，Esc 取消。宏在注入时按列表顺序展开。'
        : '拖动左侧抓手调整顺序：分界线「其它提示词」上方进系统提示词区，下方进对话尾部。'
            + '角色不同的相邻提示词会各自成段。宏（{{char}} / {{user}} / {{setvar::名::值}} / {{getvar::名}}）按列表顺序展开。';

    return { order, items, meta, footHint, injectOff: settings.promptInject === false, editingId: editing?.id ?? '' };
}

function signatureOf(view) {
    return JSON.stringify([
        view.meta,
        view.footHint,
        view.editingId,
        view.items.map(item => [
            item.id, item.state, item.role, item.enabled, item.chars, item.digest, item.name, item.side,
        ]),
    ]);
}

function renderBody(view) {
    if (view.items.length === 0) {
        return '<div class="thrive-prompts__empty">这里还没有提示词。</div>';
    }

    return `<div class="thrive-prompts__list">${view.items.map(renderItem).join('')}</div>`;
}

function renderItem(item) {
    if (item.anchor) {
        return `<article class="thrive-prompts__item thrive-prompts__item--anchor" data-prompt="${item.id}" data-kind="anchor">
            <span class="thrive-prompts__grip fa-solid fa-grip-vertical" title="拖动换边：上方进系统区，下方进尾部"></span>
            <div class="thrive-prompts__main">
                <div class="thrive-prompts__head">
                    <span class="thrive-prompts__name">其它提示词</span>
                    <span class="thrive-prompts__badge">分界线</span>
                </div>
                <div class="thrive-prompts__note">上方 → 系统提示词区 · 下方 → 对话尾部（这张本身不注入）</div>
            </div>
        </article>`;
    }

    const roleOptions = [
        [PROMPT_ROLE.SYSTEM, '系统'],
        [PROMPT_ROLE.USER, '用户'],
        [PROMPT_ROLE.ASSISTANT, '助手'],
    ].map(([value, label]) => `<option value="${value}"${value === item.role ? ' selected' : ''}>${label}</option>`).join('');

    const roleDisabled = item.id === CARD_ID.COMPACT;
    const roleNote = roleDisabled ? '压缩指令不注入，角色无意义' : '注入时这条提示词用的角色';

    const badge = `<span class="thrive-prompts__badge thrive-prompts__badge--${item.state}">`
        + `${escapeHtml(STATE_LABEL[item.state] ?? '')}</span>`;

    const editButton = item.editable
        ? '<div class="menu_button thrive-prompts__act" data-act="edit" title="编辑名称与正文">编辑</div>'
        : '';
    const deleteButton = item.deletable
        ? '<div class="menu_button thrive-prompts__act thrive-prompts__act--danger" data-act="delete" title="删除这条自建提示词">删除</div>'
        : '';

    const sideLabel = item.side === 'head' ? '系统区' : '尾部';
    const note = `${sideLabel} · ${escapeHtml(item.note)} · ${item.chars} 字`;

    return `<article class="thrive-prompts__item" data-prompt="${item.id}"
        data-kind="${item.kind}" data-state="${item.state}">
        <span class="thrive-prompts__grip fa-solid fa-grip-vertical" title="拖动调整顺序与落点"></span>
        <label class="thrive-prompts__toggle" title="启用 / 停用（停用只影响注入，正文留着）">
            <input type="checkbox" data-act="toggle"${item.enabled ? ' checked' : ''}>
        </label>
        <div class="thrive-prompts__main">
            <div class="thrive-prompts__head">
                <span class="thrive-prompts__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <span class="thrive-prompts__chip">${escapeHtml(roleLabel(item.role))}</span>
                ${badge}
            </div>
            <div class="thrive-prompts__note">${note}</div>
            <div class="thrive-prompts__preview">${escapeHtml(item.preview)}</div>
        </div>
        <div class="thrive-prompts__tools">
            <select class="thrive-prompts__role" data-act="role" title="${roleNote}"
                aria-label="${escapeHtml(item.name)} 的注入角色"${roleDisabled ? ' disabled' : ''}>${roleOptions}</select>
            ${editButton}
            ${deleteButton}
        </div>
        ${editing?.id === item.id ? renderEditor(item) : ''}
    </article>`;
}

/**
 * 展开的编辑框。
 *
 * 名称只对自建提示词可改；内置卡的名称是功能名，改了反而找不到。
 */
function renderEditor(item) {
    const nameField = item.custom
        ? `<label class="thrive-prompts__field">
                <span>名称</span>
                <input class="text_pole" data-field="name" type="text"
                    value="${escapeHtml(editing.name)}" maxlength="80">
            </label>`
        : `<div class="thrive-prompts__field thrive-prompts__field--static">
                <span>名称</span>
                <b>${escapeHtml(item.name)}</b>
            </div>`;

    const reset = item.canReset
        ? '<div class="menu_button thrive-prompts__ghost" data-act="reset-text" '
            + 'title="用回内置的默认文本">恢复默认</div>'
        : '';

    return `<div class="thrive-prompts__editor">
        <div class="thrive-prompts__editor-head">
            ${nameField}
            <span class="thrive-prompts__count">${countText(editing.text)}</span>
        </div>
        <textarea class="text_pole thrive-block-text" data-field="text" rows="10" spellcheck="false"
            placeholder="在这里写提示词。支持 {{char}}、{{setvar::名::值}}、{{getvar::名}} 等 ST 宏。"
        >${escapeHtml(editing.text)}</textarea>
        <div class="thrive-prompts__editor-foot">
            <small>${escapeHtml(item.hint)}</small>
            ${reset}
            <div class="menu_button thrive-prompts__ghost" data-act="cancel">取消</div>
            <div class="menu_button thrive-prompts__save" data-act="save">保存</div>
        </div>
    </div>`;
}

function countText(text) {
    const chars = countChars(text);
    return chars > 0 ? `${chars} 字` : '0 字 · 不会注入';
}

function previewOf(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) {
        return '（空）';
    }
    const cut = truncate(flat, PREVIEW_CHARS);
    return cut.truncated ? `${cut.text} …` : cut.text;
}

/* ------------------------------------------------------------------ 交互 */

function onClick(event) {
    const trigger = event.target.closest('[data-act]');
    const action = trigger?.dataset.act;
    if (!action || trigger.tagName === 'SELECT' || trigger.tagName === 'INPUT') {
        return;
    }

    const item = trigger.closest('[data-prompt]');
    const id = item?.dataset.prompt ?? '';

    switch (action) {
        case 'close':
            closePromptWindow();
            break;
        case 'add':
            void beginAdd();
            break;
        case 'import':
            document.getElementById('thrive_prompts_file')?.click();
            break;
        case 'reset-order':
            resetOrder();
            break;
        case 'edit':
            void beginEdit(id);
            break;
        case 'delete':
            void confirmDelete(id);
            break;
        case 'save':
            saveEditing();
            break;
        case 'cancel':
            cancelEditing();
            break;
        case 'reset-text':
            resetEditingText();
            break;
        default:
            break;
    }
}

/** 编辑框里打字：只更新草稿与字数，不重绘 */
function onInput(event) {
    if (!editing) {
        return;
    }

    const field = event.target?.dataset?.field;
    if (field === 'text') {
        editing.text = event.target.value;
        editing.dirty = true;
        const label = event.target.closest('.thrive-prompts__editor')?.querySelector('.thrive-prompts__count');
        if (label) {
            label.textContent = countText(editing.text);
        }
        return;
    }

    if (field === 'name') {
        editing.name = event.target.value;
        editing.dirty = true;
    }
}

function onChange(event) {
    const trigger = event.target;
    if (!trigger || !trigger.dataset?.act) {
        return;
    }

    if (trigger.dataset.act === 'toggle') {
        togglePrompt(trigger.closest('[data-prompt]')?.dataset.prompt, trigger.checked);
        return;
    }

    if (trigger.dataset.act === 'role') {
        const id = trigger.closest('[data-prompt]')?.dataset.prompt;
        changeRole(id, Number(trigger.value));
    }
}

/** 编辑框里的键盘：Ctrl/Cmd+Enter 保存，Esc 取消（不让它冒到窗口层） */
function onKeyDown(event) {
    if (!editing) {
        return;
    }

    if (event.key === 'Escape') {
        event.stopPropagation();
        cancelEditing();
        return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveEditing();
    }
}

/* ------------------------------------------------------------ 增删改查 */

function beginAdd() {
    if (editing) {
        toast('先把正在编辑的那条保存或取消');
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const prompt = addCustomPrompt(settings, { content: '' });

    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);

    editing = {
        id: prompt.id,
        name: prompt.name,
        text: '',
        role: prompt.role,
        isNew: true,
        dirty: false,
    };

    signature = null;
    renderWindow(ctx, true);

    // 重画之后把焦点放到名称上并全选，直接敲名字就能替换掉「新提示词 N」
    const win = document.getElementById(PROMPT_WINDOW_ID);
    const input = win?.querySelector(`[data-prompt="${attrEscape(prompt.id)}"] [data-field="name"]`);
    input?.focus();
    input?.select();
    win?.querySelector(`[data-prompt="${attrEscape(prompt.id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function beginEdit(id) {
    if (!id || editing?.id === id) {
        return;
    }

    if (editing) {
        if (editing.dirty) {
            const confirmed = await askConfirm('正在编辑的那条还没保存，切过去会丢掉这些改动。确定吗？');
            if (!confirmed) {
                return;
            }
        }
        editing = null;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    if (id !== CARD_ID.ANCHOR && !isCustomPrompt(settings, id) && !PROMPT_CARD_META[id]) {
        return;
    }

    editing = {
        id,
        name: getPromptName(settings, id),
        text: getCardText(settings, id),
        role: getPromptRole(settings, id),
        isNew: false,
        dirty: false,
    };

    signature = null;
    renderWindow(ctx, true);

    const win = document.getElementById(PROMPT_WINDOW_ID);
    const area = win?.querySelector(`[data-prompt="${attrEscape(id)}"] [data-field="text"]`);
    area?.focus();
}

function saveEditing() {
    if (!editing) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const custom = findCustomPrompt(settings, editing.id);

    if (custom) {
        custom.name = String(editing.name ?? '').trim() || '未命名提示词';
    }

    setPromptRole(settings, editing.id, editing.role);
    setPromptText(settings, editing.id, editing.text);

    const name = getPromptName(settings, editing.id);
    const empty = !String(editing.text ?? '').trim();
    editing = null;
    signature = null;

    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    // refreshUI 会经登记表重画这个窗口（此刻 editing 已经是 null）
    refreshUI(ctx);

    toast(empty ? `「${name}」已保存，但正文为空，不会注入` : `「${name}」已保存`);
}

function cancelEditing() {
    if (!editing) {
        return;
    }

    const ctx = getContext();
    const wasNew = editing.isNew;
    const id = editing.id;
    editing = null;
    signature = null;

    // 新增时直接取消 = 什么都没发生：把刚建出来的空条目收掉，不留一条占位
    if (wasNew) {
        const settings = ensureSettings(ctx);
        deleteCustomPrompt(settings, id);
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);
    }

    renderWindow(ctx, true);
}

function resetEditingText() {
    if (!editing) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    if (!resetPromptText(settings, editing.id)) {
        return;
    }

    editing.text = getCardText(settings, editing.id);
    editing.dirty = true;

    const win = document.getElementById(PROMPT_WINDOW_ID);
    const area = win?.querySelector(`[data-prompt="${attrEscape(editing.id)}"] [data-field="text"]`);
    if (area) {
        area.value = editing.text;
    }
    const label = win?.querySelector(`[data-prompt="${attrEscape(editing.id)}"] .thrive-prompts__count`);
    if (label) {
        label.textContent = countText(editing.text);
    }
}

async function confirmDelete(id) {
    if (!id) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const name = getPromptName(settings, id);

    const confirmed = await askConfirm(`删除「${name}」？正文会一起删掉，不能撤销。`);
    if (!confirmed) {
        return;
    }

    if (editing?.id === id) {
        editing = null;
    }

    if (!deleteCustomPrompt(ensureSettings(ctx), id)) {
        toast('这条提示词已经不在了');
        return;
    }

    signature = null;
    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    refreshUI(ctx);
    // 删的是别的条目、手里还开着编辑框：这一行得从 DOM 里拿掉，草稿本身还在
    renderWindow(ctx, Boolean(editing));

    toast(`已删除「${name}」`);
}

function togglePrompt(id, enabled) {
    if (!id) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    if (!setPromptEnabled(settings, id, enabled)) {
        return;
    }

    signature = null;
    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    refreshUI(ctx);

    toast(enabled ? `「${getPromptName(settings, id)}」已启用` : `「${getPromptName(settings, id)}」已停用（正文保留）`);
}

function changeRole(id, role) {
    if (!id) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    if (!setPromptRole(settings, id, role)) {
        return;
    }

    if (editing?.id === id) {
        editing.role = role;
    }

    signature = null;
    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    refreshUI(ctx);
    renderWindow(ctx, true);
}

function resetOrder() {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const extra = getCustomPrompts(settings).map(item => item.id);

    // 分界线在最前，内置卡按默认顺序接在后面，自建提示词收在尾部
    settings.promptOrder = normalizeOrder([CARD_ID.ANCHOR], extra);

    signature = null;
    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    refreshUI(ctx);
    if (editing) {
        renderWindow(ctx, true);
    }

    toast('提示词顺序已恢复默认');
}

/* ------------------------------------------------------------------ 导入 */

/** id 拼进属性选择器前先转义：手改过设置的 id 可能带引号或反斜杠 */
function attrEscape(value) {
    const str = String(value ?? '');
    return globalThis.CSS?.escape ? CSS.escape(str) : str.replace(/["\\]/g, '\\$&');
}

async function onFilePicked(event) {
    const input = event.target;
    const file = input?.files?.[0];
    // 先清掉，下一次选同一个文件才会再触发 change
    if (input) {
        input.value = '';
    }

    if (!file || importBusy) {
        return;
    }

    await importPreset(file);
}

async function importPreset(file) {
    importBusy = true;
    const win = document.getElementById(PROMPT_WINDOW_ID);
    win?.classList.add('thrive-prompts--busy');

    try {
        let text = '';
        try {
            text = await file.text();
        } catch (err) {
            console.warn(`${LOG} 读取预设文件失败`, err);
            toast('读取文件失败，详情见控制台');
            return;
        }

        const parsed = parseStPreset(text);
        if (!parsed.ok) {
            toast(importErrorMessage(parsed.error));
            return;
        }

        const confirmed = await askConfirm(buildImportMessage(file.name, parsed.counts));
        if (!confirmed) {
            return;
        }

        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const result = applyPresetImport(settings, parsed);

        editing = null;
        signature = null;

        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);

        toast(`已从「${file.name}」导入 ${result.prompts.length} 条提示词（系统区 ${result.head} / 尾部 ${result.tail}）`);
    } finally {
        importBusy = false;
        win?.classList.remove('thrive-prompts--busy');
    }
}

/**
 * 确认框里的说明。既要说清进来多少，也要说清丢掉了什么——"有损"不能只是一句形容词。
 */
function buildImportMessage(fileName, counts) {
    const skipped = [];
    if (counts.marker > 0) {
        skipped.push(`世界书 / 角色卡等标记块 ${counts.marker} 条`);
    }
    if (counts.empty > 0) {
        skipped.push(`没有正文的空条目 ${counts.empty} 条`);
    }
    if (counts.duplicate > 0) {
        skipped.push(`重复条目 ${counts.duplicate} 条`);
    }

    const notes = [];
    if (counts.triggered > 0) {
        notes.push(`${counts.triggered} 条带触发器，触发器会被忽略（启用即总是注入）`);
    }
    if (counts.core > 0) {
        notes.push(`${counts.core} 条核心系统提示词（主提示词 / 越狱等）；如果当前预设也在用，注意会在请求里出现两次`);
    }

    return `从「${fileName}」导入 ${counts.imported} 条提示词：`
        + `启用 ${counts.enabled} / 停用 ${counts.disabled}，系统区 ${counts.head} / 尾部 ${counts.tail}。`
        + (skipped.length ? `跳过 ${skipped.join('、')}。` : '')
        + (notes.length ? `${notes.join('；')}。` : '')
        + '导入会替换当前所有自建提示词；学习块等内置卡保留并恢复启用。继续吗？';
}

/* ------------------------------------------------------------------ 拖动 */

/**
 * 列表排序。用 ST 自带的 jQuery UI sortable；拿不到就退化成不能拖，增删改照常。
 *
 * 每次重绘都会换掉列表节点，所以绑定前先销毁旧实例——不然 jQuery 会把事件
 * 挂在一个已经从 DOM 里消失的节点上。
 */
function initSortable() {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    const list = win?.querySelector('.thrive-prompts__list');
    const $ = globalThis.jQuery;

    if (!list || typeof $?.fn?.sortable !== 'function') {
        return;
    }

    if ($(list).data('ui-sortable')) {
        $(list).sortable('destroy');
    }

    $(list).sortable({
        items: '.thrive-prompts__item',
        // 整卡可拖会让编辑框里的选区没法用；只认抓手
        handle: '.thrive-prompts__grip',
        cancel: '.thrive-prompts__editor, [data-act]',
        placeholder: 'thrive-prompts__placeholder',
        forcePlaceholderSize: true,
        axis: 'y',
        tolerance: 'pointer',
        delay: 30,
        start: () => {
            dragging = true;
        },
        stop: () => {
            dragging = false;
        },
        update: () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const ids = Array.from(list.querySelectorAll('.thrive-prompts__item')).map(el => el.dataset.prompt);
            const extra = getCustomPrompts(settings).map(item => item.id);

            settings.promptOrder = normalizeOrder(ids, extra);
            ctx.saveSettingsDebounced?.();
            syncFromContext(ctx);

            /*
             * 等这一轮 sortable 的收尾跑完再重绘：在 update 里直接换掉列表节点，
             * jQuery UI 手里的 helper / placeholder 会指向孤儿节点。
             */
            setTimeout(() => {
                signature = null;
                refreshUI(ctx);
                renderWindow(ctx, true);
            }, 0);
        },
    });
}

/* -------------------------------------------------------------- 窗口拖动 */

function onPointerDown(event) {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win || event.button > 0 || !event.target.closest('.thrive-prompts__bar')) {
        return;
    }
    if (event.target.closest('[data-act], button, a, input, select')) {
        return;
    }

    const rect = win.getBoundingClientRect();
    // 默认落点是 transform 居中：第一次动它时先换算成确定的 left/top，否则一拖就跳
    win.style.transform = 'none';
    win.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    win.style.top = `${Math.round(rect.top + window.scrollY)}px`;

    drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
    };
    win.classList.add('thrive-prompts--dragging');
    document.body.classList.add('thrive-panel-dragging');
    event.preventDefault();
}

function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
        return;
    }

    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win) {
        return;
    }

    const width = win.getBoundingClientRect().width || 720;
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
    document.getElementById(PROMPT_WINDOW_ID)?.classList.remove('thrive-prompts--dragging');
    document.body.classList.remove('thrive-panel-dragging');
}

/* 登记给刷新编排：切对话、改模式、设置页改了开关，窗口里的状态都跟着变 */
registerSurfaces({
    promptWindow: ({ ctx }) => {
        if (dragging) {
            return;
        }
        refreshPromptWindow(ctx);
    },
});
