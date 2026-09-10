# WP05 之后的路线图审计

**审计基线：** `5507d76ee`（`dev`，2026-08-27）。

**状态：** 规划清单，不是行为契约。在与当前产品边界一致的地方，[`harness.md`](harness.md) 仍是规范文档。下面列出的矛盾必须显式解决；本文不会默默选择其中一方。

## 范围和方法

本审计覆盖持久化 AgentHarness，以及与其直接耦合的 Session backend 和 presentation 路径：

- `packages/agent/src/harness`、`packages/agent/src/search` 及其测试/文档；
- `packages/session-backends/sqlite-node`；
- 当前 `packages/protocol`、`packages/client` 和 `packages/server` presentation 路径；
- 承载该路径的 `packages/coding-agent/src/experimental` 及其聚焦测试；
- `packages/telemetry`、`packages/ai` 和 `packages/agent` 中的 telemetry plumbing。

清单已对照当前源码、测试、包 README、完整 `harness.md`、已完成的 WP00–WP07 状态、可执行的 WP08 handoff、显式 stub/TODO/skip 以及已交付的包边界进行检查。当当前源码和已完成的 WP05 契约已经取代历史 handoff 时，不把历史 handoff 当作 backlog。

## 执行摘要

WP05 已完成到 M10。剩余 assistant-output 工作由 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) 及其编号前置条件负责。当前 Harness 执行图没有未完成的运行时路径：`watchSession()` 是唯一的 `SliceNotImplemented` Harness 方法。

这**不**意味着周边的持久系统已经完成。剩余审计发现包括：

1. 规范定义了 JSONL snapshot compaction，但没有实现；
2. 一个必需的 Harness 方法 stub（`watchSession`）；
3. 有意移除 raw `RemoteSession`，但与后续规范 WP06/`harness.md` 文本冲突；
4. 公开 search 类型骨架与较新的 search 设计冲突，且没有实现；
5. 完整的 telemetry 词汇中，生产环境唯一的 span 是 tool-hook span；
6. 较小的 repository、client-watch、query-bound、文档和端到端测试缺口。

WP07 在审计基线之后完成了 SQLite host-ownership 对齐和 live-source fork 支持，其历史 handoff 是 [`work-packages/07-sqlite-host-ownership-live-forks.md`](work-packages/07-sqlite-host-ownership-live-forks.md)。WP08 现在负责独立的 named-branch、tree-state 和有界内存 fork 重设计；其可执行 handoff 是 [`work-packages/08-named-branch-streaming-forks.md`](work-packages/08-named-branch-streaming-forks.md)。

## 必需缺失功能和契约矛盾

### R12——Session 级 Harness watch

**证据**

- `AgentHarness.watchSession(context)` 在 `src/harness/agent-harness.ts` 中是公开方法；
- `Harness.watchSession()` 在 `src/harness/runtime/harness.ts` 中抛出 `SliceNotImplemented("watchSession")`；
- `SessionSnapshot` 当前只包含 `{ lanes: LaneInfo[]; faulted: boolean }`；
- `src/harness/events.ts` 和 `src/harness/runtime/lane.ts` 已存在 lane watch、事件缓冲、delivery-tail barrier 和 `resnapshot()`。

**剩余边界**

为动态 lane 目录和故障状态定义一个一致的 capture/fold。决定刻意精简的 `SessionSnapshot` 是否保持精简，还是增加 session metadata/stats/global configuration。然后实现 snapshot-before-events、lane 创建、resnapshot、listener 重入、close/fault 行为；如果承诺只通过事件复制，则还要实现 session reducer。

**依赖**

独立于 mobile assistant-output handoff 和 SQLite 内部实现。任何基于它构建的 revisioned Transcript service 或远程 Session 级 observation 都应在其之后进行。

### JSONL snapshot compaction

**证据**

