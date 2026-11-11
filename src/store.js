/**
 * store.js · 设置与对话状态的读写
 *
 * 两条存储线：
 *   - 跨对话设置 → extension_settings.thrive（context 里叫 ctx.extensionSettings）
 *   - 对话级状态 → chat_metadata.thrive（context 里叫 ctx.chatMetadata）
 *
 * 约定：ctx 由调用方在使用时现取，不要把 getContext() 的结果长期缓存。
 * 切换聊天时 ST 会整体替换 chat_metadata 对象，旧 ctx 会指向上一个对话。
 */

import { DESC_STORAGE } from './desc-entry.js';
import { notifyPanel } from './events.js';
import { LIMIT_DEFAULTS, readLimit } from './limits.js';
import { CARD_ID, DEFAULT_PROMPT_ORDER, isPinnedCard } from './prompt-order.js';
import { fnv1a } from './util.js';

export const MODULE_NAME = 'thrive';

/**
 * 本步骤只需要这几项设置。后续步骤（写入目标、长度上限等）
 * 会往 DEFAULT_SETTINGS 里继续补，ensureSettings 的补全逻辑不用改。
 */
export const DEFAULT_SETTINGS = Object.freeze({
    /** 新对话默认是否开启学习模式 */
    enabledByDefault: false,
    /** 输入框旁是否显示状态徽章 */
    showBadge: true,
    /**
     * 自动学习判据：从上次学习算起，攒够这么多条可见消息就触发一次。
     * 0 = 不用这条判据（全局）。开关本身按对话记（`state.enabled`）。
     */
    learnInterval: 0,
    /** 自动学习判据：关键词，逗号/分号/换行分隔；空 = 不用关键词触发（全局） */
    learnKeywords: '',
    /**
     * 学习 / 压缩会话走哪条连接。
     *
     * 空串 = 跟随当前聊天设置（ST 主界面上选的那个 API）；否则是 ST「连接配置」里
     * 某一份的 id。改动只影响**之后新开的**会话：一场会话开始时读一次就定死，
     * 中途换路会让后半场跑到另一个模型上。
     */
    connectionProfile: '',
    /**
     * 提示词卡片的顺序（prompt-order.js 里的 id 数组，以及自建提示词的 id）。
     * 空数组 = 默认顺序。这份顺序就是学习会话里消息的先后。
     */
    promptOrder: [],
    /**
     * 用户自建的提示词。
     *
     * 每条形如 `{ id, name, content, role, enabled }`：
     *   role     ST 的扩展提示词角色，0 系统 / 1 用户 / 2 助手
     *   enabled  停用之后内容还留着，只是不参与注入
     *
     * 内置卡（学习块、工具指令、压缩指令）不在这里，它们的正文仍存在下面那几个
     * 老设置键里；停用状态见 `disabledCards`，角色覆盖见 `promptRoles`。
     */
    customPrompts: [],
    /** 被停用的内置卡片 id。停用 = 不注入，正文一个字不动 */
    disabledCards: [],
    /** 内置卡片的角色覆盖：`{ [cardId]: 0|1|2 }`。没写 = 系统 */
    promptRoles: {},

    /**
     * 学习会话用到的四段文字（ADR-054 把它们分成两层）。
     *
     * 通用层（列表里的卡片，每一场都带）：
     *   sessionRules  通用提示词的正文——这场会话里你是谁、擅长什么。默认空串。
     *   targetPrompt  目标内容描述行（默认「以下是目标内容：」），真正的内容由
     *                 learning.js 在发请求前追加在后面。
     *
     * 特化层（开场白，只属于那一种任务）：
     *   learningTask  学习这一场怎么干：产出方式、写到哪、怎么写、这一次的要求。
     *   compactTask   压缩那一场同样的一份。
     *
     * 空串 = 使用 prompt.js 里对应的 DEFAULT_*（默认文本随版本更新时老用户也能拿到新版）。
     */
    targetPrompt: '',
    sessionRules: '',
    learningTask: '',
    compactTask: '',
    /*
     * 「角色描述存哪儿」（descStorage）与「可写书」（writableBook）不在这里：
     * 它们按对话保存（ADR-044），见 createChatState。老版本留在全局的旧值只当
     * 未设置过的对话的初值，见 legacyChatValue。
     */
    /** 新建条目的插入位置：0 角色定义前 / 1 角色定义后 / 2 作者注释顶 / 3 作者注释底 */
    entryPosition: 0,
    /**
     * 所有"写多少 / 读多少"的数值上限。默认值与取值范围由 limits.js 定义，
     * 设置页「数值与上限」直接对着它渲染；这里铺开是为了让 ensureSettings
     * 的类型补全也覆盖到它们（老用户没有这些键，缺一个就会被当成 0）。
     */
    ...LIMIT_DEFAULTS,
    /**
     * 记录面板的布局。位置/尺寸是按屏幕算的，与具体对话无关，所以放全局设置：
     *   panelX / panelY  -1 = 还没拖过，走样式里的右下角；否则是左上角像素坐标
     *   panelWidth       展开时的宽度（窄屏会被 `min(…, 92vw)` 再收一次）
     *   panelHeight      展开时的最大高度
     *   panelOpacity     整块面板的不透明度，调低可以透出后面的聊天内容
     *
     * 默认值随面板瘦身一起调小过一档（ADR-043）：正文只剩两块开关 + 一个折叠块，
     * 再给 480×620 就只是空着。用户自己拖过 / 调过的值不动。
     */
    panelX: -1,
    panelY: -1,
    panelWidth: 400,
    panelHeight: 520,
    panelOpacity: 1,
});

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * patch 的最小形状校验。
 *
 * `status` 只判"是不是字符串"而不校验枚举值：新版本加了状态之后，
 * 老聊天文件里的 patch 至少还能被丢弃，不会因为不认识就被悄悄清掉。
 */
function isPatchState(patch) {
    return isPlainObject(patch)
        && typeof patch.before === 'string'
        && typeof patch.after === 'string'
        && typeof patch.status === 'string';
}

