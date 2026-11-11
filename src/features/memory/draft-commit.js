/** draft-commit.js · Internal memory module; public entry: index.js. */

import { DRAFT_LAYER, clearDraft, cloneEntries, getDraft, hashEntries } from './draft.js';

import { notifyPanel } from '../../shared/events.js';

import { dropDraftBackups, rememberLoreBackup, saveChat } from '../settings/index.js';

import { getWritableBook } from './target-selection.js';

import { entryTitle } from './lore-entry.js';

import { loadBookFromDisk, persistBookOnDisk } from './lore-repository.js';

/* -------------------------------------------- 虚拟世界书：比对与保存 */

/** `selectiveLogic` → 界面上的说法，与 SELECTIVE_LOGIC 互为反向 */
const LOGIC_LABELS = Object.freeze({
    0: '任一命中',
    1: '不全命中',
    2: '全不命中',
    3: '全部命中',
});

/**
 * 缓冲区窗口要的那份数据：真实世界书 vs 缓冲区，逐条比。
 *
 * 比的是**磁盘此刻**的样子，不是"缓冲区开出来时的样子"：
 *   - 用户想看的正是"点保存会发生什么"，而保存会把磁盘整本换成缓冲区；
 *   - 开出来之后用户在世界书编辑器里改过什么，也会如实地出现在差异里
 *     （`diskChanged` 会说清楚"这些是你自己改的，保存会覆盖掉"）。
 *
 * 条目按 uid 对齐：文件名、key 顺序、条目在数组里的位置都可能变，uid 不会。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, exists: false } | { ok: true, exists: true, book: string,
 *            diskChanged: boolean, items: Array<object>, changed: Array<object>,
 *            counts: object, createdAt: number, updatedAt: number, writable: string }
 *          | { ok: false, error: string, hint?: string, book: string }>}
 */
async function buildDraftView(ctx) {
    const draft = getDraft(ctx);
    if (!draft) {
        return { ok: true, exists: false };
    }

    const disk = await loadBookFromDisk(ctx, draft.book);
    if (!disk.ok) {
        // 书被删了 / 改名了：缓冲区还在，但没有可以对照与保存的目标了
        return { ok: false, error: disk.error, hint: disk.hint, book: draft.book };
    }

    const items = diffBooks(disk.data.entries, draft.entries, draft.touched);
    const changed = items.filter(item => item.status !== 'same');

    return {
        ok: true,
        exists: true,
        book: draft.book,
        diskChanged: Boolean(draft.baseHash) && hashEntries(disk.data.entries) !== draft.baseHash,
        items,
        changed,
        counts: {
            total: items.length,
            added: changed.filter(item => item.status === 'added').length,
            changed: changed.filter(item => item.status === 'changed').length,
            removed: changed.filter(item => item.status === 'removed').length,
        },
        createdAt: Number(draft.createdAt) || 0,
        updatedAt: Number(draft.updatedAt) || 0,
        writable: getWritableBook(ctx),
    };
}

/**
 * 把缓冲区保存成真实世界书。
 *
 * 三件事，顺序不能换：
 *   1. 先读磁盘、比指纹。开出来之后磁盘被别处改过就不写，除非用户明确要求覆盖——
 *      覆盖会把别人（往往是用户自己在世界书编辑器里）的改动整段冲掉。
 *   2. 写盘（整本替换，与"这就是那本书"的心智模型一致）。
 *   3. 逐条补一份 `layer: disk` 的快照，再清掉缓冲区。
 *
 * 第 3 步是这次保存唯一的退路：缓冲区消失之后，"刚才那一下到底改了哪几条"只能靠
 * 这些记录回答，面板的「已写入 → 恢复写入前」正是照它们来的。
 *
 * @param {object} ctx
 * @param {{ force?: boolean }} [options] force = 明知磁盘变了也照写
 * @returns {Promise<{ ok: true, action: 'committed'|'empty', book: string, written: number,
 *                     added: number, removed: number, editor?: object }
 *          | { ok: false, error: string, hint?: string }>}
 */
async function commitDraft(ctx, options = {}) {
    const draft = getDraft(ctx);
    if (!draft) {
        return { ok: false, error: 'NO_DRAFT', hint: '虚拟世界书里没有待保存的改动。' };
    }

    if (typeof ctx.saveWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: '当前 ST 没有向扩展暴露 saveWorldInfo，写不进真实世界书。',
        };
    }

    const disk = await loadBookFromDisk(ctx, draft.book);
    if (!disk.ok) {
        return disk;
    }

    const diskHash = hashEntries(disk.data.entries);
    if (options.force !== true && draft.baseHash && diskHash !== draft.baseHash) {
        return {
            ok: false,
            error: 'DISK_CHANGED',
            hint: `真实世界书「${draft.book}」在虚拟世界书开出来之后被改动过。再确认一次才会覆盖那些改动。`,
        };
    }

    const items = diffBooks(disk.data.entries, draft.entries, draft.touched);
    const changed = items.filter(item => item.status !== 'same');

    if (changed.length === 0) {
        clearDraft(ctx);
        dropDraftBackups(ctx);
        saveChat(ctx);
        return { ok: true, action: 'empty', book: draft.book, written: 0, added: 0, removed: 0 };
    }

    const data = { ...disk.data, entries: cloneEntries(draft.entries) };
    const saved = await persistBookOnDisk(ctx, draft.book, data);
    if (!saved.ok) {
        return saved;
    }

    for (const item of changed) {
        rememberLoreBackup(ctx, {
            book: draft.book,
            title: item.title || item.titleBefore,
            action: item.status === 'added' ? 'created' : 'rewritten',
            layer: DRAFT_LAYER.DISK,
            before: item.status === 'added' ? '' : item.before,
            beforeKeys: item.status === 'added' ? [] : item.keysBefore,
            chars: String(item.after ?? '').length,
        });
    }

    clearDraft(ctx);
    // 保存完，缓冲区那一层的记录已经指不到任何东西了；刚补的 disk 记录留着
    dropDraftBackups(ctx);
    saveChat(ctx);

    return {
        ok: true,
        action: 'committed',
        book: draft.book,
        written: changed.length,
        added: changed.filter(item => item.status === 'added').length,
        removed: changed.filter(item => item.status === 'removed').length,
        editor: saved.editor,
    };
}