`harness.md` §1.7 规范性地规定了临时文件加 rename 的 snapshot compaction、保留 sequence high-water mark/list cursor、打开时阈值检查，以及终端/outcome 删除后的回收。`JsonlStorage` 已实现原子创建、撕裂尾部修复、legacy-v3 重写、追加和 fork snapshot，但没有当前状态 snapshot 重写或 dead-byte 统计。

**后果**

被取代的 `pi.op.state`、已删除的 pending payload、已删除的 tool checkpoint 和已删除的 assistant-frame list 会永久保留为物理字节。通用 compaction 和 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md) 是互补的：compaction 事后回收已经过时的 session 作用域写历史；handoff 将 pending assistant/tool output 移入临时作用域，使其不会成为主日志历史，并将完整/逐帧复制替换为 Chord op batch。

**依赖**

Assistant-output handoff 不依赖 J1：作用域存储是 pending output 的预期生命周期机制，J1 仍是回收已被取代 session-scoped state 的机制。应分别测量二者，避免混淆影响。

### Remote Session 契约矛盾——需要决策

**当前产品边界**

Commit `f8a6e670d` 有意删除了 `RemoteSession`、raw Session RPC protocol 和 server mutation-scope manager，改为 attachment-fenced 的语义服务路由。当前 protocol/server README 明确写明，真实的 `Session` 和 `AgentHarness` 对象仍是进程本地的。已交付路径支持 Session 发现/创建/附着、main-lane prompt/watch 和 allowlisted plugin-service call；不通过 RPC 暴露 `Session`、`SessionMutation`、values/lists、branches 或 storage。

**冲突契约**

该删除之后编写的 WP06 要求“当前无 key 的 RemoteSession mutation transport”，并把 remote begin/read/commit/publication/end 列为必需测试和停止条件，还禁止删除它。`harness.md` §§2.8 和 9.1 同样声称本地和远程实现保留该生命周期。在审计基线中，没有这种实现、protocol schema、client facade、server-held scope、worker adapter 或一致性测试。

**必需决策**

在安排实现之前二选一：

1. **Session 保持进程本地：** 从规范当前状态文档中移除虚假的 RemoteSession 要求，同时保留语义 service RPC；或
2. **需要 RemoteSession：** 委托一个专门包，实现 mutation begin/read/commit/end、disconnect/timeout 清理、publication-before-end、values/lists/branches/entries/stats、protocol validation、client/server/worker adapter 和远程一致性。

不要把当前 lane-watch 兼容 RPC 或 plugin-service RPC 计为 RemoteSession。不要原样恢复已删除的 507 行 facade：它早于无 key 的 Session/Branch 契约，并严重依赖无类型解码。

### Telemetry 契约超过实现

**证据**

`src/harness/telemetry.ts` 和生成的 `docs/telemetry-schema.md` 声明了 `pi.ai.request`、operation、checkpoint、turn、step、tool、hook、sleep、event-handler 和 session-write span。生产源码只启动 `pi.harness.hook`，且只针对已注册的 `before_tool`/`after_tool` handler。AI options 会传播 `telemetryContext`，但没有 provider 路径启动 `pi.ai.request`。Server request ingress 有取消，但没有 trace carrier 或 client/server RPC span。`TODO_CONTEXT` 仍存在于 transport/worker 生命周期和事件交付边界。

**剩余边界**

将其作为独立的包处理：

1. 本地 Harness/Session/AI instrumentation 和运行时测试；
2. RPC trace-carrier/client/server 传播；
3. 可选的由应用选择的 exporter/adapter。

首先重新确认是否仍然需要每个声明的 span。如果保留，就实现它；如果不保留，就移除不受支持的公开 schema surface，并修正 `harness.md`。不要把 telemetry 与 Context/RPC 取消混在一起，后者已经有独立的 request-ID signaling。

### S3——Search

**证据**

