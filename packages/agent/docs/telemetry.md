# Invocation Context 与 Telemetry 设计说明

> **状态：** 设计输入，不是规范性契约。context 原语和必需的尾部 `Context` 参数已经在 Harness、Session、执行能力和托管 Harness adapter 中落地。本地传播只是脚手架，不能证明 telemetry 语义已经完整：大多数运行时 span 和跨进程 trace 传播仍属于设计或实现工作。Drive 所有权现在归 Harness 所有，请求 ID RPC 取消已经实现；两者都不提供分布式 trace parentage。将已接受的最终行为并入 `harness.md`。`telemetry-schema.md` 仍是 span 名称和属性的生成式参考。

## 目标

`Session`、`Branch`、`AgentLane` 和 `AgentHarness` 通过必需的尾部 `Context` 参数，显式接收 invocation 作用域的控制数据。同一个 receiver 可能服务于并发的本地调用或 RPC 客户端，因此不能保留可变的或默认的调用者 context。

Invocation context 必须在不使用 `AsyncLocalStorage` 的情况下解决两个相关问题：

1. 在并发异步工作中保持正确的 telemetry parentage；
2. 在存在 `AbortSignal` 时携带它，让 RPC adapter 能将其映射到请求取消。

这项工作必须复用 `@earendil-works/pi-telemetry`，不得引入另一套 span 抽象。

## Context 模型

已实现的公开类型是：

```ts
interface ContextKey<T> {
	readonly token: symbol;
	readonly valueType?: (value: T) => T;
}

interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetryContext: TelemetryContext;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}
```

`valueType` 只是类型标记。运行时查找使用 key 的 symbol token。`createContextKey<T>(description)` 会创建并冻结带有唯一 token 的 key。

Context 不可变。派生 Context 会创建父链接的 copy-on-write 层。helper 参数把 value 放在前面、父 context 放在最后：

```ts
const requestContext = withAbortSignal(requestSignal, parentContext);
const spanContext = withTelemetryContext(span, requestContext);
const tenantContext = withContextValue(tenantKey, tenantId, spanContext);
```

已实现的行为如下：

- `BACKGROUND_CONTEXT` 和 `TODO_CONTEXT` 是两个不同的空根，它们的 `abortSignal` 都是 `undefined`；
- `telemetryContext` 始终可用；未安装 telemetry 值时回退到 `NOOP_TELEMETRY_CONTEXT`；
- `withAbortSignal(signal, context)` 在父 context 没有 signal 时保留传入 signal，否则使用 `AbortSignal.any()` 将它与父 signal 合并；
- `withCancel(context)` 返回一个独立可取消的子 context 和 `cancel(reason?)` 函数；父级取消仍然会传递到子级；
- 类型化 value 使用 symbol identity 和不可变 copy-on-write 层；同一 key 的更新值会遮蔽父级值；
- 内置 abort-signal 和 telemetry key 是私有的；调用者使用命名属性，而不是通过 key 取回这些值；
- `toString()` 用于诊断，并记录根以及每层 key 的描述。

Context value 是横切的请求 metadata，而不是业务依赖。适合的类型化值包括 request ID、已认证 principal、tenant ID 和诊断 metadata。存储、模型、工具、持久状态和业务 payload 不属于 context。Context、signal、telemetry 对象和 backend 原生 span 对象永远不是持久数据。

## Receiver 所有权

共享 receiver 保留 identity 以及持久/进程状态，不保留 invocation context：

```text
AgentHarness receiver  ── no caller context
AgentLane receiver     ── no caller context
Session receiver       ── no caller context
Branch receiver        ── no caller context
```

每次调用都提供自己的 context。这样可以防止并发调用者互相覆盖 telemetry parent 或取消 signal。

表示一个正在进行的 invocation 的进程本地对象可以保留派生 context。例如 active drive task 或 event subscription。这与在共享 Harness 或 Session receiver 上保存默认 context 不同。

`AgentHarnessOptions.telemetryContext` 已移除。Harness 级默认值无法表示两个拥有不同 parent 的并发调用者。

## 现有类型化 telemetry 仍是权威

设计保留：

