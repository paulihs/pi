# 作用域存储第 1 步 — 可执行实现 handoff

**状态：可执行，尚未实现。**

**基线：** c4b0e35ab（dev）。若实现基线有实质变化，应重新审计指定源码。

本 handoff 只实现 storage scopes。与 scopes.md 冲突时以本文为准，尤其是可复用 scope ID、每 scope 全局序号、显式 retirement、sidecar 布局和 Step 1/Step 2 的边界。Step 2 的 Chord 编码、地址 intern 和 compact tuple 是独立工作包，必须在 Step 1 完成测试、评审、获得用户明确批准、提交并 push 后才能开始。

## 0. 交付流程

1. 只实现 Step 1；
2. 运行 focused tests、npm run check、./test.sh；
3. 检查完整 diff 并报告结果；
4. 停止，等待用户明确批准；
5. 批准后只提交本包文件并 push；
6. 确认 push 的 commit 后，才能开始 Step 2。

不得合并两个步骤，也不得提前 commit/push。

## 1. 必读内容

完整阅读 harness.md、values.md、mobile-handoff README、scopes.md、delta.md 的 vocabulary、harness-tools.md、message-update.md、session/JSONL/SQLite 实现、runtime progress/lane、drive 的相关模块、operationCleanupWrites 调用方、共享 conformance、focused tests 和 scopes.variance.ts。Step 1 不存储 Chord op；Format 4 仍是 WIP，不包含 R11 migration；不要使用 dist/ 作为实现输入。

## 2. 固定 scope 契约

### 2.1 运行时 scope identity

scope ID 是可复用的逻辑生命周期名，不是一次性全局 token：

~~~ts
export type SessionScope = { readonly kind: "session" };

export interface EphemeralScope {
  readonly kind: "ephemeral";
  readonly id: string;
}

export type Scope = SessionScope | EphemeralScope;

export function ephemeralScope(id: string): EphemeralScope;
~~~

ephemeralScope 要求非空、合法 Unicode string，返回 frozen value。相同 ID 表示同一物理 scope，对象 identity 无意义。JSONL 使用 encodeURIComponent；编码后组件最多 180 个 ASCII 字符，拒绝过长 ID 和 lone surrogate。物理文件始终有固定 scope- 前缀，不能把未编码 caller input 直接插入路径。

不存在 create/open-scope transaction；首次 scoped value/list write 创建物理状态。retireScope(scope) 以其全局序号结束 scope；退休后同一 ID 的写入开启新的逻辑生命周期。Harness operation scope 使用 ephemeralScope(operationId)，普通应用可以使用稳定名称。Storage 不解析 scope ID，也不读取 Harness operation state 推断生命周期。

### 2.2 复用和 retirement 边界

~~~text
seq 10  scoped write S
seq 20  scoped write S
seq 30  retireScope(S)
seq 40  scoped write S  # 新生命周期
~~~

同一 ID 只有 seq 大于最新 retirement seq 的 scoped record 才是 live。Memory/SQLite 在 retirement 时删除当前 rows/maps；JSONL 用 retirement seq 作为 replay boundary。没有当前 state 时 retirement 仍合法且推进边界；Storage 不维护历史 ID registry，也不因复用拒绝。

late assistant/tool progress 不能在 terminal retirement 后重建 output，必须由 Harness invocation fence 和 settlement drain 保证，并增加回归测试。

### 2.3 显式 retirement 是唯一权威

~~~ts
export function retireScope(scope: EphemeralScope): Write<SessionScope>;
~~~

Storage 不从 operation absence、namespace、current state 或 owner 缺失推断 orphan。owner 不退休属于 owner defect，scope 保持 live。

崩溃前后：

- retirement transaction 提交前崩溃：scope 仍 live；
- retirement 已提交但 JSONL unlink 未完成：replay 忽略边界前 sidecar，reopen 重试删除；
- 之后复用的 lifetime：只恢复最新 retirement 后的记录。

Repository delete 另行删除 Session 的全部 sidecar，不使用 operation 语义。

### 2.4 地址和写入类型

地址 scope tag 协变，写入 scope tag 不变；Value 的 T 不变性独立保留：

~~~ts
interface Value<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }
interface ValueList<T, Sc extends Scope = SessionScope> { /* existing fields + scope */ }

