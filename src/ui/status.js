/**
 * ui/status.js · 一行状态摘要
 *
 * 只服务 `/thrive status`：它回答的是"这个对话现在什么状态"，所以读的仍是对话级状态，
 * 但不占设置页的位置——设置页只放跨对话一致的设置（ADR-043）。
 */

import { getContext } from '../../../../../extensions.js';
import { getCompressSnapshot } from '../compress.js';
import { diagnoseEnvironment } from '../diagnostics.js';
import { describePending, intervalProgress, parseKeywords } from '../passive.js';
import { getPatch, isUnresolved } from '../patch.js';
import { ensureSettings, getPending, isChatAvailable, isEnabled, isPassiveEnabled } from '../store.js';
import { getWritableBook, isBookScanned } from '../targets.js';

/**
 * 一行状态摘要，给 `/thrive status` 用。
 *
 * 一眼要能看出四件事：开关、模块、可写书、待确认份数。
 * 环境不可用时补一句原因——否则用户会以为"都开着，为什么模型不理我"。
 *
 * @param {object} [ctx]
 */
export function describeStatus(ctx = getContext()) {
    const settings = ensureSettings(ctx);
    const modules = [];

    if (settings.moduleWorldbook !== false) {
        modules.push(getWritableBook(ctx) ? '世界书' : '世界书（未选书）');
    }
    if (settings.moduleDescription !== false) {
        modules.push('角色描述');
    }

    const book = getWritableBook(ctx);
    const bookText = !book
        ? '未选择'
        : isBookScanned(ctx, book) === false
            ? `${book}（未激活）`
            : book;

    const pending = isUnresolved(getPatch(ctx)) ? 1 : 0;
    const oneShot = getPending(ctx);
    const parts = [
        `主动：${isEnabled(ctx) ? '已开启' : '已关闭'}`,
        `被动：${describePassiveState(ctx, settings)}`,
        `模块：${modules.length > 0 ? modules.join(' + ') : '无可写模块'}`,
        `可写书：${bookText}`,
        `待确认：${pending} 份`,
    ];

    if (oneShot) {
        parts.push(`待学习：${describePending(oneShot)}（下一轮临时开启）`);
    }

    /*
     * 超长内容是"最近一次扫描"的结论，可能比此刻晚几秒——所以只在有条目时补一句，
     * 不写"0 条"，免得让人以为这个数字是实时精确的。
     */
    const compress = getCompressSnapshot().items.length;
    if (compress > 0) {
        parts.push(`超长：${compress} 条（/thrive compress 打开压缩面板）`);
    }

    const diag = diagnoseEnvironment(ctx);
    if (!diag.ok) {
        parts.push(`工具不可用（${diag.reason}）`);
    }

    return parts.join(' · ');
}

/** 被动学习的一行摘要：开没开、用什么判据、还差几条 */
function describePassiveState(ctx, settings) {
    if (!isPassiveEnabled(ctx)) {
        return '已关闭';
    }

    const rules = [];
    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    if (interval > 0) {
        rules.push(`每 ${interval} 条`);
    }

    const keywords = parseKeywords(settings.passiveKeywords);
    if (keywords.length > 0) {
        rules.push(`关键词 ${keywords.length} 个`);
    }

    if (rules.length === 0) {
        return '已开启（未配判据）';
    }

    const progress = intervalProgress(ctx, settings);
    const tail = interval > 0 && isChatAvailable(ctx) ? `，还差 ${progress.remaining} 条` : '';
    return `已开启（${rules.join(' + ')}${tail}）`;
}
