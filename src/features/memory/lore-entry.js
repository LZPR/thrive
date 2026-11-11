/** lore-entry.js · Internal memory module; public entry: index.js. */

import { isReservedEntry } from '../../desc-entry.js';

function uidOf(entry) {
    const uid = Number(entry?.uid);
    return Number.isFinite(uid) ? uid : 0;
}

/**
 * 条目标题：优先 comment（写入时也用它做 upsert 主键），
 * 其次第一个关键词，最后退回 uid —— 至少让模型能区分彼此。
 */
function entryTitle(entry) {
    const comment = String(entry?.comment ?? '').trim();
    if (comment) {
        return comment;
    }

    const firstKey = Array.isArray(entry?.key) ? String(entry.key[0] ?? '').trim() : '';
    return firstKey || `条目 #${uidOf(entry)}`;
}

/* ----------------------------------------------------------- 世界书 · 写入 */

/** `logic` 参数 → `selectiveLogic` */
const SELECTIVE_LOGIC = Object.freeze({ any: 0, not_all: 1, not_any: 2, all: 3 });

/**
 * 按标题找条目。标题取 `comment`，比较前两边都 trim。
 *
 * 同书内理论上标题唯一，实际手写完可以重名 —— 取 uid 最小的那条，
 * 之后所有改写都落在它身上，不会每次换一条。
 *
 * 默认**跳过**角色描述的保留条目：这条对 lore_* 工具不可见。只有 desc.js 与
 * "恢复写入前"这种明确知道自己在干什么的调用点才传 `includeReserved: true`。
 *
 * @param {object} data
 * @param {string} title
 * @param {{ includeReserved?: boolean }} [options]
 * @returns {{ key: string, uid: number, entry: object } | null}
 */
function findLoreEntry(data, title, options = {}) {
    const wanted = String(title ?? '').trim();
    if (!wanted) {
        return null;
    }

    const includeReserved = options.includeReserved === true;
    let found = null;

    for (const [key, entry] of Object.entries(data?.entries ?? {})) {
        if (!entry) {
            continue;
        }
        if (!includeReserved && isReservedEntry(entry)) {
            continue;
        }
        if (String(entry.comment ?? '').trim() !== wanted) {
            continue;
        }

        const uid = Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : Number(key);
        if (!found || uid < found.uid) {
            found = { key, uid, entry };
        }
    }

    return found;
}

/** 下一个可用 uid：现有数字 uid 的最大值 + 1；空书从 0 开始（与 ST 一致） */
function nextLoreUid(data) {
    const uids = Object.values(data?.entries ?? {})
        .map(entry => Number(entry?.uid))
        .filter(uid => Number.isFinite(uid));

    return uids.length ? Math.max(...uids) + 1 : 0;
}

function clampEntryPosition(value) {
    const position = Number(value);
    if (!Number.isFinite(position)) {
        return 0;
    }
    return Math.min(3, Math.max(0, Math.trunc(position)));
}

/**
 * 新建条目。固定值就定义在这里（spec 不抄清单），其余字段照 ST 1.19 的条目模板补齐。
 *
 * `triggers` 容易被漏掉，但 1.19 的部分生成类型会读它，
 * 缺字段的条目会静默不生效，所以必须显式写空数组。
 */
function buildNewLoreEntry(settings, fields) {
    return {
        uid: fields.uid,
        key: fields.keys,
        keysecondary: [],
        comment: fields.title,
        content: fields.content,
        // ADR-008：常驻锁死 false，模型无权设置
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: SELECTIVE_LOGIC[fields.logic] ?? SELECTIVE_LOGIC.any,
        addMemo: false,
        order: 100,
        position: clampEntryPosition(settings?.entryPosition),
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ignoreBudget: false,
        triggers: [],
    };
}

/**
 * 合并关键词：保留原顺序，追加没出现过的，按上限截断。
 *
 * 去重是必需的：同一批关键词写两遍，条目在世界书里看起来会像"重点强调"，
 * 实际只是把触发词表撑长。
 */
function mergeKeys(existing, incoming, maxKeywords) {
    const keys = Array.isArray(existing) ? existing.map(String) : [];
    const added = [];
    const skipped = [];

    for (const raw of Array.isArray(incoming) ? incoming : []) {
        const key = String(raw ?? '').trim();
        if (!key) {
            continue;
        }
        if (keys.includes(key)) {
            skipped.push(key);
            continue;
        }
        keys.push(key);
        added.push(key);
    }

    const limit = Math.max(1, Number(maxKeywords) || 1);
    const truncated = keys.length > limit;

    return {
        keys: keys.slice(0, limit),
        added: added.slice(0, Math.max(0, limit - (keys.length - added.length))),
        skipped,
        truncated,
    };
}

export { uidOf, entryTitle, findLoreEntry, nextLoreUid, clampEntryPosition, buildNewLoreEntry, mergeKeys };
