/** lore-handlers.js · Internal tools module; public entry: index.js. */

import { getContext } from '../../platform/sillytavern/context.js';

import { BOOK_SEEN, bookReadKey, ensureSettings, getReadHash, isLearningActive, lorePatternKey, loreReadKey, loreSeenKey, rememberLoreBackup, saveChat, setReadHash } from '../../store.js';

import { readLimits } from '../../limits.js';

import { appendLoreEntry, createLoreEntry, findLoreEntry, getWritableBook, listLore, loadWritableBook, locateLoreEntry, replaceLoreEntry } from '../../targets.js';

import { isReservedTitle } from '../../desc-entry.js';

import { ensureDraft, layerFor, rollbackEmptyDraft } from '../../draft.js';

import { compilePattern, replaceIn, scan } from '../../regex.js';

import { fnv1a, isBlank, truncate } from '../../util.js';

import { LOG, applyBookNotes, applyReadNotes, bookNote, canReplace, errorResult, normalizeKeys, normalizeLogic, registerLoreWrite } from './tool-contracts.js';

/* --------------------------------------------------------------- lore_list */

async function handleLoreList(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }
    if (!getWritableBook(ctx)) {
        return errorResult('NO_BOOK', '还没有选择可写书，请让用户在浮动面板里选一本。');
    }

    const listed = await listLore(ctx);
    if (!listed.ok) {
        return errorResult(listed.error, listed.hint);
    }

    const limits = readLimits(settings);
    const enabled = listed.items.filter(item => item.disabled !== true);

    let picked = enabled;
    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }
        // 只看标题和关键词：目录不扫正文，那是 lore_read 的活
        picked = enabled.filter(item => compiled.regex.test(item.title)
            || item.keys.some(key => compiled.regex.test(key)));
    }

    const wanted = Number(params?.limit);
    const cap = Number.isFinite(wanted) && wanted > 0
        ? Math.min(Math.trunc(wanted), limits.listLimit)
        : limits.listLimit;
    const shown = picked.slice(0, cap);

    const payload = {
        ok: true,
        book: listed.book,
        total: listed.items.length,
        enabled: enabled.length,
        truncated: picked.length > shown.length,
        titles: shown.map(item => item.title),
    };

    const disabledCount = listed.items.length - enabled.length;
    if (disabledCount > 0) {
        payload.disabled_count = disabledCount;
    }

    if (payload.truncated) {
        payload.hint = `还有 ${picked.length - shown.length} 条没列出。用 pattern 缩小范围，或把设置里的目录上限调大。`;
    }

    // 条目多到一定程度就该提醒合并：这是模型自己能做的动作，不替它对用户说话
    const merge = listed.items.length > limits.softEntryCount
        ? `这本书已经有 ${listed.items.length} 条，考虑合并重复条目。`
        : '';
    if (merge) {
        payload.note = [payload.note, merge].filter(Boolean).join(' ');
    }

    applyBookNotes(ctx, listed.book, payload);
    registerDirectoryRead(ctx, listed.book, shown);

    console.debug(`${LOG} lore_list`, {
        book: listed.book,
        total: payload.total,
        shown: shown.length,
        filtered: !isBlank(pattern),
    });

    return payload;
}

/** 目录读过 = 新建条目的前置。只登记真正列出来的那些标题 */
function registerDirectoryRead(ctx, book, shown) {
    setReadHash(ctx, bookReadKey(book), BOOK_SEEN);
    for (const item of shown) {
        setReadHash(ctx, loreSeenKey(book, item.title), BOOK_SEEN);
    }
}

/* --------------------------------------------------------------- lore_read */

