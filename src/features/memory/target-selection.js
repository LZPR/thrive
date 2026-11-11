/** target-selection.js · Internal memory module; public entry: index.js. */

import { descBookName } from '../../desc-entry.js';

import { getWritableBookSetting, isWorldbookDesc } from '../../store.js';

import { getActiveCharacter } from './character-target.js';

/* ------------------------------------------------------------------ 世界书 */

/*
 * 读取侧的数值上限（返回几条、每条给多少字、总览列几个标题、多少条开始提醒合并）
 * 都在 limits.js 里定义，设置页可调；这里只负责按传进来的那套值裁剪。
 */

/**
 * 可写世界书名；空串表示未就绪。
 *
 * 两个来源，优先级固定：
 *   1. 统一描述模式 → **角色同名书**，不看设置。描述就存在那本书里，允许另选一本
 *      会让"描述写哪儿"出现两个答案（ADR-044）；
 *   2. 其余情况 → 这一场对话选的那本（chat_metadata，ADR-044）。
 *
 * 一个已知的例外：角色改过名、而描述此前已经落在绑定书里时，`resolveDescTarget` 会继续认
 * 那本旧书（否则改名就等于凭空再建一本空书）。这里按现名给，所以两边会短暂指向不同的书；
 * 设置页的两条提示会各自写出书名，不是静默分叉。
 *
 * @param {object} ctx
 */
function getWritableBook(ctx) {
    if (isWorldbookDesc(ctx)) {
        return descBookName(getActiveCharacter(ctx));
    }
    return getWritableBookSetting(ctx);
}

/**
 * 当前角色"绑定了但不属于可写目标"的其他书。
 *
 * 只认文件型的绑定：`character.data.extensions.world`（角色自带）与
 * `chat_metadata.world_info`（聊天级）。卡内嵌的 `character_book` 没有独立文件，
 * loadWorldInfo 用名字取不到，所以既不可写也不参与读取（spec §11.1）。
 */
function getBoundBookNames(ctx) {
    const names = [];
    const character = getActiveCharacter(ctx);

    const characterWorld = character?.data?.extensions?.world;
    if (typeof characterWorld === 'string' && characterWorld.trim()) {
        names.push(characterWorld.trim());
    }

    const chatWorld = ctx?.chatMetadata?.world_info;
    if (typeof chatWorld === 'string' && chatWorld.trim()) {
        names.push(chatWorld.trim());
    }

    return names;
}

/**
 * 这本书会不会被 ST 扫描到 —— 决定写进去的条目有没有机会进入上下文。
 *
 * 三条路都能让一本书进入扫描范围：
 *   1. 角色自带（`character.data.extensions.world`）
 *   2. 聊天级绑定（`chat_metadata.world_info`）
 *   3. 世界书面板里被手动勾选（`#world_info` 的 option 值是 `world_names` 的下标）
 *
 * 第 3 条没有公开 API，`selected_world_info` 只在 change 事件里重建，所以只能读 DOM。
 * 前三者之外，条目写得再对也只是躺在文件里。
 *
 * @param {object} ctx
 * @param {string} book
 * @returns {boolean|null} null = 判断不了（面板还没渲染 / 书单拿不到），调用方按"未确认"处理
 */
function isBookScanned(ctx, book) {
    const name = String(book ?? '').trim();
    if (!name) {
        return null;
    }

    // 绑定的书不需要手动激活，ST 每次都会带上
    if (getBoundBookNames(ctx).includes(name)) {
        return true;
    }

    const select = document.getElementById('world_info');
    if (!select || !select.options || select.options.length === 0) {
        return null;
    }

    const names = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
    if (!Array.isArray(names) || names.length === 0) {
        return null;
    }

    // 多选框：selectedOptions 就是当前勾选的那几本，option.value 是下标
    const selected = Array.from(select.selectedOptions ?? []);
    return selected.some(option => names[Number(option.value)] === name);
}

export { getWritableBook, getBoundBookNames, isBookScanned };
