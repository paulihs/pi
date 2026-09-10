# 类型化值与列表

本文规定 Session、harness 和应用使用的可变持久化存储原语。

公开抽象是绑定的类型化地址：

- value<T>(namespace, key?) 表示一个可替换的持久化值；
- list<T>(namespace, key?) 表示一个追加式持久化列表，元素类型为 T。

namespace/key 在构造地址时绑定一次，后续操作只接收该地址：

~~~ts
const state = value<ApplicationState>("my-app.state");
const events = list<ApplicationEvent>("my-app.events");

await session.getValue(state, context);
await session.setValue(state, nextState, context);
await session.readList(events, { limit: 100 }, context);
await session.appendList(events, event, context);
~~~

调用方不再重复传入第二个含义不明的 key。若应用确实有按 key 区分的实例，应为该实例构造地址：

~~~ts
const workspaceEvents = (workspaceId: string) =>
  list<ApplicationEvent>("my-app.events", workspaceId);

await session.readList(workspaceEvents("pi"), { limit: 100 }, context);
~~~

存储可以将地址物理索引为 kind、namespace、key，但这种表示不应泄漏到每次读写调用中。Storage、Session、harness 和应用使用同一套地址词汇；不再有全局 value 类型表、动态注册表、token 目录或独立的应用状态存储机制。

## 目标

1. 一个精确的持久化地址对应一个编译期值类型。
2. 应用可以定义标量值和列表，不需要 declaration merging，也不需要修改核心类型表。
3. Storage 到 Session 再到应用使用相同的类型化地址和操作名称。
4. 保持当前标量替换语义。
5. 追加一个列表元素时不读取或重写已有元素。
6. 每个列表元素使用现有的 session 全局事务 seq，并以此排序和分页。
7. 值、列表元素可以和 entry、usage 原子提交。
8. Memory、JSONL、SQLite 产生一致的逻辑行为。
9. 列表读取有明确且有界的范围。
10. 标量操作状态保持权威；辅助列表不能选择恢复状态。

## 非目标

本阶段不定义：

- assistant frame 的内容或归约语义；
- 工具进度语义；
- 受信任进程内值的运行时校验；
- 单元素或单列表字节限制；
- 列表截断或单元素删除；
- 通用事件日志、journal、流恢复协议或 operation reducer；
- 全局注册地址对象；
- 向工具暴露原始 Session 或事务访问。

调用方负责地址构造、内容限制、清理时机、fork 策略、迁移策略和消费时 hydration。assistant-durability.md 定义第一个列表消费者。

## 绑定地址模型

~~~ts
declare const storedValueType: unique symbol;

interface StoredAddressBase {
  readonly namespace: string;
  readonly key: string;
  readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
  readonly kind: "value";
  readonly [storedValueType]?: (value: T) => T;
}

export interface ValueList<T> extends StoredAddressBase {
  readonly kind: "list";
  readonly [storedValueType]?: (value: T) => T;
}

export function value<T>(namespace: string, key = ""): Value<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "value" });
}

export function list<T>(namespace: string, key = ""): ValueList<T> {
  validateAddress(namespace, key);
  return Object.freeze({ namespace, key, kind: "list" });
}
~~~

phantom function 使 T 保持不变性：一个类型的地址不能静默扩大为另一个类型，运行时不保存该字段。

约束如下：

- namespace 不能为空；
- pi 和所有 pi.* namespace 按契约保留给内置地址；
- 应用构造保留地址属于受信任代码的编程缺陷，不增加运行时权限分层、注册表或目录；
- 任一组件都不能包含 Memory 后端使用的内部分隔符 U+0000；
- 空 key 合法，适合表示应用级单值或单列表；
- 对象身份没有持久化意义；
- kind、namespace、key 相同但分别构造的地址指向同一持久化位置；
- 为同一地址使用不兼容的 TypeScript 类型是受信任程序的缺陷；
- 同一个 storage version 中，标量地址和列表地址不能共用 namespace/key；存储不做跨 kind 冲突检查；
- 修改 namespace、key、kind 或不兼容的值形状需要迁移。

