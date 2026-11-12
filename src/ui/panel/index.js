import { renderPanel } from './view.js';
/**
 * ui/panel.js · 浮动面板
 *
 * 面板只装**作用于当前对话**的东西，全局设置一律留在扩展设置页：
 *   - 学习模式：一个总开关，整块可点；下面写着"学习中 / 上次学习 / 还差几条"
 *   - 立刻学一次 / 停止学习：不等判据，手动起一场会话（或中止正在跑的那场）
 *   - 更多设置（默认收起）：描述存哪儿、可写书——都只落在这一场
 *   - 角色描述落点、待确认改动、写入记录
 *
 * 判据（每 N 条 / 关键词）不在这里：它对所有对话一致，在设置页的「自动学习」组。
 * 面板里只读它来算"还差几条"，并在没配判据时指一句路。
 *
 * 另外三件事：
 *   - 重绘：refreshPanel 现算状态，签名没变就不碰 DOM
 *   - 交互：写入 / 丢弃 / 恢复 / 重写 / 开关学习 / 手动学习
 *   - 入口：initPanel 挂载，openPanel 给 `/thrive panel` 用
 *
 * 位置、尺寸、拖动这些几何细节在 ui/panel-layout.js；面板开没开的状态在 ui/shared.js
 * （徽章也要读它）。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { getCompressSnapshot } from '../../features/memory/compress.js';
import { getDescTargetSnapshot, isWorldbookDesc } from '../../features/memory/desc.js';
import { PANEL_EVENT, PANEL_TOGGLE_EVENT } from '../../shared/events.js';
import {
    getLearningView,
    isLearningRunning,
    startLearning,
    stopLearning,
} from '../../features/learning/learning.js';
import {
    PATCH_STATUS,
    applyPatch,
    discardPatch,
    diskDescription,
    getPatch,
    isUnresolved,
    restoreDescBackup,
    rewriteAppliedDescription,
} from '../../features/memory/patch.js';
import { summarizeDraft } from '../../features/memory/draft.js';
import {
    clearReadHash,
    ensureSettings,
    findLoreBackup,
    getDescBackup,
    getDescFormats,
    getLoreBackups,
    isChatAvailable,
    isEnabled,
    loreReadKey,
    markLoreBackupRestored,
    saveChat,
    setEnabled,
} from '../../features/settings/index.js';
import { getActiveCharacter, refreshDescriptionEditor, restoreLoreEntry } from '../../features/memory/index.js';
import { normalizeEol } from '../../shared/util.js';
import { syncBadgeOpenState } from './badge.js';
import { openCompressPanel } from '../compress/index.js';
import { changeDescFormats, changeDescStorage, changeWritableBook, descTargetView } from './desc-target.js';
import { openDraftWindow } from '../draft/index.js';
import { applyPanelLayout, bindDrag, bindPanelRelayout } from './layout.js';
import { refreshUI, registerSurfaces, setPanelOpen } from '../shared/refresh.js';
import { LOG, PANEL_ID, askConfirm, isPanelOpen, markPanelOpen, toast } from '../shared/common.js';
import { openTeachWindow } from '../teach/index.js';

/* ------------------------------------------------------------------ 浮动面板 */

let patchBusy = false;
let panelSignature = null;
/** 已经被"强制打开"过的那份 patch。只在它第一次出现时打开，之后用户关掉就是关掉 */
let forcedPatchId = null;
/**
 * 「已写入」展开着没有。
 *
 * 默认收起：这一段是流水账，内容会随着写入累积到十条，展开着会把模式开关挤到
 * 需要滚动才能看见的位置。状态放模块级而不是设置里——它只影响"这一次打开面板",
 * 刷新页面回到收起是合理的默认值，不值得为它多存一个键、多一次落盘。
 */
let historyExpanded = false;

/**
 * 「更多设置」展开着没有。理由同上：默认收起，面板打开的常态是"看状态、拨开关"，
 * 换落点、手动触发都是偶发动作。
 */
let moreExpanded = false;

/** 落点切换进行中：要建书 / 停用条目、还可能弹确认框，期间不接受第二次操作 */
let descTargetBusy = false;

