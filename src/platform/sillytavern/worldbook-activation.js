import { selected_world_info, world_info } from '../../../../../../world-info.js';

/** File-backed books scanned by the host for this chat, before keyword matching. */
export function scannedBookNames(ctx) {
    const character = ctx.characters?.[ctx.characterId];
    const filename = String(character?.avatar ?? '').replace(/\.[^.]+$/, '');
    const extra = world_info.charLore?.find(item => item.name === filename)?.extraBooks ?? [];
    return [...new Set([
        ...selected_world_info,
        character?.data?.extensions?.world,
        ...extra,
        ctx.chatMetadata?.world_info,
        ctx.powerUserSettings?.persona_description_lorebook,
    ].filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
}

/** Activate an existing book, preserving other global selections. */
export function activateBook(ctx, book) {
    if (scannedBookNames(ctx).includes(book)) return;
    selected_world_info.push(book);
    world_info.globalSelect = selected_world_info;
    const names = ctx.getWorldInfoNames?.() ?? [];
    const select = document.getElementById('world_info');
    const option = Array.from(select?.options ?? []).find(item => names[Number(item.value)] === book);
    if (option) {
        option.selected = true;
        if (typeof globalThis.$ === 'function') globalThis.$(select).trigger('change');
        else select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    ctx.saveSettingsDebounced?.();
}
