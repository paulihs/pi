# @earendil-works/chord

Chord 是一个面向插件/扩展组装系统的应用组合运行时。它提供 facet、服务、复制状态和可插拔的远程服务边界。Chord 在 Pi monorepo 中作为独立包开发，但它不是 Pi 包：不依赖任何其他 Pi workspace 包，也可以被无关的应用使用。

## Chord 的用途

同一个应用功能可能需要运行在多个环境中，例如 Agent worker、终端 UI 和远程 WebUI。Chord 提供通用机制，让你能够以同时适合人类和 Agent 的方式编写这类扩展。

该设计由几个相互关联的部分组成：

- **Plugin** 是同步设置单元，用于声明自己提供和需要的服务。所有 Plugin 声明形状后，Host 会验证完整依赖图、绑定服务、先激活供应商再激活消费者，并按依赖的逆序释放资源。这些单元称为 *facet*。

- **Facet** 是 Plugin 的组成部分。每个 facet 独立打包，并在预期的进程或环境中运行。你可以用 facet 将一个 Plugin 拆成需要加载到不同进程和环境中的独立部分（例如后端、浏览器、TUI 等）。

- **服务** 是类型化且稳定的 Token，可以只有一个供应商（**singleton**），也可以拥有动态的键控实例（**keyed**）。服务可以只存在于进程内，使用不受限制的 JavaScript 契约，也可以对外远程暴露。供应商断开或被替换时，消费者仍保留稳定的 facade。

- **复制状态** 向本地和远程连接消费者暴露权威状态。生产者修改被跟踪的 `state` 代理并调用 `publish(context)`；消费者接收完整的不可变值。Chord 每次发布只刷新一个解码后的操作批次，同时每个远程客户端/状态流拥有独立的路径编解码状态。副本在断开或替换后会变为未就绪，直到重新水合。

- **Delta 跟踪** 在刷新时从被跟踪的普通 JSON 推导紧凑操作。它无需保留变更历史，就能保留字符串追加/前端截断和数组追加行为，支持持久化基础批次，并在应用不可信操作时进行验证。

- **远程服务源** 广播 facet host 外部可用的服务，并为 facet 所需的服务打开绑定。绑定通过应用提供的适配器承载逻辑调用和订阅。Chord 要求参数、结果、快照、更新和目录使用严格 JSON，但不规定分帧、路由、传输或应用线协议外壳。`JsonRepresentation<T>` 为带未知负载的应用数据推导可安全在线传输的类型，`isJsonValue()` 则在适配器边界验证接收值。对称 RPC 对端计划作为该边界的一种可选实现。

- **Context** Chord 提供类似 Go 的 Context 系统，用于取消和携带调用范围内的应用值。应用可以通过这些值传递权限或遥测信息，而 Chord 不依赖其中任何一种。

当前运行时从 `@earendil-works/chord` 导出服务 Token、singleton 和 keyed 供应商、远程绑定、复制状态、facet host 和 facet loader。请从包根导入公共类型和通用运行时 API。Context 常量和函数位于 `@earendil-works/chord/context`，因为它们的通用名称不应污染根 API。Chord 所有的标识符使用 `chord.*` 命名空间，保留的服务前缀是 `$chord.*`。

## 远程服务适配器

Chord 负责与传输无关的服务线协议语法。消费者适配器使用 `createServiceCatalogueCall()`、`createServiceSubscribeCall()` 和 `createServiceUnsubscribeCall()` 发起 `$chord.service` 控制调用。`createRemoteServiceEndpoint()` 为一个供应商消费者处理这些调用，包括激活和清理订阅。适配器建立严格 JSON 边界后，`parseServiceCall()`、`parseServiceCatalogue()` 以及解码/线上的快照和更新解析器会验证 Chord 语义。`RemoteServiceErrorCode` 和 `REMOTE_SERVICE_ERROR_CODES` 定义可以跨越该边界的服务错误。

复制状态操作对每个订阅分别在供应商侧使用一个 `createServiceStateEncoder()`，在消费者侧使用一个 `createServiceStateDecoder()`。这些注册表为每个实例/成员状态创建独立的 Delta 路径字典，并在替换、不可用、关闭或重新水合时重置。应用可以将这些值放入任意路由、请求、响应或事件信封中；Chord 不规定外层协议。