/**
 * 世界书快照 / 写入记录保留条数。
 * 一份快照同时充当"已写入"列表里的一行，所以这个数字既是备份槽位数，也是面板条数。
 *
 * 具体条数由设置项 `loreBackupLimit` 决定（limits.js 里默认 10）；
 * 这里只在读状态与写入时取一次，不缓存——用户改完设置下一笔写入就生效。
 */
function loreBackupLimit(settings) {
    return readLimit(settings, 'loreBackupLimit');
}

/**
 * 规范一条世界书快照。
 *
 * 记录与快照是同一份数据：`before` 是写入前的正文（新建时为空串），
 * 面板靠 `action` 决定按钮是"恢复写入前"还是"撤销新建"。
 * 老对话里的快照只有 `{ book, title, before, at }`，这里按 before 是否为空推断 action，
 * 并补一个稳定的 id（`restore` 用它定位，不用下标——下标会随新写入整体前移）。
 *
 * `layer` 说明这份快照记的是**哪一层**的写入：
 *   `disk`  写进了真实世界书（保存缓冲区之后、或缓冲区出现之前的那些旧记录）
 *   `draft` 只写进了虚拟世界书，真实世界书当时一个字都没动
 * 恢复要按层走：拿缓冲区里的 before 去覆盖磁盘，等于凭空造出一份用户没同意过的内容。
 * 老记录一律当 `disk`（那时候还没有缓冲区）。
 *
 * @returns {object|null} 形状完全不认识时返回 null，由调用方丢掉
 */
function normalizeLoreBackup(raw, index) {
    if (!isPlainObject(raw)) {
        return null;
    }

    const before = typeof raw.before === 'string' ? raw.before : '';
    const at = Number(raw.at) > 0 ? Number(raw.at) : 0;
    const action = raw.action === 'created' || raw.action === 'rewritten'
        ? raw.action
        : (before ? 'rewritten' : 'created');

    return {
        // 补出来的 id 必须可重复：每次 getState 都会跑一遍规范化，
        // 用随机数会让"刚点下恢复"和"重绘后面板拿到的 id"对不上
        id: typeof raw.id === 'string' && raw.id ? raw.id : `b${at}-${index}`,
        book: String(raw.book ?? ''),
        title: String(raw.title ?? ''),
        action,
        layer: raw.layer === 'draft' ? 'draft' : 'disk',
        before,
        beforeKeys: Array.isArray(raw.beforeKeys) ? raw.beforeKeys.map(String) : [],
        chars: Number(raw.chars) > 0 ? Number(raw.chars) : 0,
        at,
        restoredAt: Number(raw.restoredAt) > 0 ? Number(raw.restoredAt) : null,
    };
}

/**
 * 规范虚拟世界书。
 *
 * 就地改写并返回**同一个对象**（理由同 normalizePassive）：每次 getState 都会跑一遍，
 * 每次返回新对象的话，调用方手里那个引用会在下一次 getState 之后变成孤儿，
 * 刚写进去的条目就凭空消失了。
 *
 * `entries` 是整本书的副本，**不在这里深拷贝**——getState 每次工具调用都会走一遍，
 * 拷贝一本两百条的书不是"顺手"的成本。写入方自己保证传进来的是副本。
 *
 * @param {unknown} raw
 * @returns {object|null} 形状不认识（没有书名 / 没有条目表）就当没有缓冲区
 */
function normalizeDraft(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    raw.book = String(raw.book ?? '').trim();
    if (!raw.book) {
        return null;
    }

    if (!isPlainObject(raw.entries)) {
        raw.entries = {};
    }
    if (!isPlainObject(raw.touched)) {
        raw.touched = {};
    }
    if (typeof raw.baseHash !== 'string') {
        raw.baseHash = '';
    }

    const created = Number(raw.createdAt);
    raw.createdAt = Number.isFinite(created) && created > 0 ? created : Date.now();

    const updated = Number(raw.updatedAt);
    raw.updatedAt = Number.isFinite(updated) && updated > 0 ? updated : raw.createdAt;

    return raw;
}

/**
 * 规范自建提示词表。
 *
 * 老版本没有这些键，手改过 settings.json 的可能只有半个对象——一律补成
 * `{ id, name, content, role, enabled }`，认不出的条目直接丢。
 * 只返回内容真的变了才替换原数组，免得每次 ensureSettings 都换一个新引用，
 * 界面手里那个"正在编辑的这条"变成孤儿。
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeCustomPrompts(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const source = raw;
    const out = [];
    const seen = new Set();

    for (const item of source) {
        if (!isPlainObject(item)) {
            continue;
        }

        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);

        out.push({
            id,
            name: typeof item.name === 'string' && item.name.trim() ? item.name : '未命名提示词',
            content: typeof item.content === 'string' ? item.content : '',
            role: item.role === 1 || item.role === 2 ? item.role : 0,
            enabled: item.enabled !== false,
        });
    }

    const same = out.length === source.length && out.every((item, index) => {
        const before = source[index];
        return isPlainObject(before)
            && before.id === item.id
            && before.name === item.name
            && before.content === item.content
            && before.role === item.role
            && before.enabled === item.enabled;
    });

    return same ? raw : out;
}

/**
 * 停用的内置卡：只认认识的 id、去重，并且丢掉注入位。
 *
 * 注入位不能停用（`setPromptEnabled` 会拒），所以老设置里万一带了它，这里顺手
 * 清掉——留着一条永远不生效的停用记录，只会让人以为它真的被关了。
 */
function normalizeDisabledCards(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const known = new Set(Object.values(CARD_ID).filter(id => !isPinnedCard(id)));
    const source = raw;
    const out = [];

    for (const id of source) {
        if (typeof id === 'string' && known.has(id) && !out.includes(id)) {
            out.push(id);
        }
    }

    return out.length === source.length && out.every((id, index) => id === source[index]) ? raw : out;
}

