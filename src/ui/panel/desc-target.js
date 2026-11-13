/** Per-chat description and creation destinations, including deferred preparation notices. */

import { syncDescEntries } from '../../features/memory/desc.js';
import { normalizeDescFormats } from '../../features/memory/desc-entry.js';
import { clearLearningQueue, isLearningRunning, stopLearning } from '../../features/learning/learning.js';
import { hintFor } from '../../shared/diagnostics.js';
import { getPatch, isUnresolved } from '../../features/memory/patch.js';
import {
    isWorldbookDesc,
    setDescStorageMode,
    setWritableBookSetting,
    getDescriptionBookSetting,
    setDescriptionBookSetting,
    getWritableBookSetting,
    getDescFormats,
    getActiveDescFormats,
    setDescFormats,
} from '../../features/settings/index.js';
import { getActiveCharacter, getWritableBook, isBookScanned } from '../../features/memory/index.js';
import { getDescriptionBook } from '../../features/memory/target-selection.js';
import { LOG, toast } from '../shared/common.js';

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

    const books = [];
    for (const name of names) {
        const tag = annotations.get(name)?.tag;
        books.push({ value: name, label: tag ? `${name}（${tag}）` : name });
    }

    const descriptionBook = getDescriptionBook(ctx);
    const notices = [];
    for (const [label, name] of [
        ...(forced ? [['角色描述', descriptionBook]] : []),
        ['其它设定', book],
    ]) {
        if (!names.includes(name)) notices.push(`${label}「${name}」尚不存在，将在下次写入时自动创建。`);
        else if (!isBookScanned(ctx, name)) notices.push(`${label}「${name}」未激活，将在下次读取前自动激活。`);
    }
    return { storage: forced ? 'worldbook' : 'card', forced, book, descriptionBook, books,
        bookSetting: getWritableBookSetting(ctx), descriptionBookSetting: getDescriptionBookSetting(ctx),
        notices, formats: getDescFormats(ctx) };
}

export async function changeDescFormats(ctx, formats) {
    const next = normalizeDescFormats(formats);
    const chatId = ctx.getCurrentChatId?.();
    if (isWorldbookDesc(ctx)) {
        const result = await syncDescEntries(ctx, next, { create: false });
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

/** Changing the creation destination preserves every existing book and draft. */
export async function changeWritableBook(ctx, book) {
    setWritableBookSetting(ctx, book);
    return { ok: true, changed: true };
}

export async function changeDescriptionBook(ctx, book) {
    // Selecting a destination does not migrate or modify any previous book.
    setDescriptionBookSetting(ctx, book);
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
 * 切到世界书模式；已有条目同步状态，缺失书留到首次写入。
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

    const ensured = await syncDescEntries(ctx, getDescFormats(ctx), { create: false });
    if (!ensured.ok) {
        toast(ensured.hint ?? `切换失败：${ensured.error}`);
        return { ok: false, changed: false };
    }
    if (ctx.getCurrentChatId?.() !== chatId) return { ok: false, changed: false };

    setDescStorageMode(ctx, 'worldbook');
    const learningBlocked = warnIfLearningBlocked(ctx);

    if (!learningBlocked) toast('已切到世界书条目；缺失的书将在下次写入时创建');

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
