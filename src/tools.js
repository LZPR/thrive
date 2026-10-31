/**
 * tools.js · 工具注册与分发
 *
 * 关键设计（ADR-001）：工具在初始化时注册一次，之后永不增删。
 * 开关和模块切换只改 `shouldRegister` 的返回值 —— 如果反过来在切换时
 * register / unregister，`tools` 数组的顺序和内容会变，而 `tools` 位于请求头部，
 * 任何变化都会让整条前缀缓存失效。
 *
 * 因此 `shouldRegister` 必须是同步、廉价的，并且要现取 context：
 * 缓存的 ctx 会指向切换前的对话（chat_metadata 被整体替换过）。
 */

import { getContext } from '../../../../extensions.js';
import {
    BOOK_SEEN,
    bookReadKey,
    ensureSettings,
    getReadHash,
    getState,
    isLearningActive,
    loreReadKey,
    READ_KEY_DESC,
    rememberDescBackup,
    rememberLoreBackup,
    saveChat,
    setReadHash,
} from './store.js';
import { compactHint } from './compact.js';
import {
    applyDescriptionLocally,
    findLoreEntry,
    getActiveCharacter,
    getWritableBook,
    isBookScanned,
    loadWritableBook,
    readDescription,
    readLore,
    saveDescription,
    TITLE_MAX_CHARS,
    writeLoreEntry,
} from './targets.js';
import {
    descriptionView,
    getPatch,
    isUnresolved,
    PATCH_STATUS,
    stagePatch,
} from './patch.js';
import { TOOL_NAMES } from './tool-names.js';
import { hintFor } from './diagnostics.js';
import { appendParagraph, fnv1a, isBlank, normalizeEol } from './util.js';

const LOG = '[Thrive]';
const DEFAULT_SOFT_LIMIT_DESC = 1600;
const DEFAULT_HARD_LIMIT_DESC = 2400;
const DEFAULT_HARD_LIMIT_ENTRY = 1200;
const DEFAULT_MAX_KEYWORDS = 8;
const WRITE_MODES = new Set(['append', 'rewrite']);

export { TOOL_NAMES };

/** 注册是一次性的，重复调用直接忽略 */
let registered = false;

/**
 * 注册本插件全部工具。重复调用安全。
 * @param {object} [ctx] 仅用于首次注册，不参与后续判断
 */