/** 内置卡的角色覆盖：只留认识的、可改角色的卡，值只留 1/2（0 是默认，存不存一样） */
function normalizePromptRoles(raw) {
    if (!isPlainObject(raw)) {
        return {};
    }

    const known = new Set(Object.values(CARD_ID).filter(id => !isPinnedCard(id)));
    const out = {};
    for (const [id, role] of Object.entries(raw)) {
        if (known.has(id) && (role === 1 || role === 2)) {
            out[id] = role;
        }
    }

    const before = Object.keys(raw).filter(id => raw[id] === 1 || raw[id] === 2);
    const after = Object.keys(out);
    const same = before.length === after.length && after.every(id => raw[id] === out[id]);
    return same ? raw : out;
}

/**
 * 补齐 extension_settings.thrive，返回该对象本身（可安全地直接改）。
 * @param {object} ctx getContext() 的返回值
 */
export function ensureSettings(ctx) {
    const root = ctx.extensionSettings;

    if (!isPlainObject(root[MODULE_NAME])) {
        root[MODULE_NAME] = {};
    }

    const settings = root[MODULE_NAME];
    let dirty = false;

    /*
     * v0.33：对话与学习分离（ADR-050）。
     *
     * 学习的语义变了：不再有"主动 / 被动"两套模式，也没有"借下一轮"这回事。
     * 学习一律发生在独立会话里，聊天请求里不再出现任何插件提示词与工具。
     * 因此这一版要搬的东西比较多，全部只搬一次：
     *
     *   blockText / blockCommon / blockActive / blockPassive → learningTask
     *   passiveInterval / passiveKeywords                  → learnInterval / learnKeywords
     *   passiveByDefault                                   → enabledByDefault（取或）
     *   compactPrompt                                      → compactTask
     *   blockPosition / promptInject / toolsResident / toolPrompt → 丢掉
     *
     * 主动段与被动段不再存在，只保留通用段：它原本写的就是"和这一轮学多少无关"的规则。
     * 那段规则讲的是产出方式 / 写到哪 / 怎么写，按 ADR-054 属于特化内容，所以落到
     * learningTask（v0.37 之前它先落在 sessionRules，由下面那段再搬一次）。
     */
    if (Object.hasOwn(settings, 'blockText')) {
        const legacy = typeof settings.blockText === 'string' ? settings.blockText : '';
        if (!Object.hasOwn(settings, 'blockCommon') && legacy.trim()) {
            settings.blockCommon = legacy;
        }
        delete settings.blockText;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'blockCommon')) {
        const legacy = typeof settings.blockCommon === 'string' ? settings.blockCommon : '';
        if (!String(settings.learningTask ?? '').trim() && legacy.trim()) {
            settings.learningTask = legacy;
        }
        delete settings.blockCommon;
        dirty = true;
    }

    for (const legacyKey of ['blockActive', 'blockPassive', 'blockPosition', 'promptInject', 'toolsResident', 'toolPrompt']) {
        if (Object.hasOwn(settings, legacyKey)) {
            delete settings[legacyKey];
            dirty = true;
        }
    }

    /*
     * 原来由 limits.js 管的两个键也跟着"工具日志"一起消失：
     *   traceMaxChars  日志压缩的单行上限（日志本身没了）
     *   learnRounds / learnHistoryChars 是新增的，不需要搬
     * 留着它们只是垃圾：limits.js 的 readLimits 只读自己表里的键，读到也永远不会用。
     */
    if (Object.hasOwn(settings, 'traceMaxChars')) {
        delete settings.traceMaxChars;
        dirty = true;
    }

    for (const [legacyKey, nextKey] of [
        ['passiveInterval', 'learnInterval'],
        ['passiveKeywords', 'learnKeywords'],
    ]) {
        if (Object.hasOwn(settings, legacyKey)) {
            const legacy = settings[legacyKey];
            if (!Object.hasOwn(settings, nextKey) || !settings[nextKey]) {
                settings[nextKey] = typeof legacy === typeof DEFAULT_SETTINGS[nextKey] ? legacy : DEFAULT_SETTINGS[nextKey];
            }
            delete settings[legacyKey];
            dirty = true;
        }
    }

    if (Object.hasOwn(settings, 'passiveByDefault')) {
        // 以前"被动开着"的人，升级后想要的就是"学习模式开着"：两个开关合并成一个
        if (settings.passiveByDefault === true) {
            settings.enabledByDefault = true;
        }
        delete settings.passiveByDefault;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'passiveEnabled')) {
        // v0.26 之前的全局开关，更早的一层；同样只是初值
        if (settings.passiveEnabled === true) {
            settings.enabledByDefault = true;
        }
        delete settings.passiveEnabled;
        dirty = true;
    }

    if (Object.hasOwn(settings, 'compactPrompt')) {
        const legacy = typeof settings.compactPrompt === 'string' ? settings.compactPrompt : '';
        /*
         * v0.33 起这一项改叫 compactUserMessage。两个键同时还在时以后者为准：
         * 它是后来那一版真正给用户编辑的，compactPrompt 只是更早的一份残影。
         */
        const newer = typeof settings.compactUserMessage === 'string' ? settings.compactUserMessage.trim() : '';
        if (!String(settings.compactTask ?? '').trim() && !newer && legacy.trim()) {
            settings.compactTask = legacy;
        }
        delete settings.compactPrompt;
        dirty = true;
    }

    /*
     * v0.36 / v0.37：提示词分成"通用 / 特化"两层（ADR-054）。
     *
     *   learningUserMessage         → learningTask
     *   learnPrompt                 → learningTask 前面（旧的"学习规则"卡排在开场白之前）
     *   compactUserMessage          → compactTask
     *   sessionRules（v0.36 的老值） → learningTask 前面，然后清空这个键
     *
     * 为什么老值一律并进 task 而不是留在通用提示词里：旧版的"规则"写的是产出方式、
     * 写到哪、怎么写，按新分工属于**特化**内容。通用提示词讲的是"你是谁"，
     * 是 v0.37 才有的新东西，所以它从空串（= 默认文本）开始。
     *
     * v0.36 的 `sessionRules` 也要搬，判据是**顺序表里没有 rules 这张卡**——它不可删，
     * 顺序表里出现它就说明已经迁过一遍了。搬完顺便把这张卡插到最前面。
     */
    let promptMoved = false;

    for (const [legacyKey, taskKey] of [
        ['learningUserMessage', 'learningTask'],
        ['compactUserMessage', 'compactTask'],
    ]) {
        if (!Object.hasOwn(settings, legacyKey)) {
            continue;
        }

        const legacy = typeof settings[legacyKey] === 'string' ? settings[legacyKey].trim() : '';
        if (legacy && !String(settings[taskKey] ?? '').trim()) {
            settings[taskKey] = legacy;
            promptMoved = true;
        }
        delete settings[legacyKey];
        dirty = true;
    }

    if (Object.hasOwn(settings, 'learnPrompt')) {
        const legacy = typeof settings.learnPrompt === 'string' ? settings.learnPrompt.trim() : '';
        if (legacy) {
            settings.learningTask = [legacy, String(settings.learningTask ?? '').trim()]
                .filter(Boolean).join('\n\n');
            promptMoved = true;
        }
        delete settings.learnPrompt;
        dirty = true;
    }

    {
        const order = Array.isArray(settings.promptOrder) ? settings.promptOrder.filter(id => typeof id === 'string') : [];
        const hasRulesCard = order.includes(CARD_ID.RULES);
        const staleRules = typeof settings.sessionRules === 'string' ? settings.sessionRules.trim() : '';

        if (!hasRulesCard && (order.length || staleRules || promptMoved)) {
            if (staleRules) {
                settings.learningTask = [staleRules, String(settings.learningTask ?? '').trim()]
                    .filter(Boolean).join('\n\n');
                settings.sessionRules = '';
            }
            // 通用提示词排在目标内容上面：先知道自己是谁，再读到要干什么。
            // 顺序表本来是空的话，这里写出的是默认顺序（空 = 默认，等价）
            const base = order.length ? order : DEFAULT_PROMPT_ORDER;
            settings.promptOrder = [CARD_ID.RULES, ...base.filter(id => id !== CARD_ID.RULES)];
            dirty = true;
        }
    }

    if (Object.hasOwn(settings, 'dropTraces')) {
        // 聊天里不再有插件工具，也就没有"工具日志"要清理
        delete settings.dropTraces;
        dirty = true;
    }

    /*
     * v0.28：三项设置被固定成规则，不再可调（ADR-046）。
     *   moduleWorldbook / moduleDescription  描述存哪儿说了算：card 两个都能写，
     *                                        worldbook 只有那本书能写，没有"关掉一半"这回事
     *   patchEnabled                         card 模式恒暂存（ADR-005）
     *   readScope                            只读可写书：读得到改不了的书会诱发认知冲突
     *
     * 旧值一律丢掉而不是留着当默认：它们描述的是"用户可以关掉一个模块"，
     * 而那个能力已经不存在了，留着只会在别处读到 false 时判出一个不存在的状态。
     */
    for (const legacyKey of ['moduleWorldbook', 'moduleDescription', 'patchEnabled', 'readScope']) {
        if (Object.hasOwn(settings, legacyKey)) {
            delete settings[legacyKey];
            dirty = true;
        }
    }

    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        // 用类型比对而不是 undefined 判断：手改过 settings.json 存进去的 "false" 也能被纠正
        if (typeof settings[key] !== typeof fallback) {
            settings[key] = fallback;
            dirty = true;
        }
    }

    /*
     * 三张表按内容规范一遍。它们可能是老版本没有的键、也可能是手改过的半个对象；
     * 返回同一个引用说明没变，不重复落盘。
     */
    for (const [key, normalize] of Object.entries({
        customPrompts: normalizeCustomPrompts,
        disabledCards: normalizeDisabledCards,
        promptRoles: normalizePromptRoles,
    })) {
        const next = normalize(settings[key]);
        if (next !== settings[key]) {
            settings[key] = next;
            dirty = true;
        }
    }

    if (dirty) {
        ctx.saveSettingsDebounced?.();
    }

    return settings;
}

