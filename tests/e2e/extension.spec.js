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

test('shows write destinations beside learning mode and closes both windows with X', async ({ page }, testInfo) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await expect(panel.locator('.thrive-modes__destination > span')).toHaveText(['角色：测试角色（角色卡）', '世界书：未选择']);
    await expect(panel.locator('[data-thrive-action="toggle-more"] .thrive-panel__meta')).toHaveCount(0);
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await panel.locator('[data-thrive-field="storage"]').selectOption('worldbook');
    await expect(panel.locator('.thrive-modes__destination > span')).toHaveText(['角色：测试角色（世界书条目）', '世界书：测试角色']);
    await expect(panel.locator('.thrive-panel__section-title', { hasText: '角色描述 · 世界书条目' })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => panel.locator('.thrive-modes__row').evaluate(row => {
        const mode = row.querySelector('.thrive-mode').getBoundingClientRect();
        const destination = row.querySelector('.thrive-modes__destination').getBoundingClientRect();
        return Math.abs(mode.width - destination.width);
    })).toBeLessThan(1);
    const lines = panel.locator('.thrive-modes__destination > span');
    const characterBox = await lines.nth(0).boundingBox();
    const bookBox = await lines.nth(1).boundingBox();
    expect(bookBox.y).toBeGreaterThanOrEqual(characterBox.y + characterBox.height - 1);
    await panel.screenshot({ path: testInfo.outputPath('learning-destinations-mobile.png') });
    await panel.locator('[data-thrive-action="open-teach"]').click();
    const teach = page.locator('#thrive_teach');
    await teach.locator('[data-field="teach-text"]').fill('保留草稿');
    await expect(teach.getByRole('button', { name: '关闭', exact: true })).toHaveText('X');
    await teach.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(teach).toBeHidden();
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await expect(teach.locator('[data-field="teach-text"]')).toHaveValue('保留草稿');
    await teach.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(panel.getByRole('button', { name: '关闭面板' })).toHaveText('X');
    await panel.getByRole('button', { name: '关闭面板' }).click();
    await expect(panel).toBeHidden();
    await page.locator('#thrive_badge').click();
    await expect(panel).toBeVisible();
});

test('saves and cancels custom prompts while keeping the target block last', async ({ page }) => {
    await page.locator('#thrive_prompt_open').click();
    const editor = page.locator('#thrive_prompts');
    await expect(editor).toBeVisible();
    await editor.locator('[data-act="add"]').click();
    await editor.locator('[data-field="name"]').fill('自建规则');
    await editor.locator('[data-field="text"]').fill('保留北境的设定');
    await editor.locator('[data-act="save"]').click();
    await expect(editor.locator('.thrive-prompts__name', { hasText: '自建规则' })).toBeVisible();
    expect(await editor.locator('[data-prompt]').evaluateAll(nodes => nodes.slice(-3).map(node => node.dataset.prompt)))
        .toEqual(['targetDesc', 'target', 'targetEnd']);
    await editor.locator('[data-act="add"]').click();
    await editor.locator('[data-act="cancel"]').click();
    expect(await page.evaluate(() => window.__host.state.extensionSettings.thrive.customPrompts.length)).toBe(1);
    await editor.locator('[data-fold="tools"] summary').click();
    await expect(editor.locator('[data-tool]')).toHaveCount(10);
});

test('learns from instructions without history or advancing the chat baseline', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    await page.evaluate(() => { window.__host.state.chatMetadata.thrive.learn.baseline = 7; });
    await page.locator('[data-thrive-action="open-teach"]').click();
    await page.locator('[data-field="teach-history"]').uncheck();
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
    expect(result.request.messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringMatching(/^雾港是一座海边城市。\n/),
    });
    expect(result.request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))
        .not.toContain('北境在南边');
    expect(result.chat).toHaveLength(2);
    expect(result.chat.some(message => message.role === 'tool')).toBe(false);
});

