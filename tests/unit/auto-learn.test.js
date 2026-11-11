import { it, expect } from 'vitest';
import { createContext } from '../helpers/context.js';
import { getLearn } from '../../src/features/settings/index.js';
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
