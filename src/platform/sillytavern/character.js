
/**
 * 把描述写进角色卡。
 *
 * 只提交 `description` —— `merge-attributes` 是深合并，多带一个字段就多改一处
 * （ADR-015：不返回也不写入 personality / scenario / first_mes / mes_example）。
 *
 * @param {object} ctx
 * @param {object} character 当前角色对象
 * @param {string} text 新的描述全文
 * @returns {Promise<{ ok: true } | { ok: false, error: string, hint?: string }>}
 */
async function saveDescription(ctx, character, text) {
    if (!character?.avatar) {
        return {
            ok: false,
            error: 'NO_CHAR',
            hint: '当前角色没有头像文件名，无法定位角色卡文件。请让用户先重新选一次角色。',
        };
    }

    let response;
    try {
        response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: ctx.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                avatar: character.avatar,
                description: String(text ?? ''),
            }),
        });
    } catch (err) {
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `写入请求没有发出去（${err?.message ?? err}）。可以让用户检查 ST 服务是否在运行。`,
        };
    }

    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json();
            if (body?.message) {
                message = body.message;
            }
        } catch {
            // 响应不是 JSON，就用状态码
        }
        return {
            ok: false,
            error: 'WRITE_FAILED',
            hint: `角色卡写入被服务端拒绝：${message}`,
        };
    }

    return { ok: true };
}

export { saveDescription };