`src/search/index.ts` 导出公开的 `SessionSearchService` 骨架，包含 `sync()`、`notify()` 和返回数组的 `searchEntries()`。但 `harness.md` §2.8 规定的是独立 service、独立 catch-up/notify utility、generation-aware cursor 和可选的 `AsyncIterable` entry search。没有 factory、sync utility、cursor store、projection 或源端 SQLite FTS 实现。审计基线中 SQLite README 宣传不存在的 `createSqliteSessionSearch()` 行为；本审计修正了 README，而不是把缺失 API 当成已实现。

**剩余边界**

实现前替换或协调草拟的公开接口，并决定 metadata filtering（`cwd`）、candidate restriction 或 indexed metadata。对排名后的 `limit` 再做 post-filtering 是不正确的。然后实现独立 catch-up 和独立 SQLite FTS5 projection；不要增加 repository search method。

### R11——受激活门控的 Schema migration

当前不需要 format-4 migration。Memory 只保留当前状态；JSONL 和 SQLite 拒绝不支持的 storage version；SQLite 只运行幂等的 `001_initial.sql`。format 4 稳定后，在第一个不兼容的持久 storage version/address/state 变更之前，R11 立即变为必需。它不是 mobile assistant-output handoff 或当前 WIP format replacement 的前置工作。

激活时，它必须在独占所有权下提供有序的 transactional migrate-on-open、按版本解码 JSONL 并在迁移后 compaction，以及对每个可达的 open operation leaf 和存活 value/list 的完整映射。

## 正确性和数据安全债务

### SQLite host ownership 和 live-source fork——WP07 已完成

权威产品规则位于 `plugins.md`：恰好一个由宿主分配的进程拥有可写 Session authority；通常是 Session worker，而 server 可以临时拥有新创建或 fork 的目标，然后关闭它并交给 worker。Storage backend 不实现 writer ownership。Server 会在破坏性 repository 管理前关闭 worker。

SQLite 现在遵循该规则：writer-lease schema/module、claim、renewal timer、lease-loss path 和 pre-commit callback 已移除，没有替代锁或 ownership primitive。Create/open/fork/delete 保留 repository-local ID reservation。Metadata open/deletion 使用真正的 no-create read-write mode；listing 和 external fork source 使用 no-create read-only connection。

同 repository fork 保留源 `commitQueue` 排序接缝。其他地方拥有的源（包括 live worker）通过一个独立的只读 deferred WAL transaction，从精确的 canonical container 读取。聚焦的逐文件和共享容器测试在 reader 建立 snapshot 后、关闭前提交完整的后续 source transaction：第一次 fork 完全排除该 transaction，后续 fork 完整包含它。

WP07 还完成了 canonical `(containerPath, sessionId)` active identity、安全的显式 ID 文件名、自定义 `databasePath` parent creation、Session 作用域的共享删除、WAL/SHM 清理和 all-settled SQLite repository close。Writable open/delete 会拒绝 foreign metadata；foreign fork source 只从精确路径只读。相同 `createdAt` 的列表排序仍没有确定性 tie-break，属于后续保持行为的清理。

### Repository close ownership 未定义

`JsonlSessionRepo.close()` 包含唯一活动的 Agent 源 TODO，且不会关闭已打开的 Session handle。Memory 仍使用 fail-fast `Promise.all`；SQLite 现在执行 backend-local 的 all-settled 清理，但已经准入的 create/open/fork 仍可能在 repository close 捕获集合后注册 handle。`SessionRepo` 本身没有声明 `close()`，共享一致性也没有定义 repository 到 handle 的所有权或如何 drain 已准入的 repository operation。应在一个 repository-lifecycle package 中解决所有权和通用清理；在决定通用契约前不要继续只修一个 backend。

### Disconnect 后 Client watch 过时

