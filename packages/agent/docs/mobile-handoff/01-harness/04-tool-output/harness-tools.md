# 工具输出和进度

> **范围：** Harness 本地。本文不依赖 facet system、RPC 或任何 presentation。依赖 [delta tracking](../01-delta/delta.md)（已落地的 Chord op 词汇和 tracker）、[execution environment](../03-execenv/execenv.md)（截断发生的位置）和[作用域存储](../02-scopes/scopes.md)（持久化）。

## 1. 问题

三个故障，一个根因。

**每个工具都实现自己的截断。** `bash.ts` 拥有 rolling buffer、`truncateTail`、溢写文件、update throttle 和 checkpoint interval。`read.ts` 也有自己的截断。以后每个产生批量输出的工具都会以不同方式重复实现这些功能。

**Progress 是一个完整 value。** `onUpdate(partialResult)` 每次更新都交出完整的 `AgentToolResult`，`tool_update` 携带完整 result，`openToolProgress` 使用 `setValue` 持久化它。

**有人认为 `details: unknown` 迫使我们这样做**——不知道 value 的 shape 就无法 append。这个前提已经错误。结构 tracker（`delta.md`）可以在不知道类型的情况下对 JSON 记录 op，因此 details 完全不需要特殊处理。

## 2. `ToolOutput`

Harness 为每次 invocation 构造一个 sink，并传给 `execute`。**Tool 不返回任何内容**；结果由 sink 持有。

```ts
interface ToolOutput<TDetails extends JsonValue> {
  /** Append to the text block. */
  write(text: string): void;
  /** Append an image block. Images are never windowed. */
  image(image: ImageContent): void;
  /** Replace the retained text wholesale. Chord still recovers a verified `t` + `a` slide when possible. */
  replace(text: string): void;
  /** Apply source-owned truncation totals and spill metadata without resending text. */
  capture(metadata: ShellOutputMetadata): void;

  /** The tool's own details object. Mutate it directly. */
  readonly details: TDetails;

  /** Accumulates. A subagent making several model calls adds to it. */
  usage(usage: Usage): void;
  /** Replaces. */
  addTools(names: string[]): void;
  /** Replaces — a tool that decides to terminate and then recovers can say so. */
  terminate(value: boolean): void;
}
```

```ts
execute(
  toolCallId: string,
  params: Static<TParameters>,
  signal: AbortSignal,
  out: ToolOutput<TDetails>,
  context: Context,
): Promise<void>;
```

`execute` 返回 `void`。工具产生的所有内容都经过 sink——包括 `usage` 和 `addTools`；它们不能是 settle-time return value，因为 replay 的 tool 必须能从 durable state 取 seed（§7.4）。

**失败通过抛出 error 表示。** `execute` reject 时由 Harness 设置 `isError`。Tool 可以抛出任何内容，包括它没有编写的 library error。

**`terminate` 与执行如何结束正交，**因此失败的 tool 可以要求 loop 停止：

```ts
try { await thing(); } catch (error) { out.terminate(true); throw error; }
```

这修复当前实现中的缺口：`executeToolCall` 的 catch 会硬编码 `isError: true` 但不设置 terminate，而 `immediateError` 的 terminate 参数只会由 hook block 的 `applyBeforeToolDecision` 传入 `true`。

### 2.1 Details 只是一个对象

```ts
async execute(id, params, signal, out, context) {
  out.details.total = 42;
  out.details.passed += 1;
  out.details.failures.push({ name, message });
  out.details.current = undefined;          // -> delete
}
```

经过原型验证，完整粒度的 op 会自然产生：

```jsonc
["#",0,["details","passed"]]
["s",0,1]
["p",["details","failures"],0,0,[{…}]]
["d",["details","current"]]
```

没有 recipe、mutation map、`tool_start` 上的 `initialDetails`、Immer，也没有 consumer 执行 tool code。`TDetails` 仍是 tool 自己导出的类型，因此 renderer 可以把 `call.details` cast 成它；这就是它的全部用途。

