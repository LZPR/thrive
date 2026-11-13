/**
 * ui/desc-target.js · 「描述存哪儿」与「可写书」两个落点
 *
 * 这两项都是**对话级**的（ADR-044）：换一场对话通常就换了角色，落点跟着变才对。
 * 按"作用域用位置表达"这条线（ADR-043 / ADR-045），它们的控件住在浮动面板的
 * 「更多设置」里，设置页不再出现——那一页只放对所有对话一致的东西。
 *
 * 这个文件管"选项怎么排、切过去要做什么"，不管排版：面板负责把 view 画出来。
 * 切换是有副作用的，所以不能像普通下拉那样写个值就完事：
 *   · 切到统一模式：先确认没有未决 patch（那份 diff 在新模式里没有处理入口），
 *     再把"书 + 常驻条目"准备好，最后才改状态。反过来的话，状态已经变了、
 *     条目却没建出来，模型会读到一份空描述，而用户以为只是换了个存储位置。
 *   · 切回角色卡：把条目停用（内容保留），否则两处内容会同时进上下文。
 *   · 换可写书：先问一句（新书里没有旧书的内容），并把 lastBook 清掉，
 *     下一次读取才会带上"可写书已切换"的提醒（spec §11.3）。
 */

import { syncDescEntries } from '../../features/memory/desc.js';
import { normalizeDescFormats } from '../../features/memory/desc-entry.js';
import { clearLearningQueue, isLearningRunning, stopLearning } from '../../features/learning/learning.js';
import { hintFor } from '../../shared/diagnostics.js';
import { clearDraft, summarizeDraft } from '../../features/memory/draft.js';
import { getPatch, isUnresolved } from '../../features/memory/patch.js';
import {
    isWorldbookDesc,
    setDescStorageMode,
    setWritableBookSetting,
    getState,
    getDescFormats,
    getActiveDescFormats,
    setDescFormats,
    saveChat,
} from '../../features/settings/index.js';
import { getActiveCharacter, getWritableBook, isBookScanned } from '../../features/memory/index.js';
import { LOG, askConfirm, toast } from '../shared/common.js';

