# WP08 — 命名分支与树分支的流式 fork

**状态：进行中，正在实现 Slice A。**

本工作包替换 fork 契约：ForkOptions 必须指定 scope，branch scope 必须指定命名 source branch；分支 fork 校验完整且已配置的源 AgentLane 及其祖先关系；tree fork 复制完整不可变树以及当前应用值/列表；三个后端都使用有界内存的流式复制，不再物化源 snapshot 数组。所有 namespace 的 fork 规则由一个封闭的核心 classifier 统一负责。

WP07 是硬依赖，以下行为保持不变：no-create 数据库模式、规范化的 (containerPath, sessionId) identity、面向外部/live-worker 源的独立只读 WAL reader、仓库级删除 reservation、all-settled close。本包只替代 roadmap 中的 SQLite fork cost 性能事项。

## 0. 必读内容

编辑前完整阅读：

1. harness.md 中关于 fork、invariant 和 ledger completeness 的相关章节；
2. values.md 的 Forks and rewrites 与各后端章节；
3. post-wp05-roadmap.md 的 SQLite fork cost 和 repository lifecycle；
4. 已完成的 WP06、WP07，历史文档不得修改；
5. session fork/types/values、Memory、Session；
6. JSONL repo/storage/codec/legacy-v3/types；
7. sqlite-node 的 repo、storage、session values/entries/branch-entries/types；
8. §5 点名的 conformance 和测试；
9. benchmark 的 session-repo 实现与两个 benchmark 文件。

不要使用 dist/ 作为实现输入。WP00–WP07 文档及已发布 changelog 不在本包范围内。

## 1. 固定架构

### 1.1 公开契约

~~~ts
export type ForkOptions =
  | { scope: "branch"; branch: string; entryId?: string; position?: "before" | "at"; id?: string }
  | { scope: "tree"; id?: string };
~~~

scope 必填，branch scope 的 branch 必填；没有默认 scope、隐式 main 或兼容别名。

Branch scope 要求源 AgentLane 完整且已配置：pi.branch.tip/{branch}、pi.lane.config/{branch}、pi.lane.state/{branch} 必须同时存在。缺少 tip 是 unknown branch；只有 tip 的 data-only Branch 拒绝；config/state 部分缺失，或没有 branchTip 却存在 laneConfig/laneState，视为存储损坏并拒绝。

如果指定 entryId，它必须位于该 Branch 当前 tip 的祖先链上（包含 tip）；树中其他位置的 entry 拒绝。未指定 entryId 时使用当前 tip。position 默认 at；before 选择目标 entry 的 parent，根 entry 之前可以得到 null tip，这是合法结果。目标只包含一个同名 Branch、选中的 tip、复制的 LaneConfiguration，以及新的 idle lane state：

~~~ts
{ currentOperationId: null, lastOperationId: null, inbox: [] }
~~~

目标中没有其他 Branch 或 lane。data-only Branch 不可用于 branch fork；tree fork 仍可复制它。

Tree scope 复制：

- 所有不可变 entry，包括不在任意当前 Branch tip 可达路径上的 entry；
- 所有 Branch tip；
- 每个已配置 lane 的 config 和同名的新 idle state；
- data-only Branch，仍保持 data-only；
- 部分 config/state 组合则视为损坏并拒绝，而不是静默丢弃。

两种 scope 都复制 pi.session.name，并且只为实际复制的 entry 复制 pi.entry.label；排除 usage ledger、pi.result、全部 pi.op.*、全部 pi.pending.* 以及所有活动 operation 状态。目标 usage 从零开始，messageCount 等于复制的 message entry 数量。目标元数据记录 parentSessionId = source.id。复制的 entry、value 和 list element 保留原 seq；目标 nextSeq 保持源 high-water mark，不能复用序号。被改写的 branchTip 和新的 idle laneState 使用源对应当前 value row 的 seq。

应用 namespace（不属于 pi 或 pi.*）的规则是：tree scope 复制当前所有 scalar value 和存活的 list element，并保留 seq；branch scope 一个也不复制。禁止用 seq <= tipSeq 作为“历史重建”：

