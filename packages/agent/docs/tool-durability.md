# Tool durability — 实现 handoff

本文规定 durable tool-call lifecycle，以及当前 tool API 的最小 harness 专用 progress-checkpoint 扩展。不在此最终确定 harness-native public tool interface；该接口必须提供所需 capability，但不能暴露原始 Session storage。

本设计有两个独立增加项：

1. 外部 effect settlement 与 source-order conversation placement 之间的 durable outcome_ready 状态；
2. 可选的、对完整有界 onUpdate snapshot 的 durable replacement checkpoint。

## 问题

并行 tool effect 按完成顺序结束，但 tool-result entry 必须按 assistant source order 进入 conversation。若没有中间 durable state，B/C 可能已经完成却只存在进程内，A 阻塞 placement 后崩溃，恢复会错误地重跑或中断已完成的 effect。

解决方案拆分两种顺序：

1. outcome durability：实际完成顺序；
2. entry materialization：assistant 源码顺序。

完整最终结果立即写入 pi.pending.entry，call 变为 outcome_ready；等更早 source position 都 complete/ready 后再 placement。

## 目标

1. 完整最终 outcome durable 后不再重跑 tool；
2. 持久化 out-of-order parallel outcome，同时保持 transcript 顺序；
3. 保留 replay: "safe" | "never"；
4. 支持 Flue 风格 step.do 的 invocation-scoped memo；
5. 保留 reconnect 和 unsafe interruption recovery 所需的 bounded progress checkpoint；
6. 在 outcome settlement、cancellation 或 external finalization 后 fence late write；
7. 最终 tree entry canonical、完整、有界且 immutable。

## 非目标

不保证任意外部 effect exactly-once；不为每个 step.do 建独立 durable state machine；不从 progress 推断 completion；不把 partial output 当最终结果；不向 tool 暴露 raw Session/SessionMutator/storage address；不在本文最终确定 public harness-native tool type。

## Durable identity

每个 call 在执行前已经预留 result entry ID，并将其作为稳定 public invocation identity：

~~~text
invocationId = resultEntryId
~~~

它跨 safe replay 保持稳定，但与 provider 的 batch-local toolCallId 不同。外层 operation state 继续提供 operationId、turn/generation step ID、sourceIndex、assistant entry ID、captured config 和 execution mode。

## Storage

### Existing bound values

operationToolArgs(operationId, turnId, sourceIndex) 保存 effect admission 前的有效参数；pendingEntry(resultEntryId) 保存等待 placement 的完整最终 ToolResultMessage。

### Invocation memo

session/values.ts 定义 operation-owned address：

~~~ts
export const operationToolMemo = (
  operationId: string,
  invocationId: string,
  memoName: string,
) => value<JsonValue>(
  "pi.op.tool_memo",
  operationId + ":" + invocationId + ":" + memoName,
);
~~~

memoName 非空且不能含冒号，可用点或斜杠分组。setMemo(name, undefined) 删除精确地址。operation cleanup 可用 operationToolMemoPrefix 扫描，单次 outcome 可扫描 invocation 前缀。

### Partial tool output

durable recovery value 是工具选择的最新完整有界 progress snapshot，使用一个 bound value：

~~~ts
export const pendingToolOutput = (
  operationId: string,
  invocationId: string,
) => value<AgentToolResult<unknown>>(
  "pi.pending.tool_output",
  operationId + ":" + invocationId,
);
~~~

它只用于 observation，不能证明 effect 成功/完成；内容/details/usage 与 live partialResult 相同。工具负责 snapshot 上限、checkpoint cadence 和 duplicate suppression；harness 负责同步 enqueue、promise tracking、invocation fence 和 cleanup。没有通用 byte cap、flush method 或 progress list。崩溃可能丢失最近 checkpoint 之后的 live update；Memory/SQLite 保留一个当前值，JSONL 在 compaction 前会按 checkpoint 大小/频率增长。

## Tool update API

保留 full-snapshot update callback，增加 harness 专用 options：

