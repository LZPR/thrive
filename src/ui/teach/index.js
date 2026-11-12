/**
 * 立即学习窗口：补充指令、可选图片与聊天历史开关。
 * 读取历史时沿用聊天学习基线；取消时保留原教授流程，不推进基线和消息哈希。
 *
 * 图片走 data URL（不引用 `user/images/` 里的文件）：会话不落盘，路径形式的图
 * 在任何一步都可能失效；而且这个窗口关掉之后，图片只存在于这一次会话里。
 * 文件太大或尺寸太大时先缩一遍，否则一张图就能吃掉半个上下文。
 */

import { getContext } from '../../platform/sillytavern/context.js';
import { TEACH_MAX_CHARS, TEACH_MAX_IMAGES, startLearning } from '../../features/learning/learning.js';
import { escapeHtml } from '../../shared/util.js';
import { TEACH_ID, LOG, toast } from '../shared/common.js';

/** 单张图的上限（读之前就拦，省得把浏览器卡住） */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/** 超过这个边长就缩：再大对"看清一个人物长什么样"没有帮助，只有 token 开销 */
const MAX_EDGE = 1400;

/** 小于这个体积、边长也不超的图原样发出：重新编码只会掉质量 */
const KEEP_BYTES = 700 * 1024;

/** 重编码质量。0.86 是"看得出笔触、又不至于一张两兆"的位置 */
const JPEG_QUALITY = 0.86;

/** 未保存的草稿：关窗口不丢，重开接着写 */
let draft = { text: '', images: [] };
let includeHistory = true;

/** 正在读图 / 正在开始，避免连点 */
let busy = false;

/* ------------------------------------------------------------------ 挂载 */

export function initTeachWindow() {
    if (document.getElementById(TEACH_ID)) {
        return;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="${TEACH_ID}" class="thrive-teach displayNone" role="dialog"
            aria-label="立即学习">${BODY}</div>`,
    );

    const win = document.getElementById(TEACH_ID);
    if (!win) {
        console.warn(`${LOG} 学习窗口创建失败`);
        return;
    }

    win.addEventListener('click', onClick);
    win.addEventListener('input', onInput);
    win.addEventListener('change', onChange);
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('paste', onPaste);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isTeachWindowOpen()) {
            closeTeachWindow();
        }
    });
}

export function isTeachWindowOpen() {
    const win = document.getElementById(TEACH_ID);
    return Boolean(win) && !win.classList.contains('displayNone');
}

/**
 * 打开窗口。
 *
 * 不重置草稿：关掉窗口只是为了回聊天里看一眼，回来还应该接着写。
 * 要清空用窗口里的「清空」。
 *
 * @returns {boolean}
 */
export function openTeachWindow() {
    const win = document.getElementById(TEACH_ID);
    if (!win) {
        toast('学习窗口还没挂载，刷新页面再试');
        return false;
    }

    win.classList.remove('displayNone');

    const area = win.querySelector('[data-field="teach-text"]');
    if (area) {
        area.value = draft.text;
        // 光标落到末尾：用户多半是在原来的基础上补两句
        area.setSelectionRange(area.value.length, area.value.length);
        area.focus();
    }

    renderImages();
    syncCount();
    return true;
}

export function closeTeachWindow() {
    const win = document.getElementById(TEACH_ID);
    if (win) {
        win.classList.add('displayNone');
    }
    // 文件选择框留在上次选过的状态会让人以为已经加进去了
    const file = win?.querySelector('[data-role="teach-file"]');
    if (file) {
        file.value = '';
    }
}

/* ------------------------------------------------------------------ 静骨架 */

const BODY = `
    <div class="thrive-teach__bar">
        <i class="fa-solid fa-chalkboard-user thrive-teach__icon" aria-hidden="true"></i>
        <span class="thrive-teach__title">立即学习</span>
        <span class="thrive-teach__meta">独立会话</span>
        <button type="button" class="menu_button thrive-teach__close" data-act="teach-close"
            title="关闭（内容留着，下次打开接着写）" aria-label="关闭">X</button>
    </div>
    <div class="thrive-teach__body">
        <label class="thrive-teach__history">
            <input type="checkbox" data-field="teach-history" checked>
            <span>读取聊天历史</span>
        </label>
        <small class="thrive-hint" data-role="teach-history-hint">读取当前聊天记录，并更新聊天学习进度。</small>
        <textarea class="text_pole thrive-teach__text" data-field="teach-text" rows="7"
            spellcheck="false" data-macros="true" data-macros-autocomplete="always"
            data-macros-autocomplete-style="small"
            placeholder="补充指令（可选）：例如，只整理这段对话中的地点设定；把图中的外貌写进角色描述；记住雾港是一座海边城市……"></textarea>
        <div class="thrive-teach__row">
            <span class="thrive-teach__count" data-role="teach-count">0 / ${TEACH_MAX_CHARS} 字</span>
            <div class="menu_button thrive-teach__clear" data-act="teach-clear"
                title="清空正文与图片">清空</div>
        </div>
        <div class="thrive-teach__images" data-role="teach-images"></div>
    </div>
    <div class="thrive-teach__foot">
        <div class="menu_button thrive-teach__pick" data-act="teach-pick"
            title="附一张图：人物立绘、场景、界面截图都行。图会与正文一起发过去">
            <i class="fa-regular fa-image" aria-hidden="true"></i> 图片
        </div>
        <input type="file" accept="image/*" multiple class="displayNone" data-role="teach-file">
        <span class="thrive-teach__hint">支持粘贴文字与图片。补充指令会放在「学习时发送」之前，结果通过工具写入世界书 / 角色描述。</span>
        <div class="menu_button thrive-teach__go" data-act="teach-start" title="在独立会话里开始学习">开始学习</div>
    </div>`;

/* ------------------------------------------------------------------ 交互 */

function onClick(event) {
    const trigger = event.target.closest?.('[data-act]');
    if (!trigger) {
        return;
    }

    const act = trigger.dataset.act;

    if (act === 'teach-close') {
        closeTeachWindow();
        return;
    }

    if (act === 'teach-pick') {
        document.querySelector(`#${TEACH_ID} [data-role="teach-file"]`)?.click();
        return;
    }

    if (act === 'teach-clear') {
        draft = { text: '', images: [] };
        const area = document.querySelector(`#${TEACH_ID} [data-field="teach-text"]`);
        if (area) {
            area.value = '';
            area.focus();
        }
        renderImages();
        syncCount();
        return;
    }

    if (act === 'teach-remove') {
        const index = Number(trigger.dataset.image);
        if (Number.isInteger(index) && index >= 0) {
            draft.images.splice(index, 1);
            renderImages();
        }
        return;
    }

    if (act === 'teach-start') {
        void startTeach();
    }
}

