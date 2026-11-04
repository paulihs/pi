# 04 MCP：接入方式与默认策略

校对基准：`main@2c8d1feb1`。

MCP 在 pi 里不是特殊通道，就是一个内建扩展。它的工具走和普通工具完全一样的注册、校验、拦截、渲染流程。特殊的地方只有三点：连接时机、命名、暴露级别。

## 1. 它从哪儿来

`packages/coding-agent/src/extensions/index.ts:7`：

```ts
export const builtInExtensions: InlineExtension[] = [
  { name: "llama.cpp", factory: llamaExtension, builtin: true },
  { name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
  { name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
  { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
```

`main.ts:578` 把它们拼进 `extensionFactories`，交给 `DefaultResourceLoader`。`replaceable: true` 意思是：如果你自己装了一个注册 `codemode` / `tool_search` / `/mcp` 的第三方扩展，它会接管，而不是两个一起跑。

`--no-mcp` 关掉的就是这个内建扩展（`main.ts:797` 传 `disabledBuiltinExtensions: ["mcp"]`）。

SDK 用户默认**没有**这些内建扩展，需要自己加：

```ts
import { createMcpExtension, createCodemodeExtension } from "@earendil-works/pi-coding-agent";

await createAgentSession({
  resourceLoader: new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [
      { name: "mcp", factory: createMcpExtension(), builtin: true },
      { name: "codemode", factory: createCodemodeExtension(), builtin: true },
    ],
  }),
});
```

## 2. 什么时候连

```
loading extensions
  └─ 扩展注册服务器：pi.registerMcpServer(name, config)   ← 此时只登记，不连接
        │
session_start                                              ← bindExtensions() 触发的
  └─ createMcpExtension 读取：
       ├─ pi.getMcpServers()         扩展登记的
       └─ mcp.json                    全局 + 项目（项目需 trusted）
       然后后台并发连接
        │
        ├─ 连接成功 → registerTools(connection)
        └─ 失败/需要登录 → 记一条报告，/mcp 里可见
```

两个细节：

- **配置优先于代码**：`mcp.json` 里同名服务器会覆盖扩展登记的那个，`/mcp` 会显示被覆盖的项。
- **连接是后台的**：第一个 prompt 只等那些有 `direct` 工具的服务器，默认等待上限 10 秒（`DEFAULT_STARTUP_WAIT_MS = 10_000`，可用 `startupWaitMs` 改）。codemode 脚本、`tool_search`、资源工具在真正需要时才等自己依赖的服务器。所以一个慢的 MCP 服务器不会卡住启动，但 `direct` 模式的服务器会。

## 3. 工具命名

```
mcp__<server>__<tool>
     └─ 服务器名里的 - 换成 _
```

例如服务器 `docs` 提供工具 `search` → `mcp__docs__search`。

命名空间对象（`registerTools` 里构造）：

```ts
const namespace = {
  name: "mcp__docs",
  aliases: ["docs"],          // describeNamespace("docs") 也能找到
  description: entry.config.description,
  instructions: connection.instructions,   // 服务器的使用说明
};
```

`instructions` 不进提示词，只在 codemode 的 `describeNamespace()` 里返回。这是给脚本作者看的，不是给模型的常驻上下文。

名字去重：多个工具名 normalize 后撞车时，会加 hash 后缀，并保证同一个工具在重连后名字稳定。

## 4. 暴露级别：默认不进模型上下文

这是 MCP 集成最重要的设计决定。默认 `exposure: "codemode"`：

| exposure | 效果 |
|---|---|
| `codemode`（默认） | 不声明给模型。只有 codemode 脚本能调，脚本用 `searchTools()` 找工具、`describeNamespace()` 找说明 |
| `deferred` | 同样不声明，但可以被 `tool_search` 加载出来；此时激活 `tool_search` 而不是 codemode |
| `direct` | 直接声明给模型，和内置工具一样 |
| `hidden` | 注册但不可达，等于从模型视角移除 |

配置写法：

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "exposure": "direct" },
    "sentry": {
      "url": "https://mcp.sentry.dev/mcp",
      "exposure": "codemode",
      "toolExposure": { "list_*": "deferred", "delete_*": "hidden" }
    }
  }
}
```

`toolExposure` 按工具名覆盖，支持 `*` 通配，按对象顺序第一个匹配生效（`core/mcp-servers.ts:245`）。

默认策略的收益：装十个 MCP 服务器不会把几十个工具的声明塞进系统提示词，prompt cache 也不会因为工具列表变化而反复失效。代价是模型必须先写一段 codemode 脚本，比直接调工具多一步。

`autoEnableCodemode: true`（默认）会在有 codemode 级 MCP 工具时自动激活 `codemode` 工具本身。如果你根本不想要 codemode，把它设成 `false`，同时把这些服务器改成 `direct` 或 `deferred`。

## 5. 资源（resources）

MCP 的 resources 通过三个工具暴露，命名沿用 Codex 的约定：

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

它们和普通工具一样注册，一样受 `tool_call` 钩子约束。

## 6. 认证

- 传输：`command`（stdio 子进程）或 `url`（HTTP）。
- 头部支持环境变量展开：`"Authorization": "Bearer ${DOCS_TOKEN}"`。
- OAuth 凭据存在 `McpOAuthCredentialStore`（默认在 agent 目录下），登录是浏览器流程。
- `auth` 配置只允许写在全局 `mcp.json`，项目级的会被拒绝（防止恶意仓库让你把 token 发给它的服务器）。

`/mcp` 打开管理器：登录、重连、启用/禁用、改 exposure。启用/禁用和 exposure 的修改会写回定义该服务器的 `mcp.json`，扩展登记的服务器则只对当前会话生效。

## 7. 拦截与渲染

MCP 工具不是旁路，走的还是 pi 的完整管线：

- `tool_call` / `tool_result` 扩展钩子对它们生效，权限扩展可以统一拦截。
- `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）从服务器透传，权限扩展可据此决定是否需要用户确认。
- 渲染：`registerToolRenderer` 注册了一个 `mcp__<server>__<tool>` 的匹配器，所以恢复旧会话时，即使服务器还没连上，历史里的 MCP 调用也能正确显示。

## 8. 最小接入步骤

1. 写 `~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@acme/docs-mcp"], "exposure": "direct" }
  }
}
```

2. 启动 pi。`/mcp` 看连接状态。
3. 需要减少上下文占用，就把 `exposure` 改成 `codemode`，让模型通过脚本调用。
4. 需要项目级隔离，写 `<project>/.pi/mcp.json`（项目要 trusted，且不能带 `auth`）。

## 9. 自己验证

```bash
# 内建扩展清单
sed -n '1,20p' packages/coding-agent/src/extensions/index.ts

# MCP 扩展的顶层说明（设计意图都写在这里）
sed -n '1,40p' packages/coding-agent/src/extensions/mcp/index.ts

# 暴露级别默认值
grep -n "config.exposure ?? \"codemode\"" packages/coding-agent/src/core/mcp-servers.ts

# 配置校验
sed -n '100,160p' packages/coding-agent/src/extensions/mcp/config.ts
```
