# pi 架构笔记

校对至 v1.4.0 之后的主干（`2c8d1feb1`，2026-11-01）。行数为 `packages/*/src` 的 TypeScript 总量，用于判断模块权重。

## 0. 速览

pi 不是一个单体 agent，而是四层加一圈外围：

| 层 | 包 | 体量 | 职责 |
|---|---|---|---|
| 模型访问 | `@earendil-works/pi-ai` | 28,565 行 | 统一各家 API 的请求/流式协议、模型目录、重试与溢出判定 |
| 循环 | `@earendil-works/pi-agent` | 2,541 行 | 一次对话的 turn 循环、工具批处理、steering/follow-up、事件流 |
| 持久化运行时 | `@earendil-works/pi-durable` | 33,594 行 | 事务化会话、任务调度、崩溃恢复、压缩、文档与视图同步 |
| 组合层 | `@earendil-works/pi-coding-agent` | 77,235 行 | 把上面三层装配成 CLI/SDK/RPC，连同工具、扩展、设置、资源发现 |

外围：`pi-codemode`（沙箱 JS 调工具，3,037 行）、`pi-env`（远程执行环境，2,390 行）、`pi-mcp`（3,287 行）、`pi-chord`（49,698 行，状态复制与 RPC 运行时）、`pi-schema`（3,702 行）、`pi-telemetry`（1,572 行）、`pi-tui`（19,882 行）、`pi-evals`（1,447 行）。

三条主线值得先记住：

1. **transcript 是唯一真相。** system prompt、可用工具、上下文都不是某个对象的字段，而是从消息历史回放出来的（`getCurrentSystemPrompt`、`normalizeContext`、durable 的 10 条 context 派生规则）。
2. **循环不认识 provider。** `StreamFn` 是一个函数签名，谁都能实现：真实 provider、HTTP 代理、测试桩。
3. **只有提交过的状态可观测。** durable 的会话以 commit 为单位原子落盘，UI 读的是提交后的视图快照，不是事件流拼装。

## 1. 分层与依赖方向

```
coding-agent   ← CLI / SDK / RPC / interactive
    ↓
durable        ← 会话、任务、文档、恢复
    ↓
agent          ← turn 循环
    ↓
ai             ← 协议与模型目录
```

依赖单向，`ai` 不知道 `agent` 存在，`agent` 不知道 `durable` 存在。这条纪律是后面所有可替换性的前提：可以只要 `ai` 做流式调用，可以只要 `agent` 配自研存储，也可以用 `durable` 拿到完整恢复能力。

## 2. pi-ai：模型访问层

### 2.1 协议面

`KnownApi` 覆盖 `openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`、`mistral-conversations` 和自家的 `pi-messages`；provider 约 40 个。上层只面对 `Model<TApi>` 和一组消息类型，不碰 HTTP。

`packages/ai/src/index.ts` 明确 core 无副作用：生成的模型目录、provider 工厂、OAuth、`compat` 都不在主入口，而在 `@earendil-works/pi-ai/providers/*`、`/api/*`、`/compat`。做 Web 端时这点直接可用——引 core 不会把 Node 专属的凭据逻辑拽进浏览器包。

### 2.2 消息模型

- `TextContent` / `ThinkingContent` / `ImageContent` / `ToolCall`（`packages/ai/src/types.ts`）。
- `AssistantMessage` 带 `api`、`provider`、`model`、`usage`、`stopReason`、`diagnostics`、`durationMs`，`StopReason` 有 `pending | stop | length | toolUse | error | aborted | deferred`。`deferred` 是异步应答（长任务模型）用的，durable 会为它安排轮询。
- `ToolResultMessage` 带 `isError`、`details`、`usage`、`nestedCalls`。

### 2.3 SystemMessage 是一条补丁链，不是一段字符串

这是全仓最容易被低估的设计：

