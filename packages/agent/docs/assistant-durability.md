# Assistant 局部持久化——实现交接

本文规定普通 assistant 生成和延迟响应轮询的 assistant 局部消息如何持久化。它建立在以下内容之上：

- `values.md` 中有界的类型化 value/list 地址；
- `@earendil-works/pi-ai` 中的 `AssistantMessageFrame`、`AssistantMessageFrameEncoder` 和 `reduceAssistantMessageFrames()`；
- `harness.md` 中 assistant intent/effect/settlement 状态机。

该设计持久化紧凑、可重放的流帧，不让它们成为操作状态权威，也不会在每次更新时存储不断增长的完整局部消息。

## 目标

1. 进程丢失后重建最新已提交的 assistant 局部消息。
2. 在不反复写入完整快照的前提下，保留 provider 流顺序。
3. 避免存储提交对 provider 产生背压。
4. 复用 pi-ai 的规范帧转换和归约语义。
5. 保留当前公开 assistant 事件的顺序。
6. 让操作的 `effect_pending` 状态继续作为恢复权威。
7. 在普通或合成响应结算时，原子删除所有局部帧。

## 非目标

- 从帧推断 provider 是否完成。
- 将终端 `done`/`error` 事件与响应结算分开持久化。
- provider 请求恰好执行一次。
- 公开帧游标或帧持久化事件。
- 通用批处理、定时器、合并或 flush API。
- 持久化结构化摘要生成流。
- 持久化任意 provider SDK 事件或反复写入完整 `partial` 快照。

## 存储

`session/values.ts` 中的内置地址构造器：

```ts
export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  `${operationId}:${responseEntryId}`,
);
```

该过程为普通生成或延迟轮询绑定一个精确地址：

```ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
```

`responseEntryId` 已在 assistant/deferred 的 `effect_pending` 状态中预留。操作状态不存储帧数量、游标或列表身份，后续列表操作只接收 `frames`，永远不会再接收另一个 key。

每个列表元素都是一个 `AssistantMessageFrame`。存储事务的全局写入序列为帧排序。该列表是辅助数据：

- 缺失是有效情况；
- 它不能证明请求已准入、完成、成功或失败；
- 它永远不会选择重启点；
- 基线恢复不会读取它。

## 帧契约

每个 provider 流创建一个 pi-ai encoder，并按顺序向它输入每个事件：

```ts
const encoder = new AssistantMessageFrameEncoder();
const frame = encoder.encode(event);
```

`partial` 是 provider 共享的实时响应至今内容 helper，而不是事件时刻的快照。encoder 维护每个开放块的计数器，并裁剪已经由推进后的块起始快照表示的文本/思考 delta 前缀。它只会暂存同步已经推进的工具调用所需的原始 JSON 前缀，然后发出一个检查点并恢复紧凑 delta。它不会在每个事件中复制不断增长的完整消息。

- `start` 产生一个空内容的 metadata 帧；
- 非终端事件产生零或一个帧；
- 已覆盖的排队 delta 不产生帧；
- 终端 `done` 和 `error` 不产生帧，因为最终响应结算是独立的；
- `start` 之前的 setup `error` 有效且不产生帧；
- text/thinking/tool end 帧包含权威的已完成块值；
- 已完成的工具调用参数不会依据工具 schema 做验证。

不要定义第二套 Harness 帧编解码器或 reducer。持久化直接保存导出的 pi-ai 值；hydration 调用 `reduceAssistantMessageFrames()`。

Provider 事件块可能交错。编码和归约依靠 `contentIndex`，不依靠块的连续性。text 和普通 thinking 块在发布 `*_start` 时必须为空，之后只能通过匹配的 delta 追加；redacted thinking 可以在 start 时就完整存在并且不产生 delta。流式工具调用以空参数开始，并通过 delta 输出完整原始 JSON；一开始就提供完整参数的 provider，必须在后续参数 delta 之前，在某个事件边界发出能解析为该快照的累积 delta 前缀。

## 新流调度

最简单的调度是刻意设计的：每个转换后的帧对应一个 list-append 事务，在 provider 循环中入队但不等待存储完成。

对于每个 `start` 或更新事件：

```text
根据每流的帧 encoder 编码事件
→ 返回帧时，同步入队带 invocation fence 的 appendList(frames, frame)
→ 为返回的 promise 附加普通 Harness 故障观察器
→ 替换进程本地的 latestFrameWrite promise 引用
→ 发出并等待已有的 message_start/message_update 事件
→ 消费下一个 provider 事件
```

