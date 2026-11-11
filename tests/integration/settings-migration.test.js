import { it, expect } from 'vitest';
import {
    ensureSettings, getState, setWritableBookSetting, setDescStorageMode,
    isLearningActive, markLearningRunning, isEnabled,
} from '../../src/store.js';
import { createContext } from '../helpers/context.js';

it('migrates obsolete settings once, deletes migrated keys and preserves prompt order', () => {
    const ctx = createContext({ settings: {
        passiveInterval: 12, passiveKeywords: '记住', passiveByDefault: true,
        sessionRules: '旧规则', learningUserMessage: '本场任务', compactUserMessage: '压缩任务',
        promptOrder: ['custom', 'target'], customPrompts: [{ id: 'custom', name: '自建', content: '文本' }],
        blockActive: '旧', toolsResident: true, moduleWorldbook: false,
    } });
    const settings = ensureSettings(ctx);
    expect(settings).toMatchObject({
        learnInterval: 12, learnKeywords: '记住', enabledByDefault: true,
        sessionRules: '', learningTask: '旧规则\n\n本场任务', compactTask: '压缩任务',
        promptOrder: ['rules', 'custom', 'target'],
    });
    for (const key of ['passiveInterval', 'passiveKeywords', 'passiveByDefault', 'learningUserMessage', 'compactUserMessage', 'blockActive', 'toolsResident', 'moduleWorldbook']) {
        expect(Object.hasOwn(settings, key)).toBe(false);
    }
    const saved = JSON.stringify(settings);
    ctx.saveSettingsDebounced.mockClear();
    expect(ensureSettings(ctx)).toBe(settings);
    expect(JSON.stringify(settings)).toBe(saved);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
});

it('migrates legacy chat state in place without losing baseline or sharing chats', () => {
    const ctx = createContext({ metadata: { thrive: { passive: { enabled: true, baseline: 8, lastLearnedUserHash: 'hash' } } } });
    const state = getState(ctx);
    expect(state.learn).toMatchObject({ baseline: 8, lastHash: 'hash' });
    expect(state.enabled).toBe(true);
    expect(Object.hasOwn(state, 'passive')).toBe(false);
    expect(getState(ctx)).toBe(state);
    const learn = state.learn;
    expect(getState(ctx).learn).toBe(learn);

    setWritableBookSetting(ctx, '第一本');
    setDescStorageMode(ctx, 'worldbook');
    ctx.chatMetadata = {};
    expect(getState(ctx)).toMatchObject({ writableBook: '', descStorage: 'card' });
    expect(state).toMatchObject({ writableBook: '第一本', descStorage: 'worldbook' });
});

it('keeps legacy per-chat defaults until the user explicitly chooses a value', () => {
    const ctx = createContext({ settings: { writableBook: '旧书', descStorage: 'worldbook' } });
    expect(getState(ctx)).toMatchObject({ writableBook: '旧书', descStorage: 'worldbook' });
    ctx.chatMetadata = {};
    expect(getState(ctx).writableBook).toBe('旧书');
    setWritableBookSetting(ctx, '新书');
    expect(Object.hasOwn(ensureSettings(ctx), 'writableBook')).toBe(false);
    setDescStorageMode(ctx, 'card');
    expect(Object.hasOwn(ensureSettings(ctx), 'descStorage')).toBe(false);
});

it('distinguishes enabling a chat from running a session', () => {
    const ctx = createContext({ settings: { enabledByDefault: true } });
    expect(isEnabled(ctx)).toBe(true);
    expect(isLearningActive()).toBe(false);
    try {
        markLearningRunning({ reason: 'manual' });
        expect(isLearningActive()).toBe(true);
    } finally {
        markLearningRunning(null);
    }
    expect(isLearningActive()).toBe(false);
});
