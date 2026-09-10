# WP02 — 原子接受与一致的 lane 观测

## 状态

已完成。Phase A 建立了最小 attachment、活动 operation inventory、Session line inspection/watch capture、commit continuation 中的 recipient binding，以及 in-band identity failure 词汇。Phase B 已在 beac75ecc 落地，focused tests、monorepo check、全套测试和最终 Fable review 均通过。

实现也更新了变更公开契约所需的 protocol/coding-agent wire projection。没有增加 execution owner、provider/tool effect、timer、retry、polling、cancellation procedure、manual action 或 terminal settlement。

## 目标

提供两个不涉及 effect 的边界：

~~~text
idle lane
→ 原子接受 prompt/skill/template
→ 无 payload 的持久化 starting operation

open 或 running lane
→ Session line watch capture
→ 完整 snapshot 加无间隙的后续事件
~~~

AgentHarness.create(options, context) 成功后：

- 每个配置 lane 都有完整的小型进程内 projection；
- open 只盘点持久化的当前 operation，不预测 model/tool 是否可用；
- attachment 不启动 hook、provider、tool、timer、breakpoint、drive owner 或 application callback；
- inspectExecution(context) 在 Session line 上观察小 projection 和本地 owner；
- watch(context) 注册 buffering、复制实时 presentation，并在一个无写入 lane job 中完成有界 snapshot read；
- 每个提交型 lane job 在 commit continuation 中发布 memory，并同步绑定 event batch；
- mutation 不等待 listener delivery，但公开 operation 会等待。

WP02 不实现 drive、provider generation、hooks、tools、retry、deferred polling、cancellation、manual action execution 或 terminal settlement。

## 决策

### 1. Attachment 恢复 projection，不恢复 presentation

将 open Session 传给 AgentHarness.create() 后，编排所有权持续到 create 拒绝或 harness close。期间禁止直接 Session.mutate、Session.createLane、保留地址写入和创建第二个 harness，避免 lane inventory 与外部 lane creation 竞争。

Attachment 只读取 branchTip、laneConfig、laneState、可选 laneLastResult，以及当前 operation 的 operationMeta、operationState。它校验必需值存在、operation ID/lane ownership 和 intent/state kind 一致；projection 损坏使 create 失败。

Attachment 不读取 transcript、queues、pending writes、drained payload、deferred source、frames、tool calls、args、checkpoints、preparations、memos 或 staged outcomes。这些引用由 watch 或消费时的 drive 校验。必需 payload 缺失/矛盾是存储损坏；可选 frame/checkpoint 缺失合法。

### 2. Watch 负责详细 snapshot read

一个无写入 Session mutation job 定义 watch 边界：

~~~text
等待所有早先 lane job 完成
→ 同步注册 buffering watcher
→ 同步复制 live presentation
→ 在排除后续 lane job 时完成有界 durable reads
→ 组装 snapshot
→ 释放 Session line
→ 返回 handle
~~~

首次 watch、重连和执行中的 watch 使用同一流程，不设专用 cache。读取集合包括：当前 tip 的 compaction-bounded branch scan；nextRun/steer/follow-up/write/abort drain 的精确 pendingEntry；deferred source；tools 阶段的 assistant entry 和 effect_pending call 的 args；有界 assistant frame page 与可选 tool checkpoint。

ToolCall.sourceIndex 是完整 assistant message content 数组中的索引，不是过滤后的 tool-call ordinal；被表示的 call 必须指向 tool-call block。

### 3. Recipient binding 放在 commit continuation

成功提交的 lane job 依次执行：

~~~text
commit
→ 发布小型自有 projection
→ 同步绑定 recipient，并追加完整 { event, context } batch
→ mutation 返回且不等待 delivery
→ 公开 operation 在完成前等待 delivery
~~~

WP02 曾用 enqueue()+调用方 start()；WP04 将其替换为同一 commit-observation continuation 中立即调用 emitBatch()。emitBatch 后注册的 listener/watcher 不能收到历史事件。

唯一两种 watcher/publication 顺序：

~~~text
watcher first       → snapshot-before + 完整 buffered event batch
publication first   → snapshot-after + 不包含旧事件
~~~

live provider/tool 更新也采用同步 publish + emitBatch；frame/checkpoint commit 是排在 watch capture 后的 lane job。

### 4. Inspection 是无写入的 Session-line 观测

inspectExecution(context) 观察 lane、tip、未解析的 { provider, modelId }、current operation ID/kind/start time、running/open/durable aborting 状态，以及当前 durable phase 中记录的 model identity 和可选 latest result。不解析 model/tool registry，不读取 transcript 或 presentation payload。

### 5. 缺失实现使用 in-band outcome

不存在 blocked、missing-identity suspension、预测 classifier 或 acceptance registry preflight。

实际执行边界的规则：

