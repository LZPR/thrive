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
 *      合并之后"我把它放在这一条之后"就不再是它字面上的意思了。唯一的例外是
 *      目标内容的描述行与注入位——后者本来就是前者的正文，挨着时并成一条。
 *   2. 目标内容拆成两行：描述行是用户能改能删的一句话，注入位没有正文，由运行时
 *      填真实内容（学习 = 当前对话记录）。没有内容时注入位不出现。
 *   3. 停用 = 不进预设，正文一个字不动。描述行还可以从列表里移除（正文留着，
 *      「默认顺序」能拿回来）；注入位两样都不行——它必须存在。
 *   4. 空串 = 用默认文本。默认文本随版本更新，老用户也能拿到新版。
 *   5. 宏不在这里展开：这里产出的是"用户写的样子"，session-preset.js 发请求前
 *      按顺序展开 `{{char}}` / `{{user}}` / `{{setvar::…}}`。
 */

import { CARD_ID, DEFAULT_PROMPT_ORDER, isBuiltinCard, isPinnedCard, normalizeOrder } from './prompt-order.js';
import { createId } from './util.js';

/** 与 ST 的 extension_prompt_roles 对应（会话里就是消息的 role） */
export const PROMPT_ROLE = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/* ------------------------------------------------------------------ 默认文本 */

/**
 * 通用规则：学习、压缩、将来别的任务都按这一套走。
 *
 * 它不再是列表里的一张卡，也不再是两段开场白里各抄一遍的正文（ADR-053）。
 * 它是「开场白」这一组的第一段，学什么、压什么都在它后面接本场指令——这样改一次
 * 规则，所有任务一起变。
 *
 * 写的是"这一场是什么、产出走哪里、写到哪、怎么写"，刻意不含任何动态内容
 * （条数、进度、触发原因），所以同一段文字在哪一种任务里都能用。
 */
