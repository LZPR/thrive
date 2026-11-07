/**
 * ui/settings/prompt-cards.js · 「提示词」组的可拖动卡片
 *
 * 一张卡片对应一段提示词或一段工具指令；顺序与落点（系统区 / 尾部）由卡片的
 * 位置决定，中间那张「其它提示词」就是分界线。改正文走 ST 的通用弹窗，
 * 不在这里另搭一层编辑器。
 *
 * 卡片的状态、字数、角标都是"现在这一轮实际发什么"，所以跟着 refreshUI 一起刷。
 */

import { getContext } from '../../../../../../extensions.js';
import { COMPACT_PROMPT_LIMIT } from '../../compact.js';
import {
    PROMPT_CARD_META,
    buildInjection,
    countChars,
    getCardSettingKey,
    getCardState,
    getCardText,
    getPromptOrder,
    normalizeCardText,
    syncFromContext,
} from '../../prompt.js';
import { CARD_ID, DEFAULT_PROMPT_ORDER, normalizeOrder } from '../../prompt-order.js';
import { ensureSettings } from '../../store.js';
import { refreshUI } from '../refresh.js';
import { toast } from '../shared.js';
import { byId, paintHint, scheduleSave } from './common.js';

/** 卡片状态 → 角标文案。`anchor` 是分界线，没有状态角标 */
const PROMPT_STATE_LABEL = Object.freeze({
    on: '生效中',
    idle: '未生效',
    cond: '条件触发',
});

/** jQuery UI 拖动期间不要重排 DOM：它正持有占位元素与 helper */
let promptDragging = false;

export function bindPromptControls() {
    byId('thrive_tools_resident')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).toolsResident = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        // 工具注册表与工具卡片状态都跟着变
        refreshUI(ctx);
    });

    byId('thrive_prompt_inject')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).promptInject = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);
    });

    byId('thrive_prompt_order_reset')?.addEventListener('click', () => {
        const ctx = getContext();
        ensureSettings(ctx).promptOrder = DEFAULT_PROMPT_ORDER.slice();
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);
        toast('提示词顺序已恢复默认');
    });

    // 一张卡一个铅笔，用委托就够；分界线卡片没有铅笔
    byId('thrive_prompt_list')?.addEventListener('click', event => {
        const edit = event.target?.closest?.('.thrive-prompt-card__edit');
        if (!edit) {
            return;
        }
        void openPromptEditor(getContext(), edit.closest('.thrive-prompt-card')?.dataset.card);
    });

    initPromptSortable();
}

/**
 * 拖动排序。用 ST 自带的 jQuery UI sortable（预设面板也是它），
 * 不额外引入依赖；拿不到就退化成不能拖，编辑与注入照常。
 */
function initPromptSortable() {
    const list = byId('thrive_prompt_list');
    const $ = globalThis.jQuery;

    if (!list || typeof $?.fn?.sortable !== 'function') {
        return;
    }

    // 手机上整卡拖动会和滚动打架，只认抓手；桌面整卡可拖，铅笔留给点击
    const mobile = Boolean(getContext()?.isMobile?.());

    $(list).sortable({
        items: '.thrive-prompt-card',
        handle: mobile ? '.thrive-prompt-card__grip' : null,
        cancel: '.thrive-prompt-card__edit',
        placeholder: 'thrive-prompt-placeholder',
        forcePlaceholderSize: true,
        axis: 'y',
        tolerance: 'pointer',
        delay: 30,
        start: () => {
            promptDragging = true;
        },
        stop: () => {
            promptDragging = false;
        },
        update: () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const ids = Array.from(list.querySelectorAll('.thrive-prompt-card')).map(el => el.dataset.card);

            settings.promptOrder = normalizeOrder(ids);
            ctx.saveSettingsDebounced?.();
            syncFromContext(ctx);
            updatePromptCards(ctx, settings);
            updatePromptStats(ctx, settings);
        },
    });
}

/** 卡片骨架。只在列表为空时铺一次，之后靠 updatePromptCards 改状态与顺序 */
function renderPromptCards(settings) {
    const list = byId('thrive_prompt_list');
    if (!list || list.childElementCount) {
        return;
    }

    list.innerHTML = getPromptOrder(settings).map(id => {
        const meta = PROMPT_CARD_META[id];
        if (!meta) {
            return '';
        }

        const anchor = id === CARD_ID.ANCHOR;
        return `<div class="thrive-prompt-card${anchor ? ' thrive-prompt-card--anchor' : ''}" data-card="${id}" data-state="idle" title="${meta.hint}">
    <span class="thrive-prompt-card__grip fa-solid fa-grip-vertical" title="拖动调整位置与落点"></span>
    <div class="thrive-prompt-card__main">
        <span class="thrive-prompt-card__name">${meta.label}</span>
        <span class="thrive-prompt-card__note"></span>
    </div>
    ${anchor ? '' : '<span class="thrive-prompt-card__badge"></span>'}
    ${meta.editable
        ? '<span class="thrive-prompt-card__edit fa-solid fa-pen-to-square" role="button" title="编辑内容"></span>'
        : ''}
</div>`;
    }).join('');
}

