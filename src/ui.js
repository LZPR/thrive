/**
 * ui.js · 设置面板 + 状态徽章 + 记录面板
 *
 * 三处入口：
 *   - 设置面板：渲染 settings.html，append 到 #extensions_settings2
 *   - 状态徽章：append 到 #leftSendForm，**两段**——左「主动」切当前对话的开关，右「被动」切全局的
 *     自动学习；有未处理的改动时带计数，被动挂上待学习时右段变成「待学」
 *   - 记录面板：浮动在右下角，两个分区——待确认（patch）+ 已写入（世界书历史）
 *
 * 所有事件处理器都在触发时现取 getContext()，理由见 index.js 的 context() 注释。
 */

import { getContext } from '../../../../extensions.js';
import {
    COMPACT_PROMPT_LIMIT,
    DEFAULT_COMPACT_PROMPT,
    getCompactPrompt,
    normalizeCompactPrompt,
} from './compact.js';
import {
    countChars,
    DEFAULT_BLOCK,
    getBlockText,
    getPositionHint,
    normalizeBlockText,
    normalizePosition,
    syncFromContext,
} from './prompt.js';
import {
    clearReadHash,
    DEFAULT_SETTINGS,
    ensureSettings,
    findLoreBackup,
    getDescBackup,
    getLoreBackups,
    getPending,
    getState,
    isChatAvailable,
    isEnabled,
    loreReadKey,
    markLoreBackupRestored,
    saveChat,
    setEnabled,
} from './store.js';
import {
    getActiveCharacter,
    getWritableBook,
    isBookScanned,
    refreshDescriptionEditor,
    restoreLoreEntry,
} from './targets.js';
import {
    applyPatch,
    buildDiffRows,
    discardPatch,
    diskDescription,
    getPatch,
    isUnresolved,
    PATCH_STATUS,
    restoreDescBackup,
    rewriteAppliedDescription,
} from './patch.js';
import { PANEL_EVENT, PASSIVE_EVENT } from './events.js';
import { clampLimit, LIMIT_SPECS, readLimits } from './limits.js';
import { armManual, describePending, intervalProgress, parseKeywords } from './passive.js';
import { diagnoseEnvironment, formatDiagnosis } from './diagnostics.js';
import { escapeHtml, normalizeEol } from './util.js';

const LOG = '[Thrive]';
const BADGE_ID = 'thrive_badge';
const PANEL_ID = 'thrive_panel';

/** 记录面板的尺寸/透明度取值范围，设置页的滑块与这里的夹取必须一致 */
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 900;
const PANEL_MIN_HEIGHT = 200;
const PANEL_MAX_HEIGHT = 900;
const PANEL_MIN_OPACITY = 0.3;
/** 拖动时面板与视口边缘留的空隙：全贴边会让边框看不清，也不好再抓起来 */
const PANEL_MARGIN = 8;

/**
 * 会影响"工具能不能用"的 ST 设置控件。用户在这些地方改完，诊断区要立刻跟上，
 * 否则它一直停在页面加载时的那一句。
 */
const DIAG_TRIGGERS = new Set([
    'main_api',
    'openai_function_calling',
    'custom_prompt_post_processing',
    'chat_completion_source',
    'model_openai_select',
]);

/** 编辑防抖：只用于落盘，内存里的 settings 已经是新值 */
const SAVE_DELAY = 300;

/**
 * 徽章拆成两段：左边「主动」（当前对话的手动开关），右边「被动」（全局的自动学习）。
 *
 * 两段各自是一个可点区，因为它们管的是两件不同的事、存在两处不同的地方；
 * 合成一个点击区就只能靠右键/长按区分，用户发现不了。外层只负责外壳与计数。
 */
const BADGE_HTML = `
<div id="thrive_badge" class="thrive-badge interactable" role="group" aria-label="学习模式">
    <span class="thrive-badge__seg thrive-badge__seg--active" role="button" tabindex="0"
        data-thrive-mode="active" aria-pressed="false">
        <span class="thrive-badge__dot" aria-hidden="true"></span>
        <span class="thrive-badge__label">主动</span>
    </span>
    <span class="thrive-badge__seg thrive-badge__seg--passive" role="button" tabindex="0"
        data-thrive-mode="passive" aria-pressed="false">
        <span class="thrive-badge__dot" aria-hidden="true"></span>
        <span class="thrive-badge__label">被动</span>
    </span>
    <span class="thrive-badge__count displayNone" aria-hidden="true"></span>
</div>`;

let saveTimer = null;

function toast(message) {
    if (globalThis.toastr?.info) {
        globalThis.toastr.info(message);
    } else {
        console.info(`${LOG} ${message}`);
    }
}

/* ------------------------------------------------------------------ 设置面板 */

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
    bindPanelEvents();
    bindDiagnosticRefresh();
    await refreshBookOptions();
    refreshUI();
}

/**
 * 监听 ST 自己的相关设置项。
 *
 * 用 document 上的一次委托而不是逐个 getElementById：ST 的设置抽屉是懒渲染的，
 * 初始化时这些控件可能还不存在，绑定时找不到就永远绑不上。
 */
function bindDiagnosticRefresh() {
    document.addEventListener('change', event => {
        const id = event.target?.id;
        if (!id || !DIAG_TRIGGERS.has(id)) {
            return;
        }
        refreshUI(getContext());
    });
}

function bindPanelEvents() {
    $('#thrive_enabled_by_default').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).enabledByDefault = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
    });

    $('#thrive_show_badge').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).showBadge = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    bindBlockControls();
    bindCompactControls();
    bindLoreControls();
    bindLimitControls();
    bindModuleControls();
    bindPassiveControls();
    bindPatchControls();
    bindTraceControls();
    bindPanelLayoutControls();
}

/* ------------------------------------------------------------------ 模块开关 */

/** 至少有一个可写模块。两个都关时整个扩展没有意义，开关要置灰。 */
function hasAnyModule(settings) {
    return settings?.moduleWorldbook !== false || settings?.moduleDescription !== false;
}

function bindModuleControls() {
    $('#thrive_module_worldbook').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).moduleWorldbook = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });

    $('#thrive_module_description').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).moduleDescription = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        refreshUI(ctx);
    });
}

function updateModuleHints(ctx, settings) {
    const worldbook = settings.moduleWorldbook !== false;
    const description = settings.moduleDescription !== false;
    const book = getWritableBook(settings);

    const wbHint = document.getElementById('thrive_module_worldbook_hint');
    if (wbHint) {
        // 不自动改用户的学习块，只说一句"建议一并删掉"
        const warn = !worldbook || !book;
        wbHint.textContent = !worldbook
            ? '已关闭：模型看不到世界书工具。学习块里关于世界书的段落建议一并删掉。'
            : !book
                ? '未就绪：还没选可写书，世界书工具不会注册。'
                : '模型可以读写可写书里的条目。';
        wbHint.classList.toggle('thrive-hint--warn', warn);
    }

    const descHint = document.getElementById('thrive_module_description_hint');
    if (descHint) {
        descHint.textContent = description
            ? '模型可以读写当前角色的描述。'
            : '已关闭：模型看不到角色描述工具。学习块里关于角色描述的段落建议一并删掉。';
        descHint.classList.toggle('thrive-hint--warn', !description);
    }

    const note = document.getElementById('thrive_module_note');
    if (note) {
        note.classList.toggle('displayNone', worldbook || description);
    }
}

/* ------------------------------------------------------------ 被动学习设置 */

/** 条数判据的上限。再大就不是"定期抽查"，是"永远不会触发" */
const PASSIVE_INTERVAL_MAX = 500;

function bindPassiveControls() {
    const toggle = document.getElementById('thrive_passive_enabled');
    if (toggle) {
        toggle.addEventListener('change', function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            settings.passiveEnabled = Boolean(this.checked);
            ctx.saveSettingsDebounced?.();

            // 关掉时顺手丢掉已经挂上的待学习：否则会出现"被动显示关闭、徽章却在闪待学"
            if (!settings.passiveEnabled && getPending(ctx)) {
                getState(ctx).passive.pending = null;
                saveChat(ctx);
            }

            syncFromContext(ctx);
            refreshUI(ctx);
            toast(settings.passiveEnabled
                ? '被动学习已开启（不影响徽章上的主动开关）'
                : '被动学习已关闭');
        });
    }

    const interval = document.getElementById('thrive_passive_interval');
    if (interval) {
        // 只在 change（失焦 / 回车）时落值：边打字边存盘会把"12"中间那个"1"也存进去
        interval.addEventListener('change', () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const value = clampInterval(interval.value);

            settings.passiveInterval = value;
            interval.value = String(value);
            ctx.saveSettingsDebounced?.();
            updatePassiveHint(ctx, settings);
        });
    }

    const keywords = document.getElementById('thrive_passive_keywords');
    if (keywords) {
        keywords.addEventListener('input', () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            settings.passiveKeywords = String(keywords.value ?? '');

            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                ctx.saveSettingsDebounced?.();
                updatePassiveHint(ctx, settings);
            }, SAVE_DELAY);

            // 提示立刻跟着变，不用等存盘：用户正在看的就是"配了几个"
            updatePassiveHint(ctx, settings);
        });
    }

    const once = document.getElementById('thrive_passive_once');
    if (once) {
        once.addEventListener('click', () => onTriggerOnce());
    }
}