~~~text
标量：seq 10 写入 v1，seq 12 写入 entry，seq 50 将同一值替换为 v2。
在 entry 处分支时，v1 已被替换且没有历史，按 seq 截断只能看到 v2 被排除，无法恢复分支时的 v1。

列表：seq 5、20 追加，seq 40 整表删除，seq 60 再追加。
按 seq <= 30 截断时，5 和 20 已因整表删除不存在，60 又被排除，错误得到空列表。
~~~

任何 cutoff 都只会过滤当前幸存者，不能恢复历史状态。因此 branch scope 不复制应用所有权的数据，由应用自行重新派生。

### 1.2 一个封闭的 fork classifier

所有 namespace fork 知识集中在 session/values.ts 和 session/fork.ts 旁的核心模块（例如 session/fork-policy.ts），使用封闭 switch，不使用 registry、plugin policy 或 DSL：

- pi.op.*、pi.pending.*、pi.result：两种 scope 都排除；
- pi.session.name：复制；
- pi.entry.label：仅当对应 entry 被复制时复制；
- pi.branch.tip、pi.lane.config、pi.lane.state：由共享 driver 执行 scope 特定的 lane 操作；
- 精确 namespace pi 或未声明的 pi.*：只有当当前仍存在 scalar row 或 list element 时才使 fork 失败；仅存在已替换/删除的历史写入不能使 fork 失败；
- 其他 namespace：视为应用数据，tree 复制，branch 排除。

driver 接收一个已提交的 value/list write 或当前 row，流式产生目标写入；finish() 产生新的 idle lane state 和改写后的 branch tip。只保留 lane 名和目标 tip 等有界状态。Entry 是否属于复制集合由后端索引提供。删除 createForkSnapshot、forkSnapshotWrites、ForkSourceSnapshot、ForkDestinationSnapshot 和 entriesComplete escape hatch。

### 1.3 有界内存的后端流程

fork 辅助内存必须与源大小无关。不得调用返回无界数组的 full read，例如 snapshotEntriesAndValues、captureForkSource、readAllScalarValueRows、readAllEntryRows、whole-file readTextFile 或对无界 rows 使用 SQLite .all()。

**Memory：** 在 source commitQueue 边界直接创建目标 InMemoryStorageState；通过 classifier/driver 遍历源 map 一次。branch scope 从 tip 沿 parentId 向根行走，计算祖先集合并验证 entryId，只复制该集合，不构造中间 snapshot 数组。

**JSONL：** 使用只读固定前缀：打开 reader，记录 capture 时文件长度，只读该前缀；绝不截断、重写、升级 source，也不在 source 旁创建 .tmp。前缀内不完整尾行只在内存中丢弃。nextSeq 取 header.nextSeq 与完整写入最高 seq + 1 的较大值。

两次流式扫描使用一个临时磁盘索引：

1. 第一次扫描折叠当前状态：每个标量地址保存当前 set 的 seq（尾随 delete 后为空），每个列表保存存活 element seq，整表 delete 会清空；同时保存 entry → parentId。
2. 第二次按原始顺序扫描，只输出索引证明仍当前且 classifier 允许的内容：选中 entry、当前 scalar set、存活 list append。delete、被替换 set 和已死亡应用历史都不输出，因此目标文件只有当前状态，且 seq 顺序与源一致。
3. 读取源当前 branchTip/laneState 时，在相同 seq 位置输出改写的 tip 和新 idle state，不追加尾部。
4. branch scope 使用磁盘索引沿 tip→root 检查 ancestry 与 entryId；label 只为祖先 entry 输出。
5. 目标先写入临时文件，再使用 publishFileAtomically 原子 rename；成功或失败都在 finally 删除索引和临时文件。

打开的 legacy-v3 JsonlStorage 在普通非空 commit 升级并持久化 format-4 ID 前，fork 必须返回清晰错误；fork 不能自己升级或修改 source。关闭的 v3 source 使用有界磁盘 parser/normalizer 且不修改源文件，tree fork 可用；branch fork 只有在能重建完整配置 lane 且未指定旧进程内 entryId 时可用。打开的普通 JSONL source 在 commitQueue 边界捕获只读前缀，释放队列后再执行两遍磁盘扫描；后续 append 可以继续，但不进入该 fork。

