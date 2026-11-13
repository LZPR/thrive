import { TRIGGER, describeTrigger } from '../../features/learning/auto-learn.js';
import { describeLearnRun } from '../../features/learning/learning.js';
import { PATCH_STATUS, buildDiffRows, isUnresolved } from '../../features/memory/patch.js';
import { escapeHtml } from '../../shared/util.js';

function renderPanel({
    learn,
    patch,
    descTarget,
    descChoice,
    backups,
    descBackup,
    drift = false,
    editorStale = false,
    compress = { items: [] },
    draft = { exists: false, touched: 0, book: '' },
    moreExpanded: moreOpen = false,
    historyExpanded = false,
    characterName = '',
}) {
    const pending = isUnresolved(patch);
    const counts = [];
    if (pending) {
        counts.push('待确认 1');
    } else if (drift) {
        counts.push('描述已变');
    }
    if (backups.length > 0) {
        counts.push(`已写入 ${backups.length}`);
    }

    /*
     * 压缩不再是正文里的一段，而是标题栏上的一颗按钮：它只做一件事——打开压缩侧栏。
     * 条数做成按钮右上角的小角标，有超长内容时整颗按钮点亮（is-alert）。
     * 这样面板正文只剩"当前对话"的三段，不用为一件低频操作常年占一屏。
     */
    const compressCount = compress.items.length;
    const compressHard = compress.items.filter(item => item.level === 'hard').length;
    const compressAlert = compressCount > 0;
    const compressTitle = compressAlert
        ? `压缩：${compressCount} 条超软提醒${compressHard > 0 ? ` · ${compressHard} 条超硬上限` : ''}。点开逐条处理`
        : '压缩：没有超长内容，点开可以确认或重新扫描';

    /*
     * 虚拟世界书：模型的每一笔世界书写入先落在这里。角标 = 被工具改过几条，
     * 亮着就说明"真实世界书还没变，等你决定"。它是第三个窗口，所以只占一颗图标。
     */
    const draftCount = draft.exists ? draft.touched : 0;
    const draftAlert = draftCount > 0;
    const draftTitle = draft.exists
        ? `虚拟世界书「${draft.book}」：${draftCount} 条改动还没进真实世界书。点开看 diff、保存或丢弃`
        : '虚拟世界书：模型的改动会先落在这里，真实世界书等你说保存才变';

    const bar = `
        <div class="thrive-panel__bar">
            <i class="fa-solid fa-grip-vertical thrive-panel__grip" title="按住拖动可移动面板" aria-hidden="true"></i>
            <span class="thrive-panel__title">Thrive</span>
            <span class="thrive-panel__summary">${escapeHtml(counts.join(' · '))}</span>
            <div class="menu_button thrive-panel__draft${draftAlert ? ' is-alert' : ''}"
                data-thrive-action="open-draft" title="${escapeHtml(draftTitle)}"
                aria-label="${escapeHtml(draftTitle)}">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                ${draftAlert ? `<span class="thrive-panel__draft-count">${draftCount}</span>` : ''}
            </div>
            <div class="menu_button thrive-panel__compress${compressAlert ? ' is-alert' : ''}"
                data-thrive-action="open-compress" title="${escapeHtml(compressTitle)}"
                aria-label="${escapeHtml(compressTitle)}">
                <i class="fa-solid fa-compress" aria-hidden="true"></i>
                ${compressAlert ? `<span class="thrive-panel__compress-count">${compressCount}</span>` : ''}
            </div>
            <button type="button" class="menu_button thrive-panel__toggle" data-thrive-action="hide-panel"
                title="关闭面板；输入框旁的徽章随时能把它叫回来" aria-label="关闭面板">X</button>
        </div>`;

    const body = [
        renderLearnSection(learn, descChoice, characterName),
        renderMoreSection({ learn, choice: descChoice, expanded: moreOpen }),
        renderDescTargetSection(descTarget),
        renderPatchSection(patch, drift, editorStale, characterName),
        renderHistorySection(backups, descBackup, historyExpanded),
    ].filter(Boolean).join('');

    return `${bar}<div class="thrive-panel__body">${body}</div>`;
}