function clampInterval(value) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num <= 0) {
        return 0;
    }
    return Math.min(num, PASSIVE_INTERVAL_MAX);
}

/**
 * 「现在触发一次」：不等判据，直接给下一轮挂一次学习。
 *
 * 存在的理由不是方便，而是**可验证**：用户配完关键词之后总得能立刻看见它生效，
 * 否则要等到真出现那句话，期间只能猜。
 */
function onTriggerOnce() {
    const ctx = getContext();
    ensureSettings(ctx);

    if (!hasAnyModule(ensureSettings(ctx))) {
        toast('两个模块都关着，请先开启至少一个');
        return;
    }
    if (!isChatAvailable(ctx)) {
        toast('请先打开一个对话');
        return;
    }

    const diag = diagnoseEnvironment(ctx);
    if (!diag.ok) {
        toast(`工具调用不可用：${formatDiagnosis(diag)}`);
        return;
    }
    if (getPending(ctx)) {
        toast('已经有一次待学习了，下一次生成就会用掉它');
        return;
    }

    if (!armManual(ctx)) {
        toast('没能挂上待学习，请稍后再试');
        return;
    }

    saveChat(ctx);
    syncFromContext(ctx);
    refreshUI(ctx);
    // 提示由 PASSIVE_EVENT 统一发，这里不重复弹
}

/**
 * 被动学习那一段的说明文字。
 *
 * 四种状态各说一句话：关着 / 开着但没配判据 / 已经触发等下一轮 / 正常待命。
 * 用户最容易踩的是第二种——点了徽章却没反应，原因就在这儿。
 *
 * @param {object} ctx
 * @param {object} settings
 */
function updatePassiveHint(ctx, settings) {
    const hint = document.getElementById('thrive_passive_hint');
    const progressEl = document.getElementById('thrive_passive_progress');
    const keywordHint = document.getElementById('thrive_passive_keyword_hint');

    const enabled = settings.passiveEnabled === true;
    const keywords = parseKeywords(settings.passiveKeywords);
    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    const pending = getPending(ctx);
    const available = isChatAvailable(ctx);
    const progress = intervalProgress(ctx, settings);
    const noRule = interval <= 0 && keywords.length === 0;

    if (hint) {
        let text;
        let warn = false;

        if (!enabled) {
            text = '被动学习关着：点亮徽章右侧的「被动」之后才会自动触发；和左侧「主动」互不影响。';
        } else if (noRule) {
            text = '已开启，但两条判据都没配（间隔 0、关键词为空），现在不会触发。填一个就行，两个都填也行。';
            warn = true;
        } else if (pending) {
            text = `已触发一次（${describePending(pending)}）：下一次生成临时打开学习模式，那一轮回复结束后立刻关闭。`;
        } else if (!available) {
            text = '已开启：打开一个对话之后开始累计。';
        } else {
            text = '已开启：任一判据命中就触发（或的关系），触发后下一轮临时开启、回复完自动关闭。';
        }

        hint.textContent = text;
        hint.classList.toggle('thrive-hint--warn', warn);
    }

    if (progressEl) {
        progressEl.textContent = !available
            ? '—'
            : interval > 0
                ? `${progress.since} / ${interval} 条`
                : '未启用';
    }

    if (keywordHint) {
        keywordHint.textContent = keywords.length > 0
            ? `已配 ${keywords.length} 个：${keywords.join('、')}。大小写不敏感，子串命中即算；只看最近一轮的用户与角色消息。`
            : '留空 = 不用关键词触发。多个关键词用逗号、分号或换行分隔。';
        keywordHint.classList.toggle('thrive-hint--warn', enabled && noRule);
    }
}

/** 把设置里的值回填到两个控件上。正在编辑的控件不回写，否则光标会跳 */
function updatePassiveControls(ctx, settings) {
    const interval = document.getElementById('thrive_passive_interval');
    if (interval && document.activeElement !== interval) {
        const value = String(Math.max(0, Math.floor(Number(settings.passiveInterval) || 0)));
        if (interval.value !== value) {
            interval.value = value;
        }
    }

    const keywords = document.getElementById('thrive_passive_keywords');
    if (keywords && document.activeElement !== keywords) {
        const value = String(settings.passiveKeywords ?? '');
        if (keywords.value !== value) {
            keywords.value = value;
        }
    }

    updatePassiveHint(ctx, settings);
}

/* ------------------------------------------------------------ 描述改动暂存 */

function bindPatchControls() {
    const toggle = document.getElementById('thrive_patch_enabled');
    if (!toggle) {
        return;
    }

    toggle.addEventListener('change', function () {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const enabled = Boolean(this.checked);

        // spec §10：有 pending 时不允许静默丢弃。这里不弹"要不要一起丢掉"，
        // 只把开关拨回去——丢弃必须发生在面板里，用户得亲眼看一遍 diff
        if (!enabled && isUnresolved(getPatch(ctx))) {
            this.checked = true;
            toast('还有一份待处理的描述改动：请先在记录面板里接受或拒绝');
            panelExpanded = true;
            refreshPanel(ctx);
            document.getElementById(PANEL_ID)?.scrollIntoView({ block: 'nearest' });
            return;
        }

        settings.patchEnabled = enabled;
        ctx.saveSettingsDebounced?.();
        updatePatchHint(ctx, settings);

        if (!enabled) {
            toast('之后的描述改动会直接写入角色卡');
        }
    });
}

/* ------------------------------------------------------------ 工具日志清理 */

function bindTraceControls() {
    const toggle = document.getElementById('thrive_drop_traces');
    if (!toggle) {
        return;
    }

    toggle.addEventListener('change', function () {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        settings.dropTraces = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        updateTraceHint(settings);

        // 关掉只是"以后不再清"，已经清掉的日志不会自己回来——说明清楚，别让人以为没生效
        toast(this.checked
            ? '下一条消息起，旧工具日志会移出上下文（界面里仍可见）'
            : '旧工具日志会按 ST 原生行为留在上下文里');
    });
}

function updateTraceHint(settings) {
    const el = document.getElementById('thrive_drop_traces_hint');
    if (!el) {
        return;
    }

    const on = settings.dropTraces !== false;
    el.textContent = on
        ? '发下一条消息时，把上一轮及更早的工具日志移出上下文；消息本身留在聊天里，照常显示。'
        : '已关闭：日志按 ST 原生行为留在上下文里，看得见，但会随轮次累积、持续占 token。';
    el.classList.toggle('thrive-hint--warn', !on);
}

function updatePatchHint(ctx, settings) {
    const el = document.getElementById('thrive_patch_hint');
    if (!el) {
        return;
    }

    const enabled = settings.patchEnabled !== false;
    const pending = isUnresolved(getPatch(ctx));

    if (!enabled) {
        el.textContent = '已关闭：模型改完直接落盘，下一轮立即生效。保护只剩「上一版快照」，改错了要去角色卡里手动改回来。';
        el.classList.add('thrive-hint--warn');
        return;
    }

    el.textContent = pending
        ? '当前有一份待处理的改动，在记录面板的「待确认」里接受或拒绝。'
        : '模型的描述改动会先暂存成一份 diff，你接受后才写入角色卡；暂存期间模型读到的是暂存版。';
    el.classList.toggle('thrive-hint--warn', pending);
}

/* ------------------------------------------------------------ 数值与上限 */

/**
 * 设置页「数值与上限」的输入框：`[元素 id, limits.js 的键]`。
 *
 * min / max / step 不写死在 HTML 里，绑定时从 LIMIT_SPECS 灌进去：
 * 范围只有一份定义，否则模板里改了一半、夹取逻辑还是老值，用户会看到
 * "输入框允许填 5000、实际被夹到 2000"这种自相矛盾的界面。
 */
const LIMIT_FIELDS = Object.freeze([
    ['thrive_limit_soft_entry', 'softLimitEntry'],
    ['thrive_limit_hard_entry', 'hardLimitEntry'],
    ['thrive_limit_max_keywords', 'maxKeywords'],
    ['thrive_limit_title_chars', 'titleMaxChars'],
    ['thrive_limit_soft_desc', 'softLimitDesc'],
    ['thrive_limit_hard_desc', 'hardLimitDesc'],
    ['thrive_limit_query_entries', 'maxQueryEntries'],
    ['thrive_limit_content_chars', 'maxContentChars'],
    ['thrive_limit_max_titles', 'maxTitles'],
    ['thrive_limit_entry_count', 'softEntryCount'],
    ['thrive_limit_backup', 'loreBackupLimit'],
    ['thrive_limit_trace_chars', 'traceMaxChars'],
]);

function bindLimitControls() {
    for (const [id, key] of LIMIT_FIELDS) {
        const input = document.getElementById(id);
        if (!input) {
            continue;
        }

        const spec = LIMIT_SPECS[key];
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);

        // input 只刷提示，change（失焦 / 回车）才落值：
        // 边打字边存盘会把 "1600" 中间那个 "1" 先存成 1，再被夹成下限
        input.addEventListener('input', () => {
            const settings = ensureSettings(getContext());
            updateLimitHint({ ...settings, [key]: clampLimit(key, input.value) });
        });

        input.addEventListener('change', () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const value = clampLimit(key, input.value);

            settings[key] = value;
            input.value = String(value);
            ctx.saveSettingsDebounced?.();
            updateLimitHint(settings);
        });
    }

    const reset = document.getElementById('thrive_limits_reset');
    reset?.addEventListener('click', () => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);

        for (const [, key] of LIMIT_FIELDS) {
            settings[key] = LIMIT_SPECS[key].default;
        }

        ctx.saveSettingsDebounced?.();
        syncLimitControls(settings);
        toast('数值与上限已恢复默认');
    });
}

