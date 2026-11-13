import { isReservedEntry, isReservedTitle } from './desc-entry.js';
import { getLoreBookNames, getWritableBook } from './target-selection.js';
import { reservedHint } from './target-errors.js';
import { entryTitle, uidOf } from './lore-entry.js';
import { loadBook, loadWritableBook } from './lore-repository.js';
import { getState } from '../settings/index.js';

// Per-read-session aliases never move to another book or uid when the active set changes.
const directories = new WeakMap();
function registry(ctx) {
    const state = getState(ctx);
    let value = directories.get(ctx.chatMetadata);
    if (!value || value.reads !== state.reads) {
        value = { reads: state.reads, aliases: new Map(), identities: new Map() };
        directories.set(ctx.chatMetadata, value);
    }
    return value;
}

export async function listLore(ctx) {
    const metadata = ctx.chatMetadata;
    const chatId = ctx.getCurrentChatId?.();
    const items = [];
    const books = getLoreBookNames(ctx);
    for (const book of books) {
        const loaded = book === getWritableBook(ctx) ? await loadWritableBook(ctx) : await loadBook(ctx, book);
        if (!loaded.ok) return loaded;
        if (ctx.chatMetadata !== metadata || ctx.getCurrentChatId?.() !== chatId) {
            return { ok: false, error: 'TOOL_UNAVAILABLE', hint: '对话已切换，请重新读取。' };
        }
        for (const [key, entry] of Object.entries(loaded.data.entries)) {
            if (!entry || isReservedEntry(entry)) continue;
            items.push({ book, key, title: entryTitle(entry), originalTitle: entryTitle(entry), uid: uidOf(entry),
                disabled: entry.disable === true, keys: Array.isArray(entry.key) ? entry.key.map(String) : [] });
        }
    }
    items.sort((a, b) => books.indexOf(a.book) - books.indexOf(b.book) || a.uid - b.uid);
    const names = new Set(items.map(item => item.title));
    const counts = new Map();
    for (const item of items) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
    const mapping = registry(ctx);
    for (const item of items) {
        const identity = JSON.stringify([item.book, item.key]);
        let alias = mapping.identities.get(identity);
        if (!alias) {
            alias = item.title;
            if (counts.get(alias) > 1 || mapping.aliases.has(alias)) {
                let number = 1;
                do { alias = `${item.title} [#${number++}]`; } while (names.has(alias) || mapping.aliases.has(alias));
            }
            mapping.identities.set(identity, alias);
            mapping.aliases.set(alias, { book: item.book, key: item.key, originalTitle: item.originalTitle });
        }
        item.title = alias;
    }
    return { ok: true, book: getWritableBook(ctx), books, items };
}

export async function locateLoreEntry(ctx, title) {
    const wanted = String(title ?? '').trim();
    if (!wanted) return { ok: false, error: 'INVALID_TITLE', hint: '标题不能为空。先用 lore_list 查看条目。' };
    if (isReservedTitle(wanted)) return reservedHint();
    const listed = await listLore(ctx);
    if (!listed.ok) return listed;
    const item = listed.items.find(row => row.title === wanted);
    if (!item || item.disabled) return { ok: false, error: 'NOT_FOUND', hint: '没有这个已启用条目。先用 lore_list 获取当前标题，重名条目须保留编号。' };
    const loaded = await loadBook(ctx, item.book);
    if (!loaded.ok) return loaded;
    const entry = loaded.data.entries[item.key];
    if (!entry || isReservedEntry(entry) || entryTitle(entry) !== item.originalTitle || entry.disable === true) {
        return { ok: false, error: 'STALE_READ', hint: '条目已变化，请重新读取目录。' };
    }
    return { ok: true, book: item.book, data: loaded.data, found: { key: item.key, uid: item.uid, entry } };
}