/**
 * 学习的对话状态。
 *
 *   baseline  上一次真正学过时的可见消息条数；-1 = 还没初始化
 *   lastHash  上一次学习所依据的那条用户消息的哈希，避免同一句话反复触发
 *   lastRun   最近一次学习会话的结果，面板靠它显示"上次学习"那一行
 *
 * baseline 存"条数快照"而不是"已累计几条"：用户删消息、编辑消息之后，
 * 用差值算出来的进度会自动跟上，不会因为我们自己记了个计数器而永远对不上。
 */
export const LEARN_BASELINE_NONE = -1;

/** 最近一次学习结果：形状不认识或没有时间戳就当没有 */
function normalizeLastRun(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) {
        return null;
    }

    const count = value => (Number(value) >= 0 ? Math.floor(Number(value)) : 0);

    return {
        at,
        ok: raw.ok === true,
        stopped: typeof raw.stopped === 'string' ? raw.stopped : '',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        rounds: count(raw.rounds),
        toolCalls: count(raw.toolCalls),
        chars: count(raw.chars),
        ms: count(raw.ms),
        error: typeof raw.error === 'string' ? raw.error : '',
        hint: typeof raw.hint === 'string' ? raw.hint : '',
    };
}

function createLearnState() {
    return { baseline: LEARN_BASELINE_NONE, lastHash: '', lastRun: null };
}

/**
 * 规范 learn 状态。就地改写并返回同一个对象：getState 每次都会调它，
 * 每次换新对象的话，调用方手里那个引用会在下一次 getState 之后变成孤儿。
 */
function normalizeLearn(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const baseline = Number(source.baseline);

    source.baseline = Number.isFinite(baseline) && baseline >= 0
        ? Math.floor(baseline)
        : LEARN_BASELINE_NONE;
    source.lastHash = typeof source.lastHash === 'string' ? source.lastHash : '';
    source.lastRun = normalizeLastRun(source.lastRun);

    return source;
}