/**
 * 学习分区：总开关、写入落点、状态与统一的立即学习入口。
 * 运行时仍可打开窗口排队，并显示单独的停止按钮。
 *
 * @param {ReturnType<typeof readLearnView>} view
 */
function renderLearnSection(view, choice, characterName) {
    const { enabled, running, last, usable, available, interval, remaining, keywordCount, queued, blocked: formatWarning } = view;
    const characterDestination = `角色：${characterName || '未选择'}（${choice.storage === 'worldbook' ? '世界书条目' : '角色卡'}）`;
    const bookDestination = `世界书：${choice.book || '未选择'}`;

    /*
     * 第二行要跟着判据走：开了但一条判据都没有是最常见的空转状态，
     * 只写"已开启"等于没说——用户以为开了就会自己学。
     */
    const hint = running
        ? '学习中…'
        : formatWarning
            ? '未选描述方式'
            : !enabled
                ? '未开启'
                : interval > 0
                    ? `还差 ${remaining} 条`
                    : keywordCount > 0
                        ? `${keywordCount} 个词`
                        : '未配判据';

    const blocked = !available ? '请先打开一个对话。' : formatWarning;

    const status = running
        ? running.reason === TRIGGER.TEACH
            ? '正在学习（未读取聊天历史）· 不影响当前聊天'
            : `正在学（${describeTrigger({ reason: running.reason })}）· 不影响当前聊天`
        : describeLearnRun(last);

    // 排队只在有活干的时候出现；没有队列时这一行不占地方
    const queueNote = running && queued > 0
        ? `<span class="thrive-learn__queue" title="学习一次只跑一场，其余的按顺序接着跑">排队 ${queued}</span>`
        : '';

    return `
        <section class="thrive-panel__section thrive-modes">
            <div class="thrive-modes__row">
                ${renderLearnTile({ on: enabled, hint, usable, running })}
                <small class="thrive-modes__destination">
                    <span title="${escapeHtml(characterDestination)}">${escapeHtml(characterDestination)}</span>
                    <span title="${escapeHtml(bookDestination)}">${escapeHtml(bookDestination)}</span>
                </small>
            </div>
            ${blocked ? `<div class="thrive-panel__notice thrive-panel__notice--warn" role="alert">${escapeHtml(blocked)}</div>` : ''}
            <div class="thrive-learn${running ? ' is-running' : ''}">
                <span class="thrive-learn__status" title="学习在独立会话里跑，结果只写进世界书与角色描述">
                    ${escapeHtml(status)}
                </span>
                ${queueNote}
                <div class="thrive-learn__actions">
                    <div class="menu_button thrive-panel__button thrive-learn__go"
                        data-thrive-action="open-teach"
                        title="补充指令、附图，并选择是否读取聊天历史；有任务在跑时会排队">立即学习</div>
                    ${running ? `<div class="menu_button thrive-panel__button thrive-panel__button--ghost"
                        data-thrive-action="stop-learn"
                        title="中止正在跑的这一场，排队的一起取消；已经写进去的内容不会撤回">停止</div>` : ''}
                </div>
            </div>
        </section>`;
}


/**
 * 学习开关。灯亮 = 开，灭 = 关；不可用时整块压暗，点了不动（原因在下面那行 notice）。
 *
 * 用 div + role="switch" + tabindex 而不是 <button>：按钮样式会把这一块压成另一种观感，
 * 而整块可点又要能 Tab 到、空格切换，所以无障碍行为自己补（onPanelKeydown）。
 *
 * @param {{on: boolean, hint: string, usable: boolean, running: boolean}} props
 */
function renderLearnTile({ on, hint, usable, running }) {
    // 不可用时不要说"点一下切换"：点了不会动，原因就在下面那行 notice 里
    const tip = usable
        ? `学习模式：${on ? '已开启' : '已关闭'}（点一下${on ? '关闭' : '开启'}）· ${hint}`
        : '学习模式：现在切换不了——原因见下方说明';

    return `
        <div class="thrive-mode thrive-mode--learn${on ? ' is-on' : ''}${usable ? '' : ' is-muted'}${running ? ' is-running' : ''}"
            role="switch" tabindex="0" aria-checked="${on ? 'true' : 'false'}"
            data-thrive-action="toggle-learn"
            title="${escapeHtml(tip)}">
            <span class="thrive-mode__led" aria-hidden="true"></span>
            <span class="thrive-mode__title">学习模式</span>
            <span class="thrive-mode__hint">${escapeHtml(hint)}</span>
        </div>`;
}


