import { it, expect } from 'vitest';
import { createContext } from '../helpers/context.js';
import { getLearn, setDescFormats } from '../../src/features/settings/index.js';
import { evaluateAuto, parseKeywords, countMessages, TRIGGER } from '../../src/features/learning/auto-learn.js';
import { fnv1a } from '../../src/shared/util.js';

it('counts visible chat messages and fires the interval only after an assistant reply', () => {
    const ctx = createContext({ settings: { enabledByDefault: true, learnInterval: 2 }, chat: [
        { is_user: true, mes: '问题' }, { is_user: false, mes: '回答' }, { is_system: true, mes: '系统消息' },
    ] });
    getLearn(ctx).baseline = 0;
    expect(countMessages(ctx)).toBe(2);
    expect(evaluateAuto(ctx, 'user').fire).toBe(false);
    expect(evaluateAuto(ctx, 'assistant')).toMatchObject({ fire: true, reason: TRIGGER.INTERVAL });
});

it('deduplicates keywords, triggers on keywords and suppresses an already-learned round', () => {
    expect(parseKeywords('记住,北境；记住\n北境')).toEqual(['记住', '北境']);
    const ctx = createContext({ settings: { enabledByDefault: true, learnKeywords: '北境' }, chat: [
        { is_user: true, mes: '北境在南边' }, { is_user: false, mes: '好的' },
    ] });
    expect(evaluateAuto(ctx)).toMatchObject({ fire: true, reason: TRIGGER.KEYWORD });
    getLearn(ctx).lastHash = fnv1a('北境在南边');
    expect(evaluateAuto(ctx)).toMatchObject({ fire: false, reason: 'JUST_LEARNED' });
});

it('does not trigger or align the baseline when no description format is active', () => {
    const ctx = createContext({ settings: { enabledByDefault: true, learnInterval: 1, learnKeywords: '北境' }, chat: [
        { is_user: true, mes: '北境在南边' }, { is_user: false, mes: '好的' },
    ] });
    setDescFormats(ctx, []);
    const baseline = getLearn(ctx).baseline;
    expect(evaluateAuto(ctx)).toMatchObject({ fire: false, reason: 'NO_DESC_FORMAT' });
    expect(getLearn(ctx).baseline).toBe(baseline);
    setDescFormats(ctx, ['text']);
    expect(evaluateAuto(ctx)).toMatchObject({ fire: true, reason: TRIGGER.KEYWORD });
});
