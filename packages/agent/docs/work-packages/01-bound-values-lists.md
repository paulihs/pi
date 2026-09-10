# WP01 — 有界 Values 和 Lists

## 状态

已完成。`harness.md` 是规范文档。[`values.md`](../values.md) 提供详细的地址、backend 和 conformance 设计。

## 目标

在 Session、Memory、JSONL、SQLite、instrumentation、测试和公开 application access 中，用有界的 `Value<T>` 与 `ValueList<T>` 地址替换保留的 register/custom-state 存储 surface。在运行时执行消费者之前停止。

## 本工作包固定的决策

1. **核心和应用命名空间。** 每个核心地址使用文档规定的精确 `pi.*` 命名空间。应用通过同一套公开 `value()`/`list()` 构造器使用自己的非保留命名空间。删除 `fact.custom` 及其 API，不把它改名为内置 custom namespace。
2. **Fork。** 通用 fork 只复制明确处理的核心地址：Branch tip/lane configuration 加新 lane state、session name 以及目标被复制的 labels。不复制 `pi.op.*`、`pi.pending.*`、list、ledger 或任意 application address。后续应用功能若依赖复制的应用状态，必须先添加特定地址的 fork policy。
3. **可信 kind 规则。** 将同一个 `(namespace, key)` 同时用作 value 和 list 是可信编程缺陷。Backend 不增加跨 kind 冲突检查、trigger、registry 或 catalog。
4. **操作名称。** 保留源 `OperationMeta` 用于不可变 acceptance metadata，保留 `Operation` 用于进程本地 `{ meta: OperationMeta, state: OperationState }` projection。`operationMeta(id)` 绑定 `Value<OperationMeta>`；复合对象永远不作为一个 value 持久化。
5. **查询顺序和上限。** `scanValues()` 返回按 key 升序的结果。`readList()` 只限制一次查询 page，不限制 list 总长度或字节数：拒绝非正数或非 safe limit，默认 1,000，更大的值限制为 10,000。
6. **不做 WIP 兼容。** 原地替换未完成的 format-4 storage schema。JSONL 仍为 format 4/storage version 1，但只接受新的 value/list record。SQLite 保持 `SQLITE_STORAGE_VERSION = 1`，原地编辑 `001_initial.sql`，将 `registers` 重命名为 `scalar_values` 并增加 `list_values`。不支持 WP01 之前的 format-4 JSONL 和 SQLite 文件。不添加 migration runner 或 legacy decoder。
7. **只做通用基础设施。** WP01 定义所有内置 value/list constructor，包括未来的 assistant/tool address，但不实现它们的运行时 consumer。

## 公开和存储契约

添加 `packages/agent/src/harness/session/values.ts`，包含：

- 不可变的 `Value<T>` 和 `ValueList<T>` address 类型；
- 通用 `value<T>(namespace, key?)` 和 `list<T>(namespace, key?)` 构造器；
- 只做 namespace/key validation：namespace 非空，组件中不能有 `\u0000`；
- `StoredValue<T>`、`ListElement<T>`、`ListCursor` 和 `ListReadOptions`；
- 使用 `NoInfer<T>` 的类型化 `setValue`、`deleteValue`、`appendList` 和 `deleteList` 写 helper；
- `values.md` 中的每个精确内置构造器和五个 scan-prefix 构造器。

全局替换旧 API：

```ts
getRegister(namespace, key)       -> getValue(address)
listRegisters(namespace, prefix) -> scanValues(prefixAddress)
register set/delete writes        -> typed value helpers
```

Storage 和历史 Session reader、mutator、tree-view、repository surface 暴露同样的有界地址读操作：

```ts
getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;
scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;
readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]>;
```

历史 tree-view 和 Session surface 还暴露单次 commit 的直接写入：

```ts
setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void>;
deleteValue<T>(address: Value<T>): Promise<void>;
appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void>;
deleteList<T>(address: ValueList<T>): Promise<void>;
```

`SessionMutator` 保留一个显式的 `commit(writes)`，不增加直接 commit 方法。每个 write array 都可以将 helper 构造的 value/list write 与 entry 和 usage 组合起来。

保留 `getName`/`setName` 和 `getLabel`/`setLabel`，作为 `sessionName` 和 `entryLabel(id)` 的 wrapper。删除 `getCustomFact`/`setCustomFact`。将公开的被动 metadata event 从 `fact_update` 改为 `harness.md` 已规定的 `value_update` 形状；它只覆盖 session-name 和 entry-label wrapper，不覆盖任意 application write。