```ts
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

首条 system message 的 `content` 是基底提示词，后续 system message 的 `content` 是追加文本；`sections` 是按名的有序补丁，字符串加/替换，`null` 删除；`toolsRemoved` 在同一消息内先于 `toolsAdded` 生效。**按顺序回放所有 system message，就得到当前有效的提示词与工具集。**

这样设计的原因很实际：对话中途换工具、加 skill、改 cwd 时，如果改请求里的 `tools` 数组，provider 侧的 prompt cache 整个失效；而追加一条只声明「移除了 X、新增了 Y」的系统消息，前缀不变，缓存仍在。durable 把这条规则推到极致：提示词的每个部分都是一个命名 section，`content` 永远写空串（`packages/durable/docs/spec.md:4204`）。

### 2.4 流式事件协议

`AssistantMessageEvent`：`start` → `text_start/text_delta/text_end`（thinking、toolcall 同构）→ `done` 或 `error`。文档特别强调 `partial` 是**共享的活动对象**，不是快照：消费方要读当前值，不能留存引用当历史。

`StreamFn` 的契约同样是防御式的：**不得 throw，也不得 reject**。失败必须编码成 `stopReason: "error" | "aborted"` 的事件流。这让循环里没有 try/catch 分支，错误只有一种形状。

### 2.5 其余值得知道的点

- `normalizeContext()` 把公开的 `Context{systemPrompt, messages, tools}` 折成 leading system message，并返回带 brand 的 `TranscriptContext`。只有它能产出该类型，防止未经归一化的上下文被塞进 provider 代码。
- `Context` 是入参类型，`TranscriptContext` 是内部类型，用品牌类型把「入口」和「内部」分开。
- `Transport` 有 `sse | websocket | websocket-cached | auto`；`cacheRetention` 默认 `"short"`；`sessionId` 供 prompt cache 路由。
- `constrainedSampling` 允许对工具参数要求 JSON Schema 严格模式或语法约束，按 provider 能力降级。
- `retry.ts`、`overflow.ts`（`isContextOverflow`）、`validation.ts`、`streaming-json.ts`（`StreamingJsonParser`/`ToolCallArgumentsStream`，增量解析工具参数，修掉 O(n²)）、`json-parse.ts`（容错解析模型输出）。
- `identity.ts`：客户端身份与归因头，1.4.0 的 breaking change 就是把它从 `telemetryContext` 收敛成 `telemetry?: TelemetrySpan`。

## 3. pi-agent：循环层

2,541 行做完了「一次对话怎么推进」，是整个仓库最值得精读的部分。

### 3.1 三个入口

```ts
agentLoop(prompts, context, config, signal, streamFn): EventStream<AgentEvent, AgentMessage[]>
agentLoopContinue(context, config, signal, streamFn)   // 空上下文或末条是 assistant 时直接 throw
runToolCall(toolCall, options)                          // 单次工具调用，不发事件，供 codemode 等嵌套复用
```

`runToolCall` 单独导出很关键：它复用了 prepare → validate → before/after hook 的完整管线但不产生事件，于是「模型调工具」和「程序调工具」共享同一套语义。

### 3.2 runLoop 的形状

双层循环：

- 外层：等 follow-up 消息，处理完再决定是否继续。
- 内层：处理工具调用与 steering 消息。

每轮的次序是：

```
poll getSteeringMessages
  → prepareNextTurn（可换 context / model / thinkingLevel）
  → emit turn_start
  → declareToolChanges()（工具集变化写成 SystemMessage 的 toolsAdded/toolsRemoved）
  → prepareRequest
  → streamAssistantResponse()
