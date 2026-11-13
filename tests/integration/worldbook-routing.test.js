import { beforeEach, afterEach, it, expect } from 'vitest';
import { createContext } from '../helpers/context.js';
import { selected_world_info, world_info, setContext } from '../helpers/host.js';
import { getToolDefs } from '../../src/features/tools/index.js';
import {
    getState, getLoreBackups, markLearningRunning, resetReads, setDescStorageMode,
    setDescFormats, setDescriptionBookSetting, setWritableBookSetting,
} from '../../src/features/settings/index.js';
import { getDescriptionBook, getWritableBook } from '../../src/features/memory/target-selection.js';
import { commitDraft, buildDraftView, discardDraft, restoreLoreEntry } from '../../src/features/memory/index.js';
import { getDrafts, summarizeDraft } from '../../src/features/memory/draft.js';

let ctx;
let books;
let writes;
const entry = (uid, comment, content, fields = {}) => ({
    uid, comment, content, key: [comment], constant: false, disable: false, ...fields,
});
const call = (name, args = {}) => getToolDefs().find(tool => tool.name === name).action(args);

beforeEach(() => {
    selected_world_info.length = 0;
    for (const key of Object.keys(world_info)) delete world_info[key];
    books = new Map();
    writes = [];
    ctx = createContext();
    ctx.getWorldInfoNames = () => [...books.keys()];
    ctx.loadWorldInfo = async name => structuredClone(books.get(name) ?? { entries: {} });
    ctx.saveWorldInfo = async (name, data) => {
        writes.push(name);
        books.set(name, structuredClone(data));
    };
    ctx.updateWorldInfoList = async () => {};
    setContext(ctx);
    markLearningRunning({ reason: 'manual' });
});

afterEach(() => {
    markLearningRunning(null);
    setContext(null);
    selected_world_info.length = 0;
    for (const key of Object.keys(world_info)) delete world_info[key];
});

it('defaults both destinations to the character name and keeps selections independent per chat', () => {
    expect(getWritableBook(ctx)).toBe('测试角色');
    expect(getDescriptionBook(ctx)).toBe('测试角色');
    setWritableBookSetting(ctx, '设定库');
    setDescriptionBookSetting(ctx, '人物库');
    setDescStorageMode(ctx, 'worldbook');
    expect(getWritableBook(ctx)).toBe('设定库');
    expect(getDescriptionBook(ctx)).toBe('人物库');
    setDescStorageMode(ctx, 'card');
    expect(getWritableBook(ctx)).toBe('设定库');
    ctx.chatMetadata = {};
    expect(getDescriptionBook(ctx)).toBe('测试角色');
    expect(getWritableBook(ctx)).toBe('测试角色');
});

it('does not create either missing book on any read, then creates each on its first valid write', async () => {
    setDescStorageMode(ctx, 'worldbook');
    setDescFormats(ctx, ['text', 'plist', 'alichat']);
    setDescriptionBookSetting(ctx, '人物库');
    setWritableBookSetting(ctx, '设定库');
    expect(await call('lore_list')).toMatchObject({ ok: true, titles: [] });
    expect(await call('desc_read')).toMatchObject({ ok: true, text: '' });
    expect(await call('plist_read')).toMatchObject({ ok: true, categories: {} });
    expect(await call('alichat_read')).toMatchObject({ ok: true, items: [] });
    expect(writes).toEqual([]);
    expect(await call('lore_add', { title: '北境', content: '寒冷', keys: [] })).toMatchObject({ error: 'NO_KEYS' });
    expect(writes).toEqual([]);
    expect(await call('lore_add', { title: '北境', content: '寒冷', keys: ['北境'] })).toMatchObject({ ok: true });
    expect(await call('desc_append', { text: '温和' })).toMatchObject({ ok: true });
    expect(await call('plist_add', { key: 'persona', traits: ['kind'] })).toMatchObject({ ok: true });
    expect(await call('alichat_add', { question: '性格？', answer: '温和。' })).toMatchObject({ ok: true });
    expect(writes).toEqual(['设定库', '人物库']);
    expect(books.get('人物库').entries).toEqual({});
    expect(books.get('设定库').entries).toEqual({});
    expect(getDrafts(ctx)).toHaveLength(2);
    await commitDraft(ctx);
    expect(Object.values(books.get('人物库').entries).map(item => item.comment))
        .toEqual(['【角色描述】', '【角色描述 · PLists】', '【角色描述 · Ali:Chat】']);
    expect(Object.values(books.get('设定库').entries).map(item => item.comment)).toEqual(['北境']);
});

