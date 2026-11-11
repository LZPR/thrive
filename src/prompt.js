/**
 * prompt.js · 预设卡片与学习会话的预设
 *
 * 一条线：卡片（正文 + 角色 + 启用状态）按 settings.promptOrder 排成一次会话
 * 的预设，`buildPreset()` 产出 `{ role, text, ids }[]`，交给 session-preset.js
 * 展开宏、转成消息。
 *
 * 这里**不再往聊天请求里注入任何东西**（ADR-050）。学习发生在独立会话里，
 * 所以这里没有 extension prompt、没有头部/尾部分界、没有"这一轮生不生效"，
 * 只有"这份预设长什么样"。
 *
 * 五条约定：
 *   1. 每张卡 = 一条消息。不合并相邻同角色的卡：卡片是用户自己排的，
 *      合并之后"我把它放在这一条之后"就不再是它字面上的意思了。
 *   2. 目标内容卡的正文由运行时给：卡片里存的是那句描述（「以下是目标内容：」），
 *      真正的内容由 learning.js 拼上去。没有内容时这一整段不出现。
 *   3. 停用 = 不进预设，正文一个字不动；内置卡不能删，只能停用。
 *   4. 空串 = 用默认文本。默认文本随版本更新，老用户也能拿到新版。
 *   5. 宏不在这里展开：这里产出的是"用户写的样子"，session-preset.js 发请求前
 *      按顺序展开 `{{char}}` / `{{user}}` / `{{setvar::…}}`。
 */

import { CARD_ID, DEFAULT_PROMPT_ORDER, isBuiltinCard, normalizeOrder } from './prompt-order.js';
import { createId } from './util.js';

/** 与 ST 的 extension_prompt_roles 对应（会话里就是消息的 role） */
export const PROMPT_ROLE = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/* ------------------------------------------------------------------ 默认文本 */

/**
 * 默认会话规则。
 *
 * 写的是"这一场是什么、产出走哪里、写到哪、怎么写"，刻意不含任何动态内容
 * （条数、进度、触发原因），保证同一套规则在学习与压缩里都能用。
 */
export const DEFAULT_LEARNING_PROMPT = `【学习会话】

你在一场独立的学习会话里工作。这里的内容不会出现在聊天里，{{user}} 也看不到你在做什么。

产出方式：
· 只有工具会留下结果。把要记的东西用工具写进去，会话里的正文输出没人会看，可以完全不写。
· 没有值得长期保留的内容时，一个工具都不调用也没关系——这不算失败，也不必解释。
· 写之前先读：要改哪条就先把它读出来，工具会拒绝没读过就覆盖的写入。

写到哪里：
· 世界书 —— 客观的、大而重的：某个东西是什么样的，某件事该怎么做。
· 角色描述 —— 主观的、小而轻：{{char}} 喜欢什么、性格如何、怎么看 {{user}}。

怎么写：
· 角色描述要像原有人设文字一样自然，不要用列表、小标题或笔记痕迹。
· 用 {{char}} 和 {{user}} 指代角色，避免“你”“我”等代词。
· 拿不准的不要写。不要把目标内容里没有的东西补全成设定，也不要替它做推论。`;

/** 目标内容卡的描述行。内容会追加在它下面 */
export const DEFAULT_TARGET_PROMPT = '以下是目标内容：';

/** 学习会话的 User 消息：告诉模型这一次要它做什么 */
export const DEFAULT_LEARNING_MESSAGE = '请按上面的规则处理这些内容。有值得长期保留的就调用工具写进去；没有就什么也不用做。';

/** 压缩会话的 User 消息。压缩还没接线，这段先留着给同一条链路用 */
export const DEFAULT_COMPACT_MESSAGE = '请把这些内容压短：去掉重复和已经无关的细节，保留仍然需要记住的部分，然后用工具写回原来那一条。';

/**
 * 卡片元信息：界面按 id 取标签与说明，不在这里判断"能不能用"。
 * `editable` 指正文能不能改——目标内容的正文是运行时给的，只能改描述行。
 */
