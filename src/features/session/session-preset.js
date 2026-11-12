/**
 * session-preset.js · 预设 → 有序 run 列表
 *
 * 预设由 prompt.js 的 `buildPreset()` 产出，形状是：
 *
 *   { id, name, runs: [{ role: 0|1|2|'system'|'user'|'assistant', text, ids }] }
 *
 * 这一层做三件事：
 *
 *   1. 校验形状（角色认不认识、正文空不空），坏预设要说人话而不是发出去
 *   2. 按顺序展开 ST 宏：`{{char}}` / `{{user}}` / `{{setvar::…}}` / `{{getvar::…}}`。
 *      逐段展开而不是先拼成一大段，`setvar` 的副作用才会按卡片顺序生效
 *   3. 转成 `session.js` 能直接塞进消息栈的 run
 *
 * 宏在这里展开而不是在 prompt.js：那边还要给编辑器显示"用户写的样子"，
 * 这里才是"发出去的样子"。
 */

/** 数字角色 → 字符串角色。0/1/2 与 `prompt.js` 的 PROMPT_ROLE 一致 */
const ROLE_BY_INDEX = Object.freeze({ 0: 'system', 1: 'user', 2: 'assistant' });
const ROLES = new Set(['system', 'user', 'assistant']);

/**
 * 编译预设。
 *
 * @param {object|null} ctx 用来展开宏；没有 substituteParams 时原样发出
 * @param {{ id?: string, name?: string, runs?: Array<{ role: string|number, text: string, ids?: string[] }> }|null} preset
 * @param {{ allowEmpty?: boolean }} [options] 有独立开场白时可省略全部预设消息
 * @returns {{ ok: true, id: string, name: string, runs: Array<{ role: string, text: string, ids: string[] }> }
 *          | { ok: false, error: string, detail?: string }}
 */
export function compilePreset(ctx, preset = null, { allowEmpty = false } = {}) {
    if (!preset || !Array.isArray(preset.runs)) {
        return { ok: false, error: 'SESSION_NO_PRESET', detail: '预设没有 runs 数组' };
    }

    const runs = [];

    for (const run of preset.runs) {
        const role = normalizeRole(run?.role);
        if (!role) {
            return { ok: false, error: 'SESSION_PROTOCOL', detail: `预设里有一段角色是「${run?.role}」` };
        }

        const text = substituteSessionText(ctx, String(run?.text ?? ''));
        if (!text.trim()) {
            // 空段不是错误，是没东西可填：跳过，别让一条空 system 白占一条消息
            continue;
        }

        runs.push({ role, text, ids: Array.isArray(run?.ids) ? run.ids.slice() : [] });
    }

    if (runs.length === 0 && !allowEmpty) {
        return { ok: false, error: 'SESSION_NO_PRESET', detail: '预设编译完是空的：目标内容没有内容可发，其余卡片也都没启用' };
    }

    return {
        ok: true,
        id: String(preset.id ?? ''),
        name: String(preset.name ?? ''),
        runs,
    };
}

/** 现取 context 的宏替换。失败时按原文发出去，不让一整场会话因为一条宏炸掉 */
export function substituteSessionText(ctx, text) {
    if (!text.includes('{{') || typeof ctx?.substituteParams !== 'function') {
        return text;
    }

    try {
        return String(ctx.substituteParams(text) ?? text);
    } catch (err) {
        console.error('[Thrive] 会话的宏替换失败，按原文发送', err);
        return text;
    }
}

function normalizeRole(role) {
    if (typeof role === 'number') {
        return ROLE_BY_INDEX[role] ?? '';
    }
    const text = String(role ?? '').trim().toLowerCase();
    return ROLES.has(text) ? text : '';
}
