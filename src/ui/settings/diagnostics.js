/**
 * ui/settings/diagnostics.js · 设置页顶部的环境诊断
 *
 * 只做两件事：给出结论、指出去哪改。不做分步引导（ADR-020 的延伸）。
 * 这一段固定在外层、不参与折叠——不能用的时候，用户最先要看到的就是它。
 */

import { getContext } from '../../../../../../extensions.js';
import { diagnoseEnvironment, formatDiagnosis } from '../../diagnostics.js';
import { refreshUI } from '../refresh.js';
import { byId } from './common.js';

/**
 * 会影响"工具能不能用"的 ST 设置控件。用户在这些地方改完，诊断区要立刻跟上，
 * 否则它一直停在页面加载时的那一句。
 */
const DIAG_TRIGGERS = new Set([
    'main_api',
    'openai_function_calling',
    'custom_prompt_post_processing',
    'chat_completion_source',
    'model_openai_select',
]);

/**
 * 监听 ST 自己的相关设置项。
 *
 * 用 document 上的一次委托而不是逐个 getElementById：ST 的设置抽屉是懒渲染的，
 * 初始化时这些控件可能还不存在，绑定时找不到就永远绑不上。
 */
export function bindDiagnosticRefresh() {
    document.addEventListener('change', event => {
        const id = event.target?.id;
        if (!id || !DIAG_TRIGGERS.has(id)) {
            return;
        }
        refreshUI(getContext());
    });
}

/**
 * @param {object} ctx
 * @param {{ ok: boolean, code: string, reason: string, fix: string }} [diag]
 */
export function refreshDiagnostics(ctx, diag = diagnoseEnvironment(ctx)) {
    const box = byId('thrive_diag');
    const reason = byId('thrive_diag_reason');
    const fix = byId('thrive_diag_fix');

    if (!box || !reason || !fix) {
        return;
    }

    box.classList.toggle('thrive-diag--warn', !diag.ok);
    box.dataset.code = diag.code;
    box.title = diag.ok ? '' : formatDiagnosis(diag);

    reason.textContent = diag.ok ? '工具调用可用。' : diag.reason;
    fix.textContent = diag.ok ? '' : diag.fix;
    fix.classList.toggle('displayNone', diag.ok || !diag.fix);
}