test('combines history and instructions in a private session with the requested message order', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await expect(panel.locator('.thrive-learn__go')).toHaveCount(1);
    await expect(panel.locator('.thrive-learn__go')).toHaveText('立即学习');
    await page.evaluate(() => {
        window.__host.state.extensionSettings.thrive.learningTask = '学习时发送的内容';
        window.__host.state.chatMetadata.thrive.learn.baseline = 7;
    });
    await panel.locator('[data-thrive-action="open-teach"]').click();
    const dialog = page.getByRole('dialog', { name: '立即学习', exact: true });
    await expect(dialog.locator('[data-field="teach-history"]')).toBeChecked();
    await dialog.locator('[data-field="teach-text"]').fill('只整理{{char}}的地点设定');
    await expect.poll(() => page.evaluate(() => window.__host.state.requests.length)).toBe(0);
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.ok)).toBe(true);
    const result = await page.evaluate(() => ({
        baseline: window.__host.state.chatMetadata.thrive.learn.baseline,
        messages: window.__host.state.requests[0].messages,
        chat: window.__host.state.chat,
    }));
    expect(result.baseline).toBe(2);
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: '只整理测试角色的地点设定\n学习时发送的内容' });
    const presetText = result.messages.slice(0, -1).map(message => message.content).join('\n');
    expect(presetText).toContain('北境在南边。');
    expect(presetText).not.toContain('只整理');
    expect(result.chat).toHaveLength(2);
});

test('warns and blocks every learning entry without a description format, then resumes after selection', async ({ page }, testInfo) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await panel.locator('[data-thrive-field="storage"]').selectOption('worldbook');
    await page.evaluate(() => {
        window.__formatWarnings = [];
        window.toastr = { warning: message => window.__formatWarnings.push(message) };
        window.__host.state.chatMetadata.thrive.learn.baseline = 7;
        window.__host.state.chatMetadata.thrive.learn.lastHash = 'original-hash';
    });
    await panel.locator('[data-thrive-field="format-text"]').uncheck();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.descFormats)).toEqual([]);
    await expect(panel.getByRole('alert')).toContainText('所有学习均不生效');
    await expect.poll(() => page.evaluate(() => window.__formatWarnings.length)).toBe(1);
    expect(await page.evaluate(() => window.__formatWarnings[0])).toContain('至少选择一种');
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.screenshot({ path: testInfo.outputPath('no-description-format-warning-mobile.png') });
    await panel.locator('[data-thrive-action="open-teach"]').click();
    const dialog = page.getByRole('dialog', { name: '立即学习', exact: true });
    await dialog.locator('[data-field="teach-history"]').uncheck();
    await dialog.locator('[data-field="teach-text"]').fill('将雾港写入世界书');
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-field="teach-text"]')).toHaveValue('将雾港写入世界书');
    const blocked = await page.evaluate(async () => {
        const ctx = window.__host.getContext();
        ctx.chatMetadata.thrive.enabled = true;
        ctx.extensionSettings.thrive.learnKeywords = '北境';
        const commandResult = window.__host.state.commands.get('thrive')({}, 'learn');
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, 1);
        return {
            commandResult,
            status: window.__host.state.commands.get('thrive')({}, 'status'),
            requests: window.__host.state.requests.length,
            baseline: ctx.chatMetadata.thrive.learn.baseline,
            hash: ctx.chatMetadata.thrive.learn.lastHash,
        };
    });
    expect(blocked).toMatchObject({
        commandResult: expect.stringContaining('所有学习均不生效'),
        status: expect.stringContaining('学习不生效'),
        requests: 0,
        baseline: 7,
        hash: 'original-hash',
    });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await panel.locator('[data-thrive-field="format-plist"]').check();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await dialog.locator('[data-act="teach-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.ok)).toBe(true);
    const request = await page.evaluate(() => window.__host.state.requests[0]);
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/^将雾港写入世界书\n/) });
    expect(request.payload.tools.some(tool => tool.function.name.startsWith('plist_'))).toBe(true);
    expect(await page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.baseline)).toBe(7);
});

