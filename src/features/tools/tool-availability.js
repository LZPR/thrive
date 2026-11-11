/** tool-availability.js · Internal tools module; public entry: index.js. */

import { getContext } from '../../platform/sillytavern/context.js';

import { isLearningActive } from '../../store.js';

import { getWritableBook } from '../../targets.js';

import { errorResult } from './tool-contracts.js';

/**
 * 这组工具此刻可不可用。
 *
 * 两个条件：学习会话正在跑（否则连调用入口都没有），世界书工具还要求选了可写书。
 * 描述工具两种存储模式都有，换的只是落点。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isToolAvailable(name) {
    if (!isLearningActive()) {
        return false;
    }

    const key = String(name ?? '');
    if (key.startsWith('lore_')) {
        return Boolean(getWritableBook(getContext()));
    }
    return true;
}

/**
 * 工具调用前的守卫：定义表里有不等于现在能用。
 *
 * 会话结束后模型可能还留着一轮递归（或者别处误调），这里统一拒绝并给一句话，
 * 比让它反复试别的工具好。
 *
 * @param {string} name
 * @param {(params: object) => Promise<object>} handler
 */
function guardAction(name, handler) {
    return async params => {
        if (!isToolAvailable(name)) {
            return errorResult('TOOL_UNAVAILABLE');
        }
        return handler(params);
    };
}

export { isToolAvailable, guardAction };