export const PROMPT_CARD_META = Object.freeze({
    [CARD_ID.LEARNING]: {
        label: '学习规则',
        hint: '会话里做什么、产出走哪里、写到哪、怎么写；学习与压缩共用这一份',
        editable: true,
    },
    [CARD_ID.TARGET]: {
        label: '目标内容',
        hint: '这一行是描述，正文由插件在发送前追加：学习 = 当前对话记录，压缩 = 超长条目',
        editable: true,
    },
});

/** 卡片 id → 设置键。自建卡不在表里（正文存在自己身上） */
const CARD_SETTING_KEY = Object.freeze({
    [CARD_ID.LEARNING]: 'learnPrompt',
    [CARD_ID.TARGET]: 'targetPrompt',
});

/** 卡片 id → 默认正文 */
const CARD_DEFAULT = Object.freeze({
    [CARD_ID.LEARNING]: DEFAULT_LEARNING_PROMPT,
    [CARD_ID.TARGET]: DEFAULT_TARGET_PROMPT,
});

/* ------------------------------------------------------------------ 自建提示词 */

/**
 * 当前的自建提示词表。只做形状过滤，不拷贝——界面拿到的就是设置里那个对象，
 * 改完直接落进设置，不需要再找一次下标。
 *
 * @param {object} settings
 * @returns {object[]}
 */
export function getCustomPrompts(settings) {
    const list = settings?.customPrompts;
    if (!Array.isArray(list)) {
        return [];
    }

    return list.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id);
}

/** 按 id 找一条自建提示词 */
export function findCustomPrompt(settings, id) {
    return getCustomPrompts(settings).find(item => item.id === id) ?? null;
}

/** 这个 id 是不是自建提示词 */
export function isCustomPrompt(settings, id) {
    return Boolean(findCustomPrompt(settings, id));
}

/**
 * 卡片显示名。自建卡用用户起的名字；内置卡用固定的中文标签。
 * @param {object} settings
 * @param {string} id
 */
export function getPromptName(settings, id) {
    const custom = findCustomPrompt(settings, id);
    if (custom) {
        return String(custom.name ?? '').trim() || '未命名提示词';
    }
    return PROMPT_CARD_META[id]?.label ?? id;
}

/**
 * 这条提示词发送时用的角色。
 *
 * 自建卡存在自己身上；内置卡存在 `promptRoles` 里，没写过就是系统。
 * @param {object} settings
 * @param {string} id
 * @returns {number} 0 系统 / 1 用户 / 2 助手
 */
export function getPromptRole(settings, id) {
    const custom = findCustomPrompt(settings, id);
    if (custom) {
        return custom.role === PROMPT_ROLE.USER || custom.role === PROMPT_ROLE.ASSISTANT
            ? custom.role
            : PROMPT_ROLE.SYSTEM;
    }

    const role = Number(settings?.promptRoles?.[id]);
    return role === PROMPT_ROLE.USER || role === PROMPT_ROLE.ASSISTANT ? role : PROMPT_ROLE.SYSTEM;
}

/**
 * 改一条提示词的角色。
 * @param {object} settings
 * @param {string} id
 * @param {number} role 0 / 1 / 2
 * @returns {boolean} 有没有这条提示词
 */
export function setPromptRole(settings, id, role) {
    const value = role === PROMPT_ROLE.USER || role === PROMPT_ROLE.ASSISTANT
        ? role
        : PROMPT_ROLE.SYSTEM;

    const custom = findCustomPrompt(settings, id);
    if (custom) {
        custom.role = value;
        return true;
    }

    if (!isBuiltinCard(id)) {
        return false;
    }

    const map = { ...(settings.promptRoles ?? {}) };
    if (value === PROMPT_ROLE.SYSTEM) {
        delete map[id];
    } else {
        map[id] = value;
    }
    settings.promptRoles = map;
    return true;
}

