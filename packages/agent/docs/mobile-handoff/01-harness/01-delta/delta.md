# Delta 跟踪与 Op 词汇

> **生产状态：** 已落地于 `packages/chord/src/delta/index.ts`，测试位于 `packages/chord/test/delta.test.ts`。Chord 负责无依赖的 `Op`/`WireOp`、tracker、applier、codec 和验证边界；Session storage、Harness 和 facet 会消费它。本文旁边的实现和测试是历史原型/基准测试证据，不是生产源码。
>
> 已落地 tracker 在 `flush()` 时根据 dirty tree 和 baseline 计算 delta，而不是为每次 mutation 保留一个 op。这解决了 FINDINGS D1。生产环境重新测量也关闭了 D2：通用字符串路径的成本低于周围复制/渲染成本，因此拒绝显式 append/truncate API（[decision](append-decision.md)）。

一个机制覆盖 assistant partial、tool output、tool details、lane state 和任意 facet state，在线路和持久存储中都适用。

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/delta.test.ts
# run from packages/chord
```

## 1. 为什么不使用现有 library

Immer、Valtio、Mutative 和 Colyseus 都记录 effect，而不是 intent。字符串是 leaf，因此 `text += chunk` 被记录为完整新字符串的写入；`unshift` 也会因为引擎移动每个 index 而变成许多写入。它们的典型结果如下：

| 操作 | 发出的内容 |
| --- | --- |
| 40 KB 上的 `text += "x"` | 携带 40 KB 的 `replace` |
| 100 个元素上的 `arr.unshift(x)` | 约 100 次 index write |
| `arr.pop()` | 写入 `length` path，而它不是 document location |

对 base 和 result 自行做 differ 也不能恢复 intent。滚动窗口同时从前端删除、从后端追加，既不是旧值的 prefix，也不是 suffix，最终会退回 whole-value replace。

因此 tracker 记录变脏的 path 和 array operation，并在 `flush()` 时只比较这些 subtree 与已接受的 baseline。

## 2. Ops

**所有地方都使用 tuple，没有 keyed variant。**

```ts
export type Seg = string | number;
export type Path = readonly Seg[];
/** Non-empty: `s`/`d`/`a`/`t` cannot target the root. Enforced by the type. */
export type NonEmptyPath = readonly [Seg, ...Seg[]];

export type Op =
  | readonly ["r", JsonValue]                            // replace the value
  | readonly ["s", NonEmptyPath, JsonValue]              // set
  | readonly ["d", NonEmptyPath]                         // delete
  | readonly ["a", NonEmptyPath, string]                 // append
  | readonly ["t", NonEmptyPath, number]                 // truncate, in chars
  | readonly ["p", Path, number, number, JsonValue[]]    // splice: index, remove, items
