/**
 * draft.js · 虚拟世界书（缓冲区）
 *
 * 为什么要有这一层：模型的每一笔世界书写入都会让真实世界书的文件变了、让 ST 的
 * 世界书缓存与提示词前缀缓存失效；而绝大多数写入其实是"这一轮学到的三句话"，
 * 用户要么想改一改，要么根本不想留。中间隔一层缓冲区之后：
 *
 *   真实世界书 ──(用户点「保存」)──▶ 缓冲区 ──(工具)──▶ 模型
 *
 * 规则只有一条，别在别处再判一遍：**工具改的一律是缓冲区，用户点保存才落盘。**
 * 读写路由在 targets.js（loadBook / persistBook 两个入口），这里只负责那块内存状态：
 * 什么时候开、被改过哪几条、什么时候清掉。
 *
 * 不负责的事：跟真实世界书比对（要读盘，在 targets.js），画界面（ui/draft-window.js）。
 */

import { notifyPanel } from './events.js';
import { getDraftState, saveChat, setDraftState } from './store.js';
import { fnv1a } from './util.js';

/**
 * 一份写入记录属于哪一层。快照（store.js 的 backups.lore）用它决定能不能恢复
 * 以及恢复到哪儿——见 targets.js 的 restoreLoreEntry。
 */
export const DRAFT_LAYER = Object.freeze({
    /** 真实世界书 */
    DISK: 'disk',
    /** 虚拟世界书（缓冲区） */
    DRAFT: 'draft',
});

/** 条目里"改了就算改过"的字段。其余（order / position / probability…）工具不碰 */
const SIGNIFICANT = ['comment', 'content', 'key', 'selectiveLogic', 'constant', 'disable'];

/**
 * 拷贝一份条目表。
 *
 * 条目是纯 JSON（ST 写出来的世界书就这样），所以两种拷贝方式都够用；
 * 优先 structuredClone——它不会把 undefined / Date 之类的边角情况拧成字符串。
 *
 * @param {object} entries
 * @returns {object}
 */
export function cloneEntries(entries) {
    const source = entries && typeof entries === 'object' ? entries : {};

    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(source);
        }
    } catch {
        // 有函数 / 循环引用之类的怪东西，退到 JSON
    }

    try {
        return JSON.parse(JSON.stringify(source));
    } catch {
        return { ...source };
    }
}

/**
 * 一整本书的指纹。
 *
 * 用途只有一个：判断"缓冲区开出来之后，真实世界书有没有被别处改过"（用户在世界书
 * 编辑器里改了、另一个标签页改了、别的插件改了）。保存前比一次，不一致就要求用户
 * 再确认一次——否则那次保存会把别人的改动整段冲掉。
 *
 * 只算会被工具改动的字段，且按 uid 排序：条目在文件里的顺序变了不算改动。
 *
 * @param {object} entries
 * @returns {string}
 */
