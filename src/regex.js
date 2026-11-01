/**
 * regex.js · 正则的编译、扫描与替换
 *
 * 这一层只做三件事，并且全部是纯函数（不碰 ctx、不碰 DOM），因为它是
 * "模型递过来一串它自己写的正则"的唯一入口：
 *
 *   - 编译时**夹住**长度与标志位。`g` 一律不允许模型传——全局替换由
 *     `replace_all` 参数表达，两个开关表达同一件事时，模型总会用错一个。
 *   - 扫描时给出命中位置与上下文，供模型判断"是不是这一处"。
 *   - 替换时先数命中数：0 处、或多处而没开 `replace_all`，一律拒绝。
 *     这是"降低出错率"的核心——不是靠提示词叮嘱，而是让危险的结果拿不到手。
 *
 * 文本规模有上限（描述硬上限与条目硬上限都在几千字），所以扫描不需要
 * 复杂的超时保护；仍然给了一个迭代上限，防止 `(a?)*` 这类写法把浏览器卡死。
 */

/** 允许模型使用的标志位。`g` 由 replace_all 控制，`y`/`d` 没有实际用途 */
export const ALLOWED_FLAGS = Object.freeze(['i', 'm', 's', 'u']);

/** 扫描迭代上限。真到这一步说明正则写坏了，不是内容太长 */
const SCAN_CAP = 2000;

/**
 * 规范化 flags：小写、去重、排序、丢掉不认识的。
 *
 * 排序是为了稳定：`im` 和 `mi` 必须产生同一个读取登记键，否则模型换个顺序
 * 写同一组标志就会被判成"没预读过"。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeFlags(raw) {
    const chars = String(raw ?? '').toLowerCase().split('');
    const kept = chars.filter(char => ALLOWED_FLAGS.includes(char));
    return Array.from(new Set(kept)).sort().join('');
}

/**
 * 编译 pattern。
 *
 * @param {string} pattern
 * @param {string} [flags]
 * @param {number} [maxChars] 正则本身的字数上限
 * @returns {{ ok: true, source: string, flags: string, regex: RegExp }
 *          | { ok: false, error: string, hint: string }}
 */
export function compilePattern(pattern, flags, maxChars = 200) {
    const source = String(pattern ?? '');

    if (!source) {
        return {
            ok: false,
            error: 'INVALID_REGEX',
            hint: 'pattern 是空串。要不带正则读全文，就别传 pattern。',
        };
    }

    if (source.length > maxChars) {
        return {
            ok: false,
            error: 'PATTERN_TOO_LONG',
            hint: `正则 ${source.length} 字，超过 ${maxChars} 字上限。改用更短的特征词，别把整句原文当 pattern。`,
        };
    }

    const normalized = normalizeFlags(flags);

    try {
        return { ok: true, source, flags: normalized, regex: new RegExp(source, normalized) };
    } catch (err) {
        return {
            ok: false,
            error: 'INVALID_REGEX',
            hint: `正则语法有误：${err?.message ?? err}。检查括号、方括号和转义。`,
        };
    }
}

/**
 * 扫描命中，带上下文。
 *
 * 返回的 `match` 是**精确匹配到的那串原文**（替换时 `$1` 引用的就是它），
 * `ctx` 是它前后各 window 字，用来分辨"是哪一处"。两者分开给：只有 ctx
 * 的话，模型分不清哪部分是它匹配到的；只有 match 的话，同名多处的互换位置
 * 它会选错。
 *
 * @param {string} text
 * @param {{ source: string, flags: string }} compiled
 * @param {{ window?: number, maxMatches?: number }} [options]
 * @returns {{ count: number, truncated: boolean, matches: Array<{ at: number, match: string, ctx: string }> }}
 */
export function scan(text, compiled, options = {}) {
    const body = String(text ?? '');
    const window = Math.max(0, Number(options.window) || 0);
    const maxMatches = Math.max(1, Number(options.maxMatches) || 20);

    const regex = new RegExp(compiled.source, `${compiled.flags}g`);
    const matches = [];
    let count = 0;
    let guard = 0;

    while (guard < SCAN_CAP) {
        const hit = regex.exec(body);
        if (!hit) {
            break;
        }
        guard++;

        count++;
        if (matches.length < maxMatches) {
            matches.push({
                at: hit.index,
                match: clip(hit[0], 120),
                ctx: contextAround(body, hit.index, hit[0].length, window),
            });
        }

        // 零宽匹配（`^`、`\b`、`(?=x)`）不会自己前进，手动推一格
        if (hit[0] === '') {
            regex.lastIndex++;
        }
    }

    return { count, truncated: count > matches.length, matches };
}

/**
 * 替换。命中数先过一遍，再决定做不做。
 *
 * @param {string} text
 * @param {{ source: string, flags: string }} compiled
 * @param {string} replacement
 * @param {boolean} replaceAll
 * @param {{ window?: number }} [options]
 * @returns {{ ok: true, replaced: number, text: string, sample: string }
 *          | { ok: false, error: string, hint: string, count?: number,
 *              matches?: Array<{ at: number, match: string, ctx: string }> }}
 */
export function replaceIn(text, compiled, replacement, replaceAll, options = {}) {
    const body = String(text ?? '');
    const target = String(replacement ?? '');
    const window = Math.max(0, Number(options.window) || 40);

    const counter = new RegExp(compiled.source, `${compiled.flags}g`);
    const count = countMatches(counter, body);

    if (count === 0) {
        return {
            ok: false,
            error: 'NO_MATCH',
            hint: '这个正则一处也没命中，正文没有被改动。先带同样的 pattern 读一次，看清能匹配到什么再换。',
        };
    }

    if (count > 1 && !replaceAll) {
        const preview = scan(body, compiled, { window, maxMatches: 3 });
        return {
            ok: false,
            error: 'AMBIGUOUS_MATCH',
            hint: `命中 ${count} 处，但 replace_all=false。要么把 pattern 写得更具体，要么明确传 replace_all=true 全改。`,
            count,
            matches: preview.matches,
        };
    }

    // 单处替换用不带 g 的实例：它只会换掉第一处，而这里已经确认只有一处
    const one = new RegExp(compiled.source, compiled.flags);
    const first = one.exec(body);
    const next = replaceAll
        ? body.replace(counter, target)
        : body.replace(one, target);

    const sample = first
        ? contextAround(next, Math.min(first.index, next.length), 0, window)
        : '';

    return { ok: true, replaced: count, text: next, sample };
}

/* ------------------------------------------------------------------ 内部 */

function countMatches(regex, text) {
    let count = 0;
    while (count < SCAN_CAP) {
        const hit = regex.exec(text);
        if (!hit) {
            break;
        }
        count++;
        if (hit[0] === '') {
            regex.lastIndex++;
        }
    }
    return count;
}

/** 取 [at, at+len) 两侧各 window 字的原文；截断处补省略号 */
function contextAround(text, at, length, window) {
    const body = String(text ?? '');
    const from = Math.max(0, at - window);
    const to = Math.min(body.length, at + length + window);

    const head = from > 0 ? '…' : '';
    const tail = to < body.length ? '…' : '';
    const slice = body.slice(from, to).replace(/\n/g, ' ');

    return `${head}${slice}${tail}`;
}

function clip(text, max) {
    const value = String(text ?? '');
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}
