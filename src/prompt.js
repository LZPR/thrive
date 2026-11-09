/**
 * prompt.js · 提示词卡片、宏与注入
 *
 * 一条线：按 settings.promptOrder 把卡片拼成两段文本，塞进 ST 的扩展提示词。
 *
 *   卡片 ──> 分界线（其它提示词）上方 = 系统提示词区（IN_PROMPT）
 *                       下方 = 对话尾部（IN_CHAT depth 0）
 *
 * 参与注入的卡片有三类：
 *   内置卡  学习块[通用] / 学习块[主动模式] / 学习块[被动模式] / 工具指令
 *   自建卡  settings.customPrompts 里的任意条，各自带 Role（系统 / 用户 / 助手）
 *   条件卡  压缩指令不注入；工具指令"全都可用"时整段消失
 *
 * 五个反直觉点：
 *   1. ST 不会替尾部注入（IN_CHAT）做宏替换，头部（IN_PROMPT）路径又不一样，
 *      所以两段统一由这里先 substituteParams，保证表现一致。自建卡里常见的
 *      `{{setvar::x::…}}` / `{{getvar::x}}` 也就靠这一步生效——按列表顺序逐条展开，
 *      前一条 set 的变量后一条读得到。
 *   2. 关闭时不是"不设置"，而是显式写入空串：getExtensionPrompt 会过滤掉空 value，
 *      这样条目彻底不出现，请求体与没装插件时一致。
 *   3. 工具宏全部展开为空时整段不注入。默认的工具指令是"列出不可用的工具"，
 *      全都可用时它只剩一句没头没尾的引导语；与其让模型读一段废话，不如整段消失。
 *   4. 角色不同的提示词不能拼成同一段：ST 的一条扩展提示词只有一个 role。
 *      这里把**相邻且同角色**的卡合成一次注入（一"段"），角色一变就另起一段。
 *      段号补零写进 key（`thrive_head_000`…），ST 按 key 排序时顺序才不会乱。
 *   5. 同一组里空卡片（停用、不属于当前模式）直接跳过，不会把一段切成两段——
 *      "中间停用了一条"不该让前后两段分开成两条消息。
 *
 * 同一"段"里的卡片按顺序用空行拼起来（`\n\n`）。顺序是用户拖出来的，这里不再替它
 * 排序——通用段与模式段谁在后、谁更强势，交给用户按效果决定。
 */

import { getCompactPrompt, normalizeCompactPrompt } from './compact.js';
import {
    CARD_ID,
    DEFAULT_PROMPT_ORDER,
    isBuiltinCard,
    normalizeOrder,
    splitByAnchor,
} from './prompt-order.js';
import {
    ensureSettings,
    getLearningMode,
    getPending,
    LEARNING_MODE,
} from './store.js';
import { isThriveTool } from './tool-names.js';
import { isToolAvailable, isToolExposed, listUnavailableTools } from './tool-state.js';
import { createId } from './util.js';

/** 系统提示词区那一段的键名前缀；实际键名带段号：`thrive_head_000` */
export const HEAD_KEY = 'thrive_head';

/** 对话尾部那一段的键名前缀；实际键名带段号：`thrive_tail_000` */
export const TAIL_KEY = 'thrive_tail';

/** v0.19 及以前的单块键名；现在只用于清理旧条目 */
export const LEGACY_BLOCK_KEY = 'thrive_block';

/** 与 ST 的 extension_prompt_types 对应，避免为了三个常量去 import script.js */
const IN_PROMPT = 0;
const IN_CHAT = 1;

/** 与 ST 的 extension_prompt_roles 对应 */
export const PROMPT_ROLE = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/** 段号位数：补零之后 key 的字典序才和列表顺序一致（ST 会按 key 排序） */
const RUN_DIGITS = 3;

/** 段号 key：`thrive_head_000` / `thrive_tail_012` */
function runKey(side, index) {
    const prefix = side === 'head' ? HEAD_KEY : TAIL_KEY;
    return `${prefix}_${String(index).padStart(RUN_DIGITS, '0')}`;
}

/** 上一个版本留下的段号 key（包括改过段数的旧清单），同步时统一清掉 */
const RUN_KEY_RE = /^thrive_(?:head|tail)_\d+$/;

/* ------------------------------------------------------------------ 默认文本 */

