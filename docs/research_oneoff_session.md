# 调研 · 一次性内部会话（预设 + 工具调用）

适用 SillyTavern **1.19.0**（本机快照 `E:/tavern/SillyTavern`）· 调研日期 2026-11-09

> 本文件是**调研记录**，不是规范，也不含设计方案或决策。
> 只记录"ST 现在长什么样、哪些能直接拿、哪些不能拿、拿了要付什么代价"，供实现时查证。
> **所有行号对应上面这一份快照**，ST 升级后会漂，引用前先核对。

---

## 0. 需求与给定约束

**原始诉求**：给插件加一次性会话（总结、压缩等用途）。要求支持 ST 原生预设以便用户自定义提示词；支持函数调用；不显示、不持久化、不接受用户输入，仅供插件内部使用。

**后续给定的约束**（用户明确，作为调研前提）：

- 插件的预设**不支持触发器**，位置**只支持相对**（不需要 in-chat depth / order）；
- 导入 ST 预设**允许有损**，不要求与 ST 行为一致；
- 尽量复用**没有副作用**的部分，插件只做最小拼装与修补。

---

## 1. 事实摘要

1. ST 现成的三条一次性生成通道，**没有任何一条同时具备"预设提示词栈 + 函数调用"**。
2. 组件层面存在一组**纯内存**的导出件（`ChatCompletion` / `Message` / `MessageCollection` / `TokenHandler`），覆盖消息组装与 token 预算。
3. `quiet` 类型被 ST **硬性排除**在工具调用之外；但 `tools` 可以借 `CHAT_COMPLETION_SETTINGS_READY` 事件塞进请求体。
4. **provider 适配在服务端完成**：客户端只需产出 OpenAI 形状的 `tools` 与工具消息。
5. 预设的"纯逻辑"（条目模型 + 顺序）不到 300 行，ST 组装逻辑的大头是通用于 RP 场景的部分（角色、群聊、示例、媒体、续写），与内部会话无关。

---

## 2. 三条现成通道的能力边界

| 通道 | 位置 | 预设提示词栈 | 只注历史 | 函数调用 | UI / 持久化 | 副作用 |
|---|---|---|---|---|---|---|
| `generateQuietPrompt` | script.js:3084 | ✅ 完整 | ❌ 继承全部扩展注入 | ❌ 硬禁 | 无 | 发 `GENERATION_*`；共用全局 `abortController`，结束调 `unblockGeneration`（script.js:5693） |
| `generateRaw` / `generateRawData` | script.js:4122 / 4000 | ❌ 只走 `createRawPrompt` | ✅ 自己给 messages | ⚠️ 默认不发，可钩事件塞 | 无 | 只 emit 两个 PROMPT/SETTINGS 事件 + 一次 fetch |
| `prepareOpenAIMessages` | openai.js:1542 | ✅ 完整 | ✅ 可传空 source | —（只组装不发送） | 会重渲染设置面板 | 见 §3 |
| `ChatCompletionService.processRequest` | custom-request.js:544 | ❌ 只带采样参数 | ✅ 自己给 messages | ✅ 可传 tools | 无 | 需自己拼 model / 后处理 |

### 2.1 `quiet` 与工具为什么互斥

```js
// tool-calling.js:694
static canPerformToolCalls(type, settings = null, model = null) {
    const noToolCallTypes = ['impersonate', 'quiet', 'continue'];
    return isSupported && !noToolCallTypes.includes(type);
}
```

即使绕过这道门把 `tools` 发出去，响应也接不住：

```js
// script.js:5526 —— 非流式在"工具调用处理块"之前就 return 了
} else if (type == 'quiet') {
    unblockGeneration(type);
    return getMessage;
}
```

另外两个相关事实：

- `quiet` **不走流式**：`script.js:5385` `if (isStreamingEnabled() && type !== 'quiet')`；
- `quiet` 的 `skipWIAN` 只跳过世界书与作者注释（`script.js:4664`），**人设描述仍在**（`openai.js:1434` 用 `power_user.persona_description` 直接构造，参数关不掉）。

### 2.2 `generateRawData` 的形状

