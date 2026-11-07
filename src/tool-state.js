/**
 * tool-state.js · 「这个工具此刻能不能用」的唯一判据
 *
 * 三处要问同一件事：工具注册（shouldRegister）、工具调用（action 守卫）、
 * 工具指令里的宏（`{{desc_append}}` / `{{!desc_append}}`）。三处各判一套，
 * 迟早出现"提示词说可用、调用却被拒"的分裂，所以判定收在这里。
 *
 * 两个概念要分开：
 *   exposed    这个工具的名字在不在请求里（模块开着、世界书还要选了可写书）
 *   available  exposed 且这一轮学习模式开着
 *
 * 常驻模式只影响 exposed 的"生命周期"（它不再随对话开关消失），不改变这套判定。
 * 工具指令的清单用 exposed && !available：只列"看得见但现在不能用"的那批，
 * 没注册的写进去只是噪音。
 *
 * 注意这里**不含** `toolsResident`：常驻只决定"工具定义要不要留在请求里"，
 * 不改变工具能不能用。常驻时不可用的工具照样注册，只是调用会被拒绝，
 * 同时由「工具指令」那段告诉模型别调。
 */

import { ensureSettings, isLearningActive } from './store.js';
import { getWritableBook } from './targets.js';
import { TOOL_NAMES } from './tool-names.js';

const DESC_TOOLS = new Set([
    TOOL_NAMES.DESC_READ,
    TOOL_NAMES.DESC_APPEND,
    TOOL_NAMES.DESC_REPLACE,
    TOOL_NAMES.DESC_REWRITE,
]);

const LORE_TOOLS = new Set([
    TOOL_NAMES.LORE_LIST,
    TOOL_NAMES.LORE_READ,
    TOOL_NAMES.LORE_ADD,
    TOOL_NAMES.LORE_APPEND,
    TOOL_NAMES.LORE_REPLACE,
    TOOL_NAMES.LORE_REWRITE,
]);

/** 工具属于哪一组：'desc' / 'lore' / ''（不认识） */
export function toolGroup(name) {
    const key = String(name ?? '');
    if (DESC_TOOLS.has(key)) {
        return 'desc';
    }
    if (LORE_TOOLS.has(key)) {
        return 'lore';
    }
    return '';
}

/**
 * 这个工具此刻**在不在请求里**。
 *
 * 只由结构性条件决定（模块开关、可写书），与"这一轮开没开学习模式"无关：
 * 常驻模式下它就是"工具定义还在不在 tools 数组里"。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {boolean}
 */
export function isToolExposed(ctx, name) {
    const group = toolGroup(name);
    if (!group) {
        return false;
    }

    const settings = ensureSettings(ctx);

    if (group === 'desc') {
        return settings.moduleDescription !== false;
    }

    return settings.moduleWorldbook !== false && Boolean(getWritableBook(settings));
}

/**
 * 不可用的原因代号。空串 = 可用。
 * @param {object} ctx
 * @param {string} name
 * @returns {''|'learning-off'|'module-off'|'no-book'|'unknown'}
 */
export function toolUnavailableReason(ctx, name) {
    const group = toolGroup(name);
    if (!group) {
        return 'unknown';
    }

    if (!isLearningActive(ctx)) {
        return 'learning-off';
    }

    const settings = ensureSettings(ctx);

    if (group === 'desc') {
        return settings.moduleDescription === false ? 'module-off' : '';
    }

    if (settings.moduleWorldbook === false) {
        return 'module-off';
    }

    return getWritableBook(settings) ? '' : 'no-book';
}

/** 这个工具此刻可用吗 */
export function isToolAvailable(ctx, name) {
    return toolUnavailableReason(ctx, name) === '';
}

/**
 * 「看得见、但现在不能用」的工具名——工具指令真正要列的那批。
 *
 * 没注册的工具（模块关着 / 没选可写书）不该出现在清单里：模型根本看不到它们，
 * 写进去只是噪音，还会让"不可用"这个词失去准头。
 *
 * @param {object} ctx
 * @returns {string[]}
 */
export function listUnavailableTools(ctx) {
    return Object.values(TOOL_NAMES)
        .filter(name => isToolExposed(ctx, name) && !isToolAvailable(ctx, name));
}