function syncLimitControls(settings) {
    for (const [id, key] of LIMIT_FIELDS) {
        const input = document.getElementById(id);
        // 正在这个框里打字时不要回写，否则光标和没落盘的输入会被冲掉
        if (!input || document.activeElement === input) {
            continue;
        }

        const value = clampLimit(key, settings[key]);
        if (input.value !== String(value)) {
            input.value = String(value);
        }
    }

    updateLimitHint(settings);
}

/**
 * 一句"现在实际生效的是什么"。
 *
 * 设置页里的输入框是用户的**意愿**，这里给的是**结果**——两者可能不一样：
 * 软提醒高于硬上限时会被硬上限封顶，填了 0 或超范围的值会回落到默认值。
 * 只把结果写出来，不去改用户填的数字：改一个框同时动另一个框是最难理解的交互。
 */
function updateLimitHint(settings) {
    const el = document.getElementById('thrive_limits_hint');
    if (!el) {
        return;
    }

    const limits = readLimits(settings);
    const entryClamped = Number(settings.softLimitEntry) > limits.hardLimitEntry;
    const descClamped = Number(settings.softLimitDesc) > limits.hardLimitDesc;

    const parts = [
        `条目 ${limits.softLimitEntry} / ${limits.hardLimitEntry} 字`,
        `描述 ${limits.softLimitDesc} / ${limits.hardLimitDesc} 字`,
        `关键词 ${limits.maxKeywords} 个`,
        `单次读 ${limits.maxQueryEntries} 条、每条 ${limits.maxContentChars} 字`,
        `总览 ${limits.maxTitles} 个标题`,
        `记录留 ${limits.loreBackupLimit} 条`,
    ];

    el.textContent = `当前生效：${parts.join('；')}。`
        + (entryClamped || descClamped
            ? ' 软提醒高于硬上限，已按硬上限计算；被拒之前不会再有单独的提醒。'
            : '');
    el.classList.toggle('thrive-hint--warn', entryClamped || descClamped);
}

/* ------------------------------------------------------------------ 记录面板 */

let patchBusy = false;
let panelSignature = null;
/** 用户展开/收起过面板没有。待确认一出现会强制展开，处理完不自动收起 */
let panelExpanded = false;
/** 已经被"强制展开"过的那份 patch。只在它第一次出现时展开，之后收起就是收起 */
let forcedPatchId = null;
/** 拖动会话：{ pointerId, offsetX, offsetY }，按下标题栏时建立，松手清空 */
let dragSession = null;

/**
 * 挂载记录面板。重复调用安全。
 * 面板是空壳，内容由 refreshPanel 填；没有东西可显示时整块隐藏。
 */
export function initPanel() {
    if (document.getElementById(PANEL_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${PANEL_ID}" class="thrive-panel displayNone" role="complementary" aria-live="polite" aria-label="Thrive 记录"></div>`,
    );

    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        console.warn(`${LOG} 记录面板创建失败`);
        return;
    }

    // 事件挂在外壳上：内容每次整块重绘，挂在里面会跟着一起没
    panel.addEventListener('click', onPanelClick);
    document.addEventListener(PANEL_EVENT, () => refreshPanel());

    bindDrag();

    // 窗口变小后原来拖到右下角的面板可能整个跑到屏幕外，重新摆一次
    window.addEventListener('resize', () => {
        const current = document.getElementById(PANEL_ID);
        if (!current || current.classList.contains('displayNone')) {
            return;
        }
        applyPanelLayout(current);
    });
}

/* -------------------------------------------------------------- 面板布局 */

/**
 * 面板的位置、尺寸、透明度都由设置决定，统一走 applyPanelLayout 写到行内样式。
 *
 * 为什么不做成拖拽 + 设置各写一套：两条路径写同一个 DOM 迟早会打架
 * （拖动改了 left，滑块改了 width，谁也不知道该以谁为准）。这里只有一个出口。
 */

/** 数字夹取。设置文件被手改过时也能拿到能用的值。 */
function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.min(Math.max(num, min), max);
}

/**
 * 从设置里读出一份可用的布局。
 * 位置用 -1 表示"还没拖过"，此时走 CSS 里的右下角。
 */
function readPanelLayout(settings) {
    const x = Number(settings.panelX);
    const y = Number(settings.panelY);
    const pinned = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0;

    return {
        pinned,
        x: pinned ? x : -1,
        y: pinned ? y : -1,
        width: Math.round(clampNumber(settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, DEFAULT_SETTINGS.panelWidth)),
        height: Math.round(clampNumber(settings.panelHeight, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, DEFAULT_SETTINGS.panelHeight)),
        opacity: clampNumber(settings.panelOpacity, PANEL_MIN_OPACITY, 1, DEFAULT_SETTINGS.panelOpacity),
    };
}

/**
 * 把当前设置铺到面板上。收起时宽度交给内容，展开时才用设置里的宽度与最大高度。
 * @param {HTMLElement} [panel]
 */
function applyPanelLayout(panel = document.getElementById(PANEL_ID)) {
    if (!panel || dragSession) {
        // 拖动中不要按设置回摆，否则面板会在指针底下跳回旧位置
        return;
    }

    const layout = readPanelLayout(ensureSettings(getContext()));

    panel.classList.toggle('thrive-panel--collapsed', !panelExpanded);
    panel.style.opacity = String(layout.opacity);

    if (panelExpanded) {
        // 再叠一个 vw/vh 上限：窗口窄于设置值时不该顶出屏幕
        panel.style.width = `min(${layout.width}px, 92vw)`;
        panel.style.maxHeight = `min(${layout.height}px, calc(100vh - 24px))`;
    } else {
        // 交给 .thrive-panel--collapsed 的 max-content，别留一条空荡荡的长条挡聊天
        panel.style.width = '';
        panel.style.maxHeight = '';
    }

    if (layout.pinned) {
        pinPanel(panel, layout.x, layout.y);
        return;
    }

    // 没拖过：交回 CSS 的右下角，顺手清掉之前拖出来的行内位置
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
}

/**
 * 把面板摆到（文档坐标下的）某个位置，并夹在视口内。
 *
 * 面板是 absolute 定位在初始包含块里的，style.left 用的是文档坐标；
 * getBoundingClientRect() 给的是视口坐标，两者差一个滚动量——ST 页面不滚动，
 * 但这里仍然换算，免得哪天外面套了一层可滚动的容器就整块跑偏。
 *
 * @param {HTMLElement} panel
 * @param {number} left 文档坐标
 * @param {number} top 文档坐标
 */
