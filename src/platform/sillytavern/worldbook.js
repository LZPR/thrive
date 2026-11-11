import { refreshWorldEditor } from './worldbook-editor.js';

/** target-errors.js · Internal memory module; public entry: index.js. */

function noBook(hint) {
    return { ok: false, error: 'NO_BOOK', hint };
}

export { noBook };

/**
 * 按书名取**磁盘上**那份世界书数据。
 *
 * 三种场合用它，且只有这三种：
 *   - loadBook 判断这本书没有缓冲区之后；
 *   - 缓冲区保存到真实世界书（要拿磁盘现状比对、并作为写入底本）；
 *   - 窗口展示"真实世界书 vs 缓冲区"的差异。
 *
 * @param {object} ctx
 * @param {string} book
 */
async function loadBookFromDisk(ctx, book) {
    const name = String(book ?? '').trim();
    if (!name) {
        return noBook('没有指定世界书。');
    }

    if (typeof ctx.loadWorldInfo !== 'function') {
        return noBook('当前 ST 没有向扩展暴露 loadWorldInfo，改不到世界书。');
    }

    let data = null;
    try {
        data = await ctx.loadWorldInfo(name);
    } catch (err) {
        console.debug('[Thrive] loadWorldInfo 失败', name, err);
    }

    // loadWorldInfo 对不存在的书名**不返回 null**：1.19 会给出一个空 entries 的对象，
    // 于是 `data != null` 这条判断放过了"书已被删除/改名"的情况，接着 saveWorldInfo
    // 还会把文件重新创建出来——用户看到的是"写成功了"，实际写到一本刚被凭空造出来的书里。
    // 书名清单才是"这本书存在"的判据（getWorldInfoNames 是 world_names 的副本）。
    const names = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : null;
    if (Array.isArray(names) && !names.includes(name)) {
        return noBook(`读不到世界书「${name}」，它可能已被删除或改名。请让用户重新选择。`);
    }

    if (!data || typeof data !== 'object') {
        return noBook(`读不到世界书「${name}」，它可能已被删除或改名。请让用户重新选择。`);
    }

    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    return { ok: true, book: name, data };
}


/**
 * 真的写盘：saveWorldInfo(name, data, true) → 刷新世界书列表 → 刷新世界书编辑器。
 *
 * `immediately = true` 是硬要求：默认走 debounce，用户切走对话或关页面时
 * 那几百毫秒的窗口足够丢掉一次写入，而这条路径没有别的重试机会。
 *
 * 只有两处用它：persistBook（这本书没有缓冲区）与 commitDraft（把缓冲区存成真的）。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {object} data
 * @param {{ uid?: number }} [options] 刚写入的那条，刷新后拿来定位
 */
async function persistBookOnDisk(ctx, book, data, options = {}) {
    try {
        await ctx.saveWorldInfo(book, data, true);
    } catch (err) {
        console.debug('[Thrive] saveWorldInfo 失败', book, err);
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `写入世界书「${book}」失败：${err?.message ?? err}。可以让用户检查 ST 服务是否在运行。`,
        };
    }

    // 列表没刷新的话，设置面板里的选择器还是旧的，用户会以为没写进去
    try {
        await ctx.updateWorldInfoList?.();
    } catch (err) {
        console.debug('[Thrive] updateWorldInfoList 失败', err);
    }

    // 编辑器开着这本书就必须跟着刷新，否则它手里那份旧拷贝迟早把整本书写回去
    const editor = await refreshWorldEditor(ctx, book, options.uid);

    return { ok: true, editor };
}

export { loadBookFromDisk, persistBookOnDisk };