~~~ts
export interface AgentHarnessToolUpdateOptions {
  checkpoint?: true;
}

export type AgentHarnessToolUpdateCallback<TDetails> = (
  partialResult: AgentToolResult<TDetails>,
  options?: AgentHarnessToolUpdateOptions,
) => void;
~~~

harness 总是提供该 callback，即使没有 live listener；checkpoint:true 只是请求持久化，不是 acknowledgement。每次调用仍立即发布 live update 并返回 void。

每个 checkpoint:true 都在 Session mutation line 上同步 enqueue 一次 scalar replacement，绑定 fault observer，并替换 latestCheckpointWrite 引用。写入不 drop、不 coalesce；FIFO、effect_pending fence 和 latest promise 保证顺序。tool settlement 停止接受 update，等待 latest promise；失败的 checkpoint commit 按普通 storage fault 使 harness fault。trusted tool 自行负责 cadence，内置 bash policy 负责限制普通场景下的排队。

### Bash policy

bash 保持 100 ms live update，最多每两秒请求一次 checkpoint，且完整 snapshot 与上次请求不同：

~~~ts
const BASH_UPDATE_THROTTLE_MS = 100;
const BASH_CHECKPOINT_INTERVAL_MS = 2_000;
~~~

ShellCaptureProgress 已提供 bounded snapshot：最后 2000 行或 50 KiB，加 truncation metadata 和 overflow path。初始空 update 只 live，不加快 checkpoint；短 tool 可以不写 checkpoint，因为最终结果会完整提交。

## Tool-call state

ToolCall 增加 outcome_ready：

~~~ts
type ToolCall =
  | { status: "planned"; sourceIndex: number; resultEntryId: string }
  | { status: "effect_pending"; sourceIndex: number; resultEntryId: string; replay: "never" | "safe" }
  | { status: "outcome_ready"; sourceIndex: number; resultEntryId: string; terminate: boolean }
  | { status: "completed"; sourceIndex: number; resultEntryId: string; terminate: boolean };
~~~

outcome_ready 表示 execution/error normalization/after_tool 已结束，或 harness 已生成 synthetic result；完整 ToolResultMessage 已在 pendingEntry；memo 和 partial-output storage 已清理；该 tool 永不再执行；immutable result entry 可能因更早 call 尚未 ready 而暂未存在。不要在 union 中重复最终 payload。

## State transition

~~~text
planned
  ├─ real effect admitted → effect_pending
  └─ immediate/synthetic  → outcome_ready

effect_pending
  ├─ live effect settles    → outcome_ready
  ├─ safe orphan replay     → outcome_ready
  └─ unsafe synthesis       → outcome_ready

outcome_ready
  └─ source position ready  → completed
~~~

立即可放置的 head call 可以把最后一步合并到同一事务，但语义检查必须覆盖持久化 outcome_ready；优先实现显式两事务形式。

## Fresh execution

### Clearance 与 intent

流程不变：

~~~text
planned
→ prepare args、before_tool、校验替换
→ TX[set operationToolArgs; set call=effect_pending(replay)]
→ post-commit tool_start
→ admit tool execution
~~~

invocation capability 只在 durable effect_pending 后激活。

### Partial output

每个 onUpdate 通过现有 event/snapshot path 发布 live update。checkpoint:true 额外请求：

~~~text
TX[setValue(pendingToolOutput(operationId, invocationId), partialResult)]
~~~

mutation 执行时校验 operation、turn、source position 和 invocation 仍是 effect_pending。它不改 pi.op.state；settlement 后的 late checkpoint 不提交。工具必须写有界完整 snapshot。客户端可显示但只在进程内保留未 durable 的更新。

### Finalization to outcome_ready

tool promise settle 后：

1. 同步停止接受 update 并让 capability 失效；
2. 等待 latest tool_update delivery 和 latest checkpoint write；
3. 如果是真实 fresh/safe replay 且 cancellation 未阻止，执行 after_tool；
4. 构造完整 ToolResultMessage；
5. 提交 outcome_ready；
6. 从 committed staging transition 发出并等待 tool_end。

