# WP06 — Session、Branch、Lane 分离

**状态：在 WP05 M4 之前已实现。** WP05 M3 保持完成；retry/deferred 工作在这里建立的 composition、mutation 和 ownership 边界上继续。

本包用四个明确概念替代混杂的 SessionTree/隐式 main 继承：

~~~text
Session       全局持久化数据 + 一条 mutation line
Branch        entry tree 中的一条路径，可移动 tip
AgentLane     Branch 数据面 + agent 操作/配置
AgentHarness  AgentLane 管理器，本身不是 lane
~~~

## 0. 必读内容

完整阅读 harness.md、WP05、session types/session/memory、JSONL repo/storage、SQLite session/storage/repo、runtime lane/harness/restore/types、agent-harness、session fork、repository conformance，以及第 8 节列出的全部测试。不要查看删除的 runtime 实现或 Git history；当前 source、harness.md、WP05 和本包是唯一依据。

## 1. 问题

### 1.1 SessionTree 混合不相关的 ownership

SessionTree 同时包含 lane/path 数据和 session-global 数据：Branch tip/entry query/append 与 getEntry、stats、全局 find、value/list、name/label 等。选择不同 tree view 只改变 global write 进入的 mutation queue，不改变 durable address，因此两个 view 可能在不同 lane line 上读取同一值并产生 lost update。

### 1.2 Session 默认为 main

Session extends SessionTree，继承的 branch 方法和高层写入隐式委托给 main；session.setValue 实际是 setValueForLane("main")。新 repository session 在 harness 存在前还会创建部分 implicit main lane。

### 1.3 AgentHarness 默认为 main

AgentHarness extends AgentLane，runtime Harness 也 extends Lane；manager 被放入自己的 lane map，名称为 main。harness.prompt、watch、getModel 等调用隐式针对 main。

### 1.4 Per-lane mutation queue 没有解决当前问题

Storage 已经串行化原子 commit，并按 session 全局 seq 排序。per-lane queue 可以让 preparation 重叠，但当前 runtime 的 mutation callback 只做有界读取、准备一个 write set、最多提交一次、发布进程状态并返回；provider、tool、hook、timer 和异步 event delivery 都在线外。因此第一版使用一条 Session mutation line。只有 profiling 证明全局 line 是瓶颈后，才考虑 keyed line，并需重新审计 mutable ownership，但不需重设计公开 API。

## 2. 术语与 ownership

### Session

拥有 session metadata、全局 entry/usage query、应用 values/lists、session name/entry labels、Branch discovery/creation、一条处理所有支持 mutation 的进程内 line，以及一个 storage/backend lifecycle。Session 不实现 Branch，也没有 implicit branch。

### Branch

表示 immutable entry tree 中一条命名路径的数据能力，只拥有 current tip、branch-relative entry query 和直接扩展 tip 的 message/custom entry。Branch 没有 model config、queue、operation state、drive、hook 或 agent policy。

### AgentLane

一个 Branch 加 agent config/operation。直接暴露 Branch 方法，不暴露嵌套 Branch/tree/store/view。idle 时 append 直接扩展 tip；active run 时保留 deferred-write 语义：预留 entry ID、持久化 pendingEntry、将 ID 放入 operation inbox。原始 Branch append 始终是直接 data append；Harness 持有对应 lane 时，原始 Branch mutation 属于受信任代码缺陷。

### AgentHarness

拥有 global registry/config、hooks、events、lifecycle 和 AgentLane map。它不是 AgentLane，不提供 implicit-main operation method。

## 3. 目标公开类型

### 3.1 Session reader 与 mutation

SessionReader 提供 getEntries、typed getValue、scanValues、readList 和 scanBranch。SessionMutation extends reader，提供一次 commit(writes, context) 和 end(context)。commit 恰好允许零次或一次，第二次（包括首次失败后）拒绝；end 等待已接受的 commit、使 capability 失效并释放 line。SessionMutator 是去掉 end 的类型，mutate callback 接收 mutator 和 context。

beginMutation/end 是当前 remote Session protocol 使用的可传输 scope，不带 lane field；本地/harness 代码通常使用 mutate，不选择 mutation key。

### 3.2 Branch

Branch 接口包含 name、getTipId、findEntries、findEntry、appendMessage、appendCustomEntry。receiver 已经是 Branch，所以不再使用 findEntriesOnBranch 等冗余名称。

