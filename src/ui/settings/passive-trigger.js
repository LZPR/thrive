/**
 * ui/settings/passive-trigger.js · 「被动学习」组
 *
 * 三样东西：总开关、两条判据（每 N 条 / 关键词）、以及一颗"现在触发一次"。
 *
 * 这一组最容易踩的坑是"点了开关却没反应"——因为判据一条都没配。所以小字只在
 * 这种情况下说话；配置齐全、还差几条，数字都写在行尾，不用再解释一遍。
 */

import { getContext } from '../../../../../../extensions.js';
import { diagnoseEnvironment, formatDiagnosis } from '../../diagnostics.js';
import { armManual, describePending, intervalProgress, parseKeywords } from '../../passive.js';
import { syncFromContext } from '../../prompt.js';
import { ensureSettings, getPending, getState, hasAnyModule, isChatAvailable, saveChat } from '../../store.js';
import { refreshUI } from '../refresh.js';
import { toast } from '../shared.js';
import { byId, paintHint, scheduleSave, syncCheckbox } from './common.js';

/** 条数判据的上限。再大就不是"定期抽查"，是"永远不会触发" */
const PASSIVE_INTERVAL_MAX = 500;

export function bindPassiveControls() {
    const toggle = byId('thrive_passive_enabled');
    if (toggle) {
        toggle.addEventListener('change', function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            settings.passiveEnabled = Boolean(this.checked);
            ctx.saveSettingsDebounced?.();

            // 关掉时顺手丢掉已经挂上的待学习：否则会出现"被动显示关闭、徽章却在闪待学"
            if (!settings.passiveEnabled && getPending(ctx)) {
                getState(ctx).passive.pending = null;
                saveChat(ctx);
            }

            syncFromContext(ctx);
            refreshUI(ctx);
            toast(settings.passiveEnabled ? '被动学习已开启' : '被动学习已关闭');
        });
    }

    const interval = byId('thrive_passive_interval');
    if (interval) {
        // 只在 change（失焦 / 回车）时落值：边打字边存盘会把"12"中间那个"1"也存进去
        interval.addEventListener('change', () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const value = clampInterval(interval.value);

            settings.passiveInterval = value;
            interval.value = String(value);
            ctx.saveSettingsDebounced?.();
            updatePassiveHint(ctx, settings);
        });
    }

    const keywords = byId('thrive_passive_keywords');
    if (keywords) {
        keywords.addEventListener('input', () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            settings.passiveKeywords = String(keywords.value ?? '');

            scheduleSave(ctx);
            // 提示立刻跟着变，不用等存盘：用户正在看的就是"配了几个"
            updatePassiveHint(ctx, settings);
        });
    }

    byId('thrive_passive_once')?.addEventListener('click', () => onTriggerOnce());
}

/** @param {object} settings */
export function syncPassiveControls(settings) {
    syncCheckbox('thrive_passive_enabled', settings.passiveEnabled);
}

function clampInterval(value) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num <= 0) {
        return 0;
    }
    return Math.min(num, PASSIVE_INTERVAL_MAX);
}

/**
 * 「现在触发一次」：不等判据，直接给下一轮挂一次学习。
 *
 * 存在的理由不是方便，而是**可验证**：用户配完关键词之后总得能立刻看见它生效，
 * 否则要等到真出现那句话，期间只能猜。
 */
function onTriggerOnce() {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!hasAnyModule(settings)) {
        toast('两个模块都关着，请先开启至少一个');
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
    // 提示由 PASSIVE_EVENT 统一发，这里不重复弹
}

/**
 * 这一组的动态小字。
 *
 * 三种情况才出声：关着（不写——勾选框已经说了）、判据没配（警告）、已挂上一次
 * （告诉用户下一轮会用掉）、没有对话（说明为什么还没开始数）。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function updatePassiveHint(ctx, settings) {
    const enabled = settings.passiveEnabled === true;
    const keywords = parseKeywords(settings.passiveKeywords);
    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    const pending = getPending(ctx);
    const available = isChatAvailable(ctx);
    const progress = intervalProgress(ctx, settings);
    const noRule = interval <= 0 && keywords.length === 0;

    let text = '';
    let warn = false;

    if (enabled && noRule) {
        text = '两条判据都没配，现在不会触发。';
        warn = true;
    } else if (enabled && pending) {
        text = `已挂上一次（${describePending(pending)}），下一轮生效。`;
    } else if (enabled && !available) {
        text = '打开一个对话后开始累计。';
    }

    paintHint('thrive_passive_hint', text, warn);

    const progressEl = byId('thrive_passive_progress');
    if (progressEl) {
        progressEl.textContent = !available
            ? '—'
            : interval > 0
                ? `${progress.since} / ${interval} 条`
                : '未启用';
    }

    paintHint(
        'thrive_passive_keyword_hint',
        keywords.length > 0 ? `已配 ${keywords.length} 个。` : '',
    );
}

/** 把设置里的值回填到两个控件上。正在编辑的控件不回写，否则光标会跳 */
export function refreshPassive(ctx, settings) {
    const interval = byId('thrive_passive_interval');
    if (interval && document.activeElement !== interval) {
        const value = String(Math.max(0, Math.floor(Number(settings.passiveInterval) || 0)));
        if (interval.value !== value) {
            interval.value = value;
        }
    }

    const keywords = byId('thrive_passive_keywords');
    if (keywords && document.activeElement !== keywords) {
        const value = String(settings.passiveKeywords ?? '');
        if (keywords.value !== value) {
            keywords.value = value;
        }
    }

    updatePassiveHint(ctx, settings);
}