/**
 * 0.25 及以前，「可写书」与「角色描述存储」是全局设置。0.26 起按对话记（ADR-044），
 * 老键只当**初值**用：
 *
 *   - 哪个对话还没有自己的值，就先认全局那个 —— 升级后打开任何一场对话都不会
 *     突然变成"没选书 / 角色卡"，用户看不出区别；
 *   - 用户在某个对话里真正选过一次（走 setWritableBookSetting / setDescStorageMode），
 *     就删掉全局键，从那一刻起"每个对话各记各的"。
 *
 * 不在 getState 里直接删：那样只有升级时正开着的那一场能拿到旧值，其余对话
 * 会凭空丢掉设置，看起来像插件把人家的书弄丢了。
 */
function legacyChatValue(settings, key) {
    return Object.hasOwn(settings, key) ? settings[key] : undefined;
}

/** 用户显式写过之后丢掉旧全局键；没有这个键时是空操作 */
function dropLegacyChatValue(ctx, key) {
    const settings = ensureSettings(ctx);
    if (!Object.hasOwn(settings, key)) {
        return false;
    }
    delete settings[key];
    ctx.saveSettingsDebounced?.();
    return true;
}

/** 存储模式归一：手改过的聊天文件写成 'worldBook' 也当 worldbook 认 */
function normalizeDescStorage(value) {
    return value === DESC_STORAGE.WORLDBOOK ? DESC_STORAGE.WORLDBOOK : DESC_STORAGE.CARD;
}

/**
 * 新建一份对话状态。字段与默认值以本文件为准（spec §4 不列清单），
 * 这样后续步骤加字段时不需要写迁移。
 * @param {object} settings
 */
export function createChatState(settings) {
    const legacyBook = legacyChatValue(settings, 'writableBook');

    return {
        enabled: Boolean(settings.enabledByDefault),
        reads: {},
        lastBook: null,
        patch: null,
        backups: { lore: [], desc: [] },
        learn: createLearnState(),
        /**
         * 角色描述存在哪（ADR-042）：
         *   'card'      角色卡的 description 字段（默认）
         *   'worldbook' 与角色同名那本世界书里的 `【角色描述】` 常驻条目
         *
         * 存字符串而不是布尔：以后要加第三处落点时不用再动一遍字段。
         * 按对话保存的理由见 ADR-044 —— 它决定"这一场对话的描述读哪儿、写哪儿"，
         * 换个对话就换个角色，本来就不该共用。
         */
        descStorage: normalizeDescStorage(legacyChatValue(settings, 'descStorage')),
        /** 可写世界书；空 = 这一场对话还没选书（世界书工具不注册） */
        writableBook: typeof legacyBook === 'string' ? legacyBook.trim() : '',
        /**
         * 虚拟世界书（缓冲区）：模型的每一笔世界书改动先落在这里，用户点「保存」
         * 才写进真实世界书。null = 缓冲区是空的。形状与语义见 src/draft.js。
         */
        draft: null,
    };
}

/**
 * 取当前对话的状态；缺失时按 enabledByDefault 初始化。
 * 注意这里只写内存，落盘交给 setEnabled / saveChat。
 * @param {object} ctx
 */
export function getState(ctx) {
    const settings = ensureSettings(ctx);
    const meta = ctx.chatMetadata;

    if (!isPlainObject(meta) || !isChatAvailable(ctx)) {
        // 没有打开对话时 chat_metadata 是空对象，往里写没有意义也存不下来；
        // 返回一次性状态，别把 ST 的全局对象写脏
        return createChatState(settings);
    }

    if (!isPlainObject(meta[MODULE_NAME])) {
        meta[MODULE_NAME] = createChatState(settings);
    }

    const state = meta[MODULE_NAME];

    // 补全旧版本可能缺的字段
    if (typeof state.enabled !== 'boolean') {
        state.enabled = Boolean(settings.enabledByDefault);
    }
    if (!isPlainObject(state.reads)) {
        state.reads = {};
    }
    if (!Object.hasOwn(state, 'lastBook')) {
        state.lastBook = null;
    }
    /*
     * 0.26 新增的两项。老对话没有这两个字段：先认全局的旧值（见 legacyChatValue），
     * 这样升级不会把"统一模式 / 可写书"抹掉；新对话在 createChatState 里已经填好，
     * 这里再判一次是为了手改过的聊天文件。
     */
    state.descStorage = normalizeDescStorage(
        state.descStorage ?? legacyChatValue(settings, 'descStorage'),
    );
    if (typeof state.writableBook !== 'string') {
        const legacyBook = legacyChatValue(settings, 'writableBook');
        state.writableBook = typeof legacyBook === 'string' ? legacyBook.trim() : '';
    }
    if (!Object.hasOwn(state, 'patch')) {
        state.patch = null;
    }
    // 旧版本残留或手改过的聊天文件：形状不对就当没有，
    // 否则面板会拿到半截对象、diff 渲染出 undefined
    if (state.patch !== null && !isPatchState(state.patch)) {
        state.patch = null;
    }
    if (!isPlainObject(state.backups)) {
        state.backups = { lore: [], desc: [] };
    }
    if (!Array.isArray(state.backups.lore)) {
        state.backups.lore = [];
    } else {
        // 每条都要补 id / action：面板用它定位，工具写入时用它决定能否撤销
        state.backups.lore = state.backups.lore
            .map(normalizeLoreBackup)
            .filter(Boolean)
            .slice(0, loreBackupLimit(settings));
    }
    if (!Array.isArray(state.backups.desc)) {
        state.backups.desc = [];
    } else {
        state.backups.desc = state.backups.desc.filter(isPlainObject).slice(0, 1);
    }

    /*
     * v0.33：旧的 passive.{baseline,lastLearnedUserHash} 并进 learn。
     *
     * 那时"被动开着"就是这个人想在这场上定期学，所以并进总开关；
     * 基线一起搬过来，升级后不用从头再数一遍消息。
     */
    if (isPlainObject(state.passive)) {
        const legacy = state.passive;
        const learn = isPlainObject(state.learn) ? state.learn : {};

        if (legacy.enabled === true) {
            state.enabled = true;
        }
        if (learn.baseline === undefined && Number(legacy.baseline) >= 0) {
            learn.baseline = Number(legacy.baseline);
        }
        if (!learn.lastHash && typeof legacy.lastLearnedUserHash === 'string') {
            learn.lastHash = legacy.lastLearnedUserHash;
        }

        state.learn = learn;
        delete state.passive;
    }

    // 学习进度与上次结果：老对话没有这个字段，补一份空状态
    state.learn = normalizeLearn(state.learn);

    // 缓冲区：老对话没有这个字段（null 就是"没有缓冲区"），手改坏的当没有
    state.draft = normalizeDraft(state.draft);

    return state;
}