export function registerTools(ctx = getContext()) {
    if (registered) {
        return;
    }

    if (typeof ctx?.registerFunctionTool !== 'function') {
        console.error(`${LOG} 当前 ST 没有 registerFunctionTool，工具未注册`);
        return;
    }

    ctx.registerFunctionTool({
        name: TOOL_NAMES.DESC_READ,
        displayName: '读取角色描述',
        description: '读取角色描述全文。写入角色描述之前必须先调用它。',
        parameters: {
            type: 'object',
            properties: {},
        },
        action: () => handleDescRead(),
        formatMessage: () => '读取角色描述',
        shouldRegister: () => shouldRegisterDescription(),
        stealth: false,
    });

    ctx.registerFunctionTool({
        name: TOOL_NAMES.DESC_WRITE,
        displayName: '写入角色描述',
        description: '写入角色描述。append 追加到末尾；rewrite 提交整段新文本，会替换全部现有内容。'
            + '写入前必须先读，写入成功后本轮无需再读。只放角色自身的经历、外貌、认知与态度，不放世界设定。'
            + '返回 staged 表示只暂存、等用户确认，还没进角色卡。',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['append', 'rewrite'],
                    description: 'append 追加到末尾；rewrite 用 text 整体替换现有描述。',
                },
                text: {
                    type: 'string',
                    description: 'mode=append 时为要追加的内容；mode=rewrite 时为完整的描述全文（不是片段）。',
                },
            },
            required: ['mode', 'text'],
        },
        action: params => handleDescWrite(params),
        formatMessage: params => (params?.mode === 'rewrite' ? '改写角色描述' : '追加角色描述'),
        shouldRegister: () => shouldRegisterDescription(),
        stealth: false,
    });

    ctx.registerFunctionTool({
        name: TOOL_NAMES.LORE_READ,
        displayName: '读取世界书',
        description: '读取世界书条目。写入世界书之前必须先调用它，确认已经有什么。'
            + '省略 query 只返回标题总览；带 query 会在标题、关键词、正文里查找并返回正文。',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '检索词。省略则只返回条目标题总览。',
                },
            },
        },
        action: params => handleLoreRead(params),
        formatMessage: params => (params?.query ? `检索世界书：${params.query}` : '浏览世界书标题'),
        shouldRegister: () => shouldRegisterLore(),
        stealth: false,
    });

    ctx.registerFunctionTool({
        name: TOOL_NAMES.LORE_WRITE,
        displayName: '写入世界书',
        description: '新增或整条改写世界书条目。写入前必须先读。'
            + 'title 为同书内唯一的条目标题；content 为完整正文，会整条替换；'
            + 'keys 为触发关键词，新建时必填，改写时省略表示沿用原关键词；'
            + 'logic 为关键词组合方式，省略表示沿用原值。',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: '条目标题，同书内唯一。用短的专有名词，不要写成句子。',
                },
                content: {
                    type: 'string',
                    description: '条目正文，完整内容（整条替换，不是追加）。',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '触发关键词。新建时必填，改写时省略表示沿用原关键词。',
                },
                logic: {
                    type: 'string',
                    enum: ['any', 'all', 'not_all', 'not_any'],
                    description: '关键词组合逻辑，省略表示沿用原值。',
                },
            },
            required: ['title', 'content'],
        },
        action: params => handleLoreWrite(params),
        formatMessage: params => `写入世界书条目：${params?.title ?? ''}`,
        shouldRegister: () => shouldRegisterLore(),
        stealth: false,
    });

    registered = true;
}

/**
 * 每次请求前由 ST 调用。必须同步返回、必须现取 context。
 * @returns {boolean}
 */
export function shouldRegisterDescription() {
    const ctx = getContext();

    if (!isLearningActive(ctx)) {
        return false;
    }

    return ensureSettings(ctx).moduleDescription !== false;
}

/**
 * 世界书工具的门控比描述多一条：没选可写书 = 模块未就绪，工具干脆不注册。
 * 注册了再报 NO_BOOK，模型会反复试 —— 看不见才是"未就绪"的正确表达。
 * @returns {boolean}
 */
export function shouldRegisterLore() {
    const ctx = getContext();

    if (!isLearningActive(ctx)) {
        return false;
    }

    const settings = ensureSettings(ctx);
    if (settings.moduleWorldbook === false) {
        return false;
    }

    return Boolean(getWritableBook(settings));
}

/* ------------------------------------------------------------------ desc_read */

/**
 * desc_read 的执行体。
 * 不出抛异常：ST 会把 Error 原样丢给模型，结构化错误码更好用。
 *
 * 有未处理的 patch 时返回 `after`（模拟叠加）并附 `staged: true`：
 * 模型必须看到"自己刚写的东西"，否则它会以为写入失败，再写一遍。
 * 但 prompt 里仍然是旧描述——这个不一致是设计选择，不在这里补偿。
 */