- `createRawPrompt`（script.js:3924）只做 `substituteParams` + 拼接，**不读预设的 prompts**；
- 内部调用 `sendOpenAIRequest('quiet', …)`（script.js:4077），返回**原始 JSON**，`tool_calls` 完好；
- 会 emit `CHAT_COMPLETION_PROMPT_READY` 与 `CHAT_COMPLETION_SETTINGS_READY`。

### 2.3 `processRequest` 的 preset 只到采样参数

```js
// custom-request.js:575 presetToGeneratePayload
const settings = structuredClone(oai_settings);
for (const [key, value] of Object.entries(preset)) { … }   // 只映射 settingsToUpdate 里的字段
const data = await createGenerationParameters(settings, overridePayload.model, 'quiet', overridePayload.messages);
```

即：**预设的 sampler 生效，预设的 prompt 列表不生效**（prompt 列表是客户端 `promptManager` 拼的，不经过这里）。

---

## 3. 无副作用复用审计

判据：不写 `chat`、不写 `extension_settings` / `oai_settings`、不碰 DOM、不 emit `GENERATION_*`。

| 复用项 | 位置 | 读 | 写 | 判定 |
|---|---|---|---|---|
| `ChatCompletion` | openai.js:3917（`export class`，~350 行） | — | 自身预算与集合 | 纯内存 |
| `Message` | openai.js:3511（~295 行） | ST 全局 `tokenHandler` | 给其 `counts` 加 `undefined: NaN` 键 | 近似纯，污染无害（`getTotal` 过滤 `isNaN`） |
| `MessageCollection` | openai.js:3808（~108 行） | — | 自身 collection | 纯内存 |
| `TokenHandler` | openai.js:3420（~57 行） | — | 自身 counts | 纯记账 |
| `sendOpenAIRequest` | openai.js:3138 | `oai_settings` | emit `CHAT_COMPLETION_SETTINGS_READY` + 一次 fetch | 唯一外泄，可当钩子 |
| `countTokensOpenAIAsync` | tokenizers.js:846（export） | 缓存 | 缓存 + `POST /api/tokenizers/openai/count` | 只读外部；有内容哈希缓存 |
| `substituteParams` | `ctx` / script.js | 宏上下文 | — | 纯 |
| `Prompt` / `PromptCollection` | PromptManager.js:80 / 201（均 export） | — | — | 纯数据，无 DOM |

**导出入口**：`openai.js:86` 的 export 块包含 `TokenHandler`、`Message`、`MessageCollection`、`sendOpenAIRequest`；`ChatCompletion` 在 3917 单独 `export class`。四者可在同一条 import 里拿到。

**同类中确认"不能当纯内存用"的**：

- `prepareOpenAIMessages`（openai.js:1542）：`finally` 里 `promptManager.setChatCompletion()`（1606）、`promptManager.render(false)`（1613），还会覆写全局 `openai_messages_count`（1621）并 emit `CHAT_COMPLETION_PROMPT_READY`（1619）。
- `ToolManager.parseToolCalls`（tool-calling.js:427）：函数体第一行 `if (!this.isToolCallingSupported()) return;`，**结果完全由全局设置决定**。
- `ToolManager.invokeFunctionTools`（tool-calling.js:786）：每次调用弹 `toastr.info(…, timeOut: 0)`（811）；`saveFunctionToolInvocations`（899）会 `chat.push` + `addOneMessage` + `saveChatConditional`。
- `PromptManager`（PromptManager.js:300）：需要 DOM 容器、弹窗 id、`tryGenerate`、`serviceSettings`，见 §8。

---

## 4. 预设数据模型实测

### 4.1 顶层字段

| 预设文件 | 顶层字段数 | `prompts` | `prompt_order` 组 |
|---|---|---|---|
| `default/content/presets/openai/Default.json` | 62 | 12 | 2（`character_id` 100000 / 100001） |
| `data/default-user/OpenAI Settings/Test.json` | 76 | 12 | 2 |
| `data/default-user/OpenAI Settings/简单预设_V2.0.json` | 46 | 52 | 1 |
| `data/default-user/OpenAI Settings/Tavo_简单预设_V2.0_1LOCI.json` | 11 | 53 | 1 |

**60 个左右的字段与提示词无关**（模型名、代理、bias 预设、`continue_postfix`、`names_behavior` 等）。真正与"提示词"有关的只有 `prompts` 与 `prompt_order`。