declare function value<T>(namespace: string, key?: string): Value<T, SessionScope>;
declare function value<T>(namespace: string, key: string, scope: EphemeralScope): Value<T, EphemeralScope>;
declare function list<T>(namespace: string, key?: string): ValueList<T, SessionScope>;
declare function list<T>(namespace: string, key: string, scope: EphemeralScope): ValueList<T, EphemeralScope>;
~~~

session 地址没有 runtime scope ID，ephemeral 地址携带 ID；scope 属于 physical identity。setValue、deleteValue、appendList、deleteList 在 Write<Sc> 中保留 scope。entry、usage 和 retireScope write 属于 session scope。

普通事务只能有一个静态 scope：session transaction 可包含 session values、entries、usage 和 retireScope，但不能直接包含 ephemeral set/delete/append；ephemeral transaction 只能包含 value/list。运行时需断言同一事务的 ephemeral writes 拥有相同 scope ID。只做必要的泛化，贯穿 Write、CommittedWrite、Storage.commit、Session mutation、CommitDecision 和 lane command，不要让只读 reader 变成 invariant。

### 2.5 一个全局序号空间

Memory、JSONL 主记录、sidecar 记录和 SQLite rows 共用 Session-global seq。commit 按 admission order 串行并递增分配；gap 合法。Memory 用一个 nextSeq，SQLite 从 sessions.next_seq 分配，JSONL 主/sidecar 共享 queue 和 resident nextSeq。

JSONL open 必须在删除/忽略 retirement sidecar 前，从 header 和所有完整主/sidecar record 计算 high-water。退休记录的 seq 可成为 gap，但不能复用；torn uncommitted final transaction 不推进 high-water。不允许 reservation record、per-scope counter 或 range allocator。

## 3. List tag

~~~ts
export interface ListElement<T> {
  seq: number;
  value: T;
  tag?: string;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
  stopAtTag?: string;
}

export function appendList<T, Sc extends Scope>(
  address: ValueList<T, Sc>,
  element: NoInfer<T>,
  tag?: string,
): ListAppendWrite<Sc>;
~~~

tag 存在时必须非空；Storage 只保存和返回 tag，不解释 element。读取依次应用 scope、exclusive cursor、order，最多检查归一化 limit 个元素，包含第一个 stopAtTag 后停止。stopAtTag 不搜索超过 page limit；未出现时继续从最后 seq 分页。不要增加 draft tag filter。SQLite 可在取出 indexed rows 后由 TypeScript 截断，仍不得解析 payload。

## 4. Durable payload 保持不变

本步骤只改变 lifetime/routing：

- pendingToolOutput 是 EphemeralScope 的 Value；
- pendingAssistantFrames 是 EphemeralScope 的 ValueList；
- operationToolMemo 仍为 JsonValue；
- JSONL record 仍是 keyed object；
- 每个 accepted assistant frame 仍追加一次；
- tool checkpoint 仍替换完整 snapshot；
- message_update/tool_update shape 不变；
- safe replay 保留当前 checkpoint 行为和已知 bug。

不要重命名 pendingAssistantFrames、引入 pendingAssistantOutput、存 WireOp[]、增加 Chord tracker/codec、重设计 AgentHarnessTool 或改变 cadence。

## 5. Runtime ownership 与 cleanup

### 5.1 Operation scope 地址

用 ephemeralScope(operationId) 构造 operationToolMemo、pendingToolOutput、pendingAssistantFrames。pi.op.state、pi.op.meta、pi.op.tool_args、pi.op.preparation、pi.pending.entry 等保持 session scope，因为它们需和 lane/operation state 原子协调。

### 5.2 不做跨文件 cleanup transaction

从同时写 session state 的 assistant settlement、deferred supersession、tool outcome staging、cancellation/recovery 和 terminal per-address cleanup 中移除直接 ephemeral delete。tool-placement.ts 当前没有此类 delete，不要添加。

operationCleanupWrites 保留 session-scoped cleanup，并在 universal terminal suffix 中恰好加入 retireScope(ephemeralScope(operationId))。删除 tool memo/output scan 和 assistant-frame delete 后，移除 operationToolMemoPrefix、pendingToolOutputPrefix，并把规范中的 prefix constructor 数量从五改为三。ephemeral-only delete 仍合法，例如 safe-replay checkpoint delete。

### 5.3 Unreachable scoped residue

