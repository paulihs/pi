# WP04 — Mutation 发布和事件交付

## 状态

已完成。Phase A 和最终实现复审通过 Fable，没有发现问题。聚焦的 agent/server/SQLite 测试、`npm run build`、`npm run check` 和 `./test.sh` 均通过。`packages/agent/docs/harness.md` 仍是规范文档。

> 历史说明：WP06 后来用单条 Session line 上原子获取 `AgentHarness.lane()` 替换了本已完成 handoff 中描述的 lane-creation API 和 keyed line。事件发布保证仍然有效。

WP02 建立了原子 acceptance、recipient binding 和一致的 lane watch。WP03 移除了 drive deadline。WP04 在不削弱这些保证的前提下，移除由调用者操作的事件交付 gate，并让历史 `Session.createLane()` 从头到尾拥有 lane 创建。直接持久 drive package 随后作为 WP05。

## 问题

当前 committing lane job 使用两段式事件 API：

```text
inside Session.mutate:
  commit
  publish process-local state
  delivery = events.enqueue(batch, context)

outside Session.mutate:
  await delivery.start()
```

拆分保留了正确边界，但也容易误用：过早调用 `emit()`、过早调用 `start()` 或丢弃 `start()`，都可能破坏 observation 语义或阻塞全局 event tail。历史 `Harness.createLane()` 还会手动重复这套编排。

Lane 创建还有第二个一次性边界。历史 `Session.createLane()` 负责 validation 和 durable transaction，但 Harness 无法在同一个 commit continuation 中发布其 process-local `Lane` 并绑定 `lane_created` recipient。因此 Harness 自己打开 `Session.mutate()`，并调用导出的 `createLaneWithMutator()`。

WP04 移除这两个由调用者操作的接缝，同时保留当前 direct-listener 和 hook barrier。

## 必需语义

### Direct event 仍然是等待中的 observation

直接 `events.on()` listener 仍是被动且有因果顺序的：

```text
hook or preparation
→ commit
→ publish process-local state
→ bind and append event batch
→ release lane mutation line
→ await direct listeners
→ resolve operation
→ later hook or transition
```

被动意味着 listener 不能转换正在进行的操作，listener 失败会作为 `handler_error` 隔离；不意味着 fire-and-forget。Extension 可以在 event listener 中更新进程本地状态，并在后续 hook 中检查它。等待也提供 producer backpressure。

Direct listener 不得调用会修改状态的 Harness API：发出的 mutation 会把后续 event 排在当前正在等待该 listener 的 event 之后。只读 lane call 仍然合法。

以下有意保留的例外不变：

- watcher 和 RPC/watch consumer 使用自己的 buffered FIFO，operation 不等待它们；
- fault publication 采用 fire-and-forget，close 永远不等待 listener 完成；
- 高频 tool update 会入队每个 event，但只保留最新的 delivery promise；tool settlement 在 `after_tool` 和 outcome publication 前等待该 promise，通过 global FIFO 排空所有更早 update，但不对每次 update 施加 backpressure。

### Commit 和 recipient binding 仍在一个 continuation 中

每个产生事件的 committing lane job 都在观察到 commit 成功的**同一个 continuation**中执行：

```text
commit succeeds
→ publish complete process-local state
→ synchronously call emitBatch(batch, context)
   - clone payloads
   - bind current ordinary listeners and watchers
   - append the complete batch to the global delivery tail
→ return from the mutation callback
```

不存在 scheduler-owned 的 after-release publication phase。把 recipient binding 移到后续 promise continuation 会产生一个间隙：另一个 task 可能观察到已提交状态，并在旧 event 绑定 recipient 之前注册 listener。

`emitBatch()` 会立即开始异步交付并返回完成 promise。Mutation callback 不会等待该 promise。Listener 可能在 publication/binding 后、mutation line 技术上释放前开始执行；重入的 lane read 会排在当前 job 后面。Command 将 promise 带出 `Session.mutate()`，并在对外 resolve 前等待它。

这保留两种合法的 watcher 竞态：

```text
watcher registration first
→ snapshot-before + complete buffered batch

commit publication first
→ snapshot-after + no old event
```

### 排序

- 一次非空 `emitBatch()` 调用发布一个连续 batch；
- batch 按 `emitBatch()` 调用顺序进入既有 global event tail，跨 lane 也一样；
- batch 内 event 保留源顺序；
- Direct listener 按注册顺序串行运行；
- 同一 lane 的 committing job 按 lane mutation 顺序绑定 batch；
- Lane procedure 在调用下一 hook 或 transition 前等待当前 command 的 delivery；
- 不相关 lane 上的 hook 可以重叠，不存在跨 lane 的全局 hook 顺序；
- Context 保持为精确的 emitting invocation Context，且始终是最后一个参数。

## Event bus 契约

用以下内容替换公开/内部交付拆分：