async function handleDescRead() {
    const ctx = getContext();

    // 防止"生成过程中用户把开关/模块关了"这类竞态：工具已发出，但此刻不该再用
    if (!isDescriptionModuleActive(ctx)) {
        return errorResult('MODULE_DISABLED', '角色描述模块已关闭，不能读写角色描述；现在只能记录世界书条目。');
    }

    const settings = ensureSettings(ctx);
    const softLimit = Number(settings.softLimitDesc) > 0 ? Number(settings.softLimitDesc) : DEFAULT_SOFT_LIMIT_DESC;
    const result = readDescription(ctx, { softLimit });

    if (!result.ok) {
        console.debug(`${LOG} desc_read 失败`, result.error);
        return result;
    }

    const view = descriptionView(ctx);
    const text = view.staged ? view.text : result.text;
    const chars = text.length;
    const overLimit = chars >= softLimit;

    // 读过了才允许写。登记的是"读到的这份内容"的哈希，写入时用它检测中间有没有被改过。
    // 暂存期间读到的就是 after，所以这里登记的也是 after 的哈希
    setReadHash(ctx, READ_KEY_DESC, fnv1a(text));

    const payload = { ok: true, chars, over_limit: overLimit, text };

    // 超阈值只给建议，不拦截：append 仍然可写，硬上限才是拒绝线。
    // 已经硬超限时要说实话——这张卡 append 永远会被拒，只能整段改写。
    // 具体的"该怎么压"是可配的（设置里的压缩指令），这里只负责把事实说准
    if (overLimit) {
        const hardLimit = Number(settings.hardLimitDesc) > 0 ? Number(settings.hardLimitDesc) : DEFAULT_HARD_LIMIT_DESC;
        payload.hint = compactHint(settings, chars > hardLimit
            ? `描述已 ${chars} 字，超过硬上限 ${hardLimit} 字；append 会被直接拒绝，只能整段改写（mode=rewrite）。`
            : `描述已 ${chars} 字，超过软提醒 ${softLimit} 字；append 仍可写入，写到总长超过 ${hardLimit} 字才会被拒绝。`);
    }

    if (view.staged) {
        payload.staged = true;
        payload.note = '这份内容还没写入角色卡，用户确认后才会落盘；在此之前 prompt 里仍是原描述。';
    }

    console.debug(`${LOG} desc_read`, { chars, over_limit: overLimit, staged: view.staged });
    return payload;
}

/* ----------------------------------------------------------------- desc_write */

/**
 * desc_write 的执行体。
 *
 * 守卫顺序不可调（spec §8）：模块 → 角色 → 读登记 → 版本 → 其余校验。
 * 先判"做没做过"再判"参数对不对"：反过来的话，模型会因为参数错误
 * 而一直发现不了自己漏了读取。
 *
 * 基准文本随 patch 状态变：有未处理的 patch 时基准是它的 `after`（模型看到的那份），
 * 否则是磁盘值。校验哈希和计算 `next` 必须用同一个基准，否则合并进 patch 的第二笔
 * 写入永远过不了版本校验。
 */
