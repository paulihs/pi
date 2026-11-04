# 01 装配：从 `main()` 到第一次 prompt

校对基准：`main@2c8d1feb1`（v1.4.0 之后 288 个提交）。行号会漂移，用符号名搜索。

这一篇回答一个问题：敲下 `pi` 之后，在模型收到第一个请求之前，代码把哪些东西拼在了一起，每一层负责什么。

## 1. 核心代码地图

三层，依赖单向向下，每层只管自己那一段。

| 层 | 包 | 核心文件 | 行数 | 管什么 |
|---|---|---|---|---|
| 模型层 | `@earendil-works/pi-ai` | `packages/ai/src/types.ts` | 915 | provider/API 抽象、消息与事件协议 |
| | | `packages/ai/src/models.ts` | 1300 | 模型目录查询、`getModel(provider, id)` |
| | | `packages/ai/src/compat.ts` | 302 | `streamSimple` 等旧全局接口，装配层默认用它 |
| 循环层 | `@earendil-works/pi-agent-core` | `packages/agent/src/agent-loop.ts` | 959 | 一轮轮跑模型、执行工具、发事件 |
| | | `packages/agent/src/agent.ts` | 623 | 状态机、队列、订阅、生命周期 |
| | | `packages/agent/src/types.ts` | 539 | `AgentTool`、`AgentEvent`、`AgentLoopConfig` |
| | | `packages/agent/src/proxy.ts` | 395 | 把请求转给远端代理的 `StreamFn` |
| 装配层 | `@earendil-works/pi-coding-agent` | `packages/coding-agent/src/core/sdk.ts` | 481 | `createAgentSession()`，全部装配在这里 |
| | | `packages/coding-agent/src/core/agent-session.ts` | 4479 | 会话：持久化、扩展、压缩、工具装载 |
| | | `packages/coding-agent/src/core/system-prompt.ts` | 228 | 系统提示词分节与增量更新 |
| | | `packages/coding-agent/src/core/resource-loader.ts` | 1319 | 磁盘上找扩展/skill/AGENTS.md/主题 |
| | | `packages/coding-agent/src/core/tools/index.ts` | 224 | 8 个内置工具的工厂 |
| | | `packages/coding-agent/src/main.ts` | — | CLI 入口，选模式，注册内建扩展 |

关键点：`pi-agent-core` 不认识 provider，也不认识磁盘。它只有一个 `StreamFn` 函数指针。所有"真实世界"的东西都在装配层注入。

## 2. 装配时序

```
main.ts
  │  解析参数 → 选模式（interactive / rpc / json / print）
  │  extensionFactories = [llama.cpp, codemode, tool-search, mcp]
  ▼
createAgentSession(options)                      sdk.ts:191
  │
  ├─ ModelRuntime.create({authPath, modelsPath})     读 ~/.pi/agent/auth.json + models.json
  ├─ SettingsManager.create(cwd, agentDir)          读 settings
  ├─ SessionManager.create(cwd, sessionDir)         读/建 JSONL 会话文件
  ├─ new DefaultResourceLoader({cwd, agentDir, settingsManager})
  │    └─ reload()  → extensions / skills / prompts / themes / AGENTS.md
  ├─ sessionManager.buildSessionContext()            有旧会话就把 messages 取出来
  ├─ findInitialModel(...)                           决定 model
  ├─ 计算 thinkingLevel（会话 > 每模型覆盖 > 全局 > clamp）
  ├─ 计算初始工具名集合（tools / noTools / excludeTools / +name -name）
  │
  ├─ new Agent({ ... })                          sdk.ts:403
  │    initialState: { systemPrompt: "", model, thinkingLevel, tools: [], messages }
  │    convertToLlm / streamFn / transformContext / onPayload / hooks
  │
  └─ new AgentSession({ agent, ... })            sdk.ts:455
       │
       ├─ agent.subscribe(this._handleAgentEvent)     持久化 + 扩展 + 压缩都挂在事件上
       ├─ _installAgentToolHooks()                    beforeToolCall / afterToolCall
       ├─ _installAgentNextTurnRefresh() 等 5 个钩子
       └─ _buildRuntime({ activeToolNames })
            ├─ runner = new ExtensionRunner(...)
            ├─ _refreshToolRegistry()                内置 + 扩展 + customTools 合并
            ├─ _rebuildSystemPrompt()                组织 section 原料
            └─ _applyToolLoadout()                   this.agent.state.tools = declared
```

`bindExtensions()` 是第三步，发生在模式层拿到 session 之后。它做三件事：注入 UI/命令上下文、`emit(session_start)`、`extendResourcesFromExtensions()`（扩展可以再贡献 skill/prompt/theme 路径）。MCP 的连接就发生在 `session_start`。

