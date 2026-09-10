# 现有 AgentHarness Runtime 简化

## 范围

重做 `packages/agent/src/harness/runtime/` 下的真实实现和 `packages/agent/src/harness/session/types.ts` 中的规范持久类型。这不是独立的 scratch spike。

执行图是完整的，公开 drive 已启用。Format 4 仍在开发中，因此本次持久类型替换不需要 migration 或兼容表示。

## 实现状态

M6 完成前的测量：

- 简化前 runtime（`eb1185d93`）：5,358 行 TypeScript；
- 第一次简化后 runtime（`417905647`）：4,667 行；
- 简化后的 substrate（`0e77e57d9`）：4,654 行；
- M6 前总减少：704 行（13.1%）。

简化 pass 已实现：

- 显式的 `ContinueOperationResult<T>`，使用 `cancel_requested` 而不是隐式 `undefined`；
- 具体的 generation、deferred-poll 和 tool-call phase：准备不可变 input、发布持久 intent、执行 effect、发布持久 outcome；
- 共享的 assistant stream protocol 消费和 Drive response lifecycle；
- 用于通用 assistant/deferred 持久发布的 `publishResponse`，以及用于相同 pre-intent failure transition 的 `publishConfigurationFailure`；
- source-order tool publication、一次读取的不可变 source validation，以及隔离在 `runtime/drive/tool-placement.ts` 中的共享 tool-batch reconstruction；
- 移除同调用 tool status defense、未经检查的 `toolOperation()` cast 及其 result union；保留真实的 sibling/progress/memo check；
- 集中的 lane-storage classification，不重复读取 projection；
- checkpoint dead-check 移除和精确 checkpoint 保留；
- `runtime/transcript.ts` 中共享的 transcript mechanics；
- 更窄的 `LanePatch`、不多余的 Drive promise-settlement flag，以及未使用的 operation reject arm 移除。

简化完成时，最大文件是 `runtime/lane.ts`（约 996 行）、`runtime/drive/tools.ts`（约 663 行）、`runtime/drive/checkpoint.ts`（约 452 行）和 `runtime/drive/response.ts`（约 417 行）。

### WP05 结构化状态

M6 在简化后的 substrate 上建立了结构化执行。第一块一致切片增加了：

- 共享的、受 compaction 限制的 transcript/context read 和 committed-entry event decoration；
- 用于 compaction 和 branch summary 的 caller-owned 单 provider-request 接缝，同时为现有非 Harness caller 保留 retry 行为；
- `runtime/drive/structural.ts` 中每个结构化 `at` leaf 的直接 procedure；
- 每个 trigger 一次的 threshold routing 和 atomic overflow preparation publication；
- 每请求的 structural intent 和 usage settlement、attempt retry/recovery、hook decision、compaction/navigation publication 和 terminal cleanup；
- 对 threshold/overflow entry、split-turn request accounting、generated 和 hook result、retry/cap/recovery、model 缺失、请求中途 durable cancellation、navigation 和 preparation corruption 的聚焦覆盖。

随后 R1a、R2 和 R3 将 queued input 移到 lane，用不可变 operation record 替换 hydrated family outcome，并将 family cross-product 压缩为 13 个中性 leaf。R1b 用一个共享的 atomic boundary planner、transcript-derived threshold guard 和 off-line finish-hook replanning 替换了过渡性 checkpoint drain 和 marker field。M7 移除了 drained control，添加 atomic drain-and-return cancellation，协调全部 13 个 leaf，并安装完整的 direct dispatcher。

M8 增加 primitive/convenience lane surface、一个有序 tagged inbox、idle ownership、snapshot/event replication、`reduceLaneSnapshot` 和 remote resnapshot。M9 协调了规范。M10 只转发一个由 Session metadata ID 加 lane name 派生的稳定 ordinary-provider identity；structural summary 保持新的 request identity。M10 完成时 runtime 为 7,410 行，`runtime/drive` 为 4,147 行，`lane.ts` 为 1,992 行，`structural.ts` 为 1,221 行，新的规范 reducer 为 193 行。相对于经过审查的 M7 checkpoint，公开/复制 surface 增加 1,130 行 runtime；持久的 13-leaf procedure model 没有变化。

保留可见的持久 procedure 顺序：
`prepare → publish intent → perform effect → publish outcome`。
不要引入通用 Procedure interface、runner、scheduler、graph、callback plan 或 dependency facade。历史 work-package 文档保持不变。

## 核心模型

