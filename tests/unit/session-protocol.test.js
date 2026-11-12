// Regression scenarios promoted from .workbuddy/session-check.mjs; obsolete scratch/ticket APIs omitted.
import { describe, it, expect } from 'vitest';
import {
    assertProtocol, systemText, userText, userWithImages, assistantReply, toolResult, toChat, estimateTokens,
} from '../../src/features/session/session-messages.js';
import { detectShape, readReply } from '../../src/features/session/session-provider.js';
import { compilePreset } from '../../src/features/session/session-preset.js';
import { applyPreset, sendUserMessage } from '../../src/features/session/session.js';
import { createSessionTools, executeTool } from '../../src/features/session/session-tools.js';

describe('session message protocol', () => {
    it('preserves system/user messages and pairs each tool result with its normalized call id', () => {
        const assistant = assistantReply('ignored when calling tools', [
            { id: 'same', name: 'read', arguments: { key: '北境' } },
            { id: 'same', name: 'read', arguments: {} },
        ]);
        const messages = [
            systemText('规则'), userText('目标'), assistant,
            ...assistant.tool_calls.map(call => toolResult(call.id, '结果')),
        ];
        expect(new Set(assistant.tool_calls.map(call => call.id)).size).toBe(2);
        expect(assistant.content).toBeNull();
        expect(typeof assistant.tool_calls[0].function.arguments).toBe('string');
        expect(assertProtocol(messages).ok).toBe(true);
        expect(toChat(messages)).toEqual(messages);
    });

    it.each([
        [[{ role: 'unknown', content: 'x' }]],
        [[{ role: 'tool', content: 'result', tool_call_id: 'missing' }]],
        [[{ role: 'user', content: '' }]],
    ])('rejects an invalid protocol sequence %j', messages => {
        expect(assertProtocol(messages).ok).toBe(false);
    });

    it('keeps image blocks and accounts for their token cost', () => {
        const plain = userText('教授');
        const image = userWithImages('教授', ['data:image/png;base64,AAAA']);
        expect(toChat([image])[0].content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'image_url' }),
        ]));
        expect(estimateTokens([image])).toBeGreaterThan(estimateTokens([plain]));
    });
});

describe('provider responses', () => {
    it('supports old function_call and generates missing ids', () => {
        const reply = readReply({ choices: [{ message: { function_call: { name: 'read', arguments: '{}' } } }] });
        expect(reply.ok).toBe(true);
        expect(reply.toolCalls[0]).toMatchObject({ name: 'read', arguments: '{}' });
        expect(reply.toolCalls[0].id).toBeTruthy();
    });

    it.each([
        [{ content: [{ type: 'text', text: 'hello' }] }, 'claude'],
        [{ candidates: [] }, 'gemini'],
        [{ message: {} }, 'cohere'],
    ])('reports unsupported response shapes explicitly', (data, shape) => {
        expect(detectShape(data)).toBe(shape);
        expect(readReply(data)).toMatchObject({ ok: false, error: 'SESSION_PROVIDER_UNSUPPORTED' });
    });

    it('distinguishes empty OpenAI responses from unsupported providers', () => {
        expect(readReply({ choices: [] })).toEqual({ ok: false, error: 'SESSION_EMPTY_REPLY' });
    });
});

describe('preset and tool execution', () => {
    it('allows an explicitly empty preset for an opening-only session but still rejects malformed presets', () => {
        expect(compilePreset({}, { runs: [] }).ok).toBe(false);
        expect(compilePreset({}, { runs: [] }, { allowEmpty: true })).toMatchObject({ ok: true, runs: [] });
        expect(compilePreset({}, null, { allowEmpty: true })).toMatchObject({ ok: false, error: 'SESSION_NO_PRESET' });
    });

    it('expands opening instructions after preset macros and keeps images on the same message', () => {
        let value = '';
        const session = {
            state: 'open',
            messages: [],
            ctx: {
                substituteParams: text => {
                    if (text === '{{setvar::place::雾港}}') {
                        value = '雾港';
                        return '设定完成';
                    }
                    return text.replace('{{getvar::place}}', value);
                },
            },
        };
        expect(applyPreset(session, { runs: [{ role: 0, text: '{{setvar::place::雾港}}' }] }).ok).toBe(true);
        expect(sendUserMessage(session, '整理{{getvar::place}}\n学习任务', { images: ['data:image/png;base64,AAAA'] }).ok).toBe(true);
        expect(session.messages.at(-1)).toMatchObject({
            role: 'user',
            content: [
                { type: 'text', text: '整理雾港\n学习任务' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
        });
    });

    it('expands macros in card order and preserves separate runs', () => {
        const calls = [];
        const result = compilePreset({ substituteParams: text => { calls.push(text); return text.replace('{{char}}', '角色'); } }, {
            runs: [{ role: 0, text: '{{char}}' }, { role: 'system', text: '下一张' }, { role: 1, text: ' ' }],
        });
        expect(result.ok).toBe(true);
        expect(calls).toEqual(['{{char}}']);
        expect(result.runs.map(run => run.text)).toEqual(['角色', '下一张']);
    });

    it('feeds recoverable failures back as nonempty JSON and preserves fatal failures', async () => {
        const tools = createSessionTools({ defs: [
            { name: 'crash', run: () => { throw new Error('broken'); } },
            { name: 'fatal', run: () => ({ ok: false, fatal: true, error: 'STOP' }) },
            { name: 'empty', run: () => ({ text: '' }) },
        ] });
        expect(await executeTool(tools, { name: 'missing' }, {})).toMatchObject({ ok: false, fatal: false });
        expect(await executeTool(tools, { name: 'crash' }, {})).toMatchObject({ error: 'TOOL_CRASHED' });
        expect(await executeTool(tools, { name: 'fatal' }, {})).toMatchObject({ fatal: true, error: 'STOP' });
        const output = await executeTool(tools, { name: 'empty' }, {});
        expect(JSON.parse(output.text)).toMatchObject({ ok: true });
        expect(await executeTool(tools, { name: 'empty', arguments: '{' }, {})).toMatchObject({ error: 'ARGS_NOT_JSON' });
    });
});