function onInput(event) {
    if (event.target?.dataset?.field !== 'teach-text') {
        return;
    }

    draft.text = String(event.target.value ?? '');
    syncCount();
}

async function onChange(event) {
    if (event.target?.dataset?.field === 'teach-history') {
        includeHistory = event.target.checked;
        const hint = document.querySelector(`#${TEACH_ID} [data-role="teach-history-hint"]`);
        hint.textContent = includeHistory
            ? '读取当前聊天记录，并更新聊天学习进度。'
            : '只使用补充指令与图片，不更新聊天学习进度。';
        return;
    }
    if (event.target?.dataset?.role !== 'teach-file') {
        return;
    }

    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) {
        return;
    }

    await addFiles(files);
}

function onKeyDown(event) {
    // Ctrl / Cmd + Enter = 开始，和提示词编辑器里的约定一致
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void startTeach();
    }
}

/**
 * 粘贴：图片进草稿，纯文字走 textarea 的默认行为。
 *
 * 剪贴板里同时有图和字的时候（从网页复制的图文、截图工具附带的说明），只接图片并
 * 拦掉默认插入——那段说明往往是一串无关的文件名或网址，塞进正文还得自己删。
 * 只有文字时一律不拦：光标在哪插在哪，那是输入框本来的行为，不该由我们重写。
 *
 * @param {ClipboardEvent} event
 */
function onPaste(event) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
        .filter(item => item.kind === 'file' && String(item.type ?? '').startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);

    if (files.length === 0) {
        return;
    }

    event.preventDefault();
    void addFiles(files);
}

/* ------------------------------------------------------------------ 图片 */

/**
 * 把选中的文件读进草稿。
 *
 * 逐张处理而不是 `Promise.all`：一张大图解码时其余几个会一起占内存，
 * 而且"第几张没读进来"要说得清。
 *
 * @param {File[]} files
 */
async function addFiles(files) {
    const room = TEACH_MAX_IMAGES - draft.images.length;
    if (room <= 0) {
        toast(`最多 ${TEACH_MAX_IMAGES} 张图，先移除一张再加`);
        return;
    }

    const accepted = files.filter(file => String(file.type ?? '').startsWith('image/'));
    if (accepted.length === 0) {
        toast('只认图片文件');
        return;
    }

    busy = true;
    setBusy(true);

    try {
        for (const file of accepted.slice(0, room)) {
            const image = await readImageFile(file);
            if (!image.ok) {
                toast(image.hint);
                continue;
            }
            draft.images.push(image.image);
            renderImages();
        }

        if (accepted.length > room) {
            toast(`只加了前 ${room} 张，最多 ${TEACH_MAX_IMAGES} 张`);
        }
    } finally {
        busy = false;
        setBusy(false);
    }
}

/**
 * 读一张图：能原样发就原样发，太大就先缩。
 *
 * @param {File} file
 * @returns {Promise<{ ok: true, image: { url: string, name: string, kb: number } } | { ok: false, hint: string }>}
 */