child settle 后，旧 frame/checkpoint/memo 可能仍在活动 scope 内，但不得被 snapshot/recovery 消费或作为权威。terminal retirement 与 operation completion 一起删除整个 scope。称为 unreachable scoped residue，不要称 orphan。close/fault 是受控崩溃，不 retirement；reopen 只从当前 authoritative operation state 推导地址。

## 6. JSONL sidecar

### 6.1 布局

每个主文件拥有固定 sidecar directory，名称为主文件路径加 .scopes，懒创建并递归创建。sidecar 文件名为 scope- 加 encodeURIComponent(scope.id) 加 .scope，编码组件最多 180 字符；后缀不是 .jsonl，repository listing 不会把它误认为 Session。

header：

~~~ts
interface JsonlScopeHeader {
  v: 4;
  kind: "scope_header";
  sessionId: string;
  scopeId: string;
  storageVersion: 1;
}
~~~

replay 前校验 session/scope identity。首次创建使用目录内 temp file 加 atomic rename；.tmp 不参与发现。使用现有 FileSystem，不增加 dirname、JsonlStorageOptions 或 Node-only core access。

### 6.2 Retirement record

主日志写入：

~~~ts
interface CommittedScopeRetireWrite {
  kind: "scope";
  op: "retire";
  seq: number;
  scopeId: string;
}
~~~

不使用 Step 2 的 compact tuple。应用 retirement 删除 resident scope values/lists；主事务 durable 后在同一 commit queue 中关闭 sidecar、尝试 unlink，再释放 queue。unlink 失败不影响已提交 transaction，reopen 重试。

### 6.3 Replay 与可复用 ID

open 顺序：

1. 读取/修复主文件并解析完整事务；
2. 发现并校验匹配 sidecar；
3. 解析/修复完整 sidecar transaction；
4. 用 header 和全部完整 record（包括后续会被 retirement 排除的 record）计算 high-water；
5. 找到每个 scope 最新 retirement seq；
6. 保留 seq 大于边界的 sidecar write；
7. 按 global seq 合并主/sidecar并 replay，保留 transaction boundary，拒绝重复/非单调 seq；
8. 推进到 high-water；
9. 删除最新 retirement 后没有 record 的 sidecar。

retirement 后的 record 表示新的 active lifetime，不能删除；cleanup 必须与后续 write 串行，避免旧 unlink 删除新复用 sidecar。active sidecar 的 malformed interior record 或 identity mismatch 使 open 失败；torn final transaction 整体丢弃；temp file 只是 cleanup artifact。

### 6.4 Legacy v3、Repository、Fork

v3 没有 scope；普通 Harness acceptance 会先提交 session state，因此正常路径先升级。也要测试首个 write 是 ephemeral 时的 v3→v4 调整，并保持全局 commit queue。

Repository.list 忽略 sidecar directory，delete 删除主文件后递归删除 sidecar；close 不因 handle 关闭而 retirement。fork 保持旧 allowlist，不复制 ephemeral values/lists，目标不含 sidecar/retirement state。J1 compaction 不在范围内。

## 7. Memory 后端

InMemoryStorageState 的 value/list identity 加 scope；保留一个 global nextSeq。应用 retirement 时，在同一同步事务中删除精确 scope 的全部 scalar/list，不删除 entry/usage；同 ID 后续写入自然重建。snapshot 暴露 scope 供 fork 排除；instrumentation 记录 retirement 在内的精确顺序。

## 8. SQLite 后端

原地修改 WIP schema，不做 migration：

~~~sql
scalar_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(session_id, scope_id, namespace, key)
) WITHOUT ROWID;

list_values(
  session_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value TEXT NOT NULL,
  tag TEXT,
  PRIMARY KEY(session_id, scope_id, namespace, key, seq)
) WITHOUT ROWID;
~~~

session scope 使用 scope_id = ''。所有 point read、prefix scan、set/delete、append/delete、snapshot 和 query plan 都包含 scope identity。retirement 在 BEGIN IMMEDIATE 内执行 scoped scalar/list DELETE，仍消耗 sessions.next_seq；rollback 必须恢复 scoped rows 与 sibling main writes。fork 只复制 scope_id = ''。

## 9. 必需测试

### 类型与构造器

覆盖默认 SessionScope、ephemeral overload、地址读协变/写不变、同 scope transaction、Session write + retirement、混合 scope 编译失败、不同 ephemeral ID 的 runtime assertion、object identity、空/超长 ID、Unicode/path encoding，以及相同 namespace/key 的 session/ephemeral 不 alias。