### 3.3 Session

Session extends SessionReader，拥有 metadata、idGenerator、直接 global reads、name/label、branch(name)、createBranch(name, at)、keyless beginMutation、mutate、基于 mutate 的 set/delete value/list、name/label setters 和 close。mutate 是受信任 sharp edge：plugin 不能保存 mutator、嵌套 public writer、执行 effect 或长时间持有 line；beginMutation 的直接调用必须在 finally 中 end。

### 3.4 AgentLane

AgentLane 直接增加 getTipId、findEntries、findEntry、appendMessage、appendCustomEntry，同时保留 getLastResult、accept、drive、requestAbort、inspectExecution 和原有 queue/config/idle/watch 方法。删除 AgentLane.sessionTree。

### 3.5 AgentHarness

AgentHarness 提供 lane(name, context)、lane(name, options, context)、lanes、global name/label wrapper 及原有全局 tools/resources/options/settings/hooks/events/watchSession/close。lane 是原子 get-or-create；已有 lane 忽略 createAt，缺失 lane 使用 createAt ?? null。并发 acquisition 返回同一个已发布 AgentLane。新 Session/Harness 没有 implicit main，await harness.lane("main", context) 才创建 main，lanes() 可以返回空数组。

## 4. Mutation 与 read 语义

### 4.1 一条 Session mutation line

用单个 MutationLine 替代 LaneMutationLine：

~~~ts
export class MutationLine {
  private tail: Promise<void> = Promise.resolve();
  private sealedError: Error | undefined;

  run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult>;
  seal(error: Error): Promise<void>;
}
~~~

StorageBackedSession.beginMutation 获取 line 并返回 keyless capability，只有 end 释放；mutate 基于 begin/end 并在 finally 结束。callback 可以读取、准备、提交一次、发布 process-local state、同步绑定 event recipient 后返回。close seal admission，并等待已取得的 scope end 后关闭 Storage。高层 Session write、Branch create/append、Lane.command、progress write、coherent restore snapshot 和 Harness lane acquisition 全部使用 Session.mutate。

### 4.2 Read 绕过 line

普通 Session/Branch read 直接调用 Storage，并看到每次 read 执行时最新完整提交：

- 排队/规划中的 mutation 不可见；
- 多写 commit 不会部分可见；
- Storage commit resolve 后，即使 callback 仍在发布 process state，direct read 也可以看到它；
- 多次 line 外读取不是 snapshot；
- read-decide-write/CAS 必须使用 mutate。

### 4.3 Effect 在线外

mutation callback 不得执行或等待 provider/deferred fetch/cancel、tool、hook、timer、异步 event delivery、idle callback、Drive completion 或嵌套 mutator。callback 只能在 publication 后同步调用 emitBatch 来绑定 recipient；公开 operation 在 mutate 返回后等待 delivery。

### 4.4 Storage 仍独立保持原子性

Storage 保留单 Session commit serializer，并为每个 write 分配全局 seq。Session line 保护 read-decide-commit-publication；Storage queue 保护事务应用、序号、fork snapshot 和后端 caller。两者不能合并。

## 5. Branch 与 lane 的持久化形状

### 5.1 没有 implicit main

repository create 只写 session metadata/header/catalog，不写 branch tip、lane config 或 lane state。删除 Memory/JSONL create 和 SQLite init 中的 main seed。legacy coding-agent v3 normalization 可以因为导入 transcript 有选定路径而产生 main Branch。

### 5.2 Branch 完整性

Branch 存在的唯一条件是 required tip value 存在。createBranch 校验 name、absence 和非 null target，然后在一次 mutation 写入 tip，不写 model config 或 operation state。

统一使用 branchTip/tipId，persisted namespace 使用 pi.branch.tip。format 4 和新 harness 是 WIP，应原地替换 leaf/lane 字段，不增加 version、migration、compat decoder 或旧格式拒绝。legacy v3 import 仍支持：把选定 main leaf 映射为 main Branch tip，并只沿选定 ancestry 分别重建最近 model_change、thinking_level_change、active_tools_change；不支持的最近值不回退到更旧历史。

若能重建完整配置，导入器先写 laneConfig("main") 与 fresh idle laneState("main")；v3 没有持久化初始工具清单，因此缺失 active-tools history 归一化为 []。model/thinking 必需配置缺失或不支持时，只返回 data-only main Branch。更新 legacy active-tools record 以读取 encoded activeToolNames array，并同步 public tipId protocol/adapters。

