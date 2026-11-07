/**
 * compress.js · 超长内容的收集、手动压缩与（待接线的）智能压缩
 *
 * 为什么单独成模块：v0.21 之前"超限"是模型侧的事——工具返回里附一句压缩指令，
 * 让模型自己压。但"该压哪条、压到什么程度"取决于对话上下文、条目重要性和用户的
 * 判断：同一条 900 字的设定，有时候该删、有时候一个字都不能动。自动触发必然在
 * 某个场景里压错，而且压错了模型自己也不知道该保留什么。
 *
 * 所以这一整块搬到用户手里：
 *
 *   - 软提醒只在这里用：算"哪些内容值得压"，不再进入任何工具返回（见 tools.js）
 *   - 硬上限仍在 tools.js 里拒绝模型的写入，这条不受影响
 *   - 面板里可以逐条手动改，也可以勾选后走智能压缩（接线前的占位）
 *
 * 四个出口：
 *   scanCompressTargets  读一遍世界书与角色描述，算出超软提醒的那些
 *   refreshCompressState 扫一遍并把结果存成快照，然后广播给界面
 *   saveManualEdit       用户在面板里改完，写回世界书 / 角色卡
 *   smartCompress        智能压缩（占位，见函数注释）
 *
 * 面板本身在 ui/compress-panel.js。这里不碰 DOM——除了"该重扫了 / 结果变了"
 * 通过 events.js 广播出去。
 */

import { getContext } from '../../../../extensions.js';
import { compactHint } from './compact.js';
import { COMPRESS_EVENT } from './events.js';
import { readLimits } from './limits.js';
import { diskDescription, getPatch, isUnresolved } from './patch.js';
import {
    READ_KEY_DESC,
    clearReadHash,
    clearReadKeysByPrefix,
    ensureSettings,
    lorePatternPrefix,
    loreReadKey,
    rememberDescBackup,
    rememberLoreBackup,
    saveChat,
} from './store.js';
import {
    applyDescriptionLocally,
    entryTitle,
    findLoreEntry,
    getActiveCharacter,
    getWritableBook,
    loadWritableBook,
    replaceLoreEntry,
    saveDescription,
} from './targets.js';
import { normalizeEol } from './util.js';

const LOG = '[Thrive]';

/** 角色描述在这份列表里的固定 id：世界书条目的 id 都带 `lore:` 前缀，不会撞 */
export const DESC_ITEM_ID = 'desc';

/**
 * 空快照。界面在第一次扫描完成之前读到的就是它——所以字段必须齐，
 * 让"还没扫过"和"扫过了什么都没有"走同一套渲染。
 */
function emptySnapshot() {
    return {
        /** 扫描完成的时间；0 = 还没扫过 */
        at: 0,
        /** 这次扫的是哪本可写书 */
        book: '',
        /** 超过软提醒的目标，描述在最前，其余按字数从多到少 */
        items: [],
        /** 世界书那一段没扫成功时的原因（没选书 / 读不到）；空串 = 正常 */
        error: '',
        /** 有没有一份还没应用的描述改动（它不计入统计，只是一句提醒） */
        descPending: false,
        /** 统计口径，界面直接拿来显示，避免两处各读一次设置算出不同的数 */
        limits: { entrySoft: 0, entryHard: 0, descSoft: 0, descHard: 0 },
    };
}

let snapshot = emptySnapshot();

/** 扫描代次：连发几次扫描时只让最后那次的结果落地 */
let scanToken = 0;

/** 去抖用的定时器（同一轮里连续触发只扫一次） */
let scanTimer = 0;

/** 界面同步读的那份快照。只读副本，调用方不要改 */
export function getCompressSnapshot() {
    return {
        ...snapshot,
        items: snapshot.items.map(item => ({ ...item })),
        limits: { ...snapshot.limits },
    };
}

