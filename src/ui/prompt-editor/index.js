import { renderPromptBody, countText, msgCountText } from './view.js';
/**
 * ui/prompt-window.js · 提示词编辑器（独立窗口）
 *
 * 入口只有一处：设置页「提示词」折叠块里的按钮。标题栏也能拖，Esc 关闭。
 *
 * 这里编辑的是**一场学习会话的预设**（ADR-050、ADR-053、ADR-054）：
 *   · 卡片 = 预设里的一条消息，按列表顺序发出（没有系统区 / 尾部之分）
 *   · 卡片是**通用提示词**：通用提示词卡（你是谁）+ 目标内容的描述行与注入位 + 自建卡
 *   · 目标内容拆成两条：可改可删的**描述行**，和没有正文、只在运行时被填内容的**注入位**
 *   · 折叠块「会话开场白」是**特化提示词**：学习 / 压缩各一段，讲这一场具体怎么干
 *   · 折叠块「工具列表」：这一版带出去的全部工具，名字、用途与激活状态
 *   · 导入 SillyTavern 预设：可以从文件选，也可以直接从 ST 已装的预设里挑
 *
 * 为什么独立成窗口而不是加厚设置页：一张提示词动辄几百字，设置页那条 480px
 * 的栏里连正文都看不全；而且导入要预览"进来多少条、跳过了什么"，这需要一个
 * 能摊开的地方。设置页只留一个入口与一行摘要。
 *
 * 行上只留"看得出状态"的东西：名字、角色、状态与字数。角色下拉与删除都收进
 * 编辑区——它们不是每眼都要看的，但会把每行右侧挤成参差不齐的按钮堆。
 *
 * 与压缩面板的编辑约法一致：同一时刻只展开一条（卡片或开场白），切走 / 关闭窗口
 * 就放弃未保存的内容（不弹二次确认），因为草稿从来没离开过这个窗口。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../platform/sillytavern/popup.js';
import {
    PROMPT_CARD_META,
    SESSION_MESSAGE_KINDS,
    addCustomPrompt,
    countChars,
    findCustomPrompt,
    getCardSettingKey,
    getCardState,
    getCardText,
    getCustomPrompts,
    getPromptName,
    getPromptOrder,
    getPromptRole,
    getSessionMessage,
    getSessionMessageDefault,
    getSessionMessageMeta,
    isCustomPrompt,
    isPromptEnabled,
    removePromptCard,
    resetPromptText,
    roleLabel,
    setPromptEnabled,
    setPromptRole,
    setPromptText,
    setSessionMessage,
} from '../../features/prompts/prompt.js';
import { DEFAULT_PROMPT_ORDER, isPinnedCard, normalizeOrder } from '../../features/prompts/prompt-order.js';
import { applyPresetImport, importErrorMessage, parseStPreset } from '../../features/prompts/prompt-import.js';
import { ensureSettings } from '../../features/settings/index.js';
import { getToolDefs } from '../../features/tools/index.js';
import { escapeHtml, fnv1a } from '../../shared/util.js';
import { refreshUI, registerSurfaces } from '../shared/refresh.js';
import { LOG, PROMPT_WINDOW_ID, askConfirm, toast } from '../shared/common.js';

/** 当前展开编辑的那条：`{ id, name, text, role, isNew, dirty }`；null = 没在编辑 */
let editing = null;

/** 正在编辑开场白的那一种任务（learn / compact）；null = 没在编辑 */
let msgEditing = null;

/** 开场白草稿。只在 msgEditing 非空时有意义 */
let msgDraft = '';

/** 重绘签名：内容没变就不碰 DOM（重绘会把滚动位置弹回顶部） */
let signature = null;

/** jQuery UI 拖动会话中：这段时间不整块重绘 */
let dragging = false;

/** 打开文件选择框 / 读预设期间：挡住重复触发 */
let importBusy = false;

/** 拖动窗口的状态 */
let drag = null;

/**
 * 折叠块的展开状态。
 *
 * 整块重绘会把 `<details>` 的展开状态一起冲掉——保存一条提示词之后「工具列表」
 * 自己合上，会让人以为点错了。所以状态存在这里，渲染时照着写回 open。
 */