`Client` 会在 disconnect 时清空 active watch-listener map，但已有的 `LaneWatch` 对象仍保留本地 `ready`/`started` 状态和旧 watch ID。Reconnect/reattach 后它们可能调用 `start()` 或 `resnapshot()`，远程失败，而不是像 `packages/client/README.md` 所规定的那样确定性地拒绝过时对象。Service-subscription object 有同样问题：listener 被清空，残留对象静默失效。使用 connection/attachment incarnation fencing 和聚焦的 reconnect 测试同时修复二者。这独立于 R12：当前 client method 是兼容性 main-lane watch。

### Query 上限和 SQLite bind 限制

- SQLite `getEntries(ids)` 为每个请求 ID 生成一个 placeholder，可能超过 engine 的变量上限。
- Entry、usage 和 branch 上限使用临时的 `Math.max(0, limit)` 行为。对于 `NaN`、无穷大、小数和极端值，Memory 与 SQLite 不一致；与 list read 不同，这里没有共享的归一化契约。

在 agent conformance 中定义跨 backend 的 query-limit 语义，然后将 SQLite ID lookup 分块。这是 storage-contract 加固包，不属于 WP07。

### Harness 契约和一致性闭环

- 公开 `OperationStatus` 包含 `"running"`，但 lane inspection、snapshot 和 `reduceLaneSnapshot` 当前只产生 `"open"` 或 `"aborting"`。定义并实现其 producer，或删除无用变体。
- Rewrite 前的 abort 契约会在 resolve cancellation promise、signal live gate 之前绑定/发布 `operation_abort`。当前 `Lane.command()` 先物化结果——resolve/signal——再构造和绑定事件批次，尽管它仍会在释放 Session mutation line 前绑定 recipients。决定是修改实现还是保留并记录当前 no-interleaving 顺序；添加显式顺序测试。
- 生产 gate-close 契约只允许 `HarnessClosed | HarnessFault`，但私有 source primitive 接受任意 `Error`，隔离测试也使用更宽类型。收窄 source declaration 和 fixture，或明确保留私有扩展。
- `harness.md` Part 9 是必需的一致性矩阵。现有聚焦测试广泛覆盖执行图，包括对全部 13 个 leaf 的 cancellation reconciliation，但没有经过审计的一对一证据证明每个 close/reopen leaf case 和每个 race row 都有两种确定性顺序。审计该矩阵，只添加缺失 case，不要声称整体完成。

将此包与 telemetry、RemoteSession 和 mobile assistant-output handoff 分开；它是本地契约/测试闭环。

### 被禁用的真实 worker 持久化回归

`packages/coding-agent/test/experimental-remote-runtime.test.ts` 仍跳过“通过 worker-owned Harness 完成并持久化 prompt”，并带有过时的“使用 runtime no-tool execution 重新启用”说明。No-tool execution 已存在。重新启用或替换为确定性的 faux-provider 真实 worker 持久化测试；不要使用真实付费 provider。

## 性能债务

### Mobile assistant-output handoff——持久化和复制放大

仓库外用户提供的动机 mini Session 有 569 个物理行，共 303,920 字节。以下外部测量是证据，不是已提交、可复现的 fixture：

- 477 次 assistant-frame append，共约 118,418 个序列化写入字节；
- 12 次 frame-list delete；提及 frame namespace 的物理行共 148,214 字节；
- 约 51,568 字节的过时 `pi.op.state` 写入和 26,192 字节的一次 structural preparation，说明通用 JSONL compaction 与帧专用有界处理为何不同。

权威设计是 [mobile assistant-output handoff](mobile-handoff/01-harness/05-assistant-output/message-update.md)，遵循 [`mobile-handoff/README.md`](mobile-handoff/README.md) 中编号的 `01-harness` 前置条件。Chord delta tracking 已落地；scoped storage、tool-output integration 和 assistant-output integration 尚未落地。