```

Interning、ID reference 和省略 path 属于 `WireOp`，只存在于 `encode` 与 `decode` 之间（§4）。`r` 是唯一替换完整 value 的 op；不要把它编码为 root path 上的 set，因为 base-batch detection 是恢复正确性边界。只有 `p` 可以作用于 root，因为 tracked value 本身可能是 array；其余 verb 使用 `NonEmptyPath`。

不要在 serialization boundary 添加另一套 keyed shape 和 codec。内存、wire、磁盘均使用 tuple；可读性由 debug formatter 负责。共六个 verb，不提供 `move`、`copy` 或 `test`。`chars` 统计 UTF-16 code unit，不是字节；byte cap 属于 producer。

## 3. Tracker

State 是普通 TypeScript，不使用 container、handle、schema 或 decorator：

```ts
const t = track(laneView);
t.state.operation.streamingMessage.content[0].text += delta;   // -> append
t.state.transcript.push(entry);                         // -> splice
t.state.tools[0].details.failures.push({ name, msg });  // -> splice
delete t.state.config.model;                            // -> delete
const ops = t.flush();
```

- Object 使用普通 `set`/`deleteProperty` trap；
- Array 在 `get` trap 中拦截 mutator method，`push` 记录一个 splice 后再委托执行，因此 `unshift` 不会变成 O(n) 个 op；
- String 在 `set` trap 中标记 dirty，`flush()` 使用已验证的 overlap 推导 append、truncate+append 或 set。

### 3.1 Overlap 不使用手写 KMP

手写 KMP 在实际 JS 中约慢 47 倍。实现使用 native `indexOf` probe，再以 `endsWith` 验证候选，并先走 `startsWith` fast path。生产实现限制候选扫描，超过上限返回 0，产生更大的 set，但不会产生错误。

### 3.2 实现规则

- Inserted value 被采用，flush 时 clone payload 和 accepted baseline，避免 alias producer state；
- `x = undefined` 归一化为 `delete`；
- `arr.length = n` 转为 splice，缩短时删除，增长时插入显式 null；
- numeric array key 归一化为 number；
- Proxy 按 object 和 path 缓存；
- 只接受经检查的 `JsonValue`，拒绝 symbol key、`Map`、`Set`、`Date`、`RegExp`、typed array 和 class instance；
- root 只允许 `r`，或当 tracked value 是 array 时允许 `p`；
- 同一 transaction 中对一个 address 的多次写入，必须逐次针对前一个结果记录。

### 3.2.1 替换完整 value

`state` 必须是 tracker 上的 setter：

```ts
tracker.state = next;    // emits ["r", next]; discards ops recorded before it
```

没有 setter 会把 proxy 换成普通对象，后续 mutation 静默失去跟踪。只有完整 replacement 折叠为 `r`；部分重写保留较小的 set op。

### 3.2.2 第一次 flush 是 base batch

`track()` 打开 stream，consumer 从空状态开始，因此第一次 flush 总是携带 `r`，包括之前发生的 mutation。不要要求 producer 先调用 `rebase()`，否则错误会在运行时远处才暴露。

### 3.2.3 后续强制 base batch

```ts
tracker.rebase();        // next flush is ["r", value]; value unchanged
```

`rebase()` 丢弃 pending op，因为 proxy 已经直接修改 target。它不会自动发生；append stream 可以一直保持 delta。恢复从最后一个 base batch 开始，周期性 rebase 可把 replay 数量从数百批限制到策略规定的上限。Durable sink 和 facet host resubscribe 都需要按需生成 base。

### 3.3 已知缺口

`sort`、`reverse`、`fill` 和 `copyWithin` 会标记 array dirty 并发出结构/index 变更；手动 index-shift loop 可能产生 O(n) set；滚动窗口 assignment 仍在 flush 时做 overlap discovery，这是有意保留的通用路径。

### 3.4 String algorithm 的限制

固定长度 probe 找不到短于 probe 的 overlap，因此要先试长 head，再回退到单字符 head。重复输出会使候选数巨大，必须限制扫描。任何依赖该算法的工作都应先运行 property test；`delta.test.ts` 是应移植的测试套件。

## 4. Codec

`Op` 是 tracker 产生、`apply` 消费的内容，path 始终 inline。`WireOp` 才包含压缩：

```text
["#", id, path]     defines an id, emitted on a path's SECOND use
a numeric PathRef   references a previously defined id
a shortened tuple   reuses the previous op's path; arity disambiguates
```

`encoder().encode(ops): WireOp[]` 和 `decoder().decode(wire): Op[]` 是唯一的转换位置。每个 stream 使用独立的 encoder/decoder pair；base batch 时重置 ID table；arity omission 只在 batch 内有效。第二次使用才 intern，因为第一次使用的 definition 可能比原 path 更大。

## 5. Flush 和 dirty-tree collapse

`flush()` 针对最后接受的 baseline 计算 dirty path 的 op，不为每次 mutation 保留一个 op。不要根据 serialized size 自动选择 replacement；replacement 由 producer 赋值 `state` 或调用 `rebase()` 请求。

已落地 tracker 在 flush 时比较 dirty subtree 与最终值：重复字段自然折叠，交替字段保留少量 dirty path，父级 replacement 可以覆盖 descendant。不要移植旧的 backwards dead-op pass 或 adjacent-only coalescer。

> **Object key order 不是复制不变量。** Delete-and-reinsert 可能使 replica 的 insertion order 不同。需要显示排序时显式排序，不要 hash 或 content-address replicated value。

## 6. 没有 Frame type

Logical batch 是 `Op[]`，transport 和 durable storage 使用 `WireOp[]`。不要再包一层，也不要把 `seq` 放入 payload；storage list element 已经有 `seq`，SSE 用 `id:` 表达 transport metadata。Base batch 的判定是 `ops[0]?.[0] === "r"`。

| 原来由 frame 提供 | 现在由谁提供 |
| --- | --- |
| `seq` | list element 的 `seq` 或 SSE `id:` |
| `kind: "replace"` | `r` op |
| 所属 value | address |
| “这是 snapshot” | `"base"` storage tag |

Resubscription 是 base batch 加 buffered batches。遇到 gap、path 无法解析或 cold connect 时请求 base。Consumer 不能只凭 payload 判断过时，必须依赖 transport 报告断开。

## 7. 安全

Op 可能来自 facet、plugin compartment 或回显 model output 的 tool，因此不可信。Op 只能在 path 上放置 `JsonValue`，不能引用 code、module 或 runtime object；伪造 payload 的最坏结果是 replica state 损坏，而不是 RCE。

> **规则：op 不得命名由 host 解析的内容。** 不要放 mutation name、component ID 或 module reference。

### 7.1 Path

危险操作是 `parent[key]`。保留并在 record/apply 两处拒绝 `__proto__`、`constructor` 和 `prototype` 这三个 path segment，但作为完整 JSON value 的字面量 key 可以复制。写入使用 `Object.defineProperty`，解析只允许 own property（`Object.hasOwn`），避免 inherited setter/getter 和 prototype chain。

### 7.2 Array index

Index 只能指向已有 element，或恰好指向末尾后一个位置。拒绝稀疏数组写入既保持 `JsonValue` 往返一致，也避免一次 op 分配数十亿个元素；`arr.length = n` 通过显式 null splice 增长。

### 7.3 Decode 时验证结构

Decoder 必须验证 verb、arity、path、index/count、items 和 `#`。Unknown verb 是 error，不是 no-op。`assertValidOp` 只守护 `apply` 的完整 Op，`assertValidWireOp` 守护允许 ID/short form 的 WireOp；不要用较宽的 wire grammar 验证 decode 后的 Op。

