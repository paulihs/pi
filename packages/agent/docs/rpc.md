# Facet Service RPC

Chord 负责与应用无关的服务语义和可插拔的严格 JSON 连接边界。Pi 负责本文描述的具体 wire envelope、路由、附着状态和错误 adapter。当前实现将 `JsonValue` 视为静态契约，并把不支持值的运行时拒绝交给具体 serializer。

> **状态：** experimental facet-service RPC 语义的设计规格。

## 作用

`provide()`/`use()` 以及 `provideMany().spawn()`/`observe()` 是 facet 系统隐藏的 RPC。Facet 共享 TypeScript 服务契约，而传输层承载服务/成员标识、严格 JSON 值、请求/订阅关联、带 key 的 generation 和绑定控制消息。宿主构造类型化本地实现或 facade；TypeScript 类型和任意对象不会跨越 wire。独立加载的进程可能暂时运行不同的源代码 generation，因此在支持的版本偏差窗口内，服务契约必须保持向前兼容；版本协商仍待决定。

```text
session/server facet: provide() / provideMany().spawn()
                    ↕ hidden service RPC
presentation/session facet: use() / observe()
```

服务系统是扩展边界。Presentation facet 接收语义服务和复制状态；它们永远不会接收原始 Harness、Session、tool registry、hook registry、credential store 或 storage handle。

## 非目标

不要序列化 `Context`、`AbortSignal`、telemetry 对象、callback、tool、hook、函数或任意对象图。不要让核心 Harness 或 Session 实现感知传输机制。不要让 disconnect 执行持久或服务所有的取消。对于已经限制为 JSON 的值，不要为每个方法构建 codec。

## 服务契约和类型化 Facade

Service token 是共享的 TypeScript 契约和稳定 service ID。它不是生成的 descriptor，也不会创建 provider。默认情况下 token 可被远程发布；进程本地 token 声明 `{ local: true }`。`provide()` 向宿主图添加一个 singleton 实现。`provideMany()` 在 facet setup 期间注册一个多实例服务所有者，并返回 `ServiceSpawner`，其后续 `spawn()` 调用会发布实例。宿主自动发布每个非 local provision。一个 token 在一个宿主服务图中只能有一种模式：混用 singleton 和 keyed use 属于错误。

Provider 会将每个暴露的实现成员分类为方法或 Chord 创建的 `ReplicatedState`，并在订阅快照中发布成员表。消费者通过普通属性访问获得成员名——例如 JavaScript `Proxy` 为 `models.state` 收到 `"state"`，为 `models.refresh(context)` 收到 `"refresh"`。Facade 绑定时，会根据 provider 宣布的 kind 验证已访问的 slot。

本地和远程 `use()` 都会返回一个稳定、延迟创建的类型化 facade，供该 token 的消费者共享。在同步 facet setup 期间，facade 处于 disconnected 状态，因此 setup 可以捕获它，但不能调用方法、读取状态或注册成员订阅。组装完成后，本地 facade 通过进程本地实现 slot 直接解析，远程 facade 通过宿主的已连接服务绑定。重新加载提供方 facet 时，同一个 facade 会暂时标记为不可用，然后替换 target；RPC singleton 会清除 ready 状态，并在已有订阅上安装完整的替换快照，因此已捕获的方法和成员 facade 仍能指向替换对象。没有 provider 绑定时，调用方法会失败，状态保持未 hydration；调用不会仅仅因为通过 proxy 发出就进入队列。

远程方法返回 promise，并接受/返回严格 JSON（声明的 `Context` 除外）；`void` 是没有 result 字段的成功响应。不支持私有返回引用。客户端会在传输前移除 context，接收宿主构造新的本地 context。契约中该参数的位置由宿主控制，必须保持一致；示例使用一个必需的尾部 `Context`。业务上的缺失使用 JSON `null` 或 options 对象表示，绝不传输 `undefined`。

同时使用静态断言和运行时验证。静态检查限制远程方法和复制状态成员；运行时边界拒绝不支持的成员，以及非 JSON 的参数、结果和状态值。TypeScript 提供类型化 facade，但不会认证 peer，也不会创建运行时 metadata。

`{ local: true }` 只移除远程发布和 wire 契约限制。除此之外，本地和非本地 provision 使用相同的依赖账本、激活顺序、稳定 singleton slot、带 key 的实例 generation、observer 取消、销毁和 provider-facet reload。本地 singleton slot 和本地 keyed registry 直接持有任意对象契约；非本地 provision 还会将其实现安装到远程 provider 中。