async function handleDescWrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isDescriptionModuleActive(ctx)) {
        return errorResult('MODULE_DISABLED', '角色描述模块已关闭，不能读写角色描述；现在只能记录世界书条目。');
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return errorResult('NO_CHAR', '当前没有选中角色，请让用户先在角色列表里选一个。');
    }

    // 冲突是用户没做完的决定：写进去会把"用户手改的那一版"和"模型这一版"混成一份，
    // 谁覆盖谁就没有答案了，所以这一段由面板独占
    const pending = getPatch(ctx);
    if (pending?.status === PATCH_STATUS.CONFLICT) {
        return errorResult('PATCH_CONFLICT', '角色描述有一份冲突的改动等着用户处理（暂存之后磁盘被改过）。'
            + '这一轮不要再写描述，继续正文即可；用户处理完再写。');
    }

    // 换行统一成 LF：ST 的编辑面板会把换行写成 CRLF，不归一化哈希永远对不上
    const current = normalizeEol(typeof character.description === 'string'
        ? character.description
        : String(character.description ?? ''));

    const staged = isUnresolved(pending);
    const base = staged ? pending.after : current;

    const recorded = getReadHash(ctx, READ_KEY_DESC);
    if (!recorded) {
        return errorResult('READ_REQUIRED', '本轮还没读过角色描述。先调用 desc_read，再按读到的内容写入。');
    }

    if (fnv1a(base) !== recorded) {
        return errorResult('STALE_READ', '角色描述在你读取之后被改动过。请重新调用 desc_read 拿到最新内容，不要重试原来的参数。');
    }

    const mode = String(params?.mode ?? '');
    if (!WRITE_MODES.has(mode)) {
        return errorResult('INVALID_MODE', 'mode 只能是 append（追加到末尾）或 rewrite（提交完整全文）。');
    }

    const incoming = String(params?.text ?? '');
    if (isBlank(incoming)) {
        return errorResult('EMPTY_CONTENT', '写入内容为空。如果要追加，请给出具体文字。');
    }

    const next = mode === 'rewrite' ? incoming.trim() : appendParagraph(base, incoming);

    const hardLimit = Number(settings.hardLimitDesc) > 0 ? Number(settings.hardLimitDesc) : DEFAULT_HARD_LIMIT_DESC;
    if (next.length > hardLimit) {
        return errorResult('TOO_LONG', compactHint(settings,
            `写入后共 ${next.length} 字，超过上限 ${hardLimit} 字。`));
    }

    if (settings.patchEnabled !== false) {
        stagePatch(ctx, { before: current, after: next });
        // 自写视为已读，登记的是暂存后的全文，同轮再写一笔不会被自己挡住（ADR-007）
        setReadHash(ctx, READ_KEY_DESC, fnv1a(next));

        console.debug(`${LOG} desc_write · staged`, { mode, chars: next.length, id: getPatch(ctx)?.id });

        return {
            ok: true,
            mode,
            added: next.length - base.length,
            staged: true,
            chars: next.length,
            note: '已暂存，用户确认后才写入角色卡。在此之前你的续写仍按原描述进行。',
        };
    }

    const saved = await saveDescription(ctx, character, next);
    if (!saved.ok) {
        console.debug(`${LOG} desc_write 失败`, saved.error);
        return saved;
    }

    // 顺序：先记快照（写之前的版本），再同步内存，最后把新内容登记为"已读"
    rememberDescBackup(ctx, current);
    // 传 current：编辑器里还停着写入前的原文就顺手同步掉，避免用户一次保存把它覆盖回去
    applyDescriptionLocally(character, next, current);
    // 自写视为已读（ADR-007 第 3 条）：不这么做，同轮第二次写入必被 STALE_READ 挡住
    setReadHash(ctx, READ_KEY_DESC, fnv1a(next));
    saveChat(ctx);

    console.debug(`${LOG} desc_write`, { mode, chars: next.length });

    return {
        ok: true,
        mode,
        added: next.length - current.length,
        applied: true,
        chars: next.length,
        note: '已写入角色卡。同一次回复的续写可能已经用上它。',
    };
}

/* ----------------------------------------------------------------- lore_read */

/**
 * lore_read 的执行体。
 *
 * 只读，但仍然要处理两件有状态的事：
 *   1. 换书提醒 —— 换了可写书之后模型会以为自己"忘光了"，不提醒就会把旧内容
 *      原样重写一遍（ADR-017）。提醒比拦截便宜。
 *   2. 读取登记 —— 只有返回过正文的条目登记哈希；只给标题的不登记，否则
 *      总览一下就能"直接改写"，先读后写就形同虚设。
 */
async function handleLoreRead(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isWorldbookModuleActive(ctx)) {
        return errorResult('MODULE_DISABLED', '世界书模块已关闭，不能读写世界书条目；现在只能记录角色描述。');
    }

    if (!getWritableBook(settings)) {
        return errorResult('NO_BOOK', '还没有选择可写书，请让用户到扩展设置里选一本。');
    }

    const state = getState(ctx);
    const previousBook = state.lastBook ?? null;

    const result = await readLore(ctx, settings, { query: params?.query });
    if (!result.ok) {
        return errorResult(result.error, result.hint);
    }

    const { payload, registrations } = result;

    if (previousBook !== payload.book) {
        payload.switched = true;
        payload.note = joinNotes(
            '可写书已切换，这里没有之前那本书的内容，不要重复记录。',
            payload.note,
        );
    }
    state.lastBook = payload.book;

    // 总览通常是"要不要写"的决策点：先把"这本书没激活"这个事实摆出来，
    // 至于该怎么处理，让模型自己决定怎么说
    if (Array.isArray(payload.titles) && isBookScanned(ctx, payload.book) === false) {
        payload.note = joinNotes('这本书当前没有激活。', payload.note);
    }

    for (const item of registrations) {
        setReadHash(ctx, loreReadKey(item.book, item.title), fnv1a(item.content));
    }

    // 书级标记：读完一无所获时条目级留不下痕迹，新建条目要靠它证明"看过书了"
    setReadHash(ctx, bookReadKey(payload.book), BOOK_SEEN);

    console.debug(`${LOG} lore_read`, {
        book: payload.book,
        count: payload.count,
        mode: payload.entries ? 'search' : 'overview',
        registered: registrations.length,
        switched: Boolean(payload.switched),
    });

    return payload;
}