两个组件保持分离，不拼接为单一字符串。因此动态应用 key 和 operation ID 除了不能使用存储分隔符外，不需要额外转义约定。

### 精确地址，而不是地址族

一个地址只表示一个值或一个列表。内部代码遇到动态 key 时使用小型构造器：

~~~ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);

export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);

export const operationToolArgs = (
  operationId: string,
  stepId: string,
  sourceIndex: number,
) => value<Record<string, JsonValue>>(
  "pi.op.tool_args",
  operationId + ":" + stepId + ":" + sourceIndex,
);

export const pendingAssistantFrames = (
  operationId: string,
  responseEntryId: string,
) => list<AssistantMessageFrame>(
  "pi.pending.assistant_frame",
  operationId + ":" + responseEntryId,
);
~~~

每种 key 语法封装在其所有者中，调用方拿到的是已经绑定的类型化地址：

~~~ts
await reader.getValue(operationState(operationId));
await reader.readList(pendingAssistantFrames(operationId, responseEntryId), options);
~~~

### 不使用全局 value 类型表

删除现有的全局 namespace-to-type 映射：

~~~ts
interface RegisterValues { /* 删除 */ }
interface ListRegisterValues { /* 删除 */ }
type RegisterNamespace = keyof RegisterValues; // 删除
~~~

类型归属于地址构造器：

~~~ts
export const applicationState = value<MyApplicationState>("my-app.state");
export const applicationEvents = list<MyApplicationEvent>("my-app.events");
~~~

应用应使用稳定且不易冲突的 namespace 前缀。pi 和完整的 pi.* 前缀按契约保留给内置地址；类似 pi2 的名称仍然合法。核心代码和应用都使用 value()、list()；测试会断言所有内置地址使用保留前缀。不存在运行时权限分层、注册表或目录。

## 内置地址

内置构造器统一位于 packages/agent/src/harness/session/values.ts，由调用方直接导入。典型定义如下：

~~~ts
export const branchTip = (lane: string) =>
  value<string | null>("pi.branch.tip", lane);
export const laneConfig = (lane: string) =>
  value<LaneConfiguration>("pi.lane.config", lane);
export const laneState = (lane: string) =>
  value<LaneState>("pi.lane.state", lane);
export const operationResult = (operationId: string) =>
  value<OperationResultRecord>("pi.result", operationId);

export const branchTipInventoryPrefix = () =>
  value<string | null>("pi.branch.tip");

export const operationMeta = (operationId: string) =>
  value<OperationMeta>("pi.op.meta", operationId);
export const operationState = (operationId: string) =>
  value<OperationState>("pi.op.state", operationId);
export const operationToolArgs = (operationId: string, stepId: string, sourceIndex: number) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    operationId + ":" + stepId + ":" + sourceIndex,
  );
export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", operationId + ":" + invocationId + ":" + name);
export const operationPreparation = (operationId: string, taskId: string) =>
  value<DurableStructuralPreparation>(
    "pi.op.preparation",
    operationId + ":" + taskId,
  );

export const operationToolArgsPrefix = (operationId: string, stepId?: string) =>
  value<Record<string, JsonValue>>(
    "pi.op.tool_args",
    stepId === undefined ? operationId + ":" : operationId + ":" + stepId + ":",
  );
export const operationToolMemoPrefix = (operationId: string, invocationId?: string) =>
  value<JsonValue>(
    "pi.op.tool_memo",
    invocationId === undefined ? operationId + ":" : operationId + ":" + invocationId + ":",
  );
export const operationPreparationPrefix = (operationId: string) =>
  value<DurableStructuralPreparation>("pi.op.preparation", operationId + ":");

export const pendingEntry = (entryId: string) =>
  value<PendingEntry>("pi.pending.entry", entryId);
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  value<AgentToolResult<unknown>>(
    "pi.pending.tool_output",
    operationId + ":" + invocationId,
  );