### 4.2 prompt 条目字段

默认预设的字段并集只有 6 个：`identifier / name / content / role / system_prompt / marker`。

真实在用的中文预设额外出现 6 个：`enabled / injection_position / injection_depth / injection_order / injection_trigger / forbid_overrides`。

`Prompt` 类（PromptManager.js:182）接受的全部字段：

```
identifier, role, content, name, system_prompt, position,
injection_depth, injection_position, forbid_overrides,
extension, injection_order, injection_trigger
```

注意 `enabled` **不在 `Prompt` 上**，它只存在于 `prompt_order[].order[]` 的条目里；但真实预设里 `prompts` 条目自身也可能带一个 `enabled`（两份并存，实测存在）。

### 4.3 `简单预设_V2.0` 的注入参数分布（52 条）

| 维度 | 分布 |
|---|---|
| `injection_position` | 相对（0）：52 / 绝对（1）：0 |
| `role` | system 48 / user 2 / assistant 2 |
| `system_prompt` | true 12 / false 40 |
| `injection_trigger` | `[]` 20 / 缺省 32（无按生成类型限定） |
| `injection_depth` | 全部 4（但 position 为 0，不生效） |
| `injection_order` | 全部 100 |
| `marker` | 8 条 |

**常被误读的一点**：`system_prompt` **不是"注入位置"开关**。`system_prompt: true` 的 12 条正好是内建 source（`main` / `nsfw` / `jailbreak` / `worldInfo*` / `charDescription` / `charPersonality` / `scenario` / `personaDescription` / `enhanceDefinitions` / `dialogueExamples` / `chatHistory`），各有专门的内容来源与添加点；`system_prompt: false` 的 40 条自定义条目走通用循环添加（openai.js:1242-1257）。**两类条目最终在 messages 里的位置都由 `prompt_order` 的下标决定**——`ChatCompletion.add(collection, prompts.index(id))`。

真正决定"插进对话第几条"的是 `injection_position: 1`（绝对注入），而这份预设里一条都没有；`injection_depth: 4` / `injection_order: 100` 因为没有绝对位置而**不生效**。

---

## 5. ST 组装逻辑的构成

| 环节 | 位置 | 规模 | 与"只相对位置 + 无触发器"的关系 |
|---|---|---|---|
| `Prompt` / `PromptCollection` | PromptManager.js:80 / 201 | ~300 | 数据模型，与位置无关 |
| `getPromptCollection` 顺序解析 | PromptManager.js:1516 | 25 | 直接相关 |
| `preparePromptsForChatCompletion` | openai.js:1367 | ~150 | 把 marker 换成 source 内容 |
| `populateChatCompletion` | openai.js:1185 | ~160 | 顺序 → 消息 |
| `populationInjectionPrompts`（绝对注入） | openai.js:810 | ~60 | **不需要**（约束里没有绝对位置） |
| `populateChatHistory`（预算裁剪） | openai.js:885 | ~150 | 相关，但大部分分支是媒体/示例/续写 |
| `ChatCompletion`（预算 + 插入 + 展平） | openai.js:3917 | ~350 | 可直接复用 |
| 角色级 order、覆写、群聊、示例、媒体、squash | 各处 | ~500 | **不需要** |

### 5.1 绝对注入的算法（事实记录）

`populationInjectionPrompts`（openai.js:810）：

```
for depth = 0 .. getExtensionPromptMaxDepth():        // 上限 10000（script.js:500）
    取该 depth 的 prompts → 按 injection_order 倒序分组
    每组内按 system → user → assistant 归并成一条
    messages.splice(depth + 已插入条数, 0, ...roleMessages)
```

附注：`MAX_INJECTION_DEPTH = 10000`（script.js:500），所以这个循环在**每次生成**都会跑 10001 次、每次都 `filter` 一遍 prompts。这是 ST 已有的固定开销；不需要绝对位置时不涉及。

### 5.2 相对顺序的语义

`ChatCompletion.add(collection, position)`（openai.js:3998）只是 `messages.collection[position] = collection`，`position` 就是该 prompt 在有序集合中的下标。展平由 `getChat()`（3832）完成，输出形如 `{role, content, name?, tool_calls?}` —— 与 API 请求体的 messages 同构。