/**
 * 默认通用段。**主动与被动都带这一份**，写的全是与"这轮学多少"无关的东西：
 * 工具层与正文层怎么分工、写到哪里、怎么写、守什么规矩。
 *
 * 刻意不含任何动态内容（条数、模块名、待办数），保证整场对话这段文本恒定。
 * 原则：点到为止，只给判断标准，不写"具体该怎么做"的例子——留余量给模型。
 */
export const DEFAULT_BLOCK_COMMON = `【学习模式】

你现在同时处在两个层面，互不干扰：
· 工具层：调用工具时冷静、精确，用陈述句描述事实。参数里不扮演角色、不写台词、不加情绪修饰。
· 正文层：所有回复仍以 {{char}} 的身份与口吻进行。不要提及本段、不要复述工具调用、不要说「我已经记住了」这类出戏的话。

将 {{user}} 说的话视为对设定的补充或修正，优先接受并落实。

写到哪里：
· 世界书 —— 客观的、大而重的：某个东西是什么样的，某件事该怎么做。
· 角色描述 —— 主观的、小而轻：{{char}} 喜欢什么、性格如何、怎么看 {{user}}。

怎么写：
· 角色描述要像原有人设文字一样自然，不要用列表、小标题或笔记痕迹。
· 用 {{char}} 和 {{user}} 指代角色，避免“你”“我”等代词。`;

/** 默认主动段：常开的那一种，倾向多问多记，宁可记小而不要漏 */
export const DEFAULT_BLOCK_ACTIVE = `【主动模式】
请像学生一样积极学习，主动追问并记录。`;

/**
 * 默认被动段：借来的一轮，倾向少动工具。
 * "只在这一轮有效"由 getOnceNotice() 按实际原因补，这里不写死，免得手动触发时说法不准。
 */
export const DEFAULT_BLOCK_PASSIVE = `【被动模式】
请记录过往内容中的关键部分，没有值得记忆的就正常继续。`;

/**
 * 默认工具指令。
 *
 * 工具常驻之后，模型在任何一轮都能看到全部工具定义；不能再靠"注册/不注册"表达可用性，
 * 只能靠这段文字。两种宏：
 *   {{name}}   工具可用 → 替换成工具名；不可用 → 空
 *   {{!name}}  工具不可用 → 替换成工具名；可用 → 空
 *
 * 默认用 `!` 那一半：只在有工具被关掉时才列出来。全部可用时所有宏展开为空，
 * 整段不注入（见 syncInjection 的 emptyByMacros 规则）。
 */
export const DEFAULT_TOOL_PROMPT = `【工具可用性】
这一轮里，下面这些工具不可使用，不要调用它们：
{{!desc_read}} {{!desc_append}} {{!desc_replace}} {{!desc_rewrite}} {{!lore_list}} {{!lore_read}} {{!lore_add}} {{!lore_append}} {{!lore_replace}} {{!lore_rewrite}}
调用不可用的工具会直接失败，白白浪费一次机会。只有没有列出来的工具才可以正常使用。`;

/**
 * 三段学习块的元信息：界面与设置读写都按这张表走，加一段只改这里。
 * `part` 同时是设置键的后缀（`blockCommon` / `blockActive` / `blockPassive`）。
 */
export const BLOCK_TEXT_PARTS = Object.freeze([
    {
        part: 'common',
        settingKey: 'blockCommon',
        defaultValue: DEFAULT_BLOCK_COMMON,
        label: '通用提示词',
    },
    {
        part: 'active',
        settingKey: 'blockActive',
        defaultValue: DEFAULT_BLOCK_ACTIVE,
        label: '主动模式提示词',
    },
    {
        part: 'passive',
        settingKey: 'blockPassive',
        defaultValue: DEFAULT_BLOCK_PASSIVE,
        label: '被动模式提示词',
    },
]);

const PART_BY_KEY = new Map(BLOCK_TEXT_PARTS.map(item => [item.part, item]));

/**
 * 卡片元信息：标签、说明、可编辑性。界面按 id 取，不在这里判断"能不能用"——
 * 那是 getCardState 的活。
 */
