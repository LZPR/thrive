/**
 * ui/settings/prompt-cards.js · 「提示词」组的入口与两个开关
 *
 * 卡片列表已经从设置页搬进独立窗口（ui/prompt-window.js）。这一页只留三样：
 *   · 工具提示词常驻
 *   · 「打开提示词编辑器」按钮 + 一行摘要
 *   · 自动注入开关
 *
 * 为什么把列表搬走：一张提示词动辄几百字，480px 的设置栏里连正文都看不全，
 * 而新增 / 删除 / 改角色 / 导入预设又都需要横向空间。设置页留一行摘要，
 * 想知道"现在发出去多少字"看一眼就够，要改就点进去。
 */

import { getContext } from '../../../../../../extensions.js';
import {
    buildInjection,
    countChars,
    getPromptOrder,
    isPromptEnabled,
} from '../../prompt.js';
import { CARD_ID } from '../../prompt-order.js';
import { ensureSettings } from '../../store.js';
import { openPromptWindow } from '../prompt-window.js';
import { refreshUI } from '../refresh.js';
import { byId, paintHint } from './common.js';

export function bindPromptControls() {
    byId('thrive_tools_resident')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).toolsResident = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    byId('thrive_prompt_inject')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).promptInject = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    byId('thrive_prompt_open')?.addEventListener('click', () => {
        openPromptWindow(getContext());
    });
}

/**
 * 设置页那一行摘要：多少条、启用多少、几条停用。
 *
 * 只报条数，不报字数——字数由下面「当前注入」那一行负责。两处都说一遍，
 * 同一个 0 字会在同一屏里出现两次。
 *
 * @param {object} settings
 */
export function updatePromptCards(settings) {
    const el = byId('thrive_prompt_entry_meta');
    if (!el) {
        return;
    }

    const items = getPromptOrder(settings).filter(id => id !== CARD_ID.ANCHOR);
    const enabled = items.filter(id => isPromptEnabled(settings, id)).length;
    const inactive = items.length - enabled;

    el.textContent = `共 ${items.length} 条 · 启用 ${enabled} 条`
        + (inactive > 0 ? ` · ${inactive} 条已停用` : '');
    el.classList.toggle('thrive-hint--warn', settings.promptInject === false);

    updateToolsResidentHint(settings);
}

/**
 * 「当前注入」那一行：把两段实际长度算出来。
 *
 * 卡片窗口里有同样的数字，但设置页这一行不点开窗口也能看到——它是入口的一部分。
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

    const injection = buildInjection(ctx, settings);
    const mode = injection.mode ? '' : ' · 学习模式未开启，只可能注入工具指令';
    const inactive = getPromptOrder(settings)
        .filter(id => id !== 'anchor' && !isPromptEnabled(settings, id)).length;

    el.textContent = `当前注入：系统区 ${countChars(injection.head)} 字 · 尾部 ${countChars(injection.tail)} 字`
        + `${inactive > 0 ? ` · ${inactive} 条已停用` : ''}${mode}`;
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
