// Behavior cases promoted from .workbuddy/draft-check.mjs.
import assert from 'node:assert/strict';
import { it as check } from 'vitest';

globalThis.document = { getElementById: () => null, dispatchEvent: () => {} };

const SRC = '../../src/';
const store = await import(`${SRC}store.js`);
const draft = await import(`${SRC}draft.js`);
const targets = await import(`${SRC}targets.js`);

const BOOK = '测试书';
const OTHER = '另一本书';

/* Fake host with independent in-memory worldbooks for each case. */

function entry(uid, comment, content, keys = []) {
    return {
        uid,
        key: keys,
        keysecondary: [],
        comment,
        content,
        constant: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        triggers: [],
    };
}

function makeCtx() {
    const state = {
        disk: {
            [BOOK]: { entries: { 0: entry(0, '北境', '北境在南边。', ['北境']) } },
            [OTHER]: { entries: { 7: entry(7, '南海', '南海有岛。', ['南海']) } },
        },
        writes: 0,
    };

    const ctx = {
        extensionSettings: {},
        chatMetadata: {},
        getCurrentChatId: () => 'chat-1',
        getWorldInfoNames: () => Object.keys(state.disk),
        loadWorldInfo: async name => JSON.parse(JSON.stringify(state.disk[name] ?? { entries: {} })),
        saveWorldInfo: async (name, data) => {
            state.writes += 1;
            state.disk[name] = JSON.parse(JSON.stringify(data));
        },
        updateWorldInfoList: async () => {},
        saveChat: () => {},
        saveSettingsDebounced: () => {},
        __state: state,
    };

    store.ensureSettings(ctx);
    store.getState(ctx).writableBook = BOOK;
    return ctx;
}

/** 一次工具写入：读 → 开缓冲区 → 改 → 写缓冲区（与 tools.js 的调用顺序一致） */
async function write(ctx, mutate) {
    const loaded = await targets.loadWritableBook(ctx);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    draft.ensureDraft(ctx, loaded.book, loaded.data);
    mutate(loaded.data);
    const saved = await targets.persistBook(ctx, loaded.book, loaded.data);
    assert.ok(saved.ok, JSON.stringify(saved));
    return loaded;
}

/* ------------------------------------------------------------------ 用例 */

check('没有缓冲区时，写入直接落盘', async () => {
    const ctx = makeCtx();
    // 不走 ensureDraft：建书、停用描述条目这类"结构动作"本来就直写磁盘
    const loaded = await targets.loadWritableBook(ctx);
    loaded.data.entries['0'].content = '北境在南边，终年积雪。';
    const saved = await targets.persistBook(ctx, loaded.book, loaded.data);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.draft, undefined, '这条路不该进缓冲区');

    assert.equal(ctx.__state.writes, 1);
    assert.equal(ctx.__state.disk[BOOK].entries['0'].content, '北境在南边，终年积雪。');
    assert.equal(draft.getDraft(ctx), null, '落盘这条路不该留下缓冲区');
});

check('第一次写入开缓冲区：磁盘一个字不动', async () => {
    const ctx = makeCtx();
    const before = JSON.parse(JSON.stringify(ctx.__state.disk[BOOK]));

    await write(ctx, data => {
        data.entries['1'] = entry(1, '雪原狼', '雪原狼成群出没。', ['雪原狼']);
    });

    assert.equal(ctx.__state.writes, 0, '写缓冲区不该动磁盘');
    assert.deepEqual(ctx.__state.disk[BOOK], before, '磁盘内容必须原封不动');
    assert.equal(draft.summarizeDraft(ctx).exists, true);
    assert.equal(draft.summarizeDraft(ctx).touched, 1);
});

check('多次追加相互叠加，读也读缓冲区', async () => {
    const ctx = makeCtx();

    await write(ctx, data => {
        data.entries['0'].content = '北境在南边。\n北境没有夏天。';
        data.entries['0'].key = ['北境', '极寒'];
        data.entries['1'] = entry(1, '雪原狼', '雪原狼成群出没。', ['雪原狼']);
    });
    await write(ctx, data => {
        data.entries['0'].content = `${data.entries['0'].content}\n北境人管南边叫下界。`;
    });

    const loaded = await targets.loadBook(ctx, BOOK);
    assert.equal(loaded.draft, true);
    assert.match(loaded.data.entries['0'].content, /没有夏天[\s\S]*下界/);
    assert.deepEqual(loaded.data.entries['0'].key, ['北境', '极寒']);

    // 目录与定位也走缓冲区：新建的那条在缓冲区里查得到
    const listed = await targets.listLore(ctx);
    assert.deepEqual(listed.items.map(item => item.title).sort(), ['北境', '雪原狼'].sort());
});

