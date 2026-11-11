/** Compatibility entry. Implementation lives in src/features/memory/. */
export { getActiveCharacter, cardDescription, saveDescription, applyDescriptionLocally, refreshDescriptionEditor } from './features/memory/character-target.js';
export { getWritableBook, getBoundBookNames, isBookScanned } from './features/memory/target-selection.js';
export { listLore, locateLoreEntry } from './features/memory/lore-directory.js';
export { reservedHint } from './features/memory/target-errors.js';
export { entryTitle, findLoreEntry, nextLoreUid, clampEntryPosition } from './features/memory/lore-entry.js';
export { loadWritableBook, loadBook, loadBookFromDisk, persistBook } from './features/memory/lore-repository.js';
export { createLoreEntry, appendLoreEntry, replaceLoreEntry, restoreLoreEntry } from './features/memory/lore-write.js';
export { buildDraftView, commitDraft, discardDraft } from './features/memory/draft-commit.js';
