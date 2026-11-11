/**
 * ui/settings/index.js · 扩展设置页的入口
 *
 * 设置页按"一组设置一个文件"拆在同级目录里，这里只做三件事：
 *
 *   1. 取模板、挂到 ST 的设置容器里（initSettingsPanel）
 *   2. 把各组的绑定函数叫一遍（bindSettingsEvents）
 *   3. 把状态回填到各组的控件上（refreshSettingsControls），并登记进刷新编排
 *
 * 作用域原则（ADR-043 / ADR-045）：**位置即作用域**。这一页只放跨对话一致的设置；
 * 按对话生效的一律在浮动面板里，一个都不留在这儿——
 *   - 学习模式开关、描述存哪儿、可写书、待确认改动、写入记录 → ui/panel.js
 *
 * 所以这一页的内容不随对话变化，切对话时它不需要重铺任何下拉。学习判据（每 N 条 /
 * 关键词）是全局的，因此留在这一页的「自动学习」组（learn-criteria.js）。
 *
 *   common.js         取元素、回填勾选框、状态小字、防抖落盘
 *   help.js           标签旁那个「?」的展开 / 收起
 *   diagnostics.js    顶部环境诊断
 *   basics.js         新对话默认开启、显示徽章
 *   learn-criteria.js 自动学习判据：每 N 条、关键词
 *   limit-fields.js   数值上限（含学习会话的目标内容字数与轮数）
 *   prompt-cards.js   提示词入口（编辑器在独立窗口里）
 *   appearance.js     浮动面板外观、压缩面板入口
 *
 * 加一项设置：挑一个现有的组文件改，不新建文件；实在不属于任何一组，再开一个文件
 * 并在下面两处各加一行。
 */

import { getContext } from '../../../../../../extensions.js';
import { refreshUI, registerSurfaces } from '../refresh.js';
import { LOG } from '../shared.js';
import { bindAppearanceControls, syncAppearanceControls } from './appearance.js';
import { bindBasicsControls, syncBasicsControls } from './basics.js';
import { bindDiagnosticRefresh, refreshDiagnostics } from './diagnostics.js';
import { bindHelpButtons } from './help.js';
import { bindLearnCriteria, syncLearnCriteria } from './learn-criteria.js';
import { bindLimitControls, syncLimitControls } from './limit-fields.js';
import { bindPromptControls, updatePromptCards, updatePromptStats } from './prompt-cards.js';

/**
 * 渲染并挂载设置面板。重复调用安全。
 * @param {object} [ctx]
 */
export async function initSettingsPanel(ctx = getContext()) {
    if (document.getElementById('thrive_settings')) {
        return;
    }

    const host = document.getElementById('extensions_settings2');
    if (!host) {
        console.warn(`${LOG} 找不到 #extensions_settings2，设置面板未挂载`);
        return;
    }

    let html = '';
    try {
        html = await ctx.renderExtensionTemplateAsync('third-party/thrive', 'settings');
    } catch (err) {
        console.error(`${LOG} 渲染设置面板失败`, err);
        return;
    }

    // 路径写错时 ST 不报错，只是静默返回空串；这里显式兜住
    if (!html || !html.trim()) {
        console.error(`${LOG} 设置面板模板为空：检查 renderExtensionTemplateAsync 的名字是否为 'third-party/thrive'`);
        return;
    }

    host.insertAdjacentHTML('beforeend', html);

    // 「?」必须等模板进来之后再挂：它按 id 找说明块
    bindHelpButtons();
    bindDiagnosticRefresh();
    bindSettingsEvents();

    refreshUI();
}

/** 把各组的绑定叫一遍。新增一组只在这里加一行。 */
function bindSettingsEvents() {
    bindBasicsControls();
    bindLearnCriteria();
    bindLimitControls();
    bindPromptControls();
    bindAppearanceControls();
}

/**
 * 设置页所有控件的回填。
 *
 * 顺序按模板里从上到下：同一块里后面几项会读前面刚写进 settings 的值，所以不排成
 * 随意的顺序。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function refreshSettingsControls(ctx, settings) {
    syncBasicsControls(settings);
    syncLearnCriteria(settings);
    syncLimitControls(settings);
    syncAppearanceControls(settings);

    updatePromptCards(settings);
    updatePromptStats(ctx, settings);
}

/* 登记给刷新编排：设置页的几块都在这批文件里，refresh.js 不反过来 import 它们 */
registerSurfaces({
    controls: ({ ctx, settings }) => refreshSettingsControls(ctx, settings),
    diagnostics: ({ ctx, diag }) => refreshDiagnostics(ctx, diag),
});