对 `packages/agent/src/harness/tools/` 的调查发现，**当前没有任何 tool 增量修改 details**；只有 `bash.ts` 在流中写入 details，而且它会整体重建，因为 container 本来就会整体替换。本设计移除该原因；没人采用增量修改时不会产生额外成本。

**注意：** details 现在没有上限。循环向 `failures` push 的 tool 会无限增长；与 text 不同，这里没有 cap。当前交付的工具没有这样做，但相比 details 只能 replace 的时期，现在打开了这扇门。

### 2.2 部分输出在失败后保留

当前 `executeToolCall` 捕获错误并返回 `createErrorToolResult(message)`，只从 error string 构造新 result——一个已经流式输出 8 KB 后抛错的 tool 最终只报告 error。

使用 sink 后，已经写入的内容就是 result。Harness 将 error text 追加为 content，并保留其余内容。Error text 是模型可见的 content，不是 presentation：模型需要读取调用失败的原因。

`abortedMessage` 和 `interruptedMessage` 也应与此一致；当前它们通过 `syntheticMessage` 构造替换 result，因此取消的长命令也会丢失局部输出。

## 3. Content

Content 恰好是**一个 text block，后跟零个或多个 image block**。Tool 不能在图片之间交错 text——图片前后写入的 text 会落在同一个 block 中。这是有意设计：截断只处理字符串，图片不会成为部分内容。

Image **永远不做窗口化**。对 base64 payload 施加 byte 或 line cap 没有意义，而 `truncateTail` 作用于 text。`maxBytes`/`maxLines` 只约束 text。

### 3.1 保留模式

在 tool definition 中声明：

```ts
output?: {
  retain?: "head" | "tail";   // default "tail"
  maxBytes?: number;
  maxLines?: number;
}
```

**`head`**——追加到上限，之后停止。永远不删除内容。适合从开头就有意义的输出：文件读取、列表、grep。

**`tail`**——滚动窗口。适合有趣内容在末尾的场景：build、test run。

不提供 head+tail。`truncate.ts` 导出 `truncateHead` 和 `truncateTail`；二者不会组合，也不会新增组合函数。

### 3.2 Tool 不负责截断——exec env 负责

对于源自 execution environment 的输出，cap、coalescing 和 spill 都发生在**源端**。见 [`execenv.md`](../03-execenv/execenv.md)。Tool 将 `ShellOutputLimits` 传给 `env.exec`，并把生成的更新导入 sink。

这不是便利设计。Sandbox host 读取 1 GB 文件时不能先把 1 GB 传到 agent machine 再在那里截断，spill file 也必须落在模型自己的 `read` 和 `grep` 运行处。

对于源自 agent machine 的输出（subagent、进程内工作），`ToolOutput` 在本地执行相同逻辑。代码相同，位置不同。

注意，这反转了早先“sink 中不做 spill、临时文件路径属于 tool”的决策。改变它的是 exec-env 参数：跨机器边界的模型可达性。

## 4. Tool output state

`tool_update` 携带面向 invocation `ToolOutputState` 的 `Op[]`（`delta.md` §6）：

```ts
interface ToolOutputState {
  content: (TextContent | ImageContent)[];
  details: JsonValue;
  usage?: Usage;
  addedTools?: string[];
  terminate: boolean;
  truncation: ShellOutputTruncation;   // totals over everything ever written, without duplicate text
}
```

选择 op 而不是 typed variant union，有一个决定性理由：**只有 op 能在 Harness 不知道 `TDetails` 的情况下提供 details 粒度。** Typed union 需要每个 tool 的 recipe，而 §2.1 正是在删除这套 machinery。

Text 仍进行 delta 处理，因为 sink 在 mutation 前应用 cap，因此滚动窗口会在 `content[0].text` 上产生 `truncate` + `append`，而不是 whole-value set。

在所有工作负载上，interned op 测量结果也**小于 typed frame vocabulary**；details 上小 10 倍，因为 frame 会重复 `toolCallId`，而 interned op 只携带一个整数。见 `delta.md` §4.1。

不存在 `drop` event。Sink 知道淘汰了什么，并通过 `truncate` 表达；consumer 不需要额外 signal，也不会派生任何内容。

## 5. Harness event

