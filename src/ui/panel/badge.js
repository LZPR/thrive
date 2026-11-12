/**
 * ui/badge.js · 输入框旁的状态徽章
 *
 * 徽章只干一件事：开关浮动面板。它不知道面板长什么样、也不知道怎么切换学习，
 * 点击只是发一个 PANEL_TOGGLE_EVENT（见 events.js）——面板那边自己接。
 *
 * 状态全靠图标本身，三种，互不叠加成新含义：
 *   · 强调色 = 学习模式开着（会自动学）
 *   · 呼吸   = 正在学（一场学习会话在跑）
 *   · 置灰   = 现在切了也没用（没打开对话）
 * 右上角的数字只表示"有几份待确认的描述改动"，和学不学无关。
 *
 * 为什么不在这里放开关：它们挤在输入框旁边，宽度随文字变，和 ST 那一排固定尺寸
 * 的方块按钮站不到一起；而且 #leftSendForm 是 flex 容器，徽章会跟着一起被拉高。
 * 开关在面板里，点一下徽章就看见。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { describeTrigger, intervalProgress, parseKeywords } from '../../features/learning/auto-learn.js';
import { getCompressSnapshot } from '../../features/memory/compress.js';
import { LEARNING_EVENT, notifyPanelToggle } from '../../shared/events.js';
import { describeLearnRun, getLearningView } from '../../features/learning/learning.js';
import { getPatch, isUnresolved } from '../../features/memory/patch.js';
import { getLastLearnRun, getLearningRunning, isEnabled } from '../../features/settings/index.js';
import { refreshBadgeOnly, registerSurfaces } from '../shared/refresh.js';
import { BADGE_ID, LOG, PANEL_ID, isPanelOpen, toast } from '../shared/common.js';

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
     * 学习的开始与结束都要立刻反映到徽章上，并在结束时弹一句结果。
     *
     * 走事件而不是让 learning.js 直接调这里：这两件事发生在用户没在操作界面的时刻
     * （判据命中、后台跑完），如果不刷，徽章会停在旧状态——"呼吸停了但没说结果"
     * 比不呼吸更让人困惑。
     *
     * 开始时不弹 toast：图标已经在呼吸，再弹一条只会挡住输入框。结束时必须说一句，
     * 因为它同时在另一场会话里改了世界书，用户得知道刚才发生了什么。
     */
    document.addEventListener(LEARNING_EVENT, event => {
        const detail = event?.detail ?? {};
        refreshBadgeOnly(getContext());

        if (detail.running) {
            return;
        }

        const result = detail.result;
        if (!result) {
            return;
        }

        if (!result.ok) {
            const why = String(result.hint || result.error || '').trim();
            toast(`学习没跑完${why ? `：${why}` : ''}`);
            return;
        }

        const why = detail.reason ? describeTrigger({ reason: detail.reason }) : '';
        const head = `学习结束${why ? `（${why}）` : ''}`;
        // 没调用工具是正常结果（没有值得记的内容），别把它说得像失败
        toast(result.toolCalls === 0
            ? `${head}：没有调用工具，这次没有值得记下的内容`
            : `${head}：${result.toolCalls} 次工具调用 · ${result.rounds} 轮`);
    });
}

/**
 * 徽章点击：开 / 关面板。
 *
 * 这里**不做任何守卫**：环境不可用时更需要能打开面板——原因就写在面板里，
 * 比只弹一句 toast 有用。真正挡住切换的是面板里那颗开关。
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
 * @param {object} ctx
 * @param {object} settings
 * @param {boolean} available 有没有打开对话
 */
function refreshBadge(ctx, settings, available) {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) {
        return;
    }

    // 没有对话时置灰：开关切过去也没有任何东西会生效
    const usable = available;

    const enabled = isEnabled(ctx);
    const running = getLearningRunning();
    const last = getLastLearnRun(ctx);
    // 徽章计数：待确认的改动只有 patch 一种，且同一时刻最多一份
    const patchPending = isUnresolved(getPatch(ctx)) ? 1 : 0;

    badge.classList.toggle('displayNone', !settings.showBadge);
    // 没有对话就置灰
    badge.classList.toggle('thrive-badge--muted', !usable);
    badge.classList.toggle('thrive-badge--active', enabled && usable);
    badge.classList.toggle('thrive-badge--running', Boolean(running));
    syncBadgeOpenState();

    const count = badge.querySelector('.thrive-badge__count');
    if (count) {
        count.textContent = patchPending > 0 ? String(patchPending) : '';
        count.classList.toggle('displayNone', patchPending === 0);
    }

    const lines = [];
    if (!available) {
        lines.push('请先打开一个对话');
    }

    // 正在学是当下最要紧的事实，放最前面；学不学得到的结果排在后面
    if (running) {
        const why = running.reason ? describeTrigger({ reason: running.reason }) : '';
        lines.push(`正在学习${why ? `（${why}）` : ''}：在独立会话里跑，不影响当前聊天`);

        // 排队的那几场也得说一句：不说的话"我点了它怎么没反应"就没有答案
        const queued = getLearningView(ctx, settings).queued;
        if (queued > 0) {
            lines.push(`排队 ${queued} 场：前一场跑完接着学，一次只跑一场`);
        }
    } else {
        lines.push(`学习模式：${enabled ? '已开启' : '已关闭'}`);

        /*
         * 开了但没配判据是最常见的空转：只写"已开启"等于没说，
         * 用户会以为它会自己学。这里把"靠什么触发"写出来。
         */
        if (enabled) {
            const progress = intervalProgress(ctx, settings);
            const keywords = parseKeywords(settings.learnKeywords);

            if (progress.interval > 0) {
                lines.push(`下次按条数触发还差 ${progress.remaining} 条（已累计 ${progress.since} / ${progress.interval}）`);
            }
            if (keywords.length > 0) {
                lines.push(`关键词 ${keywords.length} 个：${keywords.slice(0, 4).join(' / ')}${keywords.length > 4 ? ' …' : ''}`);
            }
            if (progress.interval <= 0 && keywords.length === 0) {
                lines.push('还没配判据：只有手动「立刻学一次」会触发');
            }
        }

        lines.push(describeLearnRun(last));
    }

    if (patchPending > 0) {
        lines.push(`有 ${patchPending} 份待确认的描述改动`);
    }

    /*
     * 超长内容只在 tooltip 里提一句，不在徽章上再加一个标记：
     * 这个方块已经用颜色表达开关、用呼吸表达在跑、用数字表达待确认改动，
     * 再叠一层就分不清了。真正的高亮在面板标题栏那颗按钮上。
     */
    const compressCount = getCompressSnapshot().items.length;
    if (compressCount > 0) {
        lines.push(`有 ${compressCount} 条内容超过软提醒，面板里的「压缩」可以处理`);
    }

    // 点徽章只会开 / 关面板，说清楚，省得用户以为它还像以前那样切开关
    lines.push(isPanelOpen() ? '点击收起面板' : '点击打开面板（学习开关在里面）');

    badge.title = lines.join('\n');
    badge.setAttribute('aria-label', lines.join('；'));
}

/* 登记给刷新编排 */
registerSurfaces({
    badge: ({ ctx, settings, available }) => refreshBadge(ctx, settings, available),
});
