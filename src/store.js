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

import { notifyPanel } from './events.js';
import { LIMIT_DEFAULTS, readLimit } from './limits.js';

export const MODULE_NAME = 'thrive';

/**
 * 本步骤只需要这几项设置。后续步骤（模块开关、写入目标、长度上限等）
 * 会往 DEFAULT_SETTINGS 里继续补，ensureSettings 的补全逻辑不用改。
 */
export const DEFAULT_SETTINGS = Object.freeze({
    /** 新对话默认是否开启学习模式 */
    enabledByDefault: false,
    /** 输入框旁是否显示状态徽章 */
    showBadge: true,
    /**
     * 被动学习总开关。与"主动"（对话级 enabled）是两套独立的开关，可以同时开：
     * 主动开着时被动不再触发，但配置本身保留，关掉主动就立刻恢复。
     */
    passiveEnabled: false,
    /** 被动学习：每多少条消息触发一次；0 = 不用条数触发 */
    passiveInterval: 0,
    /** 被动学习：关键词，逗号/分号/换行分隔；空 = 不用关键词触发 */
    passiveKeywords: '',
    /** 学习块注入位置：tail / head / none */
    blockPosition: 'tail',
    /**
     * 学习块正文。空串 = 使用 prompt.js 里的 DEFAULT_BLOCK。
     * 存空串而不是存整段默认文本，默认文本随版本更新时老用户也能拿到新版。
     */
    blockText: '',
    /** 角色描述模块开关。Step 07 会把模块权限补齐 */
    moduleDescription: true,
    /**
     * 描述改动是否先暂存成 patch。
     * 关掉之后 desc_write 回到直写（Step 04 行为），文案从 staged 换成 applied。
     */
    patchEnabled: true,
    /** 世界书模块开关 */
    moduleWorldbook: true,
    /** 可写世界书；空 = 世界书模块未就绪，相关工具不注册 */
    writableBook: '',
    /** 读范围：writable 只看可写书 / bound 含当前角色绑定的其他书 */
    readScope: 'writable',
    /** 新建条目的插入位置：0 角色定义前 / 1 角色定义后 / 2 作者注释顶 / 3 作者注释底 */
    entryPosition: 0,
    /**
     * 所有"写多少 / 读多少"的数值上限。默认值与取值范围由 limits.js 定义，
     * 设置页「数值与上限」直接对着它渲染；这里铺开是为了让 ensureSettings
     * 的类型补全也覆盖到它们（老用户没有这些键，缺一个就会被当成 0）。
     */
    ...LIMIT_DEFAULTS,
    /**
     * 超过软/硬上限时追加的压缩指令。
     * 空串 = 使用 compact.js 里的 DEFAULT_COMPACT_PROMPT（理由同 blockText）。
     */
    compactPrompt: '',
    /**
     * 发下一条消息时把旧工具日志移出上下文（ADR-013）。
     * 关掉之后按 ST 原生行为保留在上下文里——看得见，但会一直占 token。
     */
    dropTraces: true,
    /**
     * 记录面板的布局。位置/尺寸是按屏幕算的，与具体对话无关，所以放全局设置：
     *   panelX / panelY  -1 = 还没拖过，走样式里的右下角；否则是左上角像素坐标
     *   panelWidth       展开时的宽度（窄屏会被 `min(…, 92vw)` 再收一次）
     *   panelHeight      展开时的最大高度
     *   panelOpacity     整块面板的不透明度，调低可以透出后面的聊天内容
     */
    panelX: -1,
    panelY: -1,
    panelWidth: 480,
    panelHeight: 620,
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
        before,
        beforeKeys: Array.isArray(raw.beforeKeys) ? raw.beforeKeys.map(String) : [],
        chars: Number(raw.chars) > 0 ? Number(raw.chars) : 0,
        at,
        restoredAt: Number(raw.restoredAt) > 0 ? Number(raw.restoredAt) : null,
    };
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

    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        // 用类型比对而不是 undefined 判断：手改过 settings.json 存进去的 "false" 也能被纠正
        if (typeof settings[key] !== typeof fallback) {
            settings[key] = fallback;
            dirty = true;
        }
    }

    if (dirty) {
        ctx.saveSettingsDebounced?.();
    }

    return settings;
}

/**
 * 至少有一个可写模块。两个都关时整个扩展没有意义，开关要置灰。
 *
 * 纯判定、不碰 DOM，所以放在 store 而不是界面层：设置页、徽章、面板、状态摘要
 * 都要用它，放在任何一处界面文件里都会让其余几处反过来依赖那一处。
 *
 * @param {object} settings
 */
export function hasAnyModule(settings) {
    return settings?.moduleWorldbook !== false || settings?.moduleDescription !== false;
}

/**
 * 被动学习的对话状态。
 *   baseline            上一次"学过 / 已同步"时的可见消息条数；-1 = 还没初始化
 *   pending             已经触发、等待下一轮消耗的一次性学习；null = 没有
 *   lastLearnedUserHash 刚学完的那一轮的用户消息哈希，用来避免同一轮重复触发
 *
 * baseline 存"条数快照"而不是"已累计几条"：用户删消息、编辑消息之后，
 * 用差值算出来的进度会自动跟上，不会因为我们自己记了个计数器而永远对不上。
 */
export const PASSIVE_BASELINE_NONE = -1;

export const PENDING_REASONS = Object.freeze(['interval', 'keyword', 'manual']);

function createPassiveState() {
    return {
        baseline: PASSIVE_BASELINE_NONE,
        pending: null,
        lastLearnedUserHash: '',
    };
}