```ts
| { type: "tool_start";
    runId; turnId; toolCallId; toolName;
    args: unknown }

| { type: "tool_update";
    runId; turnId; toolCallId;
    ops: Op[] }                       // a base batch begins with `r`

| { type: "tool_end";
    runId; turnId; toolCallId;
    isError: boolean }
```

**`tool_start` 只携带 identity。** 早期草稿增加了 `caps` 和 `initial`；二者都多余，现已删除。第一批始终是 base batch（`delta.md` §6），因此初始 state 通过 update channel 到达——携带两次意味着有两种建立 base 的方式，可能互相不一致。Caps 已在 state 内：`ToolOutputState.truncation` 携带 `maxBytes` 和 `maxLines`，这是 renderer 表达“50 KB limit”所需的内容。草稿自己也承认 consumer“不再需要”做相同 fold，因为 producer 的 op 已编码 eviction；这是 caps 需要传输的最后理由，也不再成立。

`tool_update` 携带 op。Base batch 和 delta 走同一 channel，因为 replacement 本身就是一个 op（`delta.md` §2）——不存在第二种 shape。`message_update` 具有相同 shape（`message-update.md` §5.1）；consumer 使用一条代码路径 fold tool output 和 assistant output。

**`tool_end` 不携带 content、details、usage 或 terminate。** 所有字节都已发出。没有新变化时重新发送会重复每个 base64 图片。

> **Fold 就是结果。** Consumer fold 过的任何内容都不会再次发送来确认。

这消除了一个早期开放问题：settle-time truncation 是否会与运行中的 fold 不一致。不存在独立的 settle-time truncation：sink 的 window **就是** truncation。Tool 想在末尾追加的内容——例如 bash 的 `[Showing lines 8000-8123 of 8123]` footer——就是 `out.write(footer)`，再做一次 append。

Harness 仍会在进程内为 model 组装 `AgentToolResult`，`createToolResultMessage` 仍将已结算的 `ToolResultMessage` 用 `content`、`details`、`usage`、`addedToolNames`、`isError` 写入 transcript。二者都不是 wire event。

