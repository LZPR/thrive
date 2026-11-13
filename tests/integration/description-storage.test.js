// Current storage scenarios from .workbuddy/desc-tests: no legacy global tool registration.
import { it, expect } from 'vitest';
import { createContext } from '../helpers/context.js';
import { ensureSettings, getState, getDescFormats, getActiveDescFormats, setDescFormats, setDescStorageMode } from '../../src/features/settings/index.js';
import { ensureDescEntry, readDesc, readDescription, syncDescEntries, writeDesc } from '../../src/features/memory/desc.js';
import { commitDraft, listLore, findLoreEntry } from '../../src/features/memory/index.js';
import { scanCompressTargets, saveManualEdit } from '../../src/features/memory/compress.js';
import { DESC_ENTRY_TITLE, DESC_ENTRY_TITLES } from '../../src/features/memory/desc-entry.js';

function host() {
    const ctx = createContext({ metadata: { thrive: { descStorage: 'worldbook' } } });
    const books = new Map();
    ctx.getWorldInfoNames = () => [...books.keys()];
    ctx.loadWorldInfo = async name => structuredClone(books.get(name) ?? { entries: {} });
    ctx.saveWorldInfo = async (name, data) => books.set(name, structuredClone(data));
    ctx.updateWorldInfoList = async () => {};
    return { ctx, books };
}

it('creates the reserved description entry, stages edits and hides it from lore tools', async () => {
    const { ctx, books } = host();
    expect(await readDescription(ctx)).toMatchObject({ ok: true, missing: true, text: '' });
    expect(await ensureDescEntry(ctx)).toMatchObject({ ok: true, created: true });
    const book = books.get('测试角色');
    expect(Object.values(book.entries)[0]).toMatchObject({
        comment: DESC_ENTRY_TITLE, constant: true, disable: false, content: '', key: [],
    });
    expect(await writeDesc(ctx, '喜欢喝茶')).toMatchObject({ ok: true });
    expect(Object.values(books.get('测试角色').entries)[0].content).toBe('');
    expect(await readDescription(ctx)).toMatchObject({ text: '喜欢喝茶' });
    expect((await listLore(ctx)).items).toEqual([]);
    expect(findLoreEntry(getState(ctx).draft, DESC_ENTRY_TITLE)).toBeNull();
    expect(await commitDraft(ctx)).toMatchObject({ ok: true });
    expect(Object.values(books.get('测试角色').entries)[0].content).toBe('喜欢喝茶');
    expect(ctx.characters[0].description).toBe('原始描述');
});

it('stores each format in its own reserved entry and preserves draft/disk separation', async () => {
    const { ctx, books } = host();
    ctx.characters[0].avatar = 'formats.png';
    await syncDescEntries(ctx, ['text', 'plist', 'alichat']);
    expect(Object.values(books.get('测试角色').entries).map(entry => entry.comment)).toEqual(Object.values(DESC_ENTRY_TITLES));
    await writeDesc(ctx, '[persona: kind]', 'plist');
    await writeDesc(ctx, '<START>\n{{user}}: Name?\n{{char}}: Eden.', 'alichat');
    expect((await readDesc(ctx)).text).toBe('');
    expect((await readDesc(ctx, 'plist')).text).toBe('[persona: kind]');
    expect((await listLore(ctx)).items).toEqual([]);
    expect(Object.values(books.get('测试角色').entries).every(entry => entry.content === '')).toBe(true);
    await commitDraft(ctx);
    await syncDescEntries(ctx, ['alichat']);
    const entries = Object.values(books.get('测试角色').entries);
    expect(entries.map(entry => entry.disable)).toEqual([true, true, false]);
    expect(entries[1].content).toBe('[persona: kind]');
    await syncDescEntries(ctx, ['plist', 'alichat']);
    expect((await readDesc(ctx, 'plist')).text).toBe('[persona: kind]');
});

it('normalizes selections per chat and only activates structured formats in worldbook mode', () => {
    const ctx = createContext();
    expect(getDescFormats(ctx)).toEqual(['text']);
    setDescFormats(ctx, ['alichat', 'plist', 'plist', 'unknown']);
    expect(getDescFormats(ctx)).toEqual(['plist', 'alichat']);
    expect(getActiveDescFormats(ctx)).toEqual([]);
    setDescStorageMode(ctx, 'worldbook');
    expect(getActiveDescFormats(ctx)).toEqual(['plist', 'alichat']);
    ctx.chatMetadata = {};
    expect(getDescFormats(ctx)).toEqual(['text']);
    setDescFormats(ctx, []);
    expect(getDescFormats(ctx)).toEqual([]);
});

it('keeps using an explicitly selected description book after a character rename', async () => {
    const { ctx, books } = host();
    ctx.characters[0].avatar = 'renamed.png';
    getState(ctx).descriptionBook = '旧名字';
    ctx.characters[0].data = { extensions: { world: '旧名字' } };
    books.set('旧名字', { entries: {
        3: { uid: 3, comment: DESC_ENTRY_TITLE, content: '旧书里的描述', constant: true, disable: false },
    } });
    expect(await readDescription(ctx)).toMatchObject({ ok: true, book: '旧名字', text: '旧书里的描述' });
    expect(await writeDesc(ctx, '改名后的描述')).toMatchObject({ ok: true, book: '旧名字' });
    expect(books.has('测试角色')).toBe(false);
});

it('lists the reserved entry once in compression and saves manual compression into the draft', async () => {
    const { ctx, books } = host();
    ctx.characters[0].avatar = 'compress.png';
    const settings = ensureSettings(ctx);
    settings.softLimitDesc = 100;
    await writeDesc(ctx, '长'.repeat(150));
    await commitDraft(ctx);
    const snapshot = await scanCompressTargets(ctx, settings);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ kind: 'desc', chars: 150 });
    expect(await saveManualEdit(ctx, snapshot.items[0], '压缩后的描述')).toMatchObject({ ok: true });
    expect((await readDescription(ctx)).text).toBe('压缩后的描述');
    expect(Object.values(books.get('测试角色').entries)[0].content).toHaveLength(150);
    expect(ctx.characters[0].description).toBe('原始描述');
});