/** 当前对话是否开着学习模式 */
export function isEnabled(ctx) {
    return getState(ctx).enabled === true;
}

/* ------------------------------------------------- 角色描述存在哪 / 可写书 */
/*
 * 这两项 0.26 起按对话保存（ADR-044）。放在这里而不是 desc.js：
 * targets.js 要用它们算"这次读写哪本书"，而 desc.js 反过来要用 targets.js 的读写原语
 * ——住在 store 里两边都能 import，desc.js 只做转发。
 */

/**
 * 当前对话的角色描述存在哪。
 * @returns {'card'|'worldbook'}
 */
export function descStorageMode(ctx) {
    return normalizeDescStorage(getState(ctx).descStorage);
}

/** 是否统一模式（描述存到角色同名书的常驻条目里） */
export function isWorldbookDesc(ctx) {
    return descStorageMode(ctx) === DESC_STORAGE.WORLDBOOK;
}

/**
 * 切换存储模式并落盘。
 *
 * 只改"从哪儿读写"，不搬内容（ADR-042）：两边的正文各自留在原地。
 * @param {object} ctx
 * @param {'card'|'worldbook'} mode
 */
export function setDescStorageMode(ctx, mode) {
    const state = getState(ctx);
    state.descStorage = normalizeDescStorage(mode);
    dropLegacyChatValue(ctx, 'descStorage');
    saveChat(ctx);
    return state.descStorage;
}

/** 这一场对话选的可写世界书；空串 = 还没选 */
export function getWritableBookSetting(ctx) {
    return String(getState(ctx).writableBook ?? '').trim();
}

/**
 * 设置这一场对话的可写世界书并落盘。空串 = 清掉选择。
 * @param {object} ctx
 * @param {string} book
 */
export function setWritableBookSetting(ctx, book) {
    const state = getState(ctx);
    state.writableBook = String(book ?? '').trim();
    dropLegacyChatValue(ctx, 'writableBook');
    saveChat(ctx);
    return state.writableBook;
}

/* -------------------------------------------------------------- 虚拟世界书 */
/*
 * 这里只管"挂在对话状态上的那个对象"，什么时候开、怎么写、什么时候保存到磁盘
 * 全在 draft.js 与 targets.js。缓冲区内容是一整本书的副本，属于对话数据，
 * 换一场对话就该换成那一场的。
 */

/** 当前对话的缓冲区；没有时返回 null */
export function getDraftState(ctx) {
    return getState(ctx).draft;
}

/**
 * 覆盖缓冲区。传 null 表示清空。
 * 只写内存，落盘交给调用方（它知道要不要顺带作废别的登记）。
 */
export function setDraftState(ctx, draft) {
    getState(ctx).draft = draft;
}

/* ------------------------------------------------------------------ 学习 */
/*
 * 学习的"状态"放在这里，"什么时候该触发一次"放在 auto-learn.js：
 * store 只管读写，不引入消息扫描，避免 store ↔ auto-learn 互相 import。
 */

/** 学习的对话状态（可直接改，改完记得 saveChat） */
export function getLearn(ctx) {
    return getState(ctx).learn;
}

/**
 * 更换学习模式总开关并落盘。
 *
 * 这就是唯一的开关：开着时按判据自动触发，或者手动触发；关着时一次都不会自己学。
 * 没有"主动 / 被动"之分，也没有"只借这一轮"的临时记号——学习本来就在另一场
 * 会话里跑，不存在"借聊天的一轮"这回事（ADR-050）。
 *
 * @param {object} ctx
 * @param {boolean} enabled
 */
export function setEnabled(ctx, enabled) {
    const state = getState(ctx);
    state.enabled = Boolean(enabled);
    saveChat(ctx);
    return state;
}

/**
 * 记下"这一次学的是哪一段"：基线推到当前条数、记下所依据的那条用户消息。
 *
 * 在**触发时**就写，不等会话跑完：跑到一半又来了新消息时，基线不该把它算进
 * 下一次的进度里（那几条会在下一轮重新被看到）。
 *
 * @param {object} ctx
 * @param {{ total?: number, hash?: string }} info
 * @returns {object} learn 状态
 */
export function beginLearn(ctx, { total = null, hash = '' } = {}) {
    const state = getState(ctx);
    const count = Number(total);

    if (Number.isFinite(count) && count >= 0) {
        state.learn.baseline = Math.floor(count);
    }
    state.learn.lastHash = String(hash ?? '');

    return state.learn;
}

/**
 * 记下一次学习的结果。只写内存，落盘交给调用方。
 * @param {object} ctx
 * @param {object} result `{ ok, stopped, rounds, toolCalls, chars, ms, error, hint }`
 * @returns {object} learn 状态
 */
export function finishLearn(ctx, result = null) {
    const state = getState(ctx);
    state.learn.lastRun = normalizeLastRun({ at: Date.now(), ...(result ?? {}) });
    return state.learn;
}

/** 最近一次学习的结果；没学过时返回 null */
export function getLastLearnRun(ctx) {
    const run = getState(ctx).learn.lastRun;
    return run ? { ...run } : null;
}

