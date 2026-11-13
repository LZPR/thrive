import { notifyPanel } from '../../shared/events.js';
import { descBookName } from './desc-entry.js';
import { getDescriptionBookSetting, getWritableBookSetting, isWorldbookDesc } from '../settings/index.js';
import { getActiveCharacter } from './character-target.js';
import { activateBook, scannedBookNames } from '../../platform/sillytavern/worldbook-activation.js';

/** Other settings choose only the creation destination; empty follows the character name. */
function getWritableBook(ctx) {
    return getWritableBookSetting(ctx) || descBookName(getActiveCharacter(ctx));
}

function getDescriptionBook(ctx) {
    return getDescriptionBookSetting(ctx) || descBookName(getActiveCharacter(ctx));
}

function getBoundBookNames(ctx) {
    const character = getActiveCharacter(ctx);
    return [character?.data?.extensions?.world, ctx.chatMetadata?.world_info]
        .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
}

function isBookScanned(ctx, book) {
    return Boolean(book) && scannedBookNames(ctx).includes(book);
}

/** Reading never creates files. Existing destinations activate before the read. */
function prepareBookRead(ctx, book) {
    if ((ctx.getWorldInfoNames?.() ?? []).includes(book) && !isBookScanned(ctx, book)) {
        activateBook(ctx, book);
        notifyPanel();
    }
}

function getLoreBookNames(ctx) {
    prepareBookRead(ctx, getWritableBook(ctx));
    if (isWorldbookDesc(ctx)) prepareBookRead(ctx, getDescriptionBook(ctx));
    const existing = ctx.getWorldInfoNames?.() ?? [];
    return [...new Set([...scannedBookNames(ctx), getWritableBook(ctx)])]
        .filter(name => name && (existing.includes(name) || name === getWritableBook(ctx)));
}

export { getWritableBook, getDescriptionBook, getBoundBookNames, isBookScanned, prepareBookRead, getLoreBookNames };
