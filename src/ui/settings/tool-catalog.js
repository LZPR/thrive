/**
 * ui/settings/tool-catalog.js · 「工具清单」（只读）
 *
 * 数据源是 ST 的注册表（ToolManager.tools），不是插件里另抄一份：这里显示的描述与
 * 参数就是实际发给模型的那份，改了 tools.js 不用同步改这里。状态与宏走 tool-state，
 * 与"能不能调、宏怎么展开"是同一个判据。
 */

import { getContext } from '../../../../../../extensions.js';
import { copyText } from '../../../../../../utils.js';
import { listToolInfo } from '../../tool-state.js';
import { escapeHtml } from '../../util.js';
import { LOG, toast } from '../shared.js';
import { byId } from './common.js';

/** 工具状态 → 角标文案 */
const TOOL_STATE_LABEL = Object.freeze({
    on: '可用',
    off: '不可用',
    idle: '未注入',
});

/** 「不可用 / 未注入」的短原因，接在角标后面 */
const TOOL_REASON_LABEL = Object.freeze({
    'learning-off': '学习模式没开',
    'resident-off': '常驻关且没开学习',
    'module-off': '模块已关',
    'no-book': '没选可写书',
});

/**
 * 复制用委托（十行二十个宏，逐个绑不划算）；两个"复制全部"按当前注册表拼，
 * 这样新增工具时不用改代码。
 */
export function bindToolCatalog() {
    byId('thrive_tool_catalog_list')?.addEventListener('click', event => {
        const macro = event.target?.closest?.('.thrive-tool-macro');
        if (macro) {
            void copyMacro(macro.dataset.copy ?? '');
        }
    });

    byId('thrive_tool_copy_all')?.addEventListener('click', () => {
        const names = listToolInfo(getContext()).map(item => `{{${item.name}}}`);
        void copyMacro(names.join(' '), `已复制 ${names.length} 个可用时宏`);
    });

    byId('thrive_tool_copy_all_neg')?.addEventListener('click', () => {
        const names = listToolInfo(getContext()).map(item => `{{!${item.name}}}`);
        void copyMacro(names.join(' '), `已复制 ${names.length} 个取反宏`);
    });
}

/**
 * 复制到剪贴板。
 *
 * 用 ST 自己的 copyText：它有 !navigator.clipboard 时的 execCommand 兜底，
 * 插件在非 https / 老浏览器里也不至于点了没反应。
 */
async function copyMacro(text, done = `已复制 ${text}`) {
    if (!text) {
        return;
    }

    try {
        await copyText(text);
        toast(done);
    } catch (err) {
        console.warn(`${LOG} 复制失败`, err);
        toast('复制失败：浏览器拒绝了剪贴板访问');
    }
}

/**
 * 重画整个清单。
 * @param {object} [ctx]
 */
export function renderToolCatalog(ctx = getContext()) {
    const list = byId('thrive_tool_catalog_list');
    if (!list) {
        return;
    }

    const items = listToolInfo(ctx);
    const groups = [
        { key: 'desc', label: '角色描述' },
        { key: 'lore', label: '世界书' },
    ];

    let html = '';
    for (const group of groups) {
        const rows = items.filter(item => item.group === group.key);
        if (!rows.length) {
            continue;
        }
        html += `<div class="thrive-tool-group">${group.label}</div>`;
        html += rows.map(item => renderToolRow(item)).join('');
    }
    list.innerHTML = html;

    const meta = byId('thrive_tool_catalog_meta');
    if (meta) {
        const available = items.filter(item => item.state === 'on').length;
        meta.textContent = `${items.length} 个 · 可用 ${available}`;
    }

    // 按钮上带个数：贴进提示词里就是这么多，不用自己数
    const all = byId('thrive_tool_copy_all_label');
    if (all) {
        all.textContent = `复制 {{x}} ×${items.length}`;
    }
    const neg = byId('thrive_tool_copy_all_neg_label');
    if (neg) {
        neg.textContent = `复制 {{!x}} ×${items.length}`;
    }
}

function renderToolRow(item) {
    const state = TOOL_STATE_LABEL[item.state] ?? '';
    const reason = TOOL_REASON_LABEL[item.reason] ?? '';
    const badge = reason ? `${state} · ${reason}` : state;
    const macro = `{{${item.name}}}`;
    const negMacro = `{{!${item.name}}}`;
    const params = item.parameters.length ? `参数：${item.parameters.join(' · ')}` : '无参数';

    return `<div class="thrive-tool-row" data-state="${item.state}">
    <div class="thrive-tool-row__head">
        <span class="thrive-tool-row__label">${escapeHtml(item.label)}</span>
        <code class="thrive-tool-row__name">${item.name}</code>
        <span class="thrive-tool-row__state">${badge}</span>
    </div>
    <div class="thrive-tool-row__desc">${escapeHtml(item.description)}</div>
    <div class="thrive-tool-row__macros">
        <code class="thrive-tool-macro" data-copy="${macro}" title="点击复制">${macro}</code>
        <code class="thrive-tool-macro" data-copy="${negMacro}" title="点击复制">${negMacro}</code>
        <span class="thrive-tool-row__params">${escapeHtml(params)}</span>
    </div>
</div>`;
}