/**
 * 运行时标记：此刻有没有一场学习会话在跑。
 *
 * 它是**进程级**的，不随对话切换重置：会话只活在一次异步调用里，不落在任何
 * 对话上。工具层靠它判断"现在是不是学习时间"——聊天请求里已经没有任何插件
 * 工具，会话工具是唯一的入口。
 */
let runningLearn = null;

/**
 * 标记学习会话开始 / 结束。传 null 表示结束。
 * @param {{ reason?: string, startedAt?: number }|null} info
 */
export function markLearningRunning(info = null) {
    runningLearn = info
        ? { reason: String(info.reason ?? ''), startedAt: Number(info.startedAt) || Date.now() }
        : null;
    return runningLearn;
}

/** 正在跑的那一场的简述；空闲时 null */
export function getLearningRunning() {
    return runningLearn ? { ...runningLearn } : null;
}

/**
 * 工具层问的"现在能不能写"。
 *
 * 以前它表示"学习模式开着"，现在表示"有一场学习会话正在跑"：聊天里既没有
 * 提示词也没有工具，模型只有在这个窗口里才可能调用它们。
 */
export function isLearningActive() {
    return Boolean(runningLearn);
}

/** 有没有打开一个对话（没有对话时 chat_metadata 是空对象，写进去会丢） */
export function isChatAvailable(ctx) {
    try {
        return Boolean(ctx.getCurrentChatId?.());
    } catch {
        return false;
    }
}

/**
 * 保存对话元数据。
 * ST 里 saveMetadata() 本身就是 saveChatConditional() 的别名，
 * 两者都会把 chat_metadata 写进聊天文件的 header。
 */
export function saveChat(ctx) {
    if (!isChatAvailable(ctx)) {
        return false;
    }

    try {
        const save = ctx.saveChat ?? ctx.saveMetadata;
        const result = save?.call(ctx);
        if (result && typeof result.catch === 'function') {
            result.catch(err => console.error('[Thrive] 保存对话元数据失败', err));
        }
        return true;
    } catch (err) {
        console.error('[Thrive] 保存对话元数据失败', err);
        return false;
    }
}

/* ------------------------------------------------------------------ 读取登记 */

/**
 * reads 的键，四类：
 *
 *   desc                                  角色描述全文的哈希（整段重写的前置）
 *   seen:desc                             看过描述这件事本身（任意视图；追加的前置）
 *   pat:desc:<flags>:<h>                  某个正则预读命中过（替换的前置）
 *   book:<name>                           看过这本书（新建条目的前置）
 *   lore:<book>|<title>                   条目全文的哈希（整段重写的前置）
 *   seen:lore:<book>|<title>              目录里见过这条标题（追加的前置）
 *   pat:lore:<book>|<title>:<flags>:<h>   某条目的某个正则预读命中过
 *
 * 分四级的理由：读得越少，能做的写入必须越少。只看过标题就允许整段覆盖，
 * "先读后写"就只是一句口号。写在 tools.js 里的守卫顺序与本表一一对应。
 */
export const READ_KEY_DESC = 'desc';

/** 看过角色描述（任意视图，含正则命中） */
export const DESC_SEEN = 'seen:desc';

/** 用户每发一条消息就清空：工具调用（含 ST 的递归续生成）都算同一轮 */
export function resetReads(ctx) {
    getState(ctx).reads = {};
}

/** 本轮有没有读过该目标；返回读取时记录的内容哈希 */
export function getReadHash(ctx, key) {
    const reads = getState(ctx).reads;
    const hash = reads?.[key];
    return typeof hash === 'string' && hash ? hash : null;
}

/** 登记"本轮读过，内容是这个哈希" */
export function setReadHash(ctx, key, hash) {
    getState(ctx).reads[key] = String(hash);
}

/**
 * 作废一条读取登记。
 *
 * 用于"插件替用户改了内容"之后（比如从快照恢复）：装作读过等于骗过版本校验，
 * 下一次写入就会基于模型没见过的文本覆盖磁盘。作废之后模型必须重新读一次。
 */
export function clearReadHash(ctx, key) {
    const reads = getState(ctx).reads;
    if (reads && Object.hasOwn(reads, key)) {
        delete reads[key];
        return true;
    }
    return false;
}

/**
 * 世界书读取登记的键：`lore:<book>|<title>`。
 * 书名与标题都可能含 `|`，所以只用第一个 `|` 分隔，解析时按后者处理。
 */
export function loreReadKey(book, title) {
    return `lore:${String(book ?? '')}|${String(title ?? '')}`;
}

/**
 * 书级标记：`book:<name>`。
 *
 * 条目级的键回答"这条正文我读过没有"；新建条目时那条记录压根不存在，
 * 条目级无从校验，所以再加一个书级标记回答"这本书本轮看过没有"。
 * 少了它，场景 1（书里还没有这条 → 读完发现没有 → 新建）会永远卡在
 * READ_REQUIRED：读完一本书但一无所获，在 reads 里留不下任何痕迹。
 */
export function bookReadKey(book) {
    return `book:${String(book ?? '')}`;
}

/** 书级标记的值：只需存在，不参与比对 */
export const BOOK_SEEN = 'seen';

/**
 * 某个条目的"标题见过"标记：`seen:lore:<book>|<title>`。
 *
 * 与 `loreReadKey` 分开是因为授权的动作不同：见过标题只允许**追加**，
 * 整段改写还得读过全文。两者共用一个键就会出现"看了一眼目录就能覆盖全文"。
 */
export function loreSeenKey(book, title) {
    return `seen:lore:${String(book ?? '')}|${String(title ?? '')}`;
}

/**
 * 正则预读标记：`pat:desc:<flags>:<hash>` / `pat:lore:<book>|<title>:<flags>:<hash>`。
 *
 * 存 pattern 的哈希而不是 pattern 本身：reads 会随聊天记录落盘，没必要把
 * 用户/模型写的正则原文也存一份。
 */
export function descPatternKey(flags, pattern) {
    return `pat:desc:${normalizeFlags(flags)}:${fnv1a(pattern)}`;
}

