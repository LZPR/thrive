/**
 * ui/settings/desc-storage.js · 「角色描述存在哪」这个设置
 *
 * 两件事，都在这一处收口：
 *   1. 下拉切换（角色卡 / 世界书条目），以及切换时必须做的准备与守卫；
 *   2. 下面那行状态小字 —— 书建了没有、条目在不在、会不会被扫描到。
 *
 * 切换是**有副作用**的，所以不能像普通勾选框那样写个值就完事：
 *   · 切到统一模式：先确认没有未决 patch（那份 diff 在新模式里没有地方处理），
 *     再把"书 + 常驻条目"准备好，最后才改设置。反过来的话，设置已经变了、
 *     条目却没建出来，模型会读到一份"空描述"而用户以为只是换了个存储位置。
 *   · 切回角色卡：把条目停用（内容保留），否则两处内容会同时进上下文。
 *
 * 模式判定只有 store.js 的 descStorageMode 一份，这里不重复解释字符串。
 *
 * 这个设置**按对话**保存（ADR-044）：它决定"这一场对话的描述读哪儿、写哪儿"，
 * 而换个对话通常就换了角色。所以切对话后下拉要重新回填，写入也走 setDescStorageMode。
 */

import { getContext } from '../../../../../../extensions.js';
import { descBookName, ensureDescEntry, isWorldbookDesc, resolveDescTarget, setDescEntryEnabled } from '../../desc.js';
import { getPatch, isUnresolved } from '../../patch.js';
import { setDescStorageMode } from '../../store.js';
import { cardDescription, getActiveCharacter, isBookScanned } from '../../targets.js';
import { refreshUI, setPanelOpen } from '../refresh.js';
import { LOG, PANEL_ID, toast } from '../shared.js';
import { byId, paintHint } from './common.js';

/**
 * 状态小字的节流。
 *
 * updateDescStorageHint 会在每次 refreshUI 时被叫到（切对话、发消息、改任何设置），
 * 而"书在不在、有没有被扫描"要 load 一次世界书。合并成一次、并且记住上次的结论，
 * 免得一个高频路径反复读盘。
 */
let hintTimer = 0;
let hintToken = 0;

export function bindDescStorageControls() {
    const select = byId('thrive_desc_storage');
    if (select) {
        select.addEventListener('change', async function () {
            const ctx = getContext();
            const previous = isWorldbookDesc(ctx) ? 'worldbook' : 'card';
            const next = this.value === 'worldbook' ? 'worldbook' : 'card';

            if (next === previous) {
                return;
            }

            this.disabled = true;
            try {
                const switched = next === 'worldbook'
                    ? await switchToWorldbook(ctx)
                    : await switchToCard(ctx);
                if (!switched) {
                    this.value = previous;
                }
            } finally {
                this.disabled = false;
                this.value = isWorldbookDesc(ctx) ? 'worldbook' : 'card';
                refreshUI(ctx);
            }
        });
    }

    byId('thrive_desc_bind')?.addEventListener('click', () => {
        void bindCurrentBook(getContext());
    });
}

/**
 * 回填存储模式下拉。
 *
 * 带着 ctx 而不是只带 settings：这个值按对话存（ADR-044），换对话之后必须重铺。
 * @param {object} ctx
 */
export function syncDescStorage(ctx) {
    const select = byId('thrive_desc_storage');
    const value = isWorldbookDesc(ctx) ? 'worldbook' : 'card';
    if (select && select.value !== value) {
        select.value = value;
    }
}

/**
 * 角色卡描述是否还被 ST 注入。
 *
 * 统一模式下插件不读也不写角色卡，但 ST 自己会注入 —— 这就变成两个来源。
 * 插件不去改用户的卡（切换时明确不迁移），只把这件事说出来。
 *
 * @param {object} ctx
 */
export function updateDescStorageHint(ctx) {
    byId('thrive_desc_bind')?.classList.add('displayNone');

    if (!isWorldbookDesc(ctx)) {
        paintHint('thrive_desc_storage_hint', '');
        return;
    }

    // 同步先给一句兜底，异步结论回来再覆盖：这一行永远不会空着
    const character = getActiveCharacter(ctx);
    const book = descBookName(character);
    paintHint(
        'thrive_desc_storage_hint',
        character
            ? `描述存在「${book || '（无名）'}」的【角色描述】条目里，常驻。`
            : '先选一个角色：描述会存在与角色同名的那本世界书里。',
        !character,
    );

    clearTimeout(hintTimer);
    const token = ++hintToken;
    hintTimer = setTimeout(() => {
        void paintDescHint(ctx, token);
    }, 180);
}

