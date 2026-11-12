# 开发与测试

Thrive 直接由 SillyTavern 加载浏览器 ESM，安装插件的用户无需 Node 依赖或构建步骤。
维护者使用 npm 管理测试、Lint 和 JavaScript 类型检查；Vite 仅用于 Vitest 的模块转换。

## 开始

使用 Node 24.15.0 以上的 24 LTS（已在 24.22.0 验证）和 npm：

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

Windows 若 PowerShell 命中了不可用的 `npm.ps1`，可运行 `npm.cmd`。
本次环境的已安装 npm CLI 为 `D:/nodejs/node_modules/npm/bin/npm-cli.js`；
常规安装的 Node/npm 不依赖该路径。

已有 Chrome 可以通过 PowerShell 使用：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:e2e
```

`THRIVE_TEST_PORT` 可更换离线浏览器测试服务器端口，默认 4178。
`test:all` 执行全部门禁及浏览器测试；`test:watch` 用于开发循环；
`test:coverage` 生成终端摘要与 `coverage/` HTML。覆盖率是查缺依据，当前没有人为设置全仓百分比阈值。

提交 `package-lock.json`，用 `npm ci` 复现依赖。开发依赖集中在根包，不拆 workspace。

## 模块职责

```text
index.js                         SillyTavern 固定入口，加载 app/bootstrap
src/app/                         初始化、宿主事件、斜杠命令编排
src/core/                        limits、regex、diff 等纯算法
src/shared/                      文本工具、错误提示、Thrive 事件
src/features/learning/           学习触发、目标构造、队列和结果
src/features/session/            消息协议、预设展开、回复解析、私有工具、会话循环
src/features/prompts/            卡片、排序、有损预设导入
src/features/settings/           默认设置、迁移、聊天状态、读登记和备份
src/features/memory/             描述、世界书条目、草稿、patch、压缩
src/features/tools/              工具目录、可用性、读写处理和返回契约
src/platform/sillytavern/        宿主导入、传输、角色卡写入、元数据保存、世界书磁盘与编辑器
src/ui/                          按界面分组；panel、prompt-editor 将渲染与交互分开
```

`src/store.js`、`src/targets.js`、`src/tools.js` 是原平铺路径的兼容导出。
新代码直接引用对应 feature 内的具体模块或 `index.js`。兼容入口和 feature 入口只有转发；
feature 内部引用具体实现，避免自引用入口形成循环。

ESLint 的 `thrive/imports` 检查依赖方向：

- `core` / `shared` 保持底层，不导入业务、UI、app 或宿主适配。
- 业务模块通过接口调用其他业务模块和宿主适配，不导入 UI。
- 宿主适配不反向导入业务和 UI。
- 只有 `platform/sillytavern/` 能引用插件目录外的 SillyTavern 模块。
- 生产模块使用浏览器相对 ESM 路径，不引入 npm 运行时依赖。

目前仍用真实 `ctx` 作为角色与世界书操作接口；测试传入同形状的内存实现。
会话已经支持 `deps.probe/request`，学习编排测试替换会话模块。
计时器、日志继续使用浏览器原生能力，确需控制时用 Vitest fake timers / spy，
不为尚不存在的运行时变化增加一层转发接口。

JavaScript 类型检查先覆盖 `core`、共享文本工具和提示词排序；保留 JavaScript 和 JSDoc，
逐模块扩大 `jsconfig.json` 范围。`strict` 已开启，暂时允许未声明参数类型；
宿主动态对象和 UI 的全面类型化另作后续工作。

## 测试层次

| 位置 / 命令 | 验证内容 |
|---|---|
| `scripts/check-syntax.mjs` | 跨平台遍历维护中的 JS/MJS，排除依赖、报告和历史脚本 |
| `smoke-import.mjs` / `test:smoke` | 根入口与所有源模块链接、顶层求值、manifest 资源存在；宿主模块内存桩 |
| `tests/unit/` | 消息协议、回复解析、卡片排序和导入、正则、diff、上限、触发判据、编辑器同步 |
| `tests/integration/` | 设置迁移幂等、会话循环与初始化取消、队列、教授基线、工具读写守卫、描述存储和草稿提交 |
| `tests/e2e/` | Playwright 真实 Chrome/Chromium 加载插件入口与 CSS，操作真实 UI，使用离线宿主替身 |
| `.github/workflows/checks.yml` | 干净 npm 安装、静态检查、Vitest 覆盖率与 Chromium UI 测试 |

Vitest resolver 仅在测试中把宿主 `extensions.js` / `popup.js` 替换为 `tests/helpers/host.js`。
生产代码仍加载真正宿主。Node 测试的默认环境只有事件分发；需要真实 DOM 的单个文件用
`// @vitest-environment jsdom`。