**SQLite：** 通过有界内存的临时磁盘 SQLite staging database 传输 rows，统一支持 per-file 和 shared-container。源 reader 不能直接流入目标事务，否则 shared-container 的目标 writer 会阻塞源写入。

- 外部/关闭/live-worker 源沿用 WP07：精确 canonical path 上 openReadOnly，单个 deferred read transaction 内校验 session row 和 storage version；
- 同仓库 open source 先打开独立只读连接，再在 source commitQueue 边界 callback 中 BEGIN 并进行一次 trivial read 建立 reader snapshot，随后释放队列，不能占用队列执行整个复制；
- source reader 保持打开时，按 seq 流式写入 staging：entry、classifier 允许的当前 scalar/list rows 分批写入，branch ancestry 通过 branch_entries 索引完成；
- 关闭/提交 source read transaction 后，将 staging 流入目标单个 BEGIN IMMEDIATE 事务；最后在 finally 删除 staging。目标 next_seq 保持源值；shared-container 只写新 session 的 rows。

### 1.4 保留 WP07 行为

跨 create/open/fork/delete 的目标 ID reservation、no-create open、foreign metadata 拒绝、per-file/shared-container 布局、WAL commit-boundary 完整性和 all-settled repository close 全部不变。

### 1.5 coding-agent 状态记录

/fork、/clone、--fork 仍完全使用旧 SessionManager，未迁移到本包。未来采用 SessionRepo 时的映射为：

~~~text
/fork  -> { scope: "branch", branch: "main", entryId, position: "before" }
/clone -> { scope: "branch", branch: "main" }
/--fork -> { scope: "tree" }
~~~

## 2. 当前源码的问题

- ForkOptions 默认 branch scope 并硬编码 source/destination main；
- 没有检查 entryId 是否属于命名 Branch 的 tip ancestry；
- 三个后端都物化完整 source；
- createForkSnapshot 重新分配 scalar seq，并用 max entry seq + 1 计算 nextSeq；
- closed JSONL fork 可能因 open() 的尾部修复而修改 source；
- lists 从未复制，tree scope 没有应用值策略；
- namespace fork 规则散落在多个模块，新增 pi.* namespace 不会强制声明策略；
- entriesComplete 只用于让 SQLite 跳过其他 Branch 的 tip 校验。

## 3. 必须达到的结果

1. 所有 ForkOptions 校验路径符合 §1.1，拒绝时不创建目标 artifact、不留下 rows、不泄漏 reservation ID；
2. 一个核心 classifier 由三后端共用；未知保留 namespace 只有在有当前存活状态时才拒绝，并保持后端一致；
3. 三后端都使用 §1.3 的流式过程，删除 snapshot fork plumbing；
4. 所有复制 seq、改写 tip/idle state seq 和 nextSeq high-water mark 保持不变；
5. JSONL fork 从不修改 source，包括尾部损坏和 legacy-v3；
6. 同步更新 harness、values、roadmap、sqlite-node README 和必要 benchmark 文档，历史 WP 文档与已发布 changelog 不改。

## 4. 实现切片

### Slice A：契约与 classifier，核心/Memory

修改 session/types.ts、session/fork-policy.ts、session/fork.ts、session/values.ts（如需）、session/index.ts、Memory、conformance 与 Memory 测试。替换 ForkOptions，实现校验和 classifier，直接在 commitQueue 边界构造 Memory 目标，并更新共享 conformance。

### Slice B：JSONL 流式 fork

修改 JSONL repo/storage/types、必要的 FileSystem streaming capability 和相关测试。实现固定前缀读取、磁盘状态折叠、branch ancestry 索引、原子目标发布、v3 open 拒绝和 closed parser。

### Slice C：SQLite 流式 fork

修改 sqlite repo/storage/session values/entries/branch-entries/types 和测试。使用独立 reader、边界 callback、临时 staging database、索引 ancestry 与 classifier SQL prefilter，保持 WP07 两种布局和生命周期行为。

### Slice D：benchmark 与文档

更新 ForkOptions literal，增加大源 tree/branch fork benchmark，并同步 harness、values、roadmap、sqlite README 和 benchmark 文档。

## 5. 必需测试