## Tracking JSON deltas

Import the standalone delta primitive from `@earendil-works/chord/delta`:

```ts
import { apply, track } from "@earendil-works/chord/delta";

const changes = track({ output: "", count: 0 });
changes.flush(); // opening base batch
changes.state.output += "done\n";
changes.state.count += 1;

const ops = changes.flush();
const replica = apply({ output: "", count: 0 }, ops);
```

第一次 flush 始终是完整的基础批次。后续 flush 包含基于路径的变更。`applyImmutable()` 应用这些批次，同时保留之前的副本版本。`replicatedState(initial)` 直接使用跟踪功能：

```ts
const status = env.replicatedState({ output: "", count: 0 });
status.state.output += "done\n";
status.state.count += 1;
status.publish(context);
```

`publish()` 只执行一次 flush；远程连接层会为每个客户端/状态组合独立编码该操作批次。字符串赋值会将纯追加和滚动窗口移动保留为追加与前端截断操作；无关的重写则回退为 set。插入被跟踪状态的值会归跟踪器所有，之后只能通过 `state` 修改。关于变更、数组、生命周期和消费者所有权规则，请参阅 [Delta 指南](src/delta/README.md)。

## 打包和加载 facet

`@earendil-works/chord/bundler` 使用 esbuild 将 ESM 或 TypeScript 应用入口转换为独立且按内容寻址的 CommonJS 文件。包级 API 从 `package.json` 读取 Plugin 身份和构建配置，然后应用 Host 提供的 facet 路径约定：

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "@earendil-works/chord": "^0.84.4"
  },
  "chord": {
    "facets": {
      "worker": "./src/custom-worker.ts",
      "presentation": false
    }
  }
}
```

```ts
import { bundleFacetPackage } from "@earendil-works/chord/bundler";

await bundleFacetPackage({
	packagePath: "/path/to/my-plugin",
	outdir: "/application-owned/plugin-builds/my-plugin",
	defaultFacets: {
		worker: "src/worker.ts",
		presentation: "src/presentation.ts",
	},
});
```

除非 `chord.facets` 覆盖或禁用，现有的约定文件都会成为入口。Peer 依赖会被外置，并在加载时根据 Host 解析。Chord 从不安装依赖或运行包生命周期脚本。对于已经拥有明确 Plugin 身份和入口映射的调用方，仍可以使用底层 API `bundleFacets()`。

输出目录中每个入口对应一个 `.cjs` 文件，另有 `chord-facets.json`。通过仅支持 Node 的 loader 加载应用选定的入口：

```ts
import { createFacetBundleLoader } from "@earendil-works/chord/node";

const loader = createFacetBundleLoader({
	manifestPath: "/application-owned/plugin-builds/my-plugin/chord-facets.json",
	entry: "worker",
	resolveExternal: (specifier) => import.meta.resolve(specifier),
});
const loaded = await loader.load();
```

每次 `load()` 都会验证 SHA-256 完整性，并使用 `node:vm` 直接编译 CommonJS 内容，而不是将 Plugin 放入 Node 的 CommonJS 或 ESM 模块缓存。外部依赖由 Host 解析，并通过受限的 `require` 加载；esbuild 会降低动态导入，使其使用同一路径。释放已退役的 generation 会释放 loader 对 facet 的引用；当 Plugin 自有资源也释放后，其编译代码即可被垃圾回收。

传输到另一个 Node Host 时，`readFacetBundleArtifact()` 会将一个经过验证的 manifest 入口及其源码打包，`createFacetBundleArtifactLoader()` 会在接收 Host 上解析外部依赖的同时生成新的临时 generation。

要重新加载，先加载候选版本，将其 facet 传给 `FacetHost.reload()`；失败时释放候选版本，只有成功切换后才释放退役的 `LoadedFacets`。Host 会在旧供应商仍保持路由的情况下激活并验证候选版本，然后直接替换每个 singleton，不产生不可用间隔。因此，稳定的服务 handle 在普通 reload 期间不会断开。Keyed 实例仍与各自 generation 绑定，替换时会获得新的 generation。Bundler 会先写入完整的临时目录，再替换旧输出，因此 loader 不会看到只构建了一半的 generation。

更完整的 RPC 和 generation 加载架构请参阅 [PLANNING.md](PLANNING.md)。