async function paintDescHint(ctx, token) {
    if (!isWorldbookDesc(ctx)) {
        return;
    }

    const character = getActiveCharacter(ctx);
    if (!character) {
        return;
    }

    let target;
    try {
        target = await resolveDescTarget(ctx, { create: false });
    } catch (err) {
        console.debug(`${LOG} 解析描述条目失败`, err);
        return;
    }

    // 期间又触发了一次：以最新那次为准
    if (token !== hintToken) {
        return;
    }

    const wanted = descBookName(character);
    const parts = [];
    let warn = false;

    if (!target.ok) {
        parts.push(`「${wanted}」这本书还没有：第一次写入描述时会自动创建。`);
        warn = true;
    } else if (!target.found) {
        parts.push(`「${target.book}」里还没有【角色描述】条目：第一次写入时会自动创建。`);
        warn = true;
    } else if (isBookScanned(ctx, target.book) === false) {
        parts.push(`⚠ 「${target.book}」没有被扫描到，这条常驻条目不会进入上下文——到「世界书」面板勾选它。`);
        warn = true;
        // 角色没绑任何书时，给一个"设为本角色世界书"的出口；已有绑定时不提供，
        // 避免把用户原本的书顶掉（ADR-021：不自动改激活列表）
        const bound = String(character?.data?.extensions?.world ?? '').trim();
        byId('thrive_desc_bind')?.classList.toggle('displayNone', Boolean(bound));
    } else {
        parts.push(`「${target.book}」的【角色描述】条目已就绪，常驻注入。`);
    }

    const cardChars = cardDescription(ctx).length;
    if (cardChars > 0) {
        parts.push(`角色卡上还有 ${cardChars} 字描述，ST 仍会注入它；要单一来源请手动清空。`);
        warn = true;
    }

    paintHint('thrive_desc_storage_hint', parts.join(' '), warn);
}

/**
 * 切到统一模式。
 * @returns {Promise<boolean>} 是否切换成功（false 时调用方把下拉拨回去）
 */
async function switchToWorldbook(ctx) {
    if (!getActiveCharacter(ctx)) {
        toast('请先选一个角色');
        return false;
    }

    // 未决 patch 在新模式里没有处理入口：先让用户在面板里做完决定
    if (isUnresolved(getPatch(ctx))) {
        toast('还有一份待处理的描述改动：请先在浮动面板里写入或丢弃');
        setPanelOpen(true, ctx);
        byId(PANEL_ID)?.scrollIntoView({ block: 'nearest' });
        return false;
    }

    const ensured = await ensureDescEntry(ctx);
    if (!ensured.ok) {
        toast(ensured.hint ?? `切换失败：${ensured.error}`);
        return false;
    }

    // 只切这一场对话（ADR-044）
    setDescStorageMode(ctx, 'worldbook');

    if (isBookScanned(ctx, ensured.book) === false) {
        toast(`已切到世界书条目，但「${ensured.book}」没有被扫描到：到「世界书」面板勾选它，描述才会进上下文`);
    } else {
        toast(`已切到世界书条目：描述存在「${ensured.book}」的【角色描述】里`);
    }

    return true;
}

/**
 * 切回角色卡模式。
 *
 * 条目停用但内容不动：这样切回来的时候东西还在，只是不再和角色卡抢上下文。
 * 停用失败不该拦住切换（书可能已经被删了），所以结果只进控制台。
 */
async function switchToCard(ctx) {
    try {
        await setDescEntryEnabled(ctx, false);
    } catch (err) {
        console.debug(`${LOG} 停用描述条目失败`, err);
    }

    // 只切这一场对话（ADR-044）
    setDescStorageMode(ctx, 'card');
    toast('已切回角色卡存储；世界书里的【角色描述】条目已停用，内容保留');
    return true;
}

/**
 * 把「与角色同名的世界书」设成这个角色的世界书（`extensions.world`）。
 *
 * 只有角色还没有绑定任何书时才显示这个按钮 —— 覆盖已有绑定等于把用户原本的设定
 * 挤出扫描范围，这件事不该由一个"顺手点的按钮"来做。
 */
async function bindCurrentBook(ctx) {
    const character = getActiveCharacter(ctx);
    if (!character) {
        toast('请先选一个角色');
        return;
    }

    if (String(character?.data?.extensions?.world ?? '').trim()) {
        toast('这个角色已经绑定了一本世界书，本插件不会覆盖它');
        return;
    }

    const book = descBookName(character);
    if (!book) {
        toast('角色没有名字，无法确定绑定哪本书');
        return;
    }

    if (!character.avatar) {
        toast('当前角色没有头像文件名，定位不到角色卡文件');
        return;
    }

    try {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: ctx.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                avatar: character.avatar,
                data: { extensions: { world: book } },
            }),
        });

        if (!response.ok) {
            toast('绑定失败：服务端拒绝了这次写入');
            return;
        }
    } catch (err) {
        toast(`绑定失败：${err?.message ?? err}`);
        return;
    }

    // 内存同步是必须的：isBookScanned 与 ST 的扫描范围都从角色对象读
    character.data = character.data ?? {};
    character.data.extensions = character.data.extensions ?? {};
    character.data.extensions.world = book;

    toast(`已把「${book}」设为「${character.name ?? '当前角色'}」的世界书`);
    refreshUI(ctx);
}