- `TelemetryContext` 和 `TelemetrySpan`；
- callback 所有的 span 生命周期；
- `AI_TELEMETRY_SCHEMA` 和 `HARNESS_TELEMETRY_SCHEMA`；
- 类型化 span 名称、开始属性、完成属性和事件；
- `startAiSpan()`、`startHarnessSpan()` 和 `createTypedSpanStarter()`；
- adapter 一致性行为。

`startAiSpan()` 和 `startHarnessSpan()` 通过同时给 callback 提供类型化 span 和派生 invocation context，封装 span 派生：

```ts
return startHarnessSpan(
	"pi.harness.run",
	attributes,
	async (span, runContext) => {
		return runDrive(runContext);
	},
	context,
);
```

这些 helper 委托给 `context.telemetryContext.startSpan()`，并通过 `withTelemetryContext(span, context)` 将 callback 所有的 span 安装到子 context 中。下层工作必须接收该子 context，而不是父 invocation context。

不要修改 context 来安装 active span。不要使用进程全局或 receiver 全局的 current span。

## 并发 parentage

显式传播支持并发的兄弟调用：

```ts
await parent.telemetryContext.startSpan({ name: "caller" }, async (callerSpan) => {
	const callerContext = withTelemetryContext(callerSpan, parent);
	await Promise.all([
		laneA.drive(optionsA, callerContext),
		laneB.drive(optionsB, callerContext),
	]);
});
```

每次调用都会派生自己的子 context。嵌套工作接收属于该调用的子 context。正确的 parentage 不依赖 promise 调度或环境状态。

测试必须刻意跨越并发分支，让意外的 receiver 级 context 暴露出来。仅有顺序的 parent/child 测试不够。

## Callback、hook 和事件

作为操作一部分被调用的 host-local callback，会在声明的尾部位置接收当前 invocation context：

```ts
handler(event, context);
tool.execute(toolCallId, params, onUpdate, toolContext, invocation, context);
mutation(mutator, context);
```

当前传播会保留 callback 中的 context，并给 `before_tool` 与 `after_tool` handler 提供从 `pi.harness.hook` 派生的子 context。将这种 span 行为扩展到每种 hook 类型仍是后续工作；未安装 hook span 的 handler 当前会直接收到 operation context。

在 Harness 进程内，事件保留触发每个事件的 context，缓冲事件 watcher 存储 `{ event, context }`，而不只是 `event`。从该事件 context 启动 `pi.harness.event_handler`，并把它的子 context 传给每个 listener，仍属于后续工作。事件注册本身是 host-local 配置，没有 operation parent。

Session mutation callback 和 commit 接收同一个显式 invocation context。从提交 invocation 启动 `pi.session.write`，并将其子 context 传过存储 commit，仍属于后续工作。

## Drive 执行和 joiner

多个调用者可以为同一个持久操作调用 `drive()`。仲裁决定哪个调用安装进程本地执行，哪些调用加入它。这是核心运行时问题，不是 RPC 专属问题；并发本地调用也有同样的情况。

一次 active execution 只有一个 telemetry parent。另一个调用者加入时不能重新设置其 parent。

```text
installer caller
└─ drive.execute
   └─ provider/tool work

joiner caller
└─ drive.join
```

Joiner span 描述该调用者的等待。它至少携带 lane name、持久 operation ID 和进程本地 execution ID。它以 `settled`、`caller_cancelled`、`execution_stopped` 或 `harness_closed` 等 outcome 结束。

Joiner 不得覆盖 active execution context。使用 operation/execution 属性关联两个 span。Telemetry span link 更适合表示这种关系，但当前 telemetry 契约没有 link。添加 link 是 telemetry package 的可选设计问题，不是发明多个 parent 的理由。

分布式 trace 允许 execution span 超过 installer RPC span 的生命周期。子 span 启动后，parent 和 child 可以重叠，也可以按任意顺序结算。

## Invocation 取消与持久取消

已 abort 的 invocation signal 是进程本地控制，不表示请求了持久取消。

```text
context.abortSignal is present and aborts
→ stop only that caller's observation; an installed lane-owned Drive continues
→ do not write cancel_requested
→ preserve the same durable operation state
```

两个空根暴露的 `undefined` `abortSignal` 表示该 invocation 没有取消 signal。

只有 `requestAbort()`/`abort()` 会写入持久的 `cancel_requested`，并允许持久 aborted 结算。

运行时必须跟踪停止原因，而不能将每个 aborted provider 响应都解释为持久取消：