setMemo 返回 promise，tool 必须 await；step.do 始终 await。pre-return enqueue 的 mutation 会排在 staging 前，capability 过期后新调用拒绝。

事务包含 pendingEntry(finalized message)、删除 pendingToolOutput、删除在 commit 前返回的 invocation memo、设置 call=outcome_ready。它是 invocation 永不 replay 的线性化点；post-commit tool_end 是 outcome ready 的 durable evidence，不再是 pre-commit effect observation。staged message 保存 text/image、provider tool-call ID/name、details、isError、usage、addedToolNames、timestamp；terminate 保留在 orchestration state，并在 placement 时复制到 immutable entry。

## Source-ordered materialization

call 进入 outcome_ready 后，从第一个尚未 completed 的 source position 开始找连续 ready prefix：

~~~text
[completed, outcome_ready, outcome_ready, effect_pending]
             └──────── ready prefix ────────┘
~~~

placement transaction 前按 source order 发送并等待每个 finalized result 的 message_start/message_end；随后在一个事务中插入 result entry、删除 pendingEntry、写 tool usage、更新 Branch tip 和 operation state。entry 使用预留 resultEntryId，并在事务内建立 parent chain。usage 与 entry 同时写，避免 ledger row 指向尚未存在的 entry。最后一个 call materialize 时清理 tool args 并进入 may_finish 或 need_assistant(false)。

## Parallel execution

outcome staging 按完成顺序，entry materialization 按 source order：

~~~text
A、B、C start
B finish → B outcome_ready
C finish → C outcome_ready
A finish → A outcome_ready
            materialize A、B、C
~~~

B/C staging 后崩溃时，恢复只对 A 应用 unknown-outcome policy；B/C 不需 tool registry/hook 即可成为 entry。durable invariant 是 completed 形成 source-order prefix，prefix 后可任意混合 planned/effect_pending/outcome_ready，只有 source-order materialization 能扩展 completed prefix。sequential mode 在 prefix 后最多构造一个非-planned call。

## Unsafe recovery with partial output

对 replay:never 的 orphaned effect_pending：

1. 读取存在的 pendingToolOutput；
2. 保留 bounded content/details；
3. 追加必需的人类可读 interruption marker；
4. 构造 isError:true 的 harness-owned ToolResultMessage；
5. 以 outcome_ready 提交并清理 invocation state。

marker 必须说明输出可能不完整且外部结果未知；isError 描述交给 model 的结果，不断言外部 effect 失败。例如：

~~~text
[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]
~~~

不执行 after_tool；保留 checkpoint usage，但忽略 addedToolNames/terminate；terminate=false，不新增工具；无 checkpoint 也合法；不能从 partial output 的成功行推断完成；cleanup 与 synthetic staging 原子进行。

## Safe recovery

如果 stored/current declaration 都是 replay:safe：

1. 保留 invocation memo；
2. 原子删除旧 pendingToolOutput；
3. 必要时发布/reset 进程内 progress；
4. 用持久化参数和同一 invocationId 重跑 tool；
5. 已完成 step.do 直接返回 memo；
6. 新 partial output 形成干净进度流；
7. 进入普通 outcome_ready path。

删除旧 progress 可避免 replay 再次发送重复 chunks。若删除后、replay admission 前崩溃，仍为 effect_pending，下一次重复 safe procedure。当前实现缺失或已不再 safe 时使用 unsafe interruption。

## Invocation memo 与 step.do

harness-native invocation capability 提供 invocationId、operationId、turnId 以及 getMemo/setMemo。每次操作校验 memo name 和 capability expiry，在 mutation line 上同步 enqueue，并在执行时校验 operation/turn/source/invocation 仍是同一 effect_pending call，只访问本 invocation 地址。过期或 ownership loss 后拒绝。

