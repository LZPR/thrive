/**
 * patch.js · 角色描述的"磁盘 vs 暂存"
 *
 * patch 只表达一份差异（ADR-006）：`before` 是磁盘上的原文，`after` 是模型想让它
 * 变成的样子。同一时刻最多一个。模型在 patch 存在时再写一次，是**往同一份差异上叠**，
 * 而不是再开一条——多条补丁会形成链式依赖，第 1 条被丢弃，第 2 条的基准就失效了。
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
import { applyDescriptionLocally, getActiveCharacter, saveDescription } from './targets.js';
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

/** 磁盘上的描述全文（空角色返回空串） */
export function diskDescription(ctx) {
    const character = getActiveCharacter(ctx);
    if (!character) {
        return '';
    }
    return normalizeEol(typeof character.description === 'string'
        ? character.description
        : String(character.description ?? ''));
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

/**
 * 单行超过这个长度就按句读切段。
 *
 * 角色描述常常是"一整段中文、中间不换行"。只按 `\n` 切的话，改一个字就会变成
 * "整段删除 + 整段新增"，面板里两段两千字并排，折叠也失去意义。
 */
const UNIT_MAX = 160;

/** 差异段前后各留几行原文做参照 */
const CONTEXT = 2;

/** LCS 表的规模上限；超过就退化成"整段替换"，避免大文本卡住面板 */
const LCS_BUDGET = 400_000;

/**
 * 行级 diff + 折叠，产出面板能直接渲染的行。
 *
 * @param {string} before
 * @param {string} after
 * @param {{ context?: number }} [options]
 * @returns {Array<{ type: 'same'|'add'|'del', text: string } | { type: 'fold', count: number }>}
 */
export function buildDiffRows(before, after, options = {}) {
    const context = Number.isFinite(options.context) ? Math.max(0, options.context) : CONTEXT;
    const left = splitUnits(before);
    const right = splitUnits(after);

    return collapse(diffUnits(left, right), context);
}

/** 文本 → 比对单元：先按行切，超长的行再按句读切 */
function splitUnits(text) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const units = [];

    for (const line of normalized.split('\n')) {
        units.push(...splitLongLine(line));
    }

    return units;
}

function splitLongLine(line) {
    if (line.length <= UNIT_MAX) {
        return [line];
    }

    const units = [];
    let rest = line;

    while (rest.length > UNIT_MAX) {
        const head = rest.slice(0, UNIT_MAX);
        // 切点落在句读之后；离句首太近（< 40%）就硬切，避免切出三五个字的碎片
        const at = breakPoint(head);
        const cut = at >= UNIT_MAX * 0.4 ? at + 1 : UNIT_MAX;
        units.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }

    if (rest) {
        units.push(rest);
    }

    return units;
}

const BREAK_CHARS = ['。', '！', '？', '；', '…', '，', '.', '!', '?', ';', ' '];

function breakPoint(head) {
    let best = -1;
    for (const char of BREAK_CHARS) {
        best = Math.max(best, head.lastIndexOf(char));
    }
    return best;
}

function diffUnits(left, right) {
    if (left.length * right.length > LCS_BUDGET) {
        return [
            ...left.map(text => ({ type: 'del', text })),
            ...right.map(text => ({ type: 'add', text })),
        ];
    }

    const rows = left.length;
    const cols = right.length;
    // dp[i][j] = left[i..] 与 right[j..] 的最长公共子序列长度
    const dp = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));

    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            dp[i][j] = left[i] === right[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;

    while (i < rows && j < cols) {
        if (left[i] === right[j]) {
            ops.push({ type: 'same', text: left[i] });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ type: 'del', text: left[i] });
            i++;
        } else {
            ops.push({ type: 'add', text: right[j] });
            j++;
        }
    }

    while (i < rows) {
        ops.push({ type: 'del', text: left[i++] });
    }
    while (j < cols) {
        ops.push({ type: 'add', text: right[j++] });
    }

    return ops;
}

/**
 * 未改动行默认折叠，只保留差异段前后各 `context` 行。
 * 折叠段只有一个"⋯ N 行未改动"，不展开原文——面板是确认用的，不是编辑器。
 */
function collapse(ops, context) {
    // 写入内容和磁盘一字不差（比如 rewrite 交了同一份全文）：没有差异段可展示
    if (!ops.some(op => op.type !== 'same')) {
        return [];
    }

    const keep = new Array(ops.length).fill(false);

    ops.forEach((op, index) => {
        if (op.type === 'same') {
            return;
        }
        const from = Math.max(0, index - context);
        const to = Math.min(ops.length - 1, index + context);
        for (let k = from; k <= to; k++) {
            keep[k] = true;
        }
    });

    const rows = [];
    let index = 0;

    while (index < ops.length) {
        if (keep[index]) {
            rows.push(ops[index]);
            index++;
            continue;
        }

        let end = index;
        while (end < ops.length && !keep[end]) {
            end++;
        }

        // 只折 1 行没有意义（省不下高度，还多一行噪音），原样留下
        const count = end - index;
        if (count === 1) {
            rows.push(ops[index]);
        } else {
            rows.push({ type: 'fold', count });
        }
        index = end;
    }

    return rows;
}