check('窗口视图：状态、关键词差异与磁盘变动都在', async () => {
    const ctx = makeCtx();

    await write(ctx, data => {
        data.entries['1'] = entry(1, '雪原狼', '雪原狼成群出没。', ['雪原狼', '狼群']);
        data.entries['0'].content = '北境在南边。\n补一句。';
        data.entries['0'].key = ['北境', '极寒'];
    });

    // 用户在世界书编辑器里改了另一条
    ctx.__state.disk[BOOK].entries['0'].content = '北境在南边（手改）。';

    const view = await targets.buildDraftView(ctx);
    assert.equal(view.ok, true);
    assert.equal(view.exists, true);
    assert.equal(view.diskChanged, true, '磁盘在缓冲区开出来之后被动过');
    assert.equal(view.counts.added, 1);

    const wolf = view.items.find(item => item.title === '雪原狼');
    assert.equal(wolf.status, 'added');
    assert.equal(wolf.bufferTouched, true);

    const north = view.items.find(item => item.title === '北境');
    assert.equal(north.status, 'changed');
    assert.deepEqual(north.keys, ['北境', '极寒']);

    // 一条不同的书：当前可写书与缓冲区不一致时视图要能说出来
    store.getState(ctx).writableBook = OTHER;
    const view2 = await targets.buildDraftView(ctx);
    assert.equal(view2.writable, OTHER);
    assert.equal(view2.book, BOOK);
});

check('保存：整本替换、逐条快照、缓冲区清空', async () => {
    const ctx = makeCtx();

    await write(ctx, data => {
        data.entries['1'] = entry(1, '雪原狼', '雪原狼成群出没。', ['雪原狼']);
        data.entries['0'].content = '北境在南边，终年积雪。';
    });

    const result = await targets.commitDraft(ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.written, 2);

    assert.equal(ctx.__state.writes, 1);
    assert.equal(ctx.__state.disk[BOOK].entries['0'].content, '北境在南边，终年积雪。');
    assert.equal(Object.values(ctx.__state.disk[BOOK].entries).some(e => e.comment === '雪原狼'), true);

    assert.equal(draft.getDraft(ctx), null, '保存后缓冲区应当清空');

    const records = store.getLoreBackups(ctx);
    assert.equal(records.length, 2);
    assert.ok(records.every(item => item.layer === 'disk'));
    assert.equal(records.find(item => item.title === '雪原狼').action, 'created');
    assert.equal(records.find(item => item.title === '北境').before, '北境在南边。');
});

check('保存：磁盘被动过时先拒绝，force 才覆盖', async () => {
    const ctx = makeCtx();
    await write(ctx, data => {
        data.entries['0'].content = '缓冲区版本。';
    });

    ctx.__state.disk[BOOK].entries['0'].content = '磁盘手改版。';

    const refused = await targets.commitDraft(ctx);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'DISK_CHANGED');
    assert.equal(ctx.__state.disk[BOOK].entries['0'].content, '磁盘手改版。', '拒绝时一个字都不该写');

    const forced = await targets.commitDraft(ctx, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(ctx.__state.disk[BOOK].entries['0'].content, '缓冲区版本。');
});

check('快照分层：缓冲区里的记录恢复只动缓冲区', async () => {
    const ctx = makeCtx();

    await write(ctx, data => {
        data.entries['0'].content = '缓冲区改过一次。';
    });

    const record = store.rememberLoreBackup(ctx, {
        book: BOOK,
        title: '北境',
        action: 'rewritten',
        layer: draft.layerFor(ctx, BOOK),
        before: '北境在南边。',
        beforeKeys: ['北境'],
    });
    assert.equal(record.layer, 'draft');

    const restored = await targets.restoreLoreEntry(ctx, store.findLoreBackup(ctx, record.id));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(ctx.__state.writes, 0, '恢复缓冲区里的写入不该落盘');

    const loaded = await targets.loadBook(ctx, BOOK);
    assert.equal(loaded.data.entries['0'].content, '北境在南边。');
});