```

`declareToolChanges()` 只比对差量，无变化就不插消息——这是 prompt cache 友好的直接体现。

`streamAssistantResponse()`：`transformContext` → `convertToLlm` → `normalizeContext` → 解析 apiKey → 调 `streamFn`。流式过程中把 partial 直接写进 `context.messages` 末尾并发 `message_update`，所以「正在生成的消息」在状态里是可见的。

### 3.3 终止与错误规则

- `stopReason` 为 `error` / `aborted` → `turn_end` + `agent_end` 硬退出。
- `stopReason === "length"` → 该消息里所有 tool call 一律不执行，逐个返回错误结果（`"...was not executed: the response hit the output token limit"`）。这条规则避免了「参数被截断还去执行」的灾难。
- `convertToLlm` 契约同样是不许 throw。

### 3.4 工具批处理

`toolExecution: "sequential" | "parallel"`，默认 parallel。规则：

- 只要配置是 sequential，或**任一**被调工具声明 `executionMode: "sequential"`，整批串行。
- 并行时先顺序 prepare（找工具、修参数、校验、before hook），再并发 execute；`tool_execution_end` 按完成顺序发，但 tool-result 消息最后按 assistant 里调用出现的顺序落库。
- 批终止（`terminate`）只在**每个**结果都 `terminate === true` 时生效。
- 任何环节 throw 都转成 `isError` 结果，不中断循环。

### 3.5 事件与状态

`AgentEvent`：`agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `tool_execution_start|update|end` / `turn_end` / `agent_end`。

`Agent` 类（`packages/agent/src/agent.ts:194`）负责编排：持有 `_state`、`listeners`、两个 `PendingMessageQueue`（steering、follow-up，各支持 `all` 与 `one-at-a-time`）、`activeRun`。`processEvents` 的纪律是**先改内部状态，再按订阅顺序 await listener**，`agent_end` 之后要等所有 listener 跑完才算 idle。`prompt()` 在已有 activeRun 时拒绝重入。

### 3.6 proxy：把 provider 调用搬到服务端

`streamProxy(model, context, {proxyUrl, authToken})` 以 `POST ${proxyUrl}/api/stream` 转发，响应是 SSE。`ProxyAssistantMessageEvent` 故意不带 `partial` 以省带宽，客户端用本地 partial 加 `ToolCallArgumentsStream` 重建增量。正常 EOF 却没收到 `done`/`error` 时，转成错误 `"Connection closed by proxy server before the response completed"`——不假装成功。

对浏览器端 agent 来说，这个文件就是「密钥不落前端」的官方答案。

## 4. pi-durable：持久化运行时

33,594 行，是整个仓库的工程重心。规范在 `packages/durable/docs/spec.md`（6,531 行，normative）。

### 4.1 核心规则

> A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.

一次 commit 同时写 entries、task 记录、document 变更，三者原子。存储落盘后才对外发布；存储出错是致命的，Session 必须重开。

### 4.2 记录模型

- `EntryRecord{ id, conversationId, kind, model?, data?, head?, edits?, byTaskId? }`：不可变的转录记录。`model` 是给模型的消​​息，`data` 是给 UI/程序的附加数据。
- `head`：一个 entry 携带 head，表示「从这里开始算上下文」。压缩、reset、handoff 都是靠它，**旧记录一条不删**。
- `ContextEdit{ action: "omit" | "replace" }`：对某条历史做视图级改写，不改原记录。
- conversation 有一棵树：`parent{conversationId, at}` 决定继承，`owner` 只是归属（用于 abort 与 idle 遍历），不是权限。
- ID 是带 brand 的 number（`Id<"entry">`），编译期区分类型，运行期就是普通数字。

### 4.3 上下文派生（10 条规则，spec.md:313）

最值得照抄的部分。从 entry 树推出「这次请求到底发什么」：

1. 找 cutoff 之前最新的带 `head` 的 entry。
2. 从 `head.head` 开始扫。
3. 每个 target 取范围内最新的 edit 生效；`omit` 不出消息，`replace` 用新消息替。
4. 保留所有位置性的 system message 及其 section/工具变更。
5. 把 tool result 挪到对应 assistant 之后、按调用顺序排列（provider 协议要求）。
6. 缺失结果的调用合成 error 结果（fork 截断、异常中断都会缺）。
7. 丢弃没有对应调用方的 tool result。
8. 排除 `aborted` / `error` / `deferred` 的 assistant。
9. 首个 system message 提到最前（保住 prompt cache 的 leading prompt 语义）。
10. 只搬第一个，其余位置性 system message 保持原位。

