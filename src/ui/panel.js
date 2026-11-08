/**
 * ui/panel.js · 浮动面板
 *
 * 面板只装**作用于当前对话**的东西，全局设置一律留在扩展设置页：
 *   - 模式：主动 / 被动两块，整块可点（不再有单独的「开 / 关」按钮）
 *   - 更多设置（默认收起）：被动判据与「现在触发一次」——它们的效果只落在这一场对话
 *   - 角色描述落点、待确认改动、写入记录
 *
 * 另外三件事：
 *   - 重绘：refreshPanel 现算状态，签名没变就不碰 DOM
 *   - 交互：写入 / 丢弃 / 恢复 / 重写 / 开关模式 / 改判据
 *   - 入口：initPanel 挂载，openPanel 给 `/thrive panel` 用
 *
 * 位置、尺寸、拖动这些几何细节在 ui/panel-layout.js；面板开没开的状态在 ui/shared.js
 * （徽章也要读它）。
 */

import { getContext } from '../../../../../extensions.js';
import { getCompressSnapshot } from '../compress.js';
import { getDescTargetSnapshot, isWorldbookDesc } from '../desc.js';
import { diagnoseEnvironment, formatDiagnosis } from '../diagnostics.js';
import { PANEL_EVENT, PANEL_TOGGLE_EVENT } from '../events.js';
import {
    PASSIVE_INTERVAL_MAX,
    armManual,
    describePending,
    intervalProgress,
    parseKeywords,
} from '../passive.js';
import {
    PATCH_STATUS,
    applyPatch,
    buildDiffRows,
    discardPatch,
    diskDescription,
    getPatch,
    isUnresolved,
    restoreDescBackup,
    rewriteAppliedDescription,
} from '../patch.js';
import { syncFromContext } from '../prompt.js';
import {
    clearReadHash,
    ensureSettings,
    findLoreBackup,
    getDescBackup,
    getLoreBackups,
    getPending,
    getState,
    hasAnyModule,
    isChatAvailable,
    isEnabled,
    loreReadKey,
    markLoreBackupRestored,
    saveChat,
    setEnabled,
} from '../store.js';
import { getActiveCharacter, refreshDescriptionEditor, restoreLoreEntry } from '../targets.js';
import { escapeHtml, normalizeEol } from '../util.js';
import { syncBadgeOpenState } from './badge.js';
import { openCompressPanel } from './compress-panel.js';
import { applyPanelLayout, bindDrag, bindPanelRelayout } from './panel-layout.js';
import { refreshBadgeOnly, refreshUI, registerSurfaces, setPanelOpen } from './refresh.js';
import { LOG, PANEL_ID, askConfirm, isPanelOpen, markPanelOpen, toast } from './shared.js';

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
 * 改判据是偶发动作。
 */
let moreExpanded = false;

