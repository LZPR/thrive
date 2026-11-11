/**
 * ui/settings/learn-criteria.js · 「自动学习」组的两个判据
 *
 * 这里只有两件事：条数（每 N 条）与关键词。**两项都是全局设置**——
 * 它们回答的是"我隔多久想让它学一次"，同一个人对每一场对话的答案都一样
 * （开关才是逐对话的取舍，那个在浮动面板里，ADR-044）。
 *
 * 所以这一组和数值上限一样住在设置页：切对话不该让这里的字变。
 * 面板只**读**这两个值来算"还差几条"，没有写入口（ADR-045）。
 */

import { getContext } from '../../../../../../extensions.js';
import { LEARN_INTERVAL_MAX, clampInterval, parseKeywords } from '../../auto-learn.js';
import { ensureSettings } from '../../store.js';
import { refreshUI } from '../refresh.js';
import { byId, paintHint, scheduleSave } from './common.js';

export function bindLearnCriteria() {
    const interval = byId('thrive_learn_interval');
    if (interval) {
        // 上限写进模板只会被手改绕过，这里再设一次，至少 DOM 上的加减按钮是对的
        interval.max = String(LEARN_INTERVAL_MAX);

        // change 而不是 input：边打字边存会把 "12" 中间那个 "1" 也存进去
        interval.addEventListener('change', function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const value = clampInterval(this.value);

            settings.learnInterval = value;
            // 回填夹取后的值：写 9999 会被收成上限，用户得看见这件事
            this.value = value > 0 ? String(value) : '';
            ctx.saveSettingsDebounced?.();
            refreshUI(ctx);
        });
    }

    const keywords = byId('thrive_learn_keywords');
    if (keywords) {
        // 关键词是边打边存的（和提示词编辑框同一套手感），落盘防抖在 common.js 里
        keywords.addEventListener('input', function () {
            const ctx = getContext();
            ensureSettings(ctx).learnKeywords = String(this.value ?? '');
            scheduleSave(ctx, () => refreshUI(ctx));
        });

        // 光标离开时立刻落一次：用户可能打完就走，不该等定时器
        keywords.addEventListener('change', function () {
            const ctx = getContext();
            ensureSettings(ctx).learnKeywords = String(this.value ?? '');
            ctx.saveSettingsDebounced?.();
            refreshUI(ctx);
        });
    }
}

/**
 * 回填。两项都为空时给一句规则说明——"两条判据都空着"是最常见的空转原因，
 * 而它不是错，只是没配，所以不加警告色。
 *
 * @param {object} settings
 */
export function syncLearnCriteria(settings) {
    const interval = byId('thrive_learn_interval');
    if (interval) {
        const value = Math.max(0, Math.floor(Number(settings.learnInterval) || 0));
        const text = value > 0 ? String(value) : '';
        if (interval.value !== text) {
            interval.value = text;
        }
    }

    const keywords = byId('thrive_learn_keywords');
    if (keywords) {
        const text = String(settings.learnKeywords ?? '');
        if (keywords.value !== text) {
            keywords.value = text;
        }
    }

    const intervalValue = Math.max(0, Math.floor(Number(settings.learnInterval) || 0));
    const keywordCount = parseKeywords(settings.learnKeywords).length;
    paintHint(
        'thrive_learn_hint',
        intervalValue <= 0 && keywordCount <= 0
            ? '两条判据都是空的：学习模式开着也不会自动触发，只能用面板上的「立刻学一次」或 /thrive learn。'
            : `任一判据命中就会在角色回复完之后学一次：条数 ${intervalValue > 0 ? `每 ${intervalValue} 条` : '未启用'} · 关键词 ${keywordCount} 个。`,
    );
}
