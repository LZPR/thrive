import { applyDescriptionLocally, refreshDescriptionEditor } from '../../platform/sillytavern/character-editor.js';
import { saveDescription } from '../../platform/sillytavern/character.js';
/** character-target.js · Internal memory module; public entry: index.js. */

import { normalizeEol } from '../../shared/util.js';

/**
 * 当前选中的角色。没有选中时返回 null。
 * @param {object} ctx getContext() 的返回值
 */
function getActiveCharacter(ctx) {
    const index = ctx?.characterId;
    if (index === undefined || index === null || index === '') {
        return null;
    }
    const character = ctx.characters?.[index];
    return character ?? null;
}

/**
 * 角色卡上的描述（空角色返回空串）。
 *
 * 只在 `descStorage = 'card'` 时有意义；统一模式的正文在世界书条目里，
 * 读数请走 desc.js 的 readDesc（它要 load 世界书，是异步的）。
 *
 * @param {object} ctx
 * @returns {string}
 */
function cardDescription(ctx) {
    const character = getActiveCharacter(ctx);
    if (!character) {
        return '';
    }
    return normalizeEol(typeof character.description === 'string'
        ? character.description
        : String(character.description ?? ''));
}

export { getActiveCharacter, cardDescription, saveDescription, applyDescriptionLocally, refreshDescriptionEditor };