export const pendingAssistantFrames = (operationId: string, responseEntryId: string) =>
  list<AssistantMessageFrame>(
    "pi.pending.assistant_frame",
    operationId + ":" + responseEntryId,
  );
export const pendingToolOutputPrefix = (operationId: string) =>
  value<AgentToolResult<unknown>>("pi.pending.tool_output", operationId + ":");

export const sessionName = value<string>("pi.session.name");
export const entryLabel = (entryId: string) => value<string>("pi.entry.label", entryId);
~~~

OperationMeta 是存放在 pi.op.meta 的不可变接受元数据。进程内 Operation 投影由独立的 meta 和 state 组装，形状为 { meta: OperationMeta, state: OperationState }，不会合并存放在单一地址。

导出的五个 scan 前缀构造器是 branchTipInventoryPrefix、operationToolArgsPrefix、operationToolMemoPrefix、operationPreparationPrefix 和 pendingToolOutputPrefix；它们只能传给 scanValues()。

应用直接定义自己的 value() 和 list() 地址，不需要内置的 custom application-state namespace 或 custom-state API。AgentHarnessToolInvocation.getMemo()、setMemo() 是受 invocation fence 约束的 operationToolMemo(...) 能力，而不是原始 Session 访问。invocation memo 归操作所有，在工具结果持久化后删除。

测试应断言内置构造器生成正确的 kind、namespace 和 key 语法。构造器可能使用动态 key，因此不存在枚举所有可能地址的运行时目录。

## 共享读取 API

Storage、Session、SessionReader、SessionMutator 使用相同的读取签名：

~~~ts
export interface StoredValue<T> {
  address: Value<T>;
  value: T;
  seq: number;
}

export interface ListElement<T> {
  seq: number;
  value: T;
}

export interface ListCursor {
  seq: number;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
}

interface ValueReader {
  getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined>;
  scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]>;
  readList<T>(
    address: ValueList<T>,
    options?: ListReadOptions,
  ): Promise<ListElement<T>[]>;
}
~~~

scanValues(prefixAddress) 扫描 namespace 完全相同且 key 以绑定 key 开头的标量地址，按 key 升序返回。核心调用点只能使用上述导出的前缀构造器；原始 namespace/key 语法保留在 session/values.ts。前缀地址只能传给 scanValues()，不能用于精确的 get/set/delete。不存在不受限的跨 namespace dump，普通应用读取使用精确地址。

Session 暴露使用同一地址的单转换写入：