function pinPanel(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - rect.width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - rect.height - PANEL_MARGIN);

    const viewX = clampNumber(left - window.scrollX, PANEL_MARGIN, maxLeft, PANEL_MARGIN);
    const viewY = clampNumber(top - window.scrollY, PANEL_MARGIN, maxTop, PANEL_MARGIN);

    panel.style.left = `${Math.round(viewX + window.scrollX)}px`;
    panel.style.top = `${Math.round(viewY + window.scrollY)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

/**
 * 拖动。按下标题栏开始，移动时把面板跟到指针位置，松手落盘。
 *
 * move/up 挂在 document 上而不是面板上：指针一快就会离开面板，
 * 挂在面板上需要 setPointerCapture，而它在某些嵌入环境里不可靠。
 */
function bindDrag() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    panel.addEventListener('pointerdown', event => {
        if (event.button > 0) {
            return;
        }
        // 只有标题栏能抓：正文里要能选词、复制 diff，整块可拖会把它变成"一拖就动"
        if (!event.target.closest('.thrive-panel__bar')) {
            return;
        }
        // 按钮、链接、输入控件照常点击，不要变成拖动
        if (event.target.closest('[data-thrive-action], button, a, input, textarea, select')) {
            return;
        }

        const rect = panel.getBoundingClientRect();
        dragSession = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            // 只是点了一下标题栏、没真的挪动时别把默认的右下角变成固定坐标
            moved: false,
        };

        panel.classList.add('thrive-panel--dragging');
        document.body.classList.add('thrive-panel-dragging');
        event.preventDefault();
    });

    document.addEventListener('pointermove', event => {
        if (!dragSession || event.pointerId !== dragSession.pointerId) {
            return;
        }

        const current = document.getElementById(PANEL_ID);
        if (!current) {
            return;
        }

        pinPanel(
            current,
            event.clientX + window.scrollX - dragSession.offsetX,
            event.clientY + window.scrollY - dragSession.offsetY,
        );
        dragSession.moved = true;
        event.preventDefault();
    });

    const finish = event => {
        if (!dragSession || event.pointerId !== dragSession.pointerId) {
            return;
        }

        const moved = dragSession.moved;
        dragSession = null;
        document.body.classList.remove('thrive-panel-dragging');

        const current = document.getElementById(PANEL_ID);
        if (!current) {
            return;
        }
        current.classList.remove('thrive-panel--dragging');

        if (!moved) {
            return;
        }

        const x = Number.parseFloat(current.style.left);
        const y = Number.parseFloat(current.style.top);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }

        // 位置按屏幕记住，不按对话：换个聊天面板还在原地
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        settings.panelX = Math.round(x);
        settings.panelY = Math.round(y);
        ctx.saveSettingsDebounced?.();
    };

    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
}

/* ------------------------------------------------------- 面板布局设置项 */

function bindPanelLayoutControls() {
    bindRange('thrive_panel_width', 'panelWidth', value => `${Math.round(value)} px`);
    bindRange('thrive_panel_height', 'panelHeight', value => `${Math.round(value)} px`);
    bindRange('thrive_panel_opacity', 'panelOpacity', value => `${Math.round(value * 100)}%`);

    const reset = document.getElementById('thrive_panel_reset');
    reset?.addEventListener('click', () => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);

        settings.panelX = DEFAULT_SETTINGS.panelX;
        settings.panelY = DEFAULT_SETTINGS.panelY;
        settings.panelWidth = DEFAULT_SETTINGS.panelWidth;
        settings.panelHeight = DEFAULT_SETTINGS.panelHeight;
        settings.panelOpacity = DEFAULT_SETTINGS.panelOpacity;

        ctx.saveSettingsDebounced?.();
        syncPanelLayoutControls(settings);
        applyPanelLayout();
        toast('面板已回到右下角，大小与透明度恢复默认');
    });
}

/**
 * 滑块：拖动时立刻生效（input），松手才落盘（change）——每次 20px 都存一次盘没有意义。
 * @param {string} id 滑块 id，数值标签约定为 `${id}_value`
 * @param {'panelWidth'|'panelHeight'|'panelOpacity'} key
 * @param {(value: number) => string} format
 */
function bindRange(id, key, format) {
    const input = document.getElementById(id);
    if (!input) {
        return;
    }

    const label = document.getElementById(`${id}_value`);

    const commit = persist => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        const value = Number(input.value);
        if (!Number.isFinite(value)) {
            return;
        }

        settings[key] = value;
        if (label) {
            label.textContent = format(value);
        }
        applyPanelLayout();

        if (persist) {
            ctx.saveSettingsDebounced?.();
        }
    };

    input.addEventListener('input', () => commit(false));
    input.addEventListener('change', () => commit(true));
}

function syncPanelLayoutControls(settings) {
    syncRange('thrive_panel_width', settings.panelWidth, value => `${Math.round(value)} px`);
    syncRange('thrive_panel_height', settings.panelHeight, value => `${Math.round(value)} px`);
    syncRange('thrive_panel_opacity', settings.panelOpacity, value => `${Math.round(value * 100)}%`);
}

function syncRange(id, value, format) {
    const input = document.getElementById(id);
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return;
    }

    // 正在拖这根滑块时不要回写 value，否则手上的滑块会被设回旧值、跳一下
    if (input && document.activeElement !== input) {
        input.value = String(num);
    }

    const label = document.getElementById(`${id}_value`);
    if (label) {
        label.textContent = format(num);
    }
}

/**
 * 重绘记录面板。
 *
 * 显示条件：有 patch、有写入记录、或有描述快照。三者都没有就整块消失——
 * 大多数对话从头到尾不会出现这块东西。
 *
 * @param {object} [ctx]
 */
export function refreshPanel(ctx = getContext()) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const patch = getPatch(ctx);
    const backups = getLoreBackups(ctx);
    const descBackup = getDescBackup(ctx);

    /*
     * "已写入"但角色卡上的描述已经不是那份内容了 —— 实测最常见的原因是：
     * 角色编辑面板里还停着写入前的文本，用户点了一下保存，旧文本把新内容盖了回去。
     * 这时候面板如果继续说"已写入"，就会出现"面板说写了、编辑器里什么都没有"。
     * 所以单独算一个状态：内容还在聊天记录里（patch.after），给一个「重新写入」的出口。
     */
    const drift = Boolean(patch)
        && patch.status === PATCH_STATUS.APPLIED
        && Boolean(getActiveCharacter(ctx))
        && diskDescription(ctx) !== patch.after;

    /*
     * 另一种"已写入但对不上"：盘上是对的，编辑框里还停着别的文本。
     * 用户改过、或者写入那一刻正在框里打字，同步就会被跳过（不能盖掉正在敲的字）。
     * 这时给一个「刷新编辑框」的出口，省得为了让它显示新内容还得先关掉面板。
     */
    const editorStale = Boolean(patch)
        && patch.status === PATCH_STATUS.APPLIED
        && isDescriptionEditorStale(ctx, patch.after);

    if (!patch && backups.length === 0 && !descBackup) {
        panelSignature = null;
        forcedPatchId = null;
        panel.innerHTML = '';
        panel.classList.add('displayNone');
        return;
    }

    panel.classList.remove('displayNone');

    /*
     * 新出现的待确认改动必须直接把面板打开：否则徽章上多个数字，用户不知道在哪处理。
     *
     * 但只在"这一份 patch 第一次出现"时展开。之前是每次重绘都展开，于是用户点「收起」
     * 后 panelExpanded 先变 false、refreshPanel 又立刻把它改回 true——表现为"有时候
     * 收起按钮没反应"（有未处理改动时必现，刷新一次也会把它弹回来）。
     */
    if (isUnresolved(patch)) {
        if (patch.id !== forcedPatchId) {
            forcedPatchId = patch.id;
            panelExpanded = true;
        }
    } else {
        forcedPatchId = null;
    }

    // 重绘判据要含内容哈希：合并进同一份 patch 时 id 不变，两次改动的字数还可能刚好相等
    const signature = JSON.stringify([
        panelExpanded,
        patch ? [patch.id, patch.status, patch.before.length, patch.after.length, patch.after] : null,
        backups.map(item => [item.id, item.restoredAt]),
        descBackup ? descBackup.at : null,
        drift,
        editorStale,
    ]);
    if (signature === panelSignature) {
        return;
    }
    panelSignature = signature;

    panel.innerHTML = renderPanel({ patch, backups, descBackup, drift, editorStale });
    // 内容换了高度可能也变了，重新摆一次（收起/展开、拖动后的位置都在这里生效）
    applyPanelLayout(panel);
    updatePatchHint(ctx, ensureSettings(ctx));
}

/**
 * 角色编辑框里是不是还停着"不是这次写入"的文字。
 *
 * 页面刷新后编辑框是空的、面板没开时也可能取不到元素 —— 这两种都不算 stale，
 * 别在没事的时候挂一个按钮在那儿。
 *
 * @param {object} ctx
 * @param {string} applied 已写入的全文（patch.after）
 */
function isDescriptionEditorStale(ctx, applied) {
    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return false;
    }

    // 面板正在编辑别的角色：那个框跟这次写入无关
    const nameField = document.getElementById('character_name_pole');
    const character = getActiveCharacter(ctx);
    if (nameField && character?.name && nameField.value && nameField.value !== character.name) {
        return false;
    }

    return normalizeEol(textarea.value) !== normalizeEol(applied);
}

function renderPanel({ patch, backups, descBackup, drift = false, editorStale = false }) {
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

    const bar = `
        <div class="thrive-panel__bar">
            <i class="fa-solid fa-grip-vertical thrive-panel__grip" title="按住拖动可移动面板" aria-hidden="true"></i>
            <span class="thrive-panel__title">Thrive · 记录</span>
            <span class="thrive-panel__summary">${escapeHtml(counts.join(' · '))}</span>
            <div class="menu_button thrive-panel__toggle" data-thrive-action="toggle">${panelExpanded ? '收起' : '展开'}</div>
        </div>`;

    if (!panelExpanded) {
        return bar;
    }

    const body = [renderPatchSection(patch, drift, editorStale), renderHistorySection(backups, descBackup)]
        .filter(Boolean)
        .join('');

    return `${bar}<div class="thrive-panel__body">${body}</div>`;
}

/**
 * 待确认分区。没有 patch 时整段不渲染。
 * @param {object|null} patch
 * @param {boolean} [drift] 已写入，但角色卡上已经不是这份内容
 * @param {boolean} [editorStale] 已写入，但角色编辑框里还停着别的文字
 */
function renderPatchSection(patch, drift = false, editorStale = false) {
    if (!patch) {
        return '';
    }

    const conflict = patch.status === PATCH_STATUS.CONFLICT;
    const applied = patch.status === PATCH_STATUS.APPLIED;
    const name = getActiveCharacter(getContext())?.name;

    const title = applied ? '角色描述 · 已写入' : conflict ? '角色描述 · 冲突' : '角色描述 · 待确认';
    const delta = patch.after.length - patch.before.length;
    const deltaText = `${delta > 0 ? '+' : ''}${delta}`;
    const meta = `${formatTime(patch.createdAt)} · ${patch.before.length} → ${patch.after.length} 字（${deltaText}）`;
    const when = patch.appliedAt ? `（${formatTime(patch.appliedAt)}）` : '';

    const notice = applied
        ? drift
            ? '角色卡上的描述已经和这次写入不一致了：可能是你在编辑器里自己改过，'
                + '也可能是编辑面板还停着旧文本、一次保存把它盖了回去。'
                + '这份内容只留在记录里，需要的话点「重新写入」再落一次盘（当前这版会先进上一版快照）。'
            : editorStale
                ? '角色卡上已经是这份内容了，但编辑面板的文本框里还是别的文字'
                    + '（你改过，或者写入时正在框里输入）。直接保存会把这次写入盖回去；'
                    + '点「刷新编辑框」就能把它换成这份内容，不用关面板。'
                : `已写入${name ? `「${name}」的` : ''}角色卡${when}，下一轮请求开始生效。`
        : conflict
            ? '磁盘上的描述在暂存之后被改动过。这里不做自动合并：要么整份覆盖，要么拒绝。'
            : '还没写入角色卡。接受后从下一轮请求开始生效。';

    const body = applied ? '' : renderDiff(buildDiffRows(patch.before, patch.after));
    const actions = applied ? renderAppliedActions(drift, editorStale) : renderPendingActions(conflict);
    const hint = applied
        ? (drift
            ? '重写只动角色描述；当前这一版会先进「上一版」快照。'
            : editorStale
                ? '刷新编辑框会用这次写入的内容覆盖框里的文字。'
                : '这条记录只是留痕：关掉它不会改回任何内容。')
        : '面板只读：只能整份接受或拒绝，不能在这里改文本。';

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
 * 记录只读，唯一的动作是恢复——世界书没有 patch，写错了只能靠这条退路。
 * @param {Array<object>} backups
 * @param {{ before: string, at: number }|null} descBackup
 */
function renderHistorySection(backups, descBackup) {
    if (backups.length === 0 && !descBackup) {
        return '';
    }

    const rows = backups.map(renderHistoryRow).join('');
    const desc = renderDescBackupRow(descBackup);
    const meta = backups.length > 0 ? `最近 ${backups.length} 次` : '';

    return `
        <section class="thrive-panel__section">
            <div class="thrive-panel__head">
                <span class="thrive-panel__section-title">已写入</span>
                <span class="thrive-panel__meta">${escapeHtml(meta)}</span>
            </div>
            <div class="thrive-history">${rows}${desc}</div>
        </section>`;
}

function renderHistoryRow(item) {
    const created = item.action === 'created';
    const meta = [
        item.book,
        created ? '新建' : '改写',
        `${item.chars} 字`,
        formatTime(item.at),
    ].filter(Boolean).join(' · ');

    const restored = Number(item.restoredAt) > 0;
    const action = restored
        ? `<span class="thrive-history__done">已恢复 ${escapeHtml(formatTime(item.restoredAt))}</span>`
        : `<div class="menu_button thrive-panel__button thrive-history__restore" data-thrive-action="restore-lore" data-backup-id="${escapeHtml(item.id)}">${created ? '撤销新建' : '恢复写入前'}</div>`;

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

function renderPendingActions(conflict) {
    const primary = conflict
        ? '<div class="menu_button thrive-panel__button thrive-panel__button--danger" data-thrive-action="force">强制覆盖</div>'
        : '<div class="menu_button thrive-panel__button" data-thrive-action="accept">接受</div>';

    return `${primary}<div class="menu_button thrive-panel__button" data-thrive-action="discard">拒绝</div>`;
}

function renderAppliedActions(drift = false, editorStale = false) {
    const sync = editorStale
        ? '<div class="menu_button thrive-panel__button" data-thrive-action="sync-editor"'
            + ' title="用已写入的内容覆盖角色编辑框里的文字">刷新编辑框</div>'
        : '';
    const rewrite = drift
        ? '<div class="menu_button thrive-panel__button thrive-panel__button--danger" data-thrive-action="rewrite-desc">重新写入</div>'
        : '';
    return `${sync}${rewrite}<div class="menu_button thrive-panel__button" data-thrive-action="close">关闭</div>`;
}

function onPanelClick(event) {
    const trigger = event.target.closest('[data-thrive-action]');
    const action = trigger?.dataset.thriveAction;
    if (!action) {
        return;
    }

    switch (action) {
        case 'accept':
            void applyAndReport(false);
            break;
        case 'force':
            void applyAndReport(true);
            break;
        case 'discard':
            void discardAndReport();
            break;
        case 'close':
            discardPatch(getContext());
            refreshPanel(getContext());
            break;
        case 'toggle':
            panelExpanded = !panelExpanded;
            refreshPanel(getContext());
            break;
        case 'restore-lore':
            void restoreLoreAndReport(trigger.dataset.backupId);
            break;
        case 'restore-desc':
            void restoreDescAndReport();
            break;
        case 'rewrite-desc':
            void rewriteDescAndReport();
            break;
        case 'sync-editor':
            syncEditorAndReport();
            break;
        default:
            break;
    }
}

/** 接受 / 强制覆盖。失败时把原因说清楚，别让按钮看起来"没反应" */
async function applyAndReport(force) {
    if (patchBusy) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await applyPatch(getContext(), { force });

        if (result.ok) {
            const name = getActiveCharacter(getContext())?.name;
            const reason = result.editor?.reason;
            const edited = result.editor?.synced === false && reason === 'edited';
            const who = name ? `「${name}」的` : '';

            // 编辑器里用户改过描述：不覆盖他的输入，但必须说清楚"保存会盖掉这次写入"
            if (edited) {
                toast(`已写入${who}角色卡，但编辑框里的描述你改过，这次没覆盖它；`
                    + '要换成新内容，点记录面板上的「刷新编辑框」');
            } else if (reason === 'overwrote-edited') {
                toast(`已写入${who}角色卡；编辑面板里未保存的旧描述被这次写入覆盖了`);
            } else {
                toast(`已写入${who}角色卡，下一轮请求生效`);
            }
            return;
        }

        if (result.error === 'CONFLICT') {
            toast('描述在暂存之后被改动过，请选择强制覆盖或拒绝');
        } else if (result.error === 'NO_CHAR') {
            toast('当前没有选中角色，无法写入描述');
        } else {
            toast(`写入失败：${result.hint ?? result.error}`);
        }
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel();
    }
}

async function discardAndReport() {
    if (patchBusy) {
        return;
    }

    const confirmed = await askDiscardPatch();
    if (!confirmed) {
        return;
    }

    discardPatch(getContext());
    refreshPanel(getContext());
    toast('已拒绝这份改动，角色描述没有变化');
}

/**
 * 把一条世界书条目恢复成写入前。
 *
 * 恢复要写盘、要覆盖用户可能已经手改过的内容，所以先确认一次；
 * 恢复完再作废读取登记——书被插件动过，模型下一次写入必须重新读。
 */
async function restoreLoreAndReport(backupId) {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const backup = findLoreBackup(ctx, backupId);

    if (!backup) {
        toast('这条记录已经不在对话框里了');
        refreshPanel(ctx);
        return;
    }

    const created = backup.action === 'created';
    const message = created
        ? `「${backup.book}」里的「${backup.title}」会被删掉，回到写入前（没有这条）的状态。确定吗？`
        : `「${backup.book}」里的「${backup.title}」会被改回 ${backup.before.length} 字的旧内容，之后的修改都会丢。确定吗？`;

    const confirmed = await askConfirm(message);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await restoreLoreEntry(ctx, backup);

        if (!result.ok) {
            toast(result.hint ?? `恢复失败：${result.error}`);
            return;
        }

        markLoreBackupRestored(ctx, backup.id);
        clearReadHash(ctx, loreReadKey(backup.book, backup.title));
        saveChat(ctx);

        toast(result.action === 'gone'
            ? `「${backup.title}」已经不在「${backup.book}」里了`
            : created
                ? `已从「${backup.book}」删掉「${backup.title}」`
                : `已把「${backup.title}」恢复到写入前`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

async function restoreDescAndReport() {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const backup = getDescBackup(ctx);

    if (!backup) {
        toast('还没有可恢复的上一版');
        refreshPanel(ctx);
        return;
    }

    const confirmed = await askConfirm(`角色描述会被改回 ${backup.before.length} 字的上一版，当前的描述会被覆盖。确定吗？`);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await restoreDescBackup(ctx);

        if (!result.ok) {
            if (result.error === 'NO_CHANGE') {
                toast('当前描述已经和上一版一致');
            } else if (result.error === 'PATCH_PENDING') {
                toast('还有一份待确认的描述改动，先处理它');
            } else {
                toast(result.hint ?? `恢复失败：${result.error}`);
            }
            return;
        }

        toast(`已恢复到上一版（${result.chars} 字）`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

/**
 * 把"已写入"的那份内容重新写回角色卡（见 renderPatchSection 的 drift 说明）。
 *
 * 覆盖前确认一次：这次会把角色卡上现在这一版盖掉，但会先存进「上一版」快照，
 * 所以点错了还能再恢复回来。
 */
async function rewriteDescAndReport() {
    if (patchBusy) {
        return;
    }

    const ctx = getContext();
    const patch = getPatch(ctx);
    if (!patch) {
        refreshPanel(ctx);
        return;
    }

    const current = diskDescription(ctx);
    const name = getActiveCharacter(ctx)?.name;
    const confirmed = await askConfirm(`「${name ?? '当前角色'}」的描述会被改回 ${patch.after.length} 字的那份内容，`
        + `现在的 ${current.length} 字会被覆盖（会先存进「上一版」快照，随时能恢复）。确定吗？`);
    if (!confirmed) {
        return;
    }

    patchBusy = true;
    setPanelBusy(true);

    try {
        const result = await rewriteAppliedDescription(ctx);

        if (!result.ok) {
            toast(result.error === 'NO_CHANGE'
                ? '角色卡上已经是这份内容，不用重写'
                : `写入失败：${result.hint ?? result.error}`);
            return;
        }

        const edited = result.editor?.synced === false && result.editor?.reason === 'edited';
        toast(edited
            ? `已重新写入${name ? `「${name}」的` : ''}角色卡；编辑框里你改过的内容没被覆盖，要同步点面板上的「刷新编辑框」`
            : `已重新写入${name ? `「${name}」的` : ''}角色卡（${patch.after.length} 字）`);
    } finally {
        patchBusy = false;
        setPanelBusy(false);
        refreshPanel(ctx);
    }
}

/**
 * 把已写入的内容推进角色编辑框，不管框里现在是什么。
 *
 * 只有用户点「刷新编辑框」才会走到这里 —— 这是"我知道会覆盖我刚才敲的字"的显式动作，
 * 所以不弹确认。写入路径自己遇到用户改过的框是不动的（见 applyDescriptionLocally），
 * 这个按钮就是给它留的出口：不关面板也能让框里看到新内容。
 */
function syncEditorAndReport() {
    const ctx = getContext();
    const patch = getPatch(ctx);

    if (!patch || patch.status !== PATCH_STATUS.APPLIED) {
        refreshPanel(ctx);
        return;
    }

    const result = refreshDescriptionEditor(getActiveCharacter(ctx), patch.after);

    if (!result.synced) {
        toast(result.reason === 'no-editor'
            ? '没找到角色描述的文本框：先把角色编辑面板打开'
            : '没能刷新编辑框');
        return;
    }

    toast(`编辑框已换成这次写入的内容（${patch.after.length} 字）`);
    refreshPanel(ctx);
}

async function askDiscardPatch() {
    return askConfirm('拒绝后这份改动就没了，角色描述保持原样。确定拒绝吗？');
}

/**
 * 确认弹窗。拿不到 callPopup 时按"确认"处理——
 * 按钮本身就是一次明确动作，卡在弹窗里反而像没反应。
 * @param {string} message
 * @returns {Promise<boolean>}
 */
async function askConfirm(message) {
    const ctx = getContext();

    try {
        if (typeof ctx.callPopup === 'function') {
            const choice = await ctx.callPopup(message, 'confirm');
            return choice === true || choice === 1;
        }
    } catch (err) {
        console.warn(`${LOG} 确认弹窗失败，按确认处理`, err);
    }

    return true;
}

function setPanelBusy(busy) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }
    panel.classList.toggle('thrive-panel--busy', busy);
    panel.setAttribute('aria-busy', String(busy));
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

/* -------------------------------------------------------------- 世界书选择器 */

/**
 * 填充可写书下拉。
 * 数据源用 ctx.getWorldInfoNames()（1.19 提供的副本），不碰内部变量 world_names。
 * @param {object} [ctx]
 */
async function refreshBookOptions(ctx = getContext()) {
    const select = document.getElementById('thrive_writable_book');
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

    select.innerHTML = '<option value="">（未选择 · 世界书功能不启用）</option>';

    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        // 提示放在选项文字里而不是 title 上：下拉列表里 title 根本看不到
        option.textContent = `${name}${annotations.get(name) ?? ''}`;
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
 *   角色自带书 —— 改动会随角色卡分发；
 *   与卡内嵌副本同名 —— 独立文件与卡里那份不会自动同步。
 */
function describeBookAnnotations(character) {
    const map = new Map();

    const bound = character?.data?.extensions?.world;
    if (typeof bound === 'string' && bound.trim()) {
        map.set(bound.trim(), '（角色自带 · 改动会随卡分发）');
    }

    const embedded = character?.data?.character_book?.name;
    if (typeof embedded === 'string' && embedded.trim() && !map.has(embedded.trim())) {
        map.set(embedded.trim(), '（疑似卡内嵌副本 · 不会自动同步）');
    }

    return map;
}

function bindLoreControls() {
    const bookSelect = document.getElementById('thrive_writable_book');
    if (bookSelect) {
        bookSelect.addEventListener('change', async function () {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const next = String(this.value ?? '');
            const previous = getWritableBook(settings);

            if (previous && next && previous !== next) {
                const confirmed = await askSwitchBook();
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

    const scopeSelect = document.getElementById('thrive_read_scope');
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

async function askSwitchBook() {
    return askConfirm('换书之后，新书里没有旧书的内容，角色不会记得它们。确定切换吗？');
}

function updateBookHint(ctx, settings) {
    const el = document.getElementById('thrive_book_hint');
    if (!el) {
        return;
    }

    const book = getWritableBook(settings);
    if (!book) {
        el.textContent = '没选书时世界书工具不注册，模型看不见它们。';
        el.classList.add('thrive-hint--warn');
        return;
    }

    const inactive = isBookScanned(ctx, book) === false;
    el.classList.toggle('thrive-hint--warn', inactive);

    const parts = [];
    if (inactive) {
        parts.push(`⚠ 这本书当前没有激活：ST 不会扫描它的条目，写进去也不会进入上下文。`
            + `请到「世界书」面板里勾选「${book}」。`);
    }
    parts.push('世界书工具只会写这一本。');

    const note = describeBookAnnotations(getActiveCharacter(ctx)).get(book);
    if (note) {
        parts.push(note);
    }

    el.textContent = parts.join(' ');
}

function updateScopeHint(ctx, settings) {
    const el = document.getElementById('thrive_scope_hint');
    if (!el) {
        return;
    }

    if (settings.readScope !== 'bound') {
        el.textContent = '只读可写书，最省 token。';
        return;
    }

    const character = getActiveCharacter(ctx);
    const bound = String(character?.data?.extensions?.world ?? '').trim();
    el.textContent = bound
        ? `会额外读「${bound}」，返回的每条都带 source_book。`
        : '当前角色没有绑定其他书，实际等同只看可写书。';
}

function bindBlockControls() {
    const select = document.getElementById('thrive_block_position');
    const textarea = document.getElementById('thrive_block_text');
    const reset = document.getElementById('thrive_block_reset');

    if (select) {
        select.addEventListener('change', function () {
            const ctx = getContext();
            ensureSettings(ctx).blockPosition = normalizePosition(this.value);
            ctx.saveSettingsDebounced?.();
            updateBlockHint(this.value);
            syncFromContext(ctx);
        });
    }

    if (textarea) {
        textarea.addEventListener('input', () => {
            const ctx = getContext();

            // 内存里立即生效：这样即使编辑后马上触发生成，拿到也是新文本
            ensureSettings(ctx).blockText = normalizeBlockText(textarea.value);
            updateBlockCount(textarea.value);

            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                ctx.saveSettingsDebounced?.();
                syncFromContext(ctx);
            }, SAVE_DELAY);
        });
    }

    if (reset) {
        reset.addEventListener('click', () => {
            const ctx = getContext();
            ensureSettings(ctx).blockText = '';
            ctx.saveSettingsDebounced?.();
            if (textarea) {
                textarea.value = DEFAULT_BLOCK;
                updateBlockCount(textarea.value);
            }
            syncFromContext(ctx);
            toast('学习块已恢复默认');
        });
    }
}

function updateBlockCount(text) {
    const el = document.getElementById('thrive_block_count');
    if (el) {
        el.textContent = `${countChars(text)} 字`;
    }
}

/**
 * 压缩指令编辑框。
 *
 * 与学习块不同的地方：它不进提示词，不用在防抖里 sync，只在输入时把值写进内存即可——
 * 超限提示是工具调用时现取的，晚一次落盘也不会拿到旧值。
 */
function bindCompactControls() {
    const textarea = document.getElementById('thrive_compact_prompt');
    const reset = document.getElementById('thrive_compact_reset');

    if (textarea) {
        textarea.addEventListener('input', () => {
            const ctx = getContext();

            ensureSettings(ctx).compactPrompt = normalizeCompactPrompt(textarea.value);
            updateCompactCount(textarea.value);

            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => ctx.saveSettingsDebounced?.(), SAVE_DELAY);
        });
    }

    if (reset) {
        reset.addEventListener('click', () => {
            const ctx = getContext();
            ensureSettings(ctx).compactPrompt = '';
            // 默认文本照旧存空串：版本更新换了默认文案时，点过恢复默认的人也能跟着更新
            ctx.saveSettingsDebounced?.();
            if (textarea) {
                textarea.value = DEFAULT_COMPACT_PROMPT;
                updateCompactCount(textarea.value);
            }
            toast('压缩指令已恢复默认');
        });
    }
}

/** 超过参考上限只提醒不截断：这是用户自己的提示词，截一半比超字更糟 */
function updateCompactCount(text) {
    const el = document.getElementById('thrive_compact_count');
    if (!el) {
        return;
    }

    const chars = countChars(text);
    el.textContent = `${chars} / ${COMPACT_PROMPT_LIMIT} 字`;
    el.classList.toggle('thrive-count--warn', chars > COMPACT_PROMPT_LIMIT);
}

function updateBlockHint(position) {
    const el = document.getElementById('thrive_block_hint');
    if (!el) {
        return;
    }

    const hint = getPositionHint(position);
    el.textContent = hint.text;
    el.classList.toggle('thrive-hint--warn', hint.level === 'warn');
    el.classList.toggle('thrive-hint--muted', hint.level !== 'warn');
}

/* ------------------------------------------------------------------ 徽章 */

/**
 * 挂载状态徽章。重复调用安全。
 */
export function initBadge() {
    const host = document.getElementById('leftSendForm');
    if (!host) {
        console.warn(`${LOG} 找不到 #leftSendForm，徽章未挂载`);
        return;
    }

    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
        host.insertAdjacentHTML('afterbegin', BADGE_HTML);
        badge = document.getElementById(BADGE_ID);
    }
    if (!badge) {
        console.warn(`${LOG} 徽章节点创建失败`);
        return;
    }

    badge.addEventListener('click', onBadgeClick);

    // 键盘操作挂在两段上：Enter / 空格都算一次点击
    badge.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        if (!event.target?.closest?.('[data-thrive-mode]')) {
            return;
        }
        event.preventDefault();
        onBadgeClick(event);
    });

    /*
     * 被动学习挂上 / 结算时，徽章要立刻跟着变，并且弹一条说明。
     *
     * 走事件而不是让 passive.js 直接调这里：触发发生在"发消息""收到回复"两个
     * 用户没在操作界面的时刻，如果只在评估完刷一次界面，徽章会停在旧状态，
     * 用户看不到"下一轮会临时学习"这件事——而这正是最需要提示的地方。
     */
    document.addEventListener(PASSIVE_EVENT, event => {
        const detail = event?.detail ?? {};
        refreshBadgeOnly(getContext());

        if (detail.fired) {
            const why = describePending({ reason: detail.reason, keyword: detail.keyword });
            toast(`被动学习已触发（${why}）：下一轮对话临时开启学习模式，回复结束后自动关闭`);
        }
    });
}

