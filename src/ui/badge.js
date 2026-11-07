/**
 * ui/badge.js · 输入框旁的状态徽章
 *
 * 徽章只干一件事：开关浮动面板。它不知道面板长什么样、也不知道怎么切换模式，
 * 点击只是发一个 PANEL_TOGGLE_EVENT（见 events.js）——面板那边自己接。
 *
 * 状态全靠图标本身：强调色 = 主动开着，Em 色 = 只有被动开着，「待学」让图标呼吸；
 * 具体文案在 tooltip 与面板里。
 */

import { getContext } from '../../../../../extensions.js';
import { getCompressSnapshot } from '../compress.js';
import { formatDiagnosis } from '../diagnostics.js';
import { PASSIVE_EVENT, notifyPanelToggle } from '../events.js';
import { describePending, intervalProgress, parseKeywords } from '../passive.js';
import { getPatch, isUnresolved } from '../patch.js';
import { getPending, hasAnyModule, isEnabled } from '../store.js';
import { refreshBadgeOnly, registerSurfaces } from './refresh.js';
import { BADGE_ID, LOG, PANEL_ID, isPanelOpen, toast } from './shared.js';

/**
 * 徽章 = 一个方块图标 + 待确认计数，只作为浮动面板的开关。
 *
 * 为什么把「主动 / 被动」两段从这里拿掉：它们挤在输入框旁边，宽度随文字变，和 ST 那一排
 * 固定尺寸的方块按钮站不到一起；而且 #leftSendForm 是 flex 容器，徽章会跟着一起被拉高。
 *
 * 状态也不再用额外的点/圈去画——35px 的方块里塞什么都显脏。图标颜色本身就是状态
 * （强调色 = 主动开着，Em 色 = 只有被动开着），「待学」让图标整体呼吸，
 * 具体文案都在面板里，点一下就看见。
 */
const BADGE_HTML = `
<div id="thrive_badge" class="thrive-badge interactable" role="button" tabindex="0"
    aria-controls="${PANEL_ID}" aria-expanded="false" aria-label="学习模式：打开面板">
    <i class="fa-solid fa-graduation-cap thrive-badge__icon" aria-hidden="true"></i>
    <span class="thrive-badge__count displayNone" aria-hidden="true"></span>
</div>`;

/* ------------------------------------------------------------------ 徽章 */

/**
 * 挂载状态徽章。重复调用安全。
 *
 * 徽章只做一件事：开关面板。键盘 Enter / 空格等价于点一下。
 */
export function initBadge() {
    const host = document.getElementById('leftSendForm');
    if (!host) {
        console.warn(`${LOG} 找不到 #leftSendForm，徽章未挂载`);
        return;
    }

    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
        host.insertAdjacentHTML('afterbegin', BADGE_HTML);
        badge = document.getElementById(BADGE_ID);
    }
    if (!badge) {
        console.warn(`${LOG} 徽章节点创建失败`);
        return;
    }

    badge.addEventListener('click', onBadgeClick);

    badge.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        onBadgeClick(event);
    });

    /*
     * 被动学习挂上 / 结算时，徽章要立刻跟着变，并且弹一条说明。
     *
     * 走事件而不是让 passive.js 直接调这里：触发发生在"发消息""收到回复"两个
     * 用户没在操作界面的时刻，如果只在评估完刷一次界面，徽章会停在旧状态，
     * 用户看不到"下一轮会临时学习"这件事——而这正是最需要提示的地方。
     */
    document.addEventListener(PASSIVE_EVENT, event => {
        const detail = event?.detail ?? {};
        refreshBadgeOnly(getContext());

        if (detail.fired) {
            const why = describePending({ reason: detail.reason, keyword: detail.keyword });
            toast(`被动学习已触发（${why}）：下一轮对话临时开启学习模式，回复结束后自动关闭`);
        }
    });
}

/**
 * 徽章点击：开 / 关面板。
 *
 * 这里**不做任何守卫**：环境不可用时更需要能打开面板——原因就写在面板里，
 * 比只弹一句 toast 有用。真正挡住切换的是面板里那两个开关。
 *
 * 也只是发一个事件：徽章不认识面板，开合时该顺带刷什么归刷新编排管。
 *
 * @param {MouseEvent|KeyboardEvent} [event]
 */
function onBadgeClick(event) {
    event?.preventDefault?.();
    notifyPanelToggle();
}