### 5.3 AgentLane 完整性

AgentLane 在既有 Branch 上增加完整 laneConfig、laneState、可选 laneLastResult 和可选 current operation。harness.lane 在一次 Session mutation 中按以下情况处理：

| 持久状态 | 结果 |
| --- | --- |
| Branch 和 lane value 都不存在 | 校验 createAt，提交 Branch tip、不可变 seed config、idle lane state，发布一个 AgentLane 与 lane_created |
| Branch 存在，config/state 缺失且没有 last result | 在既有 tip 提交 seed config 和 idle state，发布 AgentLane 与 lane_created |
| Branch 和完整 lane values 都存在 | 返回 restored/published AgentLane，不 commit、不发 event |
| 任意部分或矛盾组合 | 作为 storage corruption fault |

commit callback 在离开 mutate 前把新 Branch/AgentLane 放入 process map，并同步 emitBatch(lane_created, context)；释放 line 后等待 delivery。AgentHarness.create 恢复完整 lane/open operation，但不创建 main。data-only Branch 直到显式 attach 才增加 agent state。

### 5.4 Append

Branch.appendMessage/appendCustomEntry 始终在一个事务中创建以当前 tip 为 parent 的 immutable entry 并移动 tip。AgentLane idle 时立即 append；active run 时 stage pendingEntry 并 enqueue inbox.writes；active structural operation 保留既有 wait/re-evaluate；pending assistant append 在 commit 前拒绝。两者都返回预留的 entry ID。

## 6. Runtime composition

### 6.1 Harness

用 composition 替代 inheritance。Harness 持有 session、models、hooks、events 和 lanesByName，不调用 super("main")，也不把自身放进 lanesByName。restore 后每个 Lane 都是普通对象；fault/close 遍历普通 Lane；global getter/setter 只在 Harness。coding-agent service/worker 必须显式获取并缓存 main。

### 6.2 Lane

Lane.command 和 commandDriveOwned 调用 keyless session.mutate；live Lane.state 是权威 process projection，exact Drive fence 保持在 commit admission 附近。Lane 直接实现 Branch query/append 名称，内部可以有 package-private Branch implementation，但不公开嵌套 Branch。

### 6.3 Restore

Restore 不再进入 named mutation line。AgentHarness.create 拥有 attachment interval，通过一次有界 keyless mutate callback 盘点/恢复完整 AgentLane 后发布 Harness；只有 attachment normalization 明确需要时才 commit。coherent watch/inspection 也使用无 commit 的 mutate。缺失 main 合法，data-only Branch 与完整 AgentLane 分开盘点。

## 7. Repository、backend 与 fork 要求

Memory/JSONL/SQLite 的 Session facade 删除 lane argument/field，保留 keyless beginMutation/end 转发、Branch acquisition/creation、line 外 direct read 和不变的 Storage commit sequencing。SQLite 与未来 SQL backend 仍由 Storage 串行化分配 seq 的 commit；不同 Session 仍可并发。

Fork 要保持一个 coherent source Storage snapshot，并将 leaf 改称 Branch tip：

- branch scope 创建 destination Branch main；
- 未指定 source entry 时要求 source main，否则拒绝；
- source main 是完整 AgentLane 时，复制 config 并与 fresh idle state 一起写入；data-only source 只产生 data-only destination；
- tree scope 复制每个 Branch tip；完整 AgentLane 复制 config + fresh idle state，data-only 保持 data-only；
- operation/pending/last result/usage 排除；
- destination 不获得无关 implicit main；
- 保留显式 keyless begin/commit/end fork-ordering seam，在开始 snapshot 前先提交必须提交的 mutation，Storage 将 source snapshot 与 commit 排队以选择一致边界。

## 8. 实现阶段与文件清单

### Phase A — Session mutation 与 Branch

将 lane-mutations.ts 改为 mutation-line.ts。修改 session types/session/memory、JSONL repo/legacy-v3、SQLite session/repo、fork、exports、storage/repository benchmark 和 conformance。用 Branch、keyless mutate、tipId、pi.branch.tip，移除 SessionTree 和 implicit main。将 session-tree.test.ts 改为 branch.test.ts，将 session-create-lane.test.ts 改为 session-create-branch.test.ts，并更新其余 storage/SQLite/compaction 测试。

### Phase B — Harness/Lane composition