---

## 6. 工具调用链

### 6.1 `tool-calling.js`（1175 行）构成

| 部分 | 位置 | 规模 | 与"插件私有工具层"的关系 |
|---|---|---|---|
| `ToolDefinition` + 注册/反注册/调用 | 240-400 | ~250 | 可借鉴；不能直接用（全局单例 + `shouldRegister` 门控） |
| 响应解析（含流式增量合并） | 427-770 | ~310 | 非流式可只留 4 个分支 |
| `invokeFunctionTools` | 786 | ~70 | 循环结构可借鉴；副作用不可用 |
| 渲染 / toastr / slash 命令 | 807-940 | ~250 | 不需要 |
| 门控（`isToolCallingSupported` 等） | 614-700 | ~100 | 需要绕开的对象本身 |

`RECURSE_LIMIT = 5`（tool-calling.js:255），由 `oai_settings.tool_call_recurse_limit` 覆盖（openai.js:4399）。

### 6.2 服务端承担 provider 转换（关键事实）

客户端只产出 OpenAI 形状就能支持多家：

```js
// Claude：chat-completions.js:289-300
requestBody.tools = request.body.tools
    .filter(t => t.type === 'function')
    .map(t => t.function)
    .map(fn => ({ name: fn.name, description: fn.description, input_schema: flattenSchema(fn.parameters, source) }));

// Gemini：chat-completions.js:565-600 —— 同理转 functionDeclarations
```

连工具消息也会被转：

```js
// prompt-converters.js:197 convertClaudeMessages
if (message.role === 'assistant' && message.tool_calls) { /* → tool_use 块 */ }
if (message.role === 'tool') { /* → tool_result 块，role 改成 user */ }
```

**结论（事实）**：请求侧不需要写 provider adapter；响应侧需要。

### 6.3 响应侧四种形态

`ToolManager.#getToolCallsFromData`（tool-calling.js:707，私有方法）覆盖：

| 来源 | 取法 |
|---|---|
| OpenAI 兼容 | `data.choices[0].message.tool_calls` |
| Claude | `data.content[]` 中 `input && name && id` 的块 |
| Gemini / Vertex | `parts[]` 中 `functionCall`（`name && args`） |
| Cohere | `data.message.tool_calls`（对象或数组） |

### 6.4 签名与推理回传

- `ToolInvocation` 带 `signature` / `reasoning`（tool-calling.js:16-28）；
- `Message.setToolCalls(invocations, includeSignature, includeReasoning)`（openai.js:3575）把它们写回 `tool_calls[].signature`；
- 是否需要由 `isReasoningSignatureSupported()`（openai.js:6476）与 `tool_reasoning_modes` 决定。
- 该字段存在本身说明上游对签名有依赖；**具体哪些来源强制要求、缺失时报错还是丢推理，代码里没有表达**，只能按实际使用的来源验证。

---

## 7. 传输层

`sendOpenAIRequest(type, messages, signal, { jsonSchema })`（openai.js:3138）的行为：

1. `createGenerationParameters(oai_settings, model, type, messages)` —— **继承当前设置的全部采样参数、停止串、模型、后处理**；
2. `eventSource.emit(CHAT_COMPLETION_SETTINGS_READY, generate_data)`（3146）—— **扩展可在此改 payload**；
3. `POST /api/backends/chat-completions/generate`；
4. 非流式返回原始 JSON（含 `tool_calls`）。

关键一行：

```js
// openai.js:2785
const stream = settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;
```

**`type='quiet'` 永远非流式**，所以返回的必然是完整 JSON。同时 `quiet` 还会跳过 Claude `assistant_prefill`（2877）、logprobs 落库（3202）、Fireworks `chat_id`（2901）。

---

## 8. 可视化编辑器能否复用 `PromptManager`

### 8.1 支持复用的证据

`PromptManager`（PromptManager.js:300）的构造配置可替换：

```js
// openai.js:684
const configuration = {
    prefix: 'completion_',
    containerIdentifier: 'completion_prompt_manager',
    listIdentifier: 'completion_prompt_manager_list',
    sortableDelay: …,
    promptOrder: { strategy: 'global', dummyId: 100001 },
};
promptManager.init(configuration, oai_settings);
```

