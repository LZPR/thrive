import { it, expect } from 'vitest';
import { normalizeOrder } from '../../src/features/prompts/prompt-order.js';
import { parseStPreset, applyPresetImport } from '../../src/features/prompts/prompt-import.js';
import { buildPreset } from '../../src/features/prompts/prompt.js';
import { ensureSettings } from '../../src/features/settings/index.js';
import { createContext } from '../helpers/context.js';

it('keeps explicit order, removes duplicates and deleted cards, and pins the target last', () => {
    expect(normalizeOrder(['b', 'target', 'a', 'b', 'deleted', 'rules'], ['a', 'b', 'c']))
        .toEqual(['b', 'a', 'rules', 'c', 'target']);
    expect(normalizeOrder(['rules'])).toEqual(['rules', 'target']);
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
    expect(settings.promptOrder).toEqual(['rules', ...settings.customPrompts.map(item => item.id), 'targetDesc', 'target']);
    const preset = buildPreset(settings, { target: '目标正文' });
    expect(preset.runs.map(run => run.text).join('\n')).toContain('目标正文');
    expect(preset.runs.map(run => run.text).join('\n')).not.toContain('消息');
});

it.each([
    ['{', 'NOT_JSON'],
    [{ other: [] }, 'NO_PROMPTS'],
    [{ prompts: [{ marker: true }] }, 'NOTHING_TO_IMPORT'],
])('reports invalid imports without modifying settings', (input, error) => {
    expect(parseStPreset(input)).toMatchObject({ ok: false, error });
});
