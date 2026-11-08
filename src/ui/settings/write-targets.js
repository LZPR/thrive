/**
 * ui/settings/write-targets.js · 写入模块、读取范围
 *
 * 这一块管"写不写、从哪读"：两个模块各自的开关、读取是否带上角色绑定的其他书。
 * 两者互相牵连（关掉世界书 = 读范围失去意义），所以放在一起，提示也一起算——
 * 分开写会出现"模块关了、读取范围下面还写着一切正常"。
 *
 * **可写书与「描述存哪儿」不在这里**：它们按对话记（ADR-045），住在浮动面板的
 * 「更多设置」里。这一页只留一句"缺少可写书时会怎样"的提示，并指一下路。
 *
 * 模板里那个「?」负责解释规则；这里的小字只报状态，一切正常时不写任何字。
 */

import { getContext } from '../../../../../../extensions.js';
import { refreshUI } from '../refresh.js';
import { ensureSettings, isWorldbookDesc } from '../../store.js';
import { getActiveCharacter, getWritableBook } from '../../targets.js';
import { byId, paintHint, syncCheckbox } from './common.js';

export function bindWriteTargetControls() {
    byId('thrive_module_worldbook')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).moduleWorldbook = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    byId('thrive_module_description')?.addEventListener('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).moduleDescription = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    bindScopeControl();
}

/** @param {object} settings */
export function syncWriteTargetControls(settings) {
    syncCheckbox('thrive_module_worldbook', settings.moduleWorldbook);
    syncCheckbox('thrive_module_description', settings.moduleDescription);
}

/**
 * 模块的提示。
 *
 * 只在"模型其实用不了"的时候说话：关掉的模块、没有可写书的模块。一切正常时保持安静，
 * 勾选框本身就是答案。
 *
 * 可写书的位置已经在浮动面板里了，所以这里不能只说"还没选可写书"——那会让人在这一页
 * 找下拉框。说清"在哪选"，顺手把统一模式下"没有书 = 角色没名字"这个特例分开讲。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updateModuleHints(ctx, settings) {
    const worldbook = settings.moduleWorldbook !== false;
    const description = settings.moduleDescription !== false;
    const book = getWritableBook(ctx);

    // 统一模式里"没有书"只有一个原因：角色没有名字，推导不出同名书
    const noBook = isWorldbookDesc(ctx)
        ? '当前角色没有名字，取不到同名书，世界书工具不会注册。'
        : '还没选可写书（在浮动面板的「更多设置」里选），世界书工具不会注册。';

    paintHint(
        'thrive_module_worldbook_hint',
        !worldbook
            ? '已关闭：模型看不到世界书工具。'
            : !book
                ? noBook
                : '',
        !worldbook || !book,
    );

    paintHint(
        'thrive_module_description_hint',
        description ? '' : '已关闭：模型看不到角色描述工具。',
        !description,
    );

    byId('thrive_module_note')?.classList.toggle('displayNone', worldbook || description);
}

function bindScopeControl() {
    const scopeSelect = byId('thrive_read_scope');
    if (scopeSelect) {
        scopeSelect.addEventListener('change', function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            settings.readScope = this.value === 'bound' ? 'bound' : 'writable';
            ctx.saveSettingsDebounced?.();
            updateScopeHint(ctx, settings);
        });
    }
}

export function updateScopeHint(ctx, settings) {
    if (settings.readScope !== 'bound') {
        paintHint('thrive_scope_hint', '');
        return;
    }

    const bound = String(getActiveCharacter(ctx)?.data?.extensions?.world ?? '').trim();

    paintHint(
        'thrive_scope_hint',
        bound ? `会额外读「${bound}」。` : '当前角色没有绑定其他书，实际等同只看可写书。',
    );
}

/**
 * 读取范围的下拉值回填。单独拿出来是因为它不属于"勾选框"那一套。
 * @param {object} settings
 */
export function syncReadScope(settings) {
    const select = byId('thrive_read_scope');
    const scope = settings.readScope === 'bound' ? 'bound' : 'writable';
    if (select && select.value !== scope) {
        select.value = scope;
    }
}