/**
 * 挂载浮动面板。重复调用安全。
 *
 * 面板一开始是空的、收起的：模式那一段每次 refreshPanel 现画，记录有才画。
 */
export function initPanel() {
    if (document.getElementById(PANEL_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${PANEL_ID}" class="thrive-panel displayNone" role="dialog" aria-label="Thrive 面板"></div>`,
    );

    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        console.warn(`${LOG} 面板创建失败`);
        return;
    }

    // 事件挂在外壳上：内容每次整块重绘，挂在里面会跟着一起没
    panel.addEventListener('click', onPanelClick);
    // 折头是 div + role=button（按钮样式会把标题压成另一套观感），键盘要自己补
    panel.addEventListener('keydown', onPanelKeydown);
    // 「更多设置」里的两个下拉同样靠外壳接（重绘会把里面的节点换掉）
    panel.addEventListener('change', onPanelChange);
    document.addEventListener(PANEL_EVENT, () => refreshPanel());
    // 徽章点击只是发了个事件，开合由这里接（badge.js 不认识面板）
    document.addEventListener(PANEL_TOGGLE_EVENT, () => setPanelOpen(!isPanelOpen(), getContext()));

    bindDrag();
    bindPanelRelayout();
}

/**
 * 重绘浮动面板。
 *
 * 面板现在**总是有内容**：第一段是学习（一个总开关 + 状态行 + 立刻学一次），
 * 第二段是收起的「更多设置」，后面才是有才画的记录。所以它不再是"有记录才出现"，
 * 而是由面板的开关状态决定——打开着就画，关着就整块隐藏。
 *
 * @param {object} [ctx]
 */