实现必须增加确定性的 repository fixture 和测量脚本，以复现或替代这些数字，然后测量 Memory logical element、SQLite row/page/WAL、JSONL sidecar/main-log 峰值字节以及 reopen/replay 时间。Handoff 必须保留 unknown-outcome recovery、invocation fencing、非阻塞 provider streaming 和 settlement retirement，同时消除逐帧持久写入和二次方的 `message_update` 复制。数值预算应放在其 implementation handoff/tests 中，而不是放在相互竞争的独立设计中。

### SQLite branch divergence

`createDivergentBranchForEntry()` 会复制最新 compaction 之后的每一行；没有 compaction 时会复制 root 到 parent。因此，长时间未 compaction 的 transcript 第一次 divergence 是 O(history) 次写入。这暴露了 `harness.md` §2.6 的内部矛盾：开头有界前缀的承诺与自身基于 compaction 的复制算法冲突，而实现遵循后者。修改规格和 segment 表示，使 divergence 能在 parent boundary 引用覆盖 segment。保留共享容器支持，并为 large uncompacted divergence 加入 chain-soundness 测试/基准。

### Fork 契约和物化——WP08 可执行

当前所有 backend 都会物化源大小的 fork snapshot。Branch scope 默认使用 `main`，但没有 named-Branch ancestry validation；tree scope 忽略 application values/lists；JSONL closed-source fork replay 可能修复源文件。WP08 将该契约替换为必需的 named-branch 或 tree scope、一套封闭的 built-in-state policy、tree fork 的完整当前 application state，以及按 backend 区分的有界内存复制过程。它保留 WP07 的 host ownership、physical identity、same-repository ordering 和独立 live-source WAL boundary。

### SQLite catalog、statement、stats 和回收

- 默认按 session 的 `list()` 会同步、串行地打开/配置每个 SQLite 文件，并静默跳过失败。共享容器或外部 catalog 才是可扩展部署选择；有界异步调度不会让 `DatabaseSync` 变成非阻塞。
- 大多数热查询每次调用都 prepare 新 statement。测量后只缓存明确归属的 statement。
- 每个 usage row 都会解析并重写完整的聚合 JSON usage payload。
- 共享容器的 row deletion 不会回收 page。单独定义 maintenance/VACUUM 策略；不要随意把 `VACUUM` 加入普通删除。

这些是可测量的优化/运维包，不是正确性修复。

### Pending-payload 放大和 mutation-line 并行

Queued payload 有意写入 `pendingEntry → immutable entry`；改变前先测量异常 payload。Keyed Session mutation line 仍是可选项，需要性能分析和新一轮 mutable-ownership 审计。二者都不是当前正确性工作。

## 保持行为的清理和文档修复

本次审计已完成：

- 重写 SQLite README 中不存在的 `SqliteSessionRepository`/search API、错误的 `await using` 和 `appendMessage` 示例、FTS trigger/rebuild 声明以及“一条共享连接”的说法；
- 将 `harness.md` 关于 SQLite 默认单文件的表述与受支持的可选共享容器对齐；
- 将 `harness.md` Part 8 与本审计对齐，并修正 `telemetry.md` 中过时的 drive-ownership/RPC-cancellation 状态；
- 修正 coding-agent settings 文档：安装 telemetry 配置也控制选定 provider attribution header。

剩余清理：

- **Harness-owned DTO 边界：** 持久 Harness 仍从 `src/types.ts` 导入旧的 agent-loop DTO：`AgentMessage`、`AgentToolResult`、`AgentToolCall`、`AgentTool`、`QueueMode` 和 `ThinkingLevel`。后续一次性切换到独立的 `HarnessMessage`、`CustomHarnessMessages`、`HarnessToolResult`、`HarnessToolCall`、`HarnessQueueMode` 和 `HarnessThinkingLevel` 定义；保留 `AgentHarnessTool` 作为可执行 Harness 配置类型。同步更新 Harness internals、root exports、declaration-merging tests、文档和 experimental coding-agent consumers。不要将新的 message/tool DTO alias 回旧类型，否则会保留本次工作要移除的耦合。
- 保留共享容器支持，不要顺带删除；
- 删除或使用未使用的 `insertEntryRow()` 和 `insertUsageLedgerRow()`；
- 只有在正确性测试固定两条路径后，再合并重复的 SQLite branch payload/structure scan plumbing；
- 在移除 schema 前决定未使用的 `sessions.metadata` 和未经测量的 index 是否有未来 owner；不要随意改 schema；
- 只有在保留 telemetry surface 时才合并 `startAiSpan()`/`startHarnessSpan()` 实现；
- 对仍然读起来像实现队列的历史 durability 文档标记为已交付。WP00–WP07、`runtime-simplification.md`、`values.md` 中旧的 consumer deferral 和 external-finalization design 不属于活动 runtime backlog。

