# Session Storage：作用域

> 状态：设计证据。可执行的第 1 步契约以 implementation-handoff.md 为准；该文档更新了序号分配、可复用作用域 ID、回收权限与记录、sidecar 布局、实现顺序，以及将 JSONL 编码拆到第 2 步的安排。
>
> 范围：packages/agent/src/harness/session/，以及第 10 节列出的 runtime 调用点。
>
> 依赖：01-delta 提供 Chord 操作词汇和 WireOp 形式。编码和作用域是相互独立但可以叠加的优化：编码减少每次写入，作用域则让一类写入完全离开主日志。

## 1. 问题

待处理的工具输出和助手输出只在操作运行期间有意义，是崩溃恢复脚手架，不是历史记录。

JSONL 日志是追加式的，因此这些数据会一直保留。删除数据还会追加 deleteValue 或 deleteList 记录，这些记录同样会持久化。当前只有完整快照重写才能回收空间，jsonl/storage.ts 没有原地压缩能力。

在 20 个操作、每个操作 400 个助手帧、2 个工具调用、60 个检查点、窗口 50 KB 的测量中：

| 项目 | 大小 |
| --- | --- |
| JSONL 总大小 | 93.89 MB |
| 已结算的 transcript 条目，也就是实际历史 | **0.06 MB** |

因此，文件中绝大多数内容都是已完成操作的脚手架。

这里有两个相互独立、不能互相替代的修复：

- 编码：value 写入携带 Chord 操作而不是完整值，并对地址做 intern。相同负载可从单文件 93.89 MB 降到 5.32 MB，不改变原子性。
- 作用域：待处理状态写入独立文件，因此从一开始就不会成为历史。

先落地编码。即使编码后每 20 个操作仍有 5.32 MB 无效数据，作用域依然值得做，因为它会持续累积，而当前没有压缩流程可回收。

## 2. 地址上的作用域

作用域有两个不能混淆的部分：不携带数据的类型标签，以及用于命名文件的运行时作用域 ID。

~~~ts
export type SessionScope = { readonly kind: "session" };
export type EphemeralScope = { readonly kind: "ephemeral" };
export type Scope = SessionScope | EphemeralScope;

// 传入 scopeId 后，地址才会成为临时作用域地址。
export function value<T>(namespace: string, key: string): Value<T, SessionScope>;
export function value<T>(namespace: string, key: string, scopeId: string): Value<T, EphemeralScope>;

export function list<T>(namespace: string, key: string): ValueList<T, SessionScope>;
export function list<T>(namespace: string, key: string, scopeId: string): ValueList<T, EphemeralScope>;

// 主日志中的临时作用域回收记录。
export function retireScope(id: string): Write<SessionScope>;
~~~

这里的名称是有意选择的：Session 已经是 harness/session/types.ts 中的接口名，重复使用会导致 TS2440、TS2484，以及 session/index.ts 的歧义导出。

~~~ts
interface Value<T, Sc extends Scope = SessionScope> extends ScopedAddress<Sc> {
  readonly namespace: string;
  readonly key: string;
  // 仅 Ephemeral 作用域存在；用于路由写入并命名 sidecar。
  readonly scopeId?: string;
}
~~~

ID 是普通运行时字符串，因为它是运行时生成的操作 ID，类型系统无法知道它的值。因此第 6 节可以静态区分 session 和 ephemeral，却不能区分两个不同的临时作用域：标签存在于类型中，ID 存在于运行时。

~~~ts
export const pendingToolOutput = (operationId: string, invocationId: string) =>
  list<WireOp[]>("pi.pending.tool_output", operationId + ":" + invocationId, operationId);

export const pendingAssistantOutput = (operationId: string, entryId: string) =>
  list<WireOp[]>("pi.pending.assistant_output", operationId + ":" + entryId, operationId);

export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
  value<JsonValue>("pi.op.tool_memo", operationId + ":" + invocationId + ":" + name, operationId);

// 没有 scopeId，因此按推断属于 Session。
export const laneStateValue = (lane: string) =>
  value<DurableLaneState>("pi.lane.state", lane);
~~~