/** 需要压缩的条数——徽章、面板入口、设置页那一行都用它 */
export function compressNeeded() {
    return snapshot.items.length;
}

/**
 * 读一遍所有目标，算出超过软提醒的那些。
 *
 * 两处"以实际情况为准"：
 *   - 角色描述只看**盘上**那份（`diskDescription`）。暂存成 patch、还没应用的文本
 *     不算——它还没进过 prompt，压缩它等于压一份不存在的正文。
 *   - 世界书每次都重新 load，不拿缓存：用户可能刚在世界书面板里改过。
 *
 * 停用的条目（`disable: true`）不列：它不会进入上下文，压它没有意义。
 *
 * @param {object} ctx
 * @param {object} settings
 * @returns {Promise<ReturnType<typeof emptySnapshot>>}
 */
export async function scanCompressTargets(ctx, settings) {
    const limits = readLimits(settings);
    const result = emptySnapshot();

    result.limits = {
        entrySoft: limits.softLimitEntry,
        entryHard: limits.hardLimitEntry,
        descSoft: limits.softLimitDesc,
        descHard: limits.hardLimitDesc,
    };

    result.descPending = isUnresolved(getPatch(ctx));

    if (settings.moduleDescription !== false) {
        const character = getActiveCharacter(ctx);
        const text = diskDescription(ctx);
        if (character && text.length >= limits.softLimitDesc) {
            result.items.push({
                id: DESC_ITEM_ID,
                kind: 'desc',
                book: '',
                title: character.name ? `角色描述（${character.name}）` : '角色描述',
                /*
                 * 记下头像文件名：保存时用它确认"还是同一个角色"。面板开着的时候用户
                 * 完全可能去左侧换一个角色，那时把 A 的正文写进 B 的卡是灾难。
                 */
                avatar: String(character.avatar ?? ''),
                chars: text.length,
                soft: limits.softLimitDesc,
                hard: limits.hardLimitDesc,
                level: text.length > limits.hardLimitDesc ? 'hard' : 'soft',
                keys: [],
                text,
            });
        }
    }

    if (settings.moduleWorldbook === false) {
        return result;
    }

    const book = getWritableBook(settings);
    result.book = book;

    if (!book) {
        result.error = '还没选择可写书，世界书条目没有参与检查。';
        return result;
    }

    const loaded = await loadWritableBook(ctx, settings);
    if (!loaded.ok) {
        result.error = loaded.hint ?? `读不到可写书「${book}」。`;
        return result;
    }

    const entries = Object.values(loaded.data?.entries ?? {}).filter(Boolean);

    for (const entry of entries) {
        if (entry.disable === true) {
            continue;
        }

        const text = String(entry.content ?? '');
        if (text.length < limits.softLimitEntry) {
            continue;
        }

        result.items.push({
            /*
             * id 里带 uid：世界书允许两条条目用同一个标题（插件自己的 lore_add 会拦住，
             * 但别处建的不一定），只按"书名 + 标题"定位会让它们撞成一条。
             */
            id: `lore:${book}|${entryTitle(entry)}|${uidOf(entry) ?? 'na'}`,
            kind: 'lore',
            book,
            title: entryTitle(entry),
            uid: uidOf(entry),
            chars: text.length,
            soft: limits.softLimitEntry,
            hard: limits.hardLimitEntry,
            level: text.length > limits.hardLimitEntry ? 'hard' : 'soft',
            keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
            text,
        });
    }

    sortItems(result.items);
    return result;
}

/**
 * 排序：描述永远第一（它只有一个，而且是"整张卡的自我介绍"），
 * 其余按超出软提醒的幅度从大到小——最该处理的排在最上面。
 */
function sortItems(items) {
    items.sort((left, right) => {
        if (left.kind !== right.kind) {
            return left.kind === 'desc' ? -1 : 1;
        }
        return (right.chars - right.soft) - (left.chars - left.soft);
    });
}