## 依赖账本

类型擦除不会隐藏服务身份：每个 service token 在运行时都保留其稳定 ID。Facet environment 由宿主使用不可伪造的 owner identity 创建，其 setup 阶段的 service 方法会向 generation 作用域的账本追加记录：

- `provide()` 记录 singleton provision；
- `provideMany()` 记录 keyed provision；
- `use()` 记录 singleton requirement；
- `observe()` 记录 keyed requirement。

Facet 始终调用不带限定的 `env.use()` 或 `env.observe()`；路由不会编码在调用中。这些操作在 setup 期间返回与源无关的 disconnected handle。setup 后，每个 connection 返回 provider 生成的服务目录，宿主将每个 requirement 绑定到本地 provision 或恰好一个已连接 provider。方法提供 mode，token 提供 ID。因此宿主不需要反射被擦除的 `T`，也不需要手写平行依赖列表。

只有在 facet setup 期间才允许第一次 acquisition 或 provision。后续 command、hook 和 activation callback 使用 setup 获取的 singleton facade、observer registration 或 `ServiceSpawner` 能力。特别是，动态实例必须通过 `provideMany()` 返回的能力生成；晚到的 spawn 不能引入此前未声明的 provision。

Setup 后，每个宿主会将记录的 requirement 私下解析到本地 provision 和连接目录中，以拒绝缺失 provider、重复远程 offer 和模式不匹配，并推导生命周期边。没有 live attachment 的 selected-Session connection 可以暂时接受未解析 requirement，并将它们视为 unavailable；附着时会根据 worker 生成的目录验证它们，并为后续 detached generation 缓存该目录。连接绑定归 generation 所有，只包含选中的 requirement，因此失败或退休的 generation 会释放其订阅，而不会销毁底层传输连接。这个内部服务图与模块加载器的源导入图不同；它不是 facet 编写或可见的计划。

## 绑定和身份

Presentation host 将已连接 server 和选中的 Session 的服务组合到同一张图中。其所有 facet 都使用同一个无限定 environment API。Session-service 调用永远不接受客户端选择的持久 `sessionId`；服务器负责授权，并将 presentation 选中的 Session binding 路由到 worker。

### Server 控制平面

Session 列表和管理是普通 server singleton service，而不是通用远程 `Session` 方法。`SessionDirectory` 以复制状态暴露对 presentation 安全的 session 摘要。`SessionManagement` 暴露 `create`、`remove`、`attach` 和 `detach` 方法。TUI 或 Web facet 通过 environment 同时使用二者：

```ts
const directory = env.use(SessionDirectory);
const management = env.use(SessionManagement);
```

Server 为每个 presentation connection 绑定一个 service provider。它从本地认证的 connection identity 推导 workspace 和 client authority，而不是从摘要字段或方法参数推导。它可以按 client 投影 directory state；无论哪种方式，摘要都不会暴露 owner ID 或 working directory 等服务器私有字段。

`management.attach(sessionId, context)` 会改变 presentation host 中的 selected-Session services。服务器关闭 presentation 之前 Session 作用域的请求、订阅和 observer task，将 presentation 的 Session services 绑定到 worker，然后 hydration 它们的 singleton state 和 keyed-instance directory。服务器根据 connection identity 授权选中的 Session。Attachment state 是报告此选择及其健康状态的宿主控制状态，不是 directory service。`detach()` 执行相同的清理，但不设置替换对象。

宿主需要为该路由保存私有、由宿主所有的 binding incarnation。presentation attach、detach、切换 session 或替换失败 worker 时它会变化。其表示形式刻意未规定。binding 防止旧选中 session 的延迟帧应用到新 session；它不是 facet 可见的 service value，也不能替代授权。

Replicated-state source 具有结构化身份：

```text
(provider binding, service ID, optional instance key + generation, member name)
```

不存在可单独发现的 state ID。额外的 instance key 是应用层逻辑 key。复用已关闭的 key 时，其宿主所有的 generation 会变化，从而使旧 proxy 无法调用替换对象。`requestId` 标识一个传输 invocation，用于响应和取消。Harness/tool 的 `invocationId` 可以作为有用的 instance key——如问题示例所示——但它不能替代 live address 中的 service、binding 或 generation 部分。