作用域就是文件：session 作用域写入主日志，临时作用域写入 <session>.<scopeId>.jsonl。

其他后端不需要 sidecar：内存后端可以丢弃按作用域 ID 分组的 Map，SQLite 可以执行 DELETE ... WHERE scope = ?。作用域对它们只是生命周期提示；需要文件拆分的是 JSONL，后续约束也因此主要针对 JSONL。

## 3. 哪些地址需要作用域

边界应该按写入隔离来划分，而不是按生命周期划分。

把所有 pi.op.* 值都标成临时作用域看似合理，但 lane.ts 显示这会破坏协调状态：每次操作提交都会同时写 operationState 和 laneState。

~~~ts
writes: [
  ...decision.writes,
  setValue(operationStateValue(operationId), decision.operationState),
  setValue(laneStateValue(this.name), durableLaneState(...)),
]
~~~

这两个值共同描述协调状态：lane state 表示操作处于第 N 步，operation state 保存该步骤需要的数据。若拆到两个文件，崩溃可能留下一个认为自己处于某步骤的 lane，但对应数据并不存在。

批量值的行为不同。openProgress 只提交一次写入；pendingToolOutput 和 pendingAssistantFrames 在多写事务中只以删除形式出现。

| 类别 | 地址 |
| --- | --- |
| **临时作用域，sidecar** | pi.pending.tool_output、pi.pending.assistant_output、pi.op.tool_memo |
| **Session 作用域，主日志** | pi.lane.state、pi.op.state、pi.op.meta、pi.result、pi.pending.entry、pi.branch.tip、pi.op.tool_args、pi.op.preparation |

operationToolMemo 也放入临时作用域，使 harness-tools.md 第 7.5 节中的 memo 与检查点可以保持单文件事务。terminal.ts 已经把 operationToolMemoPrefix 和 pendingToolOutputPrefix 作为同一类清理对象处理，因此这与现有代码的分类一致。

## 4. 两个文件无法提供跨文件原子性

Session 线上的串行化只能提供顺序，不能提供原子性。对两个文件描述符分别 write、分别 fsync 时，如果中间崩溃，两个文件就可能不一致，而 JSONL 没有跨文件修复机制。

设计不尝试实现跨文件事务，而是保证它们不会发生：

> 一个事务中的所有写入必须属于同一作用域。

现有代码经过审计后已经基本满足该规则。因为不需要跨文件提交，所以：

- 不需要 sidecar 先写、fsync，再向主日志写确认记录；
- sidecar-only 写入不需要主日志 commit marker；
- 仍需明确 sidecar 的 durability 策略。若 fsync 更宽松，最近检查点可能丢失，这应当是有意接受的有限丢失。

## 5. 审计结果