## 可选或延后的产品能力

这些不是 durable Harness 的阻塞项：

- S3 search 独立服务（API 决策之后）；
- Accounts 移除和 revisioned Transcript 生产；
- experimental local server 的 authenticated workspace/client authorization；
- private returned reference、service flow control、multi-pane presentation、plugin kernel/reload completion 和 version-skew negotiation；
- administrative precise rewrite tooling；
- partitioned Postgres backend/retention policy；
- 通用 remote Harness/object capability；
- 在具体 snapshot 压力证明有必要之前，不引入 DeltaState 或 delta replication；
- 生产 telemetry exporter；
- 在不兼容的稳定格式变更激活 R11 之前，不做 schema migration。

## 推荐依赖顺序

顺序优先考虑数据安全，然后考虑依赖。只有不编辑同一契约的独立轨道才可以并行。

1. **Harness 契约/一致性闭环。** 解决 `OperationStatus.running`、abort signal/event binding 顺序、gate-close typing 和 Part 9 覆盖矩阵。
2. **Remote Session 决策（只做决策）。** 尽早解决错误的规范边界。如果进程本地方案胜出，修正文档；如果 raw RemoteSession 胜出，之后创建独立 protocol/client/server/worker package，不要把它并入 telemetry 或 R12。
3. **Client watch/subscription 过时和 repository lifecycle 契约。** 独立且较小的正确性包；在扩大 server/worker lifecycle 语义前完成。Lifecycle package 还必须处理 Memory 的 fail-fast repository close。
4. **[Mobile Harness handoff](mobile-handoff/README.md)。** 按编号前置条件经过 scoped storage、tool output 和 assistant output；保留所有恢复边界，并落地确定性的放大测量。
5. **JSONL snapshot compaction。** 实现已经规范化的物理回收路径和剩余 session-scoped history 的 metrics。
6. **R12 Session-wide watch。** 在构建 revisioned Transcript/session-wide remote observation 前完成唯一的 Harness method stub。
7. **Telemetry（如果保留）：** 先协调 schema，然后本地 instrumentation，再 RPC propagation，最后可选 exporter。RPC propagation 依赖 Remote Session/product-boundary 决策。
8. **WP08——named-branch 和 streaming fork。** 按可执行 handoff 实现，不重新打开 WP07 的 ownership 或 lifecycle 决策。
9. **SQLite branch/query 性能加固。** 与已完成的 WP07 ownership alignment 和 WP08 fork 语义分开，并要求基准测试。
10. **S3 search。** 解决 API/filter/cursor 决策，然后实现 catch-up 和独立 FTS projection。
11. **R11 migration。** 在第一个不兼容的稳定 durable schema 变更前立即激活，不要提前激活。

## 路线图准确性的停止条件

以下事实发生变化时必须更新清单：

- `watchSession` 不再是唯一的 Harness `SliceNotImplemented` 方法；
- raw RemoteSession 被重新委托实现，或从规范契约移除；
- JSONL snapshot compaction 落地；
- telemetry schema 被实现或移除；
- S3 的公开 API 完成协调；
- durable format 变更激活 R11；
- WP08 落地，或其 fork 契约发生变化；
- host-authority 契约发生变化。
