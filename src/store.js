/** Compatibility entry. Implementation lives in src/features/settings/. */
export { MODULE_NAME, DEFAULT_SETTINGS } from './features/settings/defaults.js';
export { LEARN_BASELINE_NONE } from './features/settings/normalization.js';
export { ensureSettings } from './features/settings/settings-store.js';
export { createChatState, getState, isEnabled, descStorageMode, isWorldbookDesc, setDescStorageMode, getWritableBookSetting, setWritableBookSetting, getDraftState, setDraftState, isChatAvailable, saveChat } from './features/settings/chat-store.js';
export { getLearn, setEnabled, beginLearn, finishLearn, getLastLearnRun, markLearningRunning, getLearningRunning, isLearningActive } from './features/settings/learning-state.js';
export { READ_KEY_DESC, DESC_SEEN, resetReads, getReadHash, setReadHash, clearReadHash, loreReadKey, bookReadKey, BOOK_SEEN, loreSeenKey, descPatternKey, lorePatternKey, descPatternPrefix, lorePatternPrefix, clearReadKeysByPrefix } from './features/settings/read-tracker.js';
export { rememberDescBackup, rememberLoreBackup, getLoreBackups, findLoreBackup, markLoreBackupRestored, dropDraftBackups, getDescBackup } from './features/settings/backup-store.js';
