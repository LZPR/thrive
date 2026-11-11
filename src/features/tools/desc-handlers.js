/** desc-handlers.js · Internal tools module; public entry: index.js. */

import { getContext } from '../../platform/sillytavern/context.js';

import { BOOK_SEEN, DESC_SEEN, READ_KEY_DESC, clearReadHash, clearReadKeysByPrefix, descPatternKey, descPatternPrefix, ensureSettings, getReadHash, isLearningActive, saveChat, setReadHash } from '../settings/index.js';

import { readLimits } from '../../core/limits.js';

import { getActiveCharacter } from '../memory/index.js';

import { PATCH_STATUS, diskDescription, getPatch, stagePatch } from '../memory/patch.js';

import { isWorldbookDesc, readDescription, writeDesc } from '../memory/desc.js';

import { compilePattern, replaceIn, scan } from '../../core/regex.js';

import { appendParagraph, fnv1a, isBlank } from '../../shared/util.js';

import { LOG, canReplace, errorResult } from './tool-contracts.js';

/* --------------------------------------------------------------- desc_read */

async function handleDescRead(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const limits = readLimits(settings);
    // 两种模式在这里合流：card 模式返回 patch 视图（暂存期间是 after），
    // worldbook 模式返回世界书条目的正文
    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const text = view.text;

    // 看过描述这件事本身：追加的前置。哪怕只是查了一个词，模型也算知道"这里有什么"
    setReadHash(ctx, DESC_SEEN, BOOK_SEEN);

    const pattern = String(params?.pattern ?? '');
    if (!isBlank(pattern)) {
        const compiled = compilePattern(pattern, params?.flags, limits.patternMaxChars);
        if (!compiled.ok) {
            return errorResult(compiled.error, compiled.hint);
        }

        const hit = scan(text, compiled, {
            window: limits.matchWindow,
            maxMatches: limits.maxMatches,
        });

        if (hit.count > 0) {
            setReadHash(ctx, descPatternKey(compiled.flags, compiled.source), String(hit.count));
        }

        const payload = { ok: true, count: hit.count, matches: hit.matches };
        if (hit.truncated) {
            payload.truncated = true;
            payload.hint = `命中 ${hit.count} 处，只列了前 ${hit.matches.length} 处。pattern 写得更具体一些。`;
        } else if (hit.count === 0) {
            payload.hint = '描述里没有命中。换一个关键词，或去掉 pattern 读全文。';
        }
        if (view.staged) {
            payload.staged = true;
            payload.note = '这份内容还没写入角色卡，用户确认后才会落盘。';
        }
        return payload;
    }

    // 全文必读且不截断：描述有硬上限，写入侧就是按这份全文算的字数。
    // 只给半截会让模型基于半截改写，后半段被冲掉
    setReadHash(ctx, READ_KEY_DESC, fnv1a(text));

    const chars = text.length;
    const payload = { ok: true, chars, text };

    /*
     * 软提醒不再进返回（见 lore_read 里的说明）。硬上限仍然只在写入侧拦：
     * 读多少字不影响任何东西，读回来是为了让模型有完整正文可用。
     */

    if (view.staged) {
        payload.staged = true;
        payload.note = '这份内容还没写入角色卡，用户确认后才会落盘；在此之前 prompt 里仍是原描述。';
    }

    console.debug(`${LOG} desc_read`, { chars, staged: view.staged });

    return payload;
}

/* ------------------------------------------------------------- desc_append */