/**
 * 回填卡片的状态、字数与顺序。
 *
 * 只改文字与 class，不重建 DOM：拖动中重建会把 jQuery UI 手里的元素抽掉，
 * 输入焦点也会丢。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updatePromptCards(ctx, settings) {
    const list = byId('thrive_prompt_list');
    if (!list) {
        return;
    }

    renderPromptCards(settings);

    const order = getPromptOrder(settings);
    const cards = new Map(
        Array.from(list.querySelectorAll('.thrive-prompt-card')).map(el => [el.dataset.card, el]),
    );

    const current = Array.from(list.children).map(el => el.dataset.card);
    if (!promptDragging && current.join(',') !== order.join(',')) {
        for (const id of order) {
            const el = cards.get(id);
            if (el) {
                list.appendChild(el);
            }
        }
    }

    for (const id of order) {
        const el = cards.get(id);
        const meta = PROMPT_CARD_META[id];
        if (!el || !meta) {
            continue;
        }

        const status = getCardState(ctx, settings, id);
        el.dataset.state = status.state;

        const note = el.querySelector('.thrive-prompt-card__note');
        if (note) {
            if (id === CARD_ID.ANCHOR) {
                note.textContent = meta.hint;
            } else {
                const chars = countChars(getCardText(settings, id));
                note.textContent = `${status.note} · ${chars} 字`;
            }
        }

        const badge = el.querySelector('.thrive-prompt-card__badge');
        if (badge) {
            badge.textContent = PROMPT_STATE_LABEL[status.state] ?? '';
        }
    }

    updateToolsResidentHint(settings);
}

/**
 * 「当前注入」那一行：把两段实际长度算出来。
 *
 * 卡片可以拖到分界线两侧，只看列表很难知道最终发出去多少字；这一行就是答案。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updatePromptStats(ctx, settings) {
    const el = byId('thrive_prompt_stats');
    if (!el) {
        return;
    }

    if (settings.promptInject === false) {
        el.textContent = '自动注入已关闭：插件不会改动提示词。';
        return;
    }

    const { head, tail, mode } = buildInjection(ctx, settings);
    const note = mode ? '' : ' · 学习模式未开启，只可能注入工具指令';
    el.textContent = `当前注入：系统区 ${countChars(head)} 字 · 尾部 ${countChars(tail)} 字${note}`;
}

/**
 * 常驻开关的状态小字。
 *
 * 开着的效果就是"tools 不变"，说出来像在解释设计；关着才有代价（缓存失效），
 * 所以只给关的那一边留一句。
 */
function updateToolsResidentHint(settings) {
    paintHint(
        'thrive_tools_resident_hint',
        settings.toolsResident === true ? '' : '未常驻：关闭学习时 tools 会从请求里撤下。',
    );
}

/**
 * 卡片内容编辑弹窗。
 *
 * 用 ST 的通用弹窗而不是自己搭一层：右上角那颗「全屏」是 ST 原生编辑器的按钮，
 * 挂了 `editor_maximize` 类就会走它自己的全屏逻辑，输入实时同步回这里的 textarea。
 *
 * 输入即写内存（防抖落盘），关掉弹窗再同步一次注入——和设置页里其它 textarea 的约定一致。
 */
async function openPromptEditor(ctx, id) {
    const meta = PROMPT_CARD_META[id];
    const key = getCardSettingKey(id);

    if (!meta || !meta.editable || !key) {
        return;
    }

    const settings = ensureSettings(ctx);
    const fieldId = 'thrive_prompt_editor_field';
    const isCompact = id === CARD_ID.COMPACT;

    if (typeof ctx.callGenericPopup !== 'function') {
        toast('当前 SillyTavern 没有提供编辑弹窗，无法编辑提示词');
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'thrive-prompt-editor';
    wrapper.innerHTML = `<div class="thrive-prompt-editor__head">
    <b>${meta.label}</b>
    <small>${meta.hint}</small>
</div>
<textarea id="${fieldId}" class="text_pole thrive-block-text" spellcheck="false"></textarea>
<div class="thrive-prompt-editor__foot">
    <span class="thrive-count"></span>
    <div class="thrive-prompt-editor__actions">
        <div class="menu_button thrive-reset" data-act="reset" title="用回内置的默认文本">
            <i class="fa-solid fa-rotate-left"></i>
            <span>恢复默认</span>
        </div>
        <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="${fieldId}"
            title="全屏编辑"></i>
    </div>
</div>`;

    const textarea = wrapper.querySelector('textarea');
    const counter = wrapper.querySelector('.thrive-count');

    const paintCount = () => {
        const chars = countChars(textarea.value);
        counter.textContent = isCompact
            ? `${chars} / ${COMPACT_PROMPT_LIMIT} 字`
            : `${chars} 字`;
        counter.classList.toggle('thrive-count--warn', isCompact && chars > COMPACT_PROMPT_LIMIT);
    };

    textarea.value = getCardText(settings, id);
    paintCount();

    textarea.addEventListener('input', () => {
        // 内存里立即生效：编辑完马上生成，拿到的也是新文本
        settings[key] = normalizeCardText(textarea.value, id);
        paintCount();
        scheduleSave(ctx, () => syncFromContext(ctx));
    });

    wrapper.querySelector('[data-act="reset"]').addEventListener('click', () => {
        // 默认文本照旧存空串：版本更新换了默认文案时，点过恢复默认的人也能跟着更新
        settings[key] = '';
        textarea.value = getCardText(settings, id);
        paintCount();
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        toast(`${meta.label}已恢复默认`);
    });

    await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE?.TEXT ?? 1, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    const latest = ensureSettings(ctx);
    updatePromptCards(ctx, latest);
    updatePromptStats(ctx, latest);
}