tool 返回前启动的 memo mutation 按 FIFO 排在 staging 前；之后的 zombie callback 不能重建 memo，也不能写入新 operation。memo 在 effect_pending 期间存活，任何 real/synthetic outcome_ready 时删除。terminal cleanup 仍防御性扫描 operation-owned memo/output family。

step.do 使用 deterministic unique name：

~~~text
validate name
→ getMemo
→ 有值则返回
→ 无值则执行 effect
→ setMemo
→ await durability
→ 返回值
~~~

它是 exactly-once recorded、at-least-once executed，不使任意外部 effect exactly-once。错误不 memoize；同一 live execution 重复 step name 是 invariant error；本阶段不增加 per-step replay policy。

## Application persistent state

应用状态不同于 invocation memo。memo 在 step completed 后立即可见；应用状态必须与最终结果一起在 outcome_ready 时可见，effect 中途崩溃不能提前出现。不要在 execution 中直接 Session.setValue。

可行阶段：Flue 在外部维护并按 invocationId 原子保存 state + result memo；或未来 harness 接受 staged application write，在 outcome_ready transaction 提升。第二种只有 usePersistentState 进入 harness-owned values 时才需要，typing/conflict semantics 仍待决定。

## Cancellation

reconciliation 永不重放 restored tool：

- planned → synthetic aborted result → outcome_ready；
- live started call 可以在 cancelled control 下提交真实 local result，但 terminate=false；
- restored effect_pending 总是 interruption synthetic，可带 partial；
- 已 outcome_ready 的 call 保留并按 source order materialize；
- 每个 cancellation outcome staging 都删除 memo/partial；
- restored synthetic reconciliation 不启动 before_tool/after_tool。

所有 call outcome materialize 且 deferred writes drain 后，才执行 aborted terminal transaction。

## Close 与 external finalization

close 是 controlled crash：已在 admission barrier 下 enqueue 的 memo/checkpoint 可完成；最新 checkpoint 之后的 live output 可能丢失；不写 synthetic outcome 或 cancellation marker；状态停留 effect_pending 或 outcome_ready。

External finalization 在 terminal transaction 删除 operation-owned args、memo、partial output、staged outcome 和 pending entry。之后的 live task 因 ownership fence 失败，并通过 OperationEnded 停止。

## Restore 与消费时读取

Base restore 只从 owner values 构造 trusted lane/operation projection，不 hydration 或语义审计 args、memo、checkpoint、staged outcome、completed entry、prefix shape 或 execution-mode relation。

- planned：不需辅助读取，准备参数并在 effect admission 前写入；
- effect_pending：读取精确 operationToolArgs，可选 pendingToolOutput；缺失 required args 在消费时 fault，memo 只通过 capability 读取；
- outcome_ready：读取 pendingEntry；缺失或 message relation 错误在 materialization 时 fault；
- completed：普通 dispatch 不做 restore audit。

所有 live mutation 仍在线上校验 operation、turn、source、invocation、status；这是并发 fence，不是历史恢复验证。

## Snapshot 与 reconnect

重连客户端可能先看到比 durable checkpoint 更新的进程内 progress；进程替换后只看到最新 committed checkpoint；outcome_ready 在 placement 前以 settled row 出现在 runningTools；completed 在 transcript。

SnapshotTool 使用 discriminated union：effect_pending 为 running + 可选 result；outcome_ready 为 settled + 必需完整 result + isError；entry_added 后才删除 settled row。planned/completed 不进入 runningTools。

## Events 与 hooks

tool_start 表示 fresh call 的公开 processing presentation，来自 intent commit 或 synthetic staging commit，本身不证明外部 effect 已开始；携带 effective/source args。progress event/checkpoint 不证明完成。harness 等待 latest tool_update delivery 后再 after_tool。

tool_end 携带完整最终结果，在 outcome_ready staging commit 后按 completion order 发出，不重复 args。fresh blocked/invalid/truncated/planned-cancel synthetic 在 staging 后按 tool_start→tool_end；unsafe recovery 可以只发 recovery tool_end。message lifecycle 和 entry_added 在 materialize 时发生，entry_added 只移除对应 settled row。listener 不能 reentrant 修改 invocation。

