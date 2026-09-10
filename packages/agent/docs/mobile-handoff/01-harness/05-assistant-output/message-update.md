# `message_update` 写放大

> **范围：** Harness 本地。依赖已落地 Chord `Op`/`WireOp` 词汇的 [delta tracking](../01-delta/delta.md)，以及用于持久化的[作用域存储](../02-scopes/scopes.md)。Chord delta tracking 已落地；作用域存储和本 Harness 集成尚未落地。

## 1. 问题

```ts
{ type: "message_update", runId, message, event, frame? }
```

同一内容的三种表示会一起传输：

- `message`——完整的 `AssistantMessage`；
- `event`——`AssistantMessageEvent`，自身又携带 `partial: AssistantMessage`，即第二份完整副本；
- `frame`——实际 delta，可选。

每个流式 token 大致包含两个完整快照加一个 delta，因此响应期间字节数呈二次增长。

Reducer 甚至不使用 delta：

```ts
case "message_update":
  if (next.operation?.id === event.runId && event.message.role === "assistant") {
    next.operation.streamingMessage = event.message;
  }
```

只是一次直接赋值。所以在任意 wire 上，发送 event 都比发送快照更差——快照的 `replace` 只发送一份，而 event 会发送两份。

Wire adapter 已经接近修复方案：它丢弃 `event`，发送 `message` 加 `frame`。这就是完整快照与产生它的 delta 一起发送。

## 2. 紧凑形式已经存在

```ts
/**
 * Compact, replayable assistant-message progress. Terminal settlement is
 * intentionally excluded and must be persisted separately.
 */
export type AssistantMessageFrame =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; contentIndex: number; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_checkpoint" | "toolcall_delta" | "toolcall_end"; ... };
```

`AssistantMessageFrameEncoder` 生成它，`reduceAssistantMessageFrames` 折叠它，`openFrameProgress` 已经通过 `appendList` 持久化它。Delta 格式已经构建、使用并持久化，只是 `message_update` 携带的还不是它。

## 3. 先例

Pi 在更下一层已经采用 wire-is-delta。`PiMessagesEvent` 是 pi-messages backend 发送的序列化形式，不包含 `partial`：

```ts
| { type: "text_delta"; contentIndex: number; delta: string }
| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
```

随后 `pi-messages.ts` 负责 hydration：它持有本地 `partial`，根据每个事件修改它（`partial.content[i].text += event.delta`），并返回附带 `partial` 的进程内 `AssistantMessageEvent`。

因此约定已经建立。它只是停在 provider 边界，没有继续穿过 Harness。

## 4. 变更

```ts
| { type: "message_update"; runId: string; entryId: string; frame: AssistantMessageFrame }
```

移除 `message` 和 `event`；`frame` 不再可选。

影响范围很小，因为大多数流式消费者并不读取 `HarnessEvent`。`AgentEvent`（`agent-loop.ts`）和 `AgentSessionEvent`（`agent-session.ts`）是两个独立 union，只是碰巧共享 tag 名称，并且直接从 pi-ai event 构造自己的 `message_update`。它们不在本范围内。

`HarnessEvent.message_update` 的真实消费者和生产者：

| 位置 | 变更 |
| --- | --- |
| `runtime/drive/response.ts` | 发出必需的语义帧；停止附带完整快照 |
| `runtime/reducer.ts` | 折叠 frame，而不是赋值 `event.message` |
| lane/facet state adapter | 在 Chord tracker 下执行折叠，并发出 `Op[]`/编码后的 `WireOp[]` |
| `experimental/harness-wire-adapter.ts` | 不再把原始 `HarnessEvent` 当作最终复制格式 |
| `harness/telemetry.ts` | 仅用于命名列表 |
| `protocol/harness.ts` | 复制携带编码后的 `WireOp[]`，而不是原始 event |

`message_end` 继续携带已结算消息，因为帧有意排除终端结算。它每条消息一次，而不是每个 token 一次。

## 5. 需要增量应用器

`reduceAssistantMessageFrames` 是对 `Iterable` 做的完整流折叠。Reducer 需要一个 step 函数：

```ts
export function applyAssistantMessageFrame(
  state: AssistantFrameState,
  frame: AssistantMessageFrame,
): void;
```

