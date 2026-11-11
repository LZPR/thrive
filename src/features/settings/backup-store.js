/** backup-store.js · Internal settings module; public entry: index.js. */

import { notifyPanel } from '../../shared/events.js';

import { loreBackupLimit, normalizeLoreBackup } from './normalization.js';

import { ensureSettings } from './settings-store.js';

import { getState } from './chat-store.js';

/* ------------------------------------------------------------------ 备份槽位 */

/**
 * 直写前把原值存起来，只留 1 版。
 * 这是"手滑保险"，不是版本控制：不阻止任何写入，成本只有一个槽位（ADR-016）。
 * @param {object} ctx
 * @param {string} before 写入前的描述全文
 */
function rememberDescBackup(ctx, before) {
    getState(ctx).backups.desc = [{ before: String(before ?? ''), at: Date.now() }];
    notifyPanel();
}

/**
 * 世界书写入前压一份快照，同时充当面板"已写入"列表里的一条记录。
 *
 * 与描述不同，这里留 10 条：模型没有删除工具（ADR-011），写错的条目要么靠这份
 * 快照找回，要么请用户去世界书编辑器里手动清理。新建时 `before` 为空串，
 * `action = created` —— 恢复它等于把这条从书里删掉，那只发生在用户点「撤销新建」时，
 * 是用户的撤销动作，不是给模型的工具能力（ADR-022）。
 *
 * `layer` 由调用方给（`draft.js` 的 layerFor）：写的是缓冲区还是真实世界书，
 * 决定这条记录还能不能被恢复（见 normalizeLoreBackup）。
 *
 * @param {object} ctx
 * @param {{ book: string, title: string, before: string, beforeKeys?: string[],
 *           action?: 'created'|'rewritten', layer?: 'disk'|'draft', chars?: number }} snapshot
 * @returns {object} 记下来的那条记录
 */
function rememberLoreBackup(ctx, snapshot = {}) {
    const list = getState(ctx).backups.lore;
    const limit = loreBackupLimit(ensureSettings(ctx));

    const record = normalizeLoreBackup({
        id: createBackupId(),
        book: snapshot.book,
        title: snapshot.title,
        action: snapshot.action,
        layer: snapshot.layer,
        before: snapshot.before,
        beforeKeys: snapshot.beforeKeys,
        chars: snapshot.chars,
        at: Date.now(),
    }, 0);

    list.unshift(record);

    // 超出上限丢最旧的。unshift 之后尾部就是最旧的
    if (list.length > limit) {
        list.length = limit;
    }

    // 写入发生在生成过程中，面板不会自己知道有新记录
    notifyPanel(record);
    return record;
}

/** 写入记录（新的在前）。只读副本——面板不该直接改 state 里的对象 */
function getLoreBackups(ctx) {
    return getState(ctx).backups.lore.map(item => ({ ...item }));
}

/** 按 id 取一条记录 */
function findLoreBackup(ctx, id) {
    const wanted = String(id ?? '');
    return getState(ctx).backups.lore.find(item => item.id === wanted) ?? null;
}

/** 标记某条记录已恢复：面板改成"已恢复 <时间>"，不再给按钮 */
function markLoreBackupRestored(ctx, id) {
    const record = getState(ctx).backups.lore.find(item => item.id === String(id ?? ''));
    if (!record) {
        return false;
    }
    record.restoredAt = Date.now();
    return true;
}

/**
 * 丢掉属于缓冲区的那批写入记录。
 *
 * 缓冲区一旦保存或丢弃，这些记录的 `before` 指的就是"缓冲区里当时的样子"，
 * 而那块缓冲区已经不存在了。留着它们，面板会挂出一颗点了必然报错的按钮
 * （恢复的目标层已经没了），用户还得读一段解释才知道为什么点了没反应。
 *
 * 保存时另有一批 `layer: disk` 的记录补进来，所以"已写入"不会变空——
 * 它换成的是"这次保存到底动了哪几条"。
 *
 * @param {object} ctx
 * @returns {number} 丢掉了几条
 */
function dropDraftBackups(ctx) {
    const state = getState(ctx);
    const list = state.backups.lore;
    const kept = list.filter(item => item.layer !== 'draft');
    state.backups.lore = kept;
    return list.length - kept.length;
}

/** 描述的上一版（1 槽）；没有时返回 null */
function getDescBackup(ctx) {
    const list = getState(ctx).backups.desc;
    const backup = list[0];
    if (!backup || typeof backup.before !== 'string') {
        return null;
    }
    return { before: backup.before, at: Number(backup.at) > 0 ? Number(backup.at) : 0 };
}

function createBackupId() {
    return `b${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export { rememberDescBackup, rememberLoreBackup, getLoreBackups, findLoreBackup, markLoreBackupRestored, dropDraftBackups, getDescBackup };
