/**
 * session-preset.js · 预设 → 有序 run 列表
 *
 * 这一版是存根：一段 system 规则 + 一段 assistant 示例，两段不同角色，
 * 顺带验证"预设能按角色分段"——与将来 `prompt.js` 的 `buildInjection()` 产出的
 * `headRuns` / `tailRuns`（同样是 `{ role, text, ids }`）同构。
 *
 * 接真实预设时只改 `compilePreset` 的函数体：
 *
 *   const { headRuns, tailRuns } = buildInjection(ctx, ensureSettings(ctx));
 *   return { ok: true, runs: [...headRuns, ...tailRuns].map(toRun) };
 *
 * 签名与返回形状不变，调用方（`applyPreset`）一个字都不用改。
 */

/** 预设置信：只有一段系统规则加一段示例，够跑通两轮工具调用 */
export const STUB_PRESET = Object.freeze({
    id: 'stub.v1',
    name: '框架自检',
    runs: Object.freeze([
        Object.freeze({
            role: 'system',
            text: [
                '【Thrive 内部会话 · 框架自检】',
                '',
                '你在插件内部的一次性会话里工作。这段内容不会出现在用户面前，你也可以直接使用工具。',
                '',
                '严格按顺序做，不要跳步，也不要把两步并成一次调用：',
                '1. 调用 stub_read，key 用「北境」。它会返回 title、body 和一个 ticket。',
                '2. 调用 stub_write，title 与 body 用第 1 步返回的内容，ticket 原样带上。',
                '3. 两步都成功后，用一句中文说明你做了什么，并在结尾加上 [SESSION-OK]。',
                '',
                '如果 stub_write 说 ticket 不对，说明你跳过了第 1 步：回到第 1 步重读。',
                '不要编造 stub_read 没有给过的内容。',
            ].join('\n'),
        }),
        Object.freeze({
            role: 'assistant',
            text: '（示例）收到。我先读「北境」，拿到 ticket 之后再写。',
        }),
    ]),
});

/** 数字角色 → 字符串角色。0/1/2 与 `prompt.js` 的 PROMPT_ROLE 一致 */
const ROLE_BY_INDEX = Object.freeze({ 0: 'system', 1: 'user', 2: 'assistant' });
const ROLES = new Set(['system', 'user', 'assistant']);

/**
 * 编译预设。
 *
 * @param {object|null} ctx 现在不用；接真实预设时要读 settings 与注入结果
 * @param {{ id?: string, name?: string, runs?: Array<{role: string|number, text: string, ids?: string[]}> }|null} preset
 * @returns {{ ok: true, id: string, name: string, runs: Array<{role: string, text: string, ids: string[]}> }
 *          | { ok: false, error: string, detail?: string }}
 */
export function compilePreset(ctx, preset = null) {
    const chosen = preset ?? STUB_PRESET;

    if (!chosen || !Array.isArray(chosen.runs)) {
        return { ok: false, error: 'SESSION_PROTOCOL', detail: '预设没有 runs 数组' };
    }

    const runs = [];

    for (const run of chosen.runs) {
        const role = normalizeRole(run?.role);
        const text = String(run?.text ?? '');

        if (!role) {
            return { ok: false, error: 'SESSION_PROTOCOL', detail: `预设里有一段角色是「${run?.role}」` };
        }
        if (!text.trim()) {
            // 空段不是错误，是没东西可填：跳过，别让一条空 system 白占一条消息
            continue;
        }

        runs.push({ role, text, ids: Array.isArray(run?.ids) ? run.ids.slice() : [] });
    }

    if (runs.length === 0) {
        return { ok: false, error: 'SESSION_EMPTY_REPLY', detail: '预设编译完是空的' };
    }

    return { ok: true, id: String(chosen.id ?? ''), name: String(chosen.name ?? ''), runs };
}

function normalizeRole(role) {
    if (typeof role === 'number') {
        return ROLE_BY_INDEX[role] ?? '';
    }
    const text = String(role ?? '').trim().toLowerCase();
    return ROLES.has(text) ? text : '';
}