`init(moduleConfiguration, serviceSettings)`（432）接受任意 `serviceSettings`（只要含 `prompts` / `prompt_order`）。列表、表头、表尾三个模板**已用 `{{prefix}}` 参数化**：

- `scripts/templates/promptManagerHeader.html` → `id="{{prefix}}prompt_manager_list"`
- `scripts/templates/promptManagerListHeader.html`
- `scripts/templates/promptManagerFooter.html`

### 8.2 复用的实际代价

| 依赖 | 现状 |
|---|---|
| 样式 | `css/promptmanager.css` **377 行，68 处硬编码 `#completion_prompt_manager` 前缀** |
| 弹窗 DOM | `index.html:7276-7391`，**116 行**，非模板，硬编码 `completion_prompt_manager_popup_*` 与 `…_entry_form_*` |
| 类内部 import | `script.js`（`event_types` / `is_send_press` / `main_api` / `substituteParams`）、`group-chats.js`（`is_group_generating`）、`openai.js`（`Message` / `MessageCollection` / `TokenHandler`）、`power-user.js`、`RossAscends-mods.js`（`isMobile`）、`templates.js`、`popup.js` |
| 外部注入 | `tryGenerate`、`saveServiceSettings`、`handle*` 系列 |

即：逻辑可复用，但要连带 377 行 CSS + 116 行 HTML + 对 2144 行类的运行时依赖。

### 8.3 插件侧已有资产（事实）

| 文件 | 行数 | 已具备 |
|---|---|---|
| `src/ui/settings/prompt-cards.js` | 335 | jQuery UI sortable 拖动排序、编辑弹窗、顺序持久化、状态角标、统计行 |
| `src/prompt-order.js` | 111 | 卡片 id 常量、顺序规范化、按分界线切 head/tail |
| `src/prompt.js` | 564 | 卡片 → 注入文本、宏展开、卡片状态 |
| `settings.html` | 429 | 设置页骨架（经 `renderExtensionTemplateAsync('third-party/thrive','settings')` 载入） |

---

## 9. 导入兼容的字段级事实

- **数据来源**：`openai_settings`（全部预设对象数组）与 `openai_setting_names`（名称 → 下标）已在客户端内存里（openai.js:531-532，赋值在 4321-4322）。导入不需要走后端、不需要读磁盘。
- **丢弃项**（与约束一致）：`injection_trigger`、`injection_position`、`injection_depth`、`injection_order`、`forbid_overrides`、`prompt_order` 的角色分组（只保留全局一组）。
- **替换项**：`worldInfoBefore` / `worldInfoAfter` / `charDescription` / `charPersonality` / `scenario` / `personaDescription` / `dialogueExamples` / `chatHistory` 这些 `marker` 条目，在 ST 里代表"内容来自哪里"；插件侧没有这些来源。
- **保留项**：40+ 条自定义 `identifier` 与正文（这些才是用户真正在调的东西）。
- **`enabled` 的双份**：`prompt_order[].order[].enabled` 与条目自身的 `enabled` 都可能存在（实测两种都有），ST 以 order 为准（`getPromptCollection`，PromptManager.js:1516）。
- **采样参数**：预设里 40+ 个字段，与生成相关的是 `temperature / top_p / frequency_penalty / presence_penalty / openai_max_context / openai_max_tokens / stop` 一小撮。

---

## 10. 已知坑（有证据）