## 6. Lane reduction

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void;
```

在普通对象上做普通 mutation。没有 `Draft`、`produce`、Immer，也没有 **`Rebase` 返回值**——无法应用 event 的 fold 保持 state 不变，宿主发送 `replace`。（早期草稿有 `void | Rebase`；在 Immer 下会抛错，不使用 Immer 时没有可返回的内容。注意 `reducer.ts:4` 当前定义 `LaneSnapshotReduction = LaneSnapshot | { rebase: true }`，因此这是对现有代码的真实变更，驱动它的 event 是 `navigation_end`。）

除了 view，event 是唯一输入。没有 registry、resolve 或 tool code，因此 crash 和 resume 之间改写 tool 不会让持久流无法读取。

Harness 被 facet 包装时，同一个 mutation 在 `delta.md` 的 tracker 下运行，并自然产生 op。Harness 自身无需知道这些。

## 7. 持久化

### 7.1 当前存在的内容

`pendingToolOutput(operationId, invocationId)` 是 `value<AgentToolResult<unknown>>`；重要的是，`progress.write(partial)` **只有在 `options?.checkpoint === true` 时**才触发（`drive/tools.ts:325`），不会在每次 update 触发。Bash 每 2 秒 checkpoint，并用 `JSON.stringify` 去重；其他工具从不 checkpoint。

它也**不是 progress buffer**，而是 interruption checkpoint。Resume 时，如果 tool 不是 replay-safe，`readCheckpoint` 会把它变成真正的 `ToolResultMessage`：`[...checkpoint.content, INTERRUPTION_MARKER]` 加 `details` 和 `usage`。

这解释了早期草稿为何误以为 checkpoint 必须采用 `value` 语义：因为 checkpoint 必须**是**当前 state。其实它只需要可派生；从最后一个 base batch 折叠编码 batch 即可派生，这也是 base batch 需要标记的原因（§7.3）。`checkpoint: true` 请求持久写入，而不是 replacement。

`pendingAssistantFrames` 是按帧 append 的 `list<AssistantMessageFrame>`，在 `response.ts:345`、`deferred.ts:157` 和 `terminal.ts:47` 的 settle 时 `deleteList`。

注意 `operationCleanupWrites`（`terminal.ts:26`）会调用四次 `scanValues`，列出 settle 时要删除的内容。在作用域方案下，覆盖 `operationToolMemoPrefix` 和 `pendingToolOutputPrefix` 的两次扫描由一个 `retireScope(operationId)` 替代。

### 7.2 重命名

`pendingAssistantFrames` → **`pendingAssistantOutput`**，与 `pendingToolOutput` 一致。帧不再是 durable unit；两个 address 现在都保存以 op 或 snapshot 写入的 tracked state。

### 7.3 写什么、何时写

两个 address 都是**临时作用域**（[scopes.md](../02-scopes/scopes.md)），因此位于 settle 时 retire 的 sidecar 中，而不是永久留在主日志。

两项独立收益，按重要性排序：

- **编码。** 使用 op 而不是完整 value，加 address interning：单文件从 93.89 MB 降至 5.32 MB，原子性不变。先做这个。
- **作用域。** Pending state 完全离开主日志：从 5.32 MB 降至 0.06 MB 的存活内容。

**二者都是 `list<WireOp[]>`，不是 value。** Sink 为每条持久 value stream 持有一个有状态的 Chord encoder/decoder pair。每次 flush 追加一个编码 batch；第一个 op 是 `r` 的逻辑 batch，在 storage record 上标记为 `"base"`。恢复时使用 `stopAtTag: "base"` 反向读取，再正向应用（[delta.md §9](../01-delta/delta.md#9-durable-form)、[scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)）。

一次 flush 的写入：

```ts
const ops = out.flush();
if (ops.length === 0) return;
const wire = enc.encode(ops);
writes: [appendList(address, wire, isBase(ops) ? "base" : undefined)];
```

`isBase` 来自 Chord。它检查 root replacement op `r`；普通嵌套 set 使用 `s`。分类逻辑位于词汇旁边，因此比较只编写一次。

已落地 tracker 无条件发出 structural op。没有 serialized-size comparison 或 adaptive replacement heuristic。Producer 通过 `rebase()` 显式请求 base batch；output sink 的 cap 限制 replacement，周期性 rebase 限制 recovery work。生产环境重新测量拒绝文本专用 append/truncate API：本地测得 50 KB rolling-window flush 为 2.43–2.46 µs，低于周边开销。保留普通 tracked string mutation；见 [decision record](../01-delta/append-decision.md)。

**Checkpoint 没有删除。** `BASH_CHECKPOINT_INTERVAL_MS` 仅作为临时兼容机制保留。通用 sink 拥有 durable frequency，因为 Shell 无法衡量存储写入成本，也无法强制 memo/output atomicity。强制 memo、terminal 和 recovery-base write 会绕过普通 pacing，但仍受 cap 限制。

### 7.4 Replay 必须取 seed，不能丢弃

当前 `clearReplayCheckpoint` 会在重执行 replay-safe tool 前写入 `deleteValue(pendingToolOutput(...))`（`drive/tools.ts:257`）。**这是一个 bug。**

Replay-safe 意味着 tool 会重执行，但 memo 存在的目的正是让它**不**重复已经完成的工作；而跳过的工作不会发出任何内容。因此 memoized work 的 output 当前会丢失。

修复方式：从 durable state 为新的 `ToolOutput` 取 seed，然后重执行。Tool 会追加到已经持有崩溃前产出内容的 sink。

这也是为什么任何内容都不能是 settle-only。`usage` 和 `addTools` 必须在 seed 后保留，因此像其他内容一样经过 sink。

### 7.5 Memo 不变量

> Tool 的 memo write 和 output checkpoint 必须在同一个 transaction 中提交。

否则，tool 完成工作、设置 memo，却在下一次 checkpoint 前崩溃；Replay 会跳过工作，而 seeded output 没有该工作的记录。

**当前不满足。** `setMemo`（`drive/tools.ts:112`）和 `openProgress`（`runtime/progress.ts:44`）是两个独立的 `lane.command` call，因此是两个 transaction。要满足它，必须把 checkpoint 绑定到 memo 的 commit：

```ts
setMemo(name, value) {
  validateMemoName(name);
  if (!active) return Promise.reject(ended());
  return lane.command<void>((state) => {
    if (!ownsEffect(state)) return { kind: "reject", error: ended() };
    const memo = operationToolMemo(drive.operationId, call.resultEntryId, name);
    return {
      kind: "commit",
      writes: [
        value === undefined ? deleteValue(memo) : setValue(memo, value),
        setValue(pendingToolOutput(drive.operationId, call.resultEntryId), out.snapshot()),
      ],
      next: state,
      materialize: () => undefined,
    };
  }, drive.context);
}
```

两个 address 都是**临时作用域**，因此这是单文件 transaction，并由静态检查强制为一个 transaction（[scopes.md §3 和 §6](../02-scopes/scopes.md)）。`operationToolMemo` 正是为此放入该作用域。仅靠 Session line 的排序不够——两个文件写入不具备原子性。Periodic checkpoint 保持不变，作为 interruption path 的 best-effort；此处会在正确性要求时强制写入一次。

该不变量成立，是因为 tool 做完 X，将 X 的 output 写入 sink，*然后*调用 `setMemo("did X")`——因此 commit 时 sink state 已经包含 X 的 output。

**仅靠排序不起作用**，尽管它看起来很诱人：

- memo first、checkpoint second → 中间崩溃 → replay 跳过 X，seeded output 缺少它 → 静默丢失；
- checkpoint first、memo second → 中间崩溃 → replay 重做 X，再次 append → output 重复。

重复是较轻的失败，因此有序写入是可容忍的 fallback，但二者都不正确。

**成本：** `setMemo` 现在写完整的有界 output state，而不是小 value。Memo 很少见——每次 invocation 只有少数几个——所以它受 `memo count x cap` 限制，而非 output volume 限制。

### 7.6 `openProgress` 存在写入排序竞态

`commitWrite(item)` 在调用 `write()` 时捕获 `item`，写入采用 fire-and-forget，仅跟踪 `latest`。因此 T1 捕获的 checkpoint 可能在 T2 的 memo-bundled checkpoint 之后提交，用旧 state 覆盖新 state，重新引入 §7.5 正要阻止的丢失。

修复：在 command planner 中解析 sink state，而不是在调用时解析。

```ts
commitWrite: () => setValue(address, out.snapshot())   // evaluated under the Session line
```

`lane.command` 在 Session line 上串行化，因此 checkpoint write 从构造上按单调顺序完成。这一般性地移除了竞态，而不只是在 memo 场景中移除。

### 7.7 Durable path 不运行 tool code

Op 由不具备 domain knowledge 的六 verb applier 解释，因此 crash 和 resume 之间重写 tool 不会让持久流无法读取。

> **Durable path 只使用 Harness-owned reducer。**

这也排除了持久化 facet op。Harness 没有 facet state，facet 会来去，恢复中的 Harness 必须在没有 facet 的情况下重建工作 value。

## 8. 开放问题

- **Tracker 的 property test**（`delta.md` §3.3）。本文一切都依赖 producer 和 replica 达成一致；当前没有任何证明它们确实一致。
- Coalescing window：按 tick，还是按 byte/time threshold。
- Image count 是否需要上限。Image 不做 window，因此循环 push image 的 tool 会无限增长 `content`。当前将其视为 tool bug。
- Details 是否同样需要上限（§2.1）。
- `retain: "head"` 达到上限后是否仍应发出只包含 counter 的 update，让 renderer 报告被抑制了多少。对于 exec-originated output，[`execenv.md`](../03-execenv/execenv.md) 已回答；agent-side output 需要相同答案。
- 失败的 tool 是否应该能 terminate，还是当前不能 terminate 是有意设计——合理观点是模型应先收到 error，再自行决定。
- **Derived value。** 从累积 JSON parse 得到的 `arguments` 不应复制；按需派生。因为 `parseStreamingJson` 是 total——四个 fallback 最终落到 `{}`，不会抛错——所以 replica 可以无 error path、无 agreement protocol 地派生。一般化为：复制 state 中不放 derived field。
