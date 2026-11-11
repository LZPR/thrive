import { beforeEach, it, expect, vi } from 'vitest';
import { createContext } from '../helpers/context.js';
import { ensureSettings, getLearn } from '../../src/features/settings/index.js';

const runner = vi.hoisted(() => ({
    busy: false,
    resolve: null,
    runSession: vi.fn(),
    abortActiveSession: vi.fn(),
}));

vi.mock('../../src/features/session/session.js', () => ({
    isSessionRunning: () => runner.busy,
    runSession: runner.runSession,
    abortActiveSession: runner.abortActiveSession,
}));

import { startLearning, stopLearning, clearLearningQueue, getLearningQueue, MAX_QUEUE } from '../../src/features/learning/learning.js';

beforeEach(() => {
    clearLearningQueue();
    runner.busy = false;
    runner.runSession.mockReset().mockImplementation(() => {
        runner.busy = true;
        return new Promise(resolve => {
            runner.resolve = result => { runner.busy = false; resolve(result); };
        });
    });
    runner.abortActiveSession.mockReset().mockImplementation(() => {
        runner.resolve?.({ ok: false, stopped: 'aborted' });
        return true;
    });
});

function context() {
    return createContext({ chat: [{ is_user: true, mes: '记住这个事实' }, { is_user: false, mes: '好的' }] });
}

it('Professor leaves the chat-learning baseline unchanged and fixes its connection at launch', async () => {
    const ctx = context();
    const settings = ensureSettings(ctx);
    settings.connectionProfile = 'first';
    getLearn(ctx).baseline = 9;
    const started = startLearning(ctx, { teach: { text: '教授内容' } });
    settings.connectionProfile = 'second';
    expect(runner.runSession.mock.calls[0][0]).toMatchObject({ profileId: 'first' });
    expect(getLearn(ctx).baseline).toBe(9);
    runner.resolve({ ok: true, stopped: 'no_tool_calls' });
    await started.promise;
    expect(getLearn(ctx).baseline).toBe(9);
});

it('queues a bounded number of tasks and stop clears them before completing the current run', async () => {
    const ctx = context();
    const started = startLearning(ctx);
    for (let i = 1; i <= MAX_QUEUE; i++) {
        expect(startLearning(ctx)).toMatchObject({ ok: true, queued: i });
    }
    expect(startLearning(ctx)).toMatchObject({ ok: false, error: 'SESSION_QUEUE_FULL' });
    expect(stopLearning()).toBe(true);
    expect(getLearningQueue()).toEqual([]);
    await started.promise;
    expect(runner.runSession).toHaveBeenCalledTimes(1);
});

it('drops queued tasks whose chat changed while a run was active', async () => {
    const ctx = context();
    const started = startLearning(ctx);
    startLearning(ctx);
    ctx.getCurrentChatId = () => 'different-chat';
    runner.resolve({ ok: true });
    await started.promise;
    expect(getLearningQueue()).toEqual([]);
    expect(runner.runSession).toHaveBeenCalledTimes(1);
});