在普通对象上做普通 mutation。**不要用 `Draft`，也不要用 Immer。** 早期草稿主张使用 draft-mutating 签名，以便在 `produce` recipe 中组合；该动机已经消失（[delta.md §8](../01-delta/delta.md#8-what-this-removes-from-the-codebase)）。仍然需要 step 函数——完整流版本会循环调用它——理由只是 reducer 要逐帧折叠，设计更简单。

### 5.1 pi-ai 帧停留在 pi-ai 边界；Chord 操作跨越复制边界

`AssistantMessageFrame` 是 pi-ai 的语义 delta 词汇（`text_delta`、`text_end` 等）。[Delta tracking §6](../01-delta/delta.md#6-there-is-no-frame-type) 不定义第二层 frame wrapper：进程内复制携带 `Op[]`，wire adapter 携带编码后的 `WireOp[]`。Pi-ai 帧在 fold 处停止；Chord 操作跨越复制边界。

`AssistantMessageFrame` 是 pi-ai 自己的 delta 词汇，应保持不变。改变的是：它不再是持久化单元或复制单元。

Harness 通过普通 mutation 将帧折叠到 `LaneView`。在 Chord tracker 下会产生：

```json
["a",["operation","streamingMessage","content",0,"text"],"Let me "]
```

在此工作负载上，测量得到的驻留操作**小于帧**——200 个 delta 的 raw 帧为 21.5 KB，而操作为 13.6 KB——因为一个帧自身携带三个 key，而驻留操作只携带一个整数。因此，在线路上传递帧的大小理由已经不成立。

帧保留的是语义：`text_end` 在一个原子单元中携带权威内容和 signature；操作则需要两个，并且二者关系的契约更弱。因此帧仍是*输入*词汇，并在跨越任何边界前被折叠。

### 5.2 Reducer 状态必须位于被归约的值中

Text 和 thinking 的折叠是纯的：`block.text += frame.delta`，而 `*_end` 会用权威内容加 signature 覆盖。`ReducerBlockState` 中的 `ended` 标志只用于验证，可以删除。

Tool call 则不同。`toolcall_delta` 执行 `state.json += frame.delta`，累积一个**从未存入 message 的 raw JSON 字符串**——block 持有的是已解析的 `arguments`。无法从快照恢复累加器，也无法向已解析对象追加 delta。

因此累加器必须成为被折叠 value 的一部分——例如 `LaneView` 上的 `operation.frameState[contentIndex].json`——而让 `AssistantMessage` 保持干净。一般原则是：

> **复制 reducer 的状态必须成为复制 value 的一部分。** 放在 value 旁边的任何状态，都会在没有执行生产者 fold 的消费者上发生分歧。

推论是 `arguments` 本身**不应该**复制。它从 `json` 派生，而每次 parse 都会产生新的引用，因此同时存储两者会发送同一信息的两份副本。按需派生即可。

这之所以安全，正是因为 `parseStreamingJson` 是**全函数**——四个 fallback 最终都会落到 `{}`，不会抛异常——因此 replica 可以无条件派生，不需要错误路径或一致性协议。没有需要表示的 parse-failure 状态，block 也不需要 error slot。

### 5.3 Parse 成本

对增长中的字符串每个 delta 调用一次 `parseStreamingJson`，每条消息的成本是二次的。既然 `arguments` 现在是派生的而非复制的，这个成本会落在读取它的人身上，而不是每个消费者身上。Presentation 可以在语义检查点和 `toolcall_end` 时刷新派生参数，而不是每个 delta 都 parse；该策略与 encoder 当前发出检查点的原因是分开的（§6）。

## 6. `toolcall_checkpoint` 的用途

`EncoderBlockState` 持有 `caughtUp` 和 `catchupJson`，因为排队的 provider event 共享的 `partial` 可能已经领先于该 event 的 delta。检查点会让语义帧流追上 block start 时可见的权威工具调用参数；它目前不是通用的迟到订阅者协议。

帧折叠到 tracked state 后，Chord 根替换（`r`）是复制和持久恢复的 resync 点。`toolcall_checkpoint` 仍是该 fold 的语义输入，而不是承担传输职责。

## 7. Pending output 的写入量

`openFrameProgress` 调用 `appendList(pendingAssistantFrames(...))`，因此每帧一行。长响应会产生数千次写入。

**地址改名为 `pendingAssistantOutput`**，并改为 `list<WireOp[]>`，与 `pendingToolOutput` 一致（[tool-output handoff §7.2](../04-tool-output/harness-tools.md#72-renaming)），不再是帧列表。Progress sink 会在每次追加 durable `WireOp[]` 批次前，使用每个响应一个有状态 encoder 对 tracked `Op[]` 编码；显式 `rebase()` 调用会为恢复产生有界的根替换批次。该列表位于**临时作用域**，因此结算时会解除链接，而不是持久在主日志中（[scoped storage](../02-scopes/scopes.md)）。

重要属性是：这个列表**不是历史**：`response.ts`、`deferred.ts` 和 `terminal.ts` 会在结算时运行 `deleteList`。它存在的目的，是让响应中途崩溃时可以恢复局部 assistant 消息。已结算消息会单独持久化。

这意味着逐帧持久化几乎没有收益，而且可以直接牺牲写入频率：

- **使用有界且不重置的窗口合并。** 第一帧 pending 会打开窗口；后续帧加入窗口但*不会*延长 deadline，因此持续流式响应不会无限期推迟第一次写入——这正是简单 debounce 的失败模式。active write 期间准入的帧会形成下一批。
- **刷新时拼接。** 一个 `contentIndex` 上连续的 `text_delta` 帧会折叠为一个、文本已连接的帧。折叠结果相同，因此对我们而言这是无损的。

因此一次崩溃最多丢失一个正在传输的窗口。

### 7.1 与 DeepSeek Harness 的对比

DSH 无法采用这种权衡。它的 `assistant/chunk` 事件是规范日志条目，因此必须逐 token 持久化，解决方案是降低大小：

- 同样的有界且不重置的 write-behind 窗口；
- **打包行**——连续 chunk delta 存储为 `text-chunks`/`reasoning-chunks`/`tool-call-chunks`，无损；在真实 session 上约小 60%，读取路径无条件处理，因此布局不会依赖写入开关；
- 默认使用带校验和的 zstd 帧，并能从末尾被截断的帧恢复。

它们的打包必须重建精确的事件边界、序列号和时间戳，因为 `seq = log.length`，验证要求逻辑日志连续。我们的情况不同：帧会在结算时丢弃，因此可以直接拼接，不需要打包机制。

## 8. 对临时 listener 的影响

`HarnessEvent.message_update` 不再自描述。中途附加的 listener 看到的是相对于它未持有的 partial 的 delta。

任何正确的 listener 已经拥有 base，因为 `watch()` 会安装订阅，并在一个 `readLane` critical section 中捕获快照，直到 `start()` 前持续缓冲。但直接调用 `on("message_update")`、不经过 watch 的 listener 将不再可用；在 commit 前需要了解这一点。