it('activates configured books before loading and includes global, character, extra, chat and persona books once', async () => {
    for (const [index, name] of ['设定库', '人物库', '全局', '角色', '附加', '聊天', '用户'].entries()) {
        books.set(name, { entries: { 0: entry(0, `条目${index}`, name) } });
    }
    selected_world_info.push('全局', '角色');
    world_info.charLore = [{ name: 'test', extraBooks: ['附加'] }];
    ctx.characters[0].data = { extensions: { world: '角色' } };
    ctx.chatMetadata.world_info = '聊天';
    ctx.powerUserSettings = { persona_description_lorebook: '用户' };
    setDescriptionBookSetting(ctx, '人物库');
    setWritableBookSetting(ctx, '设定库');
    setDescStorageMode(ctx, 'worldbook');
    const load = ctx.loadWorldInfo;
    ctx.loadWorldInfo = async name => {
        if (['设定库', '人物库'].includes(name)) expect(selected_world_info).toContain(name);
        return load(name);
    };
    const list = await call('lore_list');
    expect(list.titles).toHaveLength(7);
    expect(new Set(list.titles).size).toBe(7);
    expect(list).not.toHaveProperty('book');
    expect(list).not.toHaveProperty('books');
    expect(selected_world_info).toEqual(['全局', '角色', '设定库', '人物库']);
    expect(world_info.globalSelect).toBe(selected_world_info);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
    expect(writes).toEqual([]);
});

it('routes all existing-entry edits to their original books after changing the creation destination', async () => {
    books.set('甲', { entries: { 0: entry(0, '北境', '寒冷') } });
    books.set('乙', { entries: { 0: entry(0, '南海', '温暖') } });
    books.set('丙', { entries: {} });
    selected_world_info.push('甲', '乙', '丙');
    setWritableBookSetting(ctx, '丙');
    await call('lore_list');
    await call('lore_read', { title: '北境' });
    setWritableBookSetting(ctx, '乙');
    expect(await call('lore_rewrite', { title: '北境', content: '极寒' })).toMatchObject({ ok: true });
    expect(await call('lore_append', { title: '南海', content: '有岛' })).toMatchObject({ ok: true });
    await call('lore_read', { title: '南海', pattern: '温暖' });
    expect(await call('lore_replace', { title: '南海', pattern: '温暖', replacement: '炎热' })).toMatchObject({ ok: true });
    expect(await call('lore_add', { title: '北境', content: '重复', keys: ['北境'] })).toMatchObject({ error: 'TITLE_EXISTS' });
    expect(await call('lore_add', { title: '雨林', content: '潮湿', keys: ['雨林'] })).toMatchObject({ ok: true });
    expect(writes).toEqual([]);
    expect(summarizeDraft(ctx).touched).toBe(3);
    const view = await buildDraftView(ctx);
    expect(view.changed.map(item => item.book).sort()).toEqual(['乙', '乙', '甲'].sort());
    expect(await commitDraft(ctx)).toMatchObject({ ok: true, written: 3 });
    expect(books.get('甲').entries[0].content).toBe('极寒');
    expect(books.get('乙').entries[0].content).toContain('炎热');
    expect(Object.values(books.get('乙').entries).some(item => item.comment === '雨林')).toBe(true);
    expect(books.get('丙').entries).toEqual({});
});

it('assigns collision-safe aliases across and within books and restores the correct uid', async () => {
    books.set('甲', { entries: { 0: entry(0, '北境', '甲一'), 1: entry(1, '北境', '甲二') } });
    books.set('乙', { entries: { 0: entry(0, '北境', '乙一'), 1: entry(1, '北境 [#1]', '真实带编号的标题') } });
    selected_world_info.push('甲', '乙');
    setWritableBookSetting(ctx, '甲');
    const listed = await call('lore_list');
    expect(new Set(listed.titles).size).toBe(4);
    expect(listed.titles).toContain('北境 [#1]');
    expect(listed.titles).not.toContain('北境');
    for (const title of listed.titles) {
        const read = await call('lore_read', { title });
        expect(read).not.toHaveProperty('book');
        expect(await call('lore_rewrite', { title, content: `${read.content}改` })).toMatchObject({ ok: true });
    }
    expect((await call('lore_list')).titles).toEqual(listed.titles);
    const backup = getLoreBackups(ctx).find(item => item.book === '甲' && item.uid === 1);
    expect(await restoreLoreEntry(ctx, backup)).toMatchObject({ ok: true });
    await commitDraft(ctx);
    expect(books.get('甲').entries[0]).toMatchObject({ comment: '北境', content: '甲一改' });
    expect(books.get('甲').entries[1]).toMatchObject({ comment: '北境', content: '甲二' });
    expect(books.get('乙').entries[0]).toMatchObject({ comment: '北境', content: '乙一改' });
    expect(books.get('乙').entries[1].comment).toBe('北境 [#1]');
});

