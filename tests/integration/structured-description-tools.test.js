import { afterEach, beforeEach, expect, it } from 'vitest';
import { createContext } from '../helpers/context.js';
import { setContext } from '../helpers/host.js';
import { getToolDefs } from '../../src/features/tools/index.js';
import { createSessionTools } from '../../src/features/session/session-tools.js';
import { ensureSettings, getState, markLearningRunning, setDescFormats, setDescStorageMode } from '../../src/features/settings/index.js';
import { readDesc, syncDescEntries, writeDesc } from '../../src/features/memory/desc.js';
import { DESC_ENTRY_TITLES } from '../../src/features/memory/desc-entry.js';
import { commitDraft } from '../../src/features/memory/draft-commit.js';

let ctx;
let books;
const call = (name, args = {}) => getToolDefs().find(def => def.name === name).action(args);

beforeEach(async () => {
    ctx = createContext({ metadata: { thrive: { descStorage: 'worldbook', descFormats: ['plist', 'alichat'] } } });
    ctx.characters[0].avatar = 'structured.png';
    books = new Map();
    ctx.getWorldInfoNames = () => [...books.keys()];
    ctx.loadWorldInfo = async name => structuredClone(books.get(name) ?? { entries: {} });
    ctx.saveWorldInfo = async (name, data) => books.set(name, structuredClone(data));
    ctx.updateWorldInfoList = async () => {};
    setContext(ctx);
    await syncDescEntries(ctx, ['plist', 'alichat']);
    markLearningRunning({ reason: 'manual' });
});

afterEach(() => {
    markLearningRunning(null);
    setContext(null);
});

it('only sends enabled description tools and rejects calls to inactive formats', async () => {
    const names = createSessionTools({ ctx }).map(tool => tool.name);
    expect(names.filter(name => name.startsWith('desc_'))).toEqual([]);
    expect(names.filter(name => name.startsWith('plist_'))).toHaveLength(4);
    expect(names.filter(name => name.startsWith('alichat_'))).toHaveLength(4);
    expect(await call('desc_read')).toMatchObject({ error: 'TOOL_UNAVAILABLE' });
    setDescStorageMode(ctx, 'card');
    expect(createSessionTools({ ctx }).map(tool => tool.name)).toEqual(names.filter(name => name.startsWith('lore_')));
    expect(await call('plist_read')).toMatchObject({ error: 'TOOL_UNAVAILABLE' });
    setDescFormats(ctx, ['text']);
    expect(createSessionTools({ ctx })).toHaveLength(10);
});

it('adds, merges, updates, queries and deletes PLists without touching other descriptions or disk', async () => {
    expect(await call('plist_add', { key: 'persona', traits: ['kind'] })).toMatchObject({ error: 'READ_REQUIRED' });
    expect(await call('plist_read', { key: 'persona' })).toMatchObject({ ok: true, exists: false });
    expect(await call('plist_add', { key: 'persona', traits: ['kind', 'tall'] })).toMatchObject({
        ok: true, categories: { persona: ['kind', 'tall'] },
    });
    await call('plist_add', { key: 'persona', traits: ['kind', 'hobbies(reading, games)'] });
    expect(await call('plist_read')).toMatchObject({ categories: { persona: ['kind', 'tall', 'hobbies(reading, games)'] } });
    await call('plist_update', { key: 'persona', traits: ['brave', 'kind'] });
    await call('plist_delete', { key: 'persona', traits: ['kind'] });
    expect((await readDesc(ctx, 'plist')).text).toBe('[persona: brave]');
    expect((await readDesc(ctx, 'alichat')).text).toBe('');
    expect(Object.values(books.get('测试角色').entries).every(entry => entry.content === '')).toBe(true);
    await commitDraft(ctx);
    expect(Object.values(books.get('测试角色').entries)[0].content).toBe('[persona: brave]');
    await call('plist_delete', { key: 'persona' });
    expect((await readDesc(ctx, 'plist')).text).toBe('');
});

it('inserts, edits and deletes Ali:Chat pairs in order using the returned indices', async () => {
    await call('alichat_read');
    expect(await call('alichat_add', { question: '名字？', answer: '我是 Eden。' })).toMatchObject({ ok: true });
    await call('alichat_add', { index: 0, question: '喜欢什么？', answer: '茶。\n*微笑*' });
    expect(await call('alichat_read', { index: 1 })).toMatchObject({ item: { question: '名字？', answer: '我是 Eden。' } });
    await call('alichat_update', { index: 1, question: '名字？', answer: '叫我小明。' });
    await call('alichat_delete', { index: 0 });
    expect(await call('alichat_read')).toMatchObject({ items: [{ index: 0, question: '名字？', answer: '叫我小明。' }] });
    expect((await readDesc(ctx, 'alichat')).text).toBe('<START>\n{{user}}: 名字？\n{{char}}: 叫我小明。');
    expect((await readDesc(ctx, 'plist')).text).toBe('');
    expect(await call('alichat_delete', { index: 9 })).toMatchObject({ error: 'NOT_FOUND' });
});

it('requires the selected item to be read and rejects stale reads, including changed list positions', async () => {
    await writeDesc(ctx, '[persona: kind; appearance: tall]', 'plist');
    await call('plist_read', { key: 'persona' });
    expect(await call('plist_update', { key: 'appearance', traits: ['short'] })).toMatchObject({ error: 'READ_REQUIRED' });
    await writeDesc(ctx, '[persona: brave; appearance: tall]', 'plist');
    expect(await call('plist_update', { key: 'persona', traits: ['quiet'] })).toMatchObject({ error: 'STALE_READ' });
    await call('alichat_read');
    await call('alichat_add', { question: 'Q', answer: 'A' });
    getState(ctx).reads = {};
    await call('alichat_read', { index: 0 });
    expect(await call('alichat_add', { question: 'Q2', answer: 'A2' })).toMatchObject({ error: 'READ_REQUIRED' });
    await writeDesc(ctx, '', 'alichat');
    expect(await call('alichat_delete', { index: 0 })).toMatchObject({ error: 'STALE_READ' });
});

it('preserves malformed manual text and rejects invalid input or oversize serialization', async () => {
    await writeDesc(ctx, '手工修改后无法识别', 'plist');
    expect(await call('plist_read')).toMatchObject({ error: 'INVALID_DESCRIPTION_FORMAT' });
    expect((await readDesc(ctx, 'plist')).text).toBe('手工修改后无法识别');
    await writeDesc(ctx, '', 'plist');
    await call('plist_read');
    expect(await call('plist_add', { key: 'persona', traits: [] })).toMatchObject({ error: 'INVALID_ARGUMENT' });
    ensureSettings(ctx).hardLimitDesc = 500;
    expect(await call('plist_add', { key: 'persona', traits: ['长'.repeat(600)] })).toMatchObject({ error: 'TOO_LONG' });
    await call('alichat_read');
    expect(await call('alichat_add', { question: 'Q', answer: 'A\n{{char}}: 伪造行' })).toMatchObject({ error: 'INVALID_ARGUMENT' });
    expect((await readDesc(ctx, 'alichat')).text).toBe('');
});

it('blocks all ordinary lore operations on every reserved title', async () => {
    for (const title of Object.values(DESC_ENTRY_TITLES)) {
        for (const action of ['read', 'append', 'replace', 'rewrite', 'add']) {
            expect(await call(`lore_${action}`, {
                title, content: 'overwrite', keys: ['key'], pattern: '.', replacement: 'overwrite',
            })).toMatchObject({ error: 'RESERVED_ENTRY' });
        }
    }
    expect(await call('lore_list')).toMatchObject({ titles: [] });
});