一个 Lane 是在一个持久 lane projection 上运行的一个进程本地 actor。

- `Lane.state` 对 tip、configuration、current operation、control、inbox ID 和最新 operation ID 具有权威性；
- 每个支持的 mutation 都通过 Session mutation line 提交，并在释放 line 前发布匹配的 `Lane.state`；
- 一个 lane-owned Drive 是推进 operation state 的唯一 writer；
- 同一 operation 的调用者观察同一个 Drive；没有调用者拥有它；
- Invocation cancellation 只会在 Drive 安装后停止该调用者的 observation；
- `requestAbort` 是唯一的持久 operation cancellation；
- Close 会封闭 mutation admission，但不会修改 operation state，也不会替换 Drive；
- Process loss 会销毁所有 live continuation；附着后从 durable state 开始恢复；
- 执行期间的 Session read 会根据 `Lane.state` 命名的内容解引用；不会重新发现 control state。

## 持久状态

`OperationState` 有一个 discriminator `at`，包含 13 个直接 leaf：

- `starting`
- `checkpoint`
- `assistant.ready`
- `assistant.effect_pending`
- `assistant.retry_wait`
- `tools`
- `deferred.suspended`
- `deferred.effect_pending`
- `summary.deciding`
- `summary.ready`
- `summary.effect_pending`
- `summary.retry_wait`
- `navigation.ready_to_commit`

每个 leaf 携带一个统一的 `OperationScope`。Summary quadruple 携带一个 `SummaryTask`；其关闭的 `ResultBoundary` 选择 in-run checkpoint resumption、standalone finish 或 navigation commit。Summary algorithm 从这个 boundary 派生，而不是复制到 state 中。`Control` 保持正交。`ToolBatch` 仍然是子状态机，因为并行 tool child 确实会并发修改 sibling call status。

## State 和 content 边界

Procedure 永远不会读取以下 address 来决定执行：

- `laneState`
- `operationMeta`
- `operationState`
- `branchTip`
- `laneConfig`
- `operationResult`

它们使用 mutation line 提供的当前 `Lane.state`。

Storage read 只用于 content 和 cleanup：

- prompt、assistant、deferred-source、final-assistant 和已完成 tool entry；
- 受 compaction 限制的 branch context；
- `pendingEntry` payload；
- assistant-frame list；
- tool argument、memo 和 checkpoint；
- structural preparation；
- staged tool outcome；
- terminal cleanup 所需的 operation-owned prefix scan。

## 并发模型

### Operation advancement

只要 Drive procedure 存活，没有受支持的并发 actor 可以改变或删除其 operation state：

- inbox method 只修改 inbox field；
- `requestAbort` 只修改 `control`；
- close 会阻止后续 mutation admission；
- 另一个同 operation caller 会加入现有 Drive；
- lane 忙时不能接受另一个 operation；
- process crash 会移除 continuation 本身。

因此，普通 procedure transition 不需要重新检查 operation existence、operation ID、operation kind、`at`、attempt identity 或 nested status。这些是 dispatch 建立的 procedure precondition，不是受支持的 race。

剩余的真实 race 是：

1. cancellation 在 effect admission 前或 settlement 前到达；
2. inbox arrival 早于 checkpoint routing 或 terminal finish；
3. parallel tool child staging 和 sibling outcome materialization；
4. queued frame/checkpoint/memo write 与 effect settlement 竞态；
5. retry timer 与 cancellation 或 close 竞态；
6. deferred permit consumption；
7. Session line 上的 accept/claim serialization。

### Cancellation 边界

只在三个位置检查 cancellation：

1. drive loop 在 ordinary dispatch 前；
2. gate 在 external effect 启动前；
3. effect settlement 查看当前 `control`，并提交适当的 cancelled result。

普通 transition helper 可以在当前 control 为 `cancel_requested` 时集中拒绝 progress。Procedure 不再手写这段分支。

### Close

关闭 Harness：

1. 标记 Harness/lane admission closed；
2. seal 并 drain Session mutation line；
3. 通过 Harness-close observation promise 拒绝 client observation；
4. 观察每个 detached pass promise，使后续 rejection 不会变成 unhandled；
5. 在 admitted mutation drain 后关闭 Session。

Close 不执行 durable write、不安装 replacement Drive，也不创建 ownership-loss state。迟到的 effect 可以返回，但其 mutation 会以 `HarnessClosed` 被拒绝。

Close 是否也 signal 进程本地 provider/tool 工作，是 resource-cleanup policy，不是 durable state-machine 行为。不要将其与 Drive replacement 或 recovery 耦合。