export function refreshPanel(ctx = getContext()) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const settings = ensureSettings(ctx);

    /*
     * 统一使用世界书之后，这一段换了语义：描述不在角色卡上，也就没有"暂存 vs 磁盘"
     * 可对比。所以 patch 整段不参与渲染，改成一句"存在哪本书的哪条条目"（ADR-042）。
     */
    const worldbookDesc = isWorldbookDesc(ctx);
    const descTarget = worldbookDesc ? getDescTargetSnapshot(ctx) : null;

    const patch = worldbookDesc ? null : getPatch(ctx);
    const backups = getLoreBackups(ctx);
    // 描述上一版（backups.desc）是 card 模式的槽位；统一模式的撤销走世界书快照
    const descBackup = worldbookDesc ? null : getDescBackup(ctx);

    /*
     * "已写入"但角色卡上的描述已经不是那份内容了 —— 实测最常见的原因是：
     * 角色编辑面板里还停着写入前的文本，用户点了一下保存，旧文本把新内容盖了回去。
     * 这时候面板如果继续说"已写入"，就会出现"面板说写了、编辑器里什么都没有"。
     * 所以单独算一个状态：内容还在聊天记录里（patch.after），给一个「重写角色卡」的出口。
     */
    const drift = !worldbookDesc
        && Boolean(patch)
        && patch.status === PATCH_STATUS.APPLIED
        && Boolean(getActiveCharacter(ctx))
        && diskDescription(ctx) !== patch.after;

    /*
     * 另一种"已写入但对不上"：盘上是对的，编辑框里还停着别的文本。
     * 用户改过、或者写入那一刻正在框里打字，同步就会被跳过（不能盖掉正在敲的字）。
     * 这时给一个「填入编辑框」的出口，省得为了让它显示新内容还得先关掉面板。
     */
    const editorStale = !worldbookDesc
        && Boolean(patch)
        && patch.status === PATCH_STATUS.APPLIED
        && isDescriptionEditorStale(ctx, patch.after);

    /*
     * 新出现的待确认改动必须把面板顶出来：否则徽章上多个数字，用户不知道在哪处理。
     *
     * 但只在"这一份 patch 第一次出现"时打开。早先是每次重绘都展开，于是用户刚收起、
     * refreshPanel 又立刻把它顶开——表现为"关不掉"（有未处理改动时必现，刷新一次也会弹回来）。
     */
    if (isUnresolved(patch)) {
        if (patch.id !== forcedPatchId) {
            forcedPatchId = patch.id;
            markPanelOpen(true);
        }
    } else {
        forcedPatchId = null;
    }

    panel.classList.toggle('displayNone', !isPanelOpen());
    // 自动弹出也是"打开"，徽章的外观与 aria 必须跟上，否则会出现"面板明明在、
    // 徽章却说没开"——点一下反而把面板关了
    syncBadgeOpenState();
    if (!isPanelOpen()) {
        // 关着就不画。签名一并丢掉，下次打开必然整体重画
        panelSignature = null;
        return;
    }

    const learn = readLearnView(ctx, settings);
    const descChoice = descTargetView(ctx);
    const compress = getCompressSnapshot();
    const draft = summarizeDraft(ctx);

    /*
     * 重绘判据要含内容哈希：合并进同一份 patch 时 id 不变，两次改动的字数还可能刚好相等。
     * 学习状态也在里面——面板里就摆着那颗开关与"学习中"那一行，它们变了必须重画。
     * 「已写入」「更多设置」的展开状态同理：它们只改这段的 DOM，不重画就没有反馈。
     */
    const signature = JSON.stringify([
        learn.enabled,
        learn.usable,
        learn.queued,
        learn.running ? [learn.running.reason, learn.running.startedAt] : null,
        learn.last ? [learn.last.at, learn.last.ok, learn.last.toolCalls, learn.last.stopped] : null,
        learn.interval,
        learn.since,
        learn.keywordCount,
        settings.learnInterval,
        settings.learnKeywords,
        moreExpanded,
        // 落点两个下拉：模式、书名，以及"列表里有哪些书"（别处新建/删除之后要重排）
        [descChoice.storage, descChoice.book, descChoice.books.length, descChoice.formats],
        getActiveCharacter(ctx)?.name ?? '',
        descTarget ? [descTarget.mode, descTarget.book, descTarget.active] : null,
        patch ? [patch.id, patch.status, patch.before.length, patch.after.length, patch.after] : null,
        backups.map(item => [item.id, item.restoredAt]),
        descBackup ? descBackup.at : null,
        drift,
        editorStale,
        historyExpanded,
        compress.error,
        compress.items.map(item => [item.id, item.chars, item.level]),
        // 缓冲区：有几条被工具改过（标题栏那颗按钮的角标就读它）
        [draft.exists, draft.book, draft.touched],
    ]);
    if (signature === panelSignature) {
        return;
    }
    panelSignature = signature;

    /*
     * 整块重绘会把里面正在编辑的输入框一起换掉（光标、选区全丢）。判据就住在这块面板里，
     * 所以换 DOM 前记一笔焦点，换完再放回去——顺序不能反，否则拿到的是新节点。
     */
    const focus = capturePanelFocus();
    panel.innerHTML = renderPanel({
        learn,
        patch,
        descTarget,
        descChoice,
        backups,
        descBackup,
        drift,
        editorStale,
        compress,
        draft,
        moreExpanded,
        historyExpanded,
        characterName: getActiveCharacter(ctx)?.name ?? '',
    });
    restorePanelFocus(focus);

    // 内容换了高度可能也变了，重新摆一次（拖动后的位置在这里生效）
    applyPanelLayout(panel);
}

/**
 * 记下面板里当前的焦点位置。
 *
 * 只认带 `data-thrive-field` / `data-thrive-action` 的节点：重绘之后靠这两个属性
 * 就能找回同一个控件，不必给每个节点编 id。
 *
 * @returns {{selector: string, start: number|null, end: number|null}|null}
 */
function capturePanelFocus() {
    const active = document.activeElement;
    if (!active || typeof active.closest !== 'function' || !active.closest(`#${PANEL_ID}`)) {
        return null;
    }

    const selector = active.dataset?.thriveField
        ? `[data-thrive-field="${active.dataset.thriveField}"]`
        : active.dataset?.thriveAction
            ? `[data-thrive-action="${active.dataset.thriveAction}"]`
            : '';
    if (!selector) {
        return null;
    }

    return {
        selector,
        // number 输入框不支持 selectionStart，读到的是 null，写回时也不必管
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    };
}