/**
 * 只把"面板开着没有"同步到徽章的 aria-expanded 上，不重算状态、不碰面板——
 * 所以可以放心在 refreshPanel 里调用。
 *
 * 不额外画"已打开"的样式：面板就摆在眼前，再给图标描一圈只会让它和同一排的
 * 其它图标又不一样了。
 */
export function syncBadgeOpenState() {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) {
        return;
    }
    badge.setAttribute('aria-expanded', String(isPanelOpen()));
}

/**
 * 刷新徽章：颜色、计数、tooltip。
 *
 * 徽章不再承载开关，状态全靠图标本身：强调色 = 主动开着，Em 色 = 只有被动开着，
 * 「待学」让图标呼吸；具体文案另有 tooltip，面板里还有完整说明。
 */
function refreshBadge(ctx, settings, available, diag) {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) {
        return;
    }

    const none = !hasAnyModule(settings);
    // 环境不支持时置灰：开关切过去也没有任何东西会生效
    const unsupported = !diag.ok;
    const usable = available && !none && !unsupported;

    const activeOn = isEnabled(ctx);
    const passiveOn = settings.passiveEnabled === true;
    const pending = getPending(ctx);
    // 徽章计数：待确认的改动只有 patch 一种，且同一时刻最多一份
    const patchPending = isUnresolved(getPatch(ctx)) ? 1 : 0;

    badge.classList.toggle('displayNone', !settings.showBadge);
    // 三种"不可用"共用同一档置灰：没有可写模块、没有对话、环境不支持工具调用
    badge.classList.toggle('thrive-badge--muted', !usable);
    badge.classList.toggle('thrive-badge--active', activeOn);
    badge.classList.toggle('thrive-badge--passive', passiveOn);
    badge.classList.toggle('thrive-badge--armed', Boolean(pending));
    badge.classList.toggle('thrive-badge--pending', patchPending > 0);
    syncBadgeOpenState();

    const count = badge.querySelector('.thrive-badge__count');
    if (count) {
        count.textContent = patchPending > 0 ? String(patchPending) : '';
        count.classList.toggle('displayNone', patchPending === 0);
    }

    const lines = [];
    if (none) {
        lines.push('两个模块都关着，请先在扩展设置里开启至少一个');
    } else if (!available) {
        lines.push('请先打开一个对话');
    } else if (unsupported) {
        lines.push(`工具调用不可用：${formatDiagnosis(diag)}`);
    } else {
        lines.push(`主动学习：${activeOn ? '已开启' : '已关闭'}`);
        lines.push(`被动学习：${passiveOn ? '已开启' : '已关闭'}`);

        const progress = intervalProgress(ctx, settings);
        if (passiveOn && progress.interval > 0) {
            lines.push(`下次按条数触发还差 ${progress.remaining} 条（已累计 ${progress.since} / ${progress.interval}）`);
        }
        const keywords = parseKeywords(settings.passiveKeywords);
        if (passiveOn && keywords.length > 0) {
            lines.push(`关键词 ${keywords.length} 个：${keywords.slice(0, 4).join(' / ')}${keywords.length > 4 ? ' …' : ''}`);
        }
    }

    if (pending) {
        lines.push(`本次待学习：${describePending(pending)} —— 下一轮对话临时开启，回复后自动关闭`);
    }
    if (patchPending > 0) {
        lines.push(`有 ${patchPending} 份待确认的描述改动`);
    }

    /*
     * 超长内容只在 tooltip 里提一句，不在徽章上再加一个标记：
     * 这个方块已经用颜色表达模式、用数字表达待确认改动，再叠一层就分不清了。
     * 真正的高亮在面板里的「压缩」那一段与设置页那一组。
     */
    const compressCount = getCompressSnapshot().items.length;
    if (compressCount > 0) {
        lines.push(`有 ${compressCount} 条内容超过软提醒，面板里的「压缩」可以处理`);
    }

    // 点徽章只会开 / 关面板，说清楚，省得用户以为它还像以前那样切开关
    lines.push(isPanelOpen() ? '点击收起面板' : '点击打开面板（模式开关在里面）');

    badge.title = lines.join('\n');
    badge.setAttribute('aria-label', lines.join('；'));
}

/* 登记给刷新编排 */
registerSurfaces({
    badge: ({ ctx, settings, available, diag }) => refreshBadge(ctx, settings, available, diag),
});