export const PROMPT_CARD_META = Object.freeze({
    [CARD_ID.TOOL]: {
        label: '工具指令',
        hint: '工具常驻时说明哪些工具不可用；支持 {{工具名}} 与 {{!工具名}} 宏',
        editable: true,
    },
    [CARD_ID.COMMON]: {
        label: '学习块[通用]',
        hint: '两种模式都带：工具层与正文层的分工、写到哪里、怎么写',
        editable: true,
    },
    [CARD_ID.ACTIVE]: {
        label: '学习块[主动模式]',
        hint: '只在主动模式那一轮带上',
        editable: true,
    },
    [CARD_ID.PASSIVE]: {
        label: '学习块[被动模式]',
        hint: '只在被动学习借来的那一轮带上',
        editable: true,
    },
    [CARD_ID.ANCHOR]: {
        label: '其它提示词',
        hint: '插件以外原本的提示词；上方进系统提示词区、下方进对话尾部，这张卡本身不注入',
        editable: false,
    },
    [CARD_ID.COMPACT]: {
        label: '压缩指令',
        hint: '压缩面板里「智能压缩」要用的提示词（这个功能还没接线）；不再附在工具返回里',
        editable: true,
    },
});

/** 卡片 id → 设置键。`anchor` 没有正文，不在表里 */
const CARD_SETTING_KEY = Object.freeze({
    [CARD_ID.TOOL]: 'toolPrompt',
    [CARD_ID.COMMON]: 'blockCommon',
    [CARD_ID.ACTIVE]: 'blockActive',
    [CARD_ID.PASSIVE]: 'blockPassive',
    [CARD_ID.COMPACT]: 'compactPrompt',
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

/**
 * 按 id 找一条自建提示词。
 * @param {object} settings
 * @param {string} id
 * @returns {object|null}
 */
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
 * 这条提示词注入时用的角色（ST 的 extension_prompt_roles）。
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

    if (!isBuiltinCard(id) || id === CARD_ID.ANCHOR) {
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
 * 停用只影响注入，正文一个字都不动——用户把它关掉通常是因为"这一场不需要"，
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

    if (!isBuiltinCard(id) || id === CARD_ID.ANCHOR) {
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
 * 新建一条自建提示词，插在压缩指令之前（也就是列表末尾）。
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

    const compact = order.indexOf(CARD_ID.COMPACT);
    order.splice(compact >= 0 ? compact : order.length, 0, custom.id);
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
 * 删掉一条自建提示词。内置卡不能删（它们对应插件功能），只能停用。
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

/** 自建提示词实际生效的文本（停用也返回，编辑器要用） */
function getCustomText(settings, id) {
    return findCustomPrompt(settings, id)?.content ?? '';
}

/* ------------------------------------------------------------------ 文本取值 */

/**
 * 某一段学习块实际生效的文本。空 = 用默认（这样默认文本随版本更新，settings.json 也不用存五百字）。
 * @param {object} settings
 * @param {'common'|'active'|'passive'} part
 */
export function getPartText(settings, part) {
    const meta = PART_BY_KEY.get(part) ?? PART_BY_KEY.get('common');
    const text = typeof settings?.[meta.settingKey] === 'string' ? settings[meta.settingKey] : '';
    return text.trim() ? text : meta.defaultValue;
}

/** 工具指令实际生效的文本。空 = 用默认 */
export function getToolPrompt(settings) {
    const text = typeof settings?.toolPrompt === 'string' ? settings.toolPrompt : '';
    return text.trim() ? text : DEFAULT_TOOL_PROMPT;
}

/**
 * 某张卡实际生效的文本。分界线没有正文，返回空串。
 * 自建提示词不看启用状态——编辑器里要能看见停用的那条写了什么。
 * @param {object} settings
 * @param {string} id CARD_ID 里的值，或自建提示词的 id
 */
export function getCardText(settings, id) {
    if (isCustomPrompt(settings, id)) {
        return getCustomText(settings, id);
    }

    switch (id) {
        case CARD_ID.TOOL:
            return getToolPrompt(settings);
        case CARD_ID.COMMON:
        case CARD_ID.ACTIVE:
        case CARD_ID.PASSIVE:
            return getPartText(settings, id);
        case CARD_ID.COMPACT:
            return getCompactPrompt(settings);
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
    if (id === CARD_ID.TOOL) {
        const value = String(text ?? '');
        if (!value.trim() || value.trim() === DEFAULT_TOOL_PROMPT.trim()) {
            return '';
        }
        return value;
    }

    if (id === CARD_ID.COMPACT) {
        return normalizeCompactPrompt(text);
    }

    const meta = PART_BY_KEY.get(id) ?? PART_BY_KEY.get('common');
    const value = String(text ?? '');
    if (!value.trim() || value.trim() === meta.defaultValue.trim()) {
        return '';
    }
    return value;
}

/** 卡片的设置键；分界线没有 */
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

/* ------------------------------------------------------------------ 工具宏 */

/**
 * `{{name}}` / `{{!name}}` 的展开结果。
 * @typedef {{ text: string, matched: number, produced: number }} MacroResult
 */

/**
 * 展开工具宏。只碰工具名，认不出的花括号原样留着（`{{char}}` / `{{user}}` 还要交给 ST）。
 *
 * @param {object} ctx
 * @param {string} text
 * @returns {MacroResult} matched = 命中几个工具宏；produced = 其中展开出名字的有几个
 */
export function expandToolMacros(ctx, text) {
    let matched = 0;
    let produced = 0;

    const lines = String(text ?? '').split('\n').map(line => {
        if (!line.includes('{{')) {
            return line;
        }

        let touched = false;
        const expanded = line.replace(/\{\{(!?)([A-Za-z0-9_]+)\}\}/g, (whole, bang, rawName) => {
            const name = String(rawName).toLowerCase();
            if (!isThriveTool(name)) {
                return whole;
            }

            matched++;
            touched = true;

            const available = isToolAvailable(ctx, name);
            const exposed = isToolExposed(ctx, name);
            // 没注册的工具不写进清单：模型看不见它，"不可用"也就无从谈起
            const wanted = bang ? (exposed && !available) : available;
            if (!wanted) {
                return '';
            }

            produced++;
            return name;
        });

        // 宏展开为空会在行里留下连续空格（整行列工具名时尤其明显）；只收拾动过的行，
        // 没写宏的行原样保留用户的排版
        return touched ? expanded.replace(/[ \t]{2,}/g, ' ').trim() : line;
    });

    return { text: lines.join('\n'), matched, produced };
}

/* ------------------------------------------------------------------ 状态 */

/**
 * 卡片此刻的状态，只服务界面。
 *
 *   on      这一轮会注入
 *   idle    这一轮不注入（停用、功能没开、或者不属于当前模式）
 *   cond    条件触发：满足条件时才起作用（压缩指令）；工具指令"全都可用"也归这一类
 *   anchor  分界线
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string} id
 * @returns {{ state: 'on'|'idle'|'cond'|'anchor', note: string }}
 */
export function getCardState(ctx, settings, id) {
    const mode = getLearningMode(ctx);
    const injecting = settings?.promptInject !== false;

    if (id === CARD_ID.ANCHOR) {
        return { state: 'anchor', note: '分界线' };
    }

    // 停用压过一切：这一轮它一定不注入，不管模式与条件
    if (!isPromptEnabled(settings, id)) {
        return { state: 'idle', note: '已停用' };
    }

    if (isCustomPrompt(settings, id)) {
        if (!injecting) {
            return { state: 'idle', note: '自动注入已关闭' };
        }
        // 学习模式关着 = 插件整体不出声（ADR-001）；自建提示词也守这条线
        if (!mode) {
            return { state: 'idle', note: '学习模式未开启' };
        }
        // 落点与角色已经各占一行里的位置，这里只说"什么时候会注入"，
        // 否则界面上会出现"尾部 · 尾部 · 系统"这种重复
        return { state: 'on', note: '随学习模式注入' };
    }

    if (id === CARD_ID.COMPACT) {
        /*
         * 压缩指令不参与注入，只在压缩面板里用。
         * 仍然单列一张卡，是因为它确实是一段可编辑的提示词——用户要能看见
         * 它长什么样、能改，而不是埋进某个设置项里。
         */
        return { state: 'cond', note: '压缩面板用 · 待接线' };
    }

    if (!injecting) {
        return { state: 'idle', note: '自动注入已关闭' };
    }

    switch (id) {
        case CARD_ID.COMMON:
            return mode
                ? { state: 'on', note: '两种模式都带' }
                : { state: 'idle', note: '学习模式未开启' };

        case CARD_ID.ACTIVE:
            if (mode === LEARNING_MODE.ACTIVE) {
                return { state: 'on', note: '主动模式' };
            }
            return { state: 'idle', note: mode ? '这一轮是被动' : '主动模式未开启' };

        case CARD_ID.PASSIVE:
            return mode === LEARNING_MODE.PASSIVE
                ? { state: 'on', note: '被动轮' }
                : { state: 'idle', note: '只在被动轮' };

        case CARD_ID.TOOL: {
            if (settings?.toolsResident !== true) {
                return { state: 'idle', note: '需先开启工具常驻' };
            }
            const { matched, produced } = expandToolMacros(ctx, getToolPrompt(settings ?? {}));
            if (matched > 0 && produced === 0) {
                return { state: 'cond', note: '没有不可用的工具' };
            }
            const count = listUnavailableTools(ctx).length;
            return { state: 'on', note: count ? `${count} 个工具不可用` : '固定文本' };
        }

        default:
            return { state: 'idle', note: '' };
    }
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

/* ------------------------------------------------------------------ 拼装 */

/**
 * 某张卡这一轮要注入的正文。空串 = 不注入。
 * @param {object} ctx
 * @param {object} settings
 * @param {string} id
 * @param {'active'|'passive'|null} mode
 */
function getCardBody(ctx, settings, id, mode) {
    // 停用的卡一律不注入；锚点没有正文
    if (id !== CARD_ID.ANCHOR && !isPromptEnabled(settings, id)) {
        return '';
    }

    if (isCustomPrompt(settings, id)) {
        // 学习模式关着 = 插件整体不出声，自建提示词也不例外
        return mode ? String(findCustomPrompt(settings, id)?.content ?? '') : '';
    }

    switch (id) {
        case CARD_ID.COMMON:
            return mode ? getPartText(settings, 'common') : '';

        case CARD_ID.ACTIVE:
            return mode === LEARNING_MODE.ACTIVE ? getPartText(settings, 'active') : '';

        case CARD_ID.PASSIVE: {
            if (mode !== LEARNING_MODE.PASSIVE) {
                return '';
            }
            const base = getPartText(settings, 'passive');
            // 被动触发的那一轮要说明"只是一轮"，否则模型会以为学习模式会一直开着
            const notice = getOnceNotice(getPending(ctx));
            return notice ? `${base.trim()}\n\n${notice}` : base;
        }

        case CARD_ID.TOOL: {
            if (settings?.toolsResident !== true) {
                return '';
            }
            const result = expandToolMacros(ctx, getToolPrompt(settings ?? {}));
            // 模板全是"不可用"宏、而此刻没有不可用的工具 → 整段没有意义
            if (result.matched > 0 && result.produced === 0) {
                return '';
            }
            return result.text;
        }

        default:
            // 分界线与压缩指令都不参与注入
            return '';
    }
}

/**
 * 把一组卡片按顺序切成若干"段"：**相邻且同角色**的卡拼成一段。
 *
 * 为什么按角色切：ST 的一条扩展提示词只带一个 role，系统 / 用户 / 助手混在
 * 同一个 value 里就只能全按系统发。切段之后每条提示词的角色才真的生效，
 * 而段内仍然是原来的"空行拼接"，不会把一张卡拆成好几条消息。
 *
 * 空卡（停用、不属于当前模式）直接跳过，不算断点：中间停用一条，
 * 前后两段同角色的卡仍然合成一段。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string[]} ids
 * @param {'active'|'passive'|null} mode
 * @returns {{ role: number, text: string, ids: string[] }[]}
 */
function composeRuns(ctx, settings, ids, mode) {
    const runs = [];

    for (const id of ids) {
        const text = String(getCardBody(ctx, settings, id, mode) ?? '').trim();
        if (!text) {
            continue;
        }

        const role = getPromptRole(settings, id);
        const last = runs[runs.length - 1];

        if (last && last.role === role) {
            last.text = `${last.text}\n\n${text}`;
            last.ids.push(id);
        } else {
            runs.push({ role, text, ids: [id] });
        }
    }

    return runs;
}

/** 段拼回一整段：只用于统计字数与兼容旧的调用方 */
function joinRuns(runs) {
    return runs.map(run => run.text.trim()).filter(Boolean).join('\n\n');
}

/**
 * 这一轮实际要注入的两段文本。
 *
 * `head` / `tail` 是拼好的一整段（统计界面用）；`headRuns` / `tailRuns` 是注入时
 * 真正写进 ST 的单位——每段带自己的角色。
 *
 * @param {object} ctx
 * @param {object} settings
 * @returns {{
 *   mode: string|null,
 *   order: string[],
 *   head: string,
 *   tail: string,
 *   headRuns: { role: number, text: string, ids: string[] }[],
 *   tailRuns: { role: number, text: string, ids: string[] }[],
 * }}
 */
export function buildInjection(ctx, settings) {
    const order = getPromptOrder(settings ?? {});
    const mode = getLearningMode(ctx);

    if (settings?.promptInject === false) {
        return { mode, order, head: '', tail: '', headRuns: [], tailRuns: [] };
    }

    const { head, tail } = splitByAnchor(order);
    const headRuns = composeRuns(ctx, settings, head, mode);
    const tailRuns = composeRuns(ctx, settings, tail, mode);

    return {
        mode,
        order,
        head: joinRuns(headRuns),
        tail: joinRuns(tailRuns),
        headRuns,
        tailRuns,
    };
}

/* ------------------------------------------------------------------ 注入 */

/**
 * 把当前状态同步进 ST 的扩展提示词表。幂等，可以随便多次调用。
 *
 * 每段一个 key，段号补零；上一次同步留下、这一次不再需要的 key 直接删掉，
 * 否则停用 / 删除一条提示词之后，旧内容会一直挂在提示词表里。
 *
 * @param {object} ctx getContext() 的返回值，需在使用时现取
 * @param {object} settings extension_settings.thrive
 */
export function syncInjection(ctx, settings) {
    if (typeof ctx?.setExtensionPrompt !== 'function') {
        return;
    }

    const table = ctx.extensionPrompts;
    const keep = new Set();

    // v0.19 的单块键名与 v0.20–v0.29 的单段键名：升级后清掉，避免旧内容和新内容并存
    for (const legacy of [LEGACY_BLOCK_KEY, HEAD_KEY, TAIL_KEY]) {
        if (table && legacy in table) {
            delete table[legacy];
        }
    }

    const { headRuns, tailRuns } = buildInjection(ctx, settings ?? {});

    /*
     * 按段顺序逐段替换宏：`{{setvar::x::…}}` 的副作用会留在 ST 的变量表里，
     * 后面段里的 `{{getvar::x}}` 才读得到。跨区也按"系统区 → 尾部"的顺序走。
     */
    headRuns.forEach((run, index) => {
        const key = runKey('head', index);
        keep.add(key);
        // 头部：进 system 区，锚定在 main 之后（BEFORE_PROMPT 才是 main 之前）
        ctx.setExtensionPrompt(key, substitute(ctx, run.text), IN_PROMPT, 0, false, run.role);
    });

    tailRuns.forEach((run, index) => {
        const key = runKey('tail', index);
        keep.add(key);
        // depth 0 = 消息数组最末位；scan false（这些提示词不参与世界书关键词扫描）
        ctx.setExtensionPrompt(key, substitute(ctx, run.text), IN_CHAT, 0, false, run.role);
    });

    // 清掉这次没再用到的段号键（原来的第 3 段被删了 / 停用了）
    if (table) {
        for (const key of Object.keys(table)) {
            if (RUN_KEY_RE.test(key) && !keep.has(key)) {
                delete table[key];
            }
        }
    }
}

/** 现取 context + settings 后同步，供事件回调直接用 */
export function syncFromContext(ctx) {
    syncInjection(ctx, ensureSettings(ctx));
}

function substitute(ctx, text) {
    try {
        const replaced = ctx.substituteParams?.(text);
        return String(replaced ?? text);
    } catch (err) {
        console.error('[Thrive] 宏替换失败，按原文注入', err);
        return text;
    }
}

/* ------------------------------------------------------------------ 其它 */

/**
 * 被动学习那一轮的追加说明。
 *
 * 不加这一段，模型看不出"学习模式只是这一轮开着"，容易写出"以后我会一直记着"这类
 * 出戏的话；加了之后它至少知道这个机会是临时的，该趁现在把值得记的记下来。
 *
 * 摘要类生成（dryRun）不注入学习块，所以这段也只会出现在真正会写内容的轮次里。
 *
 * @param {{ reason: string, keyword?: string }|null} pending
 * @returns {string} 没有待学习时返回空串
 */
export function getOnceNotice(pending) {
    if (!pending) {
        return '';
    }

    let why = '自动触发';
    if (pending.reason === 'interval') {
        why = '距上次学习已经过了设定的消息条数';
    } else if (pending.reason === 'keyword') {
        why = pending.keyword ? `消息里出现了关键词「${pending.keyword}」` : '消息命中了关键词';
    } else if (pending.reason === 'manual') {
        why = '用户手动触发';
    }

    return `【本轮为自动触发】这一轮的学习模式是被动学习临时打开的（${why}），只在这一轮有效，回复结束就关闭。`
        + '先看这一轮有没有值得长期保留的信息：有就按上面的规矩记下来，没有就照常继续，不必勉强写。';
}

/** 字数统计口径：不计空白，和 spec 里「约 930 字」对得上 */
export function countChars(text) {
    return String(text ?? '').replace(/\s/g, '').length;
}
