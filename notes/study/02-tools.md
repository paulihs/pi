# 02 工具：注册、暴露、装载

校对基准：`main@2c8d1feb1`。

工具是 pi 里最容易混淆的部分，因为"注册"和"模型能看到"是两件事。这一篇把两者分开讲。

## 1. 五种注册方式

| # | 方式 | 代码位置 | 谁用 | 特点 |
|---|---|---|---|---|
| 1 | 内置工具 | `packages/coding-agent/src/core/tools/index.ts` | 所有人 | 8 个：`read` `bash` `powershell` `edit` `write` `grep` `find` `ls` |
| 2 | `baseToolsOverride` | `AgentSession` 构造参数 | 高阶用法 | 整体替换内置工具定义表 |
| 3 | `customTools` | `createAgentSession({ customTools })` | SDK 用户 | 进程内传 `ToolDefinition[]`，无扩展文件 |
| 4 | 扩展 `pi.registerTool()` | `packages/coding-agent/src/core/extensions/types.ts:1695` | 扩展作者 | 磁盘扩展、内建扩展、内联扩展都走这里 |
| 5 | MCP 工具 | `packages/coding-agent/src/extensions/mcp/index.ts` | MCP 服务器 | `session_start` 时自动注册，名字带 `mcp__` 前缀 |

另有一套独立的：`@earendil-works/pi-durable` 的 `ToolRegistration`（`defineTool` + `registry.install`），用于 durable harness 的任务化执行，和上面的 `registerTool` 不是同一个 API。做 Web 端如果只用 coding-agent，不需要碰它。

### 1.1 内置工具

每个工具一个文件，导出两个工厂：

```ts
export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition;
export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool;
```

区别只是返回 definition 还是已包装的 `AgentTool`。`cwd` 是必须的，因为读写路径要按会话目录解析。`read.ts` 里还有 `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` 和 `truncateHead` / `truncateTail`，输出超限时从中间截断而不是简单砍尾。

聚合工厂（`tools/index.ts:164` 起）：

- `createCodingToolDefinitions()` → read/bash/edit/write（默认四件套）
- `createReadOnlyToolDefinitions()` → read/grep/find/ls
- `createAllToolDefinitions()` → 8 个

### 1.2 `baseToolsOverride`

`AgentSession` 配置项。传了之后，内置工具表整体换成你给的 map：

```ts
const defaultActiveToolNames = this._baseToolsOverride
  ? Object.keys(this._baseToolsOverride)
  : ["read", "bash", "edit", "write"];
```

用途：做只读沙箱、把 `bash` 换成容器内执行、或者完全不用文件工具。注意它替换的是**内置**那一层，扩展工具仍然照常合并。

### 1.3 `customTools`

SDK 直接在进程里给工具，不需要写扩展文件：

```ts
await createAgentSession({
  customTools: [{
    name: "deploy",
    label: "Deploy",
    description: "Deploy current branch",
    parameters: Type.Object({ env: Type.String() }),
    async execute(id, params) { ... },
  }],
});
```

`_refreshToolRegistry()` 会给它们合成 sourceInfo：`<sdk:deploy>`，来源标记为 `sdk`。适合宿主程序自己提供的少数工具。

### 1.4 扩展里的 `registerTool()`

扩展就是一个文件，默认导出函数，参数是 `ExtensionAPI`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "Echo text back",
    promptSnippet: "Echo back user-provided text",     // 进提示词的 tools 段
    promptGuidelines: ["Use echo when the user asks for exact output."], // 进 rules 段
    parameters: Type.Object({ message: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.message }], details: {} };
    },
  });
}
```

放在 `~/.pi/agent/extensions/` 或项目的 `.pi/extensions/` 下，或者写进 settings 的 `extensions` 列表。加载器逐个文件解析，支持目录（只看一层，或者用 package.json manifest 声明入口）。

`registerTool` 之外，`ExtensionAPI` 还能注册命令（`registerCommand`）、快捷键（`registerShortcut`）、工具渲染器（`registerToolRenderer`），以及监听三十多个事件（`pi.on(...)`）。

### 1.5 MCP 工具

见 `04-mcp.md`。要点：不是手动注册，而是内建 `mcp` 扩展在 `session_start` 连上服务器后批量 `registerTool`，名字是 `mcp__<server>__<tool>`。

## 2. 注册之后发生了什么

```
registerTool(def)                       扩展 / SDK / MCP
        │
        ▼
runner.getAllRegisteredTools()          RegisteredTool[]（带 sourceInfo）
        │
        ├─────────────┐
        ▼             ▼
_baseToolDefinitions  customTools      （内置层 + 自定义层）
        │             │
        └──────┬──────┘
               ▼
      definitionRegistry: Map<name, {definition, sourceInfo}>
               │
               ├─► toolSnippets / toolGuidelines      → 提示词
               ├─► wrapToolDefinition(..., runner)     → AgentTool
               ▼
        _toolRegistry: Map<name, AgentTool>
               │
               ▼   _applyToolLoadout(激活名集合)
        agent.state.tools（真正声明给模型的那批）