/**
 * 徽章点击：点了哪一段就切哪个。
 *
 * 两段管的东西不一样，所以守卫也分开：
 *   主动 —— 对话级开关，要求有对话、有可写模块、环境支持工具调用
 *   被动 —— 全局开关（判据在设置页里配），要求同上，另外没有对话就没有进度可谈
 *
 * 点在外壳留白上（不在任何一段里）时按「主动」处理：老用户早就习惯了"点徽章切开关"。
 *
 * @param {MouseEvent|KeyboardEvent} [event]
 */
function onBadgeClick(event) {
    const mode = event?.target?.closest?.('[data-thrive-mode]')?.dataset.thriveMode === 'passive'
        ? 'passive'
        : 'active';

    const ctx = getContext();
    const settings = ensureSettings(ctx);

    // 模块全关时开关没有意义：点了只说原因，不切换状态
    if (!hasAnyModule(settings)) {
        toast('两个模块都关着，请先在扩展设置里开启至少一个');
        return;
    }

    if (!isChatAvailable(ctx)) {
        toast('请先打开一个对话');
        return;
    }

    // 环境不支持工具调用时，开了也只是"徽章亮着、模型什么也看不到"。
    // 这里只报第一条没通过的原因，不替用户去改 ST 的设置（ADR-020）
    const diag = diagnoseEnvironment(ctx);
    if (!diag.ok) {
        toast(`工具调用不可用：${formatDiagnosis(diag)}`);
        return;
    }

    if (mode === 'passive') {
        togglePassive(ctx, settings);
        return;
    }

    // 切换只改变注入与 shouldRegister 的依据，不重载页面、不插消息
    setEnabled(ctx, !isEnabled(ctx));
    syncFromContext(ctx);
    refreshUI(ctx);
}