## 文件

### 添加

- `packages/agent/src/harness/session/values.ts`
- `packages/agent/test/harness/values.test.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session/values.ts`

### 删除或重命名

- 移动 scalar behavior 到 `values.ts` 后删除 `packages/session-backends/sqlite-node/src/sqlite/session/registers.ts`；
- 从 `packages/agent/src/harness/session/types.ts` 移除所有 register/global-map/custom-fact declaration。

### Agent 源码

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/commit.ts`
- `packages/agent/src/harness/session/storage-state.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/fork.ts`
- `packages/agent/src/harness/session/index.ts`
- `packages/agent/src/harness/session/jsonl/storage.ts`
- `packages/agent/src/harness/session/jsonl/repo.ts`
- `packages/agent/src/harness/session/testing/storage-decorator.ts`
- `packages/agent/src/harness/session/testing/instrumented-storage.ts`
- `packages/agent/src/harness/session/testing/types.ts`
- `packages/agent/src/harness/session/testing/conformance/storage.ts`
- `packages/agent/src/harness/session/testing/conformance/session-repo.ts`
- `packages/agent/src/harness/session/testing/benchmark/storage.ts`
- `packages/agent/src/harness/session/testing/benchmark/session-repo.ts`
- `packages/agent/src/harness/session/testing/index.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/telemetry.ts`
- 仅在验证新公开 export 必要时修改 `packages/agent/src/index.ts` 和 `packages/agent/src/node.ts`；不要增加第二条 export path。

### Agent 测试和生成文档

- `packages/agent/test/harness/memory-storage.test.ts`
- `packages/agent/test/harness/memory-conformance.test.ts`
- `packages/agent/test/harness/memory-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-storage.test.ts`
- `packages/agent/test/harness/jsonl-storage-conformance.test.ts`
- `packages/agent/test/harness/jsonl-session-repo.test.ts`
- `packages/agent/test/harness/jsonl-session-repo-conformance.test.ts`
- `packages/agent/test/harness/storage-backed-session.test.ts`
- `packages/agent/test/harness/session-tree.test.ts`
- `packages/agent/test/harness/session-create-lane.test.ts`
- `packages/agent/test/harness/instrumented-storage.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/telemetry.test.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- 重新生成 `packages/agent/docs/telemetry-schema.md`

### SQLite backend

