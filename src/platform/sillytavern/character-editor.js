import { normalizeEol } from '../../shared/util.js';
/**
 * 写入成功后同步内存里的角色对象，以及角色编辑面板里的文本框。
 *
 * 内存同步是必须的：下一步生成的 system 提示词直接从 `characters[chid].description` 取。
 *
 * 文本框同步是必须的，而且比想象中更关键：ST 的编辑面板保存时提交的是**表单里的值**，
 * 不是内存里的对象。如果面板开着、里面还是旧文本，用户随手一点保存，就会把刚写进去的
 * 内容整段覆盖回去（实测踩过：写入成功、一分钟后又变回原样，真值只能从 patch.after 里捞）。
 *
 * 所以这里不再靠 `offsetParent === null` 判断"面板开没开"——面板收起时 textarea 依然
 * 留着上一次的值，等用户打开时 ST 不一定重新填充。改为看内容：
 *   - 框里还等于写入前的原文 → 用户没动过，直接同步（隐藏着也同步，省得以后拿旧的覆盖）
 *   - 框里已经被改过 → 绝不覆盖（会冲掉用户正在敲的字），交给调用方提示
 *   - 框里显示的是另一个角色 → 不动
 *
 * @param {object} character 当前角色对象（会被原地修改）
 * @param {string} text 刚写入的全文
 * @param {string|null} [previousText] 写入前角色卡上的原文，用来判断"用户动没动过"
 * @returns {{ synced: boolean, reason: string }}
 */
function applyDescriptionLocally(character, text, previousText = null) {
    if (!character) {
        return { synced: false, reason: 'no-character' };
    }

    const next = normalizeEol(text);
    character.description = next;

    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return { synced: false, reason: 'no-editor' };
    }

    // 编辑面板正在编辑别的角色：不要动别人的输入框
    const nameField = document.getElementById('character_name_pole');
    if (nameField && character.name && nameField.value && nameField.value !== character.name) {
        return { synced: false, reason: 'other-character' };
    }

    const current = normalizeEol(textarea.value);
    const focused = document.activeElement === textarea;

    /*
     * 只有"正在这个框里打字、而且内容已经和写入前不一样"才不覆盖——
     * 其余情况一律同步：
     *   - 框是隐藏的/面板收起了：里面的值迟早会被 ST 的自动保存（输入任意字段、
     *     切聊天都会触发 saveCharacterDebounced）整份提交上去，留着旧的等于埋雷
     *   - 框是可见的但没聚焦：不算在编辑
     * 以前靠 `offsetParent === null` 判断"面板没开"，并拿原始字符串和框里的值比对，
     * 两处都错：隐藏的框照样会被自动保存提交；框里的换行是 LF、盘上是 CRLF，永远不相等。
     */
    const untouched = previousText === null
        ? !focused
        : current === normalizeEol(previousText);

    if (focused && !untouched) {
        return { synced: false, reason: 'edited' };
    }

    // 焦点在这个框里时（用户没改过内容）整段替换会把光标顶到末尾；记一下位置再放回去，
    // 免得用户刚把光标点到某句话中间就被弹走
    const selection = focused && Number.isFinite(textarea.selectionStart)
        ? [textarea.selectionStart, textarea.selectionEnd]
        : null;
    textarea.value = next;
    if (selection) {
        const clamp = pos => Math.min(pos, next.length);
        textarea.setSelectionRange(clamp(selection[0]), clamp(selection[1]));
    }
    // 框里原本是别的文本（用户改过但已经失焦）：同步是对的，但要如实告诉调用方"覆盖了未保存的改动"
    return { synced: true, reason: untouched ? 'ok' : 'overwrote-edited' };
}


/**
 * 把已写入的描述直接推进编辑框，不管框里现在是什么。
 *
 * 只有用户主动点面板上的「填入编辑框」才会走到这里 —— 那是"我知道会覆盖我刚才敲的字"
 * 的显式同意。写入路径自己不用它：那边碰到用户改过的框一律不动（见 applyDescriptionLocally）。
 *
 * @param {object|null} character
 * @param {string} text
 * @returns {{ synced: boolean, reason: string }}
 */
function refreshDescriptionEditor(character, text) {
    const textarea = document.getElementById('description_textarea');
    if (!textarea) {
        return { synced: false, reason: 'no-editor' };
    }

    const next = normalizeEol(text);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    textarea.value = next;

    if (document.activeElement === textarea && Number.isFinite(start)) {
        const clamp = pos => Math.min(pos, next.length);
        textarea.setSelectionRange(clamp(start), clamp(end));
    }

    if (character) {
        character.description = next;
    }

    return { synced: true, reason: 'forced' };
}

export { applyDescriptionLocally, refreshDescriptionEditor };