/**
 * 扫一遍并广播。
 *
 * 结果写进模块级快照：徽章、浮动面板入口、设置页那行、压缩面板自己都要读它，
 * 而这几处渲染是同步的，扫描是异步的——中间必须有一份"最近一次结果"。
 *
 * @param {object} [ctx]
 * @returns {Promise<ReturnType<typeof getCompressSnapshot>>}
 */
export async function refreshCompressState(ctx = getContext()) {
    const settings = ensureSettings(ctx);
    const token = ++scanToken;

    let next;
    try {
        next = await scanCompressTargets(ctx, settings);
    } catch (err) {
        console.warn(`${LOG} 扫描超长内容失败`, err);
        next = emptySnapshot();
        next.error = '扫描失败，详情见控制台。';
    }

    // 有更新的一次扫描在跑：它的结果更接近此刻的磁盘状态
    if (token !== scanToken) {
        return getCompressSnapshot();
    }

    /*
     * 新冒出来的那几条单独记下来，交给界面决定要不要弹一句提醒。
     * 第一次扫描（`at === 0`）不算"新增"：那只是把早就超长的内容读出来，
     * 一打开页面就弹一串提示只会让人学会无视它。
     */
    const firstScan = snapshot.at === 0;
    const before = new Set(snapshot.items.map(item => item.id));
    const added = firstScan ? [] : next.items.filter(item => !before.has(item.id));

    next.at = Date.now();
    snapshot = next;
    notifyCompress(added);
    return getCompressSnapshot();
}

/**
 * 去抖地请求一次扫描。
 *
 * 触发点很多（刷新界面、切对话、角色卡被保存、一轮回复结束、改软提醒数值），
 * 每个都直接扫一遍会连着读好几次世界书。合并成一次即可——晚 200ms 知道
 * "有几条超长"完全不影响用户。
 *
 * @param {object} [ctx]
 * @param {number} [delay]
 */
export function requestCompressScan(ctx = getContext(), delay = 250) {
    clearTimeout(scanTimer);

    if (delay <= 0) {
        void refreshCompressState(ctx);
        return;
    }

    scanTimer = setTimeout(() => {
        void refreshCompressState(ctx);
    }, delay);
}

/**
 * 用户在压缩面板里改完之后写回。
 *
 * 与模型的写入是两条不同的路径，共用同一批底层函数，但有两点不一样：
 *   1. 不检查"先读后写"——改的人就是用户，不需要授权
 *   2. 硬上限仍然拦：超了不让存。这条不是限制用户，而是防止"压完还是超长"，
 *      下次模型写入照样被拒，白忙一场
 *
 * @param {object} ctx
 * @param {object} item scanCompressTargets 产出的一条
 * @param {string} rawText 编辑框里的全文
 * @returns {Promise<{ ok: true, chars: number, editor?: object }
 *          | { ok: false, error: string, hint?: string }>}
 */
export async function saveManualEdit(ctx, item, rawText) {
    if (!item) {
        return { ok: false, error: 'NO_ITEM', hint: '这条内容已经不在列表里了，重新扫描一次再试。' };
    }

    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);
    const hard = item.kind === 'desc' ? limits.hardLimitDesc : limits.hardLimitEntry;
    const text = normalizeEol(String(rawText ?? '')).trim();

    if (!text) {
        return {
            ok: false,
            error: 'EMPTY_CONTENT',
            hint: '不能存成空内容：世界书条目空了等于删除，角色描述空了等于抹掉整张卡。',
        };
    }

    if (text.length > hard) {
        return {
            ok: false,
            error: 'TOO_LONG',
            hint: `${text.length} 字，还是超过硬上限 ${hard} 字。再精简一些，或者到「数值与上限」里调高硬上限。`,
        };
    }

    return item.kind === 'desc'
        ? writeDescription(ctx, item, text)
        : writeLoreEntry(ctx, settings, item, text, hard);
}