/** 判据输入框的落盘防抖（关键词是边打边存的） */
let moreSaveTimer = 0;

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
    // 「更多设置」里那两个判据输入框，同样靠外壳接（重绘会把里面的节点换掉）
    panel.addEventListener('input', onPanelInput);
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
 * 面板现在**总是有内容**：第一段是模式（主动 / 被动 两块），第二段是收起的「更多设置」，
 * 后面才是有才画的记录。所以它不再是"有记录才出现"，而是由面板的开关状态决定——
 * 打开着就画，关着就整块隐藏。
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
    const worldbookDesc = isWorldbookDesc(settings);
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

    const mode = readModeView(ctx, settings);
    const compress = getCompressSnapshot();

    /*
     * 重绘判据要含内容哈希：合并进同一份 patch 时 id 不变，两次改动的字数还可能刚好相等。
     * 模式状态也在里面——面板里就摆着两块开关，它们变了必须重画。
     * 「已写入」「更多设置」的展开状态同理：它们只改这段的 DOM，不重画就没有反馈。
     * 判据的两个值在里面，是因为折头的摘要与被动那块的"还差几条"都跟着它们走。
     * 压缩那段同理：条数或字数变了，入口上的提示与高亮都要跟着变。
     */
    const signature = JSON.stringify([
        mode.active,
        mode.passive,
        mode.usable,
        mode.diag.code,
        mode.pending ? [mode.pending.reason, mode.pending.keyword] : null,
        mode.interval,
        mode.since,
        mode.keywordCount,
        settings.passiveInterval,
        settings.passiveKeywords,
        moreExpanded,
        descTarget ? [descTarget.mode, descTarget.book, descTarget.active, descTarget.cardChars] : null,
        patch ? [patch.id, patch.status, patch.before.length, patch.after.length, patch.after] : null,
        backups.map(item => [item.id, item.restoredAt]),
        descBackup ? descBackup.at : null,
        drift,
        editorStale,
        historyExpanded,
        compress.error,
        compress.items.map(item => [item.id, item.chars, item.level]),
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
        mode,
        settings,
        patch,
        descTarget,
        backups,
        descBackup,
        drift,
        editorStale,
        compress,
        moreExpanded,
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

/** 判据输入框的落盘防抖。和设置页的关键词框一样，边打边存没有意义 */
function saveSoon(ctx) {
    clearTimeout(moreSaveTimer);
    moreSaveTimer = setTimeout(() => {
        moreSaveTimer = 0;
        ctx.saveSettingsDebounced?.();
    }, 300);
}

/**
 * 面板「模式」那一段要用的所有状态，一次算齐。
 *
 * 徽章与面板都从同一份状态出发，省得两处各判一次、判出不一样的结果。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function readModeView(ctx, settings) {
    const none = !hasAnyModule(settings);
    const available = isChatAvailable(ctx);
    const diag = diagnoseEnvironment(ctx);
    const progress = intervalProgress(ctx, settings);
    const keywords = parseKeywords(settings.passiveKeywords);

    return {
        active: isEnabled(ctx),
        passive: settings.passiveEnabled === true,
        pending: getPending(ctx),
        // 三种"不可用"共用一档：没有可写模块、没有对话、环境不支持工具调用
        usable: available && !none && diag.ok,
        none,
        available,
        diag,
        interval: progress.interval,
        since: progress.since,
        remaining: progress.remaining,
        keywordCount: keywords.length,
    };
}

/* -------------------------------------------------------------- 模式开关 */

/**
 * "现在点了也没用"的三个原因，任一成立就不能切。
 *
 * 只判不喊：原因由面板正文里那行 notice 说明（整块压暗 + 一行字），切换本身一律静默——
 * 拨一下开关就弹一条 toast，在窄屏上挡住半块面板，比不给反馈更烦人。
 *
 * @param {object} ctx
 * @param {object} settings
 * @returns {boolean} 能不能切
 */
function canToggleMode(ctx, settings) {
    // 模块全关时开关没有意义；没对话 / 环境不支持工具调用时开了也只是"灯亮着"
    // （ADR-020：不替用户去改 ST 的设置与模块）
    return hasAnyModule(settings) && isChatAvailable(ctx) && diagnoseEnvironment(ctx).ok;
}

/**
 * 主动开关（对话级，存在 chat_metadata 里）。
 * @param {object} ctx
 * @param {object} settings
 */
function toggleActive(ctx, settings) {
    if (!canToggleMode(ctx, settings)) {
        return;
    }

    // 切换只改变注入与 shouldRegister 的依据，不重载页面、不插消息
    setEnabled(ctx, !isEnabled(ctx));
    syncFromContext(ctx);
    refreshUI(ctx);
}

/**
 * 被动学习的总开关（全局设置，不按对话保存）。
 *
 * 关掉时把已经挂上的待学习一并丢掉：它本来就是被动学习攒出来的，
 * 留着会出现"被动显示关闭、徽章却在闪待学"这种自相矛盾的状态。
 *
 * 切完不弹 toast：被动那块自己的第二行就写着"还差几条 / 没有判据"，状态已经在眼前。
 */
function togglePassive(ctx, settings) {
    if (!canToggleMode(ctx, settings)) {
        return;
    }

    const next = settings.passiveEnabled !== true;
    settings.passiveEnabled = next;
    ctx.saveSettingsDebounced?.();

    if (!next) {
        getState(ctx).passive.pending = null;
        saveChat(ctx);
    }

    syncFromContext(ctx);
    refreshUI(ctx);
}

/* ------------------------------------------------------------------ 面板入口 */

/**
 * 打开浮动面板，给 `/thrive panel` 用（徽章点击走的是同一套开关）。
 *
 * 面板里始终有「模式」这一段，所以"没有记录"不再是打不开的理由——
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

function renderPanel({
    mode,
    settings,
    patch,
    descTarget,
    backups,
    descBackup,
    drift = false,
    editorStale = false,
    compress = getCompressSnapshot(),
    moreExpanded: moreOpen = false,
}) {
    const pending = isUnresolved(patch);
    const counts = [];
    if (pending) {
        counts.push('待确认 1');
    } else if (drift) {
        counts.push('描述已变');
    }
    if (backups.length > 0) {
        counts.push(`已写入 ${backups.length}`);
    }

    /*
     * 压缩不再是正文里的一段，而是标题栏上的一颗按钮：它只做一件事——打开压缩侧栏。
     * 条数做成按钮右上角的小角标，有超长内容时整颗按钮点亮（is-alert）。
     * 这样面板正文只剩"当前对话"的三段，不用为一件低频操作常年占一屏。
     */
    const compressCount = compress.items.length;
    const compressHard = compress.items.filter(item => item.level === 'hard').length;
    const compressAlert = compressCount > 0;
    const compressTitle = compressAlert
        ? `压缩：${compressCount} 条超软提醒${compressHard > 0 ? ` · ${compressHard} 条超硬上限` : ''}。点开逐条处理`
        : '压缩：没有超长内容，点开可以确认或重新扫描';

    const bar = `
        <div class="thrive-panel__bar">
            <i class="fa-solid fa-grip-vertical thrive-panel__grip" title="按住拖动可移动面板" aria-hidden="true"></i>
            <span class="thrive-panel__title">Thrive</span>
            <span class="thrive-panel__summary">${escapeHtml(counts.join(' · '))}</span>
            <div class="menu_button thrive-panel__compress${compressAlert ? ' is-alert' : ''}"
                data-thrive-action="open-compress" title="${escapeHtml(compressTitle)}"
                aria-label="${escapeHtml(compressTitle)}">
                <i class="fa-solid fa-compress" aria-hidden="true"></i>
                ${compressAlert ? `<span class="thrive-panel__compress-count">${compressCount}</span>` : ''}
            </div>
            <div class="menu_button thrive-panel__toggle" data-thrive-action="hide-panel"
                title="收起面板；输入框旁的徽章随时能把它叫回来">收起</div>
        </div>`;

    const body = [
        renderModeSection(mode),
        renderMoreSection({ mode, settings, expanded: moreOpen }),
        renderDescTargetSection(descTarget),
        renderPatchSection(patch, drift, editorStale),
        renderHistorySection(backups, descBackup, historyExpanded),
    ].filter(Boolean).join('');

    return `${bar}<div class="thrive-panel__body">${body}</div>`;
}

/**
 * 模式分区：主动 / 被动两块，横排。
 *
 * 不再有分区标题，也不再有"都没开 / 主动开着"这种总述——两块自己就是标题，
 * 灯亮灯灭加上第二行的"本对话 / 全局 · 还差几条"已经说完了要说的。
 * 这一块也是整个面板最常点的地方，所以整块可点，不再挂一颗小小的「开 / 关」。
 *
 * @param {ReturnType<typeof readModeView>} mode
 */
function renderModeSection(mode) {
    const { active, passive, usable, none, available, diag, pending, interval, remaining, keywordCount } = mode;

    /*
     * 被动那块第二行要跟着判据走：开了但一条判据都没有是最常见的空转状态，
     * 只写"全局"等于没说——用户以为开了就会自己学。
     */
    const passiveHint = !passive
        ? '全局'
        : interval > 0
            ? `还差 ${remaining} 条`
            : keywordCount > 0
                ? `${keywordCount} 个词`
                : '没有判据';

    /*
     * 不可用的原因只能写一条：三条同时列出来，用户还是不知道该先改哪个。
     * 顺序和以前徽章的 tooltip 一致——先看模块，再看对话，最后看环境。
     */
    const blocked = none
        ? '两个模块都关着，请先在扩展设置里开启至少一个。'
        : !available
            ? '请先打开一个对话。'
            : !diag.ok
                ? `工具调用不可用：${formatDiagnosis(diag)}`
                : '';

    return `
        <section class="thrive-panel__section thrive-modes">
            <div class="thrive-modes__row">
                ${renderModeTile({
                    action: 'toggle-active',
                    variant: 'active',
                    title: '主动学习',
                    hint: '本对话',
                    on: active,
                    usable,
                })}
                ${renderModeTile({
                    action: 'toggle-passive',
                    variant: 'passive',
                    title: '被动学习',
                    hint: passiveHint,
                    on: passive,
                    usable,
                })}
            </div>
            ${blocked ? `<div class="thrive-panel__notice thrive-panel__notice--warn">${escapeHtml(blocked)}</div>` : ''}
            ${pending
                ? `<div class="thrive-mode__pending">待学习：${escapeHtml(describePending(pending))} · 下一轮生效</div>`
                : ''}
        </section>`;
}

/**
 * 一块开关。灯亮 = 开，灭 = 关；不可用时整块压暗，点了不动（原因在下面那行 notice）。
 *
 * 用 div + role="switch" + tabindex 而不是 <button>：按钮样式会把这一块压成另一种观感，
 * 而整块可点又要能 Tab 到、空格切换，所以无障碍行为自己补（onPanelKeydown）。
 *
 * @param {{action: string, variant: 'active'|'passive', title: string, hint: string,
 *     on: boolean, usable: boolean}} props
 */
function renderModeTile({ action, variant, title, hint, on, usable }) {
    // 不可用时不要说"点一下切换"：点了不会动，原因就在下面那行 notice 里
    const tip = usable
        ? `${title}：${hint}（点一下切换）`
        : `${title}：现在切换不了——原因见下方说明`;

    return `
        <div class="thrive-mode thrive-mode--${variant}${on ? ' is-on' : ''}${usable ? '' : ' is-muted'}"
            role="switch" tabindex="0" aria-checked="${on ? 'true' : 'false'}"
            data-thrive-action="${action}"
            title="${escapeHtml(tip)}">
            <span class="thrive-mode__led" aria-hidden="true"></span>
            <span class="thrive-mode__title">${escapeHtml(title)}</span>
            <span class="thrive-mode__hint">${escapeHtml(hint)}</span>
        </div>`;
}

/**
 * 「更多设置」：从设置页搬过来的那一组。
 *
 * 这几项的效果都只落在**当前对话**上（判据命中后借的是这一场对话的一轮，手动触发同理），
 * 所以它们跟着模式开关一起住在面板里；设置页只剩"跨对话都一样"的那些。
 *
 * 默认收起：面板打开的常态是"看状态、拨开关"，改判据是偶发动作。
 * 块内平铺，不再套第二层折叠。
 *
 * @param {{mode: ReturnType<typeof readModeView>, settings: object, expanded: boolean}} props
 */
function renderMoreSection({ mode, settings, expanded }) {
    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    const keywordCount = mode.keywordCount;

    const meta = interval > 0 || keywordCount > 0
        ? [interval > 0 ? `${interval} 条` : '', keywordCount > 0 ? `${keywordCount} 词` : ''].filter(Boolean).join(' · ')
        : '未配判据';

    const rows = expanded
        ? `<div class="thrive-more">
            <div class="thrive-more__row">
                <label class="thrive-more__label" for="thrive_more_interval">每 N 条</label>
                <input id="thrive_more_interval" class="text_pole thrive-more__number" type="number"
                    min="0" max="${PASSIVE_INTERVAL_MAX}" step="1" inputmode="numeric" placeholder="0"
                    data-thrive-field="interval" value="${interval > 0 ? interval : ''}">
                <span class="thrive-more__meta">${mode.since} / ${interval > 0 ? interval : '—'}</span>
            </div>
            <textarea id="thrive_more_keywords" class="text_pole thrive-more__keywords" rows="2"
                spellcheck="false" placeholder="关键词，逗号分隔"
                data-thrive-field="keywords">${escapeHtml(settings.passiveKeywords ?? '')}</textarea>
            <div class="thrive-panel__actions">
                <small class="thrive-hint">0 条 = 不用条数判据；命中后只借当前对话一轮。</small>
                <div class="menu_button thrive-panel__button" data-thrive-action="trigger-once"
                    title="不等判据，立刻给下一轮挂一次学习，用来验证判据配得对不对">现在触发一次</div>
            </div>
        </div>`
        : '';

    return `
        <section class="thrive-panel__section thrive-panel__section--fold">
            <div class="thrive-panel__head thrive-panel__fold${expanded ? ' is-open' : ''}"
                role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"
                data-thrive-action="toggle-more"
                title="展开 / 收起被动学习判据（只影响当前对话的触发）">
                <span class="thrive-panel__section-title">
                    <i class="fa-solid fa-chevron-right thrive-panel__fold-icon" aria-hidden="true"></i>更多设置
                </span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            ${rows}
        </section>`;
}

/**
 * 统一模式的说明段：描述存在哪本书的哪条条目、有没有被扫描到。
 *
 * 这里刻意不显示正文、也不做 diff —— 新模式明确不再提供"旧人物描述的 diff"（ADR-042）。
 * 要改内容就去世界书编辑器或压缩面板；面板只负责回答"它现在在哪儿、生不生效"。
 *
 * @param {{book: string, title: string, active: boolean|null, cardChars: number}|null} descTarget
 */
function renderDescTargetSection(descTarget) {
    if (!descTarget) {
        return '';
    }

    const { book, title, active, cardChars } = descTarget;
    const inactive = active === false;

    const notice = inactive
        ? `「${book}」当前没有被扫描到：这条常驻条目不会进入上下文。`
            + '到「世界书」面板勾选这本书，或在扩展设置里把它设为本角色的世界书。'
        : '常驻条目，每一轮都会注入。要直接改内容，去世界书编辑器或压缩面板。';

    const cardWarn = cardChars > 0
        ? `<div class="thrive-panel__notice thrive-panel__notice--warn">角色卡上还留着 ${cardChars} 字描述，`
            + 'ST 仍会把它注入，模型会看到两份。要单一来源请到角色卡里清空（插件不会自动改）。</div>'
        : '';

    return `
        <section class="thrive-panel__section">
            <div class="thrive-panel__head">
                <span class="thrive-panel__section-title">角色描述 · 世界书条目</span>
                <span class="thrive-panel__meta">${escapeHtml(book || '（没有书名）')}</span>
            </div>
            <div class="thrive-panel__notice${inactive ? ' thrive-panel__notice--warn' : ''}">${escapeHtml(notice)}</div>
            ${cardWarn}
            <div class="thrive-panel__actions">
                <small class="thrive-hint">存在「${escapeHtml(book)}」的 ${escapeHtml(title)} 里。这个模式不做暂存，也没有 diff。</small>
            </div>
        </section>`;
}

/**
 * 待确认分区。没有 patch 时整段不渲染。
 * @param {object|null} patch
 * @param {boolean} [drift] 已写入，但角色卡上已经不是这份内容
 * @param {boolean} [editorStale] 已写入，但角色编辑框里还停着别的文字
 */
function renderPatchSection(patch, drift = false, editorStale = false) {
    if (!patch) {
        return '';
    }

    const conflict = patch.status === PATCH_STATUS.CONFLICT;
    const applied = patch.status === PATCH_STATUS.APPLIED;
    const name = getActiveCharacter(getContext())?.name;

    const title = applied ? '角色描述 · 已写入' : conflict ? '角色描述 · 冲突' : '角色描述 · 待确认';
    const delta = patch.after.length - patch.before.length;
    const deltaText = `${delta > 0 ? '+' : ''}${delta}`;
    const meta = `${formatTime(patch.createdAt)} · ${patch.before.length} → ${patch.after.length} 字（${deltaText}）`;
    const when = patch.appliedAt ? `（${formatTime(patch.appliedAt)}）` : '';

    const notice = applied
        ? drift
            ? '角色卡上的描述已经和这次写入不一致了：可能是你在编辑器里自己改过，'
                + '也可能是编辑面板还停着旧文本、一次保存把它盖了回去。这份内容只留在记录里，'
                + '要重新落盘得点「重写角色卡」。'
            : editorStale
                ? '角色卡上已经是这份内容了，但角色编辑框里还是别的文字'
                    + '（你改过，或者写入时正在框里输入）。直接保存会把这次写入盖回去；'
                    + '点「填入编辑框」把这份内容放进框里，不用关面板。'
                : `已写入${name ? `「${name}」的` : ''}角色卡${when}，下一轮请求开始生效。`
        : conflict
            ? '磁盘上的描述在暂存之后被改动过。这里不做自动合并：要么整份覆盖，要么丢弃。'
            : '还没写入角色卡。点「写入角色卡」后从下一轮请求开始生效。';

    const body = applied ? '' : renderDiff(buildDiffRows(patch.before, patch.after));
    const actions = applied ? renderAppliedActions(drift, editorStale) : renderPendingActions(conflict);
    const hint = applied ? appliedHint(drift, editorStale) : '面板只读：只能整份写入或丢弃，不能在这里改文本。';

    const noticeClass = conflict || drift || editorStale
        ? 'thrive-panel__notice thrive-panel__notice--warn'
        : 'thrive-panel__notice';

    return `
        <section class="thrive-panel__section">
            <div class="thrive-panel__head">
                <span class="thrive-panel__section-title">${title}</span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            <div class="${noticeClass}">${escapeHtml(notice)}</div>
            ${body}
            <div class="thrive-panel__actions">
                <small class="thrive-hint">${hint}</small>
                ${actions}
            </div>
        </section>`;
}

/**
 * 已写入分区：世界书写入记录 + 描述上一版。
 *
 * 默认收起。这一段是流水账（最多十条），展开着会把模式开关挤下去；收起后只留一行
 * 折头，上面写着有几条、最近一次是什么时候——"有没有东西可恢复"一眼能看出来，
 * 要点开才占地方。
 *
 * 记录只读，唯一的动作是恢复——世界书没有 patch，写错了只能靠这条退路。
 *
 * @param {Array<object>} backups
 * @param {{ before: string, at: number }|null} descBackup
 * @param {boolean} expanded
 */
function renderHistorySection(backups, descBackup, expanded) {
    if (backups.length === 0 && !descBackup) {
        return '';
    }

    const latest = Math.max(
        0,
        ...backups.map(item => Number(item.at) || 0),
        Number(descBackup?.at) || 0,
    );
    const meta = [
        backups.length > 0 ? `${backups.length} 条` : '',
        descBackup ? '含描述上一版' : '',
        latest > 0 ? `最近 ${formatTime(latest)}` : '',
    ].filter(Boolean).join(' · ');

    const rows = expanded
        ? `<div class="thrive-history">${backups.map(renderHistoryRow).join('')}${renderDescBackupRow(descBackup)}</div>`
        : '';

    return `
        <section class="thrive-panel__section thrive-panel__section--fold">
            <div class="thrive-panel__head thrive-panel__fold${expanded ? ' is-open' : ''}"
                role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"
                data-thrive-action="toggle-history"
                title="展开 / 收起写入记录（每条都带恢复入口）">
                <span class="thrive-panel__section-title">
                    <i class="fa-solid fa-chevron-right thrive-panel__fold-icon" aria-hidden="true"></i>已写入
                </span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            ${rows}
        </section>`;
}

function renderHistoryRow(item) {
    const created = item.action === 'created';
    const meta = [
        item.book,
        created ? '新建' : '改写',
        `${item.chars} 字`,
        formatTime(item.at),
    ].filter(Boolean).join(' · ');

    const restored = Number(item.restoredAt) > 0;
    const action = restored
        ? `<span class="thrive-history__done">已恢复 ${escapeHtml(formatTime(item.restoredAt))}</span>`
        : `<div class="menu_button thrive-panel__button thrive-history__restore" data-thrive-action="restore-lore" data-backup-id="${escapeHtml(item.id)}">${created ? '撤销新建' : '恢复写入前'}</div>`;

    return `
        <div class="thrive-history__row">
            <div class="thrive-history__main">
                <span class="thrive-history__title">${escapeHtml(item.title || '（无标题）')}</span>
                <span class="thrive-history__meta">${escapeHtml(meta)}</span>
            </div>
            ${action}
        </div>`;
}

function renderDescBackupRow(descBackup) {
    if (!descBackup) {
        return '';
    }

    const chars = String(descBackup.before ?? '').length;
    const meta = ['角色描述 · 上一版', `${chars} 字`, formatTime(descBackup.at)].filter(Boolean).join(' · ');

    return `
        <div class="thrive-history__row thrive-history__row--desc">
            <div class="thrive-history__main">
                <span class="thrive-history__title">角色描述</span>
                <span class="thrive-history__meta">${escapeHtml(meta)}</span>
            </div>
            <div class="menu_button thrive-panel__button" data-thrive-action="restore-desc">恢复上一版</div>
        </div>`;
}

function renderDiff(rows) {
    if (rows.length === 0) {
        return '<div class="thrive-diff"><div class="thrive-diff__empty">与磁盘上的描述完全一致，没有可显示的差异。</div></div>';
    }

    const html = rows.map(row => {
        if (row.type === 'fold') {
            return `<div class="thrive-diff__row thrive-diff__row--fold">⋯ ${row.count} 行未改动</div>`;
        }

        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
        // 空行也要占一行高度，否则 diff 的段落结构会看不出来
        const text = row.text === '' ? '&nbsp;' : escapeHtml(row.text);

        return `<div class="thrive-diff__row thrive-diff__row--${row.type}">`
            + `<span class="thrive-diff__sign">${sign}</span>`
            + `<span class="thrive-diff__text">${text}</span>`
            + '</div>';
    });

    return `<div class="thrive-diff">${html.join('')}</div>`;
}

/**
 * 待确认 / 冲突状态下的两个动作。
 *
 * 文案不用「接受 / 拒绝」：那是相对于"这份改动"说的，用户得先想明白谁在接受谁。
 * 直接写动作落在哪儿——写进角色卡，还是丢掉。
 */
function renderPendingActions(conflict) {
    const primary = conflict
        ? '<div class="menu_button thrive-panel__button thrive-panel__button--danger" data-thrive-action="force"'
            + ' title="不用管卡上被改过的地方，直接用这份内容盖掉">强制覆盖</div>'
        : '<div class="menu_button thrive-panel__button" data-thrive-action="accept"'
            + ' title="把这份描述写进角色卡，从下一轮请求开始生效">写入角色卡</div>';

    return `${primary}<div class="menu_button thrive-panel__button thrive-panel__button--ghost"`
        + ' data-thrive-action="discard" title="丢掉这份暂存，角色卡上的描述保持原样">丢弃改动</div>';
}

/**
 * 已写入状态下的动作。
 *
 * 三个按钮以前叫「刷新编辑框 / 重新写入 / 关闭」，前两个都在"写"，但写的地方不同
 * （编辑框 vs 角色卡），第三个"关闭"更没说清关的是什么。现在每个按钮都把落点写在名字里：
 *   - 填入编辑框：只动角色编辑面板里的文本框，要保存才生效
 *   - 重写角色卡：真的落盘，卡上现在的版本先进「上一版」
 *   - 移除记录：只是把这条记录收起来，什么内容都不改
 * 前两个都会覆盖掉看得见的文字，所以各自带 title 说清覆盖的是哪一份。
 */
function renderAppliedActions(drift = false, editorStale = false) {
    const buttons = [];

    if (editorStale) {
        buttons.push('<div class="menu_button thrive-panel__button" data-thrive-action="sync-editor"'
            + ' title="只把这份内容填进角色编辑框，不动角色卡；要在角色编辑面板里保存才真正生效">填入编辑框</div>');
    }

    if (drift) {
        buttons.push('<div class="menu_button thrive-panel__button thrive-panel__button--danger"'
            + ' data-thrive-action="rewrite-desc"'
            + ' title="把这份内容重新写回角色卡；卡上现在的描述会被覆盖，覆盖前会先存进「上一版」">重写角色卡</div>');
    }

    buttons.push('<div class="menu_button thrive-panel__button thrive-panel__button--ghost"'
        + ' data-thrive-action="dismiss-record" title="只是把这条记录从面板上去掉，角色卡上的内容不会变">移除记录</div>');

    return buttons.join('');
}

/**
 * 按钮底下那句小字：说出这几个按钮**之间**的区别。
 *
 * 不复述 notice 里已经讲过的前因后果——窄屏上两段长字挤在一起，反而更像噪音。
 * 这里只回答"它们各自动哪儿"，完整说明在按钮的 title 里。
 */
function appliedHint(drift, editorStale) {
    if (drift && editorStale) {
        return '重写角色卡 = 落到角色卡；填入编辑框 = 只改框里的文字。两者都动不到这条记录本身。';
    }
    if (drift) {
        return '重写角色卡会覆盖卡上现版，覆盖前先存进「上一版」。';
    }
    if (editorStale) {
        return '填入编辑框只改框里的文字，不动角色卡，保存才生效。';
    }

    return '这条记录只是留痕：移除它不会改回任何内容。';
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
        case 'trigger-once':
            triggerOnceAndReport();
            break;
        case 'hide-panel':
            setPanelOpen(false);
            break;
        case 'open-compress':
            /* 压缩面板是另一个窗口，浮动面板不动：用户可能想两边对照着看 */
            openCompressPanel(getContext());
            break;
        case 'toggle-active':
            toggleActive(getContext(), ensureSettings(getContext()));
            break;
        case 'toggle-passive':
            togglePassive(getContext(), ensureSettings(getContext()));
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
 * 「更多设置」里的输入框：外壳接 input / change，重绘换掉节点也不会丢事件。
 *
 * 关键词边打边存（和设置页的关键词框同一套手感）；条数只在 change（失焦 / 回车）时落值——
 * 边打字边存盘会把 "12" 中间那个 "1" 也存进去。
 */
function onPanelInput(event) {
    if (event.target?.dataset?.thriveField !== 'keywords') {
        return;
    }

    const ctx = getContext();
    ensureSettings(ctx).passiveKeywords = String(event.target.value ?? '');
    saveSoon(ctx);
}

function onPanelChange(event) {
    const field = event.target?.dataset?.thriveField;
    if (!field) {
        return;
    }

    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (field === 'interval') {
        const value = clampInterval(event.target.value);
        settings.passiveInterval = value;
        // 回填成夹取后的值：写 999 会被收成上限，用户得看见这件事
        event.target.value = value > 0 ? String(value) : '';
        saveSoon(ctx);
        // 折头上的"N 条"与被动块里的"还差几条"都要跟着变
        refreshPanel(ctx);
        return;
    }

    if (field === 'keywords') {
        settings.passiveKeywords = String(event.target.value ?? '');
        ctx.saveSettingsDebounced?.();
        refreshPanel(ctx);
    }
}

/** 条数判据的夹取。设置页的输入框与这里共用同一个上限 */
function clampInterval(value) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num <= 0) {
        return 0;
    }
    return Math.min(num, PASSIVE_INTERVAL_MAX);
}