第 9 条的理由写得很直白：provider 只把 leading system message 当初始提示词和工具集，没有它的话，后续任何工具变更都会改写整个请求的 tools 列表，缓存全废。

### 4.4 任务系统

durable 里所有实际工作都是 task：generation、tool、compaction、afterRun hook、子 agent 的内层任务。task 是状态机，checkpoint（phase）落盘，崩溃后从 checkpoint 恢复。

- **effect sandwich**（`:2372`）：先记录 intent 再执行副作用，结果是可重放判定的依据。工具执行前先把最终参数和 replay 策略写进 checkpoint，恢复时不再跑 `beforeTool`，直接用存下的参数。
- **replay 策略**：`"safe" | "unsafe"`，默认 unsafe。只有存的时候和恢复时的声明都说 safe 才重跑，否则产出 `interrupted` 结果。
- **restartLimit**（默认 5）：连续无进展重启超过上限就终态，避免崩溃循环烧钱。
- **abort 是树形的**：owner 边决定级联，`Conversation.abort()` 只清非后台子树；`{background:true}` 才深入到后台子 agent。

### 4.5 generation 状态机（spec.md:4777）

一个 run 的推进过程，全部落盘：

```
prepare → request → (retry | poll) → tools → finish → drain → 完成
```

- `prepare`：解析 agent 快照、渲染 section、算上下文、比对并追加 system 补丁、检查压缩阈值。
- `request`：流式请求，partial 以 deferred commit 每 100ms 落一次（崩溃时最多丢这么久）。若上次是 host 崩溃导致中断，则按 retry 策略退避后重来，文案是「The host stopped while the model was answering, on attempt N」。
- 分类结果：`stop`/`length` → 结束；`toolUse` → 起工具轮；可重试错误 → 退避；上下文溢出且可压缩 → 起压缩任务后重试；`deferred` → 睡眠轮询。
- `tools`（`:5035`）：每个调用一个 `pi.tool` 任务，检查「这次请求是否真的提供过这个工具」，没提供过直接 `tool_unavailable`，绝不执行。
- `maxTurns` 限制工具轮数；超限按失败 run 处理，inputs settle 为 `unanswered` + `turn_limit`。

### 4.6 提交与 inbox

`submit()` 在**持久化接纳**后返回，不等待完成。三种 submission：`input`（用户消息）、`write`（被动写入，如 UI 事件）、`continue`（无新消息继续跑）。

忙碌时的选择：`steer` 插到当前 assistant turn 之后，`followUp` 等 run 结束后，`reject` 直接拒。`requestId` 让重试幂等——这对 Web 端重连非常关键。

### 4.7 压缩

`compaction: { enabled, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }`。

- 超过 `contextWindow - reserveTokens` → 阻塞式压缩，等它完成再发请求。
- 再低 `backgroundTokens` → 起后台压缩，不阻塞。
- 压缩产出一个 summary entry，带 `head` 指向被概括的区间。原记录保留，可回看、可分叉。

### 4.8 文档与 Chord

durable 内部状态（`pi.agent`、`pi.live`、`pi.inbox`、`pi.provider`、`pi.usage`）都是「文档」：可变 JSON，由 Chord 的 op（`set`/`splice`/…）表达变更，配合周期性完整 base。

`pi.agent` 只存**名字**不存代码：选的扩展名、工具名、instructions、cwd、maxTurns。代码在该进程的 registry 里按名解析（`:896`）。所以同一份会话可以在没有某扩展的进程里打开，只是那个扩展失效，不会因为缺代码而崩。

### 4.9 视图与渲染

`ConversationView{ conversation, entries, before?, docs }`（`:5601`）。UI 渲染 `docs.pi.live` 里的 run/generation/tools/compactions，`pi.inbox` 里的队列，`pi.usage` 里的花费。

文档里有一句话定义了整个前端契约：

