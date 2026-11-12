/**
 * ui/settings/prompt-cards.js · 「提示词」组的入口与一行摘要
 *
 * 卡片列表与开场白都在独立窗口里（ui/prompt-window.js）。这一页只留两样：
 *   · 「打开提示词编辑器」按钮 + 一行摘要
 *   · 学习 / 压缩时各发出去多少字（不点开窗口也能看一眼）
 *
 * 为什么把列表搬走：一张提示词动辄几百字，480px 的设置栏里连正文都看不全，
 * 而新增 / 删除 / 改角色 / 导入预设又都需要横向空间。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import {
    countChars,
    getCardText,
    getCompactMessage,
    getLearningMessage,
    getPromptOrder,
    isPromptActive,
} from '../../features/prompts/prompt.js';
import { getActiveDescFormats } from '../../features/settings/index.js';
import { openPromptWindow } from '../prompt-editor/index.js';
import { byId } from './common.js';

export function bindPromptControls() {
    byId('thrive_prompt_open')?.addEventListener('click', () => {
        openPromptWindow(getContext());
    });
}

/**
 * 设置页那一行摘要：多少条、启用多少、几条停用。
 *
 * @param {object} settings
 */
export function updatePromptCards(settings) {
    const el = byId('thrive_prompt_entry_meta');
    if (!el) {
        return;
    }

    const items = getPromptOrder(settings);
    const formats = getActiveDescFormats(getContext());
    const enabled = items.filter(id => isPromptActive(settings, id, formats)).length;
    const inactive = items.length - enabled;

    el.textContent = `共 ${items.length} 条 · 启用 ${enabled} 条`
        + (inactive > 0 ? ` · ${inactive} 条未发送` : '');
    el.classList.toggle('thrive-hint--warn', enabled === 0);
}

/**
 * 「这一段发出去多少字」那一行。
 *
 * 字数按"实际会发出去的"算：停用的卡不计，目标内容只算描述行（正文随触发变）。
 * 不点开窗口也能看出预设是不是已经偏长了——学习会话也是要花 token 的。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updatePromptStats(ctx, settings) {
    const el = byId('thrive_prompt_stats');
    if (!el) {
        return;
    }

    const order = getPromptOrder(settings);
    const cards = order.filter(id => isPromptActive(settings, id, getActiveDescFormats(ctx)));
    if (cards.length === 0) {
        // 注入位永远在、永远启用，正常走不到这里；走到说明设置被手改坏了
        el.textContent = '预设里一条都没有：触发学习会因为预设为空而失败。';
        return;
    }

    const presetChars = cards.reduce((sum, id) => sum + countChars(getCardText(settings, id)), 0);
    const learnChars = countChars(getLearningMessage(settings));
    const compactChars = countChars(getCompactMessage(settings));

    el.textContent = `每次学习约 ${presetChars + learnChars} 字（预设 ${presetChars} + 开场白 ${learnChars}）`
        + '，目标内容里的对话记录另外算。'
        + `压缩用的开场白 ${compactChars} 字。`;
}