## 小型具体 Mutation API

使用两个具体 Lane operation 替换 procedure 中反复出现的 `LaneCommand` ceremony。它们不是 scheduler、graph 或 action interpreter。

### `continueOperation`

用于普通的非终端 progress。

- 进入 Session mutation line；
- 接收当前权威 Lane projection 和 operation state；
- 如果 control 已取消，返回显式 `cancel_requested`，不调用 semantic planner；caller 不会把取消误认为 planner value；
- Planner 提供 procedure-specific write、下一个完整 `OperationState`、materialization 和 event；
- Helper 追加 `operationState` write，并发布匹配的进程本地 operation projection；
- 不验证 expected state 或 `at` value。

### `settleOperation`

在已准入的 provider/tool/structural effect 之后，以及真正的 parallel child transition 中使用。

- 即使 control 已取消，也进入 Session mutation line；
- 将当前 control/inbox field 和进程本地 effect result 提供给 semantic settlement planner；
- 原子提交 payload、usage、tip movement、cleanup 和分类后的 next state；
- 追加规范 operation-state write，并发布匹配 projection；
- Planner 返回 terminal decision 时，追加不可变 `operationResult`、带 `lastOperationId` 的 idle `laneState` 和 idle 进程本地 projection。

Caller 提供 typed outcome、cleanup/publication write、last result 和 event。Terminal business decision 仍然在 owner procedure 中可见。

## 持久 Procedure 形态

Effectful procedure 暴露四个具体 phase：

```text
prepare immutable inputs
→ publish durable effect intent
→ perform the external effect
→ publish one durable outcome
```

Intent phase 必须可见并先于 external effect。否则，effect 之后、intent 之前发生崩溃时，就没有可恢复的 unknown-outcome marker。每个 procedure 使用 `prepareGeneration`、`publishGenerationIntent`、`performGeneration` 和 `publishResponse` 等具体函数，不存在通用 Procedure abstraction。

## Drive 生命周期

删除 installer-owned model。

- 移除 `installerSignal`；
- 移除 `DriveAbandoned`；
- 从 procedure result 中移除 `LostOwnership` 和 `lost_ownership`；
- 移除 exact-object ABA fencing 和 `commandDriveOwned`；
- 移除 `finalizedOutcome` 和 planned external-finalization owner retention，除非 Flue investigation 确认具体需求；
- 只保留 `activeDrive` 作为 lane 的 install/join slot；
- 安装会把工作转移给 lane。每个 caller（包括 installer）都使用自己的 invocation Context 观察完成；
- Caller signal 在安装前 abort 时不安装任何内容；安装后只拒绝该 caller 的 observation；
- Pass settle 或进入 durable wait 后移除 Drive。进程内不会替换 live pass。

`requestAbort` 保留两段 gate 顺序：

```text
beginAbort before cancellation mutation
commit cancel_requested
signalAbort after commit
```

这会阻止新 effect 在 durable marker 提交期间进入。

## 保留的检查

不要移除对外部或被引用内容的验证：

- 必需 entry 的存在和 role；
- pending payload kind；
- deferred handle identity；
- provider stream protocol ordering；
- response stop-reason invariant；
- UUIDv7 follower timestamp parsing；
- configured model/tool availability；
- tool-call source index 和 staged result identity；
- parallel tool call status 和 ready-prefix placement；
- progress/memo invocation identity；
- retry timestamp 和 deferred permit arithmetic。

这些检查验证的是数据或真实的子并发，而不是对 operation state machine 的防御性重复验证。

## 已完成的分阶段实现计划

### Stage 1——规范的扁平持久类型

文件：

- `src/harness/session/types.ts`
- `src/harness/runtime/`、restore、conformance helper 和聚焦测试中的仅编译 consumer
- `docs/harness.md`
- `docs/work-packages/05-direct-durable-drive.md`

动作：

- 用扁平 `at` union 替换嵌套 operation state declaration；
- 保留每个 durable datum，不使用兼容 alias；
- 机械更新 pattern matching，不改变行为；
- 保持 ToolBatch/ToolCall 嵌套；
- 同步更新规范文档。

出口：`npm run check`；现有聚焦 runtime test 通过；规范 operation state 中不再有 `phase.kind`、generation `status`、deferred `status` 或 structural decision `status`。

### Stage 2——增加规范 Transition Operation

文件：

- `src/harness/runtime/lane.ts`
- `src/harness/runtime/types.ts`
- 聚焦 Lane test