const folds = new Set();

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
    // toggle 不冒泡，用捕获阶段接：details 自己开合时把状态记下来，重绘时照原样写回
    win.addEventListener('toggle', onFoldToggle, true);
    win.querySelector('#thrive_prompts_file')?.addEventListener('change', onFilePicked);

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isPromptWindowOpen()) {
            return;
        }
        if (importMenu) {
            // 来源菜单只是个临时下拉：Esc 先收它，别顺手把整个窗口关掉
            event.stopPropagation();
            closeImportMenu();
            return;
        }
        if (editing || msgEditing) {
            // 正在编辑时 Esc 先收编辑框，窗口留着——和"关掉整个窗口"分开
            event.stopPropagation();
            if (msgEditing) {
                cancelMsg();
            } else {
                cancelEditing();
            }
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

    // 已经开着就只重画，别把手里那份没保存的草稿丢掉
    if (!isPromptWindowOpen()) {
        editing = null;
        msgEditing = null;
        signature = null;
    }

    win.classList.remove('displayNone');
    renderWindow(ctx, true);
    return true;
}

export function closePromptWindow() {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    if (!win) {
        return;
    }

    closeImportMenu();
    dropUnsavedNew();
    dropEditorFocus();
    editing = null;
    msgEditing = null;
    signature = null;
    win.classList.add('displayNone');
    // 拖动留下的行内坐标一并清掉：下次打开回到默认落点
    win.style.left = '';
    win.style.top = '';
    win.style.transform = '';
}

/**
 * 关窗口时把人刚点出来的空条目收掉。
 *
 * 新增是"先建一条空提示词再编辑"，所以直接关窗口（或刷页面）会留下一条
 * 「新提示词 N」。空条目不注入什么，但会一直堆在列表里——这不是用户建的东西。
 */
function dropUnsavedNew() {
    if (!editing?.isNew) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    if (removePromptCard(settings, editing.id)) {
        ctx.saveSettingsDebounced?.();    }
}

