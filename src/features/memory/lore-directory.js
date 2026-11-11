/** lore-directory.js · Internal memory module; public entry: index.js. */

import { isReservedEntry, isReservedTitle } from './desc-entry.js';

import { getWritableBook } from './target-selection.js';

import { noBook, reservedHint } from './target-errors.js';

import { entryTitle, findLoreEntry, uidOf } from './lore-entry.js';

import { loadBook, loadWritableBook } from './lore-repository.js';

/* ------------------------------------------------------ 世界书 · 目录 */

/**
 * 列出可写书里的条目，只取标题。
 *
 * 目录的信息量要小：模型问"这本书里有什么"，一串标题就够回答。把关键词和
 * 正文一起端上去，一次目录就能吃掉几千 token，而它多半只是想确认
 * "这条写没写过"。
 *
 * 只列可写书：目录的用途是写之前先看看，而写只能落到可写书。读范围也只剩这一本
 * （ADR-046），所以目录与读、写是同一本书，模型不会看到"读得到但改不了"的标题。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, book: string, items: Array<{ title: string, uid: number, disabled: boolean }> }
 *          | { ok: false, error: string, hint?: string }>}
 */
async function listLore(ctx) {
    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return loaded;
    }

    const items = Object.values(loaded.data.entries)
        .filter(Boolean)
        // 角色描述的保留条目不属于"目录"：模型看不到它，也不该拿标题去改它
        .filter(entry => !isReservedEntry(entry))
        .map(entry => ({
            title: entryTitle(entry),
            uid: uidOf(entry),
            disabled: entry.disable === true,
            // 只在目录过滤时用得上（按关键词找条目），不往返回里带：目录只给标题
            keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
        }))
        // 按 uid 排：新建的条目落在末尾，模型能看出"这是最近写的那条"
        .sort((a, b) => a.uid - b.uid);

    return { ok: true, book: loaded.book, items };
}

/**
 * 定位一条条目，只在可写书里找（ADR-046）。
 *
 * 以前还能去角色绑定的书里读一眼，但那带来一个无解的问题：模型读到一条改不了的内容，
 * 它该认为"这条已经记在别处"，还是"这条还不存在"？两个答案都会让它做错事，
 * 所以读范围收成一本：能读的就是能改的。
 *
 * 写路径本来也只认可写书，两边现在是同一本。
 *
 * @param {object} ctx
 * @param {string} title
 * @returns {Promise<{ ok: true, book: string, data: object,
 *                     found: { key: string, uid: number, entry: object } }
 *          | { ok: false, error: string, hint?: string }>}
 */
async function locateLoreEntry(ctx, title) {
    const wanted = String(title ?? '').trim();
    if (!wanted) {
        return {
            ok: false,
            error: 'INVALID_TITLE',
            hint: '标题是空串。标题既是同书内的唯一标识，也是定位条目的唯一方式。',
        };
    }

    // 保留条目只走 desc_* 工具。这里是 lore_read 的入口，直接说清楚，别让它猜 NOT_FOUND
    if (isReservedTitle(wanted)) {
        return reservedHint();
    }

    const writable = getWritableBook(ctx);
    if (!writable) {
        return noBook('还没有选择可写书。请让用户在浮动面板里选一本。');
    }

    const loaded = await loadBook(ctx, writable);
    if (!loaded.ok) {
        return loaded;
    }

    const found = findLoreEntry(loaded.data, wanted);
    if (!found) {
        return {
            ok: false,
            error: 'NOT_FOUND',
            hint: `「${writable}」里没有标题为「${wanted}」的条目。先用 lore_list 看现有标题，标题必须与列表里完全一致。`,
        };
    }

    return { ok: true, book: writable, data: loaded.data, found };
}

export { listLore, locateLoreEntry };