动作：

- 增加 `continueOperation` 和 `settleOperation`，包括 terminal-decision suffix；
- 在一个实现中将每次 durable operation-state write 与进程本地 projection publication 配对；
- 集中 ordinary cancellation diversion；
- 信任 dispatcher 建立的当前 leaf，不做 expected-state check；
- 让 procedure-specific write 和 event builder 在调用点可见。

出口：聚焦测试证明每个 helper commit 后 durable state 与 `Lane.state` 仍相同。

### Stage 3——转换 starting、checkpoint 和 assistant

文件：

- `runtime/drive/checkpoint.ts`
- `runtime/drive/generation.ts`
- `runtime/drive/recovery.ts`
- `runtime/progress.ts`

动作：

- 移除重复的 operation/null/kind/state check 和 `same*` predicate；
- 将 ordinary progress 转换为 `continueOperation`；
- 将 assistant settlement 转换为 `settleOperation`；
- 只保留 checkpoint inbox/finish race 和 progress-channel ownership check；
- 如果更小，将 assistant recovery 合并到 effect-pending handler。

出口：不再读取 control-state storage；不再重复验证 assistant state；聚焦 generation test 通过。

### Stage 4——转换 deferred 和 tool

文件：

- `runtime/drive/deferred.ts`
- `runtime/drive/tools.ts`
- `runtime/progress.ts`

动作：

- 对语义相同的部分共享 assistant/deferred response-entry、usage 和 tool-plan 构造；
- 保留 deferred permit 和 handle check；
- 移除顶层 operation-state revalidation；
- 保留每个 call 的 tool status merge、completion-order staging、source-order placement、memo fencing 和 progress fencing；
- 对 live、recovery 和 cancellation mode 使用一个 tool-batch procedure，而不是独立的 ownership-result path。

出口：tool status check 只存在于真实 sibling concurrency；聚焦 deferred/tool/progress test 通过。

### Stage 5——移除 ownership-loss machinery

文件：

- `runtime/types.ts`
- `runtime/lane.ts`
- `execution/effect-gate.ts`
- 现有 `runtime/drive/*.ts`
- 相关聚焦测试

动作：

- 移除 `LostOwnership`、`commandDriveOwned`、exact Drive check、`installerSignal`、`DriveAbandoned` 和 `finalizedOutcome`；
- 让所有 drive caller 成为 observation peer；
- 为 Drive completion waiting 增加仅 observation 的 Context cancellation；
- 仅保留 `activeDrive` 用于 install/join arbitration；
- 删除 ABA/replacement test，用 install/join/observation-cancellation test 替换。

出口：grep 在生产 runtime 中找不到 ownership-loss 或 installer-abandonment 词汇。

### Stage 6——Close 和 fault

文件：

- `runtime/harness.ts`
- `runtime/lane.ts`
- Drive observation helper
- lifecycle test

动作：

- 封闭 mutation admission，并 drain 已准入 mutation；
- close/fault 时拒绝 client observation，不替换 Drive，也不改变 durable operation state；
- 观察 detached pass failure；
- 验证迟到的 effect 不能在 close 后 commit；
- 单独决定是否 signal local effect 做资源清理。

出口：close 和 process loss 保留相同的 durable restart point；close path 不写 cancellation 或 synthetic settlement。

### Stage 7——在更简单的 substrate 上完成 WP05

文件：

- `runtime/drive/structural.ts`
- `runtime/drive/reconcile.ts`
- `runtime/drive.ts`
- `runtime/lane.ts` public surface

动作：

- 直接基于 flat leaf 和 transition operation 实现 structural generation；
- 将 cancellation reconciliation 实现为一个 flat-state switch；
- 将完整 drive switch 实现为一个 `state.at` switch；
- 只有每个 leaf 都完整后，才接入 public claim/join/observation 和 convenience method。

除非 Flue investigation 找到无法通过 close、explicit abort、recovery 或 offline administration 表达的具体当前 caller，否则排除 external finalization。

## 验证

每个代码 stage 之后：

```bash
npm run check
```

从 package root 运行每个修改过的聚焦测试文件。只有最终 stage 让每个 leaf 完整后，才启用 public drive；不要直接运行完整 Vitest suite。

最终审计：

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome' packages/agent/src/harness
rg 'operationState\(|laneState\(|branchTip\(|laneConfig\(' packages/agent/src/harness/runtime/drive
```

第二条审计可能匹配 write constructor，但任何 reader call 都不得使用这些 control address。