每个返回帧都会同步调用 `appendList()`，因此所有帧变更按 provider 事件顺序进入 Session 线。该过程不会等待每次写入。每个 promise 都会在最新引用替换前立即被观察，以便传播故障。被覆盖的排队事件不会分配持久帧，也不会写入。encoder 状态与开放块数量及活动工具调用 JSON 流的未同步前缀成正比，不保留第二份完整 assistant 消息。模型输出上限会将排队帧字节数限制在有界输出加帧/事务开销之内。

事件侧保留现有行为：`AssistantStreamObserver.start/update` 会为每个事件等待 `events.emit()`。provider 循环推进时，不存在仍在等待的 assistant 事件交付，因此不需要单独的最新事件交付 promise。

当 provider 流结算时：

```text
停止帧准入
→ 如有 latestFrameWrite 则等待它
→ 运行 after_response
→ 发出 message_end
→ 对最终响应分类，并提交结算
```

Session 变更线是 FIFO，因此 `latestFrameWrite` 完成意味着所有更早的 append 都已完成。不存在 promise 数组、定时器、批处理器、active/waiting 状态、coalescer 或公开/内部 flush 方法。

帧追加失败会在 `after_response` 开始前使 Harness 发生故障。完整最终响应保留在进程本地，不会在存储故障后提交。

## 普通结算

任何使用帧列表的 assistant 响应结算，都会在同一个事务中删除精确列表，并写入不可变响应条目、usage、tip 和下一步操作状态：

```text
TX[
  insert response entry R,
  insert usage U,
  setValue(branchTip(lane), R),
  deleteList(frames),
  setValue(operationState(operationId), classified next state)
]
```

适用于：

- 成功的 assistant 响应；
- provider `error`/`aborted` 响应；
- 有效的 deferred 响应；
- deferred poll 响应。

`after_response` 可以在结算前转换最终响应。帧保留 provider 流观察结果，而不可变条目保留 hook 处理后的规范结果。

如果在最终帧追加后、结算前发生崩溃，恢复仍然看到 `effect_pending`；帧不会把看起来完整的草稿变成已结算响应。

## 未知结果的生成恢复

孤立的 assistant 生成 `effect_pending` 没有存活的 provider 流。激活步骤如下：

1. 根据当前类型化状态构造 `frames = pendingAssistantFrames(operationId, responseEntryId)`，并从精确地址读取有界分页；
2. 使用 `reduceAssistantMessageFrames()` 归约帧值；
3. 在已预留的响应 ID 下构造 Harness 所有的合成 assistant 响应；
4. 如果存在帧，则保留重建的局部内容和安全的消息身份 metadata；
5. 设置 `stopReason: "error"`、零 usage，以及明确的中断/未知结果 `errorMessage`/diagnostic；
6. 原子提交合成响应、零 usage 行、帧列表删除、tip 和普通重试/失败状态。

必须使用以下警告含义：

```text
The provider request was interrupted. The preceding content is the latest
committed partial response; newer live output may be missing, and the external
request outcome is unknown.
```

如果没有 start 帧提交，Harness 会基于捕获到的 model/API identity，用空内容构造相同的合成错误。

合成响应遵循普通 assistant 错误分类：

- 仍有尝试次数时，插入错误响应并进入普通 retry-wait/下一次尝试路径；
- 达到上限时，插入错误响应，并在同一个结算事务中将操作标记为终端失败。

错误响应仍是持久化的 transcript 历史，但依据现有 projection 规则，不会出现在后续 provider context 中。中断错误响应中的局部工具调用永远不会执行。

恢复不会运行 `after_response`：没有可信的完整 provider 结果可供转换。

## 取消

实时被取消的 provider 流会通过普通最终 `aborted` 响应结算。所有已接受的帧都会先等待完成，普通结算随后删除列表。

对于恢复后的已取消 assistant/deferred `effect_pending`，取消协调会：

- 归约可用帧；
- 构造保留已提交局部内容的合成 `aborted` 响应；
- 使用零 usage 和现有预留 ID；
- 原子插入响应并删除帧列表；
- 不启动 provider 请求，也不运行响应 hook。

即使归约内容看起来完整，取消分类仍然优先。

## 延迟轮询

返回 `AssistantMessageEventStream` 的 deferred poll 使用同一 `pendingAssistantFrames(operationId, responseEntryId)` 地址构造器。

