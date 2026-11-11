import { loadBookFromDisk, persistBookOnDisk } from '../../platform/sillytavern/worldbook.js';
/** lore-repository.js · Internal memory module; public entry: index.js. */

import { isDraftBook, readDraftEntries, writeDraft } from './draft.js';

import { getWritableBook } from './target-selection.js';

import { noBook } from './target-errors.js';



/*
 * 标题上限（默认 60 字）也走 limits.js 的 `titleMaxChars`：comment 会显示在
 * 世界书列表里，太长就没法一眼扫过去，但"多长算太长"由用户自己定。
 */

/**
 * 取可写书的数据。
 *
 * 每次写入前都重新 load 一次：`saveWorldInfo` 把对象按引用放进缓存，
 * 保存之后再动同一个对象会造成"内存里改了、盘上没改"的分叉
 * （spec §11.2）。所以这里只拿副本、用完不再碰。
 *
 * @param {object} ctx
 */
async function loadWritableBook(ctx) {
    const book = getWritableBook(ctx);
    if (!book) {
        return noBook('还没有选择可写书。请让用户在浮动面板里选一本。');
    }

    return loadBook(ctx, book);
}

/**
 * 按书名取一份世界书数据 —— **读缓冲区优先**。
 *
 * 与 loadWritableBook 的区别只在"书名从哪来"：从快照恢复时，记录里的书
 * 可能已经不是当前的可写书（用户中途换过书），但那条记录仍然得能恢复。
 *
 * 这本书有缓冲区时，读到的就是缓冲区那份：模型看到的、守卫比对的、写入合成的，
 * 必须是同一份内容，否则"先读后写"会在两层之间错位（读到磁盘、写到缓冲区）。
 *
 * @param {object} ctx
 * @param {string} book
 */
async function loadBook(ctx, book) {
    const name = String(book ?? '').trim();
    if (!name) {
        return noBook('没有指定世界书。');
    }

    const drafted = readDraftEntries(ctx, name);
    if (drafted) {
        return { ok: true, book: name, data: { entries: drafted }, draft: true };
    }

    return loadBookFromDisk(ctx, name);
}

/**
 * 写入的出口：**这本书有缓冲区就写缓冲区，没有才落盘**。
 *
 * 整条写入链路（新建 / 追加 / 替换 / 整段重写 / 描述条目 / 压缩面板）都从这里收尾，
 * 所以"先落缓冲区"只需要在这里判一次，不必每个调用点各判一遍——那迟早会漏一个，
 * 表现为"改了一条，但世界书里怎么没有"。
 *
 * 缓冲区这条路不碰 saveWorldInfo / updateWorldInfoList / 世界书编辑器：
 * 磁盘一个字都没动，刷新它们只会让用户以为书已经改了。
 *
 * 对外导出是为了让 desc.js 的"角色描述条目"走同一条落盘路径 —— 世界书编辑器的
 * 整本回滚问题（见下面 refreshWorldEditor）对它同样成立，不能另写一份。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ uid?: number }} [options] 刚写入的那条，刷新后拿来定位
 */
async function persistBook(ctx, book, data, options = {}) {
    if (isDraftBook(ctx, book)) {
        const written = writeDraft(ctx, book, data?.entries ?? {});
        if (!written) {
            return {
                ok: false,
                error: 'WRITE_FAILED',
                hint: `虚拟世界书「${book}」在半途被换掉了（可能刚被保存或丢弃），这次写入没有落下。请重新读取再写。`,
            };
        }
        return { ok: true, draft: true, editor: { refreshed: false, reason: 'draft' } };
    }

    return persistBookOnDisk(ctx, book, data, options);
}

export { loadWritableBook, loadBook, loadBookFromDisk, persistBook, persistBookOnDisk };