```ts
class HarnessEventBus implements Events {
  emit(event: HarnessEvent, context: Context): Promise<void>;
  emitBatch(events: readonly HarnessEvent[], context: Context): Promise<void>;
}
```

`emitBatch()`：

1. 对空 batch 或已关闭 bus 返回已 resolve 的 promise；
2. 同步对每个 payload 做 structured clone，并绑定当前 recipient；
3. 将一个连续 delivery 追加到已有 global tail；
4. 使用 emitting Context 串行交付 clone 后的 payload；
5. 隔离 listener 失败，并像现在一样发布非递归的 `handler_error`；
6. 返回一个在 eligible direct listener settle 后 resolve 的 promise，且不会因 listener 失败而 reject。

同步 publication defect（例如无法 clone 的内部 payload）仍会在 caller 的 commit continuation 中抛出，并沿用现有 Harness fault path。

删除：

- `HarnessEventDelivery`；
- `HarnessEventBus.enqueue()`；
- 调用者操作的 `start()`；
- delivery gate 和 `pendingStarts`；
- close 时强制释放 gate。

`close(error)` 立即封闭 listener/watch registration 和未来 publication。已经追加的 batch 保留其绑定 recipient，并通过已有 tail drain；listener 完成仍不阻塞 Harness close。

## Lane command 集成

`Lane.command()` 的 commit 分支返回普通内部 outcome，其中包含 caller result 和可选 delivery promise：

```ts
const events = decision.events?.(commit) ?? [];
const delivery = events.length === 0
  ? undefined
  : this.onEvent(events, context);

return {
  kind: "return",
  result,
  ...(delivery === undefined ? {} : { delivery }),
};
```

`onEvent` 返回 `Promise<void>` 并委托给 `emitBatch()`。它只在 commit、完整 process-local state publication 和同步 result materialization 完成之后调用，作为返回 mutation outcome 前的最后动作。

`Session.mutate()` 返回之后：

```ts
if (outcome.kind === "reject") throw outcome.error;
await outcome.delivery;
return outcome.result;
```

预期的 no-commit rejection 不发布 event。Commit/materialization/publication error 保留现有 Harness fault 语义。

## Session lane 创建契约

历史 `Session.createLane()` 负责 validation、commit 和同步 committed-publication callback。Context 仍在末尾：

```ts
createLane(
  name: string,
  at: string | null,
  configuration: LaneConfiguration,
  onCommitted: ((context: Context) => void | Promise<void>) | undefined,
  context: Context,
): Promise<SessionTree>;
```

实现执行：

```text
enter the prospective lane's mutation line
→ validate name, absence, complete lane shape, and target
→ commit lane configuration + leaf + idle lane state
→ synchronously invoke onCommitted(context) in that same commit continuation
→ retain its returned promise inside a non-thenable outcome object
→ return from the mutation callback and release the line
→ await the retained promise
→ return Session.view(name)
```

Callback 既不接收 `SessionTree`，也不接收 `SessionMutator`；它只是 process-local publication point。其同步前缀必须完成在另一个同 lane job 运行前所需的 publication。普通 Session caller 传 `undefined`。

如果 validation 或 commit 失败，不调用 callback。如果 callback 在 commit 后抛出，或保留的 promise 在线释放后 reject，durable lane 保留但 caller reject；Harness 将这个 committed-publication defect 转换为现有 fault path。Harness callback 返回的 promise 是 event delivery，listener 失败会由 bus 隔离。

当前 lane validation/transaction implementation 变为 Session 私有。删除导出的 `createLaneWithMutator()` 及其直接测试。

Harness 预先构造 detached `Lane`，然后调用 Session：

```ts
const lane = this.buildLane(name, state);

await this.session.createLane(
  name,
  at,
  this.seed,
  (context) => {
    if (this.closedError !== undefined) lane.seal(this.closedError);
    this.lanesByName.set(name, lane);
    return this.events.emitBatch(
      [{ type: "lane_created", lane: name, at }],
      context,
    );
  },
  context,
);

return Result.ok(lane);
```

Callback 的同步前缀会发布 `lanesByName`，并在第一个创建 job 释放其 line 前绑定 `lane_created`。因此排队的 duplicate 不会在 winner 通过 `harness.lane(name)` 可见前报告 `LaneExists`。

如果 close 或 fault 在 commit 已准入时胜出，callback 会发布 sealed 的新 Lane。已关闭 bus 上的 emission 是 resolved no-op，与现有 admitted-creation race 一致。成功的 admitted creation 仍返回 sealed Lane。

## 范围

### 源码

修改：

- `packages/agent/src/harness/events.ts`；
- `packages/agent/src/harness/runtime2/lane.ts`；
- `packages/agent/src/harness/runtime2/harness.ts`；
- `packages/agent/src/harness/session/types.ts`；
- 历史 `createLane` signature 所需的本地 Session 实现和测试；
- direct event primitive、acceptance、watch、lane 和 harness 测试。

