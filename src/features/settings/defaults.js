/** defaults.js · Internal settings module; public entry: index.js. */

import { LIMIT_DEFAULTS } from '../../core/limits.js';

const MODULE_NAME = 'thrive';

/**
 * 本步骤只需要这几项设置。后续步骤（写入目标、长度上限等）
 * 会往 DEFAULT_SETTINGS 里继续补，ensureSettings 的补全逻辑不用改。
 */
const DEFAULT_SETTINGS = Object.freeze({
    /** 新对话默认是否开启学习模式 */
    enabledByDefault: false,
    /** 输入框旁是否显示状态徽章 */
    showBadge: true,
    /**
     * 自动学习判据：从上次学习算起，攒够这么多条可见消息就触发一次。
     * 0 = 不用这条判据（全局）。开关本身按对话记（`state.enabled`）。
     */
    learnInterval: 0,
    /** 自动学习判据：关键词，逗号/分号/换行分隔；空 = 不用关键词触发（全局） */
    learnKeywords: '',
    /**
     * 学习 / 压缩会话走哪条连接。
     *
     * 空串 = 跟随当前聊天设置（ST 主界面上选的那个 API）；否则是 ST「连接配置」里
     * 某一份的 id。改动只影响**之后新开的**会话：一场会话开始时读一次就定死，
     * 中途换路会让后半场跑到另一个模型上。
     */
    connectionProfile: '',
    /**
     * 提示词卡片的顺序（prompt-order.js 里的 id 数组，以及自建提示词的 id）。
     * 空数组 = 默认顺序。这份顺序就是学习会话里消息的先后。
     */
    promptOrder: [],
    /**
     * 用户自建的提示词。
     *
     * 每条形如 `{ id, name, content, role, enabled }`：
     *   role     ST 的扩展提示词角色，0 系统 / 1 用户 / 2 助手
     *   enabled  停用之后内容还留着，只是不参与注入
     *
     * 内置卡（学习块、工具指令、压缩指令）不在这里，它们的正文仍存在下面那几个
     * 老设置键里；停用状态见 `disabledCards`，角色覆盖见 `promptRoles`。
     */
    customPrompts: [],
    /** 被停用的内置卡片 id。停用 = 不注入，正文一个字不动 */
    disabledCards: [],
    /** 内置卡片的角色覆盖：`{ [cardId]: 0|1|2 }`。没写 = 系统 */
    promptRoles: {},

    /**
     * 学习会话用到的四段文字（ADR-054 把它们分成两层）。
     *
     * 通用层（列表里的卡片，每一场都带）：
     *   sessionRules  通用提示词的正文——这场会话里你是谁、擅长什么。默认空串。
     *   targetPrompt  目标内容描述行（默认「以下是目标内容：」），真正的内容由
     *                 learning.js 在发请求前追加在后面。
     *
     * 特化层（开场白，只属于那一种任务）：
     *   learningTask  学习这一场怎么干：产出方式、写到哪、怎么写、这一次的要求。
     *   compactTask   压缩那一场同样的一份。
     *
     * 空串 = 使用 prompt.js 里对应的 DEFAULT_*（默认文本随版本更新时老用户也能拿到新版）。
     */
    targetPrompt: '',
    sessionRules: '',
    learningTask: '',
    compactTask: '',
    /*
     * 「角色描述存哪儿」（descStorage）与「可写书」（writableBook）不在这里：
     * 它们按对话保存（ADR-044），见 createChatState。老版本留在全局的旧值只当
     * 未设置过的对话的初值，见 legacyChatValue。
     */
    /** 新建条目的插入位置：0 角色定义前 / 1 角色定义后 / 2 作者注释顶 / 3 作者注释底 */
    entryPosition: 0,
    /**
     * 所有"写多少 / 读多少"的数值上限。默认值与取值范围由 limits.js 定义，
     * 设置页「数值与上限」直接对着它渲染；这里铺开是为了让 ensureSettings
     * 的类型补全也覆盖到它们（老用户没有这些键，缺一个就会被当成 0）。
     */
    ...LIMIT_DEFAULTS,
    /**
     * 记录面板的布局。位置/尺寸是按屏幕算的，与具体对话无关，所以放全局设置：
     *   panelX / panelY  -1 = 还没拖过，走样式里的右下角；否则是左上角像素坐标
     *   panelWidth       展开时的宽度（窄屏会被 `min(…, 92vw)` 再收一次）
     *   panelHeight      展开时的最大高度
     *   panelOpacity     整块面板的不透明度，调低可以透出后面的聊天内容
     *
     * 默认值随面板瘦身一起调小过一档（ADR-043）：正文只剩两块开关 + 一个折叠块，
     * 再给 480×620 就只是空着。用户自己拖过 / 调过的值不动。
     */
    panelX: -1,
    panelY: -1,
    panelWidth: 400,
    panelHeight: 520,
    panelOpacity: 1,
});

export { MODULE_NAME, DEFAULT_SETTINGS };