it('never rebinds an issued alias to a different book when active books change', async () => {
    books.set('甲', { entries: { 0: entry(0, '北境', '甲') } });
    books.set('乙', { entries: { 0: entry(0, '北境', '乙') } });
    setWritableBookSetting(ctx, '甲');
    await call('lore_list');
    setWritableBookSetting(ctx, '乙');
    selected_world_info.splice(0, selected_world_info.length, '乙');
    const listed = await call('lore_list');
    expect(listed.titles).toEqual(['北境 [#1]']);
    expect(await call('lore_append', { title: '北境', content: '错误目标' })).toMatchObject({ error: 'NOT_FOUND' });
    expect(writes).toEqual([]);
});

it('keeps description tools on their selected book even if other active books contain reserved entries', async () => {
    books.set('甲', { entries: { 0: entry(0, '【角色描述】', '错误描述') } });
    books.set('乙', { entries: { 0: entry(0, '【角色描述】', '正确描述'), 1: entry(1, '城市', '沿海') } });
    ctx.characters[0].data = { extensions: { world: '甲' } };
    setDescStorageMode(ctx, 'worldbook');
    setDescriptionBookSetting(ctx, '乙');
    setWritableBookSetting(ctx, '甲');
    expect(await call('desc_read')).toMatchObject({ text: '正确描述' });
    expect(await call('desc_rewrite', { text: '新描述' })).toMatchObject({ ok: true });
    expect((await call('lore_list')).titles).toEqual(['城市']);
    await commitDraft(ctx);
    expect(books.get('甲').entries[0].content).toBe('错误描述');
    expect(books.get('乙').entries[0].content).toBe('新描述');
});

it('preflights conflicts across all drafts and preserves unsaved work on partial I/O failure', async () => {
    for (const name of ['甲', '乙']) books.set(name, { entries: { 0: entry(0, name, '旧') } });
    selected_world_info.push('甲', '乙');
    setWritableBookSetting(ctx, '甲');
    await call('lore_list');
    for (const title of ['甲', '乙']) await call('lore_append', { title, content: '新' });
    books.get('乙').entries[0].content = '外部修改';
    expect(await commitDraft(ctx)).toMatchObject({ error: 'DISK_CHANGED' });
    expect(writes).toEqual([]);
    const save = ctx.saveWorldInfo;
    ctx.saveWorldInfo = async (name, data) => {
        if (name === '乙') throw new Error('offline');
        return save(name, data);
    };
    expect(await commitDraft(ctx, { force: true })).toMatchObject({ error: 'WRITE_FAILED' });
    expect(getDrafts(ctx).map(item => item.book)).toEqual(['乙']);
    expect(getLoreBackups(ctx).filter(item => item.layer === 'draft').map(item => item.book)).toEqual(['乙']);
    discardDraft(ctx);
    expect(books.get('乙').entries[0].content).toBe('外部修改');
});

it('cancels a delayed read when switching chats without registering reads or drafts in the new chat', async () => {
    books.set('测试角色', { entries: { 0: entry(0, '北境', '寒冷') } });
    const load = ctx.loadWorldInfo;
    let release;
    ctx.loadWorldInfo = async name => {
        await new Promise(resolve => { release = resolve; });
        return load(name);
    };
    const pending = call('lore_list');
    ctx.chatMetadata = {};
    release();
    expect(await pending).toMatchObject({ error: 'TOOL_UNAVAILABLE' });
    expect(getState(ctx).reads).toEqual({});
    expect(getState(ctx).draft).toBeNull();
    expect(writes).toEqual([]);
});

it('requires a fresh directory before creating in a newly selected missing destination', async () => {
    await call('lore_list');
    setWritableBookSetting(ctx, '新库');
    expect(await call('lore_add', { title: '北境', content: '寒冷', keys: ['北境'] })).toMatchObject({ error: 'READ_REQUIRED' });
    expect(writes).toEqual([]);
    resetReads(ctx);
    await call('lore_list');
    expect(await call('lore_add', { title: '北境', content: '寒冷', keys: ['北境'] })).toMatchObject({ ok: true });
    expect(writes).toEqual(['新库']);
});