## 3. `createAgentSession` 逐段读

### 3.1 先定六个对象

```ts
const modelRuntime  = options.modelRuntime ?? await ModelRuntime.create({ authPath, modelsPath });
const settings      = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
const sessions      = options.sessionManager ?? SessionManager.create(cwd, sessionDir);
const resourceLoader = options.resourceLoader ?? new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();
```

四个都是可注入的。SDK 用户想完全控制磁盘行为时，替换 `resourceLoader` 和 `sessionManager` 就够了，不用改 `createAgentSession` 本身。`sdk.ts:48` 的 `CreateAgentSessionOptions` 是全部可调项的清单。

`DefaultResourceLoader.reload()` 是唯一接触磁盘资源的地方：扩展文件、skill 目录、prompt 模板、主题、`AGENTS.md`（`getAgentsFiles()`）。它产出的东西后面全部通过 `get*()` 取出。

### 3.2 模型与思考等级是"恢复优先"

顺序是：会话里有 `model_change` 条目就用它 → 否则 `findInitialModel()` 看设置里的默认 → 都没有就报 "no models available"。

思考等级同样三级回退，最后一定过一遍 `clampThinkingLevel(model, level)`，因为不同模型的思考档位不一样。

### 3.3 工具装载有三个入口

```ts
const defaultToolNames = options.noTools ? [] : (settings.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
```

- `tools: ["read", "bash"]` 是白名单，只留这两个。
- `tools: ["+mcp__docs", "-bash"]` 是增量调整，在默认集合上加减。
- `noTools: "builtin"` 关掉内置四件套但保留扩展工具。

这里只算出"名字集合"，真正的工具对象在 `AgentSession._applyToolLoadout()` 里生成。

### 3.4 构造 Agent

`Agent` 的构造函数只收一个 `AgentOptions`。注意 `initialState.systemPrompt` 传的是空字符串：

```ts
const agent = new Agent({
  initialState: { systemPrompt: "", model, thinkingLevel, tools: [], messages: existingSession.messages },
  convertToLlm: convertToLlmWithBlockImages,
  streamFn: async (model, context, options) => { ... modelRuntime.streamSimple(...) },
  ...
});
```

空字符串会在 Agent 里生成一条"什么都没有"的系统消息。真正的提示词不是在这里写的，而是稍后由 `AgentSession` 以 `SystemMessage.sections` 的补丁形式追加进 transcript。这样做的原因在 §5。

`streamFn` 是唯一出口：它包了 `buildRequestOptions()`（超时、重试、identity、`before_provider_headers` 扩展钩子），再调 `modelRuntime.streamSimple()`。`CacheWarmer` 也挂在这里，同一个 `sessionId` 的请求才会触发预热。

### 3.5 构造 AgentSession

`AgentSession` 才是"产品"。它拿到 agent 之后立刻做三件事（`agent-session.ts:527` 起）：

1. `agent.subscribe(this._handleAgentEvent)` — 所有 agent 事件都从这里过，负责写会话条目、转发给扩展、触发自动压缩。
2. `_installAgentToolHooks()` — 把 `beforeToolCall`/`afterToolCall` 接到扩展的 `tool_call`/`tool_result` 事件上。注释明确写了：工具调用拦截现在在 AgentSession 里，不在 wrapper 里。
3. `_buildRuntime()` — 建扩展 runner，合并工具注册表，组织提示词。

## 4. 工具注册表是"定义优先"的

`_refreshToolRegistry()`（`agent-session.ts:3576`）做的是合并：

```
_baseToolDefinitions（内置 8 个，definition 形态）
        │
        ├─ runner.getAllRegisteredTools()（扩展 registerTool 的）
        ├─ this._customTools（SDK 传进来的 ToolDefinition[]）
        ▼
  definitionRegistry  ──►  ToolDefinition（给提示词、给 UI、给校验）
        │
        └─ wrapRegisteredTools(..., runner)  → AgentTool（给 agent loop 执行）
```

两层对象不是重复：

- `ToolDefinition` 是"人类和提示词关心的定义"：`label`、`promptSnippet`、`promptGuidelines`、`renderCall`、`exposure`、`namespace`。
- `AgentTool` 是"agent loop 需要的执行体"：`execute(toolCallId, params, signal, onUpdate)`。

`wrapToolDefinition()` 把后者从前者派生出来，并把 `runner.createToolContext()` 注入进去，所以扩展工具能拿到 `ctx.executeTool()`、`ctx.ui` 等。

