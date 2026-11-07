/**
 * ui/settings.js · 扩展设置页（settings.html）
 *
 * 这里只有两种东西：
 *   - 绑定：控件的输入 → 写进 settings / settings.json
 *   - 回填：settings 的现状 → 控件的显示（refreshSettingsControls 及其下属 updateXxx）
 *
 * 聊天区那两个界面（浮动面板、徽章）不在这里，改它们不用碰这个文件。
 * 刷新编排在 ui/refresh.js —— 绑定里需要"改完立刻反映到各处"时调它的 refreshUI。
 */

import { getContext } from '../../../../../extensions.js';
import { copyText } from '../../../../../utils.js';
import { COMPACT_PROMPT_LIMIT } from '../compact.js';
import { diagnoseEnvironment, formatDiagnosis } from '../diagnostics.js';
import { LIMIT_SPECS, clampLimit, readLimits } from '../limits.js';
import { armManual, describePending, intervalProgress, parseKeywords } from '../passive.js';
import { getPatch, isUnresolved } from '../patch.js';
import {
    PROMPT_CARD_META,
    buildInjection,
    countChars,
    getCardSettingKey,
    getCardState,
    getCardText,
    getPromptOrder,
    normalizeCardText,
    syncFromContext,
} from '../prompt.js';
import { CARD_ID, DEFAULT_PROMPT_ORDER, normalizeOrder } from '../prompt-order.js';
import {
    DEFAULT_SETTINGS,
    ensureSettings,
    getPending,
    getState,
    hasAnyModule,
    isChatAvailable,
    saveChat,
} from '../store.js';
import { getActiveCharacter, getWritableBook, isBookScanned } from '../targets.js';
import { listToolInfo } from '../tool-state.js';
import { escapeHtml } from '../util.js';
import { applyPanelLayout } from './panel-layout.js';
import { refreshUI, registerSurfaces, setPanelOpen } from './refresh.js';
import { LOG, PANEL_ID, askConfirm, toast } from './shared.js';

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

let saveTimer = null;

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

    bindPromptControls();
    bindLoreControls();
    bindLimitControls();
    bindModuleControls();
    bindPassiveControls();
    bindPatchControls();
    bindTraceControls();
    bindPanelLayoutControls();
}

/* ------------------------------------------------------------------ 模块开关 */

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
            toast('还有一份待处理的描述改动：请先在浮动面板里写入或丢弃');
            setPanelOpen(true, ctx);
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

export function updatePatchHint(ctx, settings) {
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
        ? '当前有一份待处理的改动，在浮动面板的「待确认」里写入或丢弃。'
        : '模型的描述改动会先暂存成一份 diff，你点「写入角色卡」才落盘；暂存期间模型读到的是暂存版。';
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
    ['thrive_limit_max_matches', 'maxMatches'],
    ['thrive_limit_read_chars', 'maxReadChars'],
    ['thrive_limit_list_count', 'listLimit'],
    ['thrive_limit_entry_count', 'softEntryCount'],
    ['thrive_limit_pattern_chars', 'patternMaxChars'],
    ['thrive_limit_match_window', 'matchWindow'],
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
        `一次读 ${limits.maxMatches} 处命中、单条正文最多 ${limits.maxReadChars} 字`,
        `目录 ${limits.listLimit} 个标题`,
        `正则最长 ${limits.patternMaxChars} 字、命中前后 ${limits.matchWindow} 字`,
        `记录留 ${limits.loreBackupLimit} 条`,
    ];

    el.textContent = `当前生效：${parts.join('；')}。`
        + (entryClamped || descClamped
            ? ' 软提醒高于硬上限，已按硬上限计算；被拒之前不会再有单独的提醒。'
            : '');
    el.classList.toggle('thrive-hint--warn', entryClamped || descClamped);
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

/* ------------------------------------------------------------ 提示词卡片 */

/** 卡片状态 → 角标文案。`anchor` 是分界线，没有状态角标 */
const PROMPT_STATE_LABEL = Object.freeze({
    on: '生效中',
    idle: '未生效',
    cond: '条件触发',
});

/** jQuery UI 拖动期间不要重排 DOM：它正持有占位元素与 helper */
let promptDragging = false;