check('快照分层：跨层一律拒绝', async () => {
    const ctx = makeCtx();

    // 磁盘层记录 + 缓冲区开着 → DRAFT_ACTIVE
    const diskRecord = store.rememberLoreBackup(ctx, {
        book: BOOK,
        title: '北境',
        action: 'rewritten',
        layer: 'disk',
        before: '更早的版本。',
        beforeKeys: ['北境'],
    });
    await write(ctx, data => {
        data.entries['0'].content = '缓冲区版本。';
    });

    const blocked = await targets.restoreLoreEntry(ctx, store.findLoreBackup(ctx, diskRecord.id));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'DRAFT_ACTIVE');

    // 缓冲区层记录 + 缓冲区没了 → DRAFT_GONE
    const draftRecord = store.rememberLoreBackup(ctx, {
        book: BOOK,
        title: '北境',
        action: 'rewritten',
        layer: 'draft',
        before: '缓冲区上一版。',
        beforeKeys: ['北境'],
    });
    // 直接清掉缓冲区（不走 discardDraft：那会把这条记录一起收掉），
    // 模拟"记录还在、目标层没了"的坏状态，防御分支要能挡住
    draft.clearDraft(ctx);

    const gone = await targets.restoreLoreEntry(ctx, store.findLoreBackup(ctx, draftRecord.id));
    assert.equal(gone.ok, false);
    assert.equal(gone.error, 'DRAFT_GONE');
});

check('丢弃：磁盘不动，缓冲区那层的记录一并收掉', async () => {
    const ctx = makeCtx();
    const before = JSON.parse(JSON.stringify(ctx.__state.disk[BOOK]));

    await write(ctx, data => {
        data.entries['0'].content = '不要了。';
    });
    store.rememberLoreBackup(ctx, {
        book: BOOK, title: '北境', action: 'rewritten', layer: 'draft', before: '旧', beforeKeys: ['北境'],
    });

    assert.equal(targets.discardDraft(ctx).ok, true);
    assert.equal(ctx.__state.writes, 0);
    assert.deepEqual(ctx.__state.disk[BOOK], before);
    assert.equal(draft.getDraft(ctx), null);
    assert.equal(store.getLoreBackups(ctx).some(item => item.layer === 'draft'), false);
});

check('缓冲区只属于一本书：写另一本会被挡住', async () => {
    const ctx = makeCtx();
    await write(ctx, data => {
        data.entries['0'].content = '缓冲区版本。';
    });

    const loaded = await targets.loadWritableBook(ctx);
    const blocked = draft.ensureDraft(ctx, OTHER, loaded.data);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'DRAFT_BOOK');

    // 读不受影响：另一本书照样读得到磁盘
    const other = await targets.loadBook(ctx, OTHER);
    assert.equal(other.ok, true);
    assert.equal(other.data.entries['7'].comment, '南海');
});

check('写入被拒时不留空缓冲区', async () => {
    const ctx = makeCtx();
    const loaded = await targets.loadWritableBook(ctx);
    const opened = draft.ensureDraft(ctx, loaded.book, loaded.data);
    assert.equal(opened.created, true);

    // 模拟一次超长被拒
    const tooLong = await targets.replaceLoreEntry(ctx, loaded.book, loaded.data, targets.findLoreEntry(loaded.data, '北境'), 'x'.repeat(2000), { hardLimit: 1200 });
    assert.equal(tooLong.error, 'TOO_LONG');

    assert.equal(draft.rollbackEmptyDraft(ctx), true);
    assert.equal(draft.getDraft(ctx), null, '一条都没写成的缓冲区应当撤掉');
});

check('指纹只算工具会改的字段', async () => {
    const base = { entries: { 0: entry(0, '北境', '正文', ['k']) } };
    const same = JSON.parse(JSON.stringify(base));
    same.entries['0'].order = 999;
    same.entries['0'].position = 2;

    assert.equal(draft.hashEntries(base.entries), draft.hashEntries(same.entries), 'order / position 不算改动');

    same.entries['0'].content = '别的正文';
    assert.notEqual(draft.hashEntries(base.entries), draft.hashEntries(same.entries));
});


