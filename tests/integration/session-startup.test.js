import { it, expect, vi } from 'vitest';
import { createContext } from '../helpers/context.js';
const transport = vi.hoisted(() => ({
    probe: vi.fn(),
    request: vi.fn(),
}));
vi.mock('../../src/platform/sillytavern/transport.js', () => ({
    DEFAULT_TIMEOUT_MS: 60000,
    probeTransport: transport.probe,
    requestOnce: transport.request,
}));
import { startLearning, stopLearning, getLearningQueue } from '../../src/features/learning/learning.js';
import { isSessionRunning } from '../../src/features/session/session.js';
import { isLearningActive } from '../../src/features/settings/index.js';

it('queues during async connection setup and honors stop before the first request', async () => {
    let resolveProbe;
    transport.probe.mockImplementation(() => new Promise(resolve => { resolveProbe = resolve; }));
    const ctx = createContext({ chat: [{ is_user: true, mes: '学习内容' }] });
    const first = startLearning(ctx);
    try {
        expect(isSessionRunning()).toBe(true);
        expect(startLearning(ctx)).toMatchObject({ ok: true, queued: 1 });
        expect(stopLearning()).toBe(true);
        expect(getLearningQueue()).toEqual([]);
    } finally {
        resolveProbe({ ok: true });
    }
    expect(await first.promise).toMatchObject({ ok: false, stopped: 'aborted' });
    expect(transport.request).not.toHaveBeenCalled();
    expect(isSessionRunning()).toBe(false);
    expect(isLearningActive()).toBe(false);
});