```

`_refreshToolRegistry()` 在 `agent-session.ts:3576`，`_applyToolLoadout()` 在 `:1614`。

合并顺序：先内置，后扩展/custom 覆盖同名。所以扩展可以用同名工具覆盖 `read`（有意的行为，用于替换实现）。

## 3. `ToolDefinition` 字段

| 字段 | 作用 |
|---|---|
| `name` | 模型调用时用的名字 |
| `label` | UI 显示 |
| `description` | 给模型看的说明 |
| `promptSnippet` | 提示词 `<tools>` 段里的一行摘要；没有就不列 |
| `promptGuidelines` | 提示词 `<rules>` 段里的条目；没有就不加 |
| `parameters` | TypeBox schema，调用前校验 |
| `prepareArguments` | 校验前的兼容层，把旧参数改造成新形状 |
| `outputSchema` | `structuredContent` 的 schema，codemode 用它 |
| `exposure` | 模型怎么够到它，见 §4 |
| `namespace` | 分组（MCP 一个服务器一组） |
| `annotations` | `readOnlyHint` 等，权限扩展可据此决定是否要确认 |
| `defaultActive` | 注册即激活的开关 |
| `prepareLoadout` | 激活集合变化时改自己的描述或隐藏某些声明 |
| `executionMode` | `"sequential"` 强制串行 |
| `execute` | 真正干活 |
| `renderCall` / `renderResult` | TUI 渲染 |

## 4. 五种 exposure

| 值 | 声明给模型 | 可被 `ctx.executeTool()` 调用 | 说明 |
|---|---|---|---|
| `direct` | 激活时是 | 激活时是 | 默认值，普通工具 |
| `model-only` | 激活时是 | 否 | 编排类/交互类工具 |
| `codemode` | 否（除非显式激活） | 注册即可调 | codemode 的描述里会列出它 |
| `deferred` | 否 | 注册即可调 | 不出现在 codemode 描述里，靠 `tool_search` 找 |
| `hidden` | 否 | 否 | 注册但不可达 |

`direct` 和 `model-only` 在注册时就激活，其余不会自动激活。这就是为什么 MCP 工具默认不占模型上下文：默认 exposure 是 `codemode`，只有 `/mcp` 或 `setActiveTools()` 打开，或者被写进 `tools` 白名单，才真正声明给模型。

`direct` 和 `model-only` 的区别只有一个：后者不能被别的工具调用。codemode 脚本里调用的必须是前者或 `codemode` 级别的工具。

## 5. 对提示词的影响

三个字段决定工具在提示词里出现成什么样：

```
<tools>
- read: Read a file...
- bash: Run a shell command...
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- ...
</rules>
```

- 没有 `promptSnippet` 的工具不会进 `<tools>` 列表，但仍然是可调用的。
- `promptGuidelines` 只在工具**激活**时进 `<rules>`，和 HTML 声明保持同步。
- `prepareLoadout(loadout)` 能看到 `declared` / `callable` / `registered` 三批工具，返回 `{ descriptions, hiddenDeclarations }`，用来动态改写描述（codemode 就是靠它把可调工具列表写进自己的 description）。

## 6. 调用拦截链

工具执行前后各有一个钩子，都装在 `AgentSession` 上（不在 wrapper 里，`agent-session.ts:668` 的注释说明了原因）：

```
agent loop
  └─ beforeToolCall(context)  →  _beforeToolCall  →  runner.emitToolCall   （扩展 tool_call 事件）
  └─ execute
  └─ afterToolCall(context)   →  _afterToolCall   →  runner.emitToolResult （扩展 tool_result 事件）
```

- `beforeToolCall` 返回 `{ block: true, reason }` 就不执行，模型收到一条 error 结果；返回 `{ terminate: true }` 让整个循环在这一轮结束。
- `afterToolCall` 可以改 `content` / `details` / `isError` / `usage`；字段级替换，不做深合并。

嵌套调用（工具里再调工具）走 `ctx.executeTool()`，会带 `parentToolCallId`，扩展能区分主调用和嵌套调用。

## 7. 常见坑

**注册不等于可见。** 新工具模型看不到，先查 `exposure` 和 `defaultActive`，再看它有没有出现在 `getActiveToolNames()` 里。

**并行是默认。** `toolExecution` 默认 `"parallel"`。有共享状态、或者要按顺序改同一个文件的工具，必须设 `executionMode: "sequential"`，否则会同时跑。`edit`/`write` 内部还有 `withFileMutationQueue` 做文件级串行，不依赖工具级顺序。

**参数错误不会抛给用户。** `validateToolArguments` 失败会转成一条 `isError: true` 的 tool result，模型能看到错误并重试。`execute` 里抛异常同理。

**截断在工具内部。** `read`/`bash` 的返回值可能被截断，`details` 里带截断信息。不要假设 `content` 是完整输出。