修改 agent-harness、runtime harness/lane/restore/types、session values/durable types、已有 drive module 中的名称签名、branch summarization、protocol、coding-agent experimental service/worker 及测试。所有使用 keyed mutate、implicit Harness-as-main、sessionTree、leafId、createLane 的 runtime helper 都要更新。Phase A/B 必须作为一次原子 landing，不增加临时 alias。

### Phase C — 规范文档

完整更新 harness.md：orientation、bound Branch tip、Branch/Session/fork/repository、tipId、唯一 mutation line、无 main attachment、各 public surface、event ordering、work package、invariant、race、backend conformance 和 glossary。同步更新 WP05、assistant/tool durability、values、telemetry、plugins、extensions 等当前文档，删除 SessionTree 和旧 ordering。remote Session 仍使用 keyless begin → local callback/remote read/one commit → publication → end RPC；server 持有 line 到 end acknowledgment，disconnect/timeout 按现有 hosting policy 终止 scope。released changelog 不改，非 main/PR 不加 changelog。

## 9. 必需测试

### Session mutation line

验证不同 AgentLane 的 mutate 全局串行、后一个 callback 等前一个完成 publication、direct read 不等待未 commit callback、完整 commit 不部分可见、两个 read-modify-write 得到 1/2、分离 get/set 仍非原子、零 commit 合法。验证 keyless begin 在 end 前阻塞其他 mutation、commit 不释放、无 commit end 合法、重复 end 幂等、close 等待 end、RemoteSession 保持相同 scope、第二次 commit 拒绝、嵌套写入按约定拒绝、close race、seq/stats 不变。

### Session 与 Branch

新 Session 没有 Branch 和 main tip；format 4 无 version/migration/compat decoder；v3 import 对完整/不完整/非法/branched history 正确。验证 branch read/create、duplicate race、tip query/cursor、直接 append、absent custom data、pending assistant 拒绝、全局 values/lists/name/labels 不依赖 branch、close 后 Branch 失效、branch/tree fork 的 config/idle/data-only 规则，以及 begin/commit/end 对 fork boundary 的顺序。

### AgentHarness 与 AgentLane

验证 Harness 无 AgentLane method、Session 无 Branch method、AgentLane 直接提供 Branch method 且无 sessionTree、fresh lanes 为空、lane("main") 原子创建、createAt、data-only attach、已有完整 lane 不 commit、不发 event、并发 acquisition 只发一个 lane_created、publication 在 release 前完成、invalid name/anchor 不写入、restore 不创建 main、partial state fault、global wrapper event ordering、idle/active append 和 close/fault。

### Regression

保留 M2 exact-Drive ABA fence、M3 generation/frame/settlement write 形状（仅名称变化）、frame FIFO、watch 两种顺序、跨 lane usage totals、trailing/source-identical Context，以及 Memory/JSONL/SQLite conformance。

## 10. 排除项

不增加 keyed mutation line、任意 lock name、resource lock、多锁排序、版本/optimistic retry、scheduler/transaction framework/action interpreter、AgentLane 嵌套 Branch/tree/store/access、SessionTree/view/implicit main/Harness method/createLane 兼容 alias、named remote scope、mutation 内 effect、第二套 Storage commit/seq、create 自动启动工作或 WP05 M8 之前的 public drive。

不改 provider/tool 行为、durable execution phase、retry/deferred policy 或 assistant frame 语义，除非是本包所需的名称/签名传播。

## 11. 校验

运行每个修改的 focused test，然后 git diff --check、npm run check、./test.sh。使用 rg 检查 SessionTree、sessionTree、LaneMutationLine、extends AgentLane、extends Lane、keyed mutate 等旧概念只剩历史说明或明确负向测试。完整实现和规范文档需在 commit 前通过 Fable review；未经用户明确同意不提交。

## 12. 完成条件

Session 只有一条 keyless mutation line，callback mutate 与 remote begin/commit/end 共用它且都不接受 lane key；direct read 绕过 line；SessionTree 和 implicit main 消失；Branch 成为纯数据路径/tip；AgentLane 直接提供 Branch 方法并保留 operation-aware append；AgentHarness 只使用 composition 且原子 get/create lane；fresh Session/Harness 不要求 main；publication/event binding 边界正确；三后端和 race test 通过；harness.md/WP05 一致；Fable 无 findings；之后可恢复 WP05 M4。