async function readImageFile(file) {
    if (file.size > MAX_FILE_BYTES) {
        return { ok: false, hint: `「${file.name}」太大（${Math.round(file.size / 1024 / 1024)} MB），换一张小点的` };
    }

    let source;
    try {
        source = await readAsDataUrl(file);
    } catch (err) {
        console.warn(`${LOG} 读图片失败`, err);
        return { ok: false, hint: `「${file.name}」读不进来` };
    }

    const meta = { name: String(file.name || '图'), kb: Math.round(file.size / 1024) };

    // 小图原样发：重编码会掉画质，也省一次 canvas
    if (file.size <= KEEP_BYTES) {
        return { ok: true, image: { url: source, ...meta } };
    }

    try {
        const shrunk = await shrinkToDataUrl(source);
        return { ok: true, image: { url: shrunk, ...meta } };
    } catch (err) {
        // canvas 不可用（极少见）时退回原图：宁可大一点，也不要"加不进去"
        console.warn(`${LOG} 图片缩放失败，按原图发送`, err);
        return { ok: true, image: { url: source, ...meta } };
    }
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('read error'));
        reader.readAsDataURL(file);
    });
}

/**
 * 等比缩到 `MAX_EDGE` 内并转成 JPEG。
 *
 * 先铺一层白底：JPEG 没有 alpha，透明 PNG（立绘最常见）直接画上去会变成黑底。
 *
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
function shrinkToDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => {
            try {
                const width = Number(img.naturalWidth) || 0;
                const height = Number(img.naturalHeight) || 0;
                if (width === 0 || height === 0) {
                    reject(new Error('图片尺寸是 0'));
                    return;
                }

                const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
                const targetW = Math.max(1, Math.round(width * scale));
                const targetH = Math.max(1, Math.round(height * scale));

                const canvas = document.createElement('canvas');
                canvas.width = targetW;
                canvas.height = targetH;

                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('拿不到 canvas 上下文'));
                    return;
                }

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, targetW, targetH);
                ctx.drawImage(img, 0, 0, targetW, targetH);

                resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
            } catch (err) {
                reject(err);
            }
        };

        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = dataUrl;
    });
}

/* ------------------------------------------------------------------ 开始 */

/**
 * 开始一场学习会话。
 *
 * 失败（没登录对话、工具不可用、预设空了）只弹一句原因，窗口留着——用户改两个字
 * 就能再试，重新写一遍才是真正的损失。
 */
async function startTeach() {
    if (busy) {
        return;
    }

    const ctx = getContext();
    const text = draft.text.trim();
    const images = draft.images.map(item => item.url);

    if (!includeHistory && !text && images.length === 0) {
        toast('填写补充指令、附一张图，或者勾选读取聊天历史');
        return;
    }

    if (text.length > TEACH_MAX_CHARS) {
        toast(`超过 ${TEACH_MAX_CHARS} 字了，请拆成几次学习`);
        return;
    }

    busy = true;
    setBusy(true);

    try {
        const started = startLearning(ctx, { teach: { text, images }, includeHistory });

        if (!started.ok) {
            toast(`没能开始：${started.hint}`);
            return;
        }

        /*
         * 排上队时没有 promise（那一场要等前面的跑完），此时 progress 走的是
         * LEARNING_EVENT 广播，不是这里的返回值。
         */
        started.promise?.catch(err => console.error(`${LOG} 学习会话异常`, err));

        // 成功了才清空：失败时草稿必须留着
        draft = { text: '', images: [] };
        closeTeachWindow();

        const area = document.querySelector(`#${TEACH_ID} [data-field="teach-text"]`);
        if (area) {
            area.value = '';
        }
        renderImages();
        syncCount();

        toast(started.queued > 0
            ? `已排队（第 ${started.queued} 位）：前面那一场跑完接着学`
            : '开始学习：在独立会话里跑，不影响当前聊天；结束后另弹一条摘要');
    } finally {
        busy = false;
        setBusy(false);
    }
}

/* ------------------------------------------------------------------ 重绘 */

/** 只重画图片区。整块重绘会把 textarea 的焦点和光标位置一起弄没 */
function renderImages() {
    const host = document.querySelector(`#${TEACH_ID} [data-role="teach-images"]`);
    if (!host) {
        return;
    }

    if (draft.images.length === 0) {
        host.innerHTML = '';
        return;
    }

    host.innerHTML = draft.images.map((image, index) => `
        <div class="thrive-teach__thumb" title="${escapeHtml(image.name)} · ${image.kb} KB">
            <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}">
            <div class="thrive-teach__thumb-x" data-act="teach-remove" data-image="${index}"
                role="button" tabindex="0" title="移除">×</div>
        </div>`).join('');
}

function syncCount() {
    const label = document.querySelector(`#${TEACH_ID} [data-role="teach-count"]`);
    if (!label) {
        return;
    }

    const chars = draft.text.length;
    label.textContent = `${chars} / ${TEACH_MAX_CHARS} 字`;
    label.classList.toggle('is-over', chars > TEACH_MAX_CHARS);
}

/** 忙的时候只关交互，不整体降透明度（用户可能调过面板不透明度） */
function setBusy(on) {
    const win = document.getElementById(TEACH_ID);
    if (!win) {
        return;
    }

    win.classList.toggle('thrive-teach--busy', on);
    const button = win.querySelector('[data-act="teach-start"]');
    if (button) {
        button.textContent = on ? '正在开始…' : '开始学习';
    }
}
