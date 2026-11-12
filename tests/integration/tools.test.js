import { beforeEach, afterEach, it, expect } from 'vitest';
import { getToolDefs } from '../../src/features/tools/index.js';
import { markLearningRunning, getState, ensureSettings } from '../../src/features/settings/index.js';
import { setContext } from '../helpers/host.js';
import { createContext } from '../helpers/context.js';

let ctx;
const call = (name, args = {}) => getToolDefs().find(tool => tool.name === name).action(args);

beforeEach(() => {
    ctx = createContext();
    setContext(ctx);
    ensureSettings(ctx);
    markLearningRunning(null);
});
afterEach(() => {
    markLearningRunning(null);
    setContext(null);
});

it('exposes a unique private catalog and rejects every call while no learning session runs', async () => {
    const defs = getToolDefs();
    expect(defs).toHaveLength(18);
    expect(new Set(defs.map(def => def.name)).size).toBe(defs.length);
    for (const def of defs) {
        expect(await def.action({})).toMatchObject({ ok: false, error: 'TOOL_UNAVAILABLE' });
    }
});

it('requires reading before a description write, stages the result and detects subsequent drift', async () => {
    markLearningRunning({ reason: 'manual' });
    expect(await call('desc_rewrite', { text: '新内容' })).toMatchObject({ error: 'READ_REQUIRED' });
    expect(await call('desc_read')).toMatchObject({ ok: true, text: '原始描述' });
    ctx.characters[0].description = '外部改动';
    expect(await call('desc_rewrite', { text: '新内容' })).toMatchObject({ error: 'STALE_READ' });
    await call('desc_read');
    expect(await call('desc_rewrite', { text: '新内容' })).toMatchObject({ ok: true, staged: true });
    expect(ctx.characters[0].description).toBe('外部改动');
    expect(getState(ctx).patch.after).toBe('新内容');
});

it('requires directory reads and stages new lore entries without writing the disk', async () => {
    const disk = { entries: {} };
    let writes = 0;
    ctx.loadWorldInfo = async () => structuredClone(disk);
    ctx.getWorldInfoNames = () => ['测试书'];
    ctx.saveWorldInfo = async () => { writes += 1; };
    getState(ctx).writableBook = '测试书';
    markLearningRunning({ reason: 'manual' });
    const args = { title: '北境', content: '北境在南边', keys: ['北境'] };
    expect(await call('lore_add', args)).toMatchObject({ error: 'READ_REQUIRED' });
    expect(getState(ctx).draft).toBeNull();
    await call('lore_list');
    expect(await call('lore_add', args)).toMatchObject({ ok: true });
    expect(writes).toBe(0);
    expect(Object.values(getState(ctx).draft.entries)[0]).toMatchObject({ comment: '北境', constant: false });
});