/* ---------------------------------------------------------------- lore_write */

/**
 * lore_write 的执行体。
 *
 * upsert 以标题（`comment`）为键：找到就整条改写、uid 不变，找不到就新建。
 * 守卫顺序仍然服从 spec §8，但"读没读过"这件事在两张表上分别判：
 *
 *   - 已有条目 → 必须读过这条的正文（条目级哈希）。只看过一眼标题列表不够，
 *     否则"总览一下就能覆盖全文"，先读后写形同虚设。
 *   - 新建条目 → 只要看过这本书就行（书级标记）。条目还不存在，没有正文可读，
 *     硬要求条目级登记会让场景 1 死循环。
 */
async function handleLoreWrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isWorldbookModuleActive(ctx)) {
        return errorResult('MODULE_DISABLED', '世界书模块已关闭，不能读写世界书条目；现在只能记录角色描述。');
    }

    // 标题是 upsert 的定位键：空标题既判断不了"新建还是改写"，还会在书里留下一条
    // comment 为空、和所有空标题条目撞车的记录。所以先校验它，再谈其余
    const title = String(params?.title ?? '').trim();
    if (!title) {
        return errorResult('INVALID_TITLE', '标题不能为空：它既是同书内的唯一标识，也会显示在世界书列表里。请用短的专有名词。');
    }
    if (title.length > TITLE_MAX_CHARS) {
        return errorResult('TITLE_TOO_LONG', `标题 ${title.length} 字，超过 ${TITLE_MAX_CHARS} 字上限。请精简成一个短的专有名词。`);
    }

    const loaded = await loadWritableBook(ctx, settings);
    if (!loaded.ok) {
        return loaded;
    }

    const { book, data } = loaded;
    const found = findLoreEntry(data, title);

    // 守卫一：本轮读过没有
    if (found) {
        if (!getReadHash(ctx, loreReadKey(book, title))) {
            return errorResult('READ_REQUIRED', `本轮还没读过条目「${title}」的正文。先调用 lore_read（query 用这个标题或它的关键词），拿到当前内容再改写。`);
        }
    } else if (!getReadHash(ctx, bookReadKey(book))) {
        return errorResult('READ_REQUIRED', `本轮还没看过世界书「${book}」。先调用 lore_read（不带 query 也能看标题总览）确认里面已有什么，避免写出重复条目。`);
    }

    // 守卫二：读完之后又被改过没有
    if (found) {
        const current = String(found.entry.content ?? '');
        if (fnv1a(current) !== getReadHash(ctx, loreReadKey(book, title))) {
            return errorResult('STALE_READ', `条目「${title}」在你读取之后被改动过（可能是用户或其他窗口改的）。请重新 lore_read 拿最新正文，不要重试原来的参数。`);
        }
    }

    // 以下为参数校验（守卫的第 4 步）
    const content = String(params?.content ?? '').trim();
    if (isBlank(content)) {
        return errorResult('EMPTY_CONTENT', '正文为空。世界书条目不能写成空内容，否则等同于删除。');
    }

    const hardLimit = Number(settings.hardLimitEntry) > 0 ? Number(settings.hardLimitEntry) : DEFAULT_HARD_LIMIT_ENTRY;
    if (content.length > hardLimit) {
        return errorResult('TOO_LONG', compactHint(settings,
            `正文 ${content.length} 字，超过单条上限 ${hardLimit} 字；世界书是整条替换、不能分段追加。`));
    }

    const maxKeywords = Number(settings.maxKeywords) > 0 ? Number(settings.maxKeywords) : DEFAULT_MAX_KEYWORDS;
    const normalized = normalizeKeys(params?.keys);
    const keys = normalized.keys.length > 0 ? normalized.keys.slice(0, maxKeywords) : null;
    const droppedKeys = Math.max(0, normalized.keys.length - maxKeywords);

    // 新建却没有关键词 = 永不触发的死条目（ADR-009）
    if (!found && !keys) {
        return errorResult('NO_KEYS', '新建条目至少要给 1 个关键词，否则它永远不会被触发，等于写进黑洞。');
    }

    const logic = typeof params?.logic === 'string' ? params.logic.trim().toLowerCase() : '';
    const before = found ? String(found.entry.content ?? '') : '';
    // 关键词必须在写入前取：applyLoreFields 会就地覆盖 entry.key
    const beforeKeys = found && Array.isArray(found.entry.key) ? found.entry.key.map(String) : [];

    const written = await writeLoreEntry(ctx, settings, book, data, found, {
        title,
        content,
        keys,
        logic,
    });

    if (!written.ok) {
        console.debug(`${LOG} lore_write 失败`, written.error);
        return written;
    }

    // 顺序：快照 → 自写登记 → 落盘对话。快照必须在写入之后也没关系（before 早已捕获），
    // 但自写登记必须在返回前完成，否则同轮第二次写入会被自己的 STALE_READ 挡住（ADR-007）
    rememberLoreBackup(ctx, {
        book,
        title,
        action: written.action,
        before,
        // 恢复时要连关键词一起写回：只回正文等于留下一个按新关键词触发的旧条目
        beforeKeys,
        chars: written.content.length,
    });
    setReadHash(ctx, loreReadKey(book, title), fnv1a(written.content));
    // 新建的条目也算"这本书现在看过"了
    setReadHash(ctx, bookReadKey(book), BOOK_SEEN);
    saveChat(ctx);

    const notes = [];

    // 只陈述事实。"为什么不行""该怎么办"留给模型自己说——那是对话内容，
    // 不是工具返回值该替它决定的东西。
    if (isBookScanned(ctx, book) === false) {
        notes.push(`已写入「${book}」，但这本书当前没有激活。`);
    } else {
        notes.push('已写入。同一次回复的续写可能已经读到它；最迟下一轮生效。');
    }

    if (droppedKeys > 0) {
        notes.push(`关键词超过上限 ${maxKeywords} 个，已只保留前 ${maxKeywords} 个。`);
    }

    console.debug(`${LOG} lore_write`, {
        book,
        title,
        action: written.action,
        chars: written.content.length,
        keys: written.keys.length,
    });

    return {
        ok: true,
        title,
        action: written.action,
        chars: written.content.length,
        keys: written.keys.length,
        note: notes.join(' '),
    };
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 关键词归一：去空白、去空串、去重，保持原顺序。
 * @param {unknown} raw
 * @returns {{ keys: string[] }}
 */
function normalizeKeys(raw) {
    if (!Array.isArray(raw)) {
        return { keys: [] };
    }

    const keys = [];
    for (const item of raw) {
        const key = String(item ?? '').trim();
        if (!key || keys.includes(key)) {
            continue;
        }
        keys.push(key);
    }

    return { keys };
}

function joinNotes(first, second) {
    return second ? `${first} ${second}` : first;
}

/*
 * 这两个用于"工具已经在跑"时的二次校验（开关可能在生成途中被改）。
 * 判据同样走 isLearningActive：被动学习挂上的那一轮，模型必须真的能写。
 */
function isDescriptionModuleActive(ctx) {
    return isLearningActive(ctx) && ensureSettings(ctx).moduleDescription !== false;
}

function isWorldbookModuleActive(ctx) {
    return isLearningActive(ctx) && ensureSettings(ctx).moduleWorldbook !== false;
}

function errorResult(error, hint) {
    // 兜底用统一目录：任何一条错误回到模型面前时都得有下一步动作，
    // 不能因为某个分支漏写 hint 就丢出一个裸的 { ok: false, error }
    const text = hint || hintFor(error);
    return text ? { ok: false, error, hint: text } : { ok: false, error };
}