- 普通 pending/ready/error 结算会删除 poll 的帧列表；
- 恢复后的取消会从帧合成 aborted 响应；
- 没有 permit 的未知恢复 poll 保持 suspended，并可以在快照中暴露其持久局部内容；
- 当 poll permit 使用新的预留 response/usage ID 替换未知 poll 时，该 intent 事务会删除废弃的旧帧列表地址；
- 替换后的 poll 会在新 response ID 下启动新列表。

帧不会改变 poll-number 规则。

## 结构化生成范围

结构化摘要生成流仍保留在进程本地。它们不会发出公开 assistant-message 生命周期事件，而且一次结构化发布前可能跨越多个嵌套 provider 请求。现有 attempt 级重试和 usage 恢复仍然是权威机制。

本切片不要在 `pendingAssistantFrames(...)` 地址处存储这些流的中间文本。如果结构化局部诊断变成需求，应增加单独且明确有作用域的消费者，而不是悄然复用 transcript-assistant 语义。

## 快照和重连

`LaneSnapshot.streamingMessage` 表示最新观察到的 assistant 局部消息，不表示当前一定附着了 provider 流。

优先级：

1. live stream 所有者持有的最新进程本地局部内容；
2. 否则，对于 assistant/deferred `effect_pending`，使用已提交帧分页归约出的值；
3. 否则不存在该字段。

因此，恢复后的 lane 可能处于 `suspended`，同时 `streamingMessage` 非 undefined。该字段仍位于 `transcript` 之外；只有 `entry_added` 会把完整响应移入 transcript 历史并清除局部内容。

快照 hydration 根据可信的类型化操作状态构造精确的绑定帧地址，并执行 assistant 消费者的总帧/分页预算。它不会扫描任意列表，也不会进行宽泛的语义恢复审计。

重连不会重放历史 `message_start` 或 `message_update` 事件。快照携带持久局部内容。恢复随后只会针对实际结算的响应发出带 recovery 标记的普通合成消息生命周期。

## 事件

已开始的生成保留以下实时事件顺序：

```text
message_start
→ message_update*                 每个监听器交付都由 provider 循环等待
→ await latest frame write
→ after_response
→ message_end
→ 原子响应结算 + 删除帧列表
→ entry_added
→ usage
```

请求 setup 失败可以在 `start` 之前产生 `error`；该路径不会发出 `message_start` 或帧，而是经过 `after_response`、`message_end` 和普通错误结算。成功的 `done` 以及 start 之前的更新属于协议缺陷。

帧提交只产生普通存储 telemetry。不存在公开帧事件，也不声称 `message_update` 已经持久化。`entry_added` 仍是最终 assistant 条目已提交的唯一证明。

如果实时更新事件已经发出但异步排队的帧追加尚未提交就发生崩溃，重连会显示最新已提交的帧前缀，它可能早于最后一个实时事件。

## 关闭、故障和外部终结

关闭是一种受控崩溃：

- 不写入合成响应；
- 已入队的帧提交属于已准入的普通 Session 工作，可能在关闭屏障下完成；
- 进程丢失可能丢弃尚未提交的变更；
- 重新打开时，在不变的 `effect_pending` 状态下恢复最新已提交帧前缀。

帧提交存储失败会使 Harness 发生故障。在该进程中，不会再提交响应结算。

已授权的外部终结会在其终端事务中删除操作所有的帧列表地址。每个追加变更都会在 Session 线上验证当前操作/响应所有权：

- 追加先发生 → 外部终端清理删除列表；
- 终结先发生 → 过时追加被拒绝，且不会重新创建状态。

## 终端清理、fork 和迁移

普通/合成响应结算本来就应该删除精确帧地址。操作终端事务还会在状态为 assistant/deferred `effect_pending` 时防御性地构造并删除当前操作所有的帧地址。

空闲 fork 不会复制 `pi.pending.assistant_frame` 地址族中的列表。精确重写和迁移会分页读取帧列表；如果保留帧，则保留元素序列。

如果迁移改变 `AssistantMessageFrame` 形状，必须映射每个仍存活的元素，或显式删除整个列表，并让 `effect_pending` 恢复时没有局部内容。绝不能从旧帧推断完成。

JSONL 会在快照压缩前保留已删除的帧字节。逻辑删除立即生效。

## 竞态

