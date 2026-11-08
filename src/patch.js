/**
 * patch.js · 角色描述的"磁盘 vs 暂存"
 *
 * **只在 `descStorage = 'card'` 时生效。** 统一使用世界书的模式里没有 patch：
 * 描述直接写成一条世界书条目，不在面板里做 diff（ADR-042）。所以本模块的
 * 所有入口都由调用方按模式收口，不要在这里再判一次模式（会绕成循环 import）。
 *
 * patch 只表达一份差异（ADR-006）：`before` 是磁盘上的原文，`after` 是模型想让它
 * 变成的样子。同一时刻最多一个。模型在 patch 存在时再写一次，是**往同一份差异上叠**，
 * 而不是再开一条——多条会形成链式依赖，第 1 条被丢弃，第 2 条的基准就失效了。
 *
 * 状态机：
 *
 *   pending ──接受──→ applied（落盘，面板留一条记录）
 *      │   ╲
 *      │    ╲──磁盘被手改──→ conflict ──强制覆盖──→ applied
 *      │                        │
 *      └────────丢弃────────────┴──丢弃──→ null（磁盘不动）
 *
 * 暂存期间 `desc_read` 返回 `after`（模拟叠加）。prompt 里仍然是旧描述——这是
 * ADR-005/010 的代价，插件不会偷偷把暂存内容塞进提示词。
 */

import {
    READ_KEY_DESC,
    clearReadHash,
    getDescBackup,
    getState,
    rememberDescBackup,
    saveChat,
    setReadHash,
} from './store.js';
import {
    applyDescriptionLocally,
    cardDescription,
    getActiveCharacter,
    saveDescription,
} from './targets.js';
import { notifyPanel } from './events.js';
import { fnv1a, normalizeEol } from './util.js';

export const PATCH_STATUS = Object.freeze({
    /** 已暂存，等用户确认 */
    PENDING: 'pending',
    /** 暂存之后磁盘被改过，只能强制覆盖或丢弃 */
    CONFLICT: 'conflict',
    /** 已写入角色卡，等用户关掉这条记录 */
    APPLIED: 'applied',
});

/** 还没处理完的 patch（pending 或 conflict）——"面板该不该亮"的唯一判据 */
export function isUnresolved(patch) {
    return Boolean(patch)
        && (patch.status === PATCH_STATUS.PENDING || patch.status === PATCH_STATUS.CONFLICT);
}

/** 取当前对话的 patch；形状不对当没有 */
export function getPatch(ctx) {
    const patch = getState(ctx).patch;
    return patch && typeof patch === 'object' && typeof patch.after === 'string' ? patch : null;
}

/** 角色卡上的描述全文（空角色返回空串）。统一模式请用 desc.js 的 readDesc */
export function diskDescription(ctx) {
    return cardDescription(ctx);
}

/**
 * 模型该看到的那份文本：有未处理的 patch 就是 `after`，否则是磁盘值。
 * `desc_read` 用它，`desc_write` 也用它当基准——两边必须同源，否则哈希永远对不上。
 * @returns {{ text: string, staged: boolean }}
 */
export function descriptionView(ctx) {
    const patch = getPatch(ctx);
    if (isUnresolved(patch)) {
        return { text: patch.after, staged: true };
    }
    return { text: diskDescription(ctx), staged: false };
}

/**
 * 暂存一次写入。
 *
 * - 已有 pending：以它的 `after` 为基准算新 `after`，`before` / `beforeHash` / `id`
 *   都不动，两次改动合并进同一份 diff。
 * - 没有：`before` 取磁盘值。
 *
 * @param {object} ctx
 * @param {{ before: string, after: string }} next `before` 是磁盘值，仅新建时使用
 * @returns {object} 新的 patch
 */