/**
 * 被动学习的总开关（全局设置，不按对话保存）。
 *
 * 关掉时把已经挂上的待学习一并丢掉：它本来就是被动学习攒出来的，
 * 留着会出现"被动显示关闭、徽章却在闪待学"这种自相矛盾的状态。
 */
function togglePassive(ctx, settings) {
    const next = settings.passiveEnabled !== true;
    settings.passiveEnabled = next;
    ctx.saveSettingsDebounced?.();

    if (!next) {
        getState(ctx).passive.pending = null;
        saveChat(ctx);
    }

    syncFromContext(ctx);
    refreshUI(ctx);

    if (!next) {
        toast('被动学习已关闭（主动开关不受影响）');
        return;
    }

    const hasRule = Number(settings.passiveInterval) > 0 || parseKeywords(settings.passiveKeywords).length > 0;
    toast(hasRule
        ? '被动学习已开启：命中判据后会在下一轮临时开启一次'
        : '被动学习已开启，但还没有判据（间隔 0 且关键词为空），不会触发。请到扩展设置里填一个');
}

/* ------------------------------------------------------------------ 面板入口 */

/**
 * 把记录面板摊开，给 `/thrive panel` 用。
 *
 * 没有内容时面板本来就是隐藏的，这时只回一句"没什么可看"，
 * 而不是弹出一个空壳——空壳会让人以为坏了。
 *
 * @param {object} [ctx]
 * @returns {boolean} 面板是否真的被打开
 */