/**
 * 「更多设置」：这一场对话的落点配置。
 *
 * 两样东西都只作用于当前对话（ADR-044 / ADR-045）：
 *   · 角色描述存哪儿（角色卡 / 世界书条目）
 *   · 可写书（世界书工具写哪本；统一描述模式下由插件钉死）
 *
 * 判据（每 N 条 / 关键词）不在这里：那是"我隔多久想被提醒一次"，对所有对话一致，
 * 住在设置页的「自动学习」组。"立即学习"也不在这里——它和开关回答同一个问题，
 * 放在最上面那块。
 *
 * 默认收起：面板打开的常态是"看状态、拨开关"，换落点是偶发动作。块内平铺，不套第二层折叠。
 *
 * @param {{learn: ReturnType<typeof readLearnView>,
 *          choice: ReturnType<typeof descTargetView>, expanded: boolean}} props
 */
function renderMoreSection({ learn, choice, expanded }) {
    const rows = expanded ? renderMoreRows({ learn, choice }) : '';

    return `
        <section class="thrive-panel__section thrive-panel__section--fold">
            <div class="thrive-panel__head thrive-panel__fold${expanded ? ' is-open' : ''}"
                role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"
                data-thrive-action="toggle-more"
                title="展开 / 收起落点设置（描述存哪儿、可写书；都只作用于本对话）">
                <span class="thrive-panel__section-title">
                    <i class="fa-solid fa-chevron-right thrive-panel__fold-icon" aria-hidden="true"></i>更多设置
                </span>
            </div>
            ${rows}
        </section>`;
}


/**
 * 折起来的那几行。单独拆出来是因为它只在展开时存在，和折头的摘要不是一回事。
 *
 * 两个下拉都钉 `data-thrive-field`：重绘靠它保住焦点，事件靠它认字段。
 *
 * @param {{learn: ReturnType<typeof readLearnView>, choice: ReturnType<typeof descTargetView>}} props
 */
function renderMoreRows({ learn, choice }) {
    const storageOptions = [
        { value: 'card', label: '角色卡' },
        { value: 'worldbook', label: '世界书条目' },
    ].map(item => `<option value="${item.value}"${choice.storage === item.value ? ' selected' : ''}>`
        + `${escapeHtml(item.label)}</option>`).join('');

    const bookOptions = choice.books
        .map(item => `<option value="${escapeHtml(item.value)}"${choice.book === item.value ? ' selected' : ''}>`
            + `${escapeHtml(item.label)}</option>`).join('');

    /*
     * 判据一个都没配时，学习开着也是空转。这句提示得说清楚"去哪配"——
     * 判据已经不在面板里了（它对所有对话一致），不指路等于让用户在面板里找一圈。
     */
    const noRule = learn.enabled && learn.interval <= 0 && learn.keywordCount === 0;
    const formats = [
        ['text', '自然文本'],
        ['plist', 'PLists'],
        ['alichat', 'Ali:Chat'],
    ].map(([format, label]) => {
        const unavailable = format !== 'text' && !choice.forced;
        return `<label class="thrive-more__format${unavailable ? ' is-muted' : ''}">
            <input type="checkbox" data-thrive-field="format-${format}" value="${format}"
                ${choice.formats.includes(format) ? 'checked' : ''}${unavailable ? ' disabled' : ''}>
            <span>${label}</span>
        </label>`;
    }).join('');

    return `
        <div class="thrive-more">
            <div class="thrive-more__field">
                <label class="thrive-more__label" for="thrive_more_storage">描述存储位置</label>
                <select id="thrive_more_storage" class="text_pole thrive-more__select"
                    data-thrive-field="storage">${storageOptions}</select>
            </div>

            <fieldset class="thrive-more__formats">
                <legend class="thrive-more__label">描述编辑方式 · 至少选一种，可多选</legend>
                <div class="thrive-more__format-options">${formats}</div>
                <small class="thrive-hint">${choice.forced
                    ? '每种方式使用独立条目；仅向新会话提供已启用方式的工具和用途提示。'
                    : 'PLists / Ali:Chat 仅在描述存于世界书时生效，已选状态保留。'}</small>
            </fieldset>

            <div class="thrive-more__field">
                <label class="thrive-more__label" for="thrive_more_book">可写书</label>
                <select id="thrive_more_book" class="text_pole thrive-more__select"
                    data-thrive-field="book"${choice.forced ? ' disabled' : ''}
                    title="${choice.forced
                        ? '「描述存哪儿 = 世界书条目」时固定为角色同名书'
                        : '世界书工具只会写这一本'}">${bookOptions}</select>
            </div>

            <div class="thrive-panel__actions">
                <small class="thrive-hint">${
                    choice.forced
                        ? '世界书条目模式下可写书固定为角色同名书，描述就存在那本里。'
                        : '两项都只对当前对话生效；换对话可以各选各的。'
                }${noRule ? ' 学习已经开着但还没配判据，到扩展设置的「自动学习」里配（也可以点上面「立即学习」）。' : ''}</small>
            </div>
        </div>`;
}