async function handleDescAppend(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    if (!getReadHash(ctx, DESC_SEEN)) {
        return errorResult('READ_REQUIRED', '本轮还没读过角色描述。先调用 desc_read（带 pattern 查一下也行），确认里面已有什么再追加。');
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;

    // 读过全文的话顺手做一次变更检测：内容变了，模型对"末尾是什么"的认知就不成立了
    const recorded = getReadHash(ctx, READ_KEY_DESC);
    if (recorded && fnv1a(base) !== recorded) {
        return errorResult('STALE_READ', '角色描述在你读取之后被改动过。请重新调用 desc_read 拿到最新内容，不要重试原来的参数。');
    }

    const text = String(params?.text ?? '');
    if (isBlank(text)) {
        return errorResult('EMPTY_CONTENT', '写入内容为空。如果要追加，请给出具体文字。');
    }

    const next = appendParagraph(base, text);
    const hardLimit = limits.hardLimitDesc;
    if (next.length > hardLimit) {
        return errorResult('TOO_LONG',
            `追加后共 ${next.length} 字，超过上限 ${hardLimit} 字。这次没有写入：请少追加一些，或改用 desc_replace 顺手删掉一段再写。`);
    }

    const committed = await commitDescription(ctx, { next, fullText: false });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_append`, { added: next.length - base.length, chars: next.length, staged: committed.staged });

    return {
        ...committed,
        added: next.length - base.length,
        chars: next.length,
    };
}

/* ------------------------------------------------------------ desc_replace */

async function handleDescReplace(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    const compiled = compilePattern(params?.pattern, params?.flags, limits.patternMaxChars);
    if (!compiled.ok) {
        return errorResult(compiled.error, compiled.hint);
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;

    // 守卫：这个 pattern 预读过，或者这一轮读过全文。都没有就是闭着眼睛改字
    if (!canReplace(ctx, descPatternKey(compiled.flags, compiled.source), READ_KEY_DESC, base)) {
        return errorResult('READ_REQUIRED', '本轮还没看过描述里对应的内容。先 desc_read（带同一个 pattern 最省）确认会命中什么，再替换。');
    }
    const replaced = replaceIn(base, compiled, params?.replacement, params?.replace_all === true, {
        window: limits.matchWindow,
    });

    if (!replaced.ok) {
        const failed = errorResult(replaced.error, replaced.hint);
        if (Number.isFinite(replaced.count)) {
            failed.count = replaced.count;
        }
        if (Array.isArray(replaced.matches)) {
            failed.matches = replaced.matches;
        }
        return failed;
    }

    const hardLimit = limits.hardLimitDesc;
    if (replaced.text.length > hardLimit) {
        return errorResult('TOO_LONG',
            `替换后共 ${replaced.text.length} 字，超过上限 ${hardLimit} 字。这次没有写入：把替换内容写短一些，或分几次局部替换。`);
    }

    const committed = await commitDescription(ctx, { next: replaced.text, fullText: false });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_replace`, {
        replaced: replaced.replaced,
        before: base.length,
        after: replaced.text.length,
        staged: committed.staged,
    });

    return {
        ...committed,
        replaced: replaced.replaced,
        before_chars: base.length,
        chars: replaced.text.length,
        sample: replaced.sample,
    };
}

/* ------------------------------------------------------------ desc_rewrite */

