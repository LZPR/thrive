import { beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ runSession: vi.fn(), running: false }));
vi.mock('../../src/features/session/session.js', () => ({
    isSessionRunning: () => session.running,
    runSession: session.runSession,
}));

import { createContext } from '../helpers/context.js';
import { ensureSettings } from '../../src/features/settings/index.js';
import {
    getCompressCandidate,
    moveCompressCandidate,
    rejectCompressCandidate,
    smartCompress,
} from '../../src/features/memory/compress.js';

beforeEach(() => {
    session.running = false;
    session.runSession.mockReset();
});

it('keeps generated revisions temporary and gives each item a read-only isolated session', async () => {
    const ctx = createContext();
    const settings = ensureSettings(ctx);
    session.runSession
        .mockResolvedValueOnce({ ok: true, reply: '压缩版本一' })
        .mockResolvedValueOnce({ ok: true, reply: '压缩版本二' });
    const item = { id: 'lore:book|entry|1', title: '条目', text: '原始正文', chars: 100, soft: 50, hard: 200 };

    expect(await smartCompress(ctx, settings, [item])).toMatchObject({ ok: true, generated: 1 });
    expect(getCompressCandidate(item.id)).toMatchObject({ source: '原始正文', versions: ['压缩版本一'] });
    expect(session.runSession.mock.calls[0][0]).toMatchObject({ tools: [], userMessage: expect.any(String) });
    expect(session.runSession.mock.calls[0][0].preset.runs.map(run => run.text).join('\n')).toContain('原始正文');

    expect(await smartCompress(ctx, settings, [item])).toMatchObject({ ok: true, generated: 1 });
    expect(getCompressCandidate(item.id).versions).toEqual(['压缩版本一', '压缩版本二']);
    expect(moveCompressCandidate(item.id, -1).versions.at(-1)).toBe('压缩版本二');
    expect(moveCompressCandidate(item.id, 1).versions.at(1)).toBe('压缩版本二');
    expect(rejectCompressCandidate(item.id)).toBe(true);
    expect(getCompressCandidate(item.id)).toBeNull();
});

it('does not start compression while another session occupies the shared slot', async () => {
    session.running = true;
    const result = await smartCompress(createContext(), {}, [{ id: 'x', text: 'body' }]);
    expect(result.ok).toBe(false);
    expect(session.runSession).not.toHaveBeenCalled();
});
