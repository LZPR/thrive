/** lore-write.js · Internal memory module; public entry: index.js. */

import { DRAFT_LAYER, isDraftBook } from '../../draft.js';

import { appendParagraph } from '../../util.js';

import { noSaveApi } from './target-errors.js';

import { buildNewLoreEntry, findLoreEntry, mergeKeys, nextLoreUid } from './lore-entry.js';

import { loadBook, persistBook } from './lore-repository.js';

/**
 * 新建条目。
 *
 * 与改写分开，是为了不再有 upsert：upsert 的隐含语义是"找不到就新建"，模型把
 * 标题打错一个字就会静默多出一条重复条目，而它自己并不知道。分开之后，
 * 标题不存在就是 NOT_FOUND，模型必须回头看一眼目录再决定。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {string} book
 * @param {object} data
 * @param {{ title: string, content: string, keys: string[], logic?: string }} fields
 */
async function createLoreEntry(ctx, settings, book, data, fields) {
    // 缓冲区接管时不需要 saveWorldInfo：这一笔先落在内存里，落盘由用户点「保存」触发
    if (!isDraftBook(ctx, book) && typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const uid = nextLoreUid(data);
    const entry = buildNewLoreEntry(settings, { ...fields, uid });
    // entries 以字符串 uid 为键，数字键会被 JS 转成字符串但顺序会跑到前面去
    data.entries[String(uid)] = entry;

    return commitEntry(ctx, book, data, entry, 'created');
}

/**
 * 追加：正文接在末尾，关键词合并去重。
 *
 * 这是唯一"模型不需要先读全文"的写路径 —— 它只提供增量，合成由这里做。
 * 合成的基准是盘上的完整正文，所以模型手里那半截文本永远冲不掉后半段。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ key: string, uid: number, entry: object }} found
 * @param {{ content?: string, keys?: string[], maxKeywords: number, hardLimit: number }} fields
 */
async function appendLoreEntry(ctx, book, data, found, fields) {
    // 缓冲区接管时不需要 saveWorldInfo：这一笔先落在内存里，落盘由用户点「保存」触发
    if (!isDraftBook(ctx, book) && typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const before = String(found.entry.content ?? '');
    const beforeKeys = Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];
    const content = String(fields.content ?? '').trim();

    const next = content ? appendParagraph(before, content) : before;
    if (next.length > fields.hardLimit) {
        return {
            ok: false,
            error: 'TOO_LONG',
            hint: `追加后正文 ${next.length} 字，超过单条上限 ${fields.hardLimit} 字。改用 lore_replace 精简已有内容，或把要加的这条另建一条。`,
        };
    }

    const merged = mergeKeys(beforeKeys, fields.keys, fields.maxKeywords);

    found.entry.content = next;
    found.entry.key = merged.keys;
    data.entries[found.key] = found.entry;

    const result = await commitEntry(ctx, book, data, found.entry, 'appended');
    if (!result.ok) {
        return result;
    }

    return {
        ...result,
        addedChars: next.length - before.length,
        addedKeys: merged.added,
        skippedKeys: merged.skipped,
    };
}

/**
 * 用新正文替换条目正文（replace 与 rewrite 共用后半段）。
 *
 * 只动 `content`：标题是定位键，关键词是触发方式，压缩正文时都不该被顺手改掉
 * （ADR-008 / ADR-015）。要加关键词走 append。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ key: string, uid: number, entry: object }} found
 * @param {string} content 新的正文
 * @param {{ hardLimit: number }} options
 */
async function replaceLoreEntry(ctx, book, data, found, content, options) {
    // 缓冲区接管时不需要 saveWorldInfo：这一笔先落在内存里，落盘由用户点「保存」触发
    if (!isDraftBook(ctx, book) && typeof ctx.saveWorldInfo !== 'function') {
        return noSaveApi();
    }

    const before = String(found.entry.content ?? '');
    const next = String(content ?? '');

    if (!next.trim()) {
        return {
            ok: false,
            error: 'EMPTY_CONTENT',
            hint: '替换后正文是空的。空条目等于删除，不做；要精简就保留可读的残句。',
        };
    }

    if (next.length > options.hardLimit) {
        return {
            ok: false,
            error: 'TOO_LONG',
            hint: `正文 ${next.length} 字，超过单条上限 ${options.hardLimit} 字。再压一压。`,
        };
    }

    found.entry.content = next;
    data.entries[found.key] = found.entry;

    const result = await commitEntry(ctx, book, data, found.entry, 'rewritten');
    if (!result.ok) {
        return result;
    }

    return { ...result, beforeChars: before.length, afterChars: next.length };
}

/** 三种写法的公共收尾：落盘 → 返回统一形状 */
async function commitEntry(ctx, book, data, entry, action) {
    const saved = await persistBook(ctx, book, data, { uid: entry.uid });
    if (!saved.ok) {
        return saved;
    }

    return {
        ok: true,
        action,
        uid: entry.uid,
        content: String(entry.content ?? ''),
        keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
    };
}

/**
 * 从快照把一条世界书条目恢复成写入前的样子。
 *
 * 两种情况分开处理，因为"写入前"的形态不同：
 *   - `rewritten`：写回 content / key / comment，其余字段一律不动
 *     （用户手调过的 position、depth 之类不该被这次撤销带走）
 *   - `created`：写入前这条根本不存在，所以恢复 = 从书里删掉它
 *
 * 删除只在用户主动点面板按钮时发生，不是工具能力（ADR-011 约束的是模型）。
 *
 * **恢复必须落在快照当初写入的那一层**（backup.layer）：
 *   - `draft` 的记录只能恢复到缓冲区里。缓冲区已经保存/丢弃了，那条记录就没有可
 *     恢复的位置——它的 before 是"缓冲区里当时的样子"，拿去覆盖磁盘等于凭空造内容。
 *   - `disk` 的记录只能恢复到真实世界书。缓冲区开着时先别动磁盘：缓冲区里存着这份书
 *     的整本副本，磁盘被改它看不见，之后一保存就把刚恢复的内容又冲掉了。
 *
 * @param {object} ctx
 * @param {object} backup store.js 里的快照记录
 * @returns {Promise<{ ok: true, action: 'restored'|'deleted'|'gone', book: string, title: string }
 *          | { ok: false, error: string, hint?: string }>}
 */
async function restoreLoreEntry(ctx, backup) {
    const book = String(backup?.book ?? '').trim();
    const title = String(backup?.title ?? '').trim();

    if (!book || !title) {
        return {
            ok: false,
            error: 'INVALID_BACKUP',
            hint: '这条快照缺少书名或标题，定位不到条目。',
        };
    }

    const layer = backup.layer === DRAFT_LAYER.DRAFT ? DRAFT_LAYER.DRAFT : DRAFT_LAYER.DISK;

    if (layer === DRAFT_LAYER.DRAFT && !isDraftBook(ctx, book)) {
        return {
            ok: false,
            error: 'DRAFT_GONE',
            hint: `「${book}」的缓冲区已经保存或丢弃了，这条记录说的那份改动不在任何一层里，没有可恢复的位置。`,
        };
    }

    if (layer === DRAFT_LAYER.DISK && isDraftBook(ctx, book)) {
        return {
            ok: false,
            error: 'DRAFT_ACTIVE',
            hint: `「${book}」的缓冲区正开着。先在虚拟世界书窗口里保存或丢弃它，再来改真实世界书——`
                + '否则缓冲区里那份旧副本会在保存时把这次恢复盖回去。',
        };
    }

    if (!isDraftBook(ctx, book) && typeof ctx.saveWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: '当前 ST 没有向扩展暴露 saveWorldInfo，改不到世界书。',
        };
    }

    const loaded = await loadBook(ctx, book);
    if (!loaded.ok) {
        return loaded;
    }

    const { data } = loaded;
    // 恢复是用户动作，保留条目也允许被恢复（否则「撤销新建」删不了它）
    const found = findLoreEntry(data, title, { includeReserved: true });

    if (!found) {
        if (backup.action === 'created') {
            // 已经是"写入前"的样子了：条目不在书里
            return { ok: true, action: 'gone', book, title };
        }
        return {
            ok: false,
            error: 'ENTRY_GONE',
            hint: `条目「${title}」已经不在「${book}」里了（可能被手动删除或改了标题），没有可恢复的位置。`,
        };
    }

    if (backup.action === 'created') {
        delete data.entries[found.key];
    } else {
        found.entry.content = String(backup.before ?? '');
        found.entry.comment = title;
        // 快照里没有关键词（极老的记录）就保持现状，别把 key 清空成死条目（ADR-009）
        if (Array.isArray(backup.beforeKeys) && backup.beforeKeys.length > 0) {
            found.entry.key = backup.beforeKeys.map(String);
        }
        data.entries[found.key] = found.entry;
    }

    const saved = await persistBook(ctx, book, data, { uid: found?.uid });
    if (!saved.ok) {
        return saved;
    }

    return {
        ok: true,
        action: backup.action === 'created' ? 'deleted' : 'restored',
        book,
        title,
    };
}

export { createLoreEntry, appendLoreEntry, replaceLoreEntry, restoreLoreEntry };
