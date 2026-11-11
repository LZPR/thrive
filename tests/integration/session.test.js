import { it, expect, vi } from 'vitest';
import {
    openSession, applyPreset, sendUserMessage, runLoop, closeSession,
    runSession, isSessionRunning, abortActiveSession,
} from '../../src/features/session/session.js';
import { createContext } from '../helpers/context.js';

const preset = { id: 'test', runs: [{ role: 'system', text: '隔离会话' }] };
const response = message => ({ ok: true, data: { choices: [{ message }] } });
const probe = async () => ({ ok: true });

it('runs two rounds with private tools while leaving the chat and host tool registry untouched', async () => {
    const ctx = createContext({ chat: [{ mes: '主聊天' }] });
    ctx.registerFunctionTool = vi.fn();
    const before = structuredClone({ chat: ctx.chat, metadata: ctx.chatMetadata });
    const request = vi.fn()
        .mockResolvedValueOnce(response({ tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{}' } }] }))
        .mockResolvedValueOnce(response({ content: '完成' }));
    const result = await runSession({
        ctx, preset, userMessage: '学习', tools: [{ name: 'read', run: () => ({ ok: true, value: '记忆' }) }],
        deps: { probe, request },
    });
    expect(result).toMatchObject({ ok: true, rounds: 2, toolCalls: 1 });
    expect(request.mock.calls[1][1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call' });
    expect({ chat: ctx.chat, metadata: ctx.chatMetadata }).toEqual(before);
    expect(ctx.registerFunctionTool).not.toHaveBeenCalled();
    expect(isSessionRunning()).toBe(false);
});

it('enforces the round cap and handles cancellation before sending', async () => {
    const request = vi.fn().mockResolvedValue(response({ tool_calls: [{ function: { name: 'read', arguments: '{}' } }] }));
    const { session } = await openSession({
        ctx: createContext(), deps: { probe, request }, tools: [{ name: 'read', run: () => ({ ok: true }) }],
        maxRounds: 1,
    });
    applyPreset(session, preset);
    sendUserMessage(session, '目标');
    expect(await runLoop(session)).toMatchObject({ ok: false, stopped: 'rounds', error: 'SESSION_ROUND_LIMIT' });
    closeSession(session);

    const opened = await openSession({ ctx: createContext(), deps: { probe, request }, tools: [] });
    opened.session.abort.abort();
    request.mockClear();
    expect(await runLoop(opened.session)).toMatchObject({ stopped: 'aborted' });
    expect(request).not.toHaveBeenCalled();
    closeSession(opened.session);
});

it('reserves the single session slot during async setup and releases it on abort', async () => {
    let ready;
    const pending = new Promise(resolve => { ready = resolve; });
    const request = vi.fn(async (ctx, req) => {
        if (req.signal.aborted) {
            return { ok: false, error: 'SESSION_ABORTED' };
        }
        return response({ content: 'done' });
    });
    const first = runSession({
        ctx: createContext(), preset, userMessage: '学习', tools: [],
        deps: { probe: () => pending, request },
    });
    expect(await runSession({ ctx: createContext() })).toMatchObject({ error: 'SESSION_BUSY' });
    ready({ ok: true });
    await first;
    expect(isSessionRunning()).toBe(false);
    expect(abortActiveSession()).toBe(false);
});

it('propagates transport failures and releases the session slot', async () => {
    const result = await runSession({
        ctx: createContext(), preset, userMessage: '学习', tools: [],
        deps: { probe, request: async () => ({ ok: false, error: 'SESSION_HTTP_ERROR', detail: '503' }) },
    });
    expect(result).toMatchObject({ ok: false, error: 'SESSION_HTTP_ERROR' });
    expect(isSessionRunning()).toBe(false);
});