> A renderer renders the newest value; it never assembles state from a stream of events.

窗口机制：默认 50 条，最多 100 条，超出后一次性从头部 splice 到 50；`before` 告诉你前面还有。断线重连时用 `ConversationTranscript`：

```ts
const transcript = new ConversationTranscript((q, limit, ctx) => conversation.entries(q, limit, undefined, ctx));
const watch = await conversation.watch(context);
render(transcript.merge(watch.value));
// 重连
const resumed = await conversation.watch(context, transcript.resume);
```

`TranscriptItem` 有 `entry` / `gap`（中间缺货，渲染「加载更多」）/ `earlier`（还有更早）。这套东西把「长会话、断线、分页」的坑全填了。

### 4.10 存储后端

`storage/memory.ts`、`storage/indexeddb.ts`（带 `/// <reference lib="dom" />`，浏览器可用）、`storage/jsonl/*`（Node，文件）、`storage/sqlite/*`（含 Cloudflare D1/DO 版本）。

`Harness.open(storage, options, context)` 打开；`readOnly` 选项用于「另一个进程在写，我只显示」的场景（同步副本、只读设备）。

## 5. pi-coding-agent：组合层

77,235 行，大部分是 UI 与资源管理。要做 Web 端时，它是**参考实现**而不是依赖对象。

### 5.1 目录职责

- `core/`（35,864 行）：`agent-session.ts`（装配 Agent + SessionManager + 扩展 + 工具）、`session-manager.ts`（JSONL 树与 active leaf）、`resource-loader.ts`（扩展/skill/prompt 模板/主题/上下文文件发现）、`settings-manager.ts`、`model-runtime.ts` + `model-registry.ts`、`extensions/`（`ExtensionRunner`）、`tools/`（bash/edit/read/write/find/grep/ls/powershell）、`system-prompt.ts`、`compaction.ts`、`project-trust.ts`、`telemetry.ts`。
- `modes/`（24,370 行）：`interactive`、`print-mode.ts`、`json-event.ts`、`rpc/`（JSONL 协议 + `RpcClient`）。
- `extensions/`：内建扩展 `codemode`、`tool-search`、`mcp`、`llama`。
- `cli/`、`utils/`、`bun/`。

### 5.2 AgentSession 的装配

`AgentSessionConfig`（`core/agent-session.ts:265`）把依赖全部显式传入：`agent`、`sessionManager`、`settingsManager`、`cwd`、`resourceLoader`、`customTools`、`modelRuntime`、`initialActiveToolNames`、`allowedToolNames`/`excludedToolNames`、`baseToolsOverride`、`extensionRunnerRef`。没有隐藏全局单例——这正是能把它替换成 Web 实现的原因。

`sdk.md` 的对外契约：`prompt()` 在 run 结束（含自动重试）后才 resolve；流式期间再 prompt 必须显式说 steer 还是 followUp，否则拒绝而不是猜；`agent_end` 表示低层 run 结束，`agent_settled` 才表示「不会再有自动继续」。

`SessionManager` 是权威：外部恢复历史要构造带 entries 的 manager，直接改 `session.agent.state.messages` 不会替换持久化上下文。

### 5.3 五种接口

interactive / print / JSON / RPC / SDK，共用同一套 agent 与 session（`docs/how-pi-works.md:33`）。RPC 是严格 JSONL：命​​令带 `id`，响应回带；stdout 只放协议记录，日志走 stderr；不要用 `readline` 按行切（会切在 U+2028 上）。

## 6. 外围包

