/**
 * ui/settings/write-targets.js · 写入模块、可写书、读取范围
 *
 * 这一块管"写到哪、从哪读"：两个模块各自的开关、唯一那本可写书、读取是否带上
 * 角色绑定的其他书。三者互相牵连（关掉世界书 = 可写书失去意义），所以放在一起，
 * 提示也一起算——分开写会出现"模块关了、可写书下面还写着一切正常"。
 *
 * 模板里那个「?」负责解释规则；这里的小字只报状态，一切正常时不写任何字。
 */

import { getContext } from '../../../../../../extensions.js';
import { refreshUI } from '../refresh.js';
import { LOG, askConfirm } from '../shared.js';
import { ensureSettings, getState, saveChat } from '../../store.js';
import { getActiveCharacter, getWritableBook, isBookScanned } from '../../targets.js';
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

    bindLoreControls();
}

/** @param {object} settings */
export function syncWriteTargetControls(settings) {
    syncCheckbox('thrive_module_worldbook', settings.moduleWorldbook);
    syncCheckbox('thrive_module_description', settings.moduleDescription);
}

/**
 * 模块与可写书的提示。
 *
 * 只在"模型其实用不了"的时候说话：关掉的模块、没选书的模块。一切正常时保持安静，
 * 勾选框本身就是答案。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function updateModuleHints(ctx, settings) {
    const worldbook = settings.moduleWorldbook !== false;
    const description = settings.moduleDescription !== false;
    const book = getWritableBook(settings);

    paintHint(
        'thrive_module_worldbook_hint',
        !worldbook
            ? '已关闭：模型看不到世界书工具。'
            : !book
                ? '还没选可写书，世界书工具不会注册。'
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

/* -------------------------------------------------------------- 世界书选择 */

/**
 * 填充可写书下拉。
 * 数据源用 ctx.getWorldInfoNames()（1.19 提供的副本），不碰内部变量 world_names。
 * @param {object} [ctx]
 */
export async function refreshBookOptions(ctx = getContext()) {
    const select = byId('thrive_writable_book');
    if (!select) {
        return;
    }

    let names = [];
    try {
        names = ctx.getWorldInfoNames?.() ?? [];
    } catch {
        names = [];
    }

    // 世界书列表在应用启动后才填好，拿不到就主动刷一次
    if (!names.length && typeof ctx.updateWorldInfoList === 'function') {
        try {
            await ctx.updateWorldInfoList();
            names = ctx.getWorldInfoNames?.() ?? [];
        } catch (err) {
            console.warn(`${LOG} 刷新世界书列表失败`, err);
        }
    }

    const settings = ensureSettings(ctx);
    const current = getWritableBook(settings);
    const annotations = describeBookAnnotations(getActiveCharacter(ctx));

    select.innerHTML = '<option value="">未选择</option>';

    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        // 标记放在选项文字里而不是 title 上：下拉列表里 title 根本看不到
        const tag = annotations.get(name)?.tag;
        option.textContent = tag ? `${name}（${tag}）` : name;
        select.appendChild(option);
    }

    // 已选的书可能已经被删掉或改名，保留它并标出来，别让用户以为选好了
    if (current && !names.includes(current)) {
        const option = document.createElement('option');
        option.value = current;
        option.textContent = `${current}（已不存在）`;
        select.appendChild(option);
    }

    select.value = current;
}

/**
 * 两类需要提醒的书（spec §11.1）：
 *   tag  —— 塞进下拉选项的短标记，一行里能放下；
 *   note —— 选中之后写在下面的一句完整说明。
 */
function describeBookAnnotations(character) {
    const map = new Map();

    const bound = character?.data?.extensions?.world;
    if (typeof bound === 'string' && bound.trim()) {
        map.set(bound.trim(), {
            tag: '角色自带',
            note: '这本书是角色自带的：改动会随角色卡分发。',
        });
    }

    const embedded = character?.data?.character_book?.name;
    if (typeof embedded === 'string' && embedded.trim() && !map.has(embedded.trim())) {
        map.set(embedded.trim(), {
            tag: '卡内嵌副本',
            note: '疑似卡内嵌副本：独立文件与卡里那份不会自动同步。',
        });
    }

    return map;
}

function bindLoreControls() {
    const bookSelect = byId('thrive_writable_book');
    if (bookSelect) {
        bookSelect.addEventListener('change', async function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const next = String(this.value ?? '');
            const previous = getWritableBook(settings);

            if (previous && next && previous !== next) {
                const confirmed = await askConfirm('换书之后，新书里没有旧书的内容，角色不会记得它们。确定切换吗？');
                if (!confirmed) {
                    this.value = previous;
                    return;
                }
                // 换书后清掉 lastBook，下一次读取就会带上 switched 提醒（spec §11.3）
                getState(ctx).lastBook = null;
                saveChat(ctx);
            }

            settings.writableBook = next;
            ctx.saveSettingsDebounced?.();
            updateBookHint(ctx, settings);
        });
    }

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

function updateBookHint(ctx, settings) {
    const book = getWritableBook(settings);

    if (!book) {
        // 没选书这件事，上面「世界书」那一行的提示已经说过了，不重复第二遍
        paintHint('thrive_book_hint', '');
        return;
    }

    const inactive = isBookScanned(ctx, book) === false;
    const note = describeBookAnnotations(getActiveCharacter(ctx)).get(book)?.note ?? '';
    const parts = [];

    if (inactive) {
        parts.push(`⚠ 这本书当前没激活，写进去也不会进上下文——到「世界书」面板勾选「${book}」。`);
    }
    if (note) {
        parts.push(note);
    }

    paintHint('thrive_book_hint', parts.join(' '), inactive);
}

function updateScopeHint(ctx, settings) {
    if (settings.readScope !== 'bound') {
        paintHint('thrive_scope_hint', '');
        return;
    }

    const character = getActiveCharacter(ctx);
    const bound = String(character?.data?.extensions?.world ?? '').trim();

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

export { updateBookHint, updateScopeHint };
