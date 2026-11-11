/** worldbook-editor.js · Internal memory module; public entry: index.js. */

/* -------------------------------------------------- 世界书编辑器同步 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 世界书编辑器当前开在哪本书上。
 *
 * 只能读 DOM —— 没有公开 API 能问"编辑器开着哪本"。注意 option 的 value 是
 * `world_names` 的下标，而 option 列表最前面还有一个空占位项：拿 value 当下标去取
 * option 会差一位，所以直接读选中项的文字。
 */
function isWorldEditorShowing(book) {
    const select = document.getElementById('world_editor_select');
    if (!select) {
        return false;
    }
    const label = String(select.selectedOptions?.[0]?.textContent ?? '').trim();
    return label !== '' && label === book;
}

/** 世界书列表当前在第几页；拿不到就当第 1 页 */
function readCurrentPage() {
    const $ = globalThis.jQuery;
    if (!$) {
        return 1;
    }
    try {
        return Number($('#world_info_pagination').pagination('getCurrentPageNum')) || 1;
    } catch {
        return 1;
    }
}

function goToPage(page) {
    const $ = globalThis.jQuery;
    if (!$ || !(page > 1)) {
        return;
    }
    try {
        $('#world_info_pagination').pagination('go', page);
    } catch {
        // 分页还没初始化，忽略
    }
}

/** 刚写的那条在列表里的元素（不在当前页/被搜索过滤掉时为 null） */
function findLoreEntryElement(uid) {
    if (!Number.isFinite(uid)) {
        return null;
    }
    const list = document.getElementById('world_popup_entries_list');
    return list?.querySelector(`.world_entry[uid="${uid}"]`) ?? null;
}

/** 闪一下边框，让用户一眼看到刚才写的是哪条 */
function flashLoreEntry(el) {
    try {
        el.animate?.(
            [
                { outline: '2px solid rgba(120, 200, 255, 0.95)', outlineOffset: '2px' },
                { outline: '2px solid rgba(120, 200, 255, 0)', outlineOffset: '2px' },
            ],
            { duration: 1600, easing: 'ease-out' },
        );
    } catch {
        // 没有 Web Animations 就算了
    }
}

/**
 * 把世界书编辑器刷到磁盘上的最新内容。
 *
 * 为什么非要整块重绘：`worldInfoCache` 是 `StructuredCloneMap({ cloneOnGet: true })`，
 * `loadWorldInfo` 每次返回的都是**深拷贝**。编辑器渲染时拿到自己那份拷贝，之后任何一次
 * 输入（改标题、改 Order、切禁用……）都会拿它把**整本书**写回去。所以插件写进去的条目，
 * 会在用户下一次碰编辑器时被整本回滚 —— 比角色描述那条路径更狠（那边只回滚一个字段）。
 * 实测：写入成功后只改一下 order，刚写的正文就变回旧内容了。
 *
 * 重绘是唯一能让编辑器拿到新拷贝的办法（回调闭包里那份拿不到，`updateEditor` 也是拿它
 * 重画）。代价是 ST 的 change 处理器会清掉搜索词、跳回第一页，所以这里尽量还原。
 *
 * @param {object} ctx
 * @param {string} book
 * @param {number|undefined} uid 刚写入的条目
 * @returns {Promise<{ refreshed: boolean, reason?: string, focused?: boolean }>}
 */
async function refreshWorldEditor(ctx, book, uid) {
    if (!isWorldEditorShowing(book)) {
        return { refreshed: false, reason: 'not-open' };
    }
    if (typeof ctx.reloadWorldInfoEditor !== 'function') {
        return { refreshed: false, reason: 'no-api' };
    }

    const searchEl = document.getElementById('world_info_search');
    const searchText = String(searchEl?.value ?? '');
    const page = readCurrentPage();
    const uidNum = Number(uid);

    /*
     * 条目正文的编辑区是懒加载的：抽屉展开时才创建，收起时会整个销毁。
     * 重绘后抽屉一律是收起的，用户刚在改的那条会突然合上，所以先记下它原本是展开的。
     * 顺带记下旧节点：重绘会整块换新节点，用引用比较才能确定"新内容已经上屏"。
     */
    const oldEl = findLoreEntryElement(uidNum);
    const oldContent = oldEl?.querySelector('.inline-drawer-content');
    const wasExpanded = Boolean(
        oldEl?.querySelector('.inline-drawer-icon.up')
        || (oldContent && oldContent.style.display !== 'none'),
    );

    try {
        ctx.reloadWorldInfoEditor(book);
    } catch (err) {
        console.debug('[Thrive] 刷新世界书编辑器失败', err);
        return { refreshed: false, reason: 'failed' };
    }

    /*
     * 重绘是异步的（`reloadEditor` 只是 trigger('change')，真正的重画在后面的 await 里）。
     * 只等"列表里有元素"是不够的：trigger 返回时旧的还没被清掉，会立刻命中。
     * 所以有旧节点就等它被换掉，没有就给它一个 tick 的时间。
     */
    if (oldEl) {
        for (let i = 0; i < 40; i += 1) {
            const el = findLoreEntryElement(uidNum);
            if (el && el !== oldEl) {
                break;
            }
            await sleep(25);
        }
    } else {
        await sleep(80);
    }

    if (searchText && searchEl) {
        // reloadEditor 的 change 处理器会把搜索框清空，这里放回去
        searchEl.value = searchText;
        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(350); // 搜索是防抖的，等过滤跑完再定位条目
    } else {
        goToPage(page);
        await sleep(page > 1 ? 200 : 0);
    }

    const entryEl = findLoreEntryElement(uidNum);
    if (entryEl) {
        if (wasExpanded) {
            // 交回给 ST 自己的点击处理器：它会用新拷贝重建抽屉内容并展开
            entryEl.querySelector('.inline-drawer-toggle')?.click();
            await sleep(300);
        }
        try {
            entryEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
            // 老浏览器不认平滑滚动
        }
        flashLoreEntry(entryEl);
    }

    return { refreshed: true, focused: Boolean(entryEl) };
}

export { refreshWorldEditor };
