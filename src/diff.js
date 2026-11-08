/**
 * diff.js · 行级 diff 与折叠
 *
 * 从 patch.js 抽出来的一份纯计算：现在有两个地方要看差异——浮动面板里的
 * "磁盘 vs 暂存"（角色描述），和虚拟世界书窗口里的"真实世界书 vs 缓冲区"。
 * 两处对"什么算一行"的要求完全一样，抄第二份必然会有一处先漂。
 *
 * 没有任何依赖，也不认识 patch / draft / 世界书。
 */

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
 * 行级 diff + 折叠，产出界面能直接渲染的行。
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
 * 折叠段只有一个"⋯ N 行未改动"，不展开原文——这两处界面都是确认用的，不是编辑器。
 */
function collapse(ops, context) {
    // 两边一字不差（比如 rewrite 交了同一份全文）：没有差异段可展示
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
