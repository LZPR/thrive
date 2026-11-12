/** Compatibility entry. Implementation lives in src/features/settings/. */
export { MODULE_NAME, DEFAULT_SETTINGS } from './defaults.js';
export { getDescFormats, getActiveDescFormats, setDescFormats } from './chat-store.js';
export { LEARN_BASELINE_NONE } from './normalization.js';
export { ensureSettings } from './settings-store.js';
export { createChatState, getState, isEnabled, descStorageMode, isWorldbookDesc, setDescStorageMode, getWritableBookSetting, setWritableBookSetting, getDraftState, setDraftState, isChatAvailable, saveChat } from './chat-store.js';
export { getLearn, setEnabled, beginLearn, finishLearn, getLastLearnRun, markLearningRunning, getLearningRunning, isLearningActive } from './learning-state.js';
export { READ_KEY_DESC, DESC_SEEN, resetReads, getReadHash, setReadHash, clearReadHash, loreReadKey, bookReadKey, BOOK_SEEN, loreSeenKey, descPatternKey, lorePatternKey, descPatternPrefix, lorePatternPrefix, clearReadKeysByPrefix } from './read-tracker.js';
export { rememberDescBackup, rememberLoreBackup, getLoreBackups, findLoreBackup, markLoreBackupRestored, dropDraftBackups, getDescBackup } from './backup-store.js';
