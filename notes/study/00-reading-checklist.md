# Pi Agent 初始化与模型调用：源码阅读清单

校对基准：`study-2026-11@bdd65c62e`（2026-11-04）。路径相对仓库根目录；代码更新后应按符号名重新定位。这里聚焦 coding-agent 使用的普通 `Agent` 路径，不把独立的 durable 运行时混作同一条调用链。

目标是读通：会话和 Agent 如何创建，Skill、Tool、MCP 如何加载，哪些内容进入模型上下文，以及模型调用工具后结果如何回传。适合和 Harness 对照阅读，但本文不声称两者已经完成逐项比较。

```text
CLI / SDK 创建会话
  → 加载模型配置、资源和历史消息
  → 创建 Agent 和 AgentSession
  → 组装提示词、注册和选择工具
  → 用户输入 → 整理上下文 → 请求模型
  → 模型返回文本或工具调用
  → 本地执行工具 → 结果加入会话 → 再次请求模型
```

## 1. 初始化：会话和 Agent

- [ ] **CLI 入口**：`packages/coding-agent/src/main.ts:574` 的 `main()`。看参数和模式选择，以及内建扩展如何进入资源加载流程。SDK 宿主可以自行装配，不应假定入口完全相同。
- [ ] **创建服务**：`packages/coding-agent/src/core/agent-session-services.ts:135` 的 `createAgentSessionServices()`。创建或接收模型运行时、设置和资源加载器，加载资源与扩展注册的模型；这里还没有创建 `AgentSession`。
- [ ] **组装会话**：`packages/coding-agent/src/core/sdk.ts:191` 的 `createAgentSession()`。依次跟踪 `SessionManager`、历史恢复、模型与思考等级、初始工具选择，以及 `Agent` 和 `AgentSession` 的创建。
- [ ] **区分职责**：`packages/agent/src/agent.ts` 的 `Agent` 管运行状态、消息队列和循环；`packages/coding-agent/src/core/agent-session.ts:392` 的 `AgentSession` 组织会话记录、工具、扩展、提示词和压缩。
- [ ] **会话切换与恢复**：`packages/coding-agent/src/core/agent-session-runtime.ts:74` 的 `AgentSessionRuntime` 管当前运行中的 session 和替换；`packages/coding-agent/src/core/session-manager.ts:987` 的 `SessionManager` 管会话记录、分支和上下文恢复。

详细时序见 [01-assembly.md](01-assembly.md)。

## 2. 能力加载：Skill、Tool、MCP

- [ ] **资源发现**：`packages/coding-agent/src/core/resource-loader.ts:343` 的 `DefaultResourceLoader`，重点看 `reload()`。追踪扩展、Skill、提示词模板和项目说明的来源，以及扩展贡献资源路径的方式。
- [ ] **Skill 发现与索引**：`packages/coding-agent/src/core/skills.ts:414` 的 `loadSkills()` 和 `:358` 的 `formatSkillsForPrompt()`。前者发现并解析 Skill；后者把允许模型使用的 Skill 格式化为名称、描述和文件位置的索引。通常不会把所有正文预先放进模型上下文。
- [ ] **工具定义与注册**：`packages/coding-agent/src/core/tools/index.ts` 是内置工具工厂；`packages/coding-agent/src/core/extensions/types.ts:1695` 定义扩展的 `registerTool()`。SDK 也可以传入自定义工具。对照 `ToolDefinition`、`AgentTool` 的声明和执行字段。
- [ ] **注册与暴露**：`packages/coding-agent/src/core/agent-session.ts:3576` 的 `_refreshToolRegistry()` 和 `:1614` 的 `_applyToolLoadout()`。区分已注册、可由其他工具调用、向模型声明三个状态，阅读 `direct`、`model-only`、`codemode`、`deferred`、`hidden` 的规则。
- [ ] **MCP 接入**：`packages/coding-agent/src/extensions/mcp/index.ts:279` 的 `createMcpExtension()` 和 `:387` 的 `registerTools()`。看连接、发现和注册；`packages/coding-agent/src/core/mcp-servers.ts:245` 的 `getMcpToolExposure()` 给出默认 `codemode` 策略。
- [ ] **MCP 调用与结果转换**：`packages/coding-agent/src/extensions/mcp/tools.ts:312` 的 `createMcpToolDefinition()` 和 `:266` 的 `convertMcpResult()`。看 MCP 工具如何包装成 Pi 工具，以及内容、结构化结果和错误如何转换。

