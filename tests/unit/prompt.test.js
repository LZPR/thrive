import { it, expect } from 'vitest';
import { CARD_ID, DESCRIPTION_CARDS, normalizeOrder } from '../../src/features/prompts/prompt-order.js';
import { parseStPreset, applyPresetImport } from '../../src/features/prompts/prompt-import.js';
import {
    buildPreset,
    getCompactMessage,
    getLearningMessage,
    removePromptCard,
    getCardText,
    getPromptOrder,
    setPromptEnabled,
    setPromptRole,
    setPromptText,
    resetPromptText,
} from '../../src/features/prompts/prompt.js';
import { ensureSettings } from '../../src/features/settings/index.js';
import { createContext } from '../helpers/context.js';

const usageCards = Object.keys(DESCRIPTION_CARDS);

it('keeps explicit order and pins the target content block last', () => {
    expect(normalizeOrder(['b', 'target', 'a', 'b', 'deleted', 'rules'], ['a', 'b', 'c']))
        .toEqual(['b', 'a', 'c', ...usageCards, 'target']);
    expect(normalizeOrder(['targetEnd', 'targetDesc', 'target']))
        .toEqual([...usageCards, 'targetDesc', 'target', 'targetEnd']);
    expect(normalizeOrder(['target'])).toEqual([...usageCards, 'target']);
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
    expect(settings.promptOrder).toEqual([...settings.customPrompts.map(item => item.id), ...usageCards, 'targetDesc', 'target', 'targetEnd']);
    const preset = buildPreset(settings, { target: '目标正文' });
    expect(preset.runs.map(run => run.text).join('\n')).toContain('目标正文');
    expect(preset.runs.map(run => run.text).join('\n')).not.toContain('消息');
});

it('places runtime content between editable boundary cards and skips removed or disabled boundaries', () => {
    const settings = ensureSettings(createContext());
    settings.targetPrompt = '开始';
    settings.targetEndPrompt = '结束';
    settings.promptOrder = [CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END];
    expect(buildPreset(settings, { target: '材料', descFormats: [] }).runs.map(run => run.text))
        .toEqual(['开始', '材料', '结束']);

    settings.disabledCards = [CARD_ID.TARGET_DESC];
    settings.promptOrder = [CARD_ID.TARGET_DESC, CARD_ID.TARGET, CARD_ID.TARGET_END];
    expect(buildPreset(settings, { target: '材料', descFormats: [] }).runs.map(run => run.text))
        .toEqual(['材料', '结束']);

    settings.promptOrder = [CARD_ID.TARGET];
    expect(buildPreset(settings, { target: '材料', descFormats: [] }).runs.map(run => run.text))
        .toEqual(['材料']);
});

it('lets each boundary be removed independently and keeps task identities separate', () => {
    const settings = ensureSettings(createContext());
    expect(removePromptCard(settings, CARD_ID.TARGET_DESC)).toBe(true);
    expect(removePromptCard(settings, CARD_ID.TARGET_END)).toBe(true);
    expect(buildPreset(settings, { target: '材料', descFormats: [] }).runs.map(run => run.text)).toEqual(['材料']);
    expect(getLearningMessage(settings)).toContain('学习专家');
    expect(getLearningMessage(settings)).not.toContain('压缩专家');
    expect(getCompactMessage(settings)).toContain('压缩专家');
    expect(getCompactMessage(settings)).not.toContain('学习专家');
});

it('keeps three editable usage cards mandatory and only sends matching formats as system messages', () => {
    const settings = ensureSettings(createContext());
    for (const id of usageCards) {
        expect(removePromptCard(settings, id)).toBe(false);
        expect(setPromptEnabled(settings, id, false)).toBe(false);
        expect(setPromptRole(settings, id, 1)).toBe(false);
    }
    settings.disabledCards = [...usageCards];
    settings.promptRoles = { [CARD_ID.DESC_PLIST]: 2 };
    settings.promptOrder = [CARD_ID.DESC_ALICHAT, CARD_ID.TARGET, CARD_ID.DESC_PLIST, CARD_ID.DESC_TEXT];
    setPromptText(settings, CARD_ID.DESC_PLIST, '自定义 PLists 用途');
    const preset = buildPreset(settings, { target: '材料', descFormats: ['plist', 'alichat'] });
    expect(preset.runs.map(run => run.ids[0])).toEqual([CARD_ID.DESC_ALICHAT, CARD_ID.DESC_PLIST, CARD_ID.TARGET]);
    expect(preset.runs.every(run => run.role === 0)).toBe(true);
    expect(preset.runs.map(run => run.text).join('\n')).toContain('自定义 PLists 用途');
    expect(preset.runs.map(run => run.text).join('\n')).not.toContain('自然文本');
    resetPromptText(settings, CARD_ID.DESC_PLIST);
    expect(getCardText(settings, CARD_ID.DESC_PLIST)).toContain('性格');
    settings.promptOrder = [CARD_ID.TARGET];
    expect(getPromptOrder(settings)).toEqual([...usageCards, CARD_ID.TARGET]);
    applyPresetImport(settings, { prompts: [{ name: 'Imported', content: 'rule' }] });
    expect(getPromptOrder(settings).filter(id => usageCards.includes(id))).toEqual(usageCards);
});

it.each([
    ['{', 'NOT_JSON'],
    [{ other: [] }, 'NO_PROMPTS'],
    [{ prompts: [{ marker: true }] }, 'NOTHING_TO_IMPORT'],
])('reports invalid imports without modifying settings', (input, error) => {
    expect(parseStPreset(input)).toMatchObject({ ok: false, error });
});
