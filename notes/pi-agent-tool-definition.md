# Pi 标准 Tool 定义参考

整理自 pi 主仓库（`/Users/maimai/leke/pi`）。行号随代码演进可能偏移，函数名与类型名可作保底检索。

校对至 v1.4.0（HEAD `2c8d1feb1`，2026-11-01）。

## 1. 全景：模型只输出两种东西

一条 assistant 消息的 `content` 是数组，可混排三类块（`packages/ai/src/types.ts`）：

```ts
TextContent      // { type: "text", text: "..." }   给用户看的
ThinkingContent  // { type: "thinking", ... }        思考过程
ToolCall         // { type: "toolCall", id, name, arguments: Record<string, any> }
```

关键点：`ToolCall` **不是模型吐出的 JSON 字符串**，而是走厂商原生 function calling 通道、由 API 层解析好的结构化对象。模型没有权限，只有 harness 有——它只能"请求"调用，真正执行、拦截、中止全在本地代码里。

完整回路在 `packages/agent/src/agent-loop.ts`：

```
context.tools 随请求发出
  → 模型返回 ToolCall（stopReason 标记"要调工具"）
  → executeToolCalls 按 name 查表，本地执行（sequential / parallel）
  → 结果包成 ToolResultMessage（role:"toolResult"、toolCallId 关联、content 支持 text+image）
  → 追加进上下文，再发一次请求
  → hasMoreToolCalls = !terminate，直到模型不再要求调工具
```

异常同样走这条通道：参数被 token 上限截断、工具不存在、执行报错，统统以 error tool result 的形式送回，让模型自己纠错重试。

## 2. 两层契约（字段是超集关系）

| 层 | 位置 | 用途 |
|---|---|---|
| `Tool` | `packages/ai/src/types.ts` | provider 层最小声明：`name` / `description` / `parameters` / `constrainedSampling` |
| `AgentTool` | `packages/agent/src/types.ts:466` | 运行时契约，Agent 循环实际消费的形状 |
| `ToolDefinition` | `packages/coding-agent/src/core/extensions/types.ts` | 产品层，额外带提示词贡献 + TUI 渲染 |

### AgentTool（运行时）

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  name: string;                  // 模型看到的调用名（继承自 Tool）
  label: string;                 // UI 显示名
  description: string;           // 模型看到的说明——唯一的用法提示来源
  parameters: TParameters;       // TypeBox JSON Schema
  prepareArguments?: (args: unknown) => Static<TParameters>;
  outputSchema?: TSchema;        // structuredContent 的 JSON Schema
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
  replay?: "never" | "safe";
  executionMode?: ToolExecutionMode;   // "sequential" | "parallel"
}
```

### ToolDefinition（产品层新增）

```ts
promptSnippet?: string;      // 进 system prompt 的 Available tools 一行；不填则该工具不出现在其中
promptGuidelines?: string[]; // 进 system prompt 的 Guidelines 段
constrainedSampling?: false | ConstrainedSamplingConfig;
renderShell?: "default" | "self";
renderCall?: (...) => Component;    // 自定义调用展示
renderResult?: (...) => Component;  // 自定义结果展示
execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) // 多一个 ctx（含 cwd 等）
```

## 3. 最小可用示例

`packages/coding-agent/examples/extensions/dynamic-tools.ts:33`：

```ts
pi.registerTool({
  name,
  label,
  description: `Echo a message with prefix: ${prefix}`,
  promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,
  promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
  parameters: ECHO_PARAMS,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `${prefix}${params.message}` }],
      details: { tool: name, prefix },
    };
  },
});
```

## 4. AgentToolResult 的字段

```ts
interface AgentToolResult<T = JsonValue | undefined> {
  content: (TextContent | ImageContent)[]; // 回灌给模型，计入 token
  details: T;                              // 只用于日志与 UI 渲染，模型看不到
  structuredContent?: JsonValue;           // 供程序化调用方读取，不进模型上下文
  usage?: Usage;                           // 工具自身消耗，不计主上下文
  isError?: boolean;                       // 不抛异常地报错，content 仍按 error result 回灌
  terminate?: boolean;                     // 本批全部为 true 时循环提前结束
}
```

## 5. 五条设计约定

**① `content` 给模型，`details` 给人，严格分开。**
往 `content` 里塞调试 JSON 是最常见的错：白烧 token 且干扰模型。截断统计一类的元信息只放 `details`；要给程序化调用方的结构化数据放 `structuredContent`，两者都不进模型上下文。

**② 失败要显式标记：throw，或返回 `isError: true`，但别只写在 `content` 里。**
类型注释原文：``Throw on failure, or return a result with `isError: true`; do not only describe the failure in `content` ``。循环会 catch 异常并自动生成 error tool result；走 `isError` 的路径会保留 `details` 和 `structuredContent` 给 UI 与程序化调用方。

**③ 必须响应 abort。**
`src/core/tools/ls.ts` 的模板写法：进入即查 `signal?.aborted` 并 `reject`；注册 `abort` 监听；成功路径上 `removeEventListener`。否则用户按 Esc 后工具仍在后台跑。

**④ 输出必须有上限，且提示要可操作。**
`ls.ts` 收尾不是写 "truncated"，而是：

```
[500 entries limit reached. Use limit=1000 for more]
```

直接告诉模型下一步调什么参数。同理 `description` 里要预先声明规则（排序方式、目录后缀、截断阈值）——**模型看不到实现，只看得到 `description`**。

**⑤ 长任务用 `onUpdate` 流式推进度。**
参数是与 `AgentToolResult` 同构的 partial。promise settle 之后的调用会被忽略。

## 6. 可选字段速查

| 字段 | 含义 | 何时用 |
|---|---|---|
| `executionMode` | 默认并行 | 有副作用/写文件的工具设 `sequential` |
| `prepareArguments` | schema 校验前的参数兼容 shim | 需要兼容老调用格式 |
| `terminate` | 本批全部置 true 才提前停循环 | "任务完成"信号类工具 |
| `outputSchema` / `structuredContent` | 声明工具结果的结构并回传 | 程序化调用方要读结果，而不是解析 `content` |
| `isError` | 不抛异常地报错 | 需要同时保住 `details` 给 UI 时 |
| `replay` | 崩溃恢复时效果能否重放 | 发邮件类非幂等操作用 `never` |
| `renderCall` / `renderResult` | 自定义 TUI 组件 | 需要专属展示 |
| `constrainedSampling` | provider 侧强约束采样 | 参数格式极严格时 |
| `renderShell: "self"` | 工具自管边框 | 不用默认彩色壳 |

## 7. 参考文件

- `packages/agent/src/types.ts` — `AgentTool`、`AgentToolResult`、`AgentToolUpdateCallback`
- `packages/agent/src/agent-loop.ts` — 循环与工具执行（`executeToolCalls` 的 sequential / parallel 两条分支）
- `packages/ai/src/types.ts` — `Tool`、`ToolCall`、`ToolResultMessage`、内容块类型
- `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition`
- `packages/coding-agent/src/core/tools/ls.ts` — 最干净的教科书级实现（约 180 行）
- `packages/coding-agent/examples/extensions/dynamic-tools.ts` — 运行时动态注册工具
- `packages/coding-agent/docs/extensions.md` — 扩展系统总览
