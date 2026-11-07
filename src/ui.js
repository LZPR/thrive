/**
 * ui.js · 界面门面
 *
 * 界面本身按"一块界面一个文件"分在 ui/ 下，这里只负责把对外要用的几个入口
 * 重新导出——index.js 与回归脚本都还从 './src/ui.js' 拿这些名字：
 *
 *   ui/settings/        扩展设置页（settings.html 的绑定与回填，见下面的分工）
 *   ui/panel.js         浮动面板（重绘 / 交互 / 模式开关 / 入口）
 *   ui/panel-layout.js  面板的位置、尺寸、透明度与拖拽
 *   ui/compress-panel.js 压缩面板（独立窗口：超长条目、手动编辑、智能压缩占位）
 *   ui/badge.js         输入框旁的状态徽章
 *   ui/status.js        状态摘要文本（`/thrive status` 与设置页那一行）
 *   ui/refresh.js       刷新编排：谁该在什么时候刷，以及面板开合的开关
 *   ui/shared.js        共用的常量、toast、确认弹窗、面板开合状态
 *
 * 设置页内部也是"一组设置一个文件"：common / help / diagnostics / basics /
 * write-targets / desc-patch / passive-trigger / limit-fields / prompt-cards /
 * tool-catalog / appearance，入口是 ui/settings/index.js。改哪一组就只碰那个文件。
 *
 * 跨界面的协调动作（改完状态要刷哪些地方）统一写在 ui/refresh.js 里。
 *
 * 所有事件处理器都在触发时现取 getContext()，理由见 index.js 的 context() 注释。
 */

export { initSettingsPanel } from './ui/settings/index.js';
export { initPanel, openPanel, refreshPanel } from './ui/panel.js';
export { closeCompressPanel, initCompressPanel, openCompressPanel } from './ui/compress-panel.js';
export { initBadge } from './ui/badge.js';
export { describeStatus } from './ui/status.js';
export { bindCompressRefresh, refreshUI, refreshBadgeOnly } from './ui/refresh.js';