/** @param {{selector: string, start: number|null, end: number|null}|null} focus */
function restorePanelFocus(focus) {
    if (!focus) {
        return;
    }

    const el = document.querySelector(`#${PANEL_ID} ${focus.selector}`);
    if (!el) {
        return;
    }

    try {
        el.focus({ preventScroll: true });
        if (focus.start !== null && focus.end !== null) {
            el.setSelectionRange(focus.start, focus.end);
        }
    } catch {
        // number 输入框、或节点已经不接受焦点：忽略即可，不值得为它打断重绘
    }
}

/**
 * 面板「学习」那一段要用的所有状态，一次算齐。
 *
 * 徽章与面板都从同一份状态出发（learning.js 的 getLearningView），省得两处各判
 * 一次、判出不一样的结果。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function readLearnView(ctx, settings) {
    const view = getLearningView(ctx, settings);
    const available = isChatAvailable(ctx);

    return {
        ...view,
        available,
        // 只剩一种"不可用"：没有对话。工具能不能用只有真发一次请求才知道，
        // 不在这里预先猜（ADR-052）。
        usable: available,
    };
}

/* -------------------------------------------------------------- 学习开关 */

/**
 * "现在点了也没用"的原因只有一个：没有打开的对话。
 *
 * 只判不喊：原因由面板正文里那行 notice 说明（整块压暗 + 一行字），切换本身一律静默——
 * 拨一下开关就弹一条 toast，在窄屏上挡住半块面板，比不给反馈更烦人。
 *
 * @param {object} ctx
 * @returns {boolean} 能不能切
 */
function canToggleLearn(ctx) {
    return isChatAvailable(ctx);
}

/**
 * 学习模式总开关（对话级，存在 chat_metadata 里）。
 *
 * 切换只影响"要不要自动触发学习"：正在跑的那一场不受影响，聊天请求也不会因此
 * 多出任何东西来（学习本来就在另一场会话里）。
 *
 * @param {object} ctx
 */
function toggleLearn(ctx) {
    if (!canToggleLearn(ctx)) {
        return;
    }

    setEnabled(ctx, !isEnabled(ctx));
    refreshUI(ctx);
}

/* ------------------------------------------------------------------ 面板入口 */

/**
 * 打开浮动面板，给 `/thrive panel` 用（徽章点击走的是同一套开关）。
 *
 * 面板里始终有「学习」这一段，所以"没有记录"不再是打不开的理由——
 * 也正因为如此它不会再回声"没什么可看"。
 *
 * @param {object} [ctx]
 * @returns {boolean} 面板是否被打开（现在总是 true，返回值留给命令层）
 */
export function openPanel(ctx = getContext()) {
    setPanelOpen(true, ctx);

    const panel = document.getElementById(PANEL_ID);
    panel?.scrollIntoView({ block: 'nearest' });
    return Boolean(panel);
}

/**
 * 角色编辑框里是不是还停着"不是这次写入"的文字。
 *
 * 页面刷新后编辑框是空的、面板没开时也可能取不到元素 —— 这两种都不算 stale，
 * 别在没事的时候挂一个按钮在那儿。
 *
 * @param {object} ctx
 * @param {string} applied 已写入的全文（patch.after）
 */
function isDescriptionEditorStale(ctx, applied) {
    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return false;
    }

    // 面板正在编辑别的角色：那个框跟这次写入无关
    const nameField = document.getElementById('character_name_pole');
    const character = getActiveCharacter(ctx);
    if (nameField && character?.name && nameField.value && nameField.value !== character.name) {
        return false;
    }

    return normalizeEol(textarea.value) !== normalizeEol(applied);
}

