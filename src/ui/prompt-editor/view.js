import { PROMPT_ROLE, roleLabel, countChars } from '../../features/prompts/prompt.js';
import { escapeHtml } from '../../shared/util.js';

function countText(text) {
    const chars = countChars(text);
    return chars > 0 ? `${chars} 字` : '0 字 · 不会发送';
}


/** 开场白的字数小字：空 = 用默认文本，不能说成"不会发送" */
function msgCountText(text) {
    const value = String(text ?? '');
    return value.trim() ? `${countChars(value)} 字` : '空 · 用默认文本';
}

export { countText, msgCountText };

export function renderPromptBody(view, { editing = null, msgDraft = '', folds = new Set() } = {}) {
    function renderBody(view) {
        const list = view.items.length === 0
            ? '<div class="thrive-prompts__empty">这里还没有提示词。</div>'
            : `<div class="thrive-prompts__list">${view.items.map(renderItem).join('')}</div>`;
    
        return `${list}${renderMessages(view.messages)}${renderTools(view.tools)}`;
    }
    
    
    /**
     * 折叠块的外壳。
     *
     * 用原生 `<details>` 而不是自己做一套：键盘可操作、`open` 是属性可以直接写进
     * 字符串、也不需要在重绘之后重新绑事件。状态另存在 `folds` 里，重绘时照着写回。
     *
     * @param {string} key 折叠块标识（msgs / tools）
     * @param {string} title
     * @param {string} note 标题右侧那行小字
     * @param {string} inner
     */
    function renderFold(key, title, note, inner) {
        const open = folds.has(key) ? ' open' : '';
        return `<details class="thrive-prompts__fold" data-fold="${key}"${open}>
            <summary class="thrive-prompts__fold-head">
                <span class="thrive-prompts__fold-title">${escapeHtml(title)}</span>
                <small class="thrive-prompts__fold-note">${escapeHtml(note)}</small>
            </summary>
            <div class="thrive-prompts__fold-body">${inner}</div>
        </details>`;
    }
    
    
    function renderItem(item) {
        const open = editing?.id === item.id;
    
        const editButton = item.editable
            ? `<button type="button" class="menu_button thrive-prompts__act${open ? ' thrive-prompts__act--open' : ''}"
                    data-act="edit" title="${open ? '收起编辑区' : '展开编辑：改名称、角色、正文与删除'}">
                    ${open ? '收起' : '编辑'}</button>`
            : '';
    
        // 注入位没有抓手也没有开关：它不参与排序，也不能被停用
        const grip = item.pinned
            ? '<span class="thrive-prompts__grip thrive-prompts__grip--locked fa-solid fa-lock" title="固定位置：始终在最后，代表这一场要看的内容"></span>'
            : '<span class="thrive-prompts__grip fa-solid fa-grip-vertical" title="拖动调整顺序"></span>';
    
        const note = item.pinned
            ? '运行时注入 · 内容随触发生成'
            : `${item.chars} 字`;
    
        return `<article class="thrive-prompts__item" data-prompt="${item.id}"
            data-kind="${item.kind}" data-enabled="${item.enabled}" data-pinned="${item.pinned}">
            ${grip}
            <div class="thrive-prompts__main">
                <div class="thrive-prompts__head">
                    <span class="thrive-prompts__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    <span class="thrive-prompts__chip">${escapeHtml(roleLabel(item.role))}</span>
                </div>
                <div class="thrive-prompts__note" title="${escapeHtml(item.status)}">${note}</div>
            </div>
            ${editButton}
            ${item.pinned ? '' : renderSwitch(item)}
            ${open ? renderEditor(item) : ''}
        </article>`;
    }
    
    
    /**
     * 会话开场白：**特化提示词**，每种任务一段，放在列表下面的折叠块里。
     *
     * 它们不是"预设里的一段"，所以不参与拖动排序。发出的顺序是：整份预设 → 开场白。
     * 分工写在块首那行小字里：列表里的是通用（每场都带），这里是特化（只在这一场发）。
     *
     * 收进折叠块是因为它平时不用改：改一次能用很久，却和每张卡一样占一屏。
     *
     * @param {Array<object>} messages
     */
    function renderMessages(messages) {
        if (!messages.length) {
            return '';
        }
    
        const note = '特化提示词 · 每场一段 · 收起来不影响发送';
        const head = '<small class="thrive-prompts__fold-hint">'
            + '上面列表里的卡片是通用提示词：每一场都带，讲的是这一场里你是谁。'
            + '这里两段是特化提示词：只在那一种任务里发出，讲的是这一场具体怎么干——'
            + '产出走哪、写到哪、怎么写、这一次要它做什么。'
            + '</small>';
    
        return renderFold('msgs', '会话开场白', note, head + messages.map(renderMessage).join(''));
    }
    
    
    function renderMessage(item) {
        const open = item.open;
        // 空 = 用默认文本（存空串，读取时回落到默认），所以不能说成"不会发送"
        const note = [`${item.chars} 字`, item.custom ? '已改过默认' : '默认'].join(' · ');
        const draftLabel = msgCountText(msgDraft);
        const title = `${item.label}时发送`;
    
        if (!open) {
            return `<article class="thrive-prompts__msg" data-msg="${item.kind}">
                <div class="thrive-prompts__main">
                    <div class="thrive-prompts__head">
                        <span class="thrive-prompts__name">${escapeHtml(title)}</span>
                        <span class="thrive-prompts__chip thrive-prompts__chip--muted">User</span>
                    </div>
                    <div class="thrive-prompts__note">${escapeHtml(note)}</div>
                </div>
                <button type="button" class="menu_button thrive-prompts__act" data-act="msg-edit"
                    title="展开编辑这一段的正文">编辑</button>
            </article>`;
        }
    
        return `<article class="thrive-prompts__msg thrive-prompts__msg--open" data-msg="${item.kind}">
            <div class="thrive-prompts__main">
                <div class="thrive-prompts__head">
                    <span class="thrive-prompts__name">${escapeHtml(title)}</span>
                    <span class="thrive-prompts__chip thrive-prompts__chip--muted">User</span>
                </div>
                <div class="thrive-prompts__note">${escapeHtml(note)}</div>
            </div>
            <div class="thrive-prompts__editor">
                <div class="thrive-prompts__editor-head">
                    <span class="thrive-prompts__field thrive-prompts__field--static">
                        <span>内容</span>
                        <b>这一场的第一条 User 消息</b>
                    </span>
                    <span class="thrive-prompts__count">${draftLabel}</span>
                </div>
                <div class="thrive-prompts__area">
                    <textarea class="text_pole thrive-block-text" data-field="msg" rows="8" spellcheck="false"
                        data-macros="true" data-macros-autocomplete="always" data-macros-autocomplete-style="small"
                        placeholder="这一场具体怎么干：产出方式、写到哪、怎么写、这一次要它做什么。支持 {{char}}、{{user}} 等 ST 宏。"
                    >${escapeHtml(msgDraft)}</textarea>
                </div>
                <div class="thrive-prompts__editor-foot">
                    <small>${escapeHtml(item.hint)}</small>
                    <button type="button" class="menu_button thrive-prompts__ghost" data-act="msg-reset"
                        title="用回内置的默认文本">恢复默认</button>
                    <button type="button" class="menu_button thrive-prompts__ghost" data-act="msg-cancel">取消</button>
                    <button type="button" class="menu_button thrive-prompts__save" data-act="msg-save">保存</button>
                </div>
            </div>
        </article>`;
    }
    
    
    /**
     * 工具列表：这一版插件带出去的全部工具，一行两个卡片。
     *
     * 只读——工具是写死的实现，用户能调的是"写多少、读多少"（在设置页「数值与上限」），
     * 不是"带不带这个工具"。所以这里不放开与关，只把名字、用途和激活状态摆出来，
     * 让人知道模型手里到底有什么。
     *
     * @param {Array<{ name: string, label: string, description: string, active: boolean }>} tools
     */
    function renderTools(tools) {
        if (!tools.length) {
            return renderFold('tools', '工具列表', '没有工具', '<div class="thrive-prompts__empty">读不到工具定义。</div>');
        }
    
        const inner = `<div class="thrive-prompts__tools">${tools.map(tool => `
            <article class="thrive-prompts__tool" data-tool="${escapeHtml(tool.name)}">
                <div class="thrive-prompts__tool-head">
                    <span class="thrive-prompts__tool-name">${escapeHtml(tool.label)}</span>
                    <span class="thrive-prompts__chip${tool.active ? ' thrive-prompts__chip--on' : ' thrive-prompts__chip--muted'}">
                        ${tool.active ? '激活' : '停用'}
                    </span>
                </div>
                <code class="thrive-prompts__tool-id">${escapeHtml(tool.name)}</code>
                <p class="thrive-prompts__tool-desc">${escapeHtml(tool.description)}</p>
            </article>`).join('')}</div>
            <small class="thrive-prompts__fold-hint">
                学习会话里这些工具全部带上。世界书那几个还要求这一场对话里选好了可写书——
                没选的时候它们会拒绝调用，不是没带。
            </small>`;
    
        return renderFold('tools', '工具列表', `${tools.length} 个 · 全部激活`, inner);
    }
    
    
    /**
     * 行尾的启用开关。
     *
     * 用滑块而不是复选框：复选框一排下来视觉重心全在左边，而"这一条我到底关了没有"
     * 恰恰是扫一眼就要看到的东西，所以放到行尾、用位置表态。停用时整行同时压暗并
     * 换成虚线边框（见 `[data-enabled="false"]` 的样式），两处对得上。
     */
    function renderSwitch(item) {
        return `<label class="thrive-prompts__switch" title="${item.enabled ? '已启用，点击停用（正文保留）' : '已停用，点击启用'}">
            <input type="checkbox" data-act="toggle"${item.enabled ? ' checked' : ''}
                aria-label="${escapeHtml(item.name)} 的启用状态">
            <span class="thrive-prompts__switch-track" aria-hidden="true"></span>
        </label>`;
    }
    
    
    /**
     * 展开的编辑框。
     *
     * 名称只对自建提示词可改；内置卡的名称是功能名，改了反而找不到。
     * 角色下拉与删除也在这里：它们不是每眼都要看的动作，摆在行上只会把右侧挤乱。
     */
    function renderEditor(item) {
        const nameField = item.custom
            ? `<label class="thrive-prompts__field">
                    <span>名称</span>
                    <input class="text_pole" data-field="name" type="text"
                        value="${escapeHtml(editing.name)}" maxlength="80">
                </label>`
            : `<div class="thrive-prompts__field thrive-prompts__field--static">
                    <span>名称</span>
                    <b>${escapeHtml(item.name)}</b>
                </div>`;
    
        const roleOptions = [
            [PROMPT_ROLE.SYSTEM, '系统'],
            [PROMPT_ROLE.USER, '用户'],
            [PROMPT_ROLE.ASSISTANT, '助手'],
        ].map(([value, label]) => `<option value="${value}"${value === item.role ? ' selected' : ''}>${label}</option>`).join('');
    
        const reset = item.canReset
            ? '<button type="button" class="menu_button thrive-prompts__ghost" data-act="reset-text" '
                + 'title="用回内置的默认文本">恢复默认</button>'
            : '';
    
        // 自建卡的删除是真删；可移除的内置卡只是从列表里拿掉，正文留着（「默认顺序」能拿回来）
        const remove = item.deletable
            ? `<button type="button" class="menu_button thrive-prompts__ghost thrive-prompts__act--danger" `
                + `data-act="delete" title="${item.custom
                    ? '删除这条自建提示词（正文一起删掉）'
                    : '从列表里拿掉（正文留着，「默认顺序」能让它回来）'}">删除</button>`
            : '';
    
        return `<div class="thrive-prompts__editor">
            <div class="thrive-prompts__editor-head">
                ${nameField}
                <label class="thrive-prompts__field thrive-prompts__field--role">
                    <span>角色</span>
                    <select class="thrive-prompts__role" data-act="role" title="这条消息在会话里用的角色"
                        aria-label="${escapeHtml(item.name)} 的角色">${roleOptions}</select>
                </label>
                <span class="thrive-prompts__count">${countText(editing.text)}</span>
            </div>
            <div class="thrive-prompts__area">
                <textarea class="text_pole thrive-block-text" data-field="text" rows="10" spellcheck="false"
                    data-macros="true" data-macros-autocomplete="always" data-macros-autocomplete-style="small"
                    placeholder="在这里写提示词。支持 {{char}}、{{setvar::名::值}}、{{getvar::名}} 等 ST 宏。"
                >${escapeHtml(editing.text)}</textarea>
                <button type="button" class="menu_button thrive-prompts__fullscreen" data-act="fullscreen"
                    title="全屏编辑（同样的宏补全，适合长段正文）" aria-label="全屏编辑">
                    <i class="fa-solid fa-maximize"></i>
                </button>
            </div>
            <div class="thrive-prompts__editor-foot">
                <small>${escapeHtml(item.hint)}</small>
                ${reset}
                ${remove}
                <button type="button" class="menu_button thrive-prompts__ghost" data-act="cancel">取消</button>
                <button type="button" class="menu_button thrive-prompts__save" data-act="save">保存</button>
            </div>
        </div>`;
    }

    return renderBody(view);
}