export function lorePatternKey(book, title, flags, pattern) {
    return `pat:lore:${String(book ?? '')}|${String(title ?? '')}:${normalizeFlags(flags)}:${fnv1a(pattern)}`;
}

/** 前缀要按同一套规则生成，否则清不掉 */
export function descPatternPrefix() {
    return 'pat:desc:';
}

export function lorePatternPrefix(book, title) {
    return `pat:lore:${String(book ?? '')}|${String(title ?? '')}:`;
}

/**
 * flags 规范化：只留顺序稳定的 i/m/s/u。
 *
 * 与 regex.js 的 normalizeFlags 同义，但 store 不能反过来依赖 regex（正则模块是
 * 纯函数，不该知道读取登记的存在）。两边都做一次，是为了让"读"和"写"用同一个键。
 */
function normalizeFlags(raw) {
    const allowed = 'imsug'.split('');
    const chars = String(raw ?? '').toLowerCase().split('');
    return Array.from(new Set(chars.filter(char => allowed.includes(char)))).sort().join('');
}

/**
 * 删掉某一类读取登记（按前缀）。
 *
 * 用在"插件替模型改了内容"之后：正文变了，之前预读过的正则命中位置和数量
 * 都可能不再成立，继续留着等于默许它按旧的认知去替换。
 */
export function clearReadKeysByPrefix(ctx, prefix) {
    const reads = getState(ctx).reads;
    if (!reads) {
        return 0;
    }

    const wanted = String(prefix ?? '');
    if (!wanted) {
        return 0;
    }

    let removed = 0;
    for (const key of Object.keys(reads)) {
        if (key.startsWith(wanted)) {
            delete reads[key];
            removed++;
        }
    }
    return removed;
}

/* ------------------------------------------------------------------ 备份槽位 */

/**
 * 直写前把原值存起来，只留 1 版。
 * 这是"手滑保险"，不是版本控制：不阻止任何写入，成本只有一个槽位（ADR-016）。
 * @param {object} ctx
 * @param {string} before 写入前的描述全文
 */
export function rememberDescBackup(ctx, before) {
    getState(ctx).backups.desc = [{ before: String(before ?? ''), at: Date.now() }];
    notifyPanel();
}

/**
 * 世界书写入前压一份快照，同时充当面板"已写入"列表里的一条记录。
 *
 * 与描述不同，这里留 10 条：模型没有删除工具（ADR-011），写错的条目要么靠这份
 * 快照找回，要么请用户去世界书编辑器里手动清理。新建时 `before` 为空串，
 * `action = created` —— 恢复它等于把这条从书里删掉，那只发生在用户点「撤销新建」时，
 * 是用户的撤销动作，不是给模型的工具能力（ADR-022）。
 *
 * `layer` 由调用方给（`draft.js` 的 layerFor）：写的是缓冲区还是真实世界书，
 * 决定这条记录还能不能被恢复（见 normalizeLoreBackup）。
 *
 * @param {object} ctx
 * @param {{ book: string, title: string, before: string, beforeKeys?: string[],
 *           action?: 'created'|'rewritten', layer?: 'disk'|'draft', chars?: number }} snapshot
 * @returns {object} 记下来的那条记录
 */
export function rememberLoreBackup(ctx, snapshot = {}) {
    const list = getState(ctx).backups.lore;
    const limit = loreBackupLimit(ensureSettings(ctx));

    const record = normalizeLoreBackup({
        id: createBackupId(),
        book: snapshot.book,
        title: snapshot.title,
        action: snapshot.action,
        layer: snapshot.layer,
        before: snapshot.before,
        beforeKeys: snapshot.beforeKeys,
        chars: snapshot.chars,
        at: Date.now(),
    }, 0);

    list.unshift(record);

    // 超出上限丢最旧的。unshift 之后尾部就是最旧的
    if (list.length > limit) {
        list.length = limit;
    }

    // 写入发生在生成过程中，面板不会自己知道有新记录
    notifyPanel(record);
    return record;
}

/** 写入记录（新的在前）。只读副本——面板不该直接改 state 里的对象 */
export function getLoreBackups(ctx) {
    return getState(ctx).backups.lore.map(item => ({ ...item }));
}

/** 按 id 取一条记录 */
export function findLoreBackup(ctx, id) {
    const wanted = String(id ?? '');
    return getState(ctx).backups.lore.find(item => item.id === wanted) ?? null;
}

/** 标记某条记录已恢复：面板改成"已恢复 <时间>"，不再给按钮 */
export function markLoreBackupRestored(ctx, id) {
    const record = getState(ctx).backups.lore.find(item => item.id === String(id ?? ''));
    if (!record) {
        return false;
    }
    record.restoredAt = Date.now();
    return true;
}

/**
 * 丢掉属于缓冲区的那批写入记录。
 *
 * 缓冲区一旦保存或丢弃，这些记录的 `before` 指的就是"缓冲区里当时的样子"，
 * 而那块缓冲区已经不存在了。留着它们，面板会挂出一颗点了必然报错的按钮
 * （恢复的目标层已经没了），用户还得读一段解释才知道为什么点了没反应。
 *
 * 保存时另有一批 `layer: disk` 的记录补进来，所以"已写入"不会变空——
 * 它换成的是"这次保存到底动了哪几条"。
 *
 * @param {object} ctx
 * @returns {number} 丢掉了几条
 */
export function dropDraftBackups(ctx) {
    const state = getState(ctx);
    const list = state.backups.lore;
    const kept = list.filter(item => item.layer !== 'draft');
    state.backups.lore = kept;
    return list.length - kept.length;
}

/** 描述的上一版（1 槽）；没有时返回 null */
export function getDescBackup(ctx) {
    const list = getState(ctx).backups.desc;
    const backup = list[0];
    if (!backup || typeof backup.before !== 'string') {
        return null;
    }
    return { before: backup.before, at: Number(backup.at) > 0 ? Number(backup.at) : 0 };
}

function createBackupId() {
    return `b${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

