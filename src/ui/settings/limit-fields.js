/**
 * ui/settings/limit-fields.js · 「数值与上限」组的输入框
 *
 * 14 个数字全部走 LIMIT_FIELDS 这张表：加一项只改表与模板，绑定与回填不用动。
 *
 * min / max / step 也不写死在 HTML 里，绑定时从 LIMIT_SPECS 灌进去——范围只有一份
 * 定义，否则模板里改了一半、夹取逻辑还是老值，用户会看到"输入框允许填 5000、
 * 实际被夹到 2000"这种自相矛盾的界面。
 */

import { getContext } from '../../../../../../extensions.js';
import { requestCompressScan } from '../../compress.js';
import { LIMIT_SPECS, clampLimit, readLimits } from '../../limits.js';
import { ensureSettings } from '../../store.js';
import { toast } from '../shared.js';
import { openCompressPanel } from '../compress-panel.js';
import { byId, paintHint } from './common.js';

/** 设置页里的输入框 → limits.js 的键 */
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

/** 改这几个值会改变"哪些条目算超长"，要重算一次压缩面板的列表 */
const RESCAN_KEYS = new Set(['softLimitEntry', 'softLimitDesc', 'hardLimitEntry', 'hardLimitDesc']);

export function bindLimitControls() {
    for (const [id, key] of LIMIT_FIELDS) {
        const input = byId(id);
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

            if (RESCAN_KEYS.has(key)) {
                requestCompressScan(ctx, 150);
            }
        });
    }

    byId('thrive_limits_reset')?.addEventListener('click', () => {
        const ctx = getContext();
        const settings = ensureSettings(ctx);

        for (const [, key] of LIMIT_FIELDS) {
            settings[key] = LIMIT_SPECS[key].default;
        }

        ctx.saveSettingsDebounced?.();
        syncLimitControls(settings);
        toast('数值与上限已恢复默认');
    });

    bindCompressEntry();
}

/**
 * 设置页只剩一颗「压缩面板」按钮，放在「数值与上限」组的操作行里——软提醒与硬上限
 * 就在上面，入口跟着它们，上下文最近。
 *
 * 不做高亮、不做动效、不写条数：提醒的位置在浮动面板标题栏上，设置页不是常看的地方。
 * 改内容也只在压缩侧栏里做，设置页不该出现第二处能改正文的地方。
 */
function bindCompressEntry() {
    byId('thrive_compress_open')?.addEventListener('click', () => {
        if (!openCompressPanel(getContext())) {
            toast('压缩面板还没挂载，刷新页面再试');
        }
    });
}

export function syncLimitControls(settings) {
    for (const [id, key] of LIMIT_FIELDS) {
        const input = byId(id);
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
 * 一句"哪个值没按你填的算"。
 *
 * 输入框里的数字是用户的**意愿**，夹取逻辑给的是**结果**。正常情况下两者一致——
 * 因为 change 时输入框已经被改写成效值——所以这里只在"软提醒高于硬上限"时说话：
 * 那种情况下软提醒其实不生效，一条内容在被拒之前根本不会出现在压缩面板里。
 *
 * 不去自动改用户填的数字：改一个框同时动另一个框是最难理解的交互。
 */
function updateLimitHint(settings) {
    const limits = readLimits(settings);
    const parts = [];

    if (Number(settings.softLimitEntry) > limits.hardLimitEntry) {
        parts.push(`世界书条目的软提醒高于硬上限，按 ${limits.hardLimitEntry} 字算。`);
    }
    if (Number(settings.softLimitDesc) > limits.hardLimitDesc) {
        parts.push(`角色描述的软提醒高于硬上限，按 ${limits.hardLimitDesc} 字算。`);
    }

    paintHint('thrive_limits_hint', parts.join(' '), parts.length > 0);
}
