# WP05 — 直接持久化 drive

**状态：WP05 已完成至 M10。** 已完成 lane-owned inbox、immutable result record、13 个 family-neutral leaf、原子边界规划、全量 cancellation/dispatch、公开及复制的 lane surface、文档对齐和 lane-safe provider cache identity。剩余 assistant-output 工作由 mobile assistant-output handoff 负责，不属于 public-drive gate。

WP06 的 Session/Branch/Lane separation 已作为基础。public drive 已启用，watchSession 是唯一 deferred Harness method。

Format 4 仍在开发中。本包中的 durable type 替换不需要 migration，也不为 redesign 前的 shape 增加兼容 decoder。原 standalone-compaction inbox/promotion 设计已撤回，见第 5 节；R1–R3、M7/M8 取代它。M9 已重新对齐 docs/harness.md。

## 0. 必读内容

实现前完整阅读 harness.md、runtime-simplification.md、session/types.ts、session/values.ts、runtime/lane.ts、runtime/types.ts、所有 runtime/drive/*.ts、progress.ts、restore.ts、execution/effect-gate、assistant、tools，以及相关 focused runtime tests。不要查看 Git history 或已删除 runtime 实现；当前 source 和这些文档是唯一实现输入。

## 1. 目标运行时模型

### Lane authority

Harness 持有 Session 时，Lane.state 是权威状态，包含 tip、lane config、lane-owned inbox、last operation ID、operation metadata 和含 control 的扁平 operation state。所有支持的 mutation 都在唯一 Session mutation line 上提交，并在释放 line 前发布匹配的 Lane.state。

Drive procedure 不从 storage 重新读取 laneState、operationMeta、operationState、branchTip、laneConfig 或 operationResult。SessionReader 只用于读取进程内状态命名的内容和枚举 operation-owned cleanup 地址，包括 tree entries、branch context、pending payload、assistant frames、tool args/checkpoints/memos、structural preparations、staged outcomes 和 cleanup prefix scan。

### R1：一个 lane-owned inbox

queued input 属于 lane，不属于 operation。LaneState 携带按 admission order 排列的 { entryId, kind }：

~~~ts
kind: "steer" | "followUp" | "nextRun" | "write"
~~~

enqueue 生成 entry ID 并写 pendingEntry；inbox 只保存 ID。生命周期是 admission → consumption 或 cancellation，terminal cleanup 不触碰 queue payload。

tag 只是消费资格标记，不能改变用户输入顺序。任何时机都可 enqueue：run、structural operation、cancellation 或 idle。各 drain point 按 tag 和 mode 选择，但统一按 global admission order 放入 inbox。acceptance 中 request prompt entries 排在选中 inbox items 之后。

| drain point | 规则 |
| --- | --- |
| idle acceptance | write、nextRun 全部可用；steer 按 steeringMode；followUp 按 followUpMode；先放选中的 inbox items，再放 request prompt；starting 不 drain |
| run 的 turn-end boundary | threshold/continuation planning 前处理 write、steer；followUp 仅在 may_finish、before_run_end 前处理；nextRun 在 run 中永不处理且不阻止 finish |
| idle direct append | 先按 admission order 放 queued write，再放新 entry，单事务完成 |
| abort | 移除 steer/followUp、删除 payload 并返回；nextRun/write 保留 |

R1b 规定“一次 decision 最多一次 commit”。boundary pass 可以为有界读取和 before_run_end mediation 多次进入 mutation line，但最多一次提交，且提交后的状态不会再次 drain/recheck（assistant.ready、summary.deciding、已放置 entries + assistant.ready 或 terminal transaction）。不再写回 checkpoint，因此删除 skipInboxOnce 和 thresholdCheckedTriggerEntryId。threshold marker 改由 branch 中最新 compaction entry 是否晚于 trigger entry 派生。

### R3：扁平状态

OperationState 使用一个 at discriminant 和 13 个直接 leaf：

~~~text
starting
checkpoint
assistant.ready
assistant.effect_pending
assistant.retry_wait
tools
deferred.suspended
deferred.effect_pending
summary.deciding
summary.ready
summary.effect_pending
summary.retry_wait
navigation.ready_to_commit
~~~

所有 leaf 使用统一 scope { control, settings, latestAssistantEntryId }，不存在 run/compaction/navigation 前缀或 per-family intersection。summary leaf 携带 SummaryTask，由闭合的 boundary union 决定结果边界。ToolBatch/ToolCall 仍是嵌套子状态机，Control 独立存在，并在 M7 drain-and-return abort 后去除 drained fields。

### R2：持久化 operation result

每个 terminal transaction 在 pi.result / operation ID 写入一个小型 immutable result record。该 record 属于 lane 生命周期；LaneState.lastOperationId 指向最新 record，删除 laneLastResult。drive(id) 对已结算 operation 变为 total：当前 ID 执行 install/join，record 存在则直接返回 record，两者都没有才返回 OperationMismatch。

recovery 和 attachment 不读取 result record。若 terminal transaction 在 durable cancel_requested 下执行，必须记录 status: "aborted"；其他 status 意味着 terminal control 仍为 running。没有 listing/filter/pagination/retention API，也没有 hydration layer；getResult 和 drive settled arm 是完整读取面。

### 一个 lane-owned Drive

保持每 lane 一个进程内 Drive pass；第一个匹配 caller 安装，后续 caller join 同一完成结果。安装后没有 caller ownership，invocation cancellation 只拒绝该 caller 的 observation。requestAbort(operationId) 是唯一持久化取消入口，旧 operation ID 返回 OperationMismatch。Drive.context 不保存安装方 signal。

### Close 与禁止外部 finalization

close 不是 abort：封闭 mutation admission、以 HarnessClosed 拒绝本地 observation、观察 detached pass failure、排空 seal 前已接纳的 mutation，再关闭 Session。不写 cancellation marker 或 synthetic terminal state，也不替换 Drive。不存在 live-process external finalization、OperationEnded、finalizedOutcome 或 ownership-loss result。

## 2. Procedure 形状

live procedure 是直线式 async function：

~~~text
prepare
→ commit intent
→ admit and await effect
→ commit settlement
~~~

procedure 是修改顶层 at leaf 的唯一 writer；requestAbort 只改 control 和 lane inbox；inbox admission 只改 inbox。terminal decision 的通用后缀是：procedure cleanup/publication writes、setValue(operationResult)、写 idle laneState（currentOperationId=null、lastOperationId=operationId、保留 inbox）、发布 idle projection、materialize terminal result/event。

state argument 是 dispatcher control flow 提供的 type capability，不在每次转换时与当前状态运行时比较。

## 3. 保留的并发检查

只保留其他 writer 可能改变事实的检查：

1. requestAbort 与 effect admission/settlement；
2. boundary、summary result boundary、terminal finish 前的 inbox 到达；
3. parallel tool status 和 source-ready placement；
4. queued frame/checkpoint write 与 settlement；
5. invocation memo/checkpoint 与 effect completion；
6. retry timer 与 cancellation/close；
7. deferred permit consumption；
8. accept/claim serialization；
9. external/provider/content validation。

不要把 operation identity、expected-at、exact-Drive 或 ownership-loss check 重新加回普通 transition。requestAbort 继续先 beginAbort，再提交 cancel_requested，commit 后 signalAbort。

## 4. 已完成里程碑

M0 已撤回 execution-step controls（breakpoint、manual drive、drive deadline）。M1–M2 完成 effect gate、确定性 gated storage、权威 Lane projection、progress channel、terminal cleanup 和 immutable result observation。M3 完成 assistant generation/recovery、frame persistence、configuration failure、unknown-outcome recovery 与 response/usage/state 原子性。M4 完成 retry、deferred poll permit、unknown-poll replacement 和 stream-preserving Models.streamDeferred。M5 完成 durable tools、safe replay、unsafe interruption、memo、checkpoint、completion-order staging/source-order placement、sequential/parallel 和 usage。Pre-M6 完成 flat at、continueOperation/settleOperation 以及 M3–M5 procedure 转换。M6 已提交 structural foundation；其 family cross-product 在 R3 重建，但 effect seam、preparation、threshold/overflow 和 navigation commit 保留。

## 5. 已撤回的 standalone-compaction promotion

曾经让 compaction leaf 拥有 RunScope inbox，并在 result boundary 跨 family 移入 run 的设计已撤回。问题包括松动 intent/state invariant、compact() 返回不适配 CompactionResult 的 run outcome、run_start bracket 不平衡、cancelQueued 遗留，以及 reconciliation/cleanup/watch/admission 的 promotion 分支。

替代方案是：所有操作期间的 queued input 都归 lane-owned；standalone compaction/navigation 的 continuation 是 convenience layer 组合出的第二个普通 run operation，使用新 ID；每个 operation 只返回一个 durable result record。没有代码实现 promotion，本节仅保留为历史决策。

## 6. R1：lane-owned tagged inbox

R1a 将 pendingNextRun 替换为 LaneState.inbox，删除 Inbox 和 RunScope.inbox，但在 M7 前暂时保留 Control.drained、skipInboxOnce 和 thresholdCheckedTriggerEntryId。lane.ts 在 acceptance 和 idle append 中按 tag 选择并保持 admission order；checkpoint.ts 暂时按 lane inbox 做 stepwise drain；各 procedure 的 scope copy 不再携带 inbox，避免 operation transition 覆盖并发输入。

R1b 在 R3 后落地共享 boundary planner。checkpoint pass 使用 threshold:"check"，依次选择 write/steer、threshold guard、continuation、may_finish followUp、before_run_end 和 finish；resume_checkpoint result boundary 使用 threshold:"skip"，在 publication commit 中依次写 compaction entry、selected items 和 continuation。没有 eligible item 时直接进入 assistant.ready 或保留 checkpoint{may_finish}，从不把 boundary decision commit 回 checkpoint。

before_run_end 不在线上执行 hook：先在线判断且不提交，再在线下运行 hook，最后基于当前状态 replanning；若 inbox/control 已变化则丢弃旧 hook 结果，否则一次提交 follow-up 或 terminal transaction。

## 7. R2：中立 operation outcome 与 durable result

目标是让 terminal result 独立于 operation family。新增 operationResult record、lastOperationId 和 record-based drive/getResult；所有 terminal path 使用统一后缀和 terminal-control invariant。没有结果列表或 retention 机制，观察不需要读取 entry。

## 8. R3：family-neutral leaf 与 structural rebuild

将 family-specific graph 重建为上面的 13 个 leaf。run、compaction、navigation 通过 SummaryTask/ResultBoundary 表示边界；reachability 由 intent 与 leaf/boundary 校验，而不是旧的 intent-prefix check。run 允许 starting、checkpoint、assistant.*、tools、deferred.*、summary.*(resume_checkpoint)；compaction 允许 summary.*(finish)；navigation 允许 navigation.ready_to_commit 和 summary.*(commit_navigation)。

## 9. M7：取消 reconciliation 与 total switch

requestOperationAbort 只设置 durable cancel_requested，并让 procedure 在下一个支持边界进入 reconciliation。reconciliation 不开始新的普通工作；必须处理 assistant/deferred effect、各类 ToolCall、structural local result、取消中的 summary boundary、retry/checkpoint/deferred、best-effort deferred cancellation 和 aborted terminal transaction。queued lane inbox 不由 reconciliation 应用或删除，nextRun/write 继续保留。

runtime/drive.ts 维护一个直接的 state.at 13-way switch，只导入完整 procedure module，不使用 graph table、action interpreter、ownership-loss 或 storage reload。所有 continue 结果都必须替换 Lane.state，或看到 cancel_requested 并路由到 reconciliation，否则是 invariant defect。

## 10. M8：公开 surface

已完成。执行 guard 只有在所有 leaf/reconciliation path total 后移除。顺序是接受 compaction/navigation、实现 drive install/join/record lookup、暴露 requestAbort、增加 convenience composition、queues/config/usage/idle surface，最后只保留 watchSession 为 SliceNotImplemented。

steer/followUp/nextRun 是一个 enqueue 的 tag sugar，始终接受；queue_update 和 LaneSnapshot.queues 暴露同一有序 inbox。远程 client 只能由 LaneSnapshot 加 event stream 渲染。导出 reduceLaneSnapshot；in-run compaction segment 不清空 operation，run_suspend 保留 operation，navigation_end 返回 { rebase:true }，WatchHandle.resnapshot 用同一 mutation line 获取新 snapshot。

snapshot 增加 configuration、lastResult、真实 faulted 和 stats；config_update 携带 value/previous，tools/resources 仍只是通知；setModel 接受 ModelIdentity。run/compaction/navigation start event 携带 startedAt。

Convenience composition 为 accept + drive；compact/navigateTree 结算后若有 eligible queued input，则以公开空 prompt 接受普通 run B，再 drive B，返回 A 与可选 B。aborted 后不 continuation。resume 是 inspect + drive + deferred poll；abort 是 inspect + requestAbort + reconciliation，并返回 drain 的 steer/followUp payload。所有 convenience 必须等价于公开 primitive composition。

## 11. M9：文档对齐

harness.md 已重新成为独立规范。对齐内容包括 pi.result 与 LaneState.inbox/lastOperationId、JSONL/SQLite growth tradeoff、precise rewrite policy、13 leaf、ResultBoundary、acceptance tag mode、one-decision-one-commit boundary、lane inbox、terminal result record、abort drain-and-return、queue_update、Part 9 invariants、术语表和 reduceLaneSnapshot。runtime-simplification.md 也需移除剩余 promotion 引用。生产源码中的 withdrawn symbols 应通过 rg gate 清零。

## 12. M10：Provider KV-cache identity review

Session identity 不能直接作为 provider cache lineage，因为同一 Session 的多个 lane 可能并发请求不同 transcript。普通 assistant request 使用 Session metadata id + ":" + lane name 派生的 lane identity；同 lane 的 turn/retry 复用，不同 lane 不共享。compaction/navigation/branch replacement/model change 允许安全 miss，不增加轮换机制。structural summary 继续使用 fresh identity 和 cacheRetention:"none"；deferred polling 不发送 cache identity。cache identity 与 telemetry correlation 分开处理。

验证包括同 Session 的并发 lane 使用不同 provider identity、同 lane 稳定复用、prefix discontinuity 安全 miss、retry 保持 lane identity、structural request 隔离和 faux-provider 测试。

## 13. Mobile assistant-output handoff

这是后续跟踪项，不属于 M8/M10 public-drive gate。短的 mini coding-agent Session 可能因大量 pi.pending.assistant_frame append 产生约 300 KB JSONL。后续 handoff 处理 Chord op tracking、scoped pending-output durability、tool/assistant output reduction 和 message_update replication amplification，同时保留 crash contract：已接受 effect 可重建、进度可观察、结算时回收 operation-owned pending state。

## 14. 模块边界

~~~text
session/**             durable storage，不导入 runtime
execution/**           provider/tool/gate 中立机制
runtime/types.ts       LaneState、Drive、command decision
runtime/progress.ts    frame/tool progress channel
runtime/drive/*.ts     直接 procedure
runtime/drive.ts       13-way flat switch
runtime/lane.ts        Lane actor 与公开 surface
runtime/harness.ts     Harness lifecycle 与 Lane composition
~~~

procedure module 只 type-only import 具体 Lane<TContext>。TContext 保持 object | undefined invariant；不得使用 any、as unknown as、@ts-expect-error、inline import、parameter property、enum 或其他不可擦除 TypeScript 语法。

## 15. 排除项

不引入 generic scheduler/graph/action interpreter/effect-plan DSL、per-family outcome union、result listing/filter/pagination/retention、operation-owned queue、drained control、terminal queue cleanup、drive 以下的自动 continuation、第二条 mutation line、expected-at runtime check、Drive replacement、external finalization、authoritative control storage reread、read cache/budget/generic batching、旧 durable shape 兼容 alias、structural event 的 phase 字段，以及 whole-tree/fork/repository 方法到 AgentLane。procedure-specific write、effect admission、settlement classification 和 event construction 必须保留在调用点。

## 16. 校验与评审

每个代码阶段运行 npm run check，并从所属 package 运行修改过的 focused tests；最终需要 ./test.sh。不要直接运行完整 Vitest。R3、R1b、M7、M10 和最终完成都必须进行 review，delegated review 使用 provider anthropic、model claude-fable-5。

完成条件：每个 flat leaf 可 drive/reconcile；primitive 与 convenience（含 continuation）等价；focused/backend conformance 通过；public drive 无 partial graph；watchSession 是唯一 deferred public method；drive(id) 能回答所有 settled operation；harness.md 与实现一致；provider identity 对并发 lane 安全；最终 review 无 blocker。