function onPanelClick(event) {
    const trigger = event.target.closest('[data-thrive-action]');
    const action = trigger?.dataset.thriveAction;
    if (!action) {
        return;
    }

    switch (action) {
        case 'accept':
            void applyAndReport(false);
            break;
        case 'force':
            void applyAndReport(true);
            break;
        case 'discard':
            void discardAndReport();
            break;
        case 'dismiss-record':
            discardPatch(getContext());
            refreshPanel(getContext());
            break;
        case 'toggle-history':
            historyExpanded = !historyExpanded;
            refreshPanel(getContext());
            break;
        case 'toggle-more':
            moreExpanded = !moreExpanded;
            refreshPanel(getContext());
            break;
        case 'toggle-learn':
            toggleLearn(getContext());
            break;
        case 'learn-now':
            void learnNowAndReport();
            break;
        case 'open-teach':
            openTeachWindow();
            break;
        case 'stop-learn':
            stopLearnAndReport();
            break;
        case 'hide-panel':
            setPanelOpen(false);
            break;
        case 'open-compress':
            /* 压缩面板是另一个窗口，浮动面板不动：用户可能想两边对照着看 */
            openCompressPanel(getContext());
            break;
        case 'open-draft':
            /* 同上：虚拟世界书也是独立窗口，开着它还能继续聊 */
            openDraftWindow(getContext());
            break;
        case 'restore-lore':
            void restoreLoreAndReport(trigger.dataset.backupId);
            break;
        case 'restore-desc':
            void restoreDescAndReport();
            break;
        case 'rewrite-desc':
            void rewriteDescAndReport();
            break;
        case 'sync-editor':
            syncEditorAndReport();
            break;
        default:
            break;
    }
}

/**
 * 键盘激活折头与开关。
 *
 * 折头和模式块都是 div + role 而不是 <button>：原生按钮在 ST 的主题下会带上一套
 * 边框和内边距，把"分区标题"压成了另一个东西。代价是无障碍行为要自己补——Enter /
 * 空格等价于点一下，其它键不管，免得把正文里的滚动也吞掉。
 */
function onPanelKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    const trigger = event.target.closest('[data-thrive-action][role="button"], [data-thrive-action][role="switch"]');
    if (!trigger) {
        return;
    }

    // 空格默认是翻页，Enter 默认可能触发表单提交，两者都要拦
    event.preventDefault();
    trigger.click();
}

/**
 * 「更多设置」里的两个下拉。
 *
 * 都是对话级的落点（ADR-044），切换带副作用：要建书 / 停用条目 / 弹一次确认。
 * 所以处理完一律整块重绘——下拉的值从状态重新读，切换失败（比如没有选中角色）时
 * 会自己弹回原值，不用手写回滚。
 */
function onPanelChange(event) {
    const field = event.target?.dataset?.thriveField;
    if (!field || (field !== 'storage' && field !== 'book' && !field.startsWith('format-'))) {
        return;
    }

    if (descTargetBusy) {
        // 上一次还在等确认框 / 建书：先把它读回状态值，别让下拉停在一个没生效的选项上
        refreshPanel(getContext());
        return;
    }

    descTargetBusy = true;
    const ctx = getContext();
    const value = String(event.target.value ?? '');
    const formats = new Set(getDescFormats(ctx));
    if (field.startsWith('format-')) {
        const format = field.slice('format-'.length);
        if (event.target.checked) formats.add(format);
        else formats.delete(format);
    }

    const done = () => {
        descTargetBusy = false;
        // 落点变了：patch 的可用性、设置页的提示、描述那一整段都要跟着刷
        refreshUI(ctx);
    };

    (field.startsWith('format-')
        ? changeDescFormats(ctx, [...formats])
        : field === 'storage'
        ? changeDescStorage(ctx, value)
        : changeWritableBook(ctx, value)
    ).then(done, err => {
        console.error(`${LOG} 切换落点失败`, err);
        done();
    });
}

/**
 * 不等判据，立刻学一次（`manual` 触发）。
 *
 * 存在的理由不是方便，而是**可验证**：用户配完判据之后总得能立刻看见它生效，
 * 否则要等到真出现那句话，期间只能猜。顺带它也是"我现在就想让它学一下"的正门——
 * 不需要为了学一次先去改判据。
 *
 * 不 await 整场：一次学习要跑十几秒，面板不该在这期间没有响应。开始成功之后
 * 状态行会自己变成"正在学"，结果出来时 LEARNING_EVENT 会把面板刷一遍。
 * 失败只报"没能开始"的原因——跑到一半失败属于结果，由面板的状态行说明。
 */
