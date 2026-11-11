/**
 * ui/status.js · 一行状态摘要
 *
 * 只服务 `/thrive status`：它回答的是"这个对话现在什么状态"，所以读的仍是对话级状态，
 * 但不占设置页的位置——设置页只放跨对话一致的设置（ADR-043）。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { TRIGGER, intervalProgress, parseKeywords } from '../../features/learning/auto-learn.js';
import { getCompressSnapshot } from '../../features/memory/compress.js';
import { summarizeDraft } from '../../features/memory/draft.js';
import { describeLearnRun, getLearningView } from '../../features/learning/learning.js';
import { getPatch, isUnresolved } from '../../features/memory/patch.js';
import {
    ensureSettings,
    getLastLearnRun,
    getLearningRunning,
    isChatAvailable,
    isEnabled,
    isWorldbookDesc,
} from '../../features/settings/index.js';
import { getWritableBook, isBookScanned } from '../../features/memory/index.js';

/**
 * 一行状态摘要，给 `/thrive status` 用。
 *
 * 一眼要能看出四件事：开关、模块、可写书、待确认份数。
 * 正在排队的那几场也顺带说一句——`/thrive status` 是唯一能一次看全的地方。
 *
 * @param {object} [ctx]
 */
export function describeStatus(ctx = getContext()) {
    const settings = ensureSettings(ctx);

    /*
     * 模块不再是开关（ADR-046）：世界书永远在；角色描述只在 card 模式下算独立模块，
     * worldbook 模式里描述本来就是书里的一条，再列一遍等于说有两处可写。
     */
    const modules = [getWritableBook(ctx) ? '世界书' : '世界书（未选书）'];
    if (!isWorldbookDesc(ctx)) {
        modules.push('角色描述');
    }

    const book = getWritableBook(ctx);
    const bookText = !book
        ? '未选择'
        : isBookScanned(ctx, book) === false
            ? `${book}（未激活）`
            : book;

    const pending = isUnresolved(getPatch(ctx)) ? 1 : 0;
    const parts = [
        `学习：${describeLearnState(ctx, settings)}`,
        `模块：${modules.join(' + ')}`,
        `可写书：${bookText}`,
        `待确认：${pending} 份`,
    ];

    /*
     * 缓冲区：有改动时它才是"待你决定"的东西，说清有几条；
     * 开着但没改动就只说开着——不然每次 status 都多一句废话。
     */
    const draft = summarizeDraft(ctx);
    if (draft.exists) {
        parts.push(draft.touched > 0
            ? `虚拟世界书：${draft.touched} 条改动待保存（面板标题栏那颗书页图标）`
            : '虚拟世界书：开着，没有改动');
    }

    /*
     * 超长内容是"最近一次扫描"的结论，可能比此刻晚几秒——所以只在有条目时补一句，
     * 不写"0 条"，免得让人以为这个数字是实时精确的。
     */
    const compress = getCompressSnapshot().items.length;
    if (compress > 0) {
        parts.push(`超长：${compress} 条（/thrive compress 打开压缩面板）`);
    }

    return parts.join(' · ');
}

/**
 * 学习的一行摘要：在跑 / 开没开 / 用什么判据 / 还差几条 / 上次的结果。
 *
 * 在跑的时候其余都不说：这一秒最要紧的只有"它在干活"，判据和上次结果都可以等。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function describeLearnState(ctx, settings) {
    // 排队的那几场也算"正在学"的一部分：一次只跑一场，剩下的按顺序等
    const queued = getLearningView(ctx, settings).queued;
    const tail = queued > 0 ? ` · 排队 ${queued}` : '';

    const running = getLearningRunning();
    if (running) {
        // 教授的输入是自己写的一段话，说"自动触发"会误导
        if (running.reason === TRIGGER.TEACH) {
            return `教授中（你写的那段话，不影响当前聊天）${tail}`;
        }
        return `学习中（${running.reason === TRIGGER.MANUAL ? '手动' : '自动'}触发，不影响当前聊天）${tail}`;
    }

    if (!isEnabled(ctx)) {
        const last = getLastLearnRun(ctx);
        return last ? `已关闭（${describeLearnRun(last)}）` : '已关闭';
    }

    const rules = [];
    const interval = Math.max(0, Math.floor(Number(settings.learnInterval) || 0));
    if (interval > 0) {
        rules.push(`每 ${interval} 条`);
    }

    const keywords = parseKeywords(settings.learnKeywords);
    if (keywords.length > 0) {
        rules.push(`关键词 ${keywords.length} 个`);
    }

    if (rules.length === 0) {
        return '已开启（未配判据，只能手动 /thrive learn）';
    }

    const progress = intervalProgress(ctx, settings);
    const gap = interval > 0 && isChatAvailable(ctx) ? `，还差 ${progress.remaining} 条` : '';
    return `已开启（${rules.join(' + ')}${gap}）`;
}