### 契约与校验

覆盖 unknown branch、data-only Branch、部分 config/state、错误 entryId、null tip；覆盖省略 entryId、tip、中间祖先、before 根和中间 entry、null source tip。每次拒绝都验证没有目标 artifact 且 reservation 已释放。

验证目标只包含规定的 Branch、config、新 idle lane state 和 parentSessionId；tree scope 复制不可达 entry、每个 tip、配置 lane 和 data-only Branch；部分状态组合都报 corruption。

验证两种 scope 都复制 session name，label 只随 copied entry 复制；pi.result、pi.op.*、pi.pending.*、usage 和活动状态都缺失；messageCount 与复制的 message entry 数一致，ledger 从零开始。

### 应用值与列表

tree fork 复制所有非 pi.* 当前 scalar 和存活 list element，保留 seq 与 cursor；delete 后再 append 只复制幸存者。branch fork 不复制任何应用值/列表，并以覆盖和整表删除回归用例证明 cutoff 不会错误恢复历史。

未知保留 namespace 有当前存活值时三后端都拒绝；set 后 delete 的历史只存在物理日志但不影响 fork。

### 序号

entry、value、list element 保留 seq；改写 tip 和新 idle lane state 使用源当前 row 的 seq；目标 nextSeq 等于源 high-water mark，首个新提交从其上方分配。JSONL 的 incomplete tail 不推进 high-water mark。

### 有界内存与 source 不变更

使用 instrumented reader 证明没有调用无界 snapshot/readAll/readTextFile/.all；大 fixture 覆盖数千 entry 的 tree 与 branch fork。SQLite staging 成功/失败都清理，失败不留目标 rows。

JSONL closed torn-tail fork 丢弃整个不完整事务且 source 字节完全不变；v3 fork 不产生 source 旁的 .tmp；固定前缀捕获后发生的 append 完全不进入 fork；目标只含当前 selected rows，无 delete、旧 set 或死亡历史。

验证 open v3 在升级前明确拒绝；正常非空 commit 升级后 fork 成功；closed v3 使用磁盘 parser；旧进程内 entryId 在重新解析时拒绝；data-only reconstructed lane 始终拒绝。

### 协调与顺序

Memory、JSONL、SQLite open-source fork 都验证 commitQueue 边界：边界前提交完整进入，边界后提交完整排除；SQLite 在两种布局中都验证 source writer 可以在 staging streaming 期间完成后续提交。reservation race 保持 WP07 行为。

### 后端等价

使用同一份包含 entry、不可达 entry、多 lane、data-only Branch、label、应用 scalar/list 删除、open operation、pending/frame/checkpoint、usage 的 fixture，在三后端和两种 scope 上比较完全相同的逻辑目标状态。

## 6. 校验与评审

每个 slice 后运行 npm run check 和对应 package 的 focused tests，最终运行 ./test.sh。检查 createForkSnapshot、captureForkSource、ForkSourceSnapshot、entriesComplete 不再出现在生产代码中；生产 fork source path 不得硬编码 main，文档中的 coding-agent 映射除外。

评审节点：Slice A 检查契约、classifier、conformance；Slice C 检查同仓库顺序、reader 独立性和有界内存；最后审查源码、测试、文档和排除项。

## 7. 排除项

不包括兼容别名、默认 scope、隐式 main、seq cutoff、fork-policy registry/plugin/DSL、usage/pi.result/活动状态复制、coding-agent fork/clone/RPC 迁移、storage/format version 变更、J1 compaction、SQLite branch segment 重设计、SessionRepo 其他接口变化、precise-rewrite 工具、search，以及 WP00–WP07 和已发布 changelog 修改。

若实现需要任何排除项，应停止并重新修订 handoff。

## 8. 完成条件

WP08 完成时，三后端的 ForkOptions、branch/tree 校验、classifier、seq/nextSeq、应用值/列表策略和目标逻辑状态完全符合本文件；所有 fork path（含 closed v3）都使用有界流式复制且 source 不变；SQLite 使用临时磁盘 staging；共享 conformance、focused tests、benchmark、npm run check、./test.sh 和最终 Fable review 全部通过；规范文档和 roadmap 已同步，历史文档未改。
