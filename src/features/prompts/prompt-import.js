/**
 * prompt-import.js · 有损导入 SillyTavern 预设
 *
 * 只做一件事：把 ST 预设 JSON 里的 `prompts` / `prompt_order` 翻译成 Thrive 的
 * 自建提示词表。**有损**是明确的选择——我们的预设只有"按顺序排好的一列消息"，
 * 比 ST 的预设系统小得多，硬要一一对应只会造出一堆假装支持、实际不生效的字段。
 *
 * 保留：
 *   · 正文（一字不改，宏原样留着，发请求前由 session-preset.js 展开）
 *   · 角色（system / user / assistant → 0 / 1 / 2）
 *   · 启用状态（优先 prompt_order 里那一条，其次 prompt.enabled）
 *   · 顺序（按 prompt_order；不在表里的排到最后）
 *
 * 丢掉：
 *   · 标记块（worldInfoBefore / charDescription / chatHistory …）：它们不是文本，
 *     是 ST 拼提示词时的插槽，在这里没有任何东西可插——这正是"无法导入的部分"
 *   · 触发器（injection_trigger）：导入后没有按时段触发的概念，启用即总是带上
 *   · 注入位置与深度：新架构里预设就是一列消息，没有系统区 / 尾部之分
 *   · 采样参数、正则、脚本、世界书绑定等预设里的其它所有东西
 *
 * 顺序怎么排：导入卡按 ST 的顺序在前，目标内容开始标记、注入位、结束标记组成末尾区块。
 */

import { CARD_ID } from './prompt-order.js';
import { createId } from '../../shared/util.js';

/** ST 的角色名 → extension_prompt_roles */
const ROLE_BY_NAME = Object.freeze({
    system: 0,
    user: 1,
    assistant: 2,
});

/** 全局顺序表用的 character_id（ST 的 PromptManager.configuration.promptOrder.dummyId） */
const GLOBAL_ORDER_ID = 100000;

/** 导入后保留的目标内容区块 */
const TARGET_CARDS = Object.freeze([CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END]);

/**
 * 挑一份顺序表。
 *
 * 预设里可能有多份（按角色分开）。优先全局那份（100000）；没有就取条目最多的那份。
 * 不合并多份：同一个 identifier 在不同角色下开关不同，合并出来的状态谁也不像。
 *
 * @param {unknown} raw
 * @returns {{ identifier: string, enabled?: boolean }[]}
 */
function pickPromptOrder(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const lists = raw.filter(item => item && Array.isArray(item.order));
    if (!lists.length) {
        return [];
    }

    const global = lists.find(item => String(item.character_id) === String(GLOBAL_ORDER_ID));
    if (global) {
        return global.order.filter(entry => entry && typeof entry.identifier === 'string');
    }

    const longest = lists.reduce((best, item) => (item.order.length > best.order.length ? item : best), lists[0]);
    return longest.order.filter(entry => entry && typeof entry.identifier === 'string');
}

/** 把 prompt_order 摊成 identifier → enabled；没写 enabled 的条目按"没提到"处理 */
function toEnabledMap(order) {
    const map = new Map();
    for (const entry of order) {
        if (typeof entry.enabled === 'boolean') {
            map.set(entry.identifier, entry.enabled);
        }
    }
    return map;
}

/**
 * 解析一份预设。
 *
 * 入参可以是 JSON 文本、解析好的对象，或者直接是一个 prompts 数组。
 * 永远返回结构化的结果，不抛异常——文件是用户挑的，坏文件要说人话。
 *
 * @param {string|object|object[]} raw
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   prompts?: object[],
 *   counts?: object,
 * }}
 */