export function stagePatch(ctx, { before, after }) {
    const state = getState(ctx);
    const existing = getPatch(ctx);
    const merge = Boolean(existing) && existing.status === PATCH_STATUS.PENDING;

    const patch = {
        id: merge ? existing.id : createPatchId(),
        createdAt: merge ? Number(existing.createdAt) || Date.now() : Date.now(),
        before: merge ? existing.before : String(before ?? ''),
        after: String(after ?? ''),
        beforeHash: merge ? existing.beforeHash : fnv1a(before),
        status: PATCH_STATUS.PENDING,
    };

    state.patch = patch;
    saveChat(ctx);
    notify(patch);
    return patch;
}

/**
 * 接受：把 `after` 写进角色卡。
 *
 * 冲突处理是这里唯一的判断题：暂存之后磁盘被改过（用户手动编辑、另一个标签页、
 * 别的插件），就不写，转 `conflict` 交给用户——不做自动合并，因为"用户手写的一段"
 * 和"模型追加的一段"谁在前谁在后，没有正确答案。
 *
 * @param {object} ctx
 * @param {{ force?: boolean }} [options] force = 冲突状态下强制覆盖
 * @returns {Promise<{ ok: true } | { ok: false, error: string, hint?: string }>}
 */
export async function applyPatch(ctx, options = {}) {
    const patch = getPatch(ctx);

    if (!patch || patch.status === PATCH_STATUS.APPLIED) {
        return {
            ok: false,
            error: 'NO_PATCH',
            hint: '没有待确认的描述改动。',
        };
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前没有选中角色，无法写入描述。',
        };
    }

    const disk = diskDescription(ctx);
    /*
     * 直接比文本，不只看哈希：patch 里本来就存着 before 全文。
     * 换行归一化之前存下的老 patch，beforeHash 是按 CRLF 算的，而 disk 读出来是 LF，
     * 只比哈希会把"什么都没改"误判成冲突。两边都归一化后再比，老 patch 也能正常接受。
     */
    const changed = disk !== normalizeEol(patch.before);

    if (changed && !options.force) {
        setPatch(ctx, { ...patch, status: PATCH_STATUS.CONFLICT });
        return {
            ok: false,
            error: 'CONFLICT',
            hint: '磁盘上的描述在暂存之后被改动过。面板里只能选择强制覆盖或拒绝。',
        };
    }

    const saved = await saveDescription(ctx, character, patch.after);
    if (!saved.ok) {
        return saved;
    }

    // 快照存"即将被覆盖的那一版"：没有冲突时就是 before；强制覆盖时是用户刚手改的 disk，
    // 后者更不能丢（ADR-016：这是手滑保险）
    rememberDescBackup(ctx, disk);
    // disk 传进去让 targets 判断"编辑器里是不是还停着写入前的原文"：
    // 是就同步，用户已经改过就不动（否则一次保存又会把刚写的内容覆盖回去）
    const editor = applyDescriptionLocally(character, patch.after, disk);

    // 落盘之后磁盘值就是 after，读取登记跟着更新，避免下一轮误判 STALE_READ
    setReadHash(ctx, READ_KEY_DESC, fnv1a(patch.after));

    setPatch(ctx, { ...patch, status: PATCH_STATUS.APPLIED, appliedAt: Date.now() });
    return { ok: true, editor };
}

/**
 * 丢弃 / 关闭记录：`patch = null`，磁盘不变。
 *
 * 这里**不动** `reads`：模型可能刚刚读到的是暂存文本，把磁盘值的哈希写进去，
 * 等于假装它读过磁盘内容，下一次写入就会基于没见过的文本覆盖磁盘。
 */
export function discardPatch(ctx) {
    const state = getState(ctx);
    if (!state.patch) {
        return false;
    }

    state.patch = null;
    saveChat(ctx);
    notify(null);
    return true;
}

/**
 * 把角色描述恢复成 backups.desc 里存的那一版。
 *
 * 这是 ADR-016 的"手滑保险"：不是版本控制，只有一个槽位。
 * 与 patch 的关系：有未处理的改动时不允许恢复——那份 diff 的 beforeHash
 * 会对不上磁盘，恢复完必然转 conflict，让两件事互相打架。
 *
 * 恢复之后槽位换成"刚被覆盖的这一版"：这一步本身也可以反悔，再点一次就换回来。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, chars: number } | { ok: false, error: string, hint?: string }>}
 */