async function handleLoreRead(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }
    if (!getWritableBook(ctx)) {
        return errorResult('NO_BOOK', '还没有选择可写书，请让用户在浮动面板里选一本。');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', 'title 是必填的。要浏览这本书有什么，用 lore_list。');
    }

    const located = await locateLoreEntry(ctx, title);
    if (!located.ok) {
        return errorResult(located.error, located.hint);
    }

    const { book, found } = located;
    const full = String(found.entry.content ?? '');
    const limits = readLimits(settings);

    // 见过标题，追加就放行了 —— 但仍然不登记全文，整段重写还得真读到全文
    setReadHash(ctx, loreSeenKey(book, title), BOOK_SEEN);

    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }

        const hit = scan(full, compiled, {
            window: limits.matchWindow,
            maxMatches: limits.maxMatches,
        });

        // 命中 0 处不登记：没有"会替换掉什么"可看，替换本来就该先改 pattern
        if (hit.count > 0) {
            setReadHash(ctx, lorePatternKey(book, title, compiled.flags, compiled.source), String(hit.count));
        }

        const payload = { ok: true, book, title, count: hit.count, matches: hit.matches };
        if (hit.truncated) {
            payload.truncated = true;
            payload.hint = `命中 ${hit.count} 处，只列了前 ${hit.matches.length} 处。pattern 写得更具体一些。`;
        } else if (hit.count === 0) {
            payload.hint = '这条里没有命中。换一个关键词，或去掉 pattern 读全文。';
        }
        applyReadNotes(ctx, book, payload);
        return payload;
    }

    const cut = truncate(full, limits.maxReadChars);
    const payload = {
        ok: true,
        book,
        title,
        chars: full.length,
        keys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        content: cut.text,
    };

    if (found.entry.disable === true) {
        // 停用条目照实显示：内容是存在的，只是生成时不会触发
        payload.disabled = true;
    }

    if (cut.truncated) {
        // 截断过就不登记全文：拿半截文本去重写，后半段会被冲掉
        payload.truncated = true;
        payload.note = `正文 ${full.length} 字，这里只返回了前 ${limits.maxReadChars} 字。`
            + '整段重写需要完整正文，请改用 lore_replace 做局部修改，或让用户把上限调大。';
    } else {
        setReadHash(ctx, loreReadKey(book, title), fnv1a(full));
    }

    /*
     * 软提醒不再出现在返回里。
     *
     * 以前这里会附 over_limit + 一段压缩指令，让模型自己把条目压短——结果是它在
     * 完全不了解上下文的情况下把设定压成摘要，而用户根本不知道发生过什么。
     * 现在"该压哪条、压到什么程度"只在压缩面板里由用户判断（见 compress.js），
     * 模型侧只剩硬上限：写不进去就是写不进去。
     */

    applyReadNotes(ctx, book, payload);

    console.debug(`${LOG} lore_read`, {
        book,
        title,
        chars: full.length,
        truncated: Boolean(cut.truncated),
    });

    return payload;
}

/* ---------------------------------------------------------------- lore_add */

