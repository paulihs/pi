# WP07 — SQLite 宿主所有权和 live-source fork

**状态：已实现。**

交付的 backend 没有 writer lease 或替代的 ownership primitive。它提供 no-create 的 read-write/read-only open、排队的同 repository snapshot、live external source 的独立只读 WAL snapshot、canonical physical identity、路径安全 ID、repository-local deletion reservation 和 all-settled close。测试覆盖逐文件和共享容器布局，包括 read snapshot boundary 之后、reader 关闭之前完成的 writer commit。

本工作包使 `packages/session-backends/sqlite-node` 与产品所有权模型一致：server 拥有 Session record 和 worker 生命周期，任意时刻恰好一个由宿主分配的进程拥有可写 Session authority。通常该进程是 Session worker。Server 可以临时拥有新创建或 fork 的目标，但会在把 Session metadata 交给 worker 前关闭它。

Storage 不实现 writer ownership。移除 SQLite writer lease；不要修复或替换它。

Server-side fork 与第二个 writer 有意不同：它可以在 worker 继续提交时，并发打开 live worker-owned source，获取一个一致的只读 snapshot。共享 SQLite container 仍然受支持。

## 0. 必须阅读

编辑前完整阅读：

1. `packages/agent/docs/plugins.md` 中的 ownership、replacement 和 removal 部分；
2. `packages/server/README.md` 以及相关 Session routing/removal 源码和测试；
3. `packages/agent/docs/harness.md` §§0.6、1.4–1.7、2.7–2.8、4.3 和 Part 9；
4. `packages/agent/docs/post-wp05-roadmap.md`；
5. 已完成 WP06 §7 和 repository/fork conformance；
6. `packages/session-backends/sqlite-node/src` 下的每个源文件；
7. `packages/session-backends/sqlite-node` 下的每个测试和 benchmark；
8. `packages/session-backends/sqlite-node/README.md` 和 `CHANGELOG.md`。

不要把 `dist/` 下过时文件作为实现输入。已完成的 WP01/WP06 文档是历史记录；不要重写它们来掩盖之前的 lease 实现。

## 1. 固定架构

### 1.1 可写 authority 属于宿主

恰好一个由宿主分配的进程拥有可写 Session。Session worker 是正常 owner。Worker replacement 会在新 worker 打开 Session 前关闭旧 owner。Server management 围绕 ownership transfer 序列化创建、fork、移除和 attachment 生命周期。

Memory、JSONL 和 SQLite 不检测第二个进程打开同一个 Session 进行写入。绕过 server/worker 生命周期是 trusted-host defect，而不是需要修复的 storage race。一个 repository 仍会拒绝同一进程内自己拥有的重复可写 handle。

不要添加 storage lease、filesystem lock、fencing token、heartbeat、基于 timeout 的 takeover、deletion tombstone、quarantine protocol 或通用 lock manager。

### 1.2 只读 fork access 可以与 worker 重叠

Server 拥有 repository administration，并可以在 Session worker 继续写入时 fork source。该 fork 的 source 侧：

- 不创建文件，打开精确的 source container；
- 只读；
- 使用一个 deferred `BEGIN` transaction；
- 在该 transaction 中读取经过版本门控的 Session row、scalar value 和选定 entry/branch index；
- 永远不会升级为写入，也不会 claim writable authority；
- 在 `COMMIT`/`ROLLBACK` 后关闭。

SQLite WAL 允许 worker 在 read transaction 保持打开时继续提交。Fork 看到的每个 source commit 都完整地位于 snapshot boundary 之前或之后，不会看到混合状态。

### 1.3 同 repository fork 的排序保持独立

同一 repository 中已经打开的 source 使用其 active `SqliteStorage.snapshot()` 路径。该 snapshot 在 source `commitQueue` 上排队，保留 WP06 的 admitted-commit ordering seam 和现有 conformance case。

不要用独立 connection 替换这条路径。应将 active storage lookup 绑定到精确的 physical identity 加 Session ID，防止其他 container 的 metadata 意外选中它。

### 1.4 Destination ownership 不重叠

`SessionRepo.create()` 和 `fork()` 继续返回已打开的 Session。Server 可以临时拥有该新目标，获取 metadata，然后在启动 worker 前关闭它。这是有效的 ownership transfer，不是把 `SessionRepo` 重设计为只返回 record-only API 的理由。

## 2. 当前源码中的问题

### 2.1 SQLite 重复实现了宿主 ownership

当前源码包含：

- `writer_lease` schema state；
- claim、renew 和 release helper；
- create/open/fork 中的 lease claim；
- `SqliteOpenSession` 中的 idle renewal timer 和 lease-loss path；
- `SqliteStorage` 中的 pre-commit renewal callback；
- 基于 lease 的删除检查。