### 7.4 Tracker 的 type cage

Tracker 自动保证 op shape，但 value 和 key 需要单独检查。Function、BigInt、cycle、Map、Date 和 symbol key 都必须在 record 时拒绝；不要把 `structuredClone` 当作 JSON 检查。

### 7.5 Applier

```ts
export function apply<T>(target: T | undefined, ops: readonly Op[]): T;
```

Applier 只有六个 verb，没有 domain knowledge、tool code、registry lookup 或 path table。ID 和省略 path 在 `decode` 中处理。它返回 value，因为 `r` 会替换 root；运行目标必须是 consumer 拥有的普通可变对象。

## 8. 移除和不构建的内容

移除 Immer、per-type reducer、`detailMutations`、`initialDetails`、reducer return value `Rebase`、wire 上的 mutation name 和 mutation-name version skew。不要构建盲目的 whole-value differ、keyed op 加 codec 或 frame wrapper。

## 9. 持久形式

Tracked value 保存为编码后的 `WireOp[]` batch list，每次 flush 追加一批，base batch 带 `"base"` tag。恢复时：

```ts
readList(address, { order: "desc", stopAtTag: "base", limit: 100 })
```

`stopAtTag` 只在 page 内生效；没有 base 时继续用 cursor 分页。Tag 与 `seq` 位于 storage record，而不在 value 内。这样 replacement 才能真正截断 recovery replay。

## 10. 开放问题

- 出现大量共享长 prefix 的 path 时，是否需要 prefix interning trie；
- array reorder 是否需要专用 op；
- 非 JS consumer 的 interning table 和 wire framing 规范。

JSONL log 的 address interning 是 path interning 向上移动一层，作用于 `namespace` + `key`。它已在 [scopes.md](../02-scopes/scopes.md) §12 规定，并使用独立 dictionary，不是本文的开放问题。