export function openPanel(ctx = getContext()) {
    refreshPanel(ctx);

    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.classList.contains('displayNone')) {
        toast('现在没有待确认的改动，也没有写入记录');
        return false;
    }

    panelExpanded = true;
    refreshPanel(ctx);
    panel.scrollIntoView({ block: 'nearest' });
    return true;
}

/**
 * 一行状态摘要，给 `/thrive status` 用。
 *
 * 一眼要能看出四件事：开关、模块、可写书、待确认份数。
 * 环境不可用时补一句原因——否则用户会以为"都开着，为什么模型不理我"。
 *
 * @param {object} [ctx]
 */
export function describeStatus(ctx = getContext()) {
    const settings = ensureSettings(ctx);
    const modules = [];

    if (settings.moduleWorldbook !== false) {
        modules.push(getWritableBook(settings) ? '世界书' : '世界书（未选书）');
    }
    if (settings.moduleDescription !== false) {
        modules.push('角色描述');
    }

    const book = getWritableBook(settings);
    const bookText = !book
        ? '未选择'
        : isBookScanned(ctx, book) === false
            ? `${book}（未激活）`
            : book;

    const pending = isUnresolved(getPatch(ctx)) ? 1 : 0;
    const oneShot = getPending(ctx);
    const parts = [
        `主动：${isEnabled(ctx) ? '已开启' : '已关闭'}`,
        `被动：${describePassiveState(ctx, settings)}`,
        `模块：${modules.length > 0 ? modules.join(' + ') : '无可写模块'}`,
        `可写书：${bookText}`,
        `待确认：${pending} 份`,
    ];

    if (oneShot) {
        parts.push(`待学习：${describePending(oneShot)}（下一轮临时开启）`);
    }

    const diag = diagnoseEnvironment(ctx);
    if (!diag.ok) {
        parts.push(`工具不可用（${diag.reason}）`);
    }

    return parts.join(' · ');
}

/** 被动学习的一行摘要：开没开、用什么判据、还差几条 */
function describePassiveState(ctx, settings) {
    if (settings.passiveEnabled !== true) {
        return '已关闭';
    }

    const rules = [];
    const interval = Math.max(0, Math.floor(Number(settings.passiveInterval) || 0));
    if (interval > 0) {
        rules.push(`每 ${interval} 条`);
    }

    const keywords = parseKeywords(settings.passiveKeywords);
    if (keywords.length > 0) {
        rules.push(`关键词 ${keywords.length} 个`);
    }

    if (rules.length === 0) {
        return '已开启（未配判据）';
    }

    const progress = intervalProgress(ctx, settings);
    const tail = interval > 0 && isChatAvailable(ctx) ? `，还差 ${progress.remaining} 条` : '';
    return `已开启（${rules.join(' + ')}${tail}）`;
}

/* ------------------------------------------------------------------ 刷新 */

/**
 * 把当前对话的状态同步到徽章与面板。切换聊天后必须调用。
 * @param {object} [ctx]
 */
export function refreshUI(ctx = getContext()) {
    const settings = ensureSettings(ctx);

    // 没有可写模块时整个扩展无从谈起：对话里还开着就顺手关掉，
    // 否则徽章亮着"学习"、模型却一个工具都看不到。
    // 放在这里也兜住"手改 settings.json 把两个模块都关了"的情况。
    if (!hasAnyModule(settings) && isEnabled(ctx)) {
        setEnabled(ctx, false);
        syncFromContext(ctx);
        toast('两个模块都关着，学习模式已自动关闭');
    }

    // 被动学习的待学习同理：留着它只会在徽章上闪一个永远不会生效的「待学」
    if (!hasAnyModule(settings) && getPending(ctx)) {
        getState(ctx).passive.pending = null;
        saveChat(ctx);
    }

    const available = isChatAvailable(ctx);
    // 每次都现算：用户可能刚在 ST 面板里改了函数调用开关，缓存下来的结论会撒谎
    const diag = diagnoseEnvironment(ctx);

    refreshDiagnostics(ctx, diag);
    refreshBadge(ctx, settings, available, diag);
    refreshStatusText(ctx, settings, available);
    refreshPanelControls(ctx, settings);
    refreshPanel(ctx);

    // 换角色/换对话后，选项上的"角色自带/卡内嵌"标注会变，重新铺一遍
    void refreshBookOptions(ctx);
}