## 调用、Context 和路由

一次调用携带足够的控制平面信息，用于选择 provider binding、service、可选 keyed instance 和 member，同时携带 request ID、JSON 参数和 trace carrier。服务器可以解析这些控制平面字段来路由 Session 调用，但不会解析 facet 业务 payload，也不会加载 facet 契约。Service endpoint 会验证 member 和 value，创建请求本地的 abort controller 与 `Context`，安装已认证身份，并调用本地实现。

客户端将 `context.abortSignal` 映射为对该请求的取消。Disconnect 会取消该连接的 active call 并关闭订阅。这两种行为都不会取消服务所有的工作，也不会写入持久 Harness 取消。每个 client 的请求关联会传到 worker，因此不同 presentation 的 request ID 不会冲突。

## 复制状态和带 key 的实例

`ReplicatedState` 是权威的最新值复制，不是事件历史、持久存储、CRDT 或多写入者状态。冷 replica 的 `value === undefined`；在 hydration 前订阅只会记录 listener，不会调用它。Hydration 会在交付后续更新前原子安装完整快照，因此不存在 snapshot/update 间隙。Hydration 后，`value` 是同步值，订阅会先报告当前值，再报告后续更新。第一次快照 callback 使用新的 hydration context；已经 hydration 的 replica 使用新的本地交付 context，不会保留原始写入 context。状态值是借用的不可变 JSON，不会防御性 clone；调用者不得修改或长期持有它们。

远程 hydration 使用以 subscription 为 parent 的新交付 context；更新则从源 trace metadata 重建新的交付 context。Disconnect、provider withdrawal、replacement 和 route switching 会清除 ready 状态。Reconnect 或 replacement 会在后续更新前安装完整快照。传输层会缓冲与 hydration 竞态的更新并检查其序列。Acknowledgement、flow control 和 gap recovery 是独立的协议机制。

`observe()` 是 keyed-instance discovery，不是包含 proxy 的 `ReplicatedState`。它会将完整初始目录与有序的新增、替换和移除进行协调。每个实例的初始 state member 会在其 observer task 启动前完成 hydration。关闭实例会拒绝新调用，只 abort 该实例的 observer task，并允许已准入的调用结算。Session facet 的 `env.observe()` registration 在该 facet generation 关闭时 abort 旧 task；替换 generation 会协调新目录。

## 私有返回引用

私有返回引用不属于初始服务契约。对可发现的 live instance，优先使用 keyed service。如果具体功能确实需要调用者私有的远程身份，必须显式传递引用，而不是通过 `observe()` 发现；同时要将其限定到接收者和 provider binding。

本设计不包含通用 Harness projection。原始 Harness、Session、lane、tool、hook 和 storage 对象仍是本地 authority。如果未来集成需要远程 callback 或通用 object capability，就需要单独、明确的协议和策略；它不是 service RPC 的扩展。

## Context、取消和 Telemetry

每个远程方法接收新的本地 `Context`；发送方对象、signal、telemetry 实现和任意类型化 value 都不会跨 wire。客户端将调用的 abort signal 映射到该请求并注入 trace carrier。Endpoint 创建请求本地 abort signal 和 telemetry parent。取消会经由 server 转发到 Session worker，并按 client 加 request ID 保持隔离。

