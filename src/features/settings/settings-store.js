import { migrateSettings } from './migrations.js';
/** settings-store.js · Internal settings module; public entry: index.js. */

import { DEFAULT_SETTINGS, MODULE_NAME } from './defaults.js';

import { isPlainObject, normalizeCustomPrompts, normalizeDisabledCards, normalizePromptRoles } from './normalization.js';

/**
 * 补齐 extension_settings.thrive，返回该对象本身（可安全地直接改）。
 * @param {object} ctx getContext() 的返回值
 */
function ensureSettings(ctx) {
    const root = ctx.extensionSettings;

    if (!isPlainObject(root[MODULE_NAME])) {
        root[MODULE_NAME] = {};
    }

    const settings = root[MODULE_NAME];
    let dirty = migrateSettings(settings);

    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        // 用类型比对而不是 undefined 判断：手改过 settings.json 存进去的 "false" 也能被纠正
        if (typeof settings[key] !== typeof fallback) {
            settings[key] = fallback;
            dirty = true;
        }
    }

    /*
     * 三张表按内容规范一遍。它们可能是老版本没有的键、也可能是手改过的半个对象；
     * 返回同一个引用说明没变，不重复落盘。
     */
    for (const [key, normalize] of Object.entries({
        customPrompts: normalizeCustomPrompts,
        disabledCards: normalizeDisabledCards,
        promptRoles: normalizePromptRoles,
    })) {
        const next = normalize(settings[key]);
        if (next !== settings[key]) {
            settings[key] = next;
            dirty = true;
        }
    }

    if (dirty) {
        ctx.saveSettingsDebounced?.();
    }

    return settings;
}

export { ensureSettings };