export async function restoreDescBackup(ctx) {
    const backup = getDescBackup(ctx);
    if (!backup) {
        return {
            ok: false,
            error: 'NO_BACKUP',
            hint: '还没有可恢复的上一版。',
        };
    }

    if (isUnresolved(getPatch(ctx))) {
        return {
            ok: false,
            error: 'PATCH_PENDING',
            hint: '还有一份待确认的描述改动，先在面板里接受或拒绝，再恢复上一版。',
        };
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前没有选中角色，无法写入描述。',
        };
    }

    const current = diskDescription(ctx);
    if (current === backup.before) {
        return {
            ok: false,
            error: 'NO_CHANGE',
            hint: '当前描述已经和上一版一致，不需要恢复。',
        };
    }

    const saved = await saveDescription(ctx, character, backup.before);
    if (!saved.ok) {
        return saved;
    }

    const editor = applyDescriptionLocally(character, backup.before, current);
    // 换槽本身会通知面板重绘
    rememberDescBackup(ctx, current);

    // 磁盘内容变了，这一轮的读取登记随之作废：让模型重新读，而不是拿着旧哈希去写
    clearReadHash(ctx, READ_KEY_DESC);
    saveChat(ctx);

    return { ok: true, chars: backup.before.length, editor };
}

/**
 * 把"已写入"的那份内容重新写回角色卡。
 *
 * 用在一种很实际的事故上：写入成功了，但之后角色编辑面板里还停着旧文本，
 * 用户点了一下保存，旧文本又把新内容盖了回去——面板上却仍然显示"已写入"。
 * `patch.after` 是这份内容唯一的副本（聊天记录里），所以这里用它再落一次盘，
 * 覆盖之前先把手上的这一版存进快照槽，不至于连被覆盖的那版也丢。
 *
 * @param {object} ctx
 * @returns {Promise<{ ok: true, editor: object } | { ok: false, error: string, hint?: string }>}
 */
export async function rewriteAppliedDescription(ctx) {
    const patch = getPatch(ctx);

    if (!patch || patch.status !== PATCH_STATUS.APPLIED) {
        return {
            ok: false,
            error: 'NO_PATCH',
            hint: '没有已写入的记录可以重新写入。',
        };
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前没有选中角色，无法写入描述。',
        };
    }

    const disk = diskDescription(ctx);
    if (disk === patch.after) {
        return {
            ok: false,
            error: 'NO_CHANGE',
            hint: '角色卡上已经是这次写入的内容，不需要重写。',
        };
    }

    const saved = await saveDescription(ctx, character, patch.after);
    if (!saved.ok) {
        return saved;
    }

    // 被覆盖的这版先进快照槽：万一用户其实想保留手改的那版，还有一步退路
    rememberDescBackup(ctx, disk);
    const editor = applyDescriptionLocally(character, patch.after, disk);
    setReadHash(ctx, READ_KEY_DESC, fnv1a(patch.after));
    setPatch(ctx, { ...patch, appliedAt: Date.now() });

    return { ok: true, editor };
}

function setPatch(ctx, patch) {
    getState(ctx).patch = patch;
    saveChat(ctx);
    notify(patch);
}

function createPatchId() {
    return `p${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

function notify(patch) {
    notifyPanel(patch);
}

/* -------------------------------------------------------------------- diff */

/*
 * 行级 diff 的实现搬进了 diff.js：虚拟世界书窗口要展示同一套"真实世界书 vs 缓冲区"
 * 的差异，两处对"什么算一行""折叠几行"的要求一致，抄第二份必然有一处先漂。
 * 这里只转发——面板与回归脚本一直从 patch.js 拿 buildDiffRows。
 */
export { buildDiffRows } from './diff.js';