这是第二套且不完整的 ownership 系统。它的 pre-commit renewal 与后续 data transaction 不具备原子性；正确修复是删除 ownership mechanism，而不是添加 transaction-local fencing。

### 2.2 Non-creation access 可能创建文件

Database factory 只暴露 `open(path)`，会创建缺失的 SQLite 文件。Metadata open、listing probe、deletion 和 fork-source read 不得把已删除路径变成空数据库。

Fork-source read 还会配置 `PRAGMA journal_mode = WAL`，这是面向写入的 setup 步骤，不得在只读 connection 上执行。

### 2.3 Delete 没有预留本地临界区

`delete()` 检查 `pendingIds`，但不会预留 ID。异步破坏性工作进行期间，同 repository 的 create/open/fork destination 仍可以进入。宿主生命周期负责跨进程顺序；repository 仍必须序列化自己的本地操作。

### 2.4 Physical identity、路径和 close 需要修正

- `openStorages` 只按 Session ID 索引，因此另一个 physical path 上相同的 ID 可能选中错误的 active source；
- `create()` 创建 `options.directory`，而不是显式 `databasePath` 的 parent；
- per-session 文件名直接插入任意 caller ID；`/`、`\`、`..`、`%` 和 platform separator 不得逃出 `directory`；
- `repo.close()` 使用 fail-fast `Promise.all`，可能在所有 open Session 都尝试 drain/close 之前返回。

确定性列表排序、bind-variable 限制、branch-copy 成本、fork scalar filtering、prepared statement 和 VACUUM policy 属于独立事项。

## 3. 必需结果

### 3.1 移除 storage 层 writer ownership

删除所有运行时 lease 行为：

- 删除 `src/sqlite/session/writer-lease.ts`；
- 从 WIP `001_initial.sql` 删除 `writer_lease`；
- 从 `deleteSessionRows()` 删除 lease deletion；
- 从 `SqliteSessionRepo` 删除 claim/renew/release code；
- 从 `SqliteStorage` 删除 `beforeCommit`；
- 从 `SqliteOpenSession` 删除 renewal/release option、timer 和 `leaseError`；
- 删除 lease 专用测试，换成 host-authority 和 live-fork 覆盖。

保留：

- Storage `commitQueue`；
- 每次 commit 一个 `BEGIN IMMEDIATE` transaction；
- transaction 内的 `next_seq` 分配；
- entry/usage 唯一性和 parent trigger；
- Session mutation admission 和 close draining；
- 进程本地 duplicate-open rejection。

Format 4 仍是 WIP。在新 schema 中原地删除该表；包含未使用 `writer_lease` 表的旧文件仍可读取，表和过时行永久忽略。WP07 之后的代码不删除它们，因为这不提供任何运行时行为。WP07 之前的 binary 无法打开缺少该表的新数据库；这个 WIP 格式不要求向后兼容。不要增加 migration、兼容路径或 storage-version bump。

### 3.2 添加显式 database open mode

为 `SqliteDatabaseFactory` 增加窄接口：

- `open(path)`——有意创建或在缺失时创建；
- `openExisting(path)`——文件不存在时失败的 read-write open；
- `openReadOnly(path)`——文件不存在时失败的 read-only open。

Node adapter 使用 `DatabaseSync(path, { readOnly: true })` 进行只读访问。为 `openExisting` 实现并测试真正的 no-create read-write mode；不要依赖 `access()` 后再使用可创建的 open。

分离 connection setup：

- writable connection 建立 WAL mode 和 `busy_timeout`；
- read-only connection 只设置 `busy_timeout` 等 read-safe option，绝不尝试修改 journal mode。

Metadata open、listing probe、deletion 和 fork-source read 使用 no-create mode。

### 3.3 保留两条 fork-source 路径

**Source 在本 repository 中打开：** 保留 `SqliteStorage.snapshot()`，并在之前已准入的 commit 后排队。将 ID-only active map key 替换为 canonical `(containerPath, sessionId)` identity，并在 publish、lookup 和 removal 中使用同一个 helper。

**Source 未在本 repository 中打开：** 包括关闭的 source 以及当前由另一个进程中的 worker 所有的 source。通过 `openReadOnly` 打开精确 source，然后在一个 deferred read transaction 中 capture。必须在该 transaction 内验证 Session row 和 storage version。不要查询 destination reservation、claim source ownership，也不要阻塞 worker 后续 commit。

Source capture 后，destination 仍使用普通可写 create/fork transaction。在 shared-container mode 中，source worker 和 destination transaction 可以使用同一个文件；SQLite 会序列化 destination 写入，同时保持 Session row 隔离。

### 3.4 让删除在本地互斥

宿主必须在调用 `repo.delete()` 前关闭 Session worker。直接跨进程删除 live Session 不受支持。

在一个 `SqliteSessionRepo` 中，删除必须从开始到完成预留 Session ID，并在 `finally` 中释放：

- 已打开或已预留的 Session 拒绝删除；
- 删除运行期间，该 ID 的 create/open/fork destination 被拒绝；
- shared-container deletion 在一条 connection、一个 `BEGIN IMMEDIATE` transaction 中只删除目标 Session 的 rows；
- per-file deletion 在 no-create open/existence check 后删除 database 及其 WAL/SHM sidecar；
- 缺失 Session 拒绝操作，且不创建文件。

不要增加 lease check、tombstone、quarantine rename 或 stale-deleter protocol。跨进程删除顺序由 server 负责。

### 3.5 绑定 metadata 到 physical identity 并保证路径安全

- Canonical identity 是 `(canonical container path, sessionId)`；
- per-file mode 的 metadata 必须标识 durable ID 对应的 repository-affine 编码路径；
- shared-container mode 的 metadata 必须标识配置的 canonical container 和 Session ID；
- foreign 或不匹配的路径绝不能 alias 本地 active source。聚焦测试和 SQLite README 要明确 foreign source metadata 是被拒绝，还是只从精确路径读取；不要静默地按 ID 替换为本地 storage；
- 配置 `databasePath` 时创建 `dirname(databasePath)`；
- 将任意 explicit ID 编码为安全的 per-session filename，但不改变 durable ID。编码必须防止路径逃逸，并能通过 metadata/list/open/fork 往返；
- 一个 shared container 中的两个 Session ID 仍然可以独立寻址。

### 3.6 Drain 所有 repository-owned close

`SqliteSessionRepo.close(context)` 必须：

1. 只封闭一次 repository admission；
2. 对当前每个已打开 Session 开始 close；
3. 等待每个 close 结算；
4. 全部成功时 resolve；
5. 所有清理尝试结束后才 reject，并返回单个错误或包含全部失败的 `AggregateError`；
6. 重复 close 返回同一个 promise。

这是 backend-local resource cleanup。不要在本工作包中修改共享 `SessionRepo` interface 或 JSONL lifecycle。

## 4. 实现切片

### Slice A——移除 writer lease

文件：

- 删除 `src/sqlite/session/writer-lease.ts`；
- `src/sqlite/migrations/001_initial.sql`；
- `src/sqlite/session/session-row.ts`；
- `src/sqlite/storage.ts`；
- `src/sqlite/session.ts`；
- `src/sqlite/repo.ts`；
- lease-focused repository tests。

任务：

1. 删除 schema/runtime lease state 和 timer 行为；
2. 保留 commit serialization、单次 write transaction、mutation draining 和进程本地 duplicate-open 行为；
3. 证明普通 commit 现在使用一个 write transaction，而不是 renewal 加 write。

### Slice B——no-create open 和 deletion reservation

文件：

- `src/index.ts`；
- `src/sqlite/types.ts`；
- `src/sqlite/repo.ts`；
- 聚焦 adapter/repository tests。

任务：

1. 添加带测试的 `openExisting` 和 `openReadOnly` no-create 行为；
2. 分离 writable 与 read-only connection 配置；
3. 为整个临界区本地预留 deletion；
4. 在一个 transaction 中删除 shared-container Session，同时保留无关 Session。

### Slice C——live-source 只读 fork 和 identity

文件：

- `src/sqlite/repo.ts`；
- repository/conformance tests。

任务：

1. 按 canonical container 加 Session ID 索引 active storage；保留同 repository queue ordering；
2. 对非 open/live-worker source 使用一个独立的 deferred read-only transaction；
3. 在 snapshot 内验证 source metadata/version；
4. 保留 shared-container destination 行为。

### Slice D——路径和 close draining

文件：

- `src/sqlite/repo.ts`；
- 聚焦 repository/conformance tests。

任务：

1. 创建实际的 custom container parent；
2. 安全编码任意 ID；
3. 在不 alias active source 的前提下拒绝或精确处理 foreign metadata；
4. 让 repository close all-settled 且完整报告错误。

### Slice E——文档

文件：

- `packages/agent/docs/harness.md`；
- `packages/agent/docs/post-wp05-roadmap.md`；
- `packages/agent/docs/values.md`；
- `packages/session-backends/sqlite-node/README.md`；
- 只在正常分支规则下修改 changelog。

说明宿主拥有的可写 authority、两条 fork-source 路径、no-create open、本地 deletion reservation，以及 storage 层不拥有 ownership。

## 5. 必需测试

使用真实的独立 `node:sqlite` connection。测试 wrapper 可以暴露确定性的 transaction boundary；生产代码不得加入 sleep 或 race flag。

### Lease 移除

- 新 schema 没有 `writer_lease` 表；
- create/open/fork/commit/close 不读取或写入 lease，也不启动 renewal timer；
- 同 repository duplicate writable open 仍通过进程本地 reservation 拒绝；
- 普通 commit 仍是一个 `BEGIN IMMEDIATE` transaction。

### Live fork source

逐文件和 shared-container layout 都要覆盖：

- server repository fork 一个由代表 worker 的独立 repository/connection 保持打开的 source；
- source capture 使用独立 read-only connection，且不 claim writable ownership；
- snapshot boundary 前完成的 source commit 完整出现在 fork 中；
- 建立 read snapshot 后的 commit 可以在 reader 关闭前完成，并且完整缺席于该 fork；
- fork 不会包含缺少同一 commit 的 Branch tip/value/stats 变更的 entry；
- 后续 fork 包含后来的 commit；
- 同 repository admitted-commit fork conformance 保持不变。

### Deletion

- 先 open/reserved Session → 同 repository delete 拒绝；
- 先取得 delete reservation → 同 repository 中该 ID 的 create/open/fork destination 拒绝；
- shared deletion 只删除目标 rows；
- per-file deletion 删除 database/WAL/SHM 文件；
- 缺失路径的 open/list/fork/delete 不创建空 database；
- 测试写明宿主前置条件：worker close 先于 deletion；不承诺绕过宿主的跨进程安全。

### Identity 和路径

- 两个 physical path 上相同的 Session ID 不能交叉选中 active source storage；
- 一个 shared container 中的两个 Session ID 保持独立；
- parent 不存在时 `databasePath` 仍然成功；
- 包含 `../`、`/`、`\`、`%`、点号和 Unicode 的 explicit ID 保持在 `directory` 内，并保留 metadata ID；
- create/list/open/fork 返回的 metadata 命名实际 container。

### Close

- 一个 Session close 失败不会阻止尝试清理所有其他 Session；
- 多个失败在全部 settle 后报告；
- 重复 repository close 返回相同 promise；
- 每个成功关闭的 Session 都释放其 connection。

### 回归

- 现有 storage 和 repository conformance 在语义上保持不变；
- fork destination reservation 和同 repository source ordering 保持完整；
- fork snapshot 与此前一样排除 operation/pending/result/usage/application state；
- shared-container create/list/open/fork/delete 继续支持；
- 每个 write transaction 仍使用 `BEGIN IMMEDIATE`；
- 不出现 migration、storage-version bump、兼容层或替代 ownership primitive。

## 6. 验证和审查

每个代码切片之后：

```bash
npm run check
```

使用 repository Vitest binary，在 `packages/session-backends/sqlite-node` 中运行每个修改过的聚焦测试。最终验证：

```bash
./test.sh
```

审查节点：

1. Slice A 后由 Fable 审查：确认不再存在 storage ownership mechanism，close draining 保持完整；
2. Slice C 后由 Fable 审查：确认同 repository ordering 和 live-worker read-only overlap 都成立；
3. Fable 最终审查源码、测试、文档和排除项。

委托审查使用 provider `anthropic` 和 model `claude-fable-5`。

## 7. 排除项

不要包含：

- 任何 storage lease、lock、fence、heartbeat、takeover、tombstone 或 quarantine；
- record-only `SessionRepo` 重设计或兼容 facade；
- server/router/worker-manager 重设计；单独记录任何 backend 无关的生命周期竞态；
- SQLite branch-segment 重设计或 uncompacted-divergence 优化；
- fork scalar filtering/indexing；
- `getEntries` bind-limit 分块或通用 query-limit normalization；
- statement cache 或 stats aggregation 优化；
- catalog redesign、异步 database 替换或 VACUUM policy；
- search/FTS；
- R11 migration machinery 或 storage-version bump；
- [mobile assistant-output handoff](../mobile-handoff/01-harness/05-assistant-output/message-update.md) 变更或 JSONL compaction；
- repository-wide `SessionRepo.close()` 契约变更；
- 移除 shared-container 支持；
- transaction DSL、scheduler、通用 lock manager 或兼容层。

如果实现需要排除项，停止并修改 handoff，不要默默扩展范围。

## 8. 停止条件

满足以下条件时 WP07 完成：

- SQLite 没有活动的或 schema 定义的 writer lease，也没有替代 ownership mechanism；
- 宿主 ownership 被记录为 single-writer authority；
- 同 repository active-source fork 保留排队的 commit boundary；
- live worker-owned source 通过独立只读 snapshot fork，同时后续 WAL commit 可以继续；
- deletion 预留其同 repository 临界区，并假定 worker-first 的宿主移除顺序；
- non-creation path 不能创建空 database；
- active source identity 包含 physical container 加 Session ID；
- explicit ID 不能逃出 directory，custom database parent 会被创建；
- repository close 等待每一次清理尝试；
- shared-container mode 仍有完整覆盖；
- 聚焦测试、`npm run check` 和 `./test.sh` 通过；
- 最终 Fable 审查没有 blocker。
