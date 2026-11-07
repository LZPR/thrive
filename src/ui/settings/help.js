/**
 * ui/settings/help.js · 标签旁那颗「?」
 *
 * 设置页里"这是什么、为什么这么设计"的说明都收在这些按钮里：点一下在它下面展开一段，
 * 再点收起。外面只留一眼能看懂的短标签，以及只报状态的小字（见 common.js 的 paintHint）。
 *
 * 事件挂在设置页根节点上做委托，不逐个绑：按钮数量跟着设置项走，加一项不该还要记着
 * 去改绑定。拦截冒泡是必须的——按钮常常挨着 <label> 和折叠块标题，不拦的话点一下会
 * 顺带勾上勾选框、或者把整组收起来。
 */

import { LOG } from '../shared.js';

/**
 * @param {Element|null} [root] 设置页根节点
 */
export function bindHelpButtons(root = document.getElementById('thrive_settings')) {
    if (!root) {
        return;
    }

    root.addEventListener('click', event => {
        const button = event.target?.closest?.('.thrive-help');
        if (!button || !root.contains(button)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        toggleHelp(button);
    });
}

/**
 * 一个按钮只管一段说明，对应关系写在 data-help 上（值是说明块的 id）。
 * 状态放在 aria-expanded 与说明块的 data-open 上，不额外维护一份 JS 变量。
 *
 * @param {Element} button
 */
function toggleHelp(button) {
    const body = document.getElementById(button.dataset.help ?? '');
    if (!body) {
        // 写错 id 的表现是"点了没反应"，吵一句比让用户猜强
        console.warn(`${LOG} 「?」找不到对应说明：${button.dataset.help}`);
        return;
    }

    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    body.toggleAttribute('data-open', !open);
}
