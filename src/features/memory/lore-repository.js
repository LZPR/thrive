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

    const names = ctx.getWorldInfoNames?.() ?? [];
    if (!names.includes(book)) return { ok: true, book, data: { entries: readDraftEntries(ctx, book) ?? {} }, missing: true };
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

/**
 * 建一本空书。
 *
 * 不能直接用 `createNewWorldInfo`：它没有挂到 ST 的 context 上。所以走同一条
 * 服务端接口（`/api/worldinfo/edit` 对不存在的文件会直接新建），再用
 * `updateWorldInfoList` 把 `world_names` 拉新。
 *
 * 建完必须回到列表里确认真实名字：服务端会 sanitize 文件名，算出来的名字和
 * 落盘的名字可能差一两个字符。用"前后差集"找新出现的那本，比按字符串猜可靠。
 */
export async function createBook(ctx, name) {
    if (typeof ctx.saveWorldInfo !== 'function') {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: '当前 ST 没有向扩展暴露 saveWorldInfo，建不了世界书。',
        };
    }

    // 兜底：净化口径和服务端可能还差一点点，真撞上已有书名就别写那份空模板
    const collision = matchBookName(listNames(ctx), name);
    if (collision) {
        const loaded = await loadBook(ctx, collision);
        return loaded.ok
            ? { ok: true, book: loaded.book, data: loaded.data, created: false }
            : loaded;
    }

    const before = new Set(listNames(ctx).map(normalizeName));

    try {
        await ctx.saveWorldInfo(name, { entries: {} }, true);
    } catch (err) {
        console.debug('[Thrive] 创建世界书失败', name, err);
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `创建世界书「${name}」失败：${err?.message ?? err}。可以让用户先手动在「世界书」面板里新建一本。`,
        };
    }

    try {
        await ctx.updateWorldInfoList?.();
    } catch (err) {
        console.debug('[Thrive] updateWorldInfoList 失败', err);
    }

    const names = listNames(ctx);
    const created = matchBookName(names, name);
    const wasCreated = created && !before.has(normalizeName(created));

    if (!created) {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `世界书「${name}」没有出现在列表里，写入目标不可用。可以让用户手动新建一次。`,
        };
    }

    const loaded = await loadBook(ctx, created);
    if (!loaded.ok) {
        return loaded;
    }

    return { ok: true, book: loaded.book, data: loaded.data, created: Boolean(wasCreated) };
}

/** 书名清单；拿不到时返回空数组（判据与 targets 一致：它是 world_names 的副本） */
function listNames(ctx) {
    try {
        const names = ctx.getWorldInfoNames?.();
        return Array.isArray(names) ? names.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * 在清单里找"就是这一本"的书名。
 * 不区分大小写与变音符号 —— ST 自己建书时也用同一套比较口径，
 * 严格相等会把「张三」和「张三」当成两本。
 */
function matchBookName(names, wanted) {
    const key = normalizeName(wanted);
    return names.find(name => normalizeName(name) === key) ?? '';
}

function normalizeName(name) {
    return String(name ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .trim();
}
