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
import { TOOL_NAMES, isThriveTool } from './tool-names.js';

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
 * 这个工具此刻**注册了吗**——也就是它的定义在不在这次请求的 tools 数组里。
 *
 * 与 exposed 的区别只有一条：非常驻模式下，学习模式关着就不注册。
 * 注册门控（tools.js 的 shouldRegister）与设置页的「工具清单」都问这里，
 * 免得界面显示"能用"、实际压根没发给模型。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {boolean}
 */
export function isToolRegistered(ctx, name) {
    if (!isToolExposed(ctx, name)) {
        return false;
    }

    return ensureSettings(ctx).toolsResident === true || isLearningActive(ctx);
}

/** 没注册的原因：分得清"模块/书没配好"和"这一轮没开常驻也没开学习" */
function notRegisteredReason(ctx, name) {
    const settings = ensureSettings(ctx);

    if (toolGroup(name) === 'lore' && settings.moduleWorldbook !== false && !getWritableBook(settings)) {
        return 'no-book';
    }

    if (!isToolExposed(ctx, name)) {
        return 'module-off';
    }

    return 'resident-off';
}

/**
 * 设置页「工具清单」一行要显示的状态。
 *
 * state：
 *   on   这一轮能用（注册 + 学习模式开着）
 *   off  注册了但调用会被拒（常驻开着，但学习模式没开）
 *   idle 这一轮压根没进请求（模块关 / 没选书 / 非常驻又没开学习）
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {{ state: 'on'|'off'|'idle', reason: string }}
 */
export function toolDisplayState(ctx, name) {
    if (!isToolRegistered(ctx, name)) {
        return { state: 'idle', reason: notRegisteredReason(ctx, name) };
    }

    return isToolAvailable(ctx, name)
        ? { state: 'on', reason: '' }
        : { state: 'off', reason: 'learning-off' };
}

/**
 * 工具清单的数据源：以 ST 自己的注册表为准（ToolManager.tools），
 * 名字、描述、参数都取"真正发给模型的那份"，不在这里再抄一遍。
 *
 * 注册表里没有的（比如工具还没注册）也补一行空壳，保证清单永远是完整的十行。
 *
 * @param {object} ctx
 * @returns {Array<{name: string, label: string, description: string, parameters: string[], group: string, state: string, reason: string}>}
 */
export function listToolInfo(ctx) {
    const registry = new Map();

    for (const def of ctx?.ToolManager?.tools ?? []) {
        let fn = null;
        try {
            fn = def?.toFunctionOpenAI?.()?.function ?? null;
        } catch {
            fn = null;
        }

        const name = String(fn?.name ?? '');
        if (!name || !isThriveTool(name)) {
            continue;
        }

        registry.set(name, {
            name,
            label: String(def.displayName || name),
            description: String(fn.description ?? ''),
            parameters: Object.keys(fn.parameters?.properties ?? {}),
        });
    }

    return Object.values(TOOL_NAMES).map(name => {
        const info = registry.get(name) ?? { name, label: name, description: '', parameters: [] };
        return { ...info, group: toolGroup(name), ...toolDisplayState(ctx, name) };
    });
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