/**
 * 统一模式只保留未激活警告，落点摘要统一放在学习模式旁。
 *
 * @param {{book: string, active: boolean|null}|null} descTarget
 */
function renderDescTargetSection(descTarget) {
    if (descTarget?.active !== false) {
        return '';
    }

    const notice = `「${descTarget.book}」还没有激活：到「世界书」面板勾选这本书。`;

    return `
        <section class="thrive-panel__section">
            <div class="thrive-panel__notice thrive-panel__notice--warn">${escapeHtml(notice)}</div>
        </section>`;
}


/**
 * 待确认分区。没有 patch 时整段不渲染。
 * @param {object|null} patch
 * @param {boolean} [drift] 已写入，但角色卡上已经不是这份内容
 * @param {boolean} [editorStale] 已写入，但角色编辑框里还停着别的文字
 */
function renderPatchSection(patch, drift = false, editorStale = false, name = '') {
    if (!patch) {
        return '';
    }

    const conflict = patch.status === PATCH_STATUS.CONFLICT;
    const applied = patch.status === PATCH_STATUS.APPLIED;

    const title = applied ? '角色描述 · 已写入' : conflict ? '角色描述 · 冲突' : '角色描述 · 待确认';
    const delta = patch.after.length - patch.before.length;
    const deltaText = `${delta > 0 ? '+' : ''}${delta}`;
    const meta = `${formatTime(patch.createdAt)} · ${patch.before.length} → ${patch.after.length} 字（${deltaText}）`;
    const when = patch.appliedAt ? `（${formatTime(patch.appliedAt)}）` : '';

    const notice = applied
        ? drift
            ? '角色卡上的描述已经和这次写入不一致了：可能是你在编辑器里自己改过，'
                + '也可能是编辑面板还停着旧文本、一次保存把它盖了回去。这份内容只留在记录里，'
                + '要重新落盘得点「重写角色卡」。'
            : editorStale
                ? '角色卡上已经是这份内容了，但角色编辑框里还是别的文字'
                    + '（你改过，或者写入时正在框里输入）。直接保存会把这次写入盖回去；'
                    + '点「填入编辑框」把这份内容放进框里，不用关面板。'
                : `已写入${name ? `「${name}」的` : ''}角色卡${when}，下一轮请求开始生效。`
        : conflict
            ? '磁盘上的描述在暂存之后被改动过。这里不做自动合并：要么整份覆盖，要么丢弃。'
            : '还没写入角色卡。点「写入角色卡」后从下一轮请求开始生效。';

    const body = applied ? '' : renderDiff(buildDiffRows(patch.before, patch.after));
    const actions = applied ? renderAppliedActions(drift, editorStale) : renderPendingActions(conflict);
    const hint = applied ? appliedHint(drift, editorStale) : '面板只读：只能整份写入或丢弃，不能在这里改文本。';

    const noticeClass = conflict || drift || editorStale
        ? 'thrive-panel__notice thrive-panel__notice--warn'
        : 'thrive-panel__notice';

    return `
        <section class="thrive-panel__section">
            <div class="thrive-panel__head">
                <span class="thrive-panel__section-title">${title}</span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            <div class="${noticeClass}">${escapeHtml(notice)}</div>
            ${body}
            <div class="thrive-panel__actions">
                <small class="thrive-hint">${hint}</small>
                ${actions}
            </div>
        </section>`;
}