async function learnNowAndReport() {
    const ctx = getContext();

    if (!isChatAvailable(ctx)) {
        toast('请先打开一个对话');
        return;
    }

    const started = await startLearning(ctx, { reason: 'manual' });

    if (!started.ok) {
        toast(started.hint ?? `没能开始学习：${started.error}`);
        return;
    }

    // 排上队了要明说：否则用户点了按钮，看见的却还是"正在学（上一场）"
    if (started.queued > 0) {
        toast(`已排队（第 ${started.queued} 位），上一场跑完接着学`);
    }

    // 开始成功不弹 toast：状态行与徽章会立刻变成"学习中"，再弹一条反而挡住面板
    refreshUI(ctx);
}

/**
 * 中止正在跑的那一场。
 *
 * 中止只停"还没发生的"：已经写进世界书 / 角色描述的改动不会撤回（那些是工具
 * 当场落盘的），所以不弹确认——按钮上写着"停止"，用户要的是赶紧停。
 */
function stopLearnAndReport() {
    const ctx = getContext();

    if (!isLearningRunning()) {
        refreshPanel(ctx);
        return;
    }

    stopLearning();
    toast('已中止这次学习（排队的也一起取消了；已经写进去的内容不会撤回）');
    refreshUI(ctx);
}

/** 写入 / 强制覆盖。失败时把原因说清楚，别让按钮看起来"没反应" */
async function applyAndReport(force) {
    if (patchBusy) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await applyPatch(getContext(), { force });

        if (result.ok) {
            const name = getActiveCharacter(getContext())?.name;
            const reason = result.editor?.reason;
            const edited = result.editor?.synced === false && reason === 'edited';
            const who = name ? `「${name}」的` : '';

            // 编辑器里用户改过描述：不覆盖他的输入，但必须说清楚"保存会盖掉这次写入"
            if (edited) {
                toast(`已写入${who}角色卡，但编辑框里的描述你改过，这次没覆盖它；`
                    + '要换成新内容，点浮动面板上的「填入编辑框」');
            } else if (reason === 'overwrote-edited') {
                toast(`已写入${who}角色卡；编辑面板里未保存的旧描述被这次写入覆盖了`);
            } else {
                toast(`已写入${who}角色卡，下一轮请求生效`);
            }
            return;
        }

        if (result.error === 'CONFLICT') {
            toast('描述在暂存之后被改动过，请选择强制覆盖或丢弃改动');
        } else if (result.error === 'NO_CHAR') {
            toast('当前没有选中角色，无法写入描述');
        } else {
            toast(`写入失败：${result.hint ?? result.error}`);
        }
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel();
    }
}

async function discardAndReport() {
    if (patchBusy) {
        return;
    }

    const confirmed = await askDiscardPatch();
    if (!confirmed) {
        return;
    }

    discardPatch(getContext());
    refreshPanel(getContext());
    toast('已丢弃这份改动，角色描述没有变化');
}

/**
 * 把一条世界书条目恢复成写入前。
 *
 * 恢复要写盘、要覆盖用户可能已经手改过的内容，所以先确认一次；
 * 恢复完再作废读取登记——书被插件动过，模型下一次写入必须重新读。
 */
