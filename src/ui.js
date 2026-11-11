/**
 * ui.js · 界面门面
 *
 * 界面本身按"一块界面一个文件"分在 ui/ 下，这里只负责把对外要用的几个入口
 * 重新导出——index.js 与回归脚本都还从 './src/ui.js' 拿这些名字：
 *
 *   ui/settings/        扩展设置页（settings.html 的绑定与回填，见下面的分工）
 *   ui/panel.js         浮动面板（重绘 / 交互 / 学习开关 / 入口）
 *   ui/panel-layout.js  面板的位置、尺寸、不透明度与拖拽
 *   ui/compress-panel.js 压缩面板（独立窗口：超长条目、手动编辑、智能压缩占位）
 *   ui/draft-window.js  虚拟世界书（独立窗口：条目的真实世界书 vs 缓冲区 diff、保存 / 丢弃）
 *   ui/prompt-window.js 提示词编辑器（独立窗口：一场学习会话的预设卡 + 两段开场白）
 *   ui/badge.js         输入框旁的状态徽章
 *   ui/status.js        状态摘要文本（`/thrive status`）
 *   ui/desc-target.js   两个落点：描述存哪儿、可写书（对话级，面板的「更多设置」用它）
 *   ui/refresh.js       刷新编排：谁该在什么时候刷，以及面板开合的开关
 *   ui/shared.js        共用的常量、toast、确认弹窗、面板开合状态
 *
 * 设置页内部也是"一组设置一个文件"：common / help / connection / basics /
 * learn-criteria / limit-fields / prompt-cards / appearance，入口是
 * ui/settings/index.js。改哪一组就只碰那个文件。
 *
 * 一条界线值得记住：**对话级的界面件不放在 ui/settings/ 里**。落点那两块之所以在
 * ui/desc-target.js 而不是 settings/desc-storage.js，就是因为面板要用它们，而面板不该
 * 反过来 import 设置页的文件（ADR-045）。
 *
 * 跨界面的协调动作（改完状态要刷哪些地方）统一写在 ui/refresh.js 里。
 *
 * 所有事件处理器都在触发时现取 getContext()，理由见 index.js 的 context() 注释。
 */

export { initSettingsPanel } from './ui/settings/index.js';
export { initPanel, openPanel, refreshPanel } from './ui/panel.js';
export { closeCompressPanel, initCompressPanel, openCompressPanel } from './ui/compress-panel.js';
export { closeDraftWindow, initDraftWindow, isDraftWindowOpen, openDraftWindow } from './ui/draft-window.js';
export {
    closePromptWindow,
    initPromptWindow,
    isPromptWindowOpen,
    openPromptWindow,
    refreshPromptWindow,
} from './ui/prompt-window.js';
export { initBadge } from './ui/badge.js';
export { closeTeachWindow, initTeachWindow, isTeachWindowOpen, openTeachWindow } from './ui/teach-window.js';
export { describeStatus } from './ui/status.js';
export { bindCompressRefresh, refreshUI, refreshBadgeOnly } from './ui/refresh.js';