test('stops active and queued learning when the last format is removed and warns on inactive card selections', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await panel.locator('[data-thrive-field="storage"]').selectOption('worldbook');
    await page.evaluate(() => {
        window.__host.state.holdRequests = true;
        window.__formatWarnings = [];
        window.toastr = { warning: message => window.__formatWarnings.push(message) };
    });
    const dialog = page.getByRole('dialog', { name: '立即学习', exact: true });
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await dialog.locator('[data-act="teach-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.requests.length)).toBe(1);
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(panel.locator('.thrive-learn__queue')).toHaveText('排队 1');
    await panel.locator('[data-thrive-field="format-text"]').uncheck();
    await expect(panel.getByRole('alert')).toContainText('所有学习均不生效');
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.stopped)).toBe('aborted');
    await expect(panel.locator('.thrive-learn__queue')).toHaveCount(0);
    expect(await page.evaluate(() => window.__host.state.requests.length)).toBe(1);
    await panel.locator('[data-thrive-field="format-plist"]').check();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await panel.locator('[data-thrive-field="storage"]').selectOption('card');
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeChecked();
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeDisabled();
    await expect(panel.getByRole('alert')).toContainText('角色卡存储需勾选自然文本');
    expect(await page.evaluate(() => window.__formatWarnings.length)).toBe(2);
    await panel.locator('[data-thrive-field="format-text"]').check();
    await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('keeps pasted images and the history choice in drafts and supports image-only learning', async ({ page }, testInfo) => {
    await page.locator('#thrive_badge').click();
    await page.locator('[data-thrive-action="open-teach"]').click();
    const dialog = page.getByRole('dialog', { name: '立即学习', exact: true });
    await dialog.locator('[data-field="teach-history"]').uncheck();
    await dialog.locator('[data-field="teach-text"]').evaluate(area => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([bytes], '人物.png', { type: 'image/png' }));
        area.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await expect(dialog.locator('.thrive-teach__thumb')).toHaveCount(1);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('[data-thrive-action="open-teach"]').click();
    await expect(dialog.locator('.thrive-teach__thumb')).toHaveCount(1);
    await expect(dialog.locator('[data-field="teach-history"]')).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.screenshot({ path: testInfo.outputPath('immediate-learning-mobile.png') });
    await dialog.locator('[data-field="teach-text"]').press('Control+Enter');
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.ok)).toBe(true);
    const message = await page.evaluate(() => window.__host.state.requests[0].messages.at(-1));
    expect(message.role).toBe('user');
    expect(message.content.map(part => part.type)).toEqual(['text', 'image_url']);
    await page.locator('[data-thrive-action="open-teach"]').click();
    await expect(dialog.locator('.thrive-teach__thumb')).toHaveCount(0);
});

