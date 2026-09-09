# @earendil-works/pi-agent-core

支持状态、工具执行和事件流的 Agent，构建于 `@earendil-works/pi-ai` 之上。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

### SQLite Session 后端

SQLite Session 后端和 `node:sqlite` 适配器位于独立的 `@earendil-works/pi-session-backend-sqlite-node` 包中，因此核心包默认不会引入运行时内置模块或原生 SQLite 依赖。该后端接收特定运行时的 SQLite 工厂，未来其他 Session 后端也可以作为独立包发布。

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 实验性 facet 服务

与传输无关的 facet 服务原语位于 `@earendil-works/chord`。Agent Core 不导出服务运行时。

## 核心概念

### AgentMessage 与 LLM Message

Agent 使用 `AgentMessage`，这是一种灵活的类型，可以包含：
- 标准 LLM 消息（`user`、`assistant`、`toolResult`）
- 通过声明合并扩展的自定义应用消息类型

LLM 只能理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 函数会在每次调用 LLM 前过滤并转换消息，以弥合这种差异。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```

1. **transformContext**：裁剪旧消息，注入外部上下文
2. **convertToLlm**：过滤仅供 UI 使用的消息，将自定义类型转换为 LLM 格式

## 事件流

Agent 会发出用于更新 UI 的事件。理解事件顺序有助于构建响应迅速的界面。

### `prompt()` 事件顺序

调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 包含工具调用时

如果 Assistant 调用工具，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

工具执行模式可配置：

- `parallel`（默认）：按顺序预检工具调用，并发执行允许的工具；每个工具完成后立即发出 `tool_execution_end`，然后按 Assistant 原始顺序发出 toolResult 消息和 `turn_end.toolResults`
- `sequential`：逐个执行工具调用，与历史行为一致

在并行模式下，工具完成事件按实际完成顺序发出，但持久化的 toolResult 消息仍按 Assistant 原始顺序排列。

可以通过 Agent 配置中的 `toolExecution` 设置全局模式，也可以通过 `AgentTool` 上的 `executionMode` 为单个工具设置。如果一个批次中的任意工具调用目标工具设置了 `executionMode: "sequential"`，整个批次都会忽略全局设置并按顺序执行。

`beforeToolCall` Hook 在 `tool_execution_start` 和参数验证解析之后运行。它可以阻止执行，并在阻止结果中设置 `terminate: true`。`afterToolCall` Hook 在工具执行完成后、发出 `tool_execution_end` 和最终工具结果消息事件之前运行。

工具、被阻止的 `beforeToolCall` 结果和 `afterToolCall` 覆盖结果都可以返回 `terminate: true`，提示跳过自动的后续 LLM 调用。只有该批次中所有已完成的工具结果都设置 `terminate: true` 时，循环才会提前停止。混合批次会正常继续。

`Agent` 类在 `AgentOptions` 中接受 `shouldStopAfterTurn`。底层循环调用方可以在 `AgentLoopConfig` 中设置同一个 Hook：

```typescript
const stream = agentLoop(
  prompts,
  context,
  {
    model,
    convertToLlm,
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      return shouldCompactBeforeNextTurn(context.messages);
    },
  },
  undefined,
  models.streamSimple.bind(models),
);
```

`shouldStopAfterTurn` 会在发出 `turn_end`，且 Assistant 响应和所有工具执行正常完成后运行。如果返回 `true`，循环会发出 `agent_end` 并退出，不再轮询 steering 或 follow-up 队列，也不会开始下一次 LLM 调用。它不会中止供应商流、取消正在运行的工具，也不会修改 Assistant 消息的停止原因。`AgentOptions` 回调的第二个参数还会收到当前运行的 `AbortSignal`。

使用 `Agent` 类时，Assistant 的 `message_end` 处理会作为工具预检开始前的屏障。这意味着 `beforeToolCall` 看到的 Agent 状态已经包含发起该工具调用的 Assistant 消息。

### `continue()` 事件顺序

`continue()` 会从现有上下文恢复，不添加新消息。发生错误后可以用它重试。

```typescript
// After an error, retry from current state
await agent.continue();
```

上下文中的最后一条消息必须是 `user` 或 `toolResult`（不能是 `assistant`）。

### 事件类型

| Event | Description |
|-------|-------------|
| `agent_start` | Agent 开始处理 |
| `agent_end` | 本次运行的最终事件。该事件的订阅者即使被等待，也仍计入结算 |
| `turn_start` | 新回合开始（一次 LLM 调用加工具执行） |
| `turn_end` | 回合完成，包含 Assistant 消息和工具结果 |
| `message_start` | 任意消息开始（user、assistant、toolResult） |
| `message_update` | **仅限 Assistant。** 包含带增量内容的 `assistantMessageEvent` |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_update` | 工具流式报告进度 |
| `tool_execution_end` | 工具完成 |

`Agent.subscribe()` 监听器会按注册顺序等待。`agent_end` 表示不会再发出循环事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 只有在等待中的 `agent_end` 监听器完成后才会结算。

## Agent 配置项

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Required stream function
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Stop gracefully after a completed turn, before queued messages are polled.
  shouldStopAfterTurn: async ({ context }, signal) => {
    return shouldCompactBeforeNextTurn(context.messages, signal);
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent 状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问状态。

赋值给 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 时，会先复制顶层数组再存储。修改返回的数组会修改当前 Agent 状态。

流式处理期间，`agent.state.streamingMessage` 包含当前不完整的 Assistant 消息。

`agent.state.isStreaming` 会一直保持为 `true`，直到本次运行完全结算，包括等待中的 `agent_end` 订阅者完成。

## 方法

### 发起 Prompt

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```

### 状态管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.shouldStopAfterTurn = async ({ context }) => shouldCompactBeforeNextTurn(context.messages);
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
agent.reset();
```

### Session 和思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering 和 Follow-up

Steering 消息可以在工具运行时中断 Agent。Follow-up 消息可以在 Agent 原本即将停止时为其排队后续工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 clearSteeringQueue、clearFollowUpQueue 或 clearAllQueues 丢弃排队中的消息。

回合完成后检测到 Steering 消息时：
1. All tool calls from the current assistant message have already finished
2. Steering messages are injected
3. The LLM responds on the next turn

只有在没有更多工具调用且没有 Steering 消息时才会检查 Follow-up 消息。如果队列中有消息，就会注入这些消息并运行另一个回合。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// 现在有效
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```

## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

工具失败时应**抛出错误**，不要将错误消息作为内容返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被 Agent 捕获，并以 `isError: true` 的工具错误报告给 LLM。

可以从 `execute()`、被阻止的 `beforeToolCall` 或 `afterToolCall` 返回 `terminate: true`，提示 Agent 在当前工具批次后停止。只有批次中每个已完成的工具结果都设置为终止时才会生效。该提示只在运行时使用；发出的 `toolResult` transcript 消息仍是标准 LLM 工具结果。

## 代理使用

对于通过后端代理的浏览器应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 底层 API

如果不使用 Agent 类而需要直接控制：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

这些底层流仅用于观测。它们会保持事件顺序，但不会等待异步事件处理完成后再继续后续生产阶段。如果需要让消息处理在工具预检前充当屏障，请使用 `Agent` 类，而不是直接使用 `agentLoop()` 或 `agentLoopContinue()`。

## 许可证

MIT