export function parseStPreset(raw) {
    let data = raw;

    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return { ok: false, error: 'NOT_JSON' };
        }
    }

    if (!data || typeof data !== 'object') {
        return { ok: false, error: 'NOT_A_PRESET' };
    }

    const source = Array.isArray(data) ? data : data.prompts;
    if (!Array.isArray(source)) {
        return { ok: false, error: 'NO_PROMPTS' };
    }

    const order = Array.isArray(data) ? [] : pickPromptOrder(data.prompt_order);
    const enabledMap = toEnabledMap(order);
    const orderIndex = new Map(order.map((entry, index) => [entry.identifier, index]));

    const counts = {
        total: source.length,
        imported: 0,
        marker: 0,
        empty: 0,
        duplicate: 0,
        enabled: 0,
        disabled: 0,
        triggered: 0,
        core: 0,
    };

    const prompts = [];
    const seen = new Set();

    for (const item of source) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        // 标记块：世界书 / 角色卡 / 聊天记录这些"插槽"，没有正文可导
        if (item.marker === true) {
            counts.marker++;
            continue;
        }

        const identifier = typeof item.identifier === 'string' ? item.identifier : '';
        const name = String(item.name ?? identifier).trim() || identifier || '未命名提示词';
        const content = typeof item.content === 'string' ? item.content : '';

        if (!content.trim()) {
            counts.empty++;
            continue;
        }

        // identifier 是 ST 里的唯一键；没有它就退到"名字 + 正文"，同一份预设里极少重复
        const key = identifier || `${name}\u0000${content}`;
        if (seen.has(key)) {
            counts.duplicate++;
            continue;
        }
        seen.add(key);

        const role = ROLE_BY_NAME[String(item.role ?? '').toLowerCase()] ?? 0;

        // 优先用 prompt_order 里的开关（那才是用户在预设面板里看到的），其次看条目自带的
        const enabled = enabledMap.has(identifier)
            ? enabledMap.get(identifier)
            : item.enabled !== false;

        const triggered = Array.isArray(item.injection_trigger) && item.injection_trigger.length > 0;
        if (triggered) {
            counts.triggered++;
        }

        // ST 自带的核心系统提示词：导入后很可能与当前预设重复，单独统计出来提一句
        if (item.system_prompt === true) {
            counts.core++;
        }

        prompts.push({
            name,
            content,
            role,
            enabled,
            // 只用来排序，不落到设置里：orderIndex 缺失的排到最后
            at: orderIndex.has(identifier) ? orderIndex.get(identifier) : Number.POSITIVE_INFINITY,
        });
        counts.imported++;
        counts[enabled ? 'enabled' : 'disabled']++;
    }

    if (prompts.length === 0) {
        return { ok: false, error: 'NOTHING_TO_IMPORT', counts };
    }

    // 按 ST 里的顺序摆好：用户在自己预设面板里看到的就是这个次序
    prompts.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));

    return { ok: true, prompts, counts };
}

/**
 * 把解析结果写进设置。
 *
 * 顺序表：`[导入的条目…] [开始标记] [注入位] [结束标记]`
 * 内置卡一律恢复启用、角色回到系统；导入不该覆盖用户的边界标记设置。
 * 原有的自建提示词会被整批替换——只保留一份预设，不做多份管理。
 *
 * @param {object} settings
 * @param {{ prompts: object[] }} parsed
 * @returns {{ prompts: object[] }}
 */
export function applyPresetImport(settings, parsed) {
    const list = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    const custom = [];

    for (const item of list) {
        custom.push({
            id: createId('cp'),
            name: String(item.name ?? '').trim() || '未命名提示词',
            content: typeof item.content === 'string' ? item.content : '',
            role: item.role === 1 || item.role === 2 ? item.role : 0,
            enabled: item.enabled !== false,
        });
    }

    settings.customPrompts = custom;
    settings.promptOrder = [
        ...custom.map(prompt => prompt.id),
        ...TARGET_CARDS,
    ];

    // 内置卡是必须的部分：导入之后一律启用、回到系统角色
    settings.disabledCards = [];
    settings.promptRoles = {};

    return { prompts: custom };
}

/** 导入失败的文案。界面只负责显示，不自己编。 */
export function importErrorMessage(code) {
    switch (code) {
        case 'NOT_JSON':
            return '这份文件不是合法的 JSON。';
        case 'NO_PROMPTS':
            return '这份 JSON 里没有 prompts 数组，看起来不是 SillyTavern 预设。';
        case 'NOTHING_TO_IMPORT':
            return '这份预设里没有可导入的正文——只有世界书、角色卡这类标记块。';
        case 'NOT_A_PRESET':
        default:
            return '读取失败：文件内容不是预设对象。';
    }
}