- provider model 或配置中的 active-tool definition 不可用，且 provider intent 尚未持久化时，产生不可重试的 configuration failure；
- pre-intent failure 不保留 response/usage ID，也不伪造 assistant response/usage row；
- 恢复的 effect_pending 先使用已有 reserved ID 解决不确定性；
- deferred model 不可用时以 configuration failure 持久化放弃兑换；
- requested tool 缺失时直接生成 isError ToolResultMessage 并继续；
- 缺失或不再安全的 replay 实现生成 interruption，不等待。

synthetic tool result 不带 details；details 的类型由工具负责，harness 不伪造 {} 或诊断对象。稳定错误码为：

- model_unavailable，details { provider, modelId }；
- configured_tools_unavailable，details { tools: string[] }。

failure_drain 增加 { kind: "configuration" } provenance。实际转换由对应 execution package 落地，WP02 只提供规范和 source vocabulary。

### 6. Acceptance 独立于进程 registry

Acceptance 校验持久化 caller input 和 lane state，而不是当前 model/tool registration。这避免 time-of-check/time-of-use 问题，允许在一个进程接受、另一个进程执行。

配置错误的 convenience prompt 最终由 drive 返回持久化失败 run；hosted acceptance 即使 execution worker 尚未加载实现，也应先持久化。

### 7. Invocation Context 保持显式

所有公开 harness/lane 操作的最后参数仍是 context: Context。acceptance、attachment、watch、Session read/commit、fault 和 event publication 都传递它。共享 harness/lane/Session 不保存 caller Context；context 及其 signal/telemetry 不属于持久化业务数据。

## 最终公开契约

~~~ts
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

export type OperationStatus = "running" | "open" | "aborting";

export interface OpenOperation {
  lane: string;
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
  aborting?: true;
}
~~~

open 每个持久化当前 operation 恰好一项，不包含 idle lane；aborting:true 只来自 durable cancel_requested。open 是 inventory，不是调度或 identity 建议。普通应用建立 watch 后调用 resume(context)，hosted scheduler 保留 expected-id drive fence。配置/捕获的 identity 是 durable string，不能解析。

### Outcome

删除 MissingIdentitySuspension、MissingIdentities、missing-identity drive waiting 和相关 suspension event。保留 provider 语义的 deferred suspension：

~~~ts
{ kind: "suspended", reason: "deferred", ... }
~~~

WP05 会在启用 execution 前删除撤回的 action outcome；convenience operation outcome 仍是 ResumeOutcome 的 operation-tagged branch。

### Snapshot

snapshot 的 operation 继续包含 id、kind、startedAt、status、action、retry、deferred、drained、streamingMessage 和 runningTools；runningTools 使用 toolCallId、toolName、args、可选 partialResult。配置不重复写入 snapshot；inspectExecution 暴露 model identity，getter 暴露当前配置。

## 原子 run acceptance

WP02 实现 prompt、skill、prompt-template 的 accept()；compaction/navigation 由各自 execution package 接受。

在 Lane.command(plan, context) 之前完成与状态无关的 normalization：prompt string/images、message 或 message array、skill/template 格式、pending assistant 拒绝、未知资源错误，以及 caller 提供或新生成的 operation/prompt-entry ID。

public prompt convenience overload 保持 [text, images | undefined, context] 和 [messageOrMessages, context]；其实现仍是 SliceNotImplemented，直到 R2。

一个 lane command 内：

1. 拒绝 busy；
2. 捕获当前 pendingNextRun IDs；
3. 读取并校验 pending message；
4. 拒绝零个已放置 message；
5. 在 request prompt 前设置 captured next-run entry 的 parent；
6. 只提交一次；
7. 发布小 projection；
8. 同步以 accepting Context 调用 emitBatch；
9. mutation callback 返回且不等待 delivery；
10. accept 等待 event delivery 后返回。