/**
 * 这条提示词现在启用没有。
 *
 * 停用只影响预设，正文一个字都不动——用户把它关掉通常是因为"这一场不需要"，
 * 而不是"想把写的东西删了"。
 *
 * @param {object} settings
 * @param {string} id
 */
export function isPromptEnabled(settings, id) {
    const custom = findCustomPrompt(settings, id);
    if (custom) {
        return custom.enabled !== false;
    }

    const disabled = Array.isArray(settings?.disabledCards) ? settings.disabledCards : [];
    return !disabled.includes(id);
}

/**
 * 启用 / 停用一条提示词。
 * @param {object} settings
 * @param {string} id
 * @param {boolean} enabled
 * @returns {boolean} 有没有这条提示词
 */
export function setPromptEnabled(settings, id, enabled) {
    const custom = findCustomPrompt(settings, id);
    if (custom) {
        custom.enabled = Boolean(enabled);
        return true;
    }

    if (!isBuiltinCard(id)) {
        return false;
    }

    const current = Array.isArray(settings.disabledCards) ? settings.disabledCards : [];
    const next = new Set(current);
    if (enabled) {
        next.delete(id);
    } else {
        next.add(id);
    }
    settings.disabledCards = [...next];
    return true;
}

/**
 * 改一条提示词的正文。
 *
 * 自建卡原样存（空白也算内容，用户可以先把框空着）；内置卡走 normalizeCardText，
 * 等于默认文本或全空白时存空串，这样版本更新后默认文案还能跟上。
 *
 * @param {object} settings
 * @param {string} id
 * @param {string} text
 * @returns {boolean} 有没有这条提示词
 */
export function setPromptText(settings, id, text) {
    const custom = findCustomPrompt(settings, id);
    if (custom) {
        custom.content = String(text ?? '');
        return true;
    }

    const key = CARD_SETTING_KEY[id];
    if (!key) {
        return false;
    }

    settings[key] = normalizeCardText(text, id);
    return true;
}

/** 内置卡恢复默认：存空串，读取时自然回落到 DEFAULT_* */
export function resetPromptText(settings, id) {
    const key = CARD_SETTING_KEY[id];
    if (!key) {
        return false;
    }

    settings[key] = '';
    return true;
}

/**
 * 新建一条自建提示词，插在目标内容之前（也就是列表末尾附近）。
 *
 * @param {object} settings
 * @param {{ name?: string, content?: string, role?: number }} [init]
 * @returns {object} 新建的那条
 */
export function addCustomPrompt(settings, init = {}) {
    const custom = {
        id: createId('cp'),
        name: String(init.name ?? '').trim() || nextPromptName(settings),
        content: typeof init.content === 'string' ? init.content : '',
        role: init.role === PROMPT_ROLE.USER || init.role === PROMPT_ROLE.ASSISTANT
            ? init.role
            : PROMPT_ROLE.SYSTEM,
        enabled: true,
    };

    const order = getPromptOrder(settings);
    settings.customPrompts = [...getCustomPrompts(settings), custom];

    const targetAt = order.indexOf(CARD_ID.TARGET);
    order.splice(targetAt >= 0 ? targetAt : order.length, 0, custom.id);
    settings.promptOrder = order;

    return custom;
}

/** 新提示词的默认名字：取第一个没被占用的序号 */
function nextPromptName(settings) {
    const names = new Set(getCustomPrompts(settings).map(item => String(item.name ?? '')));
    for (let i = 1; i < 1000; i++) {
        const name = `新提示词 ${i}`;
        if (!names.has(name)) {
            return name;
        }
    }
    return '新提示词';
}

/**
 * 删掉一条自建提示词。内置卡不能删（它们对应会话的必需部分），只能停用。
 * @param {object} settings
 * @param {string} id
 * @returns {boolean} 真的删掉了没有
 */