export function hashEntries(entries) {
    const rows = Object.values(entries ?? {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => {
            const view = SIGNIFICANT.map(field => {
                const value = entry[field];
                if (Array.isArray(value)) {
                    return value.map(String).join('\u0001');
                }
                return String(value ?? '');
            });
            return `${Number(entry.uid) || 0}\u0002${view.join('\u0003')}`;
        })
        .sort();

    return fnv1a(rows.join('\u0004'));
}

/** 当前对话的缓冲区；没有时返回 null */
export function getDraft(ctx) {
    return getDraftState(ctx);
}

/** 缓冲区属于哪本书；空串 = 没有缓冲区 */
export function draftBook(ctx) {
    return String(getDraftState(ctx)?.book ?? '');
}

/** 这本书是不是正被缓冲区接管（读写都该走缓冲区） */
export function isDraftBook(ctx, book) {
    const drafted = draftBook(ctx);
    return Boolean(drafted) && drafted === String(book ?? '').trim();
}

/**
 * 一份写入记录该记成哪一层。写快照时传进去，恢复时照着走。
 * @param {object} ctx
 * @param {string} book
 */
export function layerFor(ctx, book) {
    return isDraftBook(ctx, book) ? DRAFT_LAYER.DRAFT : DRAFT_LAYER.DISK;
}

/**
 * 取缓冲区的条目副本（不是引用）。
 *
 * 必须给副本：调用方拿到之后会当场改（追加、替换），改完才交给 persistBook。
 * 直接给 state 里那份，中途失败（超长被拒）就会留下一份被改了一半的缓冲区。
 *
 * @param {object} ctx
 * @param {string} book
 * @returns {object|null} null = 这本书没有缓冲区
 */
export function readDraftEntries(ctx, book) {
    const draft = getDraftState(ctx);
    if (!draft || draft.book !== String(book ?? '').trim()) {
        return null;
    }
    return cloneEntries(draft.entries);
}

/**
 * 开一块缓冲区。调用方负责确认"这本书没有缓冲区"（ensureDraft 会判）。
 *
 * `entries` 必须是**改动之前**的真实世界书内容：它既当第一版内容，也用来算指纹。
 *
 * @param {object} ctx
 * @param {{ book: string, entries: object }} seed
 */
export function openDraft(ctx, { book, entries }) {
    const now = Date.now();
    const seeded = cloneEntries(entries);

    setDraftState(ctx, {
        book: String(book ?? '').trim(),
        entries: seeded,
        baseHash: hashEntries(seeded),
        touched: {},
        createdAt: now,
        updatedAt: now,
    });

    saveChat(ctx);
    notifyPanel();
    return getDraftState(ctx);
}

/**
 * 工具写入前的守卫：该有缓冲区就开一块，不该有就返回错误。
 *
 * 必须在**所有读取守卫之后**、真正改 `data` 之前调用（tools.js 的调用点都在这个位置）：
 *   - 早一点：一次被 READ_REQUIRED 挡住的写入会留下一块空缓冲区，之后用户在世界书
 *     编辑器里改的东西它就再也看不见了；
 *   - 晚一点：`data` 已经被改过，算出来的 baseHash 是"改完之后"的，保存时永远判不出
 *     "磁盘被别处动过"。
 *
 * 同步函数，不读盘：`data` 就是调用方刚从真实世界书读出来的那份。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {{ entries: object }} data 改动之前的书
 * @returns {{ ok: true, book: string, created: boolean } | { ok: false, error: string, hint?: string }}
 */
export function ensureDraft(ctx, book, data) {
    const name = String(book ?? '').trim();
    if (!name) {
        return {
            ok: false,
            error: 'NO_BOOK',
            hint: '还没有选择可写书。请让用户在浮动面板里选一本。',
        };
    }

    const draft = getDraftState(ctx);
    if (draft) {
        if (draft.book === name) {
            return { ok: true, book: name, created: false };
        }
        // 缓冲区里是另一本书的改动：不自动丢掉（那是用户没保存的工作），
        // 也不跨书写——那会让"保存"把 A 的内容写进 B
        return {
            ok: false,
            error: 'DRAFT_BOOK',
            hint: `虚拟世界书里还有「${draft.book}」的改动，没保存也没丢弃。`
                + `请让用户先在虚拟世界书窗口里处理掉它，再往「${name}」里写。`,
        };
    }

    openDraft(ctx, { book: name, entries: data?.entries ?? {} });
    return { ok: true, book: name, created: true };
}

/**
 * 把改动写回缓冲区。
 *
 * `touched` 是"哪几条被工具动过"，面板标题栏上的角标读它。这里顺手记，是因为
 * persistBook 只拿到"改完之后"的整本书，只有在这一刻才同时握着改前与改后。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} entries 改完之后的整本条目表
 * @returns {object|null} 更新后的缓冲区；null = 缓冲区已经不在了
 */
export function writeDraft(ctx, book, entries) {
    const draft = getDraftState(ctx);
    if (!draft || draft.book !== String(book ?? '').trim()) {
        return null;
    }

    const next = cloneEntries(entries);

    for (const [key, entry] of Object.entries(next)) {
        if (!entryChanged(draft.entries?.[key], entry)) {
            continue;
        }
        draft.touched[String(entry?.uid ?? key)] = draft.entries?.[key] ? 'rewritten' : 'created';
    }

    // 恢复写入前可能把一条又删掉了（新建的反向操作）：那颗角标不该继续数着它
    const alive = new Set(Object.entries(next).map(([key, entry]) => String(entry?.uid ?? key)));
    for (const uid of Object.keys(draft.touched)) {
        if (!alive.has(uid)) {
            delete draft.touched[uid];
        }
    }

    draft.entries = next;
    draft.updatedAt = Date.now();

    saveChat(ctx);
    notifyPanel();
    return draft;
}

/**
 * 一次写入失败之后收尾。
 *
 * 守卫通过、缓冲区开出来、然后写入被拒（超长、正文为空……）是常态。那种情况下
 * 缓冲区里一条改动都没有，留着它就是一块"看不见真实世界书的空壳"——之后用户在
 * 世界书编辑器里改的东西，工具都读不到。所以一次都没写成就把它撤掉。
 *
 * @param {object} ctx
 * @returns {boolean} 是否撤掉了
 */
export function rollbackEmptyDraft(ctx) {
    const draft = getDraftState(ctx);
    if (!draft) {
        return false;
    }
    if (Object.keys(draft.touched ?? {}).length > 0) {
        return false;
    }
    clearDraft(ctx);
    return true;
}

/**
 * 清掉缓冲区（保存完、丢弃、或撤掉一块空的）。
 *
 * 只动内存与对话文件；属于缓冲区的那批写入记录由调用方按场景处理：
 * 保存要走 store.dropDraftBackups 换成真实世界书的记录，丢弃则一并丢掉。
 *
 * @param {object} ctx
 * @returns {boolean} 原来有没有缓冲区
 */
export function clearDraft(ctx) {
    const existed = getDraftState(ctx) !== null;
    if (!existed) {
        return false;
    }

    setDraftState(ctx, null);
    saveChat(ctx);
    notifyPanel();
    return true;
}

/**
 * 面板、状态行用的同步摘要（不读盘，所以"有几条改动"数的是**工具动过几条**，
 * 不是"跟磁盘差几条"——后者要读盘，那是窗口自己的活）。
 *
 * @param {object} ctx
 * @returns {{ exists: boolean, book: string, entries: number, touched: number,
 *             createdAt: number, updatedAt: number }}
 */
export function summarizeDraft(ctx) {
    const draft = getDraftState(ctx);
    if (!draft) {
        return { exists: false, book: '', entries: 0, touched: 0, createdAt: 0, updatedAt: 0 };
    }

    return {
        exists: true,
        book: draft.book,
        entries: Object.keys(draft.entries ?? {}).length,
        touched: Object.keys(draft.touched ?? {}).length,
        createdAt: Number(draft.createdAt) || 0,
        updatedAt: Number(draft.updatedAt) || 0,
    };
}

/**
 * 两条条目在"工具会改的字段"上有没有差别。
 *
 * 比的是字段值而不是整对象：世界书编辑器里改 order、probability 之类的东西也算
 * 改动，但那不是这次缓冲区造成的，不该让角标跳一下。
 *
 * @param {object|undefined} before
 * @param {object|undefined} after
 */
function entryChanged(before, after) {
    if (!before || !after) {
        return true;
    }

    for (const field of SIGNIFICANT) {
        const left = before[field];
        const right = after[field];

        if (Array.isArray(left) || Array.isArray(right)) {
            const a = Array.isArray(left) ? left.map(String) : [];
            const b = Array.isArray(right) ? right.map(String) : [];
            if (a.length !== b.length || a.some((item, index) => item !== b[index])) {
                return true;
            }
            continue;
        }

        if (String(left ?? '') !== String(right ?? '')) {
            return true;
        }
    }

    return false;
}