async function handleLoreAdd(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空：它既是同书内的唯一标识，也会显示在世界书列表里。请用短的专有名词。');
    }
    if (title.length > limits.titleMaxChars) {
        return errorResult('TITLE_TOO_LONG', `标题 ${title.length} 字，超过 ${limits.titleMaxChars} 字上限。请精简成一个短的专有名词。`);
    }

    // 保留守卫要排在"读到书"之前：这是目标不对，不是书读不到
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;

    // 守卫一：先看目录。看不见目录就新建，等于闭着眼睛往书里塞重复条目
    if (!getReadHash(ctx, bookReadKey(book))) {
        return errorResult('READ_REQUIRED', `本轮还没看过「${book}」的目录。先调用 lore_list 确认里面已有什么，避免写出重复条目。`);
    }

    if (findLoreEntry(data, title)) {
        return errorResult('TITLE_EXISTS', `「${title}」已经存在。要改正文用 lore_rewrite，要补内容用 lore_append。`);
    }

    const content = String(params?.content ?? '').trim();
    if (isBlank(content)) {
        return errorResult('EMPTY_CONTENT', '正文为空。世界书条目不能写成空内容，否则等同于删除。');
    }
    if (content.length > limits.hardLimitEntry) {
        return errorResult('TOO_LONG',
            `正文 ${content.length} 字，超过单条上限 ${limits.hardLimitEntry} 字。这次没有写入：请精简到上限以内，或者拆成两条分别新建。`);
    }

    const normalized = normalizeKeys(params?.keys);
    if (normalized.keys.length === 0) {
        return errorResult('NO_KEYS', '新建条目至少要给 1 个关键词，否则它永远不会被触发，等于写进黑洞。');
    }

    const keys = normalized.keys.slice(0, limits.maxKeywords);
    const droppedKeys = normalized.keys.length - keys.length;
    const logic = normalizeLogic(params?.logic);

    // 守卫全过完了，才开缓冲区：被 READ_REQUIRED 挡住的写入不该留下一块空壳
    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await createLoreEntry(ctx, settings, book, data, { title, content, keys, logic });
    if (!written.ok) {
        console.debug(`${LOG} lore_add 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'created',
        layer: layerFor(ctx, book),
        before: '',
        beforeKeys: [],
        chars: written.content.length,
    });
    // 新建：正文就是模型自己写的，算读过
    registerLoreWrite(ctx, book, title, written, { fullText: true });
    saveChat(ctx);

    const notes = [bookNote(ctx, book)];

    if (droppedKeys > 0) {
        notes.push(`关键词超过上限 ${limits.maxKeywords} 个，已只保留前 ${limits.maxKeywords} 个。`);
    }

    console.debug(`${LOG} lore_add`, { book, title, chars: written.content.length, keys: written.keys.length });

    return {
        ok: true,
        title,
        uid: written.uid,
        action: 'created',
        chars: written.content.length,
        keys: written.keys.length,
        note: notes.filter(Boolean).join(' '),
    };
}

/* ------------------------------------------------------------- lore_append */

async function handleLoreAppend(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要追加必须先说明追加到哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。先用 lore_list 看现有标题，或改用 lore_add 新建。`);
    }

    // 守卫：目录里见过这条标题就够 —— 追加不破坏原文，只要确认目标真实存在
    if (!getReadHash(ctx, loreSeenKey(book, title))) {
        return errorResult('READ_REQUIRED', `本轮还没确认过「${title}」存在。先调用 lore_list（或带 pattern 的 lore_read）看到这条标题再追加。`);
    }

    const content = String(params?.content ?? '');
    const keys = normalizeKeys(params?.keys).keys;

    if (isBlank(content) && keys.length === 0) {
        return errorResult('EMPTY_CONTENT', 'content 和 keys 都是空的。要追加正文就给 content，要加触发词就给 keys。');
    }

    const before = String(found.entry.content ?? '');
    const beforeKeys = Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await appendLoreEntry(ctx, book, data, found, {
        content,
        keys,
        maxKeywords: limits.maxKeywords,
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_append 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before,
        beforeKeys,
        chars: written.content.length,
    });
    // 追加：正文是插件拼的，模型没见过拼完的全文
    registerLoreWrite(ctx, book, title, written, { fullText: false });
    saveChat(ctx);

    const notes = [bookNote(ctx, book)];

    if (written.addedChars === 0) {
        notes.push('正文没有变化（content 为空）。');
    }
    if (written.skippedKeys.length > 0) {
        notes.push(`已有这些关键词，跳过：${written.skippedKeys.join('、')}。`);
    }

    console.debug(`${LOG} lore_append`, {
        book,
        title,
        addedChars: written.addedChars,
        addedKeys: written.addedKeys.length,
    });

    return {
        ok: true,
        title,
        added_chars: written.addedChars,
        added_keys: written.addedKeys,
        skipped_keys: written.skippedKeys,
        chars: written.content.length,
        keys: written.keys.length,
        note: notes.filter(Boolean).join(' '),
    };
}

/* ------------------------------------------------------------ lore_replace */

