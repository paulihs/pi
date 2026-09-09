<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的新 Issue 和 PR 默认会自动关闭。维护者每天会检查自动关闭的 Issue。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi Agent Harness（Pi Agent 框架）

这是 Pi Agent 框架项目的主仓库，包含一个可自我扩展的编码 Agent。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式编码 Agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：提供工具调用和状态管理的 Agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多供应商 LLM API（OpenAI、Anthropic、Google 等）

了解 Pi 的更多信息：

* [访问 pi.dev](https://pi.dev)，查看项目网站和演示
* [阅读文档](https://pi.dev/docs/latest)；也可以直接让 Agent 解释自身

## 所有包

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | 面向服务、复制状态、RPC 和插件的独立应用组合运行时 |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 与供应商无关的遥测契约、参考适配器、一致性测试和类型化 Schema |
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多供应商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 提供工具调用和状态管理的 Agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码 Agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 支持差分渲染的终端 UI 库 |

关于 Slack/聊天自动化和工作流，请参阅 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 权限和容器化

Pi 没有内置的权限系统来限制文件系统、进程、网络或凭据访问。默认情况下，它使用启动它的用户和进程所拥有的权限运行。

如果需要更强的边界，请将 Pi 放入容器或沙箱中。三种模式请参阅 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)：

- **Gondolin 扩展**：将 `pi` 和供应商认证保留在宿主机，同时把内置工具和 `!` 命令路由到本地 Linux micro-VM。
- **普通 Docker**：将整个 `pi` 进程运行在本地容器中，实现简单隔离。
- **OpenShell**：将整个 `pi` 进程运行在由策略控制的沙箱中。

## 参与贡献

贡献指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)；项目针对人类和 Agent 的具体规则请参阅 [AGENTS.md](AGENTS.md)。Pi 的长期规划也可在 [RFC](https://rfc.earendil.com/keyword/pi/) 中查看。

## 开发

```bash
npm install --ignore-scripts  # 安装所有依赖，但不运行生命周期脚本
npm run build         # 刷新模型数据，然后构建所有包
npm run build:offline # 使用已有模型数据重新构建，不访问网络
npm run check         # 执行 lint、格式化和类型检查
./test.sh            # 运行测试（没有 API Key 时跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi（可从任意目录执行）
```

## 从发布源码构建独立可执行文件

GitHub Release 包含带版本号的源码归档，并由该 Release 的 `SHA256SUMS` 文件提供校验。解压后运行官方独立可执行文件使用的同一构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

源码归档包含该版本使用的供应商模型数据。`--offline-model-data` 使用归档中的快照构建，而不是从实时供应商目录刷新数据。脚本仍会安装依赖、构建 monorepo、编译 Bun 可执行文件并准备运行时资源。已经单独提供依赖的包维护者可以传入 `--skip-install --skip-deps`。

## 供应链加固

我们把 npm 依赖变更视为需要审查的代码变更。

- 外部直接依赖固定为精确版本。内部 workspace 包仍使用版本范围。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2`，避免 npm 解析时采用当天刚发布的依赖版本。
- `package-lock.json` 是依赖的唯一事实来源。除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`，否则提交前检查会阻止意外提交 lockfile。
- `npm run check` 会验证直接依赖是否固定、原生 TypeScript 导入兼容性以及生成的 coding-agent shrinkwrap。
- 发布的 CLI 包包含从根 lockfile 生成的 `packages/coding-agent/npm-shrinkwrap.json`，为 npm 用户固定传递依赖。
- 发布冒烟测试使用 `npm run release:local`，在打标签前于仓库外构建、打包并创建隔离的 npm 和 Bun 安装。
- 本地发布安装、文档中的 npm 安装以及 `pi update --self` 在支持时都会使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装依赖；定时 GitHub workflow 会运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- Shrinkwrap 生成对依赖生命周期脚本使用显式许可列表；新增带生命周期脚本的依赖必须经过审查，否则检查会失败。

## 分享你的开源编码 Agent 会话

如果你使用 Pi 或其他编码 Agent 进行开源工作，请分享你的会话。

公开的开源会话数据可以用真实任务、工具使用、失败和修复来改进编码 Agent，而不只是依赖玩具基准测试。

完整说明请参阅 [X 上的这篇文章](https://x.com/badlogicgames/status/2037811643774652911)。

要发布会话，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。设置说明请阅读它的 README.md。你只需要 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

也可以观看[这段视频](https://x.com/badlogicgames/status/2041151967695634619)，其中演示了如何发布我的 `pi-mono` 会话。

我会定期在这里发布自己的 `pi-mono` 工作会话：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 许可证

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下组织慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