## Race

| race | 必须结果 |
|---|---|
| checkpoint vs settlement | 已接受 checkpoint 先入队，settlement 等 latest，再 staging 删除；late update 忽略 |
| memo vs outcome_ready | pre-return write 排在 staging 前并被删除，post-return reject；external finalization 先发生则 durable ownership check reject |
| B vs earlier A | B 独立 staging，placement 等 A |
| staging 后崩溃 | tool 不重放，pending result 后续 materialize |
| source-prefix placement 中崩溃 | 事务暴露 none 或 all |
| safe replay vs old partial | replay 发 progress 前先删除旧 checkpoint |
| cancellation vs real settlement | mutation order 只让 real cancelled result 或 synthetic outcome stage 一次 |
| terminal finalization vs late result | terminal ownership 或先 staging，late task 不重建 operation data |
| external finalization vs memo/checkpoint | mutation 先发生则被 cleanup，finalization 先发生则 mutation reject |

## Invariants

1. invocationId 等于预留 result entry ID，safe replay 中稳定；
2. outcome_ready/completed 永不再次执行；
3. 每个 outcome_ready 恰有一个匹配 pendingEntry；
4. completed 是 source-order prefix；
5. 只有 source-order materialization 扩展 prefix；
6. prefix 后 parallel call 可混合 planned/effect_pending/outcome_ready；
7. memo 只在 effect_pending 存在；
8. partial output 只是辅助信息；
9. unsafe synthetic 明确说明 output incomplete、external outcome unknown；
10. outcome staging 原子删除 memo/partial；
11. materialization 原子插入 immutable entry 并删除 pending；
12. late capability 不能在 settlement/operation loss 后写；
13. step.do 只在 memo commit 后 memoize，effect 仍至少一次执行；
14. terminal cleanup 不留下 tool args、memo、partial 或 staged outcome。

## 必需测试

覆盖 state/restore、parallel ordering、replay/interruption、memo/step.do、partial output、atomicity/instrumentation：

- 各类 ToolCall projection 在没有不必要 auxiliary read 时可恢复；
- effect_pending 只读精确 args/可选 bounded checkpoint，outcome_ready 只读精确 staged result；
- 缺失 required args/result 在消费 procedure fault；
- B/C 先 staging、crash/reopen 不 replay；
- safe replay 使用持久化 args 和同一 invocationId，清旧 progress；
- safe→never downgrade 使用 interruption；
- unsafe recovery 有/无 checkpoint，synthetic 为 error/incomplete/unknown 且不运行 after_tool；
- memo get/set/delete、crash 前后 memo、step skip/retry、duplicate name、expiry race；
- live-only update、checkpoint cadence、bash 100 ms/2 s、latest promise 推导、checkpoint 后不可重建；
- Memory/JSONL/SQLite checkpoint 一致；
- 精确 intent→start→update→staging→end→placement 顺序，synthetic staging→start→end→placement；
- staging 与 cleanup、placement 与 pending/usage/tip/state 原子；
- 每个边界 crash、无 intent 不启动 effect、outcome_ready 不启动 effect/hook、terminal 删除所有 tool value。

## 实现地图

主要涉及 operation-state types、trusted restore projection、tool batch procedure、source-order materialization、terminal cleanup、cancellation reconciliation、harness update options/snapshot/events、Session mutation line 上的 invocation capability、backend conformance 和 instrumented-storage assertions。

内置地址：

~~~text
operationToolMemo(operationId, invocationId, name) → pi.op.tool_memo
pendingToolOutput(operationId, invocationId)      → pi.pending.tool_output
pendingEntry(resultEntryId)                       → pi.pending.entry
~~~

先实现 outcome_ready 和 invocation memo，再实现 progress checkpoint。前者单独解决 parallel replay 错误，后者改善 reconnect/unsafe interruption 诊断，但不成为 completion authority。