检查 lane.ts 的 12 个提交点和 runtime/drive/*.ts 的 32 个 writes 生产点后，结论是：没有事务真正写入两个文件，但有四类事务把临时状态删除和主日志写入放在一起：

- response.ts 的结算提交：写 entry、usage、branch tip，同时删除 pending assistant frames；
- terminal.ts 的 operationCleanupWrites：删除 tool memos、tool outputs，并写 operation result 与 lane state；
- tools.ts 的工具结算；
- deferred.ts 的被替代响应处理。

调整方式是让回收成为主日志记录：

~~~ts
retireScope(operationId): Write<SessionScope>
~~~

主日志是真实来源，sidecar 是缓存。恢复时读取 retire 记录并忽略、删除对应 sidecar。提交后立即 unlink 只是优化；若 unlink 丢失，最多占用磁盘，不影响正确性。

这样上述事务都会回到单一作用域，operationCleanupWrites 也可以由扫描并逐项删除改成一次 retireScope。临时状态在操作结算前保留，结算时整体丢弃；它受操作轮次限制，且从不进入主日志。

### 5.1 一个事务不会出现两个临时作用域

一个 lane 只有一个 operation。每个写入集合使用同一个 operationId；回收与启动始终是两个事务。并发发生在不同 lane 之间，每个 lane 最多有一个活动操作，因此两个临时作用域不会进入同一个提交。第 6 节的运行时断言是对未来改动的防御。

## 6. 静态约束

scopes.variance.ts 是本节的可执行形式，可使用 npx tsc --noEmit --strict --lib es2023 scopes.variance.ts 检查。三个 @ts-expect-error 用例在约束被削弱时也会暴露问题。

需要两个只用于类型的 phantom type，它们的 Sc 出现位置不同：

~~~ts
declare const storedScopeType: unique symbol;

// 地址：协变，Sc 只出现在返回位置。
export interface ScopedAddress<Sc extends Scope> {
  readonly [storedScopeType]?: () => Sc;
}

// 写入：不变，Sc 同时出现在参数和返回位置。
export interface Scoped<Sc extends Scope> {
  readonly [storedScopeType]?: (scope: Sc) => Sc;
}
~~~

读取地址在任意作用域都安全，getValue 不关心文件位置；但构造事务不安全，因为两个文件不具备原子性，提交必须固定为一个作用域。

因此约束应放在构造事务的位置，而不是读取地址的位置。setValue<T, Sc> 从协变地址推导作用域，再将其盖到不变写入上。若把地址也设为不变，会让 getValue、scanValues、readList 等所有读取方产生大量无关类型错误。

单作用域提交应通过：

~~~ts
commit([setValue(laneState, a), setValue(operationState, b)]);
commit([setValue(toolMemo, m), setValue(pendingOutput, o)]);
commit([setValue(laneState, a), retireScope("op_1")]);
~~~

混合作用域提交必须失败：

~~~ts
commit([setValue(laneState, a), setValue(pendingOutput, o)]); // 错误
commit([setValue(pendingOutput, o), retireScope("op_1")]); // 错误
~~~

两个不同临时作用域的 ID 都属于 Write<EphemeralScope>，类型系统无法区分它们。提交时仍需运行时比较所有写入的 scopeId；按第 5.1 节的现有约束，这个断言不应在正常路径触发。

## 7. 恢复与清理

打开会话时，和主日志一起枚举 sidecar 并加载；sidecar 中的记录和主日志记录一样参与重放。

当主日志含有对应的 retireScope 记录，或操作已经不存在时，sidecar 可删除。崩溃造成的尾部截断行为不变：每行自包含，最多丢失最后一条未完整写入的记录。

## 8. 序号

每个作用域拥有独立的序号空间。作用域之外没有任何内容需要和它排序；独立编号也使主日志的 nextSeq 不必计算即将删除的 sidecar 消耗的序号。

共享编号会在多个操作结算后留下大间隔，还需要额外持久化高水位线，因此不采用。

## 9. 测量效果

使用第 1 节的相同负载：

| 方案 | 大小 | 相对当前 |
| --- | --- | --- |
| 当前，单 JSONL | 93.89 MB | — |
| 操作编码与地址 intern，单 JSONL | 5.32 MB | 5.7% |
| **再加作用域，主日志** | **0.06 MB** | **0.06%** |
| sidecar，结算时回收 | 5.26 MB | 每个操作峰值 0.26 MB |

5.7% 与采样速率相关，不能脱离条件引用；作用域的结果与速率无关，因为主日志只保留已结算条目。

## 10. 现有代码需要的改动

在 session/values.ts 和 session/types.ts 中新增 SessionScope、EphemeralScope、Scope、两个 phantom type、带作用域参数的 Value 与 ValueList、scopeId、value/list 重载、retireScope，以及保留作用域的 setValue、deleteValue、appendList、deleteList 和 Write。

需要泛化 CommitDecision<TResult, Sc>、lane.command<TResult, Sc>、Storage.commit<Sc>，并给 Sc 默认值 SessionScope。settleOperation 和 continueOperation 不应泛化。

已提交写入需要携带 scopeId，以便 JsonlStorage 路由。调用点的变化如下：

| 位置 | 当前行为 | 新行为 |
| --- | --- | --- |
| drive/terminal.ts | 扫描并删除 tool memo/output | 一次 retireScope(operationId) |
| drive/response.ts | 结算时删除 pending assistant output | 由 sidecar 回收承担 |
| drive/deferred.ts | 删除被替代响应的 pending output | 由 sidecar 回收承担 |
| drive/tools.ts | 在 Session 写入集合中删除临时值 | 删除这些操作 |
| drive/tool-placement.ts | 删除 pending tool output | 删除此操作 |

存储层需要在 JsonlStorage.commit 中按作用域路由、断言一个事务只有一个作用域 ID、提交后按回收记录 unlink，并在打开时加载和清理 sidecar。内存后端按作用域维护 Map；SQLite 使用 scope 列执行删除。

旧清理写入集合相关测试会失败，需要更新为新的 retireScope 语义。这是实现变化，不是回归。

## 11. 列表标签与停止条件

第 1 步中的跟踪状态以操作批次列表保存。恢复时需要从最近一次 base 批次开始读取，但当前 ListReadOptions 只有 cursor、order、limit，无法表达这一点。

BranchScan 已有相同能力，列表应使用 stopAtTag 和 tag：

~~~ts
appendList<T, Sc>(address: ValueList<T, Sc>, element: T, tag?: string): ListAppendWrite<Sc>;

export interface ListElement<T> {
  seq: number;
  value: T;
  tag?: string;
}

export interface ListReadOptions {
  cursor?: ListCursor;
  order?: "asc" | "desc";
  limit?: number;
  stopAtTag?: string; // 包含首个带该标签的元素，然后停止
  tag?: string; // 只返回带该标签的元素
}
~~~

stopAtTag 只是页内停止条件，不保证整个列表中一定找到标签；如果本页没有标签，消费者使用 cursor 继续分页。readList 必须返回每个元素的 tag，否则消费者无法区分因为标签停止还是因为达到 limit。

标签由生产者写入，因为生产者已经知道批次是否为 base；存储层不得解析元素来推导标签。标签存储在记录中，与 seq 和 value 并列：

~~~json
["l",7,9,[["r",{}]],"base"]
~~~

SQLite 增加 tag 列并执行真实谓词；JSONL 和内存后端可直接扫描已加载的列表。该原语也适用于其他需要读取“上次检查点之后的尾部”的列表。

## 12. JSONL 记录编码

编码有两个独立层次的字典：地址字典作用于记录的 namespace 加 key，路径字典作用于 value 内部的操作路径。两者使用相同技巧，但不能混为一谈。

### 12.1 记录

~~~text
["@", addrId, namespace, key]              地址定义
["v", addrId, seq, wireOps]                value 写入，WireOp[]
["l", addrId, seq, element, tag?]          列表追加
["x", addrId, seq]                         删除 value 或 list
["!", addrId, seq]                         回收临时作用域
~~~

记录动词和操作动词属于不同层级，必须保持可区分。用 ! 表示回收而不是 r，因为 r 已经是 delta 的 replace 操作。

条目和 usage 行保持现有 keyed 形式。地址在第二次使用时定义，以避免只写一次的地址承担额外定义开销。

### 12.2 示例

当前四次写入约 1250 字节；使用地址与路径两个字典后约 547 字节。base 批次只略微变小，增量状态从完整对象变为变更字段后，后续转换批次可缩小约 8 倍。

记录中的第一个数字是地址 ID；WireOp 中的数字是值内部的路径 ID。两者处于不同层级，分别由独立字典维护。

不要把示例中的 44% 当作文件级固定收益。字典定义会摊销，transcript 条目也不变；真实收益取决于操作状态写入所占比例。

### 12.3 读取

读取器在重放时同时建立两个字典。尾部截断只会丢失尾部记录，不需要重写头部；快照重写则重新建立字典并自然输出定义。

引用了尚未定义的 addrId 表示文件损坏，而不是可恢复状态。路径 ID 的定义和首次使用在同一条记录中，因此不会出现对应缺失。

## 13. 待决问题

- 多个并发 lane 各自持有 sidecar 时的文件句柄压力，尚未测量；
- sidecar 的 fsync 策略，是与主日志一致还是接受更宽松的有限丢失；
- 长时间运行的操作是否需要轮换 sidecar；rebase 可以限制恢复长度，但不能限制文件大小；
- 是否仍需要主日志原地压缩。createFromSnapshot 加原子替换仍可作为机制，因为作用域只减少了需求，不能消除已被替代的 Session 值累积。
