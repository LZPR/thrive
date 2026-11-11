/** chat-store.js · Internal settings module; public entry: index.js. */

import { DESC_STORAGE } from '../../desc-entry.js';

import { MODULE_NAME } from './defaults.js';

import { createLearnState, isPatchState, isPlainObject, loreBackupLimit, normalizeDescStorage, normalizeDraft, normalizeLearn, normalizeLoreBackup } from './normalization.js';

import { ensureSettings } from './settings-store.js';

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

/**
 * 新建一份对话状态。字段与默认值以本文件为准（spec §4 不列清单），
 * 这样后续步骤加字段时不需要写迁移。
 * @param {object} settings
 */
function createChatState(settings) {
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
function getState(ctx) {
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
function isEnabled(ctx) {
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
function descStorageMode(ctx) {
    return normalizeDescStorage(getState(ctx).descStorage);
}

/** 是否统一模式（描述存到角色同名书的常驻条目里） */
function isWorldbookDesc(ctx) {
    return descStorageMode(ctx) === DESC_STORAGE.WORLDBOOK;
}

/**
 * 切换存储模式并落盘。
 *
 * 只改"从哪儿读写"，不搬内容（ADR-042）：两边的正文各自留在原地。
 * @param {object} ctx
 * @param {'card'|'worldbook'} mode
 */
function setDescStorageMode(ctx, mode) {
    const state = getState(ctx);
    state.descStorage = normalizeDescStorage(mode);
    dropLegacyChatValue(ctx, 'descStorage');
    saveChat(ctx);
    return state.descStorage;
}

/** 这一场对话选的可写世界书；空串 = 还没选 */
function getWritableBookSetting(ctx) {
    return String(getState(ctx).writableBook ?? '').trim();
}

/**
 * 设置这一场对话的可写世界书并落盘。空串 = 清掉选择。
 * @param {object} ctx
 * @param {string} book
 */
function setWritableBookSetting(ctx, book) {
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
function getDraftState(ctx) {
    return getState(ctx).draft;
}

/**
 * 覆盖缓冲区。传 null 表示清空。
 * 只写内存，落盘交给调用方（它知道要不要顺带作废别的登记）。
 */
function setDraftState(ctx, draft) {
    getState(ctx).draft = draft;
}

/** 有没有打开一个对话（没有对话时 chat_metadata 是空对象，写进去会丢） */
function isChatAvailable(ctx) {
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
function saveChat(ctx) {
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

export { createChatState, getState, isEnabled, descStorageMode, isWorldbookDesc, setDescStorageMode, getWritableBookSetting, setWritableBookSetting, getDraftState, setDraftState, isChatAvailable, saveChat };
