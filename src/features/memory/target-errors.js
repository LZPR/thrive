/** target-errors.js · Internal memory module; public entry: index.js. */

function noBook(hint) {
    return { ok: false, error: 'NO_BOOK', hint };
}

/**
 * 「这是插件保留给角色描述的条目」的统一错误码。
 *
 * 只说码，hint 交给 diagnostics.js 的码表（与其它错误码同一个出口，
 * 免得同一句话在三个文件里各写一版）。
 */
function reservedHint() {
    return { ok: false, error: 'RESERVED_ENTRY' };
}

function noSaveApi() {
    return {
        ok: false,
        error: 'WRITE_FAILED',
        hint: '当前 ST 没有向扩展暴露 saveWorldInfo，写不进世界书。',
    };
}

export { noBook, reservedHint, noSaveApi };