export function deleteCustomPrompt(settings, id) {
    if (!findCustomPrompt(settings, id)) {
        return false;
    }

    settings.customPrompts = getCustomPrompts(settings).filter(item => item.id !== id);
    settings.promptOrder = getPromptOrder(settings).filter(item => item !== id);
    return true;
}

/* ------------------------------------------------------------------ 文本取值 */

/**
 * 某段内置文本实际生效的内容。空 = 用默认。
 * @param {object} settings
 * @param {string} key learnPrompt / targetPrompt
 * @param {string} fallback
 */
function readText(settings, key, fallback) {
    const text = typeof settings?.[key] === 'string' ? settings[key] : '';
    return text.trim() ? text : fallback;
}

/** 会话规则实际生效的文本 */
export function getLearningPrompt(settings) {
    return readText(settings, 'learnPrompt', DEFAULT_LEARNING_PROMPT);
}

/** 目标内容描述行实际生效的文本 */
export function getTargetPrompt(settings) {
    return readText(settings, 'targetPrompt', DEFAULT_TARGET_PROMPT);
}

/**
 * 会话开场白。两种任务各一段，设置键不同、默认文本不同，读法与卡片一致：
 * 空 = 用默认，这样默认文案随版本更新时老用户也能拿到新版。
 *
 * `kind` 是任务名，不是卡片 id——它不出现在 promptOrder 里，因为它不是"预设里的
 * 一段"，而是"这一场会话的第一条 User 消息"（见 learning.js 的 runSession 调用）。
 */
const SESSION_MESSAGE = Object.freeze({
    learn: {
        key: 'learningUserMessage',
        fallback: DEFAULT_LEARNING_MESSAGE,
        label: '学习',
        hint: '触发学习后，这段作为那一场会话的第一条 User 消息发出，说清这一次要做什么',
    },
    compact: {
        key: 'compactUserMessage',
        fallback: DEFAULT_COMPACT_MESSAGE,
        label: '压缩',
        hint: '压缩还没接线。将来它用同一套框架，这段就是压缩会话的第一条 User 消息',
    },
});

/** 有哪几种开场白，界面的渲染顺序就用这个 */
export const SESSION_MESSAGE_KINDS = Object.freeze(['learn', 'compact']);

/**
 * 某种开场白的元信息（标签、说明）。不认识的任务返回 null。
 * @param {string} kind learn / compact
 */
export function getSessionMessageMeta(kind) {
    return SESSION_MESSAGE[kind] ?? null;
}

/**
 * 某种开场白实际生效的文本。
 * @param {object} settings
 * @param {string} kind
 */
export function getSessionMessage(settings, kind) {
    const meta = SESSION_MESSAGE[kind];
    return meta ? readText(settings, meta.key, meta.fallback) : '';
}

/** 默认文本（编辑器里「恢复默认」用） */
export function getSessionMessageDefault(kind) {
    return SESSION_MESSAGE[kind]?.fallback ?? '';
}

/**
 * 写回开场白。等于默认文本或全空白时存空串——和卡片同一套归一化。
 * @param {object} settings
 * @param {string} kind
 * @param {string} text
 * @returns {boolean} kind 认不认识
 */
export function setSessionMessage(settings, kind, text) {
    const meta = SESSION_MESSAGE[kind];
    if (!meta) {
        return false;
    }

    const fallback = String(meta.fallback ?? '');
    const value = String(text ?? '');
    settings[meta.key] = !value.trim() || value.trim() === fallback.trim() ? '' : value;
    return true;
}

/** 学习用的 User 消息 */
export function getLearningMessage(settings) {
    return getSessionMessage(settings, 'learn');
}

/** 压缩用的 User 消息 */
export function getCompactMessage(settings) {
    return getSessionMessage(settings, 'compact');
}

/**
 * 某张卡实际生效的文本。自建提示词不看启用状态——编辑器里要能看见停用的那条写了什么。
 * 目标内容卡只返回描述行，正文不在这里。
 *
 * @param {object} settings
 * @param {string} id CARD_ID 里的值，或自建提示词的 id
 */