```ts
type ExecutionStopCause =
	| "no_drive_waiters"
	| "invocation_cancelled"
	| "harness_closed"
	| "durable_cancel_requested";
```

只有 `durable_cancel_requested` 可以规范化并提交持久 aborted outcome。Invocation/disconnect abort 不得在持久控制仍为 `running` 时产生 assistant `stopReason: "aborted"` 结算；该路径会违反持久状态机。

Drive 所有权已确定为**Harness 所有**：一旦安装，执行会持续到持久结算或等待、明确的持久取消、关闭、故障或进程丢失。Joiner signal 只控制自身观察。无关 joiner 的 signal 绝不能通过 `AbortSignal.any()` 合并后直接附加到共享执行上。一个取消的 joiner 不能取消所有其他调用者。

## RPC trace 传播

客户端和服务器 span 可以属于同一分布式 trace：

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session operation
```

客户端不会序列化 `TelemetryContext`，而是从 `rpc.client` span 注入 backend-neutral trace carrier。服务器将 carrier 提取到新的本地 `TelemetryContext`，并从中启动 `rpc.server`。

需要一个面向传输的 adapter 边界：

```ts
interface TelemetryPropagation {
	inject(context: TelemetryContext): JsonValue | undefined;
	extract(carrier: JsonValue | undefined): TelemetryContext;
}
```

生产实现可以使用 W3C `traceparent`/`tracestate`。当前 telemetry package 没有 carrier 注入/提取 API，因此已接受的设计必须决定该 adapter 属于 telemetry package、RPC 基础设施还是 backend 集成 package。但它仍必须复用现有 `TelemetryContext` span 契约。

RPC 取消和 telemetry 传播是相互独立的控制平面通道：

- trace metadata 重建 telemetry parentage；
- request ID 加 cancel/disconnect 消息控制服务器 request signal；
- 两个通道都不会出现在序列化的方法参数中。

## 接口迁移脚手架

Receiver 方法现在使用必需的尾部 `Context`。具体实现、调用、callback adapter 和 object-literal façade 都已经迁移，而不是只依赖 interface assignability。

`TODO_CONTEXT` 仍是临时迁移标记，不是语义根。当前使用点集中在尚不能重建调用者 context 的未解析传输和 worker 边界，尤其是 Pi protocol request ingress 和 worker RPC ingress。`BACKGROUND_CONTEXT` 表示有意在没有调用者的情况下启动。

继续单独盘点 `TODO_CONTEXT`。只有当边界能构造请求本地的取消 context 和 telemetry parent 时，才替换传输边界上的使用；替换为 `BACKGROUND_CONTEXT` 会掩盖尚未完成的传播。编译仍不能证明 telemetry 或取消正确。

## 后续交接所需测试

当前测试覆盖不可变类型化 value 分层和遮蔽、不同的空根、父子 abort 组合、兄弟取消隔离以及 tool-hook 子 parentage。剩余交接覆盖包括：

- 在一个共享 receiver 上交叉并发 telemetry 分支；
- 每种 hook 类型、工具、事件 handler 和 Session 写入都接收预期的子 context；
- 延迟交付时缓冲事件仍保留其发出 context；
- 不存在 receiver 级 telemetry 默认值；
- 已预先 abort 的 invocation 不启动外部 effect；
- Harness 所有执行下 installer 和 joiner 的取消隔离；
- invocation abort 保持已安装 Drive 和持久状态不变；
- 持久 abort 提交持久 aborted outcome；
- close 和 disconnect 不冒充持久取消；
- client → server trace 重建；
- 事件交付重建源 trace metadata；
- 缺失/格式错误的 trace carrier 降级到 no-op/root telemetry，且不影响业务行为。

## 已解决的迁移决策

- Receiver 方法使用一个必需的尾部 `Context`。
- 共享的 Harness、AgentLane、Session 和 Branch receiver 不保留默认 invocation context。
- `Context`、`AbortSignal` 和 `TelemetryContext` 对象不会跨 RPC 边界序列化。

## Telemetry 交接前的开放决策

- joiner 是否需要 telemetry link；
- trace-carrier adapter 的归属和形状；
- 哪些 context value（如果有）可以跨 RPC 边界；
- RPC 调用和 drive join 等待的精确 span 名称/outcome 属性。