- **codemode**（3,037 行）：QuickJS 沙箱，脚本里唯一的对外能力是注入的工具。适合「工具太多，让模型写代码调」的场景，也顺带解决上下文里塞几十个工具定义的问题。`callers: ["model"]` 保证脚本不能起脚本。
- **env**（2,390 行）：执行环境抽象 `ExecutionEnv`，本地版 `NodeExecutionEnv`，远程版通过 SSH 部署一个小 daemon（`LocalExecutionEnv` / `RemoteExecutionEnv`），协议在 `packages/env/docs/protocol.md`。文件读写、shell、watch、行扫描都在这一层。要点：**env 是信任边界，不是安全边界**（spec.md:3954）。
- **mcp**（3,287 行）：独立 MCP 客户端，stdio/HTTP 传输、OAuth（默认 CIMD）。
- **chord**（49,698 行）：带类型的 host 运行时，做插件契约、复制状态、JSON link 上的 RPC。durable 的文档观察、watch、多端同步都建在它上面。
- **schema**（3,702 行）：不用 `eval` 的 JSON Schema 校验，编译成普通闭包，支持 2020-12 与 draft 7。工具参数校验与 `structuredOutput` 校验走这里。
- **telemetry**（1,572 行）：厂商中立的 span/metric 契约与 schema。
- **tui**（19,882 行）：差分渲染的终端 UI 库，含 markdown 渲染与编辑器组件。Web 端用不上，但 `markdown` 与 `editor` 的交互模型值得参考。
- **evals**（1,447 行）：评测脚手架。

## 7. 两条端到端时序

### 7.1 pi-agent 路径（无持久化）

```
调用方 prompt("...")
  Agent.prompt → 入队 → runWithLifecycle(AbortController)
    agentLoop(...)
      turn_start
      declareToolChanges → 可能追加 SystemMessage
      streamFn(model, TranscriptContext)
        ← AssistantMessageEvent 流（partial 写入 messages 末尾）
      message_end
      toolUse → 并行/串行执行工具 → tool_execution_* 事件
      tool-result 按调用顺序写入
    turn_end → 下一轮或 agent_end
  agent_end 的 listener 全部 await 完 → idle
```

### 7.2 durable 路径（可恢复）

```
POST /message → conversation.submit({type:"input", requestId, whenBusy})
  commit: 写 pi.user entry + submission 记录 → 返回（已落盘）
  scheduler: 起 generation 任务
    prepare: 解析 agent → 渲染 sections → 比对 system 补丁 → 压缩阈值检查
    request: 流式请求，partial 每 100ms deferred commit
    分类:
      stop/length → 写 pi.assistant → finish → boundary 放置队列 → drain
      toolUse     → 每个调用起 pi.tool 任务 → waiting → tools 阶段汇总
      error(可重试) → retry 退避
      error(溢出且有可压区间) → 起 compaction → 重试
    视图: pi.live 更新 → Chord op 批量推给所有 watch
```

## 8. 面向 Web agent 的三条落地路线

### 路线 A：浏览器内跑 durable

`Harness.open(indexedDbStorage, {...})`，UI 直接 `conversation.watch()` 拿视图。

- 得到：崩溃恢复、压缩、队列、多任务、视图同步、断线重连，几乎不用自己写。
- 必须自己解决：
  - **模型请求走代理**。用 `packages/agent/src/proxy.ts` 的 `streamProxy`，服务端持有密钥；否则密钥暴露在浏览器。
  - **执行环境**。浏览器没有文件系统和 shell，`HarnessOptions.env` 返回 `undefined`，工具只能是 HTTP/搜索引擎/自研 API 这类。
  - **单写者**。同一 storage 只能有一个写进程；多标签页里其他标签用 `readOnly: true` 打开。
- 适合：产品形态轻、不想维护服务端会话存储、工具主要是网络调用的场景。

### 路线 B：服务端跑 durable，前端只看视图（推荐起步）

Node 进程里 `Harness + sqlite/jsonl storage`，前端通过 WebSocket 收 `ConversationView`。

- 前端只做两件事：`transcript.merge(view)` 渲染，`submit()`/`abort()` 发命令。
- 断线重连用 `transcript.resume`；多端同步用 `observeConversation`。
- 工具能力完整：`ExecutionEnv` 本地/远程都可用，`bash`/`read`/`edit`/`write`/`grep` 直接能用。
- 需要自己设计：鉴权（durable 的 ID 是 Session 全局的，信任代码持有即可，没有额外授权层）、一个用户到多个 conversation 的映射、`readOnly` 观看者策略。