/**
 * 规范 passive 状态。老聊天文件里没有这个字段，手改过的可能只有半个对象——
 * 一律补成完整形状，缺的按"没有待学习"处理。
 *
 * 就地改写并返回**同一个对象**（形状不认识时才换新的）：
 * getState 每次都会调它，如果每次返回新对象，调用方手里那个引用就会在
 * 下一次 getState 之后变成孤儿——写进去的 pending / baseline 会凭空消失。
 *
 * @param {unknown} raw
 */
function normalizePassive(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const baseline = Number(source.baseline);
    const rawPending = isPlainObject(source.pending) ? source.pending : null;

    source.baseline = Number.isFinite(baseline) && baseline >= 0
        ? Math.floor(baseline)
        : PASSIVE_BASELINE_NONE;

    source.pending = rawPending
        ? {
            reason: PENDING_REASONS.includes(rawPending.reason) ? rawPending.reason : 'manual',
            // 只在关键词触发时才有意义，其他原因是空串
            keyword: typeof rawPending.keyword === 'string' ? rawPending.keyword : '',
            at: Number(rawPending.at) > 0 ? Number(rawPending.at) : 0,
            // "已经进过一次非 dryRun 生成"，结算时用它决定要不要记进 lastLearnedUserHash
            used: rawPending.used === true,
        }
        : null;

    source.lastLearnedUserHash = typeof source.lastLearnedUserHash === 'string'
        ? source.lastLearnedUserHash
        : '';

    return source;
}

/**
 * 新建一份对话状态。字段与默认值以本文件为准（spec §4 不列清单），
 * 这样后续步骤加字段时不需要写迁移。
 * @param {object} settings
 */
export function createChatState(settings) {
    return {
        enabled: Boolean(settings.enabledByDefault),
        reads: {},
        lastBook: null,
        patch: null,
        backups: { lore: [], desc: [] },
        passive: createPassiveState(),
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

    // 被动学习：老对话没有这个字段，补一份"没有待学习、也没累计进度"的空状态
    state.passive = normalizePassive(state.passive);

    return state;
}

/** 当前对话是否开着学习模式 */
export function isEnabled(ctx) {
    return getState(ctx).enabled === true;
}

/* ---------------------------------------------------------------- 被动学习 */
/*
 * 被动学习的"状态"放在这里，"怎么判断该不该触发"放在 passive.js：
 * store 只管读写，不引入消息扫描逻辑，避免 store ↔ passive 互相 import。
 */

/** 被动学习的对话状态（可直接改，改完记得 saveChat） */
export function getPassive(ctx) {
    return getState(ctx).passive;
}

/** 有一次已触发、还没消耗的学习。它为 true 时注入与工具门控都当作"已开启" */
export function isPending(ctx) {
    return Boolean(getState(ctx).passive.pending);
}

/** 待学习的详情，没有时返回 null */
export function getPending(ctx) {
    const pending = getState(ctx).passive.pending;
    return pending ? { ...pending } : null;
}

/**
 * 挂上一次待学习。
 *
 * 已有待学习时不覆盖：同一个待学习期内两条触发路径只该响一次，
 * 否则"关键词 + 条数"同时命中会让计数被莫名其妙地重置两次。
 *
 * @param {object} ctx
 * @param {{ reason: string, keyword?: string }} info
 * @returns {boolean} 是否真的挂上了
 */
export function setPending(ctx, info = {}) {
    const passive = getState(ctx).passive;
    if (passive.pending) {
        return false;
    }

    const reason = PENDING_REASONS.includes(info.reason) ? info.reason : 'manual';
    passive.pending = {
        reason,
        keyword: reason === 'keyword' ? String(info.keyword ?? '') : '',
        at: Date.now(),
        used: false,
    };
    return true;
}

/** 标记"这次待学习已经进入生成"，结算时用它区分 dryRun 与真正的学习轮 */
export function markPendingUsed(ctx) {
    const pending = getState(ctx).passive.pending;
    if (!pending) {
        return false;
    }
    pending.used = true;
    return true;
}

/** 丢掉待学习（用户主动取消、或主动模式被打开时） */
export function clearPending(ctx) {
    const passive = getState(ctx).passive;
    if (!passive.pending) {
        return false;
    }
    passive.pending = null;
    return true;
}

/**
 * "模型现在该看到学习块、该拿到工具吗"。
 *
 * 两个入口：主动开关（对话级 enabled）与被动学习的一次性待命（pending）。
 * 注入和 shouldRegister 都必须走这一个判断，否则会出现"块注入了但工具没注册"
 * 这类半开半关的状态。
 */
export function isLearningActive(ctx) {
    const state = getState(ctx);
    return state.enabled === true || Boolean(state.passive.pending);
}

/**
 * 切换开关并落盘。
 *
 * 打开主动模式时顺手丢掉待学习：主动已经覆盖了这一轮，留着它只会在关掉主动之后
 * 突然又冒出一轮"临时学习"，看起来像开关失灵。
 * @param {object} ctx
 * @param {boolean} enabled
 */
export function setEnabled(ctx, enabled) {
    const state = getState(ctx);
    state.enabled = Boolean(enabled);
    if (state.enabled) {
        state.passive.pending = null;
    }
    saveChat(ctx);
    return state;
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
 * reads 的键。世界书用 `lore:<book>|<title>`，角色描述用 `desc`。
 */
export const READ_KEY_DESC = 'desc';

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
 * @param {object} ctx
 * @param {{ book: string, title: string, before: string, beforeKeys?: string[],
 *           action?: 'created'|'rewritten', chars?: number }} snapshot
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

