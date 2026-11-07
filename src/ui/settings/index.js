/**
 * ui/settings/index.js · 扩展设置页的入口
 *
 * 设置页按"一组设置一个文件"拆在同级目录里，这里只做三件事：
 *
 *   1. 取模板、挂到 ST 的设置容器里（initSettingsPanel）
 *   2. 把各组的绑定函数叫一遍（bindSettingsEvents）
 *   3. 把状态回填到各组的控件上（refreshSettingsControls），并登记进刷新编排
 *
 *   common.js       取元素、回填勾选框、状态小字、防抖落盘
 *   help.js         标签旁那个「?」的展开 / 收起
 *   diagnostics.js  顶部环境诊断
 *   basics.js       新对话默认开启、显示徽章
 *   write-targets.js 写入模块、可写书、读取范围
 *   desc-patch.js   描述改动暂存（面板也 import 它）
 *   passive-trigger.js 自动学习与两条判据
 *   limit-fields.js 14 个数值上限
 *   prompt-cards.js 提示词卡片、拖动、编辑弹窗
 *   tool-catalog.js 只读工具清单与复制
 *   appearance.js   旧日志清理、浮动面板外观、压缩面板入口
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
import { bindPatchControls, syncPatchCheck, updatePatchHint } from './desc-patch.js';
import { bindHelpButtons } from './help.js';
import { bindLimitControls, syncLimitControls } from './limit-fields.js';
import { bindPassiveControls, refreshPassive, syncPassiveControls } from './passive-trigger.js';
import { bindPromptControls, updatePromptCards, updatePromptStats } from './prompt-cards.js';
import { bindToolCatalog, renderToolCatalog } from './tool-catalog.js';
import {
    bindWriteTargetControls,
    refreshBookOptions,
    syncReadScope,
    syncWriteTargetControls,
    updateBookHint,
    updateModuleHints,
    updateScopeHint,
} from './write-targets.js';

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

    await refreshBookOptions();
    refreshUI();
}

/** 把各组的绑定叫一遍。新增一组只在这里加一行。 */
function bindSettingsEvents() {
    bindBasicsControls();
    bindWriteTargetControls();
    bindPatchControls();
    bindPassiveControls();
    bindLimitControls();
    bindPromptControls();
    bindToolCatalog();
    bindAppearanceControls();
}

/**
 * 设置页所有控件的回填。
 *
 * 顺序按模板里从上到下：同一块里后面几项会读前面刚写进 settings 的值（比如模块关了
 * 之后可写书的提示要变），所以不排成随意的顺序。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function refreshSettingsControls(ctx, settings) {
    syncBasicsControls(settings);

    syncWriteTargetControls(settings);
    updateModuleHints(ctx, settings);
    syncReadScope(settings);
    updateBookHint(ctx, settings);
    updateScopeHint(ctx, settings);

    syncPatchCheck(settings);
    updatePatchHint(ctx, settings);

    syncPassiveControls(settings);
    refreshPassive(ctx, settings);

    syncLimitControls(settings);
    syncAppearanceControls(settings);

    updatePromptCards(ctx, settings);
    updatePromptStats(ctx, settings);
    renderToolCatalog(ctx);
}

/* 登记给刷新编排：设置页的几块都在这批文件里，refresh.js 不反过来 import 它们 */
registerSurfaces({
    controls: ({ ctx, settings }) => refreshSettingsControls(ctx, settings),
    diagnostics: ({ ctx, diag }) => refreshDiagnostics(ctx, diag),
    passiveHint: ({ ctx, settings }) => refreshPassive(ctx, settings),
    books: ({ ctx }) => {
        void refreshBookOptions(ctx);
    },
});