async function restoreLoreAndReport(backupId) {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const backup = findLoreBackup(ctx, backupId);

    if (!backup) {
        toast('这条记录已经不在对话框里了');
        refreshPanel(ctx);
        return;
    }

    const created = backup.action === 'created';
    const message = created
        ? `「${backup.book}」里的「${backup.title}」会被删掉，回到写入前（没有这条）的状态。确定吗？`
        : `「${backup.book}」里的「${backup.title}」会被改回 ${backup.before.length} 字的旧内容，之后的修改都会丢。确定吗？`;

    const confirmed = await askConfirm(message);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await restoreLoreEntry(ctx, backup);

        if (!result.ok) {
            toast(result.hint ?? `恢复失败：${result.error}`);
            return;
        }

        markLoreBackupRestored(ctx, backup.id);
        clearReadHash(ctx, loreReadKey(backup.book, backup.title));
        saveChat(ctx);

        toast(result.action === 'gone'
            ? `「${backup.title}」已经不在「${backup.book}」里了`
            : created
                ? `已从「${backup.book}」删掉「${backup.title}」`
                : `已把「${backup.title}」恢复到写入前`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

async function restoreDescAndReport() {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const backup = getDescBackup(ctx);

    if (!backup) {
        toast('还没有可恢复的上一版');
        refreshPanel(ctx);
        return;
    }

    const confirmed = await askConfirm(`角色描述会被改回 ${backup.before.length} 字的上一版，当前的描述会被覆盖。确定吗？`);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await restoreDescBackup(ctx);

        if (!result.ok) {
            if (result.error === 'NO_CHANGE') {
                toast('当前描述已经和上一版一致');
            } else if (result.error === 'PATCH_PENDING') {
                toast('还有一份待确认的描述改动，先处理它');
            } else {
                toast(result.hint ?? `恢复失败：${result.error}`);
            }
            return;
        }

        toast(`已恢复到上一版（${result.chars} 字）`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

/**
 * 把"已写入"的那份内容重新写回角色卡（见 renderPatchSection 的 drift 说明）。
 *
 * 覆盖前确认一次：这次会把角色卡上现在这一版盖掉，但会先存进「上一版」快照，
 * 所以点错了还能再恢复回来。
 */
async function rewriteDescAndReport() {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const patch = getPatch(ctx);
    if (!patch) {
        refreshPanel(ctx);
        return;
    }

    const current = diskDescription(ctx);
    const name = getActiveCharacter(ctx)?.name;
    const confirmed = await askConfirm(`「${name ?? '当前角色'}」的描述会被改回 ${patch.after.length} 字的那份内容，`
        + `现在的 ${current.length} 字会被覆盖（会先存进「上一版」快照，随时能恢复）。确定吗？`);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await rewriteAppliedDescription(ctx);

        if (!result.ok) {
            toast(result.error === 'NO_CHANGE'
                ? '角色卡上已经是这份内容，不用重写'
                : `写入失败：${result.hint ?? result.error}`);
            return;
        }

        const edited = result.editor?.synced === false && result.editor?.reason === 'edited';
        toast(edited
            ? `已重写${name ? `「${name}」的` : ''}角色卡；编辑框里你改过的内容没被覆盖，要同步点面板上的「填入编辑框」`
            : `已重写${name ? `「${name}」的` : ''}角色卡（${patch.after.length} 字）`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

/**
 * 把已写入的内容推进角色编辑框，不管框里现在是什么。
 *
 * 只有用户点「填入编辑框」才会走到这里 —— 这是"我知道会覆盖我刚才敲的字"的显式动作，
 * 所以不弹确认。写入路径自己遇到用户改过的框是不动的（见 applyDescriptionLocally），
 * 这个按钮就是给它留的出口：不关面板也能让框里看到新内容。
 */
function syncEditorAndReport() {
    const ctx = getContext();
    const patch = getPatch(ctx);

    if (!patch || patch.status !== PATCH_STATUS.APPLIED) {
        refreshPanel(ctx);
        return;
    }

    const result = refreshDescriptionEditor(getActiveCharacter(ctx), patch.after);

    if (!result.synced) {
        toast(result.reason === 'no-editor'
            ? '没找到角色描述的文本框：先把角色编辑面板打开'
            : '没能把内容放进编辑框');
        return;
    }

    toast(`编辑框已换成这次写入的内容（${patch.after.length} 字）`);
    refreshPanel(ctx);
}

async function askDiscardPatch() {
    return askConfirm('丢弃后这份改动就没了，角色描述保持原样。确定丢弃吗？');
}

function setPanelBusy(busy) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }
    panel.classList.toggle('thrive-panel--busy', busy);
    panel.setAttribute('aria-busy', String(busy));
}

/* 登记给刷新编排：面板的刷新入口就这一个 */
registerSurfaces({
    panel: ({ ctx }) => refreshPanel(ctx),
    // 压缩扫描结果变了：入口那段的高亮与提示要跟着变，整块重画（签名会挡住无变化的）
    compressEntry: () => refreshPanel(getContext()),
});