~~~ts
interface Session extends ValueReader {
  setValue<T>(
    address: Value<T>,
    next: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
  appendList<T>(
    address: ValueList<T>,
    element: NoInfer<T>,
    context: Context,
  ): Promise<void>;
  deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
}
~~~

getName()、setName()、getLabel()、setLabel() 等用途明确的 helper 可以保留为内置地址的薄封装。应用直接定义和使用自己的标量/列表地址。

SessionMutator 仍然是读取能力加一个原子 commit(writes)。它不暴露会分别消耗唯一提交机会的直接 setValue()/appendList()；调用方构造类型化写入数组后一次提交。

## 类型化事务写入

写入通过类型化 helper 构造。entry 和 usage 构造器隐藏存储 discriminant；value/list 只有在 helper 检查地址和值类型关系之后才擦除类型：

~~~ts
interface EntryWrite {
  kind: "entry";
  entry: NewEntry;
}

interface UsageWrite {
  kind: "usage";
  row: Omit<UsageRow, "seq">;
}

interface ValueSetWrite {
  kind: "value";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

interface ValueDeleteWrite {
  kind: "value";
  op: "delete";
  namespace: string;
  key: string;
}

interface ListAppendWrite {
  kind: "list";
  op: "append";
  namespace: string;
  key: string;
  value: unknown;
}

interface ListDeleteWrite {
  kind: "list";
  op: "delete";
  namespace: string;
  key: string;
}

export function insertEntry(entry: NewEntry): EntryWrite;
export function insertUsage(row: Omit<UsageRow, "seq">): UsageWrite;
export function setValue<T>(address: Value<T>, next: NoInfer<T>): ValueSetWrite;
export function deleteValue<T>(address: Value<T>): ValueDeleteWrite;
export function appendList<T>(address: ValueList<T>, element: NoInfer<T>): ListAppendWrite;
export function deleteList<T>(address: ValueList<T>): ListDeleteWrite;
~~~

NoInfer<T> 让地址类型保持权威，避免 TypeScript 从不兼容的写入值推导出更宽的 T。

Write 包含六种 helper 返回类型，一个事务可以把它们与 entry、usage 混合并原子提交。harness 和应用代码应使用 helper，不要手写存储写入形状。

Session 直接写入和事务 helper 有意使用相同操作名：前者执行并提交一次 Session mutation，后者构造一个可显式组合的事务写入。

## 标量语义

对一个 Value<T> 地址：

- setValue 替换当前值；
- deleteValue 删除它；
- 删除不存在的值是 no-op；
- 删除后 set 可以重新创建；
- 不保留值历史；
- 当前值记录最近一次 set 的 seq；
- 事务失败时，标量写入和同事务的其他写入都不可见。

## 列表语义

一次 append 写入携带一个不可变元素；在一个事务中追加多个元素就包含多个 append 写入。每次写入都获得全局递增的事务序号：

~~~text
TX[
  appendList(frames, A),       // seq 41
  setValue(operationState, X), // seq 42
  appendList(frames, B),       // seq 43
]
~~~

读取 frames 返回 A、B。与其他写入交错产生的 seq 间隔是正常的。列表元素的 seq 是 session 全局且唯一的提交写入序号，用于排序和 cursor，不是应用领域 ID；需要领域身份时应把它放入 T。

规则：

- append 不读取已有元素；
- 元素提交后不可变；
- deleteList(address) 删除该精确地址的所有元素；
- 删除不存在的列表是 no-op；
- 同一事务中 delete 后 append 会原子地产生新列表；
- 不支持单元素 update、delete、插入或截断；
- 事务进入 Memory 状态前必须完成所有验证和序列化；
- 事务失败时，其列表和非列表写入都不可见。

“追加式”描述列表存在期间的元素行为；整表删除属于生命周期清理，不是元素修改。

### 列表读取

- 升序读取返回 seq > cursor.seq；
- 降序读取返回 seq < cursor.seq；
- 先按 order 排序，再应用 limit；
- 不存在和空列表都返回 []；
- 调用方使用最后一个元素的 seq 继续读取；
- 空页表示迭代结束；
- limit 只限制查询页大小，必须是正的安全整数，默认 1000，大于 10000 时截断为 10000；它不限制列表总长度或字节数。

~~~ts
let cursor: ListCursor | undefined;
while (true) {
  const page = await reader.readList(events, { cursor, order: "asc", limit: 100 });
  if (page.length === 0) break;
  consume(page);
  cursor = { seq: page[page.length - 1]!.seq };
}
~~~

cursor 只是序列过滤器，不是 snapshot 或 list incarnation token。并发追加可能在后续升序页出现。整表删除可能使 cursor 变旧；读取仍只对当前存活元素应用序列比较。

不要增加无界的“读取整个列表” helper。

## Assistant partial frames

assistant partial durability 是第一个内置列表消费者：

~~~ts
const frames = pendingAssistantFrames(operationId, responseEntryId);
~~~

AssistantMessageFrame、AssistantMessageFrameEncoder 和 reduceAssistantMessageFrames() 来自 @earendil-works/pi-ai，不要定义第二套 frame codec 或 reducer。

对于每个可转换的非终止 provider event，assistant procedure 执行：

~~~text
event 转换为 frame
→ 在 Session mutation line 上同步排队 appendList(frames, frame)
→ 给返回 promise 绑定普通 harness fault observer
→ 替换进程内 latestFrameWrite 引用
→ emit 并等待现有 message event
→ 消费下一个 provider event
~~~

provider loop 不会等待每个 frame 的存储完成；同步入队保持 provider event 顺序。每个 promise 都绑定 fault observer，因此替换 latest promise 不会使更早的 rejection 无人观察。输出有界也会限制排队工作。流结算时停止接受 frame，等待最新 append promise，然后进入 after_response；Session mutation FIFO 使该完成意味着所有更早的 append 都已完成。不使用 timer、batcher、coalescer 或 flush API。

标量 assistant effect_pending 仍然是权威状态。每次 append 在 mutation 执行时校验当前 lane 仍由同一 operation、attempt 和 response ID 所有。frame 不能证明请求已接受、完成、成功或失败。

最终或合成的 assistant 结算会将精确列表和 immutable response、usage、Branch tip、下一个标量状态原子删除/写入：

~~~text
TX[
  insert final assistant entry,
  insert usage,
  deleteList(frames),
  setValue(operationState(operationId), nextState),
]
~~~

assistant-durability.md 规定 frame 转换、未知结果合成、取消、deferred polling、snapshot 和事件顺序。

## 恢复策略

标量 operation state 是唯一的重启权威来源：

1. 从必需的标量值构造受信任的 lane/operation 投影；
2. 信任已提交的类型化值，不审计所有被引用的 payload 或阶段关系；
3. procedure 或 snapshot 需要辅助状态时，从当前类型化标量状态推导精确地址；
4. 只 hydration 当前消费者需要的有界标量值或列表页。

缺失的辅助列表是合法状态，除非消费者明确要求某个元素。列表内容不能证明外部 effect 已完成。在线 mutation 仍需校验当前 operation、phase、attempt 和保留 identity；这属于并发 fence，不是恢复校验。

基础恢复不枚举列表。对 assistant frame，只有在消费类型化的 assistant/deferred effect_pending 状态时，才根据 operationId 和 responseEntryId 推导 pendingAssistantFrames 地址。

每个列表消费者必须定义地址语法、元素和总字节上限、分页/hydration 预算、清理转换、fork 和迁移策略。

## Memory 后端

Memory 可以分别维护当前值和列表元素：

~~~ts
const scalarValues = new Map<string, StoredValue<unknown>>();
const listValues = new Map<string, ListElement<unknown>[]>();

function physicalKey(address: StoredAddressBase): string {
  return address.namespace + "\u0000" + address.key;
}
~~~

标量 set 替换 Map 值，标量 delete 删除它，list append 追加已分配序号的元素，list delete 删除完整数组，list read 按 exclusive cursor 过滤并截取到已验证的 limit。事务准备必须在 entries、values、lists、usage 和 stats 改变前完成。

JSONL/fork 工具使用的 snapshot 包含当前标量值和保留原始序号的列表元素。

## SQLite 后端

逻辑 schema 有一个当前值表和一个列表元素表：

~~~sql
CREATE TABLE scalar_values (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE list_values (
  namespace TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT    NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
~~~

WP01 原地替换未完成的 format-4 schema：编辑 sqlite/migrations/001_initial.sql，将物理 registers 表改名为 scalar_values，增加 list_values，并保持 SQLITE_STORAGE_VERSION = 1。不增加 migration runner；WP01 之前的 SQLite 文件不支持。

列表操作：

~~~sql
INSERT INTO list_values(namespace, key, seq, value) VALUES (?, ?, ?, ?);

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq > ?
ORDER BY seq ASC LIMIT ?;

SELECT seq, value FROM list_values
WHERE namespace = ? AND key = ? AND seq < ?
ORDER BY seq DESC LIMIT ?;

DELETE FROM list_values WHERE namespace = ? AND key = ?;
~~~

每个写入都参与既有 BEGIN IMMEDIATE 事务。可写 Session 的所有权属于 host 生命周期，而不是 SQLite 存储。用 EXPLAIN QUERY PLAN 断言分页使用主键且不产生临时排序。

## JSONL 后端

逻辑记录携带绑定地址的物理组件：

~~~jsonl
{"kind":"list","op":"append","seq":41,"namespace":"pi.pending.assistant_frame","key":"O:R","value":{"type":"text_delta","contentIndex":0,"delta":"hi"}}
{"kind":"list","op":"delete","seq":52,"namespace":"pi.pending.assistant_frame","key":"O:R"}
~~~

标量记录使用 kind:"value" 和 op:"set"|"delete"。WP01 保持 JSONL format 4 和 storage version 1，但原地替换未完成的记录写法；WP01 之前的 format-4 文件不支持，也不保留 legacy kind:"register" decoder。

重放将记录折叠到 Memory 状态：标量 set 替换当前地址，标量 delete 删除它，list append 增加 { seq, value }，list delete 删除完整列表。

一个事务仍然使用一行物理 JSONL，多写事务用数组表示。尾部截断因此仍保持原子性，不需要新的 framing。

### Snapshot compaction

压缩将所有仍存活的列表元素以原始 seq 写出，与存活的 entry、标量值和 usage row 按序合并。不能把一个存活列表压缩成合成元素，也不能分配新 seq；否则会破坏 cursor 和后端一致性。

已删除列表不写入 snapshot。snapshot rewrite 在 format-4 header 中持久化 nextSeq，防止丢失最近 delete 后复用序号；普通追加文件可以省略该字段并从重放记录推导。

## Fork 与重写

fork 和精确重写按具体地址语法决定策略：

- operation-owned pi.op.* 标量值不复制到 idle fork；
- immutable pi.result operation record 不由 fork 复制；
- pi.pending.entry、pi.pending.tool_output、pi.pending.assistant_frame 值/列表不复制；
- lane 和语义 session 值遵循现有 scope 规则；
- 通用 fork 不复制应用定义的值/列表；使用方必须先增加明确的地址策略。

精确重写保留列表元素时，除非显式重映射整个目标序列空间，否则保留原 seq。

## Schema 演进

绑定地址的 namespace、key 语法、kind 和值类型构成持久化 schema：

- 修改 namespace 或 key 语法需要明确的地址迁移；
- 标量与列表互转需要明确迁移；
- 存储不会根据观察到的记录推断或强制转换 kind；
- TypeScript 值形状变化且旧值不兼容时，需要完整值迁移；
- 列表迁移按 seq 顺序分页，并选择保留 seq 映射或删除完整列表；
- 迁移不能一次性加载无界列表。

增加通用列表存储会原地替换当前 WIP 后端 schema。构造没有持久值的新应用地址不需要迁移。

## Instrumentation 与 telemetry

instrumented storage decorator 暴露基于地址的读取 API，并按精确事务顺序记录擦除类型后的提交写入。

telemetry 的 session-write item kind 区分 scalar-value 写入和 list 写入。namespace/key 只有在 telemetry schema 允许时才作为 attribute；值、assistant frame、prompt 和工具输出绝不进入 telemetry。

append 路径测试证明 append commit 前不会调用 readList。即使早期 promise 不再是最新的 settlement-order 引用，每个 frame-persistence promise 仍必须绑定 harness fault observer。

## 不变量

1. 一个绑定地址在一个 storage version 内具有稳定的 namespace/key/kind 和受信任值类型。
2. 地址对象 identity 没有持久化意义。
3. pi 和所有 pi.* 按契约保留；所有内置 namespace 以 pi. 开头，应用使用保留空间属于受信任代码缺陷。
4. 五个内置 prefix constructor 封装 Branch inventory 和 operation cleanup 语法，结果只能传给 namespace-scoped scanValues()。
5. 标量和列表不能占用同一物理位置；这是受信任代码规则，不是运行时跨 kind 冲突检查。
6. 类型化读取和 helper 构造的写入保持 T。
7. 标量 helper 拒绝列表地址，列表 helper 拒绝标量地址。
8. 地址构造后，Session/Storage 操作不再需要第二个 key。
9. 每个列表元素不可变，并携带全局唯一的提交写入 seq。
10. 同一列表地址的元素在所有后端按 seq 返回。
11. append 不读取目标列表。
12. 标量/列表写入可以与 entry、usage 在同一事务中原子提交。
13. 整表删除后该地址没有残留元素。
14. 缺失和空列表都读取为 []。
15. 基础恢复只依赖必需标量状态，从不枚举辅助列表。
16. 辅助列表不能建立 effect 完成事实，也不能选择重启状态。
17. JSONL 压缩保留存活元素的 seq。
18. terminal cleanup 不留下 operation-owned 标量值或列表。

## 必需测试

### 地址类型与身份

验证 value<T>()、list<T>() 保持声明的 T；标量/列表读取推导正确元素类型；setValue 和 appendList 在编译期拒绝不兼容类型；标量 helper 与列表 helper 互相拒绝错误地址；相同三元组的独立地址访问同一位置；空 key 合法、空 namespace 和包含分隔符的组件被拒绝。

验证核心代码和应用使用同一套 value()/list()，没有私有构造器、权限 token、注册表或目录；内置构造器生成精确的 pi.branch.tip、pi.lane.*、pi.op.*、pi.pending.*、pi.session.name、pi.entry.label namespace/key/kind；所有内置 namespace 以 pi. 开头，应用 fixture 使用非保留 namespace。

验证五个 prefix constructor 只被 scanValues 使用，应用无需 declaration merging 或核心 catalog；任何 Storage/Session 操作都不接受构造地址后的额外 key。

### 标量回归

验证 set/get/delete/recreate、替换只保留最新值和 seq、混合事务顺序、namespace-scoped prefix scan；新 JSONL/SQLite 文件只使用 value/list schema，并明确不支持 WP01 之前的 WIP 文件。

### 列表一致性

扩展共享后端 conformance suite，覆盖单元素追加与分页、同事务多次追加、与无关写入交错后的顺序、全局 write seq、升降序 exclusive cursor、默认/显式/非法/上限 limit、缺失列表、整表删除、delete 后 append、后续写入无效时的 rollback、list+entry+usage+scalar 原子事务、Memory/JSONL/SQLite 相同页面和 cursor、JSONL 尾部截断、重放和压缩、SQLite 主键分页、append 无 list read、基础恢复无 list read、close 后行为。

### 应用接口

验证应用级标量和列表不需要额外 key；应用可以显式构造 workspace 地址；Storage 和 Session 接受同一地址并推导同一类型；直接 Session 写入只序列化和提交一次；Session.mutate() 能把类型化值/列表写入与 entry、usage 原子组合。

### Assistant frame 集成，延期到 WP01 之后

覆盖非终止 frame 的精确地址、done/error 不追加、同步入队且不产生 provider backpressure、每个 promise 都有 fault 路径、只保留 latest promise、等待 latest 即意味着所有更早追加完成、分页可还原相同 partial message、缺失列表恢复为空、最终/合成结算原子删除列表、未知 effect 恢复只读取当前标量状态推导的有界列表、external finalization 删除 operation-owned 列表、idle fork 不含 frame 列表，以及增长从重复 snapshot 变为追加线性。

## 实现地图

预计主要改动：

- 用 packages/agent/src/harness/session/values.ts 替换 session/registers.ts，集中放置地址、构造器、类型化写入 helper 和内置地址构造器；
- 从 session/types.ts 删除 RegisterValues、namespace union、register token 和原始 namespace/key 读取签名；
- 让 Storage、SessionReader、SessionMutator、Session 暴露 ValueReader；
- Session 直接暴露基于绑定地址的应用标量/列表方法；
- 更新 Memory 状态、JSONL codec/storage、snapshot、fork/rewrite、instrumentation 和 conformance suite；
- 用 scalar_values 与 list_values 原地替换 SQLite 未完成的初始 schema，保持 storage version 1，不增加 migration runner；
- 更新 telemetry schema source 并重新生成 telemetry-schema.md，不手工修改生成文件。

WP01 在通用地址、存储和 projection-only restore 覆盖完成后停止。assistant-durability.md 定义后续消费生命周期；assistant execution、deferred polling、recovery、snapshot hydration、memo/checkpoint capability 和 operation cleanup 随后续 runtime work package 实现。