/**
 * 丢弃缓冲区：真实世界书一个字都不动。
 *
 * 不弹确认（那在界面里做）：这是模块层的动作，它只负责把状态收干净。
 *
 * @param {object} ctx
 * @returns {{ ok: true } | { ok: false, error: string, hint?: string }}
 */
function discardDraft(ctx) {
    if (!getDraft(ctx)) {
        return { ok: false, error: 'NO_DRAFT', hint: '虚拟世界书里没有待丢弃的改动。' };
    }

    clearDraft(ctx);
    dropDraftBackups(ctx);
    saveChat(ctx);
    notifyPanel();
    return { ok: true };
}

/**
 * 两层条目逐条比对。
 *
 * 只比"工具会改的字段"（标题、正文、关键词、组合方式、常驻、停用）：order / position
 * 这类东西工具从来不碰，它们不同只说明用户在编辑器里调过，不该算成缓冲区的改动。
 *
 * `bufferTouched` 区分"这条是工具改的"和"这条是磁盘那边被改过、缓冲区还停在旧版本"。
 * 两者在界面上都表现为差异，但含义完全不同：前者是这次要保存的东西，后者是保存会
 * 覆盖掉的东西。合成一个"改写"会让人以为模型动过它。
 *
 * @param {object} diskEntries
 * @param {object} draftEntries
 * @param {object} [touched] draft.touched：被工具动过的 uid
 * @returns {Array<object>} 有改动的在前，同状态下按 uid 升序
 */
function diffBooks(diskEntries, draftEntries, touched = {}) {
    const disk = indexByUid(diskEntries);
    const next = indexByUid(draftEntries);
    const units = new Set([...disk.keys(), ...next.keys()]);
    const items = [];

    for (const unit of units) {
        const left = disk.get(unit);
        const right = next.get(unit);

        items.push({
            uid: Number(unit),
            status: !left ? 'added' : !right ? 'removed' : sameEntry(left.entry, right.entry) ? 'same' : 'changed',
            bufferTouched: Boolean(touched?.[unit]),
            title: entryTitle(right?.entry ?? left.entry),
            titleBefore: left ? entryTitle(left.entry) : '',
            keys: keyList(right?.entry),
            keysBefore: keyList(left?.entry),
            logic: logicLabel(right?.entry ?? left.entry),
            logicBefore: logicLabel(left?.entry),
            disabled: (right?.entry ?? left.entry)?.disable === true,
            constant: (right?.entry ?? left.entry)?.constant === true,
            before: String(left?.entry?.content ?? ''),
            after: String(right?.entry?.content ?? ''),
        });
    }

    const order = { added: 0, changed: 1, removed: 2, same: 3 };
    items.sort((a, b) => (order[a.status] - order[b.status])
        || (Number.isFinite(a.uid) ? a.uid : 0) - (Number.isFinite(b.uid) ? b.uid : 0));

    return items;
}

/** 按 uid 索引；没有 uid 的条目退回用它在 entries 里的键（老文件里可能真有） */
function indexByUid(entries) {
    const map = new Map();
    for (const [key, entry] of Object.entries(entries ?? {})) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const uid = Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : Number(key);
        map.set(String(Number.isFinite(uid) ? uid : key), { key, entry });
    }
    return map;
}

function keyList(entry) {
    return Array.isArray(entry?.key) ? entry.key.map(String) : [];
}

function logicLabel(entry) {
    return LOGIC_LABELS[Number(entry?.selectiveLogic)] ?? LOGIC_LABELS[0];
}

function sameEntry(left, right) {
    if (String(left?.content ?? '') !== String(right?.content ?? '')) {
        return false;
    }
    if (String(left?.comment ?? '') !== String(right?.comment ?? '')) {
        return false;
    }
    if (Number(left?.selectiveLogic ?? 0) !== Number(right?.selectiveLogic ?? 0)) {
        return false;
    }
    if ((left?.disable === true) !== (right?.disable === true)) {
        return false;
    }
    if ((left?.constant === true) !== (right?.constant === true)) {
        return false;
    }

    const a = keyList(left);
    const b = keyList(right);
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

export { buildDraftView, commitDraft, discardDraft };