async function handleLoreReplace(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要替换必须说明改哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const compiled = compilePattern(params?.pattern, params?.flags, limits.patternMaxChars);
    if (!compiled.ok) {
        return errorResult(compiled.error, compiled.hint);
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。先用 lore_list 看现有标题。`);
    }

    // 守卫：同一个 pattern 预读过。预读本身就是"看清会替换掉什么"，比任何叮嘱都有效
    const patternKey = lorePatternKey(book, title, compiled.flags, compiled.source);
    if (!canReplace(ctx, patternKey, loreReadKey(book, title), String(found.entry.content ?? ''))) {
        return errorResult('READ_REQUIRED', `本轮还没看过「${title}」的正文。先 lore_read（带同一个 pattern 最省）确认会命中什么，再替换。`);
    }

    const current = String(found.entry.content ?? '');
    const replaced = replaceIn(current, compiled, params?.replacement, params?.replace_all === true, {
        window: limits.matchWindow,
    });

    if (!replaced.ok) {
        const failed = errorResult(replaced.error, replaced.hint);
        if (Number.isFinite(replaced.count)) {
            failed.count = replaced.count;
        }
        if (Array.isArray(replaced.matches)) {
            failed.matches = replaced.matches;
        }
        return failed;
    }

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await replaceLoreEntry(ctx, book, data, found, replaced.text, {
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_replace 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before: current,
        beforeKeys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        chars: written.content.length,
    });
    // 替换：合成后的正文模型没读过
    registerLoreWrite(ctx, book, title, written, { fullText: false });
    saveChat(ctx);

    console.debug(`${LOG} lore_replace`, {
        book,
        title,
        replaced: replaced.replaced,
        before: written.beforeChars,
        after: written.afterChars,
    });

    return {
        ok: true,
        title,
        replaced: replaced.replaced,
        before_chars: written.beforeChars,
        after_chars: written.afterChars,
        sample: replaced.sample,
        note: bookNote(ctx, book),
    };
}

/* ------------------------------------------------------------ lore_rewrite */

async function handleLoreRewrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空。要重写必须说明改哪一条。');
    }
    if (isReservedTitle(title)) {
        return errorResult('RESERVED_ENTRY');
    }

    const loaded = await loadWritableBook(ctx);
    if (!loaded.ok) {
        return errorResult(loaded.error, loaded.hint);
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);
    if (!found) {
        return errorResult('NOT_FOUND', `可写书「${book}」里没有「${title}」。整段重写不会新建条目，要新建用 lore_add。`);
    }

    const current = String(found.entry.content ?? '');
    const recorded = getReadHash(ctx, loreReadKey(book, title));

    if (!recorded) {
        return errorResult('READ_REQUIRED', `本轮还没读过「${title}」的全文。先 lore_read（不带 pattern）拿到完整正文，再整段重写。`);
    }
    if (fnv1a(current) !== recorded) {
        return errorResult('STALE_READ', `「${title}」在你读取之后被改动过（可能是用户或其他窗口改的）。请重新 lore_read 拿最新正文，不要重试原来的参数。`);
    }

    const content = String(params?.content ?? '').trim();
    if (isBlank(content)) {
        return errorResult('EMPTY_CONTENT', '正文为空。空条目等于删除，不做。');
    }
    if (content.length > limits.hardLimitEntry) {
        return errorResult('TOO_LONG',
            `正文 ${content.length} 字，超过单条上限 ${limits.hardLimitEntry} 字。这次没有写入：请精简到上限以内再整段重写，或者改用 lore_replace 只改其中一段。`);
    }

    const drafted = ensureDraft(ctx, book, data);
    if (!drafted.ok) {
        return errorResult(drafted.error, drafted.hint);
    }

    const written = await replaceLoreEntry(ctx, book, data, found, content, {
        hardLimit: limits.hardLimitEntry,
    });
    if (!written.ok) {
        console.debug(`${LOG} lore_rewrite 失败`, written.error);
        rollbackEmptyDraft(ctx);
        return written;
    }

    rememberLoreBackup(ctx, {
        book,
        title,
        action: 'rewritten',
        layer: layerFor(ctx, book),
        before: current,
        beforeKeys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        chars: written.content.length,
    });
    // 整段重写：模型提交的就是全文
    registerLoreWrite(ctx, book, title, written, { fullText: true });
    saveChat(ctx);

    console.debug(`${LOG} lore_rewrite`, {
        book,
        title,
        before: written.beforeChars,
        after: written.afterChars,
    });

    return {
        ok: true,
        title,
        before_chars: written.beforeChars,
        after_chars: written.afterChars,
        note: bookNote(ctx, book),
    };
}

export { handleLoreList, handleLoreRead, handleLoreAdd, handleLoreAppend, handleLoreReplace, handleLoreRewrite };
