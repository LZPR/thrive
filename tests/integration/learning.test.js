import { beforeEach, it, expect, vi } from 'vitest';
import { createContext } from '../helpers/context.js';
import { ensureSettings, getLearn, getState } from '../../src/features/settings/index.js';

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
    settings.learningTask = '学习时发送的内容';
    getLearn(ctx).baseline = 9;
    getLearn(ctx).lastHash = 'original-hash';
    getState(ctx).reads = { desc: 'previous-session' };
    const started = startLearning(ctx, { teach: { text: '教授内容' } });
    expect(getState(ctx).reads).toEqual({});
    settings.connectionProfile = 'second';
    expect(runner.runSession.mock.calls[0][0]).toMatchObject({ profileId: 'first' });
    const request = runner.runSession.mock.calls[0][0];
    expect(request.userMessage).toBe('教授内容\n学习时发送的内容');
    expect(request.preset.runs.some(run => run.ids.includes('target'))).toBe(false);
    expect(request.preset.runs.map(run => run.text).join('\n')).not.toContain('教授内容');
    expect(getLearn(ctx).baseline).toBe(9);
    runner.resolve({ ok: true, stopped: 'no_tool_calls' });
    await started.promise;
    expect(getLearn(ctx).baseline).toBe(9);
    expect(getLearn(ctx).lastHash).toBe('original-hash');
});

it('combines instructions and images in the opening message while keeping history in the preset', async () => {
    const ctx = context();
    ensureSettings(ctx).learningTask = '按工具写入';
    getLearn(ctx).baseline = 9;
    const started = startLearning(ctx, {
        includeHistory: true,
        teach: { text: '只记录地点', images: ['data:image/png;base64,AAAA'] },
    });
    const request = runner.runSession.mock.calls[0][0];
    expect(request.userMessage).toBe('只记录地点\n按工具写入');
    expect(request.images).toEqual(['data:image/png;base64,AAAA']);
    expect(request.preset.runs.find(run => run.ids.includes('target')).text).toContain('记住这个事实');
    expect(request.preset.runs.map(run => run.text).join('\n')).not.toContain('只记录地点');
    expect(getLearn(ctx).baseline).toBe(2);
    runner.resolve({ ok: true });
    await started.promise;
});

it('allows history-only and image-only learning and rejects a run with no input', async () => {
    const ctx = context();
    const history = startLearning(ctx, { includeHistory: true, teach: { text: '' } });
    expect(history.ok).toBe(true);
    runner.resolve({ ok: true });
    await history.promise;
    const image = startLearning(ctx, { includeHistory: false, teach: { images: ['data:image/png;base64,AAAA'] } });
    expect(image.ok).toBe(true);
    expect(runner.runSession.mock.calls[1][0].preset.runs.some(run => run.ids.includes('target'))).toBe(false);
    runner.resolve({ ok: true });
    await image.promise;
    expect(startLearning(ctx, { includeHistory: false, teach: { text: ' ' } }))
        .toMatchObject({ ok: false, error: 'TEACH_EMPTY' });
    expect(startLearning(createContext(), { includeHistory: true }))
        .toMatchObject({ ok: false, error: 'NO_TARGET' });
    expect(runner.runSession).toHaveBeenCalledTimes(2);
});

it('allows instructions in an empty chat without advancing its baseline', async () => {
    const ctx = createContext();
    getLearn(ctx).baseline = 9;
    const started = startLearning(ctx, { includeHistory: true, teach: { text: '记住雾港' } });
    expect(started.ok).toBe(true);
    expect(getLearn(ctx).baseline).toBe(9);
    runner.resolve({ ok: true });
    await started.promise;
});

it('fixes queued instructions, images and history choice at enqueue but reads history at launch', async () => {
    const ctx = context();
    ensureSettings(ctx).learningTask = '学习任务';
    const first = startLearning(ctx);
    const teach = { text: '入队时指令', images: ['data:image/png;base64,AAAA'] };
    const options = { includeHistory: true, teach };
    expect(startLearning(ctx, options)).toMatchObject({ ok: true, queued: 1 });
    teach.text = '后来修改的草稿';
    teach.images[0] = 'data:image/png;base64,BBBB';
    options.includeHistory = false;
    ctx.chat.push({ is_user: true, mes: '排队后新增聊天' });
    runner.resolve({ ok: true });
    await first.promise;
    const request = runner.runSession.mock.calls[1][0];
    expect(request.userMessage).toBe('入队时指令\n学习任务');
    expect(request.images).toEqual(['data:image/png;base64,AAAA']);
    expect(request.preset.runs.find(run => run.ids.includes('target')).text).toContain('排队后新增聊天');
    expect(getLearn(ctx).baseline).toBe(3);
    runner.resolve({ ok: true });
    await vi.waitFor(() => expect(runner.busy).toBe(false));
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