/** 折叠块开合：记下来，重绘时还原（不然保存一条提示词就把折叠块全合上了） */
function onFoldToggle(event) {
    const fold = event.target;
    const key = fold?.dataset?.fold;
    if (!key) {
        return;
    }

    if (fold.open) {
        folds.add(key);
    } else {
        folds.delete(key);
    }
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

    // 编辑中不重绘：刷新随时可能发生（发消息、改设置），重建 DOM 会把光标一起扔掉
    if ((editing || msgEditing) && !force) {
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
        dropEditorFocus();
        body.innerHTML = renderPromptBody(view, { editing, msgDraft, folds });
    }

    const meta = win.querySelector('.thrive-prompts__meta');
    if (meta) {
        meta.textContent = view.meta;
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
    const items = order.map(id => {
        const custom = isCustomPrompt(settings, id);
        const meta = PROMPT_CARD_META[id];
        const status = getCardState(settings, id);
        const text = getCardText(settings, id);
        // 注入位没有正文：它的内容是触发那一刻才有的，界面上不显示"0 字"
        const pinned = isPinnedCard(id);

        return {
            id,
            custom,
            pinned,
            kind: custom ? 'custom' : 'builtin',
            name: getPromptName(settings, id),
            hint: custom ? '自建提示词 · 按列表顺序发出' : (meta?.hint ?? ''),
            role: getPromptRole(settings, id),
            enabled: isPromptEnabled(settings, id),
            editable: !pinned && (custom || Boolean(meta?.editable)),
            deletable: !pinned && (custom || Boolean(meta?.removable)),
            canReset: Boolean(getCardSettingKey(id)),
            status: status.note,
            chars: pinned ? null : countChars(text),
            // 只在签名里用：正文变了要重算行尾的字数（同样的字数换了内容也要重画）
            digest: fnv1a(text),
        };
    });

    const enabled = items.filter(item => item.enabled).length;

    /*
     * 开场白的草稿也要进视图：编辑中整块重绘是被挡住的，但"字数"这类
     * 随手要看到的东西仍得跟着打字更新（走 onInput 就地改，不重绘）。
     */
    const messages = SESSION_MESSAGE_KINDS.map(kind => {
        const meta = getSessionMessageMeta(kind);
        const open = msgEditing === kind;
        const text = open ? msgDraft : getSessionMessage(settings, kind);
        return {
            kind,
            label: meta?.label ?? kind,
            hint: meta?.hint ?? '',
            open,
            chars: countChars(text),
            digest: fnv1a(text),
            // 和默认文本一字不差：界面上不必说"你改过"
            custom: !open && text !== getSessionMessageDefault(kind),
        };
    });

    const tools = getToolsView();

    const footHint = editing
        ? 'Ctrl+Enter 保存，Esc 取消；打字时输入 {{ 会弹出宏补全，右上角可全屏编辑。'
        : '列表从上到下就是这一场会话的消息顺序。宏（{{char}} / {{user}} / {{setvar::名::值}} / {{getvar::名}}）'
            + '在发请求前按顺序展开。';

    return {
        order,
        items,
        messages,
        tools,
        meta: `共 ${items.length} 条 · 启用 ${enabled} 条 · 开场白 ${messages.length} 段 · 工具 ${tools.length} 个`,
        footHint,
        editingId: editing?.id ?? '',
        msgEditing,
    };
}

/**
 * 工具列表的视图。
 *
 * 「忽略对话」是用户给的口径：这一栏回答"这一版插件带出去哪些工具"，不回答
 * "这一场对话能不能用"——后者要看有没有选可写书，那个条件在浮动面板里说。
 * 所以这里一律显示激活，只把作用域写在小字里。
 */
function getToolsView() {
    try {
        return getToolDefs().map(def => ({
            name: String(def.name ?? ''),
            label: String(def.displayName ?? def.name ?? ''),
            description: String(def.description ?? ''),
            active: true,
        }));
    } catch (err) {
        console.warn(`${LOG} 读不到工具列表`, err);
        return [];
    }
}

function signatureOf(view) {
    return JSON.stringify([
        view.meta,
        view.footHint,
        view.editingId,
        view.msgEditing,
        view.items.map(item => [
            item.id, item.role, item.enabled, item.chars, item.digest, item.name,
        ]),
        view.messages.map(item => [item.kind, item.open, item.chars, item.digest]),
    ]);
}

/**
 * 让正在打字的输入框失焦，并顺手清掉可能落下的宏补全浮层。
 *
 * ST 的补全浮层靠 textarea 的 blur 自己 remove()。整块重绘会把节点直接换掉，
 * blur 永远不会发生，浮层就留在屏幕上。所以换 DOM 之前先主动失焦一次。
 */
function dropEditorFocus() {
    const win = document.getElementById(PROMPT_WINDOW_ID);
    const active = document.activeElement;
    if (win && active && win.contains(active) && typeof active.blur === 'function') {
        active.blur();
    }
    dropStrayMacroList();
}

/**
 * 兜底清掉悬在 body 上的宏补全浮层。
 *
 * ST 的 `.autoComplete-wrap` / `.autoComplete-detailsWrap` 是挂在 textarea 的
 * blur 上自己 remove() 的。有两条路它管不到：
 *
 *   1. 输入框被我们整块换掉（重绘、收起编辑、关窗口）——节点直接消失，
 *      blur 不派发，浮层就悬在窗口上那排 `{{getvar::name}}` 里不走了；
 *   2. 页面本身没有焦点时（切窗口、跑脚本），blur / focusout 压根不派发。
 *
 * 只清直接挂在 body 上的：弹窗里那份跟着 dialog 走，不用管。清掉也不伤 ST——
 * 它的实例还留着同一个节点，下次输入时会自己 append 回来。
 */
function dropStrayMacroList() {
    for (const list of document.querySelectorAll('body > .autoComplete-wrap, body > .autoComplete-detailsWrap')) {
        list.remove();
    }
}

/**
 * 只刷这一行的外观（亮/暗、角色 chip、字数）。
 *
 * 展开着编辑框时不能整块重绘——光标、选区、滚动位置都会没。但开关与角色又是
 * 随时能改的，所以这两处改完就地补一下这一行，别让界面和状态对不上。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string} id
 */
function refreshRowChrome(ctx, settings, id) {
    const row = document.querySelector(`#${PROMPT_WINDOW_ID} [data-prompt="${attrEscape(id)}"]`);
    if (!row) {
        return;
    }

    row.dataset.enabled = String(isPromptEnabled(settings, id));

    const chip = row.querySelector('.thrive-prompts__chip');
    if (chip) {
        chip.textContent = roleLabel(getPromptRole(settings, id));
    }

    const note = row.querySelector('.thrive-prompts__note');
    if (note) {
        const pinned = isPinnedCard(id);
        note.textContent = pinned
            ? '运行时注入 · 内容随触发生成'
            : `${countChars(getCardText(settings, id))} 字`;
        note.title = getCardState(settings, id).note;
    }
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
    const kind = trigger.closest('[data-msg]')?.dataset.msg ?? '';

    switch (action) {
        case 'close':
            closePromptWindow();
            break;
        case 'add':
            void beginAdd();
            break;
        case 'import':
            void openImportMenu(trigger);
            break;
        case 'reset-order':
            resetOrder();
            break;
        case 'edit':
            // 同一个按钮再点一次就是收起：不用先找「取消」在哪
            if (editing?.id === id) {
                void closeEditor();
            } else {
                void beginEdit(id);
            }
            break;
        case 'delete':
            void confirmDelete(id);
            break;
        case 'fullscreen':
            void openFullScreenEditor();
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
        case 'msg-edit':
            beginMsgEdit(kind);
            break;
        case 'msg-save':
            saveMsg();
            break;
        case 'msg-cancel':
            cancelMsg();
            break;
        case 'msg-reset':
            resetMsg();
            break;
        default:
            break;
    }
}

/** 编辑框里打字：只更新草稿与字数，不重绘 */
function onInput(event) {
    const field = event.target?.dataset?.field;

    if (field === 'msg' && msgEditing) {
        msgDraft = event.target.value;
        const count = event.target.closest('[data-msg]')?.querySelector('.thrive-prompts__count');
        if (count) {
            count.textContent = msgCountText(msgDraft);
        }
        return;
    }

    if (!editing) {
        return;
    }

    if (field === 'text') {
        editing.text = event.target.value;
        editing.dirty = true;
        const row = event.target.closest('[data-prompt]');
        const label = row?.querySelector('.thrive-prompts__count');
        if (label) {
            label.textContent = countText(editing.text);
        }
        // 行上那截字数也一起跟上：打字时它停在旧值会显得像没保存
        const note = row?.querySelector('.thrive-prompts__note');
        if (note) {
            const parts = note.textContent.split(' · ');
            parts[parts.length - 1] = `${countChars(editing.text)} 字`;
            note.textContent = parts.join(' · ');
        }
        return;
    }

    if (field === 'name') {
        editing.name = event.target.value;
        editing.dirty = true;
        // 行标题跟着改：不然「新提示词 3」会一直挂到保存之后，看着像两张卡
        const title = event.target.closest('[data-prompt]')?.querySelector('.thrive-prompts__name');
        if (title) {
            title.textContent = String(editing.name || '').trim() || '未命名提示词';
        }
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
    if (!editing && !msgEditing) {
        return;
    }

    if (event.key === 'Escape') {
        event.stopPropagation();
        if (msgEditing) {
            cancelMsg();
        } else {
            cancelEditing();
        }
        return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (msgEditing) {
            saveMsg();
        } else {
            saveEditing();
        }
    }
}

/* ------------------------------------------------------------ 增删改查 */

function beginAdd() {
    if (editing || msgEditing) {
        toast('先把正在编辑的那条保存或取消');
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const prompt = addCustomPrompt(settings, { content: '' });

    ctx.saveSettingsDebounced?.();

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

    if (msgEditing) {
        toast('先把正在编辑的开场白保存或取消');
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
    if (!isCustomPrompt(settings, id) && !PROMPT_CARD_META[id]) {
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

/**
 * 收起编辑区。行上的「编辑」再点一次走这里。
 *
 * 有未保存改动时问一句：这个动作在视觉上只是"收起来"，但草稿真的会没。
 * 新增的那条连条目一起收掉（取消新增 = 什么都没发生）。
 */
async function closeEditor() {
    if (!editing) {
        return;
    }

    if (editing.dirty) {
        const confirmed = await askConfirm('这条还没保存，收起会丢掉刚才的改动。确定吗？');
        if (!confirmed) {
            return;
        }
    }

    cancelEditing();
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
        removePromptCard(settings, id);
        ctx.saveSettingsDebounced?.();        refreshUI(ctx);
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

/* ------------------------------------------------------------ 会话开场白 */

/**
 * 开始编辑某一种开场白。
 *
 * 和卡片编辑互斥：两处同时开着，草稿就得各存一份、还得判断谁的刷新该被挡住，
 * 而它们回答的是同一个问题（"这一场会话说什么"），同时改没有意义。
 *
 * @param {string} kind learn / compact
 */
function beginMsgEdit(kind) {
    if (!kind || !getSessionMessageMeta(kind)) {
        return;
    }

    if (editing) {
        toast('先把正在编辑的那条提示词保存或取消');
        return;
    }

    if (msgEditing === kind) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    msgEditing = kind;
    msgDraft = getSessionMessage(settings, kind);

    signature = null;
    renderWindow(ctx, true);

    // 打开就把光标放进去：这一段通常是想整体改写，不是补一个词
    const win = document.getElementById(PROMPT_WINDOW_ID);
    const area = win?.querySelector(`[data-msg="${attrEscape(kind)}"] [data-field="msg"]`);
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
    area?.closest('[data-msg]')?.scrollIntoView({ block: 'nearest' });
}

function saveMsg() {
    if (!msgEditing) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const kind = msgEditing;

    if (!setSessionMessage(settings, kind, msgDraft)) {
        return;
    }

    msgEditing = null;
    msgDraft = '';
    signature = null;

    ctx.saveSettingsDebounced?.();
    // refreshUI 会经登记表重画这个窗口（此刻两处编辑都关着）
    refreshUI(ctx);

    const meta = getSessionMessageMeta(kind);
    toast(`「${meta?.label ?? kind}时发送」已保存`);
}

function cancelMsg() {
    if (!msgEditing) {
        return;
    }

    const ctx = getContext();
    msgEditing = null;
    msgDraft = '';
    signature = null;
    renderWindow(ctx, true);
}

/** 把草稿换成默认文本（不落盘，等用户点保存） */
function resetMsg() {
    if (!msgEditing) {
        return;
    }

    msgDraft = getSessionMessageDefault(msgEditing);

    const win = document.getElementById(PROMPT_WINDOW_ID);
    const row = win?.querySelector(`[data-msg="${attrEscape(msgEditing)}"]`);
    const area = row?.querySelector('[data-field="msg"]');
    if (area) {
        area.value = msgDraft;
    }
    const count = row?.querySelector('.thrive-prompts__count');
    if (count) {
        count.textContent = msgCountText(msgDraft);
    }
}

/* ------------------------------------------------------- 全屏与宏补全 */

/**
 * 全屏编辑器。
 *
 * 直接用 ST 的 `callGenericPopup`（wide + large）而不是自己搭一层浮层：
 * 遮罩、Esc、焦点回收、与别处的弹窗互斥这些都由它管，长得也和 ST 别处的
 * "放大编辑"一致。里面那个 textarea 同样挂着 `data-macros`，宏补全照常。
 */
async function openFullScreenEditor() {
    if (!editing) {
        return;
    }

    const id = editing.id;
    const wrapper = document.createElement('div');
    wrapper.classList.add('thrive-prompts__fullscreen-body');

    const area = document.createElement('textarea');
    area.className = 'text_pole thrive-block-text';
    area.value = editing.text;
    area.spellcheck = false;
    area.placeholder = '在这里写提示词。支持 {{char}}、{{setvar::名::值}}、{{getvar::名}} 等 ST 宏。';
    area.dataset.macros = 'true';
    area.dataset.macrosAutocomplete = 'always';
    area.dataset.macrosAutocompleteStyle = 'expanded';
    wrapper.appendChild(area);

    const result = await callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: '完成',
        cancelButton: '取消',
        allowVerticalScrolling: true,
        onOpen: popup => {
            area.focus();
            // 大窗口里也用 Ctrl+Enter 收工；Esc 交给弹窗自己（= 取消）
            area.addEventListener('keydown', event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    area.blur();
                    void popup.complete(POPUP_RESULT.AFFIRMATIVE);
                }
            });
            /*
             * 三个按钮都在按下时先失焦，而且用捕获阶段：
             *
             * ST 的宏补全浮层挂在 body 上，靠 textarea 的 blur 自己 remove()。
             * 等弹窗关掉再 blur 就晚了——那时 textarea 已经不在文档里，blur 不触发，
             * 浮层会留在屏幕上不消失。捕获阶段保证它比 ST 自己"关闭弹窗"的处理先跑，
             * 程序化点击（keyboard / 脚本）也一样管用。
             */
            for (const button of [popup.okButton, popup.cancelButton, popup.closeButton]) {
                button?.addEventListener('pointerdown', () => area.blur(), true);
                button?.addEventListener('click', () => area.blur(), true);
            }
        },
    });

    /*
     * 弹窗一关就把两份浮层都收掉：弹窗里那份跟着 dialog 走了，但行内那个输入框
     * 一直开着——它的宏列表在我们打开全屏之前就弹出来了，回来还悬在那儿。
     */
    dropStrayMacroList();

    // 取消 / Esc：全屏里改的东西整段丢掉，回到行内还是原来那份草稿
    if (result !== POPUP_RESULT.AFFIRMATIVE || !editing || editing.id !== id) {
        return;
    }

    if (area.value === editing.text) {
        return;
    }

    editing.text = area.value;
    editing.dirty = true;

    const win = document.getElementById(PROMPT_WINDOW_ID);
    const inline = win?.querySelector(`[data-prompt="${attrEscape(id)}"] [data-field="text"]`);
    if (inline) {
        inline.value = editing.text;
    }
    const label = win?.querySelector(`[data-prompt="${attrEscape(id)}"] .thrive-prompts__count`);
    if (label) {
        label.textContent = countText(editing.text);
    }
}

/**
 * 宏补全是 ST 自己的事，这里只负责把输入框"登记"成支持宏的输入框。
 *
 * ST 的 `initMacroAutoComplete()` 起了一个 MutationObserver 盯着 `data-macros`
 * 属性，动态插进来的 textarea 会被它自己初始化——所以标记写在模板里就够了，
 * 不用 import 它的模块，也不用担心重复挂出两个下拉。
 *
 * `data-macros-autocomplete="always"`：不用管用户全局的"所有宏输入框都补全"
 * 开关，这个编辑器里就是要补（和 ST 自己的放大编辑一致）。
 */

async function confirmDelete(id) {
    if (!id) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const name = getPromptName(settings, id);
    const custom = isCustomPrompt(settings, id);

    /*
     * 两种"删除"要说清楚差别：自建卡连正文一起没，内置的描述行只是从列表里
     * 挪开——用户点删除时通常想的是"这一场不要这句"，不该顺带毁掉他写的话。
     */
    const question = custom
        ? `删除「${name}」？正文会一起删掉，不能撤销。`
        : `把「${name}」从列表里拿掉？正文会留着，「默认顺序」能让它带着原话回来。`;

    const confirmed = await askConfirm(question, { okButton: custom ? '删除' : '拿掉' });
    if (!confirmed) {
        return;
    }

    if (editing?.id === id) {
        editing = null;
    }

    if (!removePromptCard(ensureSettings(ctx), id)) {
        toast('这张卡已经不在了');
        return;
    }

    signature = null;
    ctx.saveSettingsDebounced?.();
    refreshUI(ctx);
    // 删的是别的条目、手里还开着编辑框：这一行得从 DOM 里拿掉，草稿本身还在
    renderWindow(ctx, Boolean(editing));

    toast(custom ? `已删除「${name}」` : `已拿掉「${name}」（正文留着）`);
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
    refreshUI(ctx);
    if (editing) {
        refreshRowChrome(ctx, settings, id);
    }

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

    /*
     * 角色现在只在编辑区里选，所以就地刷这一行的角标与 chip 就行。
     * 不整块重绘：重绘会把编辑框里的光标和选区一起扔掉。
     */
    signature = null;
    ctx.saveSettingsDebounced?.();
    refreshUI(ctx);
    if (editing) {
        refreshRowChrome(ctx, settings, id);
    }
}

function resetOrder() {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const extra = getCustomPrompts(settings).map(item => item.id);

    // 描述行回到最前、注入位固定在最后，自建提示词按默认规则夹在中间
    settings.promptOrder = normalizeOrder(DEFAULT_PROMPT_ORDER, extra);

    signature = null;
    ctx.saveSettingsDebounced?.();
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

    let text;
    try {
        text = await file.text();
    } catch (err) {
        console.warn(`${LOG} 读取预设文件失败`, err);
        toast('读取文件失败，详情见控制台');
        return;
    }

    await importPreset(file.name, text);
}

/* -------------------------------------------------------- 导入来源选择 */

/** 打开中的来源菜单（`{ el, presets }`）；同一时刻只会有一个 */
let importMenu = null;

/**
 * 「导入预设」先问来源：文件还是 ST 已装的预设。
 *
 * 用一个自己画的小菜单而不是弹窗：选项数量随用户装的预设变化，弹窗里再套
 * 一个滚动列表既慢又难回收焦点；而且这个菜单只是"选来源"，不需要阻塞窗口。
 */
async function openImportMenu(anchor) {
    closeImportMenu();

    const presets = await listStPresets();
    const items = presets.map(item => `
        <div class="thrive-prompts__menu-item" data-pick="preset" data-preset="${escapeHtml(item.name)}"
            title="导入 ST 预设「${escapeHtml(item.name)}」">
            <i class="fa-solid fa-sliders" aria-hidden="true"></i>
            <span>${escapeHtml(item.name)}</span>
        </div>`).join('');

    importMenu = { presets };

    const menu = document.createElement('div');
    menu.className = 'thrive-prompts__menu';
    menu.innerHTML = `
        <div class="thrive-prompts__menu-item" data-pick="file" title="选一个预设 JSON 文件">
            <i class="fa-solid fa-file-arrow-up" aria-hidden="true"></i>
            <span>从文件选择…</span>
        </div>
        <div class="thrive-prompts__menu-sep"></div>
        <div class="thrive-prompts__menu-title">SillyTavern 预设${items ? '' : ' · 没找到带提示词的预设'}</div>
        <div class="thrive-prompts__menu-list">${items}</div>
    `;
    importMenu.el = menu;

    menu.addEventListener('click', event => {
        const choice = event.target.closest('[data-pick]');
        if (!choice) {
            return;
        }
        const pick = choice.dataset.pick;
        if (pick === 'file') {
            closeImportMenu();
            document.getElementById('thrive_prompts_file')?.click();
            return;
        }
        const name = choice.dataset.preset;
        const found = importMenu?.presets.find(item => item.name === name);
        closeImportMenu();
        if (found) {
            void importPreset(found.name, JSON.stringify(found.preset));
        }
    });

    document.body.appendChild(menu);

    // 贴着按钮下沿展开；右边不够就左移，下边不够就翻到按钮上方
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    const height = menu.getBoundingClientRect().height;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const flip = rect.bottom + height + 8 > window.innerHeight;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(flip ? Math.max(8, rect.top - height - 4) : rect.bottom + 4)}px`;
    menu.style.width = `${Math.round(width)}px`;

    // 点别处、滚动、改窗口大小都收起来：它是"选一下就完"，没有需要保留的状态
    setTimeout(() => {
        document.addEventListener('pointerdown', onImportMenuOutside, true);
        window.addEventListener('resize', closeImportMenu);
        document.addEventListener('scroll', closeImportMenu, true);
    }, 0);
}

function onImportMenuOutside(event) {
    if (event.target.closest('.thrive-prompts__menu') || event.target.closest('[data-act="import"]')) {
        return;
    }
    closeImportMenu();
}

function closeImportMenu() {
    (importMenu?.el ?? document.querySelector('.thrive-prompts__menu'))?.remove();
    importMenu = null;
    document.removeEventListener('pointerdown', onImportMenuOutside, true);
    window.removeEventListener('resize', closeImportMenu);
    document.removeEventListener('scroll', closeImportMenu, true);
}

/**
 * ST 已装的 Chat Completion 预设里，哪些能拿来导入。
 *
 * 走 ST 自己的预设管理器，不碰磁盘接口：用户在设置里看到的列表是什么，
 * 这里就是什么。拿不到管理器（版本不同 / 没装预设）就只留「从文件选择」。
 *
 * @returns {Promise<{ name: string, preset: object }[]>}
 */
async function listStPresets() {
    try {
        const { getPresetManager } = await import('../../platform/sillytavern/presets.js');
        const manager = getPresetManager('openai');
        const list = manager?.getPresetList?.();
        if (!list?.presets || !list?.preset_names) {
            return [];
        }

        const seen = new Set();
        return Object.entries(list.preset_names)
            .map(([name, index]) => ({ name, preset: list.presets[index] }))
            .filter(item => {
                // 只留真能解析出提示词的：别的 API 的预设混在同一个管理器里也说不定
                if (!Array.isArray(item.preset?.prompts) || item.preset.prompts.length === 0) {
                    return false;
                }
                if (seen.has(item.name)) {
                    return false;
                }
                seen.add(item.name);
                return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    } catch (err) {
        console.warn(`${LOG} 读不到 ST 预设列表，只能从文件导入`, err);
        return [];
    }
}

/* ------------------------------------------------------------------ 导入 */

async function importPreset(sourceName, text) {
    importBusy = true;
    const win = document.getElementById(PROMPT_WINDOW_ID);
    win?.classList.add('thrive-prompts--busy');

    try {
        const parsed = parseStPreset(text);
        if (!parsed.ok) {
            toast(importErrorMessage(parsed.error));
            return;
        }

        const confirmed = await askConfirm(buildImportMessage(sourceName, parsed.counts));
        if (!confirmed) {
            return;
        }

        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const result = applyPresetImport(settings, parsed);

        editing = null;
        msgEditing = null;
        signature = null;

        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);

        toast(`已从「${sourceName}」导入 ${result.prompts.length} 条提示词`);
    } finally {
        importBusy = false;
        win?.classList.remove('thrive-prompts--busy');
    }
}

/**
 * 确认框里的说明。既要说清进来多少，也要说清丢掉了什么——"有损"不能只是一句形容词。
 */
function buildImportMessage(sourceName, counts) {
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
        notes.push(`${counts.triggered} 条带触发器，触发器会被忽略（启用即总是带上）`);
    }
    if (counts.core > 0) {
        notes.push(`${counts.core} 条核心系统提示词（主提示词 / 越狱等）；它们是 ST 聊天用的，放在学习会话里可能重复交代同一件事`);
    }

    return `从「${sourceName}」导入 ${counts.imported} 条提示词：`
        + `启用 ${counts.enabled} / 停用 ${counts.disabled}，按预设里的顺序夹在「描述行」与「目标内容」之间。`
        + (skipped.length ? `跳过 ${skipped.join('、')}。` : '')
        + (notes.length ? `${notes.join('；')}。` : '')
        + '导入会替换当前所有自建提示词；目标内容的两条与开场白保留。继续吗？';
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
        // 注入位既没有抓手也不接受被拖到它后面：它代表这一场要看的东西，位置是固定的
        cancel: '.thrive-prompts__editor, [data-act], [data-pinned="true"]',
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