/** 写回一条世界书条目的正文（标题与关键词不动） */
async function writeLoreEntry(ctx, settings, item, text, hard) {
    /*
     * 先确认可写书没被换掉：面板里那一行说的是「哪本书里的哪条」，
     * 而写入永远落在"当前可写书"。换过书还照写，就会拿 A 书的正文去覆盖 B 书的同 uid 条目。
     */
    const book = getWritableBook(settings);
    if (!book || (item.book && book !== item.book)) {
        return {
            ok: false,
            error: 'BOOK_CHANGED',
            hint: `可写书已经不是「${item.book}」了，这一行内容对不上。重新扫描一次再改。`,
        };
    }

    const loaded = await loadWritableBook(ctx, settings);
    if (!loaded.ok) {
        return loaded;
    }

    /*
     * 优先按 uid 定位：扫描时就是按 uid 认的这条，书名与标题都可能被别处改过。
     * 找不到 uid（老数据 / 条目被重建）再退回按标题找，行为和工具的写入路径一致。
     */
    const found = locateByUid(loaded.data, item.uid) ?? findLoreEntry(loaded.data, item.title);
    if (!found) {
        return {
            ok: false,
            error: 'NOT_FOUND',
            hint: `「${loaded.book}」里已经没有「${item.title}」了，可能在别处被删掉或改了标题。重新扫描一次。`,
        };
    }

    const before = String(found.entry.content ?? '');
    if (before === text) {
        return { ok: false, error: 'NO_CHANGE', hint: '内容和现在一样，没有需要保存的改动。' };
    }

    const result = await replaceLoreEntry(ctx, loaded.book, loaded.data, found, text, { hardLimit: hard });
    if (!result.ok) {
        return result;
    }

    // 留一份快照：手动压缩也是覆盖，压过头了还得能从面板的「已写入」里退回来
    rememberLoreBackup(ctx, {
        book: loaded.book,
        title: item.title,
        action: 'rewritten',
        before,
        beforeKeys: Array.isArray(found.entry.key) ? found.entry.key.map(String) : [],
        chars: text.length,
    });

    /*
     * 正文被插件替用户改了：模型这一轮读过的"这条多长、哪里有什么"随之失效。
     * 不作废的话，它下一次写入会基于旧认知覆盖掉刚压出来的版本。
     */
    clearReadHash(ctx, loreReadKey(loaded.book, item.title));
    clearReadKeysByPrefix(ctx, lorePatternPrefix(loaded.book, item.title));
    saveChat(ctx);

    console.debug(`${LOG} 手动压缩条目`, { book: loaded.book, title: item.title, before: before.length, after: text.length });

    return { ok: true, chars: text.length, beforeChars: before.length };
}

/** 写回角色描述 */
async function writeDescription(ctx, item, text) {
    if (isUnresolved(getPatch(ctx))) {
        return {
            ok: false,
            error: 'PATCH_PENDING',
            hint: '还有一份待确认的描述改动。它和这里的编辑会互相覆盖，先到浮动面板里写入或丢弃。',
        };
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return { ok: false, error: 'NO_CHAR', hint: '当前没有选中角色，改不了描述。' };
    }

    // 面板开着时用户可能换了角色：那这一行说的已经不是眼前这张卡
    if (item?.avatar && String(character.avatar ?? '') !== item.avatar) {
        return {
            ok: false,
            error: 'CHAR_CHANGED',
            hint: '当前角色已经换了，这一行说的是另一个角色的描述。重新扫描一次再改。',
        };
    }

    const before = diskDescription(ctx);
    if (before === text) {
        return { ok: false, error: 'NO_CHANGE', hint: '内容和角色卡上的一样，没有需要保存的改动。' };
    }

    const saved = await saveDescription(ctx, character, text);
    if (!saved.ok) {
        return saved;
    }

    rememberDescBackup(ctx, before);
    // 第三个参数传盘上原文：编辑框里还停着旧文本时顺手同步，用户改过就不动
    const editor = applyDescriptionLocally(character, text, before);

    // 盘上内容变了，读取登记作废：让模型重新读，而不是拿旧哈希去写
    clearReadHash(ctx, READ_KEY_DESC);
    saveChat(ctx);

    console.debug(`${LOG} 手动压缩描述`, { before: before.length, after: text.length });

    return { ok: true, chars: text.length, beforeChars: before.length, editor };
}