- `packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql`
- `packages/session-backends/sqlite-node/src/sqlite/repo.ts`
- `packages/session-backends/sqlite-node/src/sqlite/session.ts`
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`
- 如果重命名模块需要，修改 `packages/session-backends/sqlite-node/src/sqlite/index.ts`
- `packages/session-backends/sqlite-node/test/storage.test.ts`
- `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`
- `packages/session-backends/sqlite-node/test/repo.test.ts`
- `packages/session-backends/sqlite-node/test/adapter.test.ts`
- `packages/session-backends/sqlite-node/test/sql.test.ts`

### Coding-agent consumer

- `packages/coding-agent/test/experimental-session-support.ts`
- 验证 `packages/coding-agent/test/experimental-remote-runtime.test.ts`
- 验证 `packages/coding-agent/test/experimental-server-replacement.test.ts`

如果最终旧 API grep 发现另一个保留的 source/test call site，它属于 WP01；不要为了避免触碰它而增加兼容垫片。

## 工作顺序

1. **添加地址词汇。** 实现 `values.ts`，通过现有 session/root path 导出，并添加聚焦的编译期/运行时 address 测试。在迁移 caller 前，先覆盖精确内置 namespace/key/kind 和 prefix-constructor 测试。
2. **一次切断共享 API。** 替换 `types.ts`/`commit.ts` 中的 register 类型和写入；将 `StorageState` 拆为当前 scalar value 和存活 list element；实现 Memory read/write、有序 prefix scan、分页 list read、transaction validation/application、snapshot 和直接 Session method。移除 custom-fact API，迁移 name/label wrapper。
3. **迁移 JSONL 和通用 fork/snapshot code。** 只编码 `kind:"value"` 和 `kind:"list"`；重放 set/delete/append/delete；保留 transaction-line torn-tail 原子性；以原始 `seq` 在全局 sequence order 中合并存活 list element；保留 sequence high-water mark。这只扩展已有 snapshot serialization——不要增加新的 compaction trigger 或 precise-rewrite feature。Fork 复制 Decisions 第 2 项的固定核心集合，像现在一样在复制 entry 后重新编号 destination scalar value，不复制 list。
4. **迁移 instrumentation、conformance 和 benchmark。** Storage decorator 暴露三种 read；instrumented storage 按精确顺序记录擦除后的 value/list write，但 telemetry 不含内容。在 backend-specific assertion 前扩展 shared conformance。
5. **迁移 Runtime2 shell call site。** 用内置 constructor/helper 替换 lane/harness raw write。`restore.ts` 使用 `scanValues(branchTipInventoryPrefix())` 加精确 `getValue` lookup，不调用 `readList()`。不要增加 acceptance、drive、hydration 或 cleanup 行为。
6. **替换 SQLite WIP schema 和 adapter。** 原地编辑 `001_initial.sql`，在 `session/values.ts` 中实现 scalar operation 和带 index 的 list append/delete/paging，让每次 write 保持在现有 `BEGIN IMMEDIATE` writer-lease transaction 内，更新两条 fork snapshot 路径，并保留当前 `dev` 中所有 entry/usage/branch/lease 行为。
7. **迁移公开 event、测试和 coding-agent helper。** 移除旧 type assertion 和 raw namespace。把 `fact_update` 改为 `value_update`。保留两个 remote prompt test 的 skip 以及现有 WP00 原因；WP01 不得修改 runtime execution。
8. **更新 telemetry 和文档。** 将 `pi.session.write` item kind 从 `register` 改为 `value` 和 `list`，重新生成 `telemetry-schema.md`，运行旧 API sweep，并记录任何因 branch policy 延迟的 changelog 要求。除非 `gramps` 成为 pull-request branch 或用户要求，否则不要编辑 changelog。

## Backend 要求

### Memory

- 在修改 entry、value、list、usage 或 stats 前准备并验证完整 transaction；
- 当前 scalar replacement 只存最新 value 和 set `seq`；
- list append 不读取 list，并为每个 global write 存储 `seq`；
- list delete 删除整个精确 key；
- snapshot 包含当前 scalar value 和存活 list element。

### JSONL

- 保持 format 4/storage version 1，不解码 legacy register；
- 单次写入 object 或多写入 array 仍是一条 atomic line；
- replay 产生与 Memory 相同的逻辑状态；
- torn final line 不暴露部分 transaction；
- snapshot serialization 保留存活 list-element sequence 和 next-sequence high-water mark。

### SQLite

使用：

```sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

升序和降序 list query 使用 primary key、exclusive sequence predicate 和 `LIMIT`。添加 `EXPLAIN QUERY PLAN` assertion，证明没有 table scan 或临时 ordering b-tree。不要改变 storage version、添加 migration 或削弱现有 lease/fence/fork 行为。

## 必需覆盖

### Address 和类型测试

- 不变量 address typing 以及推断的 scalar/list result type；
- `NoInfer` 拒绝不兼容的 set/append value；
- scalar helper 拒绝 list address，list helper 拒绝 scalar address；
- 独立构造的相同 address 解析到同一位置；
- 空 key 可用；空 namespace 和包含 `\u0000` 的组件拒绝；
- 精确内置 namespace、key grammar 和恰好五个 prefix constructor；
- application-wide 和 dynamic non-reserved address 不需要第二个 operation-time key；
- 没有 registry、catalog、privilege constructor、global value map 或运行时 `pi.*` gate。

### Shared scalar/list conformance

- scalar set/get/delete/delete-absent/recreate 和 latest set `seq`；
- namespace-scoped、key-ascending prefix scan；
- append 一个和多个 element，包括一个 transaction 内的多个 append；
- 与无关 write 分隔的 append 保留每个 list 的顺序和 global element sequence；
- ascending/descending exclusive cursor；
- 默认、显式、无效和 clamp 的 query-page limit；
- absent list、whole-list delete、delete-absent 和 delete-then-append；
- atomic entry + usage + value + list transaction；
- 任意 sibling write 无效时 rollback；
- append 不读取 list；
- close 拒绝后续 read，同时 drain 已准入 commit。

不要添加 value/list collision test：跨 kind misuse 是有意不强制的 trusted-programming defect。

### Backend 和 repository 测试