/**
 * 只刷徽章与"当前对话"那一行，不重建世界书下拉。
 *
 * 每发一条消息都要跑一次被动学习评估，评估完徽章得立刻变（否则"待学"要等到
 * 下次打开设置页才看见）。走 refreshUI 会顺带重建下拉列表，没必要。
 *
 * @param {object} [ctx]
 */
export function refreshBadgeOnly(ctx = getContext()) {
    const settings = ensureSettings(ctx);
    const available = isChatAvailable(ctx);
    const diag = diagnoseEnvironment(ctx);

    refreshBadge(ctx, settings, available, diag);
    refreshStatusText(ctx, settings, available);
    updatePassiveHint(ctx, settings);
}

/**
 * 设置页顶部的环境诊断。
 *
 * 只做两件事：给出结论、指出去哪改。不做分步引导（ADR-020 的延伸）。
 * @param {object} ctx
 * @param {{ ok: boolean, code: string, reason: string, fix: string }} [diag]
 */
function refreshDiagnostics(ctx, diag = diagnoseEnvironment(ctx)) {
    const box = document.getElementById('thrive_diag');
    const reason = document.getElementById('thrive_diag_reason');
    const fix = document.getElementById('thrive_diag_fix');

    if (!box || !reason || !fix) {
        return;
    }

    box.classList.toggle('thrive-diag--warn', !diag.ok);
    box.dataset.code = diag.code;
    box.title = diag.ok ? '' : formatDiagnosis(diag);

    reason.textContent = diag.ok ? '工具调用可用，模型能收到 Thrive 的工具。' : diag.reason;
    fix.textContent = diag.ok ? '' : diag.fix;
    fix.classList.toggle('displayNone', diag.ok || !diag.fix);
}

function refreshBadge(ctx, settings, available, diag) {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) {
        return;
    }

    const none = !hasAnyModule(settings);
    // 环境不支持时置灰：开关切过去也没有任何东西会生效
    const unsupported = !diag.ok;
    const usable = available && !none && !unsupported;

    const activeOn = isEnabled(ctx);
    const passiveOn = settings.passiveEnabled === true;
    const pending = getPending(ctx);
    // 徽章计数：待确认的改动只有 patch 一种，且同一时刻最多一份
    const patchPending = isUnresolved(getPatch(ctx)) ? 1 : 0;

    badge.classList.toggle('displayNone', !settings.showBadge);
    // 三种"不可用"共用同一档置灰：没有可写模块、没有对话、环境不支持工具调用
    badge.classList.toggle('thrive-badge--muted', !usable);
    badge.classList.toggle('thrive-badge--armed', Boolean(pending));
    badge.classList.toggle('thrive-badge--pending', patchPending > 0);

    updateSegment(badge, 'active', activeOn, false);
    // 待学只挂在被动那一段上：主动没有"等待"这个状态，开着就是在学
    updateSegment(badge, 'passive', passiveOn, Boolean(pending));

    const count = badge.querySelector('.thrive-badge__count');
    if (count) {
        count.textContent = patchPending > 0 ? String(patchPending) : '';
        count.classList.toggle('displayNone', patchPending === 0);
    }

    const lines = [];
    if (none) {
        lines.push('两个模块都关着，请先在扩展设置里开启至少一个');
    } else if (!available) {
        lines.push('请先打开一个对话');
    } else if (unsupported) {
        lines.push(`工具调用不可用：${formatDiagnosis(diag)}`);
    } else {
        lines.push(`主动学习：${activeOn ? '已开启（点击关闭）' : '已关闭（点击开启）'}`);
        lines.push(`被动学习：${passiveOn ? '已开启（点击关闭）' : '已关闭（点击开启）'}`);

        const progress = intervalProgress(ctx, settings);
        if (passiveOn && progress.interval > 0) {
            lines.push(`下次按条数触发还差 ${progress.remaining} 条（已累计 ${progress.since} / ${progress.interval}）`);
        }
        const keywords = parseKeywords(settings.passiveKeywords);
        if (passiveOn && keywords.length > 0) {
            lines.push(`关键词 ${keywords.length} 个：${keywords.slice(0, 4).join(' / ')}${keywords.length > 4 ? ' …' : ''}`);
        }
    }

    if (pending) {
        lines.push(`本次待学习：${describePending(pending)} —— 下一轮对话临时开启，回复后自动关闭`);
    }
    if (patchPending > 0) {
        lines.push(`有 ${patchPending} 份待确认的描述改动`);
    }

    badge.title = lines.join('\n');
    badge.setAttribute('aria-label', lines.join('；'));

    const activeSeg = badge.querySelector('[data-thrive-mode="active"]');
    if (activeSeg) {
        activeSeg.title = activeOn ? '主动学习：已开启，点击关闭' : '主动学习：已关闭，点击开启';
    }
    const passiveSeg = badge.querySelector('[data-thrive-mode="passive"]');
    if (passiveSeg) {
        passiveSeg.title = pending
            ? `被动学习：本轮已触发（${describePending(pending)}），下一轮对话临时开启`
            : passiveOn
                ? '被动学习：已开启，点击关闭'
                : '被动学习：已关闭，点击开启';
    }
}

/**
 * 更新一侧区段的显示。
 *
 * 文案只有两三个字，靠"有没有底色/有没有虚线/闪不闪"来区分状态本来就够呛，
 * 所以开启时多给一个字面上的信号：待学直接写成「待学」，比任何配色都直白。
 *
 * @param {HTMLElement} badge
 * @param {'active'|'passive'} mode
 * @param {boolean} on
 * @param {boolean} armed 这一次待学习是不是挂在它身上
 */
function updateSegment(badge, mode, on, armed) {
    const seg = badge.querySelector(`[data-thrive-mode="${mode}"]`);
    if (!seg) {
        return;
    }

    seg.classList.toggle('is-on', on);
    seg.classList.toggle('is-armed', armed);
    seg.setAttribute('aria-pressed', String(on || armed));

    const label = seg.querySelector('.thrive-badge__label');
    if (label) {
        const text = armed ? '待学' : (mode === 'active' ? '主动' : '被动');
        if (label.textContent !== text) {
            label.textContent = text;
        }
    }
}

function refreshStatusText(ctx, settings, available) {
    const status = document.getElementById('thrive_chat_status');
    if (!status) {
        return;
    }

    const none = !hasAnyModule(settings);
    if (none) {
        status.textContent = '无可写模块';
        status.classList.remove('thrive-status--on');
        return;
    }

    if (!available) {
        status.textContent = '未打开对话';
        status.classList.remove('thrive-status--on');
        return;
    }

    const active = isEnabled(ctx);
    const passive = settings.passiveEnabled === true;
    const pending = getPending(ctx);

    status.textContent = [
        `主动${active ? '开' : '关'}`,
        `被动${passive ? '开' : '关'}`,
        pending ? '待学' : '',
    ].filter(Boolean).join(' · ');

    status.classList.toggle('thrive-status--on', active || Boolean(pending));
}

function refreshPanelControls(ctx, settings) {
    syncCheckbox('thrive_enabled_by_default', settings.enabledByDefault);
    syncCheckbox('thrive_show_badge', settings.showBadge);
    syncCheckbox('thrive_passive_enabled', settings.passiveEnabled);
    syncCheckbox('thrive_module_worldbook', settings.moduleWorldbook);
    syncCheckbox('thrive_module_description', settings.moduleDescription);
    syncCheckbox('thrive_patch_enabled', settings.patchEnabled);
    syncCheckbox('thrive_drop_traces', settings.dropTraces);
    syncPanelLayoutControls(settings);
    syncLimitControls(settings);
    updateModuleHints(ctx, settings);
    updatePassiveControls(ctx, settings);
    updatePatchHint(ctx, settings);
    updateTraceHint(settings);

    const scopeSelect = document.getElementById('thrive_read_scope');
    const scope = settings.readScope === 'bound' ? 'bound' : 'writable';
    if (scopeSelect && scopeSelect.value !== scope) {
        scopeSelect.value = scope;
    }
    updateBookHint(ctx, settings);
    updateScopeHint(ctx, settings);

    const position = normalizePosition(settings.blockPosition);
    const select = document.getElementById('thrive_block_position');
    if (select && select.value !== position) {
        select.value = position;
    }
    updateBlockHint(position);

    // 正在输入时不要回写，否则会把光标和未落盘的编辑冲掉
    const textarea = document.getElementById('thrive_block_text');
    if (textarea && document.activeElement !== textarea) {
        const text = getBlockText(settings);
        if (textarea.value !== text) {
            textarea.value = text;
        }
        updateBlockCount(text);
    }

    const compactArea = document.getElementById('thrive_compact_prompt');
    if (compactArea && document.activeElement !== compactArea) {
        const text = getCompactPrompt(settings);
        if (compactArea.value !== text) {
            compactArea.value = text;
        }
        updateCompactCount(text);
    }
}

function syncCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el && el.checked !== Boolean(value)) {
        el.checked = Boolean(value);
    }
}