test('retains invalid drafts, queues from the unified entry and stops both active and queued learning', async ({ page }) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await panel.locator('[data-thrive-action="open-teach"]').click();
    const dialog = page.getByRole('dialog', { name: '立即学习', exact: true });
    await dialog.locator('[data-field="teach-history"]').uncheck();
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.__host.state.requests.length)).toBe(0);
    await dialog.locator('[data-field="teach-text"]').fill('长'.repeat(6001));
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(dialog.locator('[data-field="teach-text"]')).toHaveValue('长'.repeat(6001));
    expect(await page.evaluate(() => window.__host.state.requests.length)).toBe(0);
    await dialog.locator('[data-act="teach-clear"]').click();
    await expect(dialog.locator('[data-field="teach-history"]')).not.toBeChecked();
    await dialog.locator('[data-field="teach-history"]').check();
    await page.evaluate(() => { window.__host.state.holdRequests = true; });
    await dialog.locator('[data-act="teach-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.requests.length)).toBe(1);
    await expect(panel.locator('[data-thrive-action="stop-learn"]')).toBeVisible();
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await dialog.locator('[data-field="teach-history"]').uncheck();
    await dialog.locator('[data-field="teach-text"]').fill('下一场指令');
    await dialog.locator('[data-act="teach-start"]').click();
    await expect(panel.locator('.thrive-learn__queue')).toHaveText('排队 1');
    await panel.locator('[data-thrive-action="stop-learn"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.stopped)).toBe('aborted');
    await expect(panel.locator('.thrive-learn__queue')).toHaveCount(0);
    expect(await page.evaluate(() => window.__host.state.requests.length)).toBe(1);
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

test('selects per-chat formats and only sends their tools and editable mandatory usage cards', async ({ page }, testInfo) => {
    await page.locator('#thrive_badge').click();
    const panel = page.locator('#thrive_panel');
    await panel.locator('[data-thrive-action="toggle-more"]').click();
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeDisabled();
    await panel.locator('[data-thrive-field="storage"]').selectOption('worldbook');
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeEnabled();
    await panel.locator('[data-thrive-field="format-text"]').uncheck();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.descFormats)).toEqual([]);
    await panel.locator('[data-thrive-field="format-plist"]').check();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.descFormats)).toEqual(['plist']);
    await panel.locator('[data-thrive-field="format-alichat"]').check();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.descFormats)).toEqual(['plist', 'alichat']);
    expect(await page.evaluate(() => Object.values(window.__host.state.books['测试角色'].entries).map(entry => [entry.comment, entry.disable])))
        .toEqual([['【角色描述】', true], ['【角色描述 · PLists】', false], ['【角色描述 · Ali:Chat】', false]]);
    await panel.screenshot({ path: testInfo.outputPath('description-formats-panel.png') });

    await page.locator('#thrive_prompt_open').click();
    const editor = page.locator('#thrive_prompts');
    for (const id of ['descText', 'descPList', 'descAliChat']) {
        await expect(editor.locator(`[data-prompt="${id}"] [data-act="toggle"]`)).toHaveCount(0);
    }
    await editor.locator('[data-prompt="descPList"] [data-act="edit"]').click();
    await editor.locator('[data-field="text"]').fill('PLists 仅记录简短、稳定的人物属性。');
    await expect(editor.locator('[data-act="delete"]')).toHaveCount(0);
    await editor.locator('[data-act="save"]').click();
    await editor.locator('[data-fold="tools"] summary').click();
    await expect(editor.locator('[data-tool^="desc_"]')).toHaveCount(0);
    await expect(editor.locator('[data-tool^="plist_"]')).toHaveCount(4);
    await expect(editor.locator('[data-tool^="alichat_"]')).toHaveCount(4);
    await editor.screenshot({ path: testInfo.outputPath('description-format-prompts.png') });
    await editor.locator('[data-act="close"]').click();
    await panel.locator('[data-thrive-action="open-teach"]').click();
    await page.locator('[data-act="teach-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__host.state.chatMetadata.thrive.learn.lastRun?.ok)).toBe(true);
    const request = await page.evaluate(() => window.__host.state.requests[0]);
    const names = request.payload.tools.map(tool => tool.function.name);
    expect(names.filter(name => name.startsWith('desc_'))).toEqual([]);
    expect(names).toHaveLength(14);
    const systemText = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    expect(systemText).toContain('PLists 仅记录简短、稳定的人物属性。');
    expect(systemText).toContain('Ali:Chat');
    expect(systemText).not.toContain('自然文本');

    await panel.locator('[data-thrive-field="storage"]').selectOption('card');
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeDisabled();
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeChecked();
    expect(await page.evaluate(() => Object.values(window.__host.state.books['测试角色'].entries).every(entry => entry.disable))).toBe(true);
    await panel.locator('[data-thrive-field="storage"]').selectOption('worldbook');
    await expect(panel.locator('[data-thrive-field="format-plist"]')).toBeEnabled();
    await page.evaluate(() => window.__host.changeChat('formats-chat-2'));
    await expect(panel.locator('[data-thrive-field="format-text"]')).toBeChecked();
    expect(await page.evaluate(() => window.__host.state.chatMetadata.thrive.descFormats)).toEqual(['text']);
});