| # | 坑 | 证据 |
|---|---|---|
| 1 | `ChatCompletion.checkTokenBudget` 会抛 `TokenBudgetExceededError`（强制 prompt 装不下时），不 catch 会冒到调用方 | `checkTokenBudget` 在 openai.js:4199；错误类在 3493 |
| 2 | `Message.createAsync` 用的是**模块级** `tokenHandler`，不是注入的实例；会给 ST 的 counts 增加 `undefined: NaN` 键 | openai.js:3558、3482 |
| 3 | `quiet` 被排除在 `canPerformToolCalls` 之外，`tools` 只能靠 `CHAT_COMPLETION_SETTINGS_READY` 注入 | tool-calling.js:697、openai.js:3146 |
| 4 | `quiet` 非流式在工具处理前 return，工具调用会被静默丢弃 | script.js:5526 |
| 5 | `prepareOpenAIMessages` 有 UI 副作用（render + 全局计数），`dryRun=true` 时无角色会直接返回 `[null,false]` | openai.js:1561、1613、1621 |
| 6 | `processRequest` 传 `presetName` 只带 sampler，不带 prompt 列表 | custom-request.js:575-605 |
| 7 | `system_prompt` 不是位置开关：true/false 两类条目的消息位置都由 `prompt_order` 下标决定，区别只在"内容从哪来" | openai.js:1242-1257、3998 |
| 8 | 绝对注入每轮跑 `MAX_INJECTION_DEPTH(=10000)` 次循环 | script.js:500、openai.js:810 |
| 9 | `generateQuietPrompt` 与主生成共用**同一个全局** `abortController`（script.js:630、4303），结束时 `unblockGeneration` 会把 `is_send_press` 置 false；只有"并行流仍在本轮"时有护栏 | script.js:5693-5697 |

---

## 11. 未决问题（调研到此为止，未做取舍）

1. 会话提示词卡片集与主对话注入卡片集是否共用一份存储与顺序表。
2. 工具循环中的签名 / 推理回传：默认关、默认开，还是按 provider 自动判定。
3. 传输层用 `sendOpenAIRequest('quiet', …)` + 事件钩子，还是直接 `fetch` 该端点自行拼 payload（后者可控但要自己带全部采样字段与后处理）。
4. 导入是一次性快照，还是每次读取 ST 当前预设（影响长期同步策略）。
5. 是否需要"预演"视图（展示最终 messages）以降低与 ST 的行为差异带来的困惑。

---

## 12. 参考坐标索引

| 主题 | 文件:行 |
|---|---|
| `generateQuietPrompt` | `public/script.js:3084` |
| `generateRaw` / `generateRawData` | `public/script.js:4122` / `4000` |
| `createRawPrompt` | `public/script.js:3924` |
| quiet 非流式 return | `public/script.js:5526` |
| quiet 不走流式 | `public/script.js:5385` |
| `stream` 判定（含 quiet） | `public/scripts/openai.js:2785` |
| `prepareOpenAIMessages` | `public/scripts/openai.js:1542` |
| `preparePromptsForChatCompletion` | `public/scripts/openai.js:1367` |
| `populateChatCompletion` | `public/scripts/openai.js:1185` |
| `populationInjectionPrompts` | `public/scripts/openai.js:810` |
| `populateChatHistory` | `public/scripts/openai.js:885` |
| `sendOpenAIRequest` | `public/scripts/openai.js:3138` |
| `createGenerationParameters` | `public/scripts/openai.js:2691` |
| `TokenHandler` / `Message` / `MessageCollection` / `ChatCompletion` | `public/scripts/openai.js:3420` / `3511` / `3808` / `3917` |
| `openai.js` 导出块 | `public/scripts/openai.js:86` |
| `openai_settings` 赋值 | `public/scripts/openai.js:4321` |
| `tool-calling.js` 门控 | `public/scripts/tool-calling.js:614` / `694` / `697` |
| `ToolManager` 注册与调用 | `public/scripts/tool-calling.js:269` / `297` / `325` / `786` |
| `#getToolCallsFromData` | `public/scripts/tool-calling.js:707` |
| `Prompt` / `PromptCollection` / `PromptManager.init` | `public/scripts/PromptManager.js:80` / `201` / `432` |
| `getPromptCollection` | `public/scripts/PromptManager.js:1516` |
| `processRequest` / `presetToGeneratePayload` | `public/scripts/custom-request.js:544` / `575` |
| `countTokensOpenAIAsync` | `public/scripts/tokenizers.js:846` |
| 提示词管理器样式 | `public/css/promptmanager.css`（377 行） |
| 提示词管理器弹窗 DOM | `public/index.html:7276-7391`（116 行） |
| Claude tools 转换 | `src/endpoints/backends/chat-completions.js:289-300` |
| Gemini tools 转换 | `src/endpoints/backends/chat-completions.js:565-600` |
| `convertClaudeMessages` | `src/prompt-converters.js:197` |
| 预设样本 | `default/content/presets/openai/Default.json`、`data/default-user/OpenAI Settings/*.json` |