/**
 * 不等判据，立刻给下一轮挂一次学习。
 *
 * 存在的理由不是方便，而是**可验证**：用户配完判据之后总得能立刻看见它生效，
 * 否则要等到真出现那句话，期间只能猜。
 *
 * 成功不弹 toast：`armManual` 会广播 PASSIVE_EVENT，徽章那边统一报一句；
 * 这里只负责把"没能挂上"的原因说清楚。
 */
function triggerOnceAndReport() {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!hasAnyModule(settings)) {
        toast('两个模块都关着，请先在扩展设置里开启至少一个');
        return;
    }
    if (!isChatAvailable(ctx)) {
        toast('请先打开一个对话');
        return;
    }

    const diag = diagnoseEnvironment(ctx);
    if (!diag.ok) {
        toast(`工具调用不可用：${formatDiagnosis(diag)}`);
        return;
    }
    if (getPending(ctx)) {
        toast('已经有一次待学习了，下一次生成就会用掉它');
        return;
    }
    if (!armManual(ctx)) {
        toast('没能挂上待学习，请稍后再试');
        return;
    }

    saveChat(ctx);
    syncFromContext(ctx);
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

function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }

    const date = new Date(value);
    const pad = number => String(number).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date().toDateString() === date.toDateString();

    return today ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/* 登记给刷新编排：面板的刷新入口就这一个 */
registerSurfaces({
    panel: ({ ctx }) => refreshPanel(ctx),
    // 压缩扫描结果变了：入口那段的高亮与提示要跟着变，整块重画（签名会挡住无变化的）
    compressEntry: () => refreshPanel(getContext()),
});
