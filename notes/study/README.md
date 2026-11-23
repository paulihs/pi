# pi 学习笔记索引

这个目录放我读 pi 源码时的笔记。约定：

- 所有行号以 `main@2c8d1feb1`（2026-11-01，v1.4.0 之后 288 个提交）为准，代码变动后用符号名重新定位，别信旧行号。
- 路径相对仓库根 `/Users/maimai/leke/pi`。
- 每篇末尾都有"自己验证"的命令，看完结论能自己跑一遍。
- 结论只写代码里能看到的，拿不准的标"未验证"。

## 总览

| 文档 | 内容 | 状态 |
|---|---|---|
| [pi-architecture.md](../pi-architecture.md) | 12 包的整体架构、分层依赖、durable 运行时、端到端时序、三条 Web 落地路线 | 校对至 1.4.0 |
| [pi-agent-tool-definition.md](../pi-agent-tool-definition.md) | `Tool` / `AgentTool` / `ToolDefinition` / `ToolRegistration` 四种类型的字段对照 | 校对至 1.4.0 |

## 本目录

| 文档 | 回答的问题 |
|---|---|
| [00-reading-checklist.md](00-reading-checklist.md) | 从会话初始化到 Skill / Tool / MCP 加载、模型上下文和工具结果回传的源码阅读清单 |
| [01-assembly.md](01-assembly.md) | 一个会话是怎么被拼出来的：`main()` → `createAgentSession()` → `Agent` → `AgentSession`，提示词如何以"补丁"形式进 transcript |
| [02-tools.md](02-tools.md) | 工具有几种注册方式、注册和"模型可见"差在哪、五种 exposure 各是什么、调用拦截链 |
| [03-skills.md](03-skills.md) | skill 长什么样、从哪儿发现、为什么提示词里只放索引、正文怎么按需加载 |
| [04-mcp.md](04-mcp.md) | MCP 怎么接入、连接时机、工具命名、默认 codemode 暴露策略、OAuth 与 `/mcp` |

## 建议阅读顺序

1. `pi-architecture.md` 的 §0–§1（速览和分层），建立"三层一外围"的地图。
2. 本目录 `01-assembly.md`，把一个会话从入口到第一次请求走一遍。
3. 按需看 `02-tools.md` / `03-skills.md` / `04-mcp.md`，这三篇是同一个装配层的三个横切面。
4. 回到 `pi-architecture.md` §4（durable）和 §7（端到端时序），理解服务端形态。
5. 做 Web 端时看 `pi-architecture.md` §8，再对照 `packages/coding-agent/docs/rpc.md` 和 `sdk.md`。

## 待写

- `05-durable-runtime.md`：commit 模型、context 派生十条规则、generation 状态机。素材在 `packages/durable/docs/spec.md`。
- `06-rpc-protocol.md`：RPC 模式的请求/响应形状、事件流、和 TUI 的对应关系。
- `07-compaction.md`：压缩触发条件、摘要生成、`reserveTokens` 与输出上限的关系。

## 怎么更新

```bash
# 拉最新代码
git fetch upstream --tags && git merge --ff-only upstream/main

# 找符号新位置
grep -rn "function createAgentSession" packages/coding-agent/src
grep -rn "export function formatSkillsForPrompt" packages/coding-agent/src
```

改完笔记记得在文件头更新校对基准的 commit。