CLI 的内建 MCP 扩展与 SDK 的装配方式有区别；阅读 SDK 示例时要检查宿主实际注入了哪些扩展。详见 [02-tools.md](02-tools.md)、[03-skills.md](03-skills.md) 和 [04-mcp.md](04-mcp.md)。

## 3. 哪些内容进入模型上下文

- [ ] **系统提示词**：`packages/coding-agent/src/core/system-prompt.ts:128` 的 `buildSystemPromptSections()`。看基础提示词、工具摘要与规则、项目说明、Skill 索引和工作目录的组织方式。工具的 `promptSnippet` / `promptGuidelines` 是提示词文本；工具调用声明另有数据结构。
- [ ] **消息结构**：`packages/ai/src/types.ts` 的 `SystemMessage`、`AssistantMessage`、`ToolCall`、`ToolResultMessage` 和 `Tool`。系统消息可携带 section 和工具增删；用户、助手和工具结果消息构成对话历史。
- [ ] **请求前处理**：`packages/coding-agent/src/core/agent-session.ts:1779` 的 `_preparePromptAndToolLoadout()`，以及 `packages/agent/src/agent-loop.ts:342` 的 `declareToolChanges()` 和 `streamAssistantResponse()`。看提示词差量、工具声明变化、上下文转换及模型流函数的调用。
- [ ] **具体 provider 请求**：先看 `packages/ai/src/api/openai-completions.ts:310` 的 `stream()`，再看目标 provider 的适配器。Pi 使用统一的内部消息结构，但不同 provider 的 HTTP 字段和系统消息、工具声明的表达方式可能不同。

| 内容 | 模型通常看到的形式 |
|---|---|
| 系统规则与项目说明 | system prompt 文本或 section |
| Skill | 名称、描述、位置的索引；正文按需读取后作为工具结果进入历史 |
| 已声明工具 | 名称、描述、参数 schema；部分工具还贡献提示词摘要和规则 |
| 用户输入和历史 | 转换后的对话消息 |
| 工具结果 | 与调用 ID 关联的 `toolResult`，主要是 `content` |
| `details` / `structuredContent` | 分别供 UI、日志和程序化调用使用，默认不作为普通模型结果发送 |

## 4. 模型使用能力及结果回传

- [ ] **用户输入**：`packages/coding-agent/src/core/agent-session.ts:2113` 的 `prompt()`。看输入处理、显式 Skill 或模板引用，以及消息如何交给 `Agent`。自动选择 Skill 与用户显式引用的输入路径要分别跟踪。
- [ ] **主循环**：`packages/agent/src/agent-loop.ts:172` 的 `runLoop()`。看模型响应、工具调用、结果追加和下一次请求；再看 steering、follow-up、中止和输出截断的分支。
- [ ] **工具执行与拦截**：`packages/agent/src/agent-loop.ts:518` 的 `executeToolCalls()` 及其调用链。跟踪工具查找、参数准备与校验、调用前钩子、执行、调用后钩子和错误结果。扩展侧的钩子由 `AgentSession` 接入。
- [ ] **结果契约**：`packages/agent/src/types.ts:424` 的 `AgentToolResult`。`content` 返回模型；`details` 供 UI 和日志；`structuredContent` 供程序化调用；`isError` 标记失败。

一次模型自动使用 Skill 的典型过程：

```text
系统提示词包含 Skill 的 name / description / location
  → 模型判断任务匹配并请求读取 SKILL.md
  → 本地读取工具执行，正文作为 toolResult 加入后续请求
  → 模型依据正文继续调用工具或回答
```

Skill 是说明，动作由工具执行。MCP 工具同样经过工具调用链，但执行端会调用 MCP 服务器，再把响应转换为 Pi 工具结果。

## 验证边界

本清单依据源码和现有学习笔记整理，未运行真实模型、抓取 provider payload 或验证 MCP 服务。需要确认某个 provider 的实际线上请求时，继续阅读对应适配器并结合实际请求验证。