/** 角色卡上绑定的主世界书（`character.data.extensions.world`），空串 = 没绑 */
function boundBookName(character) {
    const value = character?.data?.extensions?.world;
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 两类需要提醒的书（spec §11.1）。标记放在选项文字里——下拉里 `title` 根本看不到。
 *
 *   tag  —— 塞进选项的短标记；
 *   note —— 选中之后写在下面的一句完整说明（面板的落点段用它）。
 */
export function bookAnnotations(character) {
    const map = new Map();

    const bound = boundBookName(character);
    if (bound) {
        map.set(bound, {
            tag: '角色自带',
            note: '这本书是角色自带的：改动会随角色卡分发。',
        });
    }

    const embedded = character?.data?.character_book?.name;
    if (typeof embedded === 'string' && embedded.trim() && !map.has(embedded.trim())) {
        map.set(embedded.trim(), {
            tag: '卡内嵌副本',
            note: '疑似卡内嵌副本：独立文件与卡里那份不会自动同步。',
        });
    }

    return map;
}

function listNames(ctx) {
    try {
        const names = ctx.getWorldInfoNames?.();
        return Array.isArray(names) ? names.map(String) : [];
    } catch {
        return [];
    }
}

/**
 * 面板要的那一份状态：当前模式、可写书、以及下拉该列哪些书。
 *
 * 每次重绘都现算（一遍 `getWorldInfoNames()`，是数组副本，很便宜），
 * 这样"刚在世界书面板建了一本书"下一次打开面板就能选到。
 *
 * @param {object} ctx
 * @returns {{ storage: 'card'|'worldbook', forced: boolean, book: string,
 *             books: Array<{ value: string, label: string }> }}
 */
export function descTargetView(ctx) {
    const forced = isWorldbookDesc(ctx);
    const book = getWritableBook(ctx);
    const names = listNames(ctx);
    const annotations = bookAnnotations(getActiveCharacter(ctx));

    const books = [{ value: '', label: '未选择' }];
    for (const name of names) {
        const tag = annotations.get(name)?.tag;
        books.push({ value: name, label: tag ? `${name}（${tag}）` : name });
    }

    /*
     * 当前值可能不在列表里：统一模式下那本书还没建（第一次写入才建），或者用户选的书
     * 被删/改名了。补一条并说明原因，别让下拉看起来"选了个空气"。
     */
    if (book && !names.includes(book)) {
        books.push({ value: book, label: forced ? `${book}（还没建）` : `${book}（已不存在）` });
    }

    return { storage: forced ? 'worldbook' : 'card', forced, book, books, formats: getDescFormats(ctx) };
}

export async function changeDescFormats(ctx, formats) {
    const next = normalizeDescFormats(formats);
    const chatId = ctx.getCurrentChatId?.();
    if (isWorldbookDesc(ctx)) {
        const result = await syncDescEntries(ctx, next);
        if (!result.ok) {
            toast(result.hint ?? `切换描述方式失败：${result.error}`);
            return { ok: false, changed: false };
        }
    }
    if (ctx.getCurrentChatId?.() !== chatId) return { ok: false, changed: false };
    setDescFormats(ctx, next);
    warnIfLearningBlocked(ctx);
    return { ok: true, changed: true };
}

/** 零种可用方式时暂停全部学习；保留空选择，让用户按自己的意图重新配置。 */
function warnIfLearningBlocked(ctx) {
    if (getActiveDescFormats(ctx).length > 0) {
        return false;
    }

    if (isLearningRunning()) {
        stopLearning();
    } else {
        clearLearningQueue();
    }
    const warning = hintFor('NO_DESC_FORMAT');
    if (globalThis.toastr?.warning) {
        globalThis.toastr.warning(warning);
    } else {
        toast(warning);
    }
    return true;
}

/**
 * 换可写书。统一模式下是空操作（下拉本来就置灰）。
 *
 * @param {object} ctx
 * @param {string} book
 * @returns {Promise<{ ok: boolean, changed: boolean }>}
 */
export async function changeWritableBook(ctx, book) {
    if (isWorldbookDesc(ctx)) {
        return { ok: false, changed: false };
    }

    const next = String(book ?? '').trim();
    const previous = getWritableBook(ctx);
    if (next === previous) {
        return { ok: true, changed: false };
    }

    /*
     * 缓冲区是"某本书的中间层"：换书之后它既不该跟着走，也不该悄悄丢掉里面没保存的东西。
     * 有改动就拦住，让用户先去窗口里做完决定；只有一块空壳（一条都没改过）时直接收掉，
     * 否则它会一直挡着新书——工具写新书时会被 DRAFT_BOOK 拒掉。
     */
    const draft = summarizeDraft(ctx);
    if (draft.exists && draft.book !== next) {
        if (draft.touched > 0) {
            toast(`虚拟世界书里还有「${draft.book}」的 ${draft.touched} 条改动没保存：`
                + '先在面板标题栏那颗书页图标里保存或丢弃，再换书');
            return { ok: false, changed: false };
        }
        clearDraft(ctx);
    }

    if (previous && next) {
        const confirmed = await askConfirm('换书之后，新书里没有旧书的内容，角色不会记得它们。确定切换吗？');
        if (!confirmed) {
            return { ok: false, changed: false };
        }
        // 换书后清掉 lastBook，下一次读取就会带上 switched 提醒（spec §11.3）
        getState(ctx).lastBook = null;
        saveChat(ctx);
    }

    setWritableBookSetting(ctx, next);
    return { ok: true, changed: true };
}

/**
 * 切换描述存储模式。
 *
 * @param {object} ctx
 * @param {'card'|'worldbook'} mode
 * @returns {Promise<{ ok: boolean, changed: boolean }>}
 */
export async function changeDescStorage(ctx, mode) {
    const wanted = mode === 'worldbook' ? 'worldbook' : 'card';
    const current = isWorldbookDesc(ctx) ? 'worldbook' : 'card';
    if (wanted === current) {
        return { ok: true, changed: false };
    }

    return wanted === 'worldbook'
        ? switchToWorldbook(ctx)
        : switchToCard(ctx);
}

/**
 * 切到统一模式：先把书与常驻条目准备好，再改状态。
 * @returns {Promise<{ ok: boolean, changed: boolean }>}
 */
async function switchToWorldbook(ctx) {
    const chatId = ctx.getCurrentChatId?.();
    if (!getActiveCharacter(ctx)) {
        toast('请先选一个角色');
        return { ok: false, changed: false };
    }

    // 未决 patch 在新模式里没有处理入口：先让用户在上面那份 diff 里做完决定
    if (isUnresolved(getPatch(ctx))) {
        toast('还有一份待处理的描述改动：先在上面「待确认」里写入或丢弃');
        return { ok: false, changed: false };
    }

    const ensured = await syncDescEntries(ctx, getDescFormats(ctx));
    if (!ensured.ok) {
        toast(ensured.hint ?? `切换失败：${ensured.error}`);
        return { ok: false, changed: false };
    }
    if (ctx.getCurrentChatId?.() !== chatId) return { ok: false, changed: false };

    setDescStorageMode(ctx, 'worldbook');
    const learningBlocked = warnIfLearningBlocked(ctx);

    // 未激活只说"去哪开"：这一刻用户已经决定换模式了，解释为什么、要不要处理角色卡上的旧描述
    // 都帮不上忙（ADR-046）
    if (isBookScanned(ctx, ensured.book) === false) {
        toast(`「${ensured.book}」还没有激活：到「世界书」面板勾选这本书`);
    } else if (!learningBlocked) {
        toast('已切到世界书条目：每种已启用的描述方式各使用一条专属条目');
    }

    return { ok: true, changed: true };
}

/**
 * 切回角色卡模式。条目停用但内容不动：切回来的那天东西还在，只是不再和角色卡抢上下文。
 * 停用失败时保留原模式，避免角色卡与世界书同时注入描述。
 */
async function switchToCard(ctx) {
    const chatId = ctx.getCurrentChatId?.();
    try {
        const result = await syncDescEntries(ctx, []);
        if (!result.ok) {
            toast(result.hint ?? `切换失败：${result.error}`);
            return { ok: false, changed: false };
        }
    } catch (err) {
        console.debug(`${LOG} 停用描述条目失败`, err);
        toast('停用描述条目失败，请稍后重试');
        return { ok: false, changed: false };
    }
    if (ctx.getCurrentChatId?.() !== chatId) return { ok: false, changed: false };

    setDescStorageMode(ctx, 'card');
    if (!warnIfLearningBlocked(ctx)) {
        toast('已切回角色卡存储；世界书里的描述条目已停用，内容保留。PLists / Ali:Chat 暂不生效');
    }
    return { ok: true, changed: true };
}
