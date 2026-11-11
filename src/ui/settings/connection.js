/**
 * ui/settings/connection.js · 「API 连接」组
 *
 * 一个下拉：学习 / 压缩会话走 ST 里哪一份连接配置。
 *
 * 默认「跟随当前设置」——这正是插件一开始唯一的行为，老用户升级后什么都不用改。
 * 指定一份之后，会话改走 ST 的 `ConnectionManagerRequestService`，用的就是那份配置的
 * api / 模型 / 密钥 / 端点。预设不随行——会话的提示词由插件自己编译。
 *
 * 只影响**之后新开的**会话：一场会话开始时读一次 `settings.connectionProfile` 就定死，
 * 中途换路会让同一场里的前后两轮跑到不同模型上。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { listConnectionProfiles } from '../../platform/sillytavern/transport.js';
import { ensureSettings } from '../../features/settings/index.js';
import { byId, paintHint } from './common.js';

const SELECT_ID = 'thrive_connection_profile';
const HINT_ID = 'thrive_connection_hint';

/** 「跟随当前设置」这一项的值。用空串而不是 'default'：设置里存的就是空串 */
const FOLLOW = '';

export function bindConnectionControls() {
    byId(SELECT_ID)?.addEventListener('change', function () {
        const ctx = getContext();
        const settings = ensureSettings(ctx);
        settings.connectionProfile = String(this.value ?? '');
        ctx.saveSettingsDebounced?.();
        // 这一项不影响任何已经画出来的界面，重算提示那一行就够
        syncConnectionControls(ctx, settings);
    });
}

/**
 * 回填下拉：选项跟着 ST 的配置表重建，选中项跟着设置走。
 *
 * 每次刷新都重建：用户可能刚在 ST 里新建 / 删掉一份配置，缓存下来的选项表就会指向
 * 一个不存在的 id。
 *
 * @param {object} ctx
 * @param {object} settings
 */
export function syncConnectionControls(ctx, settings) {
    const select = byId(SELECT_ID);
    if (!select) {
        return;
    }

    const current = String(settings.connectionProfile ?? '');
    const profiles = listConnectionProfiles(ctx);

    const options = [{ id: FOLLOW, name: '跟随当前设置（聊天的那个）' }];
    for (const profile of profiles) {
        options.push({
            id: profile.id,
            name: profile.model ? `${profile.name} · ${profile.model}` : profile.name,
        });
    }

    /*
     * 选中的那份已经不在了（被删 / 换了设备 / 换了 ST 数据目录）。留一个占位项，
     * 别让下拉静默跳回第一项——那样用户以为的"还用着那份配置"是假的。
     */
    const missing = Boolean(current) && !profiles.some(profile => profile.id === current);
    if (missing) {
        options.push({ id: current, name: '（这份配置已经不在了）' });
    }

    select.textContent = '';
    for (const item of options) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.append(option);
    }
    select.value = current;

    paintHint(HINT_ID, describeConnection(ctx, { current, profiles, missing }), missing);
}

/**
 * 提示那一行：只在"此刻需要用户知道点什么"时写字。
 *
 * @param {object} ctx
 * @param {{ current: string, profiles: Array<{id: string}>, missing: boolean }} state
 * @returns {string}
 */
function describeConnection(ctx, { current, profiles, missing }) {
    if (missing) {
        return '选中的连接配置已经不在了：重新选一个，或者改回「跟随当前设置」。在那之前，新开的会话会直接失败。';
    }

    const hasService = typeof ctx?.ConnectionManagerRequestService?.getProfile === 'function';
    if (!hasService && profiles.length === 0) {
        return '这个 SillyTavern 没有「连接配置」扩展，只能用「跟随当前设置」。';
    }

    if (!current) {
        return '';
    }

    // 选定之后补一句"什么时候生效"：这是最容易误解的一点
    return '新开的会话用这一份；已经跑着的那一场不受影响。';
}
