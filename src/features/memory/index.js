/** Compatibility entry. Implementation lives in src/features/memory/. */
export { getActiveCharacter, cardDescription, saveDescription, applyDescriptionLocally, refreshDescriptionEditor } from './character-target.js';
export { getWritableBook, getBoundBookNames, isBookScanned } from './target-selection.js';
export { listLore, locateLoreEntry } from './lore-directory.js';
export { reservedHint } from './target-errors.js';
export { entryTitle, findLoreEntry, nextLoreUid, clampEntryPosition } from './lore-entry.js';
export { loadWritableBook, loadBook, loadBookFromDisk, persistBook } from './lore-repository.js';
export { createLoreEntry, appendLoreEntry, replaceLoreEntry, restoreLoreEntry } from './lore-write.js';
export { buildDraftView, commitDraft, discardDraft } from './draft-commit.js';