/**
 * 已写入分区：世界书写入记录 + 描述上一版。
 *
 * 默认收起。这一段是流水账（最多十条），展开着会把模式开关挤下去；收起后只留一行
 * 折头，上面写着有几条、最近一次是什么时候——"有没有东西可恢复"一眼能看出来，
 * 要点开才占地方。
 *
 * 记录只读，唯一的动作是恢复——世界书没有 patch，写错了只能靠这条退路。
 *
 * @param {Array<object>} backups
 * @param {{ before: string, at: number }|null} descBackup
 * @param {boolean} expanded
 */
function renderHistorySection(backups, descBackup, expanded) {
    if (backups.length === 0 && !descBackup) {
        return '';
    }

    const latest = Math.max(
        0,
        ...backups.map(item => Number(item.at) || 0),
        Number(descBackup?.at) || 0,
    );
    const meta = [
        backups.length > 0 ? `${backups.length} 条` : '',
        descBackup ? '含描述上一版' : '',
        latest > 0 ? `最近 ${formatTime(latest)}` : '',
    ].filter(Boolean).join(' · ');

    const rows = expanded
        ? `<div class="thrive-history">${backups.map(renderHistoryRow).join('')}${renderDescBackupRow(descBackup)}</div>`
        : '';

    return `
        <section class="thrive-panel__section thrive-panel__section--fold">
            <div class="thrive-panel__head thrive-panel__fold${expanded ? ' is-open' : ''}"
                role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"
                data-thrive-action="toggle-history"
                title="展开 / 收起写入记录（每条都带恢复入口）">
                <span class="thrive-panel__section-title">
                    <i class="fa-solid fa-chevron-right thrive-panel__fold-icon" aria-hidden="true"></i>已写入
                </span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            ${rows}
        </section>`;
}


function renderHistoryRow(item) {
    const created = item.action === 'created';
    // 缓冲区里的写入还没进真实世界书：写清楚，恢复按钮动的是哪一层才不会含糊
    const drafted = item.layer === 'draft';
    const meta = [
        item.book,
        drafted ? '缓冲区' : '',
        created ? '新建' : '改写',
        `${item.chars} 字`,
        formatTime(item.at),
    ].filter(Boolean).join(' · ');

    const tip = drafted
        ? '只改虚拟世界书里的这一条，真实世界书不动；缓冲区保存或丢弃之后这条记录就失效'
        : '把真实世界书里的这一条改回写入前；缓冲区开着时不能恢复（先处理缓冲区）';

    const restored = Number(item.restoredAt) > 0;
    const action = restored
        ? `<span class="thrive-history__done">已恢复 ${escapeHtml(formatTime(item.restoredAt))}</span>`
        : `<div class="menu_button thrive-panel__button thrive-history__restore" data-thrive-action="restore-lore"
            data-backup-id="${escapeHtml(item.id)}" title="${escapeHtml(tip)}">${created ? '撤销新建' : '恢复写入前'}</div>`;

    return `
        <div class="thrive-history__row">
            <div class="thrive-history__main">
                <span class="thrive-history__title">${escapeHtml(item.title || '（无标题）')}</span>
                <span class="thrive-history__meta">${escapeHtml(meta)}</span>
            </div>
            ${action}
        </div>`;
}


function renderDescBackupRow(descBackup) {
    if (!descBackup) {
        return '';
    }

    const chars = String(descBackup.before ?? '').length;
    const meta = ['角色描述 · 上一版', `${chars} 字`, formatTime(descBackup.at)].filter(Boolean).join(' · ');

    return `
        <div class="thrive-history__row thrive-history__row--desc">
            <div class="thrive-history__main">
                <span class="thrive-history__title">角色描述</span>
                <span class="thrive-history__meta">${escapeHtml(meta)}</span>
            </div>
            <div class="menu_button thrive-panel__button" data-thrive-action="restore-desc">恢复上一版</div>
        </div>`;
}