Span 关系为：

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ service implementation
```

三种取消域仍然分离：取消一个 RPC invocation；显式取消服务所有的工作，例如 `job.cancel()`；以及持久 Harness 取消，例如 `requestAbort()`。Transport cancellation 和 disconnect 只执行第一种。跨越调用生命周期的工作必须脱离到拥有自身 controller 和 telemetry root 的 service-owned task。

## 安全和生命周期

只有未标记为 local 的已加载 service token 才能在远程边界注册。只有所属的 `ServiceSpawner` 才能生成实例。标记 `{ local: true }` 的 service 永远不能被远程发现。本地 service 可以使用不受限制的对象契约。远程 provider 验证 member kind，具体 serializer 强制 JSON 业务值。客户端不能伪造普通值中的控制 envelope，不能选择 instance generation，不能在 service call 中选择其他 Session 路由，也不能取消其他 client 的请求。

Server 认证 connection、授权 attachment，并在 service `Context` 中重建 client identity。普通业务参数永远不携带 authority。Credential、prompt、completion、tool data、文件系统内容和其他敏感值都需要明确的 presentation-safe 契约。

Facet environment 明确拥有 registration、新增 service instance、observation 以及通过 `own()` 显式注册的资源。Connection binding 拥有其传输订阅和 active request controller。已经准入的 inbound call 不附着到提供方 facet 生命周期：provider withdrawal 会拒绝新调用，但已准入的方法可以在旧 facet 停用时继续运行。除非生命周期策略停止它，否则 provider 自己的 Session 工作仍然存活。

## 测试

Facet 语义通过 loopback 和 framed transport 测试：

- setup 时依赖账本所有权、拒绝晚到 acquisition、本地和远程 `use()`、keyed-provider ownership、singleton/keyed 模式验证、token 驱动的 RPC 发布、延迟成员访问、provider-facet 替换时稳定的本地和 RPC singleton facade，以及 `{ local: true }` service 保持远程不可达；
- 严格 JSON 边界、方法 context 重建，以及不序列化 context value 的请求取消隔离；
- server/Session facet 隔离、selected-Session 切换、过时帧拒绝和 worker 侧按 client 的 request 关联；
- cold 和 hydrated `ReplicatedState`、snapshot/update 无竞态、新交付 context，以及 disconnect、reconnect 和 provider replacement 时的清除/重新 hydration；
- 实例目录 hydration、有序协调、observer task 启动前的状态 hydration、基于 generation 的过时拒绝，以及关闭或切换时的 task 清理。

额外测试覆盖已认证 attachment 和 identity、telemetry 传播、flow control 和 gap recovery，以及问题示例和 shared-review 的应用模式。如果加入私有引用，则需要单独的生命周期和隔离覆盖。

## 开放的协议机制

具体的 service call、取消、订阅、snapshot/update、keyed-instance、unavailable 和 replacement frame 定义于 `packages/protocol/src/protocol.ts`。Provider 和 namespace 层负责成员分类、延迟 facade、缓冲和排序。

仍待确定的是 acknowledgement、flow control、sequence-gap recovery、加入引用后的 reference collection、协议版本协商，以及未来多窗格 presentation 如何表示多个 selected Session。Singleton provider replacement 必须继续在现有订阅上安装完整替换快照，使方法和状态成员 slot 保持 identity。

## 示例：目录和选中 Session

Directory 和 management service 是普通 server service。它们的契约只携带 presentation-safe value：

```ts
interface SessionSummary {
	serverId: string;
	sessionId: string;
	createdAt: string;
}

interface SessionDirectory {
	readonly state: ReplicatedState<{ revision: number; sessions: SessionSummary[] }>;
}

interface SessionManagement {
	create(options: { id?: string }, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");
const SessionManagement = defineService<SessionManagement>("pi.session-management");
```

Server facet 从已认证的 `Context` 派生 client，授权请求的 Session，并执行 binding transition：

```ts
serverContext.provide(SessionDirectory, { state: directoryState });
serverContext.provide(SessionManagement, {
	async attach(sessionId, context) {
		const client = requireClientIdentity(context);
		authorizeSession(client, sessionId);
		await attachments.bind(client.clientId, sessionId, context);
	},
	async detach(context) {
		await attachments.unbind(requireClientIdentity(context).clientId, context);
	},
});
```

Presentation facet 渲染并选择 Session：

```ts
setup(env) {
	const directory = env.use(SessionDirectory);
	const management = env.use(SessionManagement);
	const tui = env.use(Tui);

	tui.commands.register("sessions.switch", async (operation) => {
		const snapshot = directory.state.value;
		if (snapshot === undefined) return;
		const sessionId = await tui.select(
			"Sessions",
			snapshot.sessions.map((session) => ({ label: session.sessionId, value: session.sessionId })),
			{ signal: operation.abortSignal },
		);
		if (sessionId !== undefined) await management.attach(sessionId, operation);
	});
}
```

同一个 presentation 中的另一个 facet 通过相同 API 获取 Session service：

```ts
setup(env) {
	const models = env.use(Models);
	// After attach() settles, `models` addresses the selected worker.
}
```

Presentation 不会使用选中的 `sessionId` 路由 `models`；其宿主负责路由每个 service token，传输层保留 selected-Session binding。Server 会在 hydration 新 binding 前关闭旧 Session binding 的资源。