Remote/experimental runtime behavior 不是 WP04 的设计约束。Session mutation authority 保持进程本地；不要添加 remote Session callback transport、protocol machinery、compatibility abstraction 或 boundary test。

### 文档

更新规范 `harness.md`：

- 用同步 `emitBatch` binding 和 mutation 后等待替换 enqueue/start 语言；
- 准确说明 listener execution 可以在 publication/binding 后、技术上的 line release 前开始；
- 保留 awaited direct-listener、event/hook、watcher、Context、close 和 ordering 语义；
- 用历史 `Session.createLane(onCommitted, context)` 替换共享导出的 mutator-procedure lane creation；
- 更新不变量、竞态、测试、术语表和 Part 8；
- 链接 WP04，并将 direct durable drive 移到 WP05。

只在历史 WP02 handoff 指向未来或声称旧机制仍然有效的地方更新它。不要把已完成包的记录重写成 WP04 行为已经在 WP02 落地。

## 非目标

- fire-and-forget direct event 或公开 flush API；
- sequence/watermark delivery redesign；
- per-extension event queue；
- 更改 hook aggregation 或 event/hook causal barrier；
- 更改 watcher/RPC buffering；
- 更改 tool-update settlement barrier；
- 让 event-listener mutation 安全；
- drive、breakpoint、provider、tool、recovery、retry、polling、abort 或 terminal settlement；
- 通用 Session post-commit/after-release task API；
- remote callback execution 或 remote-runtime redesign。

## 必需测试

### Event primitive

- `emitBatch` 同步绑定 ordinary listener 和 watcher；
- `emitBatch` 后、延迟 delivery 前注册的 listener 不会收到内容；
- 完整 batch 连续且保留 event order；
- 并发 batch publication 保留调用顺序；
- listener payload mutation 保持隔离；
- listener rejection 发出一次非递归 `handler_error`，且不 reject delivery；
- 空 batch 和 close 后 batch 无 delivery 也能 resolve；
- 已追加 batch 在 close 后仍能 drain；
- 不再保留 gate/start test。

### Lane command 和 watch

- direct listener 可以重入执行只读 lane inspection，且无 deadlock；
- command 直到 direct listener 完成才 resolve；
- listener 能看到已提交的 memory；
- commit failure 不发布任何内容；
- 观察 durable state 的 late listener 不会收到历史 event；
- watcher-first 产生 snapshot-before 加完整 buffered batch；
- publication-first 产生 snapshot-after，不 replay；
- source Context identity 在延迟和 buffered delivery 中保持。

### Lane 创建

- Session callback 在成功 commit 后恰好运行一次，validation/commit failure 时永不运行；
- callback 的同步 publication 发生在 queued duplicate 报告 `LaneExists` 前；
- Harness Lane 和 durable configuration 对 `lane_created` listener 可见；
- Harness 在 resolve 前等待异步 `lane_created` listener；
- admitted creation 与 close 竞态时发布 sealed Lane，且不要求 event delivery；
- commit 后 callback throw 和 retained-promise rejection 遵循文档规定的 committed-publication failure path；
- 普通 Session creation 传 `undefined` 时返回其 view；
- 不再存在导出的 `createLaneWithMutator`。

### Ordering barrier

- acceptance event 在 `accept()` resolve 前完成；
- command resolution 不能超过其等待的 direct event delivery；WP05 测试第一个后续 procedure hook；
- event batch 在并发 lane publication 间保持全局顺序；
- 已实现处的 tool-update latest-delivery settlement 行为保持不变。

## 验证

文档修改后：

```bash
git diff --check -- \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages/02-atomic-run-acceptance.md \
  packages/agent/docs/work-packages/04-mutation-publication.md \
  packages/agent/docs/work-packages/05-direct-durable-drive.md
```

实现后运行所有修改过的聚焦测试，然后：

```bash
git diff --check
npm run check
./test.sh
```

在宣布 WP04 完成前，用 Fable 审查最终实现。没有用户明确批准不要 commit。

## 停止条件

满足以下条件时 WP04 完成：

- 事件 publication 只有一个 `emitBatch()` 操作，不再有调用者操作的 gate；
- recipient binding 仍位于精确的 commit-observation continuation；
- direct event delivery 保持全局 FIFO，并在公开 operation resolution 前等待；
- 现有 event/hook 因果 barrier 保持完整；
- lane watch 保留恰好两种一致的竞态结果；
- Session 拥有 lane creation，并在释放 creation job 前调用 Harness publication；
- `createLaneWithMutator()` 已删除；
- Context 始终位于尾部，且 source identical；
- 聚焦测试、`npm run check` 和 `./test.sh` 通过；
- 最终 Fable 审查没有发现。