function bindPromptControls() {
    $('#thrive_tools_resident').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).toolsResident = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        // 工具注册表与工具卡片状态都跟着变
        refreshUI(ctx);
    });

    $('#thrive_prompt_inject').on('change', function () {
        const ctx = getContext();
        ensureSettings(ctx).promptInject = Boolean(this.checked);
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);
    });

    $('#thrive_prompt_order_reset').on('click', () => {
        const ctx = getContext();
        ensureSettings(ctx).promptOrder = DEFAULT_PROMPT_ORDER.slice();
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        refreshUI(ctx);
        toast('提示词顺序已恢复默认');
    });

    // 一张卡一个铅笔，用委托就够；分界线卡片没有铅笔
    $('#thrive_prompt_list').on('click', '.thrive-prompt-card__edit', function () {
        const id = this.closest('.thrive-prompt-card')?.dataset.card;
        void openPromptEditor(getContext(), id);
    });

    initPromptSortable();
    bindToolCatalog();
}

/**
 * 工具清单的复制。
 *
 * 单个宏用委托（十行二十个宏，逐个绑不划算）；两个"复制全部"按当前注册表拼，
 * 这样新增工具时不用改代码。
 */
function bindToolCatalog() {
    $('#thrive_tool_catalog_list').on('click', '.thrive-tool-macro', function () {
        void copyMacro(this.dataset.copy ?? '');
    });

    $('#thrive_tool_copy_all').on('click', () => {
        const names = listToolInfo(getContext()).map(item => `{{${item.name}}}`);
        void copyMacro(names.join(' '), `已复制 ${names.length} 个可用时宏`);
    });

    $('#thrive_tool_copy_all_neg').on('click', () => {
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
 * 拖动排序。用 ST 自带的 jQuery UI sortable（预设面板也是它），
 * 不额外引入依赖；拿不到就退化成不能拖，编辑与注入照常。
 */
function initPromptSortable() {
    const list = document.getElementById('thrive_prompt_list');
    const $ = globalThis.jQuery;

    if (!list || typeof $?.fn?.sortable !== 'function') {
        return;
    }

    // 手机上整卡拖动会和滚动打架，只认抓手；桌面整卡可拖，铅笔留给点击
    const mobile = Boolean(getContext()?.isMobile?.());

    $(list).sortable({
        items: '.thrive-prompt-card',
        handle: mobile ? '.thrive-prompt-card__grip' : null,
        cancel: '.thrive-prompt-card__edit',
        placeholder: 'thrive-prompt-placeholder',
        forcePlaceholderSize: true,
        axis: 'y',
        tolerance: 'pointer',
        delay: 30,
        start: () => {
            promptDragging = true;
        },
        stop: () => {
            promptDragging = false;
        },
        update: () => {
            const ctx = getContext();
            const settings = ensureSettings(ctx);
            const ids = Array.from(list.querySelectorAll('.thrive-prompt-card')).map(el => el.dataset.card);

            settings.promptOrder = normalizeOrder(ids);
            ctx.saveSettingsDebounced?.();
            syncFromContext(ctx);
            updatePromptCards(ctx, settings);
            updatePromptStats(ctx, settings);
        },
    });
}

/** 卡片骨架。只在列表为空时铺一次，之后靠 updatePromptCards 改状态与顺序 */
function renderPromptCards(settings) {
    const list = document.getElementById('thrive_prompt_list');
    if (!list || list.childElementCount) {
        return;
    }

    list.innerHTML = getPromptOrder(settings).map(id => {
        const meta = PROMPT_CARD_META[id];
        if (!meta) {
            return '';
        }

        const anchor = id === CARD_ID.ANCHOR;
        return `<div class="thrive-prompt-card${anchor ? ' thrive-prompt-card--anchor' : ''}" data-card="${id}" data-state="idle" title="${meta.hint}">
    <span class="thrive-prompt-card__grip fa-solid fa-grip-vertical" title="拖动调整位置与落点"></span>
    <div class="thrive-prompt-card__main">
        <span class="thrive-prompt-card__name">${meta.label}</span>
        <span class="thrive-prompt-card__note"></span>
    </div>
    ${anchor ? '' : '<span class="thrive-prompt-card__badge"></span>'}
    ${meta.editable
        ? '<span class="thrive-prompt-card__edit fa-solid fa-pen-to-square" role="button" title="编辑内容"></span>'
        : ''}
</div>`;
    }).join('');
}

/**
 * 回填卡片的状态、字数与顺序。
 *
 * 只改文字与 class，不重建 DOM：拖动中重建会把 jQuery UI 手里的元素抽掉，
 * 输入焦点也会丢。
 */
function updatePromptCards(ctx, settings) {
    const list = document.getElementById('thrive_prompt_list');
    if (!list) {
        return;
    }

    renderPromptCards(settings);

    const order = getPromptOrder(settings);
    const cards = new Map(
        Array.from(list.querySelectorAll('.thrive-prompt-card')).map(el => [el.dataset.card, el]),
    );

    const current = Array.from(list.children).map(el => el.dataset.card);
    if (!promptDragging && current.join(',') !== order.join(',')) {
        for (const id of order) {
            const el = cards.get(id);
            if (el) {
                list.appendChild(el);
            }
        }
    }

    for (const id of order) {
        const el = cards.get(id);
        const meta = PROMPT_CARD_META[id];
        if (!el || !meta) {
            continue;
        }

        const status = getCardState(ctx, settings, id);
        el.dataset.state = status.state;

        const note = el.querySelector('.thrive-prompt-card__note');
        if (note) {
            if (id === CARD_ID.ANCHOR) {
                note.textContent = meta.hint;
            } else {
                const chars = countChars(getCardText(settings, id));
                note.textContent = `${status.note} · ${chars} 字`;
            }
        }

        const badge = el.querySelector('.thrive-prompt-card__badge');
        if (badge) {
            badge.textContent = PROMPT_STATE_LABEL[status.state] ?? '';
        }
    }

    updateToolsResidentHint(settings);
}

/**
 * 「当前注入」那一行：把两段实际长度算出来。
 *
 * 卡片可以拖到分界线两侧，只看列表很难知道最终发出去多少字；这一行就是答案，
 * 也顺手说明宏替换前后的差别。
 */
function updatePromptStats(ctx, settings) {
    const el = document.getElementById('thrive_prompt_stats');
    if (!el) {
        return;
    }

    if (settings.promptInject === false) {
        el.textContent = '自动注入已关闭：插件不会改动提示词。';
        return;
    }

    const { head, tail, mode } = buildInjection(ctx, settings);
    const note = mode ? '' : '（学习模式未开启，只可能注入工具指令）';
    el.textContent = `当前注入：系统区 ${countChars(head)} 字 · 尾部 ${countChars(tail)} 字${note}`;
}

function updateToolsResidentHint(settings) {
    const el = document.getElementById('thrive_tools_resident_hint');
    if (!el) {
        return;
    }

    const resident = settings.toolsResident === true;
    el.textContent = resident
        ? '开：工具定义一直留在请求里，开关学习模式不再改变 tools 数组。不可用的工具由「工具指令」说明，调用会被直接拒绝。'
        : '关：关闭学习模式时工具会从请求里消失，tools 数组一变，前缀缓存就从工具定义处失效。';
    el.classList.toggle('thrive-hint--muted', !resident);
}

/**
 * 工具清单（折叠块，只读）。
 *
 * 数据源是 ST 的注册表（ToolManager.tools），不是插件里另抄一份：
 * 这里显示的描述与参数就是实际发给模型的那份，改了 tools.js 不用同步改这里。
 * 状态与宏走 tool-state，与"能不能调、宏怎么展开"是同一个判据。
 */
function renderToolCatalog(ctx) {
    const list = document.getElementById('thrive_tool_catalog_list');
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

    const meta = document.getElementById('thrive_tool_catalog_meta');
    if (meta) {
        const available = items.filter(item => item.state === 'on').length;
        meta.textContent = `${items.length} 个 · 可用 ${available}`;
    }

    // 按钮上带个数：贴进提示词里就是这么多，不用自己数
    const all = document.getElementById('thrive_tool_copy_all_label');
    if (all) {
        all.textContent = `复制 {{x}} ×${items.length}`;
    }
    const neg = document.getElementById('thrive_tool_copy_all_neg_label');
    if (neg) {
        neg.textContent = `复制 {{!x}} ×${items.length}`;
    }
}

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

/**
 * 卡片内容编辑弹窗。
 *
 * 用 ST 的通用弹窗而不是自己搭一层：右上角那颗「全屏」是 ST 原生编辑器的按钮，
 * 挂了 `editor_maximize` 类就会走它自己的全屏逻辑，输入实时同步回这里的 textarea。
 *
 * 输入即写内存（防抖落盘），关掉弹窗再同步一次注入——和设置页里原来那些
 * textarea 的约定一致。
 */
async function openPromptEditor(ctx, id) {
    const meta = PROMPT_CARD_META[id];
    const key = getCardSettingKey(id);

    if (!meta || !meta.editable || !key) {
        return;
    }

    const settings = ensureSettings(ctx);
    const fieldId = 'thrive_prompt_editor_field';
    const isCompact = id === CARD_ID.COMPACT;

    if (typeof ctx.callGenericPopup !== 'function') {
        toast('当前 SillyTavern 没有提供编辑弹窗，无法编辑提示词');
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'thrive-prompt-editor';
    wrapper.innerHTML = `<div class="thrive-prompt-editor__head">
    <b>${meta.label}</b>
    <small>${meta.hint}</small>
</div>
<textarea id="${fieldId}" class="text_pole thrive-block-text" spellcheck="false"></textarea>
<div class="thrive-prompt-editor__foot">
    <span class="thrive-count"></span>
    <div class="thrive-prompt-editor__actions">
        <div class="menu_button thrive-reset" data-act="reset" title="用回内置的默认文本">
            <i class="fa-solid fa-rotate-left"></i>
            <span>恢复默认</span>
        </div>
        <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="${fieldId}"
            title="全屏编辑"></i>
    </div>
</div>`;

    const textarea = wrapper.querySelector('textarea');
    const counter = wrapper.querySelector('.thrive-count');

    const paintCount = () => {
        const chars = countChars(textarea.value);
        counter.textContent = isCompact
            ? `${chars} / ${COMPACT_PROMPT_LIMIT} 字`
            : `${chars} 字`;
        counter.classList.toggle('thrive-count--warn', isCompact && chars > COMPACT_PROMPT_LIMIT);
    };

    textarea.value = getCardText(settings, id);
    paintCount();

    textarea.addEventListener('input', () => {
        // 内存里立即生效：编辑完马上生成，拿到的也是新文本
        settings[key] = normalizeCardText(textarea.value, id);
        paintCount();

        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            ctx.saveSettingsDebounced?.();
            syncFromContext(ctx);
        }, SAVE_DELAY);
    });

    wrapper.querySelector('[data-act="reset"]').addEventListener('click', () => {
        // 默认文本照旧存空串：版本更新换了默认文案时，点过恢复默认的人也能跟着更新
        settings[key] = '';
        textarea.value = getCardText(settings, id);
        paintCount();
        ctx.saveSettingsDebounced?.();
        syncFromContext(ctx);
        toast(`${meta.label}已恢复默认`);
    });

    await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE?.TEXT ?? 1, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    ctx.saveSettingsDebounced?.();
    syncFromContext(ctx);
    const latest = ensureSettings(ctx);
    updatePromptCards(ctx, latest);
    updatePromptStats(ctx, latest);
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

function refreshSettingsControls(ctx, settings) {
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

    syncCheckbox('thrive_tools_resident', settings.toolsResident);
    syncCheckbox('thrive_prompt_inject', settings.promptInject);
    updatePromptCards(ctx, settings);
    updatePromptStats(ctx, settings);
    renderToolCatalog(ctx);
}

function syncCheckbox(id, value) {
    const el = document.getElementById(id);
    if (el && el.checked !== Boolean(value)) {
        el.checked = Boolean(value);
    }
}

/* 登记给刷新编排：设置页这几块都在本文件里，refresh.js 不反过来 import 这里 */
registerSurfaces({
    controls: ({ ctx, settings }) => refreshSettingsControls(ctx, settings),
    diagnostics: ({ ctx, diag }) => refreshDiagnostics(ctx, diag),
    passiveHint: ({ ctx, settings }) => updatePassiveHint(ctx, settings),
    books: ({ ctx }) => {
        void refreshBookOptions(ctx);
    },
});