最后一步 `_applyToolLoadout()`（`agent-session.ts:1614`）过滤掉 `hidden` 暴露级别的工具、跑 `prepareLoadout` 钩子、再把结果赋给 `this.agent.state.tools`。**只有走到这一步的工具才会被模型看到。**

## 5. 系统提示词为什么是"补丁"而不是字符串

`buildSystemPromptSections()`（`system-prompt.ts:128`）把提示词拆成有名字的段：

| section | 内容 |
|---|---|
| `preamble` | "You are a coding assistant running inside pi..."（或 `customPrompt`） |
| `tools` | `- read: ...` 每个工具一行 snippet |
| `rules` | 工具贡献的 guideline + 通用规则 |
| `docs` | readme/docs/examples 的绝对路径 |
| `addendum` | `appendSystemPrompt` 用户追加的 |
| `project_context` | `<project_instructions path="...">`，来自 AGENTS.md |
| `skills` | `<available_skills>` 索引 |
| `cwd` | 工作目录 |

除 `preamble` 外，每段被包成 `<name>...</name>`。

真正发给模型的是 `SystemMessage`：`content: ""`，`sections: {...}`。想改提示词时，`_preparePromptAndToolLoadout()` 调 `diffSystemPromptSections(当前 sections, 新的 sections)`，只把变化的段作为新的一条 system 消息追加：

```ts
{ role: "system", content: "", sections: { rules: "..." }, timestamp: ... }
```

`pi-ai` 回放 transcript 时会把所有 system 消息的 sections 依次合并，得到当前完整提示词。这样做的收益：改一段提示词不会让整个 prompt 前缀失效，provider 的 prompt cache 能继续命中。删除一段则发 `null`。

`diffSystemPromptSections()` 在 `system-prompt.ts:216`，逻辑就是"新增/变更设值，消失设 null，无变化返回 undefined"。

## 6. 一次请求的数据流

```
用户输入
  │
  ▼
AgentSession.prompt(text)                     agent-session.ts:2113
  ├─ 以 / 开头 → 先试扩展命令
  ├─ _runInputHandlers()（扩展 input 事件可改写输入）
  ├─ 展开 prompt 模板 / skill 引用
  ├─ 写一条 user 条目到 session
  ▼
agent.prompt([message])
  │
  ▼
runLoop()                                     agent-loop.ts
  ├─ getSteeringMessages() 取插队消息
  ├─ prepareNextTurn() 可换 model/thinking
  ├─ declareToolChanges() 工具集变化 → 一条 system 消息
  ├─ prepareRequest()
  ├─ turn_start
  ▼
streamAssistantResponse()
  ├─ transformContext(messages)        ← 扩展 context 事件
  ├─ convertToLlm(messages)            ← 自定义消息在这里被过滤
  ├─ normalizeContext()                ← 折成 leading system message
  ├─ streamFn(model, context, opts)    ← 就是你注入的那个
  ▼
provider（SSE/WebSocket）
  │  每个 delta 触发 message_update，partial 直接写进 messages 末尾
  ▼
message_end（拿到完整 AssistantMessage）
  ├─ stopReason = toolUse → 执行工具
  │    ├─ prepareToolCall：找工具、prepareArguments、schema 校验
  │    ├─ beforeToolCall → 扩展 tool_call（可 block）
  │    ├─ execute（串行或并行，看 executionMode）
  │    ├─ afterToolCall → 扩展 tool_result（可改内容）
  │    └─ 生成 toolResult 消息，回到 runLoop 下一轮
  └─ stopReason = stop → agent_end
  ▼
AgentSession._handleAgentEvent()
  └─ 条目落盘（JSONL）+ 转发扩展事件 + 检查是否需要压缩
```

## 7. 模式层只是消费者

`interactive`、`rpc`、`json`、`print` 四种模式都调同一个 `createAgentSession`，区别只在 `bindExtensions()` 传进去的 UI 上下文：

- interactive：TUI 组件、键盘、编辑器、状态栏。
- rpc：JSON 行协议，UI 在外部进程（VS Code 扩展、Web 前端）。
- json/print：不绑 UI，只输出事件。

所以做 Web 端时，最省事的路线是复用 rpc 模式，或者直接用 SDK + 自己的 `bindExtensions()`。

## 8. 自己验证

```bash
# 装配入口
sed -n '191,260p' packages/coding-agent/src/core/sdk.ts

# 工具注册表合并
sed -n '3576,3660p' packages/coding-agent/src/core/agent-session.ts

# 提示词分节
sed -n '128,192p' packages/coding-agent/src/core/system-prompt.ts

# 谁调用了 createAgentSession
grep -rn "createAgentSession(" packages/coding-agent/src --include=*.ts
```
