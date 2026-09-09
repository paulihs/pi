<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi 标志" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 Issue 和 PR 默认会被自动关闭。维护者每天会审阅被自动关闭的 Issue。详见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

Pi 是一个精简的终端编码智能体运行框架（coding harness）。你可以让 Pi 适应自己的工作流，无需反过来调整工作流，也无需 fork 或修改 Pi 内部代码。通过 TypeScript [扩展](#extensions)、[技能](#skills)、[提示词模板](#prompt-templates)和[主题](#themes)扩展它。将扩展、技能、提示词模板和主题放入 [Pi 包](#pi-packages)，即可通过 npm 或 git 与他人分享。

Pi 提供了强大的默认能力，但没有内置子智能体、计划模式等功能。你可以让 Pi 构建所需功能，也可以安装适合自己工作流的第三方 Pi 包。

Pi 提供四种使用模式：交互模式、文本或 JSON 输出模式、用于进程集成的 RPC 模式，以及用于嵌入自有应用的 SDK。

<a id="share-your-oss-coding-agent-sessions"></a>
## 分享你的开源编码智能体会话

如果你使用 Pi 参与开源开发，欢迎分享你的编码智能体会话。

公开的开源会话数据能够基于真实开发工作流，帮助改进模型、提示词、工具和评测。

完整说明见[这篇 X 帖子](https://x.com/badlogicgames/status/2037811643774652911)。

发布会话可以使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。配置步骤见其 README.md。你只需要 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中演示了如何发布 `pi-mono` 会话。

作者会定期在这里发布自己的 `pi-mono` 工作会话：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

<a id="table-of-contents"></a>
## 目录

- [快速开始](#quick-start)
- [模型提供商与模型](#providers--models)
- [交互模式](#interactive-mode)
  - [编辑器](#editor)
  - [命令](#commands)
  - [键盘快捷键](#keyboard-shortcuts)
  - [消息队列](#message-queue)
- [会话](#sessions)
  - [分支](#branching)
  - [上下文压缩](#compaction)
- [设置](#settings)
- [上下文文件](#context-files)
- [自定义](#customization)
  - [提示词模板](#prompt-templates)
  - [技能](#skills)
  - [扩展](#extensions)
  - [主题](#themes)
  - [Pi 包](#pi-packages)
- [编程调用](#programmatic-usage)
- [设计理念](#philosophy)
- [CLI 参考](#cli-reference)

---

<a id="quick-start"></a>
## 快速开始

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装时禁用依赖的生命周期脚本。正常通过 npm 安装 Pi 不需要运行安装脚本。

也可以使用安装器：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

使用 API Key 认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或者使用已有订阅：

```bash
pi
/login  # 然后选择提供商
```

接下来直接与 Pi 对话即可。默认情况下，Pi 向模型提供四个工具：`read`、`write`、`edit` 和 `bash`。模型使用它们完成你的请求。还可以通过[技能](#skills)、[提示词模板](#prompt-templates)、[扩展](#extensions)或 [Pi 包](#pi-packages)增加能力。

**平台说明：** [Windows](docs/windows.md) | [Termux（Android）](docs/termux.md) | [tmux](docs/tmux.md) | [终端设置](docs/terminal-setup.md) | [Shell 别名](docs/shell-aliases.md)

---

<a id="providers--models"></a>
## 模型提供商与模型

Pi 为每个内置提供商维护一份支持工具调用的模型列表。已配置提供商的模型目录会自动刷新；运行 `pi update --models` 可以立即强制刷新。通过订阅（`/login`）或 API Key 完成认证后，使用 `/model`（或 Ctrl+L）选择该提供商的模型。在模型选择器中按 Ctrl+S，可将当前高亮模型保存为启动时的默认模型。

**订阅：**

- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro（Codex）
- GitHub Copilot

**API Key：**

- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan（全球）
- ZAI Coding Plan（中国）
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan（中国）
- Xiaomi MiMo Token Plan（阿姆斯特丹）
- Xiaomi MiMo Token Plan（新加坡）

Pi 也支持 llama.cpp 路由服务器。使用 `/login llama.cpp` 配置，通过 `/llama` 管理下载和已加载的模型，再用 `/model` 选择已加载的模型。配置与用法见 [docs/llama-cpp.md](docs/llama-cpp.md)。

其他提供商的配置说明见 [docs/providers.md](docs/providers.md)。

**自定义提供商与模型：** 如果提供商支持已有 API 协议（OpenAI、Anthropic、Google），可以通过 `~/.pi/agent/models.json` 添加。自定义 API 或 OAuth 请使用扩展。详见 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

<a id="interactive-mode"></a>
## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="交互模式" width="600"></p>

界面从上到下依次为：

- **启动信息区**：显示快捷键（`/hotkeys` 查看全部）、已加载的 AGENTS.md 文件、提示词模板、技能和扩展。
- **消息区**：显示你的消息、助手回复、工具调用与结果、通知、错误及扩展 UI。
- **编辑器**：输入内容的区域；边框颜色表示思考级别，边框上也会显示流式处理中的工作指示器。
- **底栏**：显示工作目录、会话名称、累计 token/缓存用量（`↑` 输入、`↓` 输出、`R` 缓存读取、`W` 缓存写入、`CH` 最近一次缓存命中率）、费用、上下文用量和当前模型。累计值包含助手回复、工具上报的用量以及摘要生成。

编辑器可以被其他 UI 临时替换，例如内置的 `/settings`，或扩展提供的自定义 UI（如让用户以结构化方式回答模型问题的问答工具）。[扩展](#extensions)也可以替换编辑器，在其上下添加组件、状态行、自定义底栏或浮层。

<a id="editor"></a>
### 编辑器

| 功能 | 操作方式 |
|------|----------|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter（Windows Terminal 中也可用 Ctrl+Enter） |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR` 指定的编辑器；Windows 默认使用记事本，其他平台默认使用 `nano` |
| 剪贴板 | Ctrl+V 粘贴图片或文本（Windows 为 Alt+V），也可以将图片拖入终端 |
| Bash 命令 | `!command` 执行命令并将输出发送给 LLM；`!!command` 执行但不发送输出 |

同时支持删除单词、撤销等标准编辑快捷键。详见 [docs/keybindings.md](docs/keybindings.md)。

<a id="commands"></a>
### 命令

在编辑器输入 `/` 触发命令。[扩展](#extensions)可以注册自定义命令，[技能](#skills)通过 `/skill:name` 调用，[提示词模板](#prompt-templates)通过 `/templatename` 展开。

| 命令 | 说明 |
|------|------|
| `/login`、`/logout` | 管理提供商凭证 |
| [`/llama`](docs/llama-cpp.md) | 下载、加载和卸载 llama.cpp 路由模型 |
| `/model` | 切换模型；在选择器中按 Ctrl+S 保存启动默认值 |
| `/thinking` | 切换思考级别；在选择器中按 Ctrl+S 保存启动默认值 |
| `/scoped-models` | 启用或禁用参与 Ctrl+P 循环切换的模型 |
| `/settings` | 设置主题、消息投递、传输方式和其他偏好 |
| `/resume` | 从历史会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话信息（文件、ID、消息、token、费用） |
| `/tree` | 跳转到会话中的任意位置并从那里继续 |
| `/trust` | 保存项目可信决定，供后续会话使用（需要重启） |
| `/fork` | 从先前的用户消息创建新会话 |
| `/clone` | 将当前活动分支复制到新会话 |
| `/compact [prompt]` | 手动压缩上下文，可附带自定义指令 |
| `/copy` | 将助手最后一条消息复制到剪贴板 |
| `/export [file]` | 将会话导出为 HTML 或 JSONL 文件 |
| `/import <file>` | 从 JSONL 文件导入并恢复会话 |
| `/share` | 上传为私密 GitHub gist，并提供可分享的 HTML 链接 |
| `/reload` | 重新加载快捷键、扩展、技能、提示词、主题和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 Pi |

<a id="keyboard-shortcuts"></a>
### 键盘快捷键

完整列表见 `/hotkeys`。通过 `~/.pi/agent/keybindings.json` 自定义。详见 [docs/keybindings.md](docs/keybindings.md)。

**常用快捷键：**

| 按键 | 操作 |
|------|------|
| Ctrl+C | 清空编辑器 |
| 连按两次 Ctrl+C | 退出 |
| Escape | 取消或中止 |
| 连按两次 Escape | 打开 `/tree` |
| Ctrl+L | 打开模型选择器 |
| Ctrl+P / Shift+Ctrl+P | 向前或向后循环切换限定范围内的模型 |
| Shift+Tab | 循环切换思考级别 |
| Ctrl+O | 折叠或展开工具输出 |
| Ctrl+T | 折叠或展开思考内容 |
| Ctrl+X | 复制助手最后一条消息；全屏模式关闭“选中即复制”时，复制当前选中的文本 |

<a id="message-queue"></a>
### 消息队列

智能体工作时也可以提交消息：

- **Enter**：将消息加入 *steering（引导）* 队列，在当前助手回合的工具调用全部执行完成后投递。
- **Alt+Enter**：将消息加入 *follow-up（后续）* 队列，仅在智能体完成全部工作后投递。
- **Escape**：中止执行，并将排队消息恢复到编辑器。
- **Alt+Up**：取回排队消息到编辑器。

Windows Terminal 默认将 `Alt+Enter` 用于切换全屏。请按 [docs/terminal-setup.md](docs/terminal-setup.md) 重新映射，以便 Pi 接收后续消息快捷键。

在[设置](docs/settings.md)中配置投递方式：`steeringMode` 和 `followUpMode` 可设为 `"one-at-a-time"`（默认，逐条投递并等待回复）或 `"all"`（一次投递全部排队消息）。对于支持多种传输方式的提供商，`transport` 用来指定偏好：`"sse"`、`"websocket"` 或 `"auto"`。

---

<a id="sessions"></a>
## 会话

会话以树结构存储在 JSONL 文件中。每个条目都有 `id` 和 `parentId`，因此可以在同一文件中创建分支，无需新建文件。文件格式见 [docs/session-format.md](docs/session-format.md)。

<a id="management"></a>
### 会话管理

会话按工作目录组织，并自动保存到 `~/.pi/agent/sessions/`。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择历史会话
pi --no-session        # 临时模式（不保存）
pi --name "my task"    # 启动时设置会话显示名称
pi --session <path|id> # 使用指定会话文件或 ID
pi --fork <path|id>    # 从指定会话文件或 ID 派生新会话
```

在交互模式中使用 `/session` 查看当前会话 ID，之后可以通过 `--session <id>` 或 `--fork <id>` 复用。

<a id="branching"></a>
### 分支

**`/tree`**：在当前文件内浏览会话树。选择任意历史位置，从那里继续，并在分支之间切换。所有历史都保留在同一个文件中。

<p align="center"><img src="docs/images/tree-view.png" alt="会话树视图" width="600"></p>

- 输入文本进行搜索；使用 Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ 折叠、展开以及在分支间跳转；使用 ←/→ 翻页。
- 筛选模式（Ctrl+O）：默认 → 隐藏工具 → 仅用户消息 → 仅带标签条目 → 全部。
- 按 Ctrl+X 复制选中的消息。
- 按 Shift+L 给条目添加标签作为书签；按 Shift+T 切换标签时间戳的显示。

**`/fork`**：从活动分支上先前的用户消息创建新会话文件。它会打开选择器，复制到该位置为止的活动路径，并把选中的提示词放入编辑器供你修改。

**`/clone`**：在当前位置，将当前活动分支复制到新会话文件。新会话保留活动路径的完整历史，并以空编辑器打开。

**`--fork <path|id>`**：直接从 CLI 使用已有会话文件或部分会话 UUID 派生新会话。它会将源会话完整复制到当前项目的新会话文件中。

<a id="compaction"></a>
### 上下文压缩

长会话可能耗尽上下文窗口。压缩会对较早的消息生成摘要，同时保留近期消息。

**手动：** `/compact` 或 `/compact <custom instructions>`

**自动：** 默认启用。在上下文溢出时触发（恢复后重试），或接近上限时主动触发。通过 `/settings` 或 `settings.json` 配置。

压缩是有损的。完整历史仍保留在 JSONL 文件中，可使用 `/tree` 回看。可以通过[扩展](#extensions)自定义压缩行为。内部机制见 [docs/compaction.md](docs/compaction.md)。

---

<a id="settings"></a>
## 设置

使用 `/settings` 修改常用选项，也可以直接编辑 JSON 文件：

| 位置 | 作用范围 |
|------|----------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目级（覆盖全局设置） |

全部选项见 [docs/settings.md](docs/settings.md)。

<a id="project-trust"></a>
### 项目信任

交互启动时，如果项目文件夹包含项目级设置、资源或项目 `.agents/skills`，且 `~/.pi/agent/trust.json` 中未保存该文件夹或其父文件夹的信任决定，Pi 会先询问是否信任。信任项目后，Pi 可以加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目包，并执行项目扩展。

做出信任决定之前，Pi 只加载上下文文件、用户/全局扩展和 CLI `-e` 指定的扩展，以便它们处理 `project_trust` 事件。项目级扩展、项目包管理的扩展和项目设置，仅在项目获得信任后加载。切换到另一个工作目录的会话时，如果当前进程尚未确定该目录的信任状态，也遵循这一划分。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示信任提示。没有适用的已保存信任决定时，使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略这些项目资源，`always` 则信任它们。传入 `--approve`/`-a` 或 `--no-approve`/`-na`，可覆盖本次运行的项目信任设置。

如果没有扩展处理或已保存决定可用，`defaultProjectTrust` 控制回退行为。可在 `~/.pi/agent/settings.json` 中设为 `"ask"`、`"always"` 或 `"never"`，也可以通过 `/settings` 修改。

`pi config` 和包管理命令采用相同的项目信任流程，但 `pi update` 始终不弹出询问。传入 `--approve` 可在单次命令中信任项目级设置，传入 `--no-approve` 则忽略它们。

在交互模式中使用 `/trust`，可为后续会话保存项目信任决定，也可以信任直接父文件夹。它只写入 `~/.pi/agent/trust.json`，不会重新加载当前会话，因此需要重启 Pi 才能生效。

<a id="telemetry-and-update-checks"></a>
### 遥测与更新检查

Pi 启动时有两项独立功能：

- **更新检查：** 请求 `https://pi.dev/api/latest-version`，检查是否存在更新版本。设置 `PI_SKIP_VERSION_CHECK=1` 可禁用。禁用更新检查只会关闭这一项检查。
- **安装/更新遥测：** 首次安装或通过更新日志检测到版本更新后，向 `https://pi.dev/api/report-install` 发送匿名版本报告。该设置也控制 OpenRouter、Cloudflare 和直接 NVIDIA NIM 请求中的可选提供商归因请求头。将 `settings.json` 中的 `enableInstallTelemetry` 设为 `false`，或设置 `PI_TELEMETRY=0`，即可退出。这不会禁用更新检查；除非关闭更新检查或启用离线模式，否则 Pi 仍可能访问 `pi.dev` 获取最新版本。

使用 `--offline` 或 `PI_OFFLINE=1` 可禁用这里描述的所有启动网络操作，包括版本更新检查、包更新检查和安装/更新遥测。

---

<a id="context-files"></a>
## 上下文文件

Pi 启动时从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：

- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 向上查找）
- 当前目录

如果某个目录中存在 `AGENTS.override.md`，Pi 会加载它，替代该目录的 `AGENTS.md` 或 `CLAUDE.md`。其他目录的上下文文件仍会拼接进来。

这些文件适合存放项目指令（`AGENTS.md`/`CLAUDE.md`）、约定和常用命令。所有匹配文件的内容会拼接在一起。

使用 `--no-context-files`（或 `-nc`）禁用上下文文件加载。

<a id="system-prompt"></a>
### 系统提示词

使用 `.pi/SYSTEM.md`（项目级）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认系统提示词。通过 `APPEND_SYSTEM.md` 可以追加内容而不替换原提示词。

---

<a id="customization"></a>
## 自定义

<a id="prompt-templates"></a>
### 提示词模板

将可复用提示词保存为 Markdown 文件。输入 `/name` 即可展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
检查这段代码中的缺陷、安全问题和性能问题。
重点关注：{{focus}}
```

放在 `~/.pi/agent/prompts/`、`.pi/prompts/` 或 [Pi 包](#pi-packages)中，即可与他人共享。详见 [docs/prompt-templates.md](docs/prompt-templates.md)。

<a id="skills"></a>
### 技能

技能是遵循 [Agent Skills 标准](https://agentskills.io)的按需能力包。通过 `/skill:name` 调用，也可以让智能体自动加载。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# 我的技能
当用户询问 X 时使用此技能。

## 步骤
1. 先做这一步
2. 再做下一步
```

放在 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`、`.agents/skills/`（从 `cwd` 向上遍历父目录），或 [Pi 包](#pi-packages)中，即可与他人共享。详见 [docs/skills.md](docs/skills.md)。

<a id="extensions"></a>
### 扩展

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom 扩展" width="600"></p>

扩展是 TypeScript 模块，可以为 Pi 增加自定义工具、命令、键盘快捷键、事件处理器和 UI 组件。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

默认导出也可以是 `async` 函数。Pi 会等待异步扩展工厂执行完成，再继续启动。适合一次性初始化，例如在调用 `pi.registerProvider()` 前获取远程模型列表。

**可以实现的功能：**

- 自定义工具（也可以完全替换内置工具）
- 子智能体和计划模式
- 自定义压缩与摘要
- 权限检查和路径保护
- 自定义编辑器和 UI 组件
- 状态行、页眉和底栏
- Git 检查点和自动提交
- SSH 和沙箱执行
- MCP 服务器集成
- 让 Pi 的外观类似 Claude Code
- 等待时玩游戏（没错，可以运行 Doom）
- ……以及其他你能想到的功能

放在 `~/.pi/agent/extensions/`、`.pi/extensions/` 或 [Pi 包](#pi-packages)中，即可与他人共享。详见 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

<a id="themes"></a>
### 主题

内置主题为 `dark` 和 `light`。主题支持热重载：修改当前主题文件后，Pi 会立即应用变更。

放在 `~/.pi/agent/themes/`、`.pi/themes/` 或 [Pi 包](#pi-packages)中，即可与他人共享。详见 [docs/themes.md](docs/themes.md)。

<a id="pi-packages"></a>
### Pi 包

通过 npm 或 git 打包并共享扩展、技能、提示词和主题。可以在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 查找包。

> **安全提示：** Pi 包以完整系统访问权限运行。扩展可以执行任意代码，技能可以指示模型执行任何操作，包括运行可执行文件。安装第三方包前请审查源代码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # 固定版本
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # 标签或提交
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # 标签或提交
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # 标签或提交
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # 标签或提交
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # remove 的别名
pi list
pi update                               # 仅更新 Pi
pi update --all                         # 更新 Pi 和包
pi update --extensions                  # 仅更新包
pi update --models                      # 仅刷新模型目录
pi update --self                        # 仅更新 Pi
pi update --self --force                # 即使已是当前版本也重新安装
pi update npm:@foo/pi-tools             # 更新单个包
pi config                               # 启用或禁用扩展、技能、提示词和主题
```

包安装到 `~/.pi/agent/git/`（git）或 `~/.pi/agent/npm/`（npm）。使用 `-l` 进行项目级安装（`.pi/git/`、`.pi/npm/`）。Git 的 `@ref` 值用于固定标签或提交；`pi update --extensions` 和 `pi update --all` 会跳过已固定的包，所以需要使用 `pi install git:host/user/repo@new-ref` 将已有包切换到新 ref。Git 包默认使用 `npm install --omit=dev` 安装依赖，因此运行时依赖必须列在 `dependencies` 中；配置了 `npmCommand` 时，Git 包使用普通的 `install`，以兼容包装命令。如果使用 Node 版本管理器，并希望包安装复用稳定的 npm 环境，可在 `settings.json` 中设置 `npmCommand`，例如 `["mise", "exec", "node@20", "--", "npm"]`。

在 `package.json` 中添加 `pi` 字段即可创建包：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

没有 `pi` 清单时，Pi 会从约定目录（`extensions/`、`skills/`、`prompts/`、`themes/`）自动发现资源。

详见 [docs/packages.md](docs/packages.md)。

---

<a id="programmatic-usage"></a>
## 编程调用

<a id="sdk"></a>
### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

对于多会话运行时替换等高级用法，使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。

详见 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

<a id="rpc-mode"></a>
### RPC 模式

与非 Node.js 程序集成时，可以使用通过 stdin/stdout 通信的 RPC 模式：

```bash
pi --mode rpc
```

RPC 模式使用严格按 LF 分隔的 JSONL 帧。客户端必须只按 `\n` 拆分记录。不要使用 Node `readline` 等通用行读取器，因为它们还会在 JSON 载荷内部的 Unicode 分隔符处拆行。

协议详见 [docs/rpc.md](docs/rpc.md)。

---

<a id="philosophy"></a>
## 设计理念

Pi 提供充分的可扩展性，让你自行决定工作流。其他工具内置的功能，可以通过[扩展](#extensions)、[技能](#skills)实现，也可以安装第三方 [Pi 包](#pi-packages)。这让核心保持精简，同时允许你按照自己的工作方式定制 Pi。

**不内置 MCP。** 构建带 README 的 CLI 工具（见[技能](#skills)），或编写扩展添加 MCP 支持。[原因是什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**不内置子智能体。** 实现方式有很多。可以通过 tmux 启动多个 Pi 实例，使用[扩展](#extensions)自行实现，或安装符合你需求的包。

**不内置权限弹窗。** 在容器中运行，或根据自己的环境和安全要求，用[扩展](#extensions)构建确认流程。

**不内置计划模式。** 将计划写入文件，或通过[扩展](#extensions)实现，也可以安装相关包。

**不内置待办列表。** 它们会让模型混淆。使用 TODO.md 文件，或通过[扩展](#extensions)自行实现。

**不内置后台 Bash。** 使用 tmux，可以完整观察运行状态并直接交互。

完整理由见[这篇博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

---

<a id="cli-reference"></a>
## CLI 参考

```bash
pi [options] [--] [@files...] [messages...]
```

<a id="package-commands"></a>
### 包管理命令

```bash
pi install <source> [-l]     # 安装包，-l 表示项目级安装
pi remove <source> [-l]      # 移除包
pi uninstall <source> [-l]   # remove 的别名
pi update [source|self|pi]   # 仅更新 Pi，或更新指定包来源
pi update --all              # 更新 Pi 和包
pi update --extensions       # 仅更新包
pi update --models           # 仅刷新模型目录
pi update --self             # 仅更新 Pi
pi update --self --force     # 即使已是当前版本也重新安装
pi update --extension <src>  # 更新单个包
pi list                      # 列出已安装包
pi config                    # 启用或禁用包资源
```

`pi config` 和项目包管理命令接受 `--approve`/`--no-approve`，用于在单次命令中信任或忽略项目级设置。`pi update` 始终不会询问项目信任。

<a id="modes"></a>
### 运行模式

| 参数 | 说明 |
|------|------|
| （默认） | 交互模式 |
| `-p`、`--print` | 输出回复后退出 |
| `--mode json` | 将所有事件按 JSON 行输出（见 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（见 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 将会话导出为 HTML |

文本输出模式也会读取管道传入的 stdin，并合并到初始提示词中：

```bash
cat README.md | pi -p "Summarize this text"
```

<a id="model-options"></a>
### 模型选项

| 选项 | 说明 |
|------|------|
| `--provider <name>` | 提供商（anthropic、openai、google 等） |
| `--model <pattern>` | 模型匹配模式或 ID（支持 `provider/id` 和可选的 `:<thinking>`） |
| `--api-key <key>` | API Key（覆盖环境变量） |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `--models <patterns>` | 以逗号分隔的模型匹配模式，用于 Ctrl+P 循环切换 |
| `--list-models [search]` | 列出可用模型 |

<a id="session-options"></a>
### 会话选项

| 选项 | 说明 |
|------|------|
| `-c`、`--continue` | 继续最近的会话 |
| `-r`、`--resume` | 浏览并选择会话 |
| `--session <path\|id>` | 使用指定会话文件或部分 UUID |
| `--fork <path\|id>` | 从指定会话文件或部分 UUID 派生新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式（不保存） |
| `--name <name>`、`-n <name>` | 启动时设置会话显示名称 |

<a id="tool-options"></a>
### 工具选项

| 选项 | 说明 |
|------|------|
| `--tools <list>`、`-t <list>` | 按名称指定内置、扩展和自定义工具的允许列表 |
| `--exclude-tools <list>`、`-xt <list>` | 按名称禁用指定的内置、扩展和自定义工具 |
| `--no-builtin-tools`、`-nbt` | 默认禁用内置工具，但保留扩展和自定义工具 |
| `--no-tools`、`-nt` | 默认禁用所有工具 |

可用内置工具：`read`、`bash`、`powershell`（Windows）、`edit`、`write`、`grep`、`find`、`ls`。

<a id="resource-options"></a>
### 资源选项

| 选项 | 说明 |
|------|------|
| `-e`、`--extension <source>` | 从路径、npm 或 git 加载扩展（可重复指定） |
| `--no-extensions` | 禁用扩展发现 |
| `--skill <path>` | 加载技能（可重复指定） |
| `--no-skills` | 禁用技能发现 |
| `--prompt-template <path>` | 加载提示词模板（可重复指定） |
| `--no-prompt-templates` | 禁用提示词模板发现 |
| `--theme <path>` | 加载主题（可重复指定） |
| `--no-themes` | 禁用主题发现 |
| `--no-context-files`、`-nc` | 禁用 AGENTS.md 和 CLAUDE.md 上下文文件发现 |

将 `--no-*` 与显式参数组合，可以忽略 settings.json，只加载指定资源，例如 `--no-extensions -e ./my-ext.ts`。

<a id="other-options"></a>
### 其他选项

| 选项 | 说明 |
|------|------|
| `--system-prompt <text>` | 替换默认提示词（仍会追加上下文文件和技能） |
| `--append-system-prompt <text>` | 追加系统提示词 |
| `--tui-mode <mode>` | TUI 模式：`regular`（默认）或实验性 `fullscreen` |
| `--use-theme <name[/name]>` | 设置本次运行的初始交互主题，不修改设置文件 |
| `--verbose` | 强制显示详细启动信息 |
| `-a`、`--approve` | 本次运行信任项目级文件 |
| `-na`、`--no-approve` | 本次运行忽略项目级文件 |
| `--` | 停止解析选项；其余参数作为提示词或 `@file` 输入 |
| `-h`、`--help` | 显示帮助 |
| `-v`、`--version` | 显示版本 |

<a id="file-arguments"></a>
### 文件参数

在文件名前加 `@`，将其包含在消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

<a id="examples"></a>
### 示例

```bash
# 带初始提示词的交互模式
pi "List all .ts files in src/"

# 非交互模式
pi -p "Summarize this codebase"

# 以连字符开头的提示词
pi -p -- "- Summarize these points"

# 通过管道传入 stdin 的非交互模式
cat README.md | pi -p "Summarize this text"

# 带名称的单次执行会话
pi --name "release audit" -p "Audit this repository"

# 使用其他模型
pi --provider openai --model gpt-4o "Help me refactor"

# 带提供商前缀的模型（无需 --provider）
pi --model openai/gpt-4o "Help me refactor"

# 思考级别简写
pi --model sonnet:high "Solve this complex problem"

# 限制循环切换的模型范围
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"

# 禁用一个扩展工具或内置工具，保留其余工具
pi --exclude-tools ask_question

# 高思考级别
pi --thinking high "Solve this complex problem"
```

<a id="environment-variables"></a>
### 环境变量

| 变量 | 说明 |
|------|------|
| `AI_AGENT` | CLI 和 RPC 入口将其设为 `pi`，供通用工具识别由 Pi 启动的子进程 |
| `PI_CODING_AGENT` | CLI 和 RPC 入口将其设为 `true`，让子进程检测到自己运行在 Pi 中 |
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录（可被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖包目录（适用于 Nix/Guix 等存储路径不利于 token 编码的环境） |
| `PI_SERVER_DIR` | 覆盖实验性服务器的配置与 socket 目录（默认：`~/.pi/server`） |
| `PI_SERVER_ID` | 未指定 `--server-id` 时，选择实验性服务器的逻辑 ID |
| `PI_OFFLINE` | 禁用启动网络操作，包括版本更新检查、包更新检查和安装/更新遥测 |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的 Pi 版本更新检查，阻止向 `pi.dev` 请求最新版本 |
| `PI_TELEMETRY` | 覆盖安装/更新遥测与提供商归因请求头设置。`1`/`true`/`yes` 启用，`0`/`false`/`no` 禁用。不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 设为 `long` 可延长提示词缓存时间（Anthropic：1 小时，OpenAI：24 小时） |
| `VISUAL`、`EDITOR` | 未设置 `externalEditor` 时，作为 Ctrl+G 的备用外部编辑器；Windows 默认为记事本，其他平台默认为 `nano` |

LLM 可调用的 `bash` 和 `powershell` 工具运行的命令，还会收到当前会话元数据：

| 变量 | 说明 |
|------|------|
| `PI_SESSION_ID` | 当前会话 ID |
| `PI_SESSION_FILE` | 会话 JSONL 文件的绝对路径；临时会话不设置此变量 |
| `PI_PROVIDER` | 当前选中模型的提供商 |
| `PI_MODEL` | 当前选中的模型 ID |
| `PI_REASONING_LEVEL` | 当前实际生效的推理级别 |

这些值在每条命令启动时解析。具体语义、示例，以及自定义工具如何选择不注入这些变量，见[环境变量](docs/environment-variables.md#shell-tool-session-environment)。

---

<a id="contributing--development"></a>
## 贡献与开发

贡献指南见 [CONTRIBUTING.md](../../CONTRIBUTING.md)；环境配置、fork 和调试说明见 [docs/development.md](docs/development.md)。

<a id="license"></a>
## 许可证

MIT

<a id="see-also"></a>
## 另请参阅

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)：核心 LLM 工具库
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)：智能体框架
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)：终端 UI 组件

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下团队慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy 吉祥物" width="48" /><br />exe.dev</a>
</p>