### 路线 C：只用 pi-ai + pi-agent，自研会话

只引 `agent` 的 `agentLoop` 与 `Agent`，自己管持久化。

- 得到：最小的控制面，turn 循环、工具批处理、事件流都是现成的。
- 失去：压缩、崩溃恢复、run 的幂等、视图同步、任务树。这些是 durable 的全部价值，等于要重写其中大部分。
- 适合：已有自己的会话存储、只想要「模型 + 工具循环」这一层。

对「基于 pi 做 Web 端 agent」这个目标，建议是 **B 起步、按需往 A 退**：先把 durable 当黑盒，把前端缩到「渲染视图 + 发命令」，等某一端真的需要离线或边缘部署，再换 IndexedDB 或 Cloudflare 的 sqlite 适配器。这三条路线的切换成本低，因为 durable 的存储是接口，视图是纯数据。

### 8.1 需要提前想清楚的四件事

1. **成本归属**：`pi.usage` 按 conversation 记账，模型按 `provider/modelId`，工具按名字。多租户要自己汇总到账号维度。
2. **扩展是代码**：扩展在同进程执行，没有沙箱。用户可控的扩展等于任意代码执行，Web 端不要开放。
3. **崩溃语义**：`restartLimit`、deferred commit 的 100ms 窗口、`afterFailedRun: "keep"` 都会影响「重启后看到什么」，对用户要能解释。
4. **prompt cache**：system 补丁链、`pi.provider.sessionId`、`cacheRetention` 三者一起决定命中率；自己接 provider 时不要每次重建 leading system message。

## 9. 设计原则

1. **回放优先于可变状态。** 提示词、工具、上下文都从记录推导，避免「对象里缓存了一份真值」的漂移。
2. **前缀稳定优先于表达简洁。** 工具变更写成增量 system 消息，而不是改请求；上下文派生把 leading system message 提到最前。都是为了 prompt cache。
3. **错误是一等数据。** `StreamFn` 不许 throw，工具错误是 `isError` 结果，诊断走独立通道而不是混进模型看到的文本。
4. **副作用在事务外，意图先落盘。** effect sandwich 让崩溃后的结果可以被判定为「重放安全」或「已中断」。
5. **未知就拒绝，不猜。** 流式期间 prompt 不指明 steer/followUp 就直接拒；工具没被提供就 `tool_unavailable`；结果被截断的 tool call 一律不执行。
6. **存名字不存代码。** `pi.agent` 只记扩展与工具名称，代码由进程的 registry 解析。
7. **UI 读快照，不拼事件。** 视图是有窗口的不可变值，客户端靠 `before`/`gap` 处理缺失，而不是重放事件流。
8. **信任边界显式化。** env 是信任边界不是安全边界，扩展同进程，这些在 spec 里直接写出来，而不是让人从代码里猜。

## 10. 阅读路线

按这个顺序读，每一步都能跑通：

1. `packages/ai/src/types.ts`（915 行）：消息与流协议。
2. `packages/agent/src/agent-loop.ts`（959 行）：一轮对话的全部决策。
3. `packages/agent/src/agent.ts`（623 行）：生命周期与监听。
4. `packages/agent/src/proxy.ts`（395 行）：浏览器 → 服务端的转发模型。
5. `packages/durable/docs/spec.md` 的 2.1（上下文派生）、7.3（工具）、8.3–8.5（generation 与工具轮）。
6. `packages/durable/src/harness/generation.ts`、`tool.ts`、`scheduler.ts`：上述规范的实现。
7. `packages/durable/src/session/session.ts` + `transaction.ts`：事务与提交。
8. `packages/coding-agent/docs/sdk.md`、`rpc.md`、`how-pi-works.md`：组合层的对外契约。
9. 动手：按 `packages/coding-agent/examples/sdk/` 的 01 → 05 → 11 → 12 顺序跑一遍。
