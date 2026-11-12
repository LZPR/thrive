import { it, expect } from 'vitest';
import { CARD_ID, normalizeOrder } from '../../src/features/prompts/prompt-order.js';
import { parseStPreset, applyPresetImport } from '../../src/features/prompts/prompt-import.js';
import {
    buildPreset,
    getCompactMessage,
    getLearningMessage,
    removePromptCard,
} from '../../src/features/prompts/prompt.js';
import { ensureSettings } from '../../src/features/settings/index.js';
import { createContext } from '../helpers/context.js';

it('keeps explicit order and pins the target content block last', () => {
    expect(normalizeOrder(['b', 'target', 'a', 'b', 'deleted', 'rules'], ['a', 'b', 'c']))
        .toEqual(['b', 'a', 'c', 'target']);
    expect(normalizeOrder(['targetEnd', 'targetDesc', 'target']))
        .toEqual(['targetDesc', 'target', 'targetEnd']);
    expect(normalizeOrder(['target'])).toEqual(['target']);
});

it('imports roles, enable flags and order while excluding host markers and duplicate prompts', () => {
    const parsed = parseStPreset({
        prompts: [
            { identifier: 'a', name: 'A', content: '规则', role: 'system' },
            { identifier: 'b', name: 'B', content: '消息', role: 'user' },
            { identifier: 'a', content: '重复' },
            { identifier: 'marker', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }] }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.prompts.map(item => [item.name, item.role, item.enabled]))
        .toEqual([['B', 1, false], ['A', 0, true]]);
    const settings = ensureSettings(createContext());
    applyPresetImport(settings, parsed);
    expect(settings.promptOrder).toEqual([...settings.customPrompts.map(item => item.id), 'targetDesc', 'target', 'targetEnd']);
    const preset = buildPreset(settings, { target: '目标正文' });
    expect(preset.runs.map(run => run.text).join('\n')).toContain('目标正文');
    expect(preset.runs.map(run => run.text).join('\n')).not.toContain('消息');
});

it('places runtime content between editable boundary cards and skips removed or disabled boundaries', () => {
    const settings = ensureSettings(createContext());
    settings.targetPrompt = '开始';
    settings.targetEndPrompt = '结束';
    settings.promptOrder = [CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END];
    expect(buildPreset(settings, { target: '材料' }).runs.map(run => run.text))
        .toEqual(['开始', '材料', '结束']);

    settings.disabledCards = [CARD_ID.TARGET_DESC];
    settings.promptOrder = [CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END];
    expect(buildPreset(settings, { target: '材料' }).runs.map(run => run.text))
        .toEqual(['材料', '结束']);

    settings.promptOrder = [CARD_ID.TARGET];
    expect(buildPreset(settings, { target: '材料' }).runs.map(run => run.text))
        .toEqual(['材料']);
});

it('lets each boundary be removed independently and keeps task identities separate', () => {
    const settings = ensureSettings(createContext());
    expect(removePromptCard(settings, CARD_ID.TARGET_DESC)).toBe(true);
    expect(removePromptCard(settings, CARD_ID.TARGET_END)).toBe(true);
    expect(buildPreset(settings, { target: '材料' }).runs.map(run => run.text)).toEqual(['材料']);
    expect(getLearningMessage(settings)).toContain('学习专家');
    expect(getLearningMessage(settings)).not.toContain('压缩专家');
    expect(getCompactMessage(settings)).toContain('压缩专家');
    expect(getCompactMessage(settings)).not.toContain('学习专家');
});

it.each([
    ['{', 'NOT_JSON'],
    [{ other: [] }, 'NO_PROMPTS'],
    [{ prompts: [{ marker: true }] }, 'NOTHING_TO_IMPORT'],
])('reports invalid imports without modifying settings', (input, error) => {
    expect(parseStPreset(input)).toMatchObject({ ok: false, error });
});