export function getCardText(settings, id) {
    if (isCustomPrompt(settings, id)) {
        return String(findCustomPrompt(settings, id)?.content ?? '');
    }

    switch (id) {
        case CARD_ID.LEARNING:
            return getLearningPrompt(settings);
        case CARD_ID.TARGET:
            return getTargetPrompt(settings);
        default:
            return '';
    }
}

/**
 * 编辑框内容 → 存储值。等于该卡默认文本或全空白时存空串。
 * @param {string} text
 * @param {string} id
 */
export function normalizeCardText(text, id) {
    const fallback = CARD_DEFAULT[id] ?? '';
    const value = String(text ?? '');
    if (!value.trim() || value.trim() === fallback.trim()) {
        return '';
    }
    return value;
}

/** 卡片的设置键；自建卡没有 */
export function getCardSettingKey(id) {
    return CARD_SETTING_KEY[id] ?? '';
}

/* ------------------------------------------------------------------ 顺序 */

/**
 * 当前顺序表。空表 = 默认顺序（老用户升级后的情况）。
 * 自建提示词的 id 一起传进去，删掉的那条才不会永远留在顺序表里。
 * @param {object} settings
 * @returns {string[]}
 */
export function getPromptOrder(settings) {
    const extra = getCustomPrompts(settings).map(item => item.id);
    const stored = Array.isArray(settings?.promptOrder) ? settings.promptOrder : [];
    return stored.length ? normalizeOrder(stored, extra) : normalizeOrder(DEFAULT_PROMPT_ORDER, extra);
}

/* ------------------------------------------------------------------ 拼预设 */

/**
 * 卡片此刻的状态，只服务界面：一句话说明它会不会进预设、为什么。
 * @param {object} settings
 * @param {string} id
 * @returns {{ state: 'on'|'idle'|'content', note: string }}
 */
export function getCardState(settings, id) {
    if (!isPromptEnabled(settings, id)) {
        return { state: 'idle', note: '已停用：预设里没有这一段' };
    }

    if (id === CARD_ID.TARGET) {
        return { state: 'content', note: '正文在触发时追加（学习 = 当前对话记录）' };
    }

    if (isCustomPrompt(settings, id)) {
        return { state: 'on', note: '每次学习都带上' };
    }

    return { state: 'on', note: '每次学习都带上' };
}

/** 角色名，界面与状态小字共用 */
export function roleLabel(role) {
    if (role === PROMPT_ROLE.USER) {
        return '用户';
    }
    if (role === PROMPT_ROLE.ASSISTANT) {
        return '助手';
    }
    return '系统';
}

/**
 * 把卡片拼成会话预设。
 *
 * 每张卡一条 run，按顺序排列；`target` 的内容追加在它自己的描述行后面。
 * 目标内容为空时整张卡跳过——只剩一句「以下是目标内容：」比不出现更糟。
 *
 * @param {object} settings
 * @param {{ target?: string }} [options] target = 这一场要处理的内容
 * @returns {{ order: string[], runs: { role: number, text: string, ids: string[] }[] }}
 */
export function buildPreset(settings, { target = '' } = {}) {
    const order = getPromptOrder(settings ?? {});
    const runs = [];

    for (const id of order) {
        if (!isPromptEnabled(settings, id)) {
            continue;
        }

        let text = '';

        if (id === CARD_ID.TARGET) {
            const body = String(target ?? '').trim();
            if (!body) {
                continue;
            }
            const head = String(getTargetPrompt(settings) ?? '').trim();
            text = head ? `${head}\n\n${body}` : body;
        } else {
            text = String(getCardText(settings, id) ?? '');
        }

        if (!text.trim()) {
            continue;
        }

        runs.push({ role: getPromptRole(settings, id), text, ids: [id] });
    }

    return { order, runs };
}

/** 字数统计口径：不计空白 */
export function countChars(text) {
    return String(text ?? '').replace(/\s/g, '').length;
}