function renderDiff(rows) {
    if (rows.length === 0) {
        return '<div class="thrive-diff"><div class="thrive-diff__empty">与磁盘上的描述完全一致，没有可显示的差异。</div></div>';
    }

    const html = rows.map(row => {
        if (row.type === 'fold') {
            return `<div class="thrive-diff__row thrive-diff__row--fold">⋯ ${row.count} 行未改动</div>`;
        }

        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
        // 空行也要占一行高度，否则 diff 的段落结构会看不出来
        const text = row.text === '' ? '&nbsp;' : escapeHtml(row.text);

        return `<div class="thrive-diff__row thrive-diff__row--${row.type}">`
            + `<span class="thrive-diff__sign">${sign}</span>`
            + `<span class="thrive-diff__text">${text}</span>`
            + '</div>';
    });

    return `<div class="thrive-diff">${html.join('')}</div>`;
}


/**
 * 待确认 / 冲突状态下的两个动作。
 *
 * 文案不用「接受 / 拒绝」：那是相对于"这份改动"说的，用户得先想明白谁在接受谁。
 * 直接写动作落在哪儿——写进角色卡，还是丢掉。
 */
function renderPendingActions(conflict) {
    const primary = conflict
        ? '<div class="menu_button thrive-panel__button thrive-panel__button--danger" data-thrive-action="force"'
            + ' title="不用管卡上被改过的地方，直接用这份内容盖掉">强制覆盖</div>'
        : '<div class="menu_button thrive-panel__button" data-thrive-action="accept"'
            + ' title="把这份描述写进角色卡，从下一轮请求开始生效">写入角色卡</div>';

    return `${primary}<div class="menu_button thrive-panel__button thrive-panel__button--ghost"`
        + ' data-thrive-action="discard" title="丢掉这份暂存，角色卡上的描述保持原样">丢弃改动</div>';
}


/**
 * 已写入状态下的动作。
 *
 * 三个按钮以前叫「刷新编辑框 / 重新写入 / 关闭」，前两个都在"写"，但写的地方不同
 * （编辑框 vs 角色卡），第三个"关闭"更没说清关的是什么。现在每个按钮都把落点写在名字里：
 *   - 填入编辑框：只动角色编辑面板里的文本框，要保存才生效
 *   - 重写角色卡：真的落盘，卡上现在的版本先进「上一版」
 *   - 移除记录：只是把这条记录收起来，什么内容都不改
 * 前两个都会覆盖掉看得见的文字，所以各自带 title 说清覆盖的是哪一份。
 */
function renderAppliedActions(drift = false, editorStale = false) {
    const buttons = [];

    if (editorStale) {
        buttons.push('<div class="menu_button thrive-panel__button" data-thrive-action="sync-editor"'
            + ' title="只把这份内容填进角色编辑框，不动角色卡；要在角色编辑面板里保存才真正生效">填入编辑框</div>');
    }

    if (drift) {
        buttons.push('<div class="menu_button thrive-panel__button thrive-panel__button--danger"'
            + ' data-thrive-action="rewrite-desc"'
            + ' title="把这份内容重新写回角色卡；卡上现在的描述会被覆盖，覆盖前会先存进「上一版」">重写角色卡</div>');
    }

    buttons.push('<div class="menu_button thrive-panel__button thrive-panel__button--ghost"'
        + ' data-thrive-action="dismiss-record" title="只是把这条记录从面板上去掉，角色卡上的内容不会变">移除记录</div>');

    return buttons.join('');
}


/**
 * 按钮底下那句小字：说出这几个按钮**之间**的区别。
 *
 * 不复述 notice 里已经讲过的前因后果——窄屏上两段长字挤在一起，反而更像噪音。
 * 这里只回答"它们各自动哪儿"，完整说明在按钮的 title 里。
 */
function appliedHint(drift, editorStale) {
    if (drift && editorStale) {
        return '重写角色卡 = 落到角色卡；填入编辑框 = 只改框里的文字。两者都动不到这条记录本身。';
    }
    if (drift) {
        return '重写角色卡会覆盖卡上现版，覆盖前先存进「上一版」。';
    }
    if (editorStale) {
        return '填入编辑框只改框里的文字，不动角色卡，保存才生效。';
    }

    return '这条记录只是留痕：移除它不会改回任何内容。';
}


function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }

    const date = new Date(value);
    const pad = number => String(number).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date().toDateString() === date.toDateString();

    return today ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export { renderPanel };