- Memory/JSONL/SQLite page 和 cursor 相同；
- JSONL single/multi-write replay、torn-tail 行为和保留 sequence 的 snapshot output；
- SQLite query plan 和 writer-lease transaction 行为；
- branch/tree fork 复制 session name、符合条件的 label 和 lane configuration/Branch tip，并使用新 lane state；
- fork 排除 operation/pending value、所有 list、application address、last result、queue 和 ledger row；
- repository parent metadata、entry ID、stats、branch index、v3 normalization、UUIDv7/follower ID 以及当前 SQLite lease/fork 场景保持不变；
- Runtime2 restore 通过唯一 prefix constructor 枚举 lane，且不读取 list。

## 延后的 Consumer

以下 `values.md` 要求明确不属于 WP01 coverage：

- assistant frame conversion、append scheduling、settlement、recovery、cancellation、snapshot hydration 和 byte-growth test（R2/R3/R6/R12）；
- invocation `getMemo`/`setMemo`、tool-output checkpoint write、outcome cleanup 和 prefix-driven operation cleanup（R4/R6）；
- 除证明 base restore 不读取 list 外的任何 consumption-time list hydration；
- runtime acceptance、driving、provider/tool effect 或 operation-state redesign。

WP01 仍导出 `pendingAssistantFrames`、`operationToolMemo`、`pendingToolOutput` 和每个 cleanup prefix，使后续包不必重设计存储。

## 移除检查

以下内容在保留的 source/test 中必须为零匹配，immutable released changelog history 和 archived prose 除外：

```bash
rg -n 'getRegister\(|listRegisters\(|RegisterValues|RegisterNamespace|RegisterSetWrite|\bRegister<' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n 'kind: "register"|getCustomFact\(|setCustomFact\(|fact\.(name|label|custom)|fact_update' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '"(branch\.tip|lane\.(config|state|lastResult)|op\.(meta|state|tool_args|preparation)|pending\.entry)"' \
  packages/agent packages/session-backends/sqlite-node packages/coding-agent \
  --glob '!**/dist/**' --glob '!**/CHANGELOG.md' --glob '!**/docs/**'

rg -n '\bregisters\b' packages/agent/src/harness/session packages/session-backends/sqlite-node/src \
  --glob '*.ts' --glob '*.sql'

rg -n '"register"' \
  packages/agent/src/harness/telemetry.ts \
  packages/agent/test/harness/telemetry.test.ts \
  packages/agent/docs/telemetry-schema.md
```

不要把无关的 model/provider/hook registration 术语当作 storage API 残留。

## 验证

直接运行每个新建或修改的测试文件，循环修复直到通过。最低要求：

```bash
# From packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/values.test.ts \
  test/harness/memory-storage.test.ts \
  test/harness/memory-conformance.test.ts \
  test/harness/memory-session-repo.test.ts \
  test/harness/jsonl-storage.test.ts \
  test/harness/jsonl-storage-conformance.test.ts \
  test/harness/jsonl-session-repo.test.ts \
  test/harness/jsonl-session-repo-conformance.test.ts \
  test/harness/storage-backed-session.test.ts \
  test/harness/session-tree.test.ts \
  test/harness/session-create-lane.test.ts \
  test/harness/instrumented-storage.test.ts \
  test/harness/types.test.ts \
  test/harness/telemetry.test.ts \
  test/harness/runtime2/harness.test.ts \
  test/harness/runtime2/lane.test.ts \
  test/harness/runtime2/restore.test.ts

# From packages/session-backends/sqlite-node
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/adapter.test.ts \
  test/repo.test.ts \
  test/sql.test.ts \
  test/storage.test.ts \
  test/storage-conformance.test.ts

# From packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/experimental-remote-runtime.test.ts \
  test/experimental-server-replacement.test.ts
```

然后从 repository root 运行：

```bash
cd packages/agent && npm run check:telemetry-docs
cd "$(git rev-parse --show-toplevel)"
node_modules/.bin/tsgo --noEmit -p packages/agent/tsconfig.build.json
node_modules/.bin/tsgo --noEmit
git diff --check
npm run check
./test.sh
```

不要运行不受限 Vitest、`npm test`、付费 provider 测试或 `npm run build`。

## 停止条件

所有保留的 backend 和 Session surface 都使用有界 values/lists；所有核心 address 使用精确的 `pi.*` grammar；任意 application address 可用但通用 fork 会排除它们；旧 register/fact/custom-state API 和物理名称均不存在；base restore 不读取 list；上述 schema/兼容决策已实现；聚焦、conformance、TypeScript、telemetry-doc、diff 和 repository 检查通过。报告最终 schema 和 fork 行为。不要开始 runtime acceptance、assistant/tool consumer 或后续工作包。