/** 条目的 uid；没有有效 uid 时返回 null（不要用 0 兜底——0 是合法 uid） */
function uidOf(entry) {
    const value = Number(entry?.uid);
    return Number.isFinite(value) ? value : null;
}

/** 按 uid 直接取条目；拿不到就返回 null，由调用方退回按标题找 */
function locateByUid(data, uid) {
    if (uid === null || uid === undefined) {
        return null;
    }

    const key = String(uid);
    const entry = data?.entries?.[key];
    return entry ? { key, uid, entry } : null;
}

/**
 * 智能压缩（占位，还没接线）。
 *
 * 原理与 v0.21 的自动压缩一致：把目标正文、字数事实和「压缩指令」一起交给大模型，
 * 让它自己决定留哪句——规则写得越细，它越会照着套模板去砍，最后压出来的是一份
 * 摘要而不是它自己的记忆（见 compact.js 的注释）。
 *
 * 区别只在触发方式：从"工具返回里自动附一句"改成"用户在面板里勾选后手动发起"，
 * 所以压缩指令仍然留在提示词卡片里可编辑（`compactPrompt`），命令也没换。
 *
 * 还没接线，缺的是三件事：调模型的入口、结果预览、逐条确认后才写回。在那之前
 * 这里只返回 NOT_IMPLEMENTED，界面据此说明"还没实现"，绝不假装压过。
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {Array<object>} items 被勾选的条目
 * @returns {{ ok: false, error: string, hint: string, requests?: Array<{ id: string, prompt: string }> }}
 */
export function smartCompress(ctx, settings, items) {
    const picked = Array.isArray(items) ? items.filter(Boolean) : [];

    if (picked.length === 0) {
        return {
            ok: false,
            error: 'NO_SELECTION',
            hint: '先在列表里勾选要压缩的条目。',
        };
    }

    return {
        ok: false,
        error: 'NOT_IMPLEMENTED',
        hint: `智能压缩还没接线：勾选的 ${picked.length} 条不会被改动，先用手动编辑。`,
        /*
         * 接线时按这份请求发出去。放在返回值里而不是直接调用模型，
         * 是为了让"还没实现"这一版也能验证提示词拼得对不对。
         */
        requests: picked.map(item => ({
            id: item.id,
            prompt: compactHint(settings, factFor(item)),
        })),
    };
}

/** 给模型看的事实句：多少字、超了哪个阈值、硬上限在哪 */
function factFor(item) {
    const over = item.chars - item.soft;
    const tail = item.chars > item.hard
        ? `已经超过硬上限 ${item.hard} 字，模型再写这条会被直接拒绝。`
        : `距硬上限 ${item.hard} 字还剩 ${item.hard - item.chars} 字。`;
    return `${item.title}目前 ${item.chars} 字，比软提醒（${item.soft} 字）多 ${over} 字。${tail}`;
}

/**
 * 广播给界面（浮动面板入口、设置页那行、压缩面板自己）。
 *
 * @param {Array<object>} [added] 这次扫描新冒出来的超长条目（不含首次扫描的全量）
 */
function notifyCompress(added = []) {
    try {
        document.dispatchEvent(new CustomEvent(COMPRESS_EVENT, {
            detail: {
                count: snapshot.items.length,
                added: added.map(item => item.title),
            },
        }));
    } catch {
        // 没有 document 的环境（纯逻辑用例）没有界面要刷
    }
}