根级 smoke 使用 Node 的实验性 VM Module 能力，命令中的 `--experimental-vm-modules` 是预期配置。
它不会执行入口的 jQuery ready 初始化，也不会进行动态宿主请求；UI 测试负责实际初始化。
浏览器替身会让所有宿主入口转发到同一个模块身份，模拟 settings/chat/worldbook/连接配置，
不读取用户账户、密钥和真实聊天。每项浏览器测试使用独立页面与内存数据，捕获未处理异常和控制台错误。

### 历史脚本迁移

重构期间的一次性验收脚本、截图和提交信息草稿曾集中在 `.workbuddy/`。有效行为全部迁入
维护套件后，这些文件已清理，目录只保留 `memory/` 的工作记录，仍在 `.gitignore` 中。
正式测试不执行也不读取其中任何文件。有效行为的去向：

- `draft-check.mjs` 的 12 个草稿/磁盘/恢复层次用例 → `tests/integration/draft.test.js`，保留行为断言。
- `session-check.mjs` 的协议、provider、工具执行、宏顺序、循环、中止和隔离场景
  → `tests/unit/session-protocol.test.js`；已删除的 scratch、ticket 和默认 stub preset 接口不迁入。
- `per-chat-store-check.mjs` 的跨聊天设置隔离，按当前统一学习语义重写。
- `desc-tests/` 的自动建书、保留条目、改名绑定和压缩路由场景 → `tests/integration/description-storage.test.js`。
- `limits-check.mjs`、`passive-check.mjs` 的有效数值和触发规则；
  旧主动/被动模式、trace、全局工具注册和聊天注入规则已经失效。
- Python/CDP 的核心 UI 和会话隔离场景由 `tests/e2e/` 重新表达。

旧脚本不做归档，也不再是验收依据；需要人工复核时按下面的真实宿主步骤现场做一次。
新增回归优先进入 Vitest 或 Playwright，避免继续扩充手写测试运行器和 Python/CDP 控制代码。

## 真实 SillyTavern 验收

离线浏览器替身不等于 SillyTavern 1.19.0 兼容认证。修改宿主适配、入口或 UI 后，
在用于测试的角色、聊天和世界书中验证：

1. 把仓库联接到 `public/scripts/extensions/third-party/thrive` 后刷新 ST，确认控制台初始化成功，
   设置页、徽章、面板和五个窗口正常，网络中所有 ESM 返回 200。
2. 编辑一条自建提示词并保存、取消新增、拖动卡片顺序、导入一份含 marker 的预设；
   关闭重开确认顺序和启停状态，目标内容的开始标记、注入位、结束标记仍以区块形式位于末尾。
3. 分别用当前聊天连接和指定连接配置学习；确认聊天消息不增加 Thrive 工具/提示词/日志，
   指定配置的请求不包含聊天预设，开始后改设置不改变本场连接。
4. 连点学习、停止、初始化期间停止、切换聊天；确认队列清空，没有继续发出旧聊天的学习请求。
   教授后聊天学习基线保持不变。
5. 修改世界书先出现在虚拟世界书，真实书保持原文；保存后编辑器刷新，外部改盘先报冲突，
   丢弃与恢复分别遵循快照层次。
6. 两种描述存储模式切换；角色卡暂存要确认，世界书描述只出现一次；角色改名后沿用含保留条目的绑定书。
   编辑框正输入时确认不会冲掉输入，显式“填入编辑框”才覆盖。
7. 在面板多选 PLists / Ali:Chat 并关闭自然文本，确认自动创建独立常驻条目、普通世界书工具不可见；
   新学习请求只带相应描述工具和用途卡。操作分类属性、插入/修改/删除问答后检查草稿与磁盘分离，
   再保存确认方括号文本和访谈标记均被 ST 正常注入。切回角色卡后结构化方式暂不生效，
   切回世界书恢复选择和正文；更换聊天后选择独立。三张用途卡可改正文，不能删或停用。

v0.39.0 的本地门禁新增了格式编解码、结构化工具 CRUD 与版本冲突、用途卡条件及面板多选的回归。
Chrome 测试运行离线宿主，不提供上述真实 ST 注入、真实模型调用或远端 CI 的验证结论。

本次本地验证使用 Node 24.22.0 / Windows 和无头 Chrome；上述真实宿主验收没有执行。
CI 工作流已加入仓库，远端运行结果待推送后确认。