### 共享后端 conformance

Memory/JSONL/SQLite 一致覆盖 scalar/list 生命周期、独立 scope、混合 scope 拒绝、retirement 精确删除、retirement 与 session sibling 原子、空 retirement、复用和重复 retirement、全局 seq/gap、tag/limit/stopAtTag、stats、close/reopen。

### JSONL

覆盖首次 scoped write 的 sidecar、单行 scoped transaction、全局 seq replay/high-water、torn/malformed/identity mismatch、retirement 前后崩溃、unlink failure、ID reuse/cleanup race、listing/delete、fork 排除、v3、close/reopen。

### SQLite

覆盖 scope_id schema/query、tag、原子 retirement/rollback、reuse、next_seq、主键分页、per-file/shared-container、fork 和 Session deletion。

### Harness 集成

更新 exact-write 测试：settlement/staging 不混合 scope delete；residue 不被 snapshot/recovery 消费；terminal leaf retirement 一次；close/fault 不 retirement；late progress 不能重建；terminal cleanup 不 scan memo/output prefix；所有 operation family/cancellation 的 cleanup caller 都覆盖。

## 10. 实现切片

### Slice A — 契约、类型、Memory、list tag

新增 session/scope.ts，修改 session types/values/commit/in-memory-storage-state/memory/session/index、storage test helper、Memory tests 和 scopes.variance.ts。先完成 scope type、retirement、tag、Memory identity/global seq/snapshot，再通过 type/conformance。

### Slice B — SQLite

修改 001_initial.sql、SQLite storage/repo/session-sequences/values 和 tests：加入 scope/tag、atomic retirement、global seq、stats、branch index、shared-container，fork 排除 ephemeral。

### Slice C — JSONL sidecar

新增 jsonl/scope-files.ts，修改 JSONL types/codec/storage/repo/legacy-v3/index 和 tests：实现 naming/header/discovery、scoped routing、global replay/high-water、reusable boundary、torn tail、corruption、v3、listing/delete/close/fork。

### Slice D — Harness migration

scope memo/tool/frame address；移除 mixed-scope delete/scan；universal suffix 加 retirement；保持 output/replay/event 行为；证明 late-write fence 和所有 terminal/close/recovery 路径。

### Slice E — 文档与最终校验

更新 harness.md、values.md、roadmap、mobile handoff、scopes.md、SQLite README；telemetry 只增加 scope session-write item kind，不实现 span。历史 WP00–WP07 和 released changelog 不改。每个 slice 运行 focused tests，最终运行 npm run check、./test.sh。

## 11. 排除项

不包括 Chord/WireOp storage integration、JSONL interning/compact tuple、pending-output rename、ToolOutput/API/replay/progress/rate-limit/exec-env、message_update/assistant reducer/protocol redesign、J1 compaction、WP08 fork redesign、repository lifecycle、超出 schema 声明的 telemetry、旧 WIP SQLite migration/compatibility、应用自动 scope ownership、operation-derived orphan inference、lease、TTL 和 background collection。

若实现需要排除项，先停止并修订 handoff。

## 12. Grep guards

最终检查 operationToolMemoPrefix、pendingToolOutputPrefix、ephemeral delete、scopeId、retireScope、stopAtTag。预期没有 session transaction 直接删除 ephemeral、没有 terminal path 漏 retirement、没有 backend read/write 漏 scope、没有 fork 复制 ephemeral、sidecar 不被当 Session 文件、没有 per-scope counter、没有 operation-state/orphan inference。

## 13. 完成条件

Step 1 完成时，类型与 runtime 都拒绝 mixed-scope transaction；ID 能按最新 retirement 的全局 seq 边界复用；Memory/JSONL/SQLite 共用全局 seq 并通过 conformance；SQLite 原子删除精确 scope；JSONL 只把 ephemeral 写入 sidecar、主日志记录 retirement、按全局顺序 replay、保持 high-water 并不依赖 operation inference；tag/stopAtTag 一致；tool/assistant payload/event 不变；terminal path 恰好 retirement 一次，close/fault 保留 active recovery；fork 和 repository listing/delete 正确；focused tests、npm run check、./test.sh 和 final review 通过。

将完整 diff 与结果展示给用户并停止等待批准。只有明确批准后才能 commit/push Step 1；确认 push 后才开始 Step 2。