| 竞态 | 必须结果 |
|---|---|
| 帧追加 vs 下一个帧 | 同步入队保持 provider 事件顺序 |
| 帧追加 vs 流结算 | 结算等待最新 promise；所有已接受的追加先完成 |
| 实时更新事件 vs 帧提交 | 任一方都可能先完成；事件是观察，重连只使用已提交帧 |
| 追加 vs 外部终结 | 追加先发生时由清理删除；终结先发生时为追加设置 fence |
| 进程丢失且存在排队写入 | 只恢复已提交前缀 |
| 最终帧 vs 响应结算 | 帧先提交；结算原子删除列表并插入最终条目 |
| 激活 vs 快照 | 两者都归约同一个已提交序列前缀；激活随后可能结算并清除它 |
| 未知生成 vs 重试 | 合成局部错误在下一次尝试开始前使用旧预留 ID 提交 |
| 未知 deferred poll vs 替换 | 旧列表随新的替换 intent 删除；新响应 ID 获得新列表 |

## 不变量

1. assistant/deferred 标量状态是唯一的重启权威。
2. 一个 effect-pending response ID 精确构造一个 assistant 帧列表地址。
3. 每个存储元素都是导出的 pi-ai `AssistantMessageFrame`。
4. 终端 `done`/`error` 事件永远不会存为帧。
5. 帧顺序是 provider 事件顺序的子序列；零帧的已覆盖事件不会扰乱顺序。
6. 流结算时等待最新帧写入 promise，意味着所有已接受的追加都已完成。
7. 帧永远不会确立 provider 已完成，也不会抑制未知结果恢复。
8. 最终或合成响应结算会原子删除精确帧列表。
9. 恢复的局部内容可以出现在 `streamingMessage` 中，但结算前绝不会出现在 `transcript` 中。
10. 被中断的局部工具调用永远不会产生 tool plan，因为合成响应以 `error`/`aborted` 停止。
11. 本切片中的结构化生成永远不会写入 `pendingAssistantFrames(...)` 列表。
12. 终端清理、外部终结和空闲 fork 不会留下操作所有的 assistant 帧列表。

## 必需测试

### 帧集成

- 每流 encoder 能处理共享实时局部内容和同步事件突发，不产生重复内容；
- 每个事件追加零或一个帧，已覆盖的排队 delta 不追加任何内容；
- `done`/`error` 不追加任何内容，包括生成前错误；
- 交错的 content index 保留序列；
- provider 循环不会等待单个帧写入；
- 下一 provider 事件到来前，帧追加已同步入队；
- 只保留最新 promise 引用；
- 等待最新 promise 意味着所有更早写入已完成；
- 有界输出会限制排队帧内存；
- 存储失败会阻止 `after_response` 并使 Harness 发生故障。

### 结算和恢复

- 每种普通响应类别都原子删除帧列表；
- 覆盖每个帧/结算边界的崩溃；
- 没有帧，以及 partial text/thinking/tool-call 帧的情况；
- 权威 end-frame 内容能够保留；
- 中断生成提交局部合成错误，然后在有剩余次数时重试，或达到上限时失败；
- 中断的局部工具调用永远不会执行；
- 恢复使用零 usage 和现有预留 ID；
- 取消会在合成 aborted 响应中保留已提交局部内容；
- 恢复的合成结算永远不会运行 `after_response`。

### Deferred、快照和生命周期

- deferred poll 帧持久化和普通清理；
- 没有 permit 的未知 poll 快照；
- 替换 intent 删除废弃 poll 帧；
- 实时局部内容优先于持久归约；
- 重新打开时，处于 suspended effect-pending 的 lane 暴露归约后的 `streamingMessage`；
- 不重放历史更新事件；
- 恢复结算在 `entry_added` 时清除局部内容；
- 结构化生成不会写入 assistant 帧列表。

### 存储生命周期

- Memory/JSONL/SQLite 对相同帧序列产生相同归约结果；
- 普通、合成、取消和外部终端转换后帧列表都不存在；
- 空闲 fork 排除帧；
- JSONL 压缩移除已删除帧字节；
- 迁移映射或显式丢弃每个旧帧；
- instrumentation 记录追加/删除顺序，但 telemetry 中不包含帧内容。

## 实现映射

预期运行时区域：

- `session/values.ts` 中的内置 `pendingAssistantFrames(operationId, responseEntryId)` 地址构造器；
- `values.md` 中的有界 value/list 存储实现；
- assistant 执行 observer 和生成过程；
- deferred polling 过程；
- 激活和取消恢复；
- 快照 hydration；
- 终端清理、fork 和迁移；
- instrumented writer 和 backend 一致性测试。

先实现有界类型化 value/list 地址，再实现帧入队/结算，最后实现恢复/快照。在实现运行时 assistant parity 之前，用完整生命周期更新 `harness.md`。