async function handleDescRewrite(params) {
    const ctx = getContext();
    const settings = ensureSettings(ctx);
    const limits = readLimits(settings);

    const gate = checkDescriptionWrite(ctx);
    if (!gate.ok) {
        return gate;
    }

    const view = await readDescription(ctx);
    if (!view.ok) {
        return errorResult(view.error, view.hint);
    }
    const base = view.text;
    const recorded = getReadHash(ctx, READ_KEY_DESC);

    if (!recorded) {
        return errorResult('READ_REQUIRED', '本轮还没读过角色描述全文。先调用 desc_read（不带 pattern），再按读到的内容整段重写。');
    }
    if (fnv1a(base) !== recorded) {
        return errorResult('STALE_READ', '角色描述在你读取之后被改动过。请重新调用 desc_read 拿到最新内容，不要重试原来的参数。');
    }

    const text = String(params?.text ?? '');
    if (isBlank(text)) {
        return errorResult('EMPTY_CONTENT', '写入内容为空。整段重写要给出完整的新描述。');
    }

    const next = text.trim();
    const hardLimit = limits.hardLimitDesc;
    if (next.length > hardLimit) {
        return errorResult('TOO_LONG',
            `正文 ${next.length} 字，超过上限 ${hardLimit} 字。这次没有写入：整段重写必须一次给到上限以内，否则先用 desc_replace 删掉一部分。`);
    }

    const committed = await commitDescription(ctx, { next, fullText: true });
    if (!committed.ok) {
        return committed;
    }

    console.debug(`${LOG} desc_rewrite`, {
        before: base.length,
        after: next.length,
        staged: committed.staged,
    });

    return {
        ...committed,
        before_chars: base.length,
        chars: next.length,
    };
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 三个描述写入共用的前置：学习模式开着、有角色、没有冲突的 patch。
 *
 * 顺序不可调（spec §8）：先判"能不能写"，再判"读没读过"，最后才是参数。
 * 反过来的话，模型会因为参数错误而一直发现不了自己漏了读取。
 */
function checkDescriptionWrite(ctx) {
    ensureSettings(ctx);

    if (!isLearningActive()) {
        return errorResult('TOOL_UNAVAILABLE');
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return errorResult('NO_CHAR', '当前没有选中角色，请让用户先在角色列表里选一个。');
    }

    // worldbook 模式没有 patch，也就不存在"冲突待处理"这件事
    if (isWorldbookDesc(ctx)) {
        return { ok: true };
    }

    // 冲突是用户没做完的决定：这时的磁盘值和 patch.before 都不代表"现在的样子"，
    // 再合进一笔，谁覆盖谁就没有答案了（spec §10）
    if (getPatch(ctx)?.status === PATCH_STATUS.CONFLICT) {
        return errorResult('PATCH_CONFLICT', '角色描述有一份冲突的改动等着用户处理（暂存之后磁盘被改过）。'
            + '这一轮不要再写描述，继续正文即可；用户处理完再写。');
    }

    return { ok: true };
}

/**
 * 描述写完之后的读取登记。
 *
 * 与世界书同一条规则：整段重写提交的就是全文，算读过；追加和替换合成的正文
 * 模型没读过，只留"看过描述"，并把旧的全文哈希清掉。
 */
function registerDescWrite(ctx, next, fullText) {
    setReadHash(ctx, DESC_SEEN, BOOK_SEEN);

    if (fullText) {
        setReadHash(ctx, READ_KEY_DESC, fnv1a(next));
    } else {
        clearReadHash(ctx, READ_KEY_DESC);
    }

    clearReadKeysByPrefix(ctx, descPatternPrefix());
}

/**
 * 描述写入的收尾。两种存储模式各走一条，但都要做同一件事：
 * 把读取登记推到新版本 —— 不这么做，同一次回复里的第二笔写入会被自己的
 * STALE_READ 挡住（ADR-007）。
 *
 * card 模式：恒走暂存，用户确认后才落盘（ADR-005 / ADR-046）。直写那条路已经没有了：
 *   它唯一的用途是"关掉暂存"，而那个开关不存在了，描述又每轮都在 system 前缀里，
 *   合并成一笔才值钱。
 * worldbook 模式：直接写进世界书条目，没有暂存也没有 diff（ADR-042）。
 *   不碰角色卡、不碰角色编辑框、不写 backups.desc —— 那条快照槽位属于 card 模式，
 *   世界书的撤销走 backups.lore（面板「已写入 → 恢复写入前」）。
 */
async function commitDescription(ctx, { next, fullText }) {
    if (isWorldbookDesc(ctx)) {
        const written = await writeDesc(ctx, next);
        if (!written.ok) {
            console.debug(`${LOG} 描述写入失败`, written.error);
            return written;
        }

        registerDescWrite(ctx, next, fullText);
        // writeDesc 里记了世界书快照（chat_metadata），得落一次盘
        saveChat(ctx);

        return {
            ok: true,
            staged: false,
            applied: true,
            note: `已写入世界书「${written.book}」的【角色描述】条目，最迟下一轮生效。`,
        };
    }

    const disk = diskDescription(ctx);
    stagePatch(ctx, { before: disk, after: next });
    registerDescWrite(ctx, next, fullText);
    // 正文变了，之前预读过的正则命中位置都可能不再成立
    clearReadKeysByPrefix(ctx, descPatternPrefix());

    return {
        ok: true,
        staged: true,
        note: '已暂存，用户确认后才写入角色卡。在此之前你的续写仍按原描述进行。',
    };
}

export { handleDescRead, handleDescAppend, handleDescReplace, handleDescRewrite };