export const DEFAULT_SESSION_RULES = `【独立会话】

你在一场独立的会话里工作。这里的内容不会出现在聊天里，{{user}} 也看不到你在做什么。

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

/**
 * 学习这一场的指令：接在通用规则后面，回答"这一次要你做什么"。
 *
 * 单独留一份是为了设置迁移与界面：规则上面一段、本场指令下面一段，两段各改各的。
 */
export const DEFAULT_LEARNING_TASK = '请按上面的规则处理这些内容。有值得长期保留的就调用工具写进去；没有就什么也不用做。';

/** 压缩这一场的指令。压缩还没接线，这段先留着给同一条链路用 */
export const DEFAULT_COMPACT_TASK = '请把这些内容压短：去掉重复和已经无关的细节，保留仍然需要记住的部分，然后用工具写回原来那一条。';

/** 目标内容描述行的默认文本。内容会追加在它下面 */
export const DEFAULT_TARGET_PROMPT = '以下是目标内容：';

/**
 * 卡片元信息：界面按 id 取标签与说明，不在这里判断"能不能用"。
 *
 * `editable` 指正文能不能改；`removable` 指能不能从列表里拿掉。注入位两样都不行
 * ——它没有正文，也不能不存在。
 */
export const PROMPT_CARD_META = Object.freeze({
    [CARD_ID.TARGET_DESC]: {
        label: '目标内容 · 描述',
        hint: '只决定注入内容前面那一句。可以改、可以停用，也可以整个删掉——删了注入的内容照样发送',
        editable: true,
        removable: true,
    },
    [CARD_ID.TARGET]: {
        label: '目标内容',
        hint: '运行时把真实内容填在这里：学习 = 当前对话记录，压缩 = 那条超长条目。没有正文，也不能改、不能停用、不能删',
        editable: false,
        removable: false,
    },
});

/** 卡片 id → 设置键。自建卡不在表里（正文存在自己身上） */
const CARD_SETTING_KEY = Object.freeze({
    [CARD_ID.TARGET_DESC]: 'targetPrompt',
});

/** 卡片 id → 默认正文 */
const CARD_DEFAULT = Object.freeze({
    [CARD_ID.TARGET_DESC]: DEFAULT_TARGET_PROMPT,
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
    // 注入位没有正文，也就没有"以谁的口吻发"这回事：它永远是系统消息，
    // 除非它并进上面那条描述行——那时候用的是描述行的角色。
    if (isPinnedCard(id)) {
        return PROMPT_ROLE.SYSTEM;
    }

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
    if (isPinnedCard(id)) {
        return false;
    }

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
    // 注入位不能停用：停掉它，这一场要处理的内容就无处可放，会话也就没有意义了
    if (isPinnedCard(id)) {
        return true;
    }

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
    if (isPinnedCard(id)) {
        return false;
    }

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

/**
 * 把一张卡从列表里拿掉——界面上的「删除」不论自建还是内置都走这里。
 *
 * 两种卡的"删"含义不同：
 *   · 自建提示词：整条删掉，正文一起没（`deleteCustomPrompt`）；
 *   · 可移除的内置卡（目标内容的描述行）：只从顺序表里去掉，正文留着。
 *     它本来就可以"不要这一句"，但用户可能只是想试试不带描述行——「默认顺序」
 *     能让它带着原来写的话回来，不必重打一遍。
 *
 * 注入位不能删：它不是"一段可写的文字"，是"这一场要看的东西"落脚的固定位置。
 *
 * @param {object} settings
 * @param {string} id
 * @returns {boolean} 真的移除了没有
 */
export function removePromptCard(settings, id) {
    if (isPinnedCard(id)) {
        return false;
    }

    if (isCustomPrompt(settings, id)) {
        return deleteCustomPrompt(settings, id);
    }

    if (!PROMPT_CARD_META[id]?.removable) {
        return false;
    }

    const order = getPromptOrder(settings);
    if (!order.includes(id)) {
        return false;
    }

    settings.promptOrder = order.filter(item => item !== id);
    return true;
}

/* ------------------------------------------------------------------ 文本取值 */

/**
 * 某段内置文本实际生效的内容。空 = 用默认。
 * @param {object} settings
 * @param {string} key targetPrompt / sessionRules / learningTask / compactTask
 * @param {string} fallback
 */
function readText(settings, key, fallback) {
    const text = typeof settings?.[key] === 'string' ? settings[key] : '';
    return text.trim() ? text : fallback;
}

/** 会话规则实际生效的文本 */
export function getSessionRules(settings) {
    return readText(settings, 'sessionRules', DEFAULT_SESSION_RULES);
}

/** 目标内容描述行实际生效的文本 */
export function getTargetPrompt(settings) {
    return readText(settings, 'targetPrompt', DEFAULT_TARGET_PROMPT);
}

/**
 * 会话开场白。一段共用的规则 + 每种任务一段自己的指令，读法与卡片一致：
 * 空 = 用默认，这样默认文案随版本更新时老用户也能拿到新版。
 *
 * `kind` 是任务名，不是卡片 id——它不出现在 promptOrder 里，因为它不是"预设里的
 * 一段"，而是"这一场会话的第一条 User 消息"（见 learning.js 的 runSession 调用）。
 */
const SESSION_MESSAGE = Object.freeze({
    rules: {
        key: 'sessionRules',
        fallback: DEFAULT_SESSION_RULES,
        label: '通用规则',
        hint: '学习、压缩以及以后别的任务都从这一段开始：这一场是什么、产出走哪里、写到哪、怎么写。'
            + '它是共用的一份，改一次所有任务一起变',
        shared: true,
    },
    learn: {
        key: 'learningTask',
        fallback: DEFAULT_LEARNING_TASK,
        label: '学习',
        hint: '接在上面那段规则后面，一起作为那一场学习会话的第一条 User 消息发出。'
            + '这里只写"这一次要它做什么"，规则不必重复',
    },
    compact: {
        key: 'compactTask',
        fallback: DEFAULT_COMPACT_TASK,
        label: '压缩',
        hint: '压缩还没接线。将来它用同一套框架，这就是压缩会话那条 User 消息的后半段',
    },
});

/** 有哪几段开场白，界面的渲染顺序就用这个：规则在最前，任务在后 */
export const SESSION_MESSAGE_KINDS = Object.freeze(['rules', 'learn', 'compact']);

/** 真正会发出去的那几段（规则是前缀，不单独发） */
export const SESSION_TASK_KINDS = Object.freeze(['learn', 'compact']);

/**
 * 某种开场白的元信息（标签、说明）。不认识的任务返回 null。
 * @param {string} kind rules / learn / compact
 */
export function getSessionMessageMeta(kind) {
    return SESSION_MESSAGE[kind] ?? null;
}

/**
 * 某一段实际生效的文本——只这一段，不含前面共用的规则。
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
 * 写回某一段。等于默认文本或全空白时存空串——和卡片同一套归一化。
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

/**
 * 拼出真正要发的那条消息：共用规则 + 本场指令。
 *
 * 规则就是规则，不因为这一场是学习还是压缩而变，所以拼接放在这里而不是让用户
 * 在每段里各抄一遍。两段都空掉时返回空串——那说明用户真的清空了开场白，
 * 由调用方决定要不要发。
 *
 * @param {object} settings
 * @param {string} kind learn / compact
 */
export function composeSessionMessage(settings, kind) {
    if (!SESSION_TASK_KINDS.includes(kind)) {
        return getSessionMessage(settings, kind);
    }

    const rules = getSessionRules(settings);
    const task = getSessionMessage(settings, kind);
    return [rules, task].map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n');
}

/** 学习用的 User 消息 */
export function getLearningMessage(settings) {
    return composeSessionMessage(settings, 'learn');
}

/** 压缩用的 User 消息 */
export function getCompactMessage(settings) {
    return composeSessionMessage(settings, 'compact');
}

/**
 * 把 v0.35 及更早那句"规则 + 指令写在一起"的开场白拆成两半（设置迁移用）。
 *
 * 老文本开头就是当时的通用规则原文，剥掉它就是这一场的指令；认不出开头说明
 * 用户整段改写过，那就整段当指令——规则那边仍是默认，两段接起来仍是完整的一段话。
 *
 * @param {string} text
 * @returns {{ rules: string, task: string }} rules 为空 = 没认出旧规则
 */
export function splitLegacySessionMessage(text) {
    const value = String(text ?? '').trim();
    const rules = DEFAULT_SESSION_RULES.trim();

    if (!value) {
        return { rules: '', task: '' };
    }

    if (value.startsWith(rules)) {
        return { rules: DEFAULT_SESSION_RULES, task: value.slice(rules.length).trim() };
    }

    return { rules: '', task: value };
}

/**
 * 某张卡实际生效的文本。自建提示词不看启用状态——编辑器里要能看见停用的那条写了什么。
 *
 * 注入位没有正文，永远返回空串：它的内容不在设置里，在触发那一刻的目标里。
 *
 * @param {object} settings
 * @param {string} id CARD_ID 里的值，或自建提示词的 id
 */
export function getCardText(settings, id) {
    if (isCustomPrompt(settings, id)) {
        return String(findCustomPrompt(settings, id)?.content ?? '');
    }

    switch (id) {
        case CARD_ID.TARGET_DESC:
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
    if (id === CARD_ID.TARGET) {
        return { state: 'content', note: '运行时填入真正的内容（学习 = 当前对话记录），没有正文可改' };
    }

    if (!isPromptEnabled(settings, id)) {
        return { state: 'idle', note: '已停用：预设里没有这一段' };
    }

    if (id === CARD_ID.TARGET_DESC) {
        return { state: 'on', note: '接在注入的内容前面；删掉也没有关系，内容照样发送' };
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
 * 一条线：从上到下每张卡一条消息，两条例外——
 *
 *   1. 注入位并进紧挨着它上面那条描述行。描述行本来就是"下面这些东西是……"的引子，
 *      拆成两条消息等于把同一句话打断。合并后角色用描述行的（用户把它设成 User
 *      就是想让模型读到一段"用户给的材料"）。
 *   2. 描述行被停用或已经被删掉时，注入位单独成一条 System 消息，内容一个字不少——
 *      删掉那句引子，不代表这一场不要看材料。
 *
 * 目标内容为空时整段跳过：只剩一句「以下是目标内容：」比不出现更糟。
 *
 * @param {object} settings
 * @param {{ target?: string }} [options] target = 这一场要处理的内容
 * @returns {{ order: string[], runs: { role: number, text: string, ids: string[] }[] }}
 */
export function buildPreset(settings, { target = '' } = {}) {
    const order = getPromptOrder(settings ?? {});
    const body = String(target ?? '').trim();
    const runs = [];

    for (const id of order) {        if (id === CARD_ID.TARGET) {
            if (!body) {
                continue;
            }

            const above = runs[runs.length - 1];
            if (above && above.ids.length === 1 && above.ids[0] === CARD_ID.TARGET_DESC) {
                above.text = `${above.text}\n\n${body}`;
                above.ids = [CARD_ID.TARGET_DESC, CARD_ID.TARGET];
            } else {
                runs.push({ role: PROMPT_ROLE.SYSTEM, text: body, ids: [id] });
            }
            continue;
        }

        if (!isPromptEnabled(settings, id)) {
            continue;
        }

        // 没有材料时描述行也不发：孤零零一句「以下是目标内容：」比不出现更糟
        if (id === CARD_ID.TARGET_DESC && !body) {
            continue;
        }

        const text = String(getCardText(settings, id) ?? '');
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