写入为：insert captured nextRun entries、insert request prompt entries、delete captured pendingEntry、set branchTip、set operationMeta、set operationState(run starting)、set laneState(current operation, pendingNextRun=[]）。事件顺序为 run_start，然后每个 message 的 message_start、message_end、entry_added，最后在捕获 nextRun 时发送 queue_update。Acceptance 不启动 drive/effect，也不写 Context。

## Phase A — 规范重写

先更新 harness.md：改为最小 projection restore、open inventory、未解析 identity inspection、Session-line ad hoc watch、commit continuation recipient binding；删除 identity preflight/suspension/error/event；定义 in-band model/tool unavailable、configuration provenance、detail-free synthetic tool result，并更新 invariant、race、roadmap、glossary 和 Appendix C。

停止评审包括 git diff --check、Terra contradiction/source-feasibility audit、完整上下文 Fable review；修复全部问题后重复，获得用户批准再进入 runtime source。

## Phase B — 实现

### Public/durable types

agent-harness.ts 删除旧 suspension/identity 类型和 branch，加入 ModelIdentity、OperationStatus、OpenOperation 及新的 inspection/snapshot 类型；create 结果从 suspended 改为 open；保留所有 trailing Context。

session types 增加 failure_drain provenance、ToolCall.outcome_ready、完整 content index 的 sourceIndex、callback-scoped scanBranch，并在 StorageBackedSession、mutator、MemorySessionFacade 实现。Session mutation authority 仍为进程内，不提供 remote Session facade。

### Event publication

HarnessEventBus.emitBatch() 同步 snapshot 普通 recipient 和 watcher；delivery 只使用该绑定列表；watcher buffer 保留 { event, context }。LaneCommand 的 post-commit event batch 同步保留，commit 成功后 Lane.command 发布 next、最终 mutation action 调用 emitBatch，再在 Session.mutate 外等待 delivery。直接 idle/pending append、lane config、session name/entry label setter 都走该路径。

WP04 还把 harness lane publication 放进 Session.createLane 的 committed-publication callback；Session commit 后发布 lanesByName 和 lane_created，再在释放 line 后等待 delivery。不要在线上执行 listener。

### Attachment、Inspection、Watch

restore.ts 保持 projection-only，校验 lane/operation ownership 和 kind，删除 describeSuspension 与 payload hydration。inspectExecution 是无写入 Lane.command，只从 durable phase 得到未解析 model identity。watch 在一个无写入 lane job 中同步注册 watcher、复制 live presentation、通过 callback-scoped reader 完成上面的有界读取、组装隔离 payload，必要 corruption 时 fault/unsubscribe，再释放 line；不要建立持久 hydration cache 或通用 reducer。

### 不在范围内

未完成部分的 drive、resume、prompt convenience、compaction/navigation acceptance、abort/queues、executeAction、runToCompletion 仍是 SliceNotImplemented。WP02 不增加 effect、active operation、timer、hook、provider request、tool execution、retry、deferred fetch、cancellation reconciliation 或 terminal transaction。

## 必需测试

### Public types

验证旧 suspension/identity 类型和状态不再存在；open/current/status 可穷举收窄；model identity 始终是未解析 string；action-required outcome 和方法签名、prompt overload tuple 正确；AgentHarnessOptions 没有 receiver telemetry default。

### Acceptance

覆盖 text、images、组合输入、数组、pending assistant 拒绝、skill/template、未知资源、空输入、无 registry preflight、caller/minted IDs、精确写入与 parent chain、starting state、pending-next-run capture/deletion、busy、并发 winner、commit/close race、精确 event order 和 object-identical Context。确认没有 hook/provider/tool/timer/drive-owner/option callback。

### Attachment/inspection

覆盖 idle omission、每个 open operation inventory、durable cancellation 的 aborting:true、create 不读 transcript/pending/frame/tool、model identity 不解析、projection corruption、无 effect start。

### Event publication/watch

验证 emitBatch 时绑定 recipient；publication 后才注册的 watcher 不收历史事件；publication 位于 Session-line release 之前。覆盖 direct append、lane config、name/label、acceptance、lane-created commit，watcher-first/publication-first，live update buffer，frame/checkpoint 排队，首次 watch 与 reconnect 同路径，精确 transcript/queue/drain/deferred/frame/tool args/checkpoint，corruption fault/unsubscribe，optional absence，context identity，payload isolation 和 close/fault lifecycle。

### In-band identity

验证 acceptance 没有 MissingIdentities 分支，configuration failure provenance 与稳定 code 可表示，deferred abandonment 归 R7，缺失工具的 ToolResultMessage 可不含 details，sourceIndex 是完整 content index，outcome_ready 不渲染为 running。

## 文件

新增 runtime2 accept test 和必要的 focused watch test。修改 harness 规范、agent-harness、events、session types/session/memory/remote、server remote manager、runtime2 harness/lane/restore/types 及相关测试。预期不改 backend schema、telemetry schema、coding-agent 或 changelog；若需要改动，应先停下做边界评审。

## 校验

Phase A 运行针对文档的 git diff --check。Phase B 在 packages/agent 运行 runtime2 accept、harness、lane、restore、types focused Vitest，回根目录后运行 git diff --check、npm run check、./test.sh。不要运行 npm test、完整 Vitest 或 npm run build，除非用户要求。

runtime2 source baseline 为 967 行；超过 1900 行应触发设计评审，而不是目标。

## 完成条件

acceptance 只提交一次并写入无 payload starting；attachment 返回最小完整 projection 和 open inventory；inspection 是一致的无写入 Session-line observation；watch 在 Session line 按需读取详细状态；commit continuation 完成 publication 和 recipient binding，mutation 不等待 delivery；snapshot/event 无 gap 或 duplicate；必需 payload corruption 由消费者 fault；不引入 execution effect/owner；focused tests、npm run check、全量测试和最终 Fable review 通过。不要开始第一个真实 drive package。
