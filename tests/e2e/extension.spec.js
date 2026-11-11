import { test, expect } from '@playwright/test';

const prefix = '/scripts/extensions/third-party/thrive';
const browserErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
    const errors = [];
    browserErrors.set(page, errors);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') {
            errors.push(message.text());
        }
    });
    await page.goto('/');
    await expect.poll(async () => {
        expect(errors).toEqual([]);
        return page.evaluate(() => Boolean(window.__thriveReady));
    }).toBe(true);
    await expect(page.locator('#thrive_settings')).toBeVisible();
    await expect(page.locator('#thrive_badge')).toBeVisible();
});

test.afterEach(async ({ page }) => {
    expect(browserErrors.get(page)).toEqual([]);
});

test('boots the real extension entry and toggles the panel with mouse and keyboard', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    await expect(page.locator('#thrive_panel')).toBeVisible();
    await page.locator('[data-thrive-action="toggle-learn"]').click();
    expect(await page.evaluate(() => window.__host.state.chatMetadata.thrive.enabled)).toBe(true);
    await page.locator('#thrive_badge').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#thrive_panel')).toBeHidden();
});

test('saves and cancels custom prompts while keeping the target card last', async ({ page }) => {
    await page.locator('#thrive_prompt_open').click();
    const editor = page.locator('#thrive_prompts');
    await expect(editor).toBeVisible();
    await editor.locator('[data-act="add"]').click();
    await editor.locator('[data-field="name"]').fill('自建规则');
    await editor.locator('[data-field="text"]').fill('保留北境的设定');
    await editor.locator('[data-act="save"]').click();
    await expect(editor.locator('.thrive-prompts__name', { hasText: '自建规则' })).toBeVisible();
    await expect(editor.locator('[data-prompt]').last()).toHaveAttribute('data-prompt', 'target');
    await editor.locator('[data-act="add"]').click();
    await editor.locator('[data-act="cancel"]').click();
    expect(await page.evaluate(() => window.__host.state.extensionSettings.thrive.customPrompts.length)).toBe(1);
    await editor.locator('[data-fold="tools"] summary').click();
    await expect(editor.locator('[data-tool]')).toHaveCount(10);
});

test('Professor uses a private session without advancing the chat baseline', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    await page.evaluate(() => { window.__host.state.chatMetadata.thrive.learn.baseline = 7; });
    await page.locator('[data-thrive-action="open-teach"]').click();
    await page.locator('[data-field="teach-text"]').fill('雾港是一座海边城市。');
    await page.locator('[data-act="teach-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.ok)).toBe(true);
    const result = await page.evaluate(() => ({
        baseline: window.__host.state.chatMetadata.thrive.learn.baseline,
        request: window.__host.state.requests[0],
        chat: window.__host.state.chat,
    }));
    expect(result.baseline).toBe(7);
    expect(result.request.includePreset).toBe(false);
    expect(result.request.payload.tools).toHaveLength(10);
    expect(result.chat).toHaveLength(2);
    expect(result.chat.some(message => message.role === 'tool')).toBe(false);
});

test('chat changes stop the running session and clear the in-memory queue', async ({ page }) => {
    const queued = await page.evaluate(async base => {
        const learning = await import(`${base}/src/features/learning/learning.js`);
        window.__host.state.holdRequests = true;
        const ctx = window.__host.getContext();
        const started = learning.startLearning(ctx);
        const queued = learning.startLearning(ctx);
        window.__learningRun = started.promise;
        return queued.queued;
    }, prefix);
    expect(queued).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__host.state.requests.length)).toBe(1);
    const result = await page.evaluate(async base => {
        const learning = await import(`${base}/src/features/learning/learning.js`);
        await window.__host.changeChat('chat-2');
        await window.__learningRun;
        return { remaining: learning.getLearningQueue().length, running: learning.isLearningRunning() };
    }, prefix);
    expect(result).toEqual({ remaining: 0, running: false });
});

test('renders pending description diffs and discards them through the panel', async ({ page }) => {
    await page.evaluate(async base => {
        const patch = await import(`${base}/src/features/memory/patch.js`);
        patch.stagePatch(window.__host.getContext(), { before: '原始描述', after: '<b>新的描述</b>' });
    }, prefix);
    const panel = page.locator('#thrive_panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('<b>新的描述</b>');
    await expect(panel.locator('b', { hasText: '新的描述' })).toHaveCount(0);
    await panel.locator('[data-thrive-action="discard"]').click();
    expect(await page.evaluate(() => window.__host.state.characters[0].description)).toBe('原始描述');
});

test('saves a buffered worldbook only after the explicit UI save', async ({ page }) => {
    await page.evaluate(async base => {
        const store = await import(`${base}/src/features/settings/index.js`);
        const tools = await import(`${base}/src/features/tools/index.js`);
        const ctx = window.__host.getContext();
        store.setWritableBookSetting(ctx, '测试书');
        store.markLearningRunning({ reason: 'manual' });
        try {
            const defs = tools.getToolDefs();
            await defs.find(tool => tool.name === 'lore_list').action({});
            await defs.find(tool => tool.name === 'lore_add').action({ title: '北境', content: '北境在南边', keys: ['北境'] });
        } finally {
            store.markLearningRunning(null);
        }
    }, prefix);
    expect(await page.evaluate(() => window.__host.state.writes)).toBe(0);
    await page.locator('#thrive_badge').click();
    await page.locator('[data-thrive-action="open-draft"]').click();
    const draft = page.locator('#thrive_draft');
    await expect(draft).toContainText('北境');
    await draft.locator('[data-act="save"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.writes)).toBe(1);
    expect(await page.evaluate(() => Object.values(window.__host.state.books['测试书'].entries)[0].comment)).toBe('北境');
});
