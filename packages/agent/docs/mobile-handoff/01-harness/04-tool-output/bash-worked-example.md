# 完整示例：`bash` 端到端流程

让一个工具经过每一层。这里简化了 `execute`——省略 timeout validation、cancellation 和 exit-code 分支。输出路径上的所有内容都展示出来。

层次：exec env → `ToolOutput` sink → Harness events → durable storage → lane state → facet → wire → consumer。

---

## 1. 工具

```ts
// packages/agent/src/harness/tools/bash.ts
export interface BashToolDetails { spillPath?: string; truncation?: ShellOutputTruncation }

export function createBashTool(): AgentHarnessTool<ExecutionToolContext, typeof bashSchema, BashToolDetails> {
  return {
    name: "bash",
    parameters: bashSchema,
    output: { retain: "tail", maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },

    async execute(_id, { command, timeout }, signal, out, context) {
      const env = context.env;
      let view: ShellOutputView | undefined;

      const result = getOrThrow(await env.exec(command, {
        cwd: env.cwd,
        inheritEnv: true,
        timeout,
        capture: { limits: this.output, spill: true },
        onUpdate: (u) => {
          view = applyShellOutputUpdate(view, u);
          if (u.kind === "append") out.write(u.text);
          else out.replace(view.text);
          out.details.truncation = view.truncation;
          if (view.spillPath) out.details.spillPath = view.spillPath;
        },
      }, context));

      if (result.spillPath) out.details.spillPath = result.spillPath;
      if (result.truncation.truncated) out.write(`\n\n[${describe(result.truncation)}]`);
      if (result.exitCode) throw new Error(`Command exited with code ${result.exitCode}`);
    },
  };
}
```

当前实现中已经移除的内容：滚动 `tailOutput` buffer、`truncateTail`、`ensureFullOutputFile`、`createTempFile`、`BASH_UPDATE_THROTTLE_MS`、`BASH_CHECKPOINT_INTERVAL_MS`、`updateDirty`、`lastCheckpoint`、`scheduleOutputUpdate`、`emitOutputUpdate` 和 `clearUpdateTimer`。约 40 行工具本地 machinery 被每个工具都能获得的 capture policy 替代。

`execute` 返回 `void`。`details` 是只设置一次的单个字段——注意工具不再计算 `truncation`，因为环境拥有窗口，工具也不再知道丢弃了什么。

## 2. Exec env 在源端限流

`env.exec` 在字节产生的位置应用 `ShellOutputLimits`。对于 sandbox host，这意味着 `cat 1gb.txt` 不会把 1 GB 发送到 agent machine，溢写文件也会落在模型自己的 `read` 和 `grep` 运行处。见 [`execenv.md`](../03-execenv/execenv.md)。

初始状态是有界 `replace`。增长会产生 `append`；移动的尾部会产生 `slide { drop, text }`；完整周转会退回有界 `replace`；metadata 会移动 totals 和 spill path，而不重新发送文本。自适应发布器让小型 slide 保持响应，并根据编码大小安排上限大小的周转。

## 3. Sink

`ToolOutput` 将这些内容折叠到 `ToolOutputState`：

```ts
{
  content: [{ type: "text", text: "…the retained window…" }],
  details: { spillPath: "/tmp/pi-session-x/bash-8f2.log" },
  usage: undefined,
  addedTools: undefined,
  terminate: false,
  truncation: { truncated: true, truncatedBy: "bytes", totalLines: 8123, totalBytes: 262144 },
}
```

`out.write(text)` 追加到 `content[0].text`；环境发送 `snapshot` 时，`out.replace(text)` 赋值整个保留视图，因为 append 无法表达淘汰。Tracker（`delta.md`）无论哪种方式都会记录 intent：append 是 `a`，整体赋值的窗口滑动则通过已验证的 overlap 变成 `t` + `a`。

## 4. 操作

256 KB 构建、约 20 次 flush、50 KB 窗口：

第一批是 base batch——以携带初始状态的 `r` 开始。其余都是 delta。重复的 content path 在第二次使用时 intern，之后连续对该 path 的操作完全省略 id：

```jsonc
[["r",{"content":[{"type":"text","text":""}],"details":{},"terminate":false,"truncation":{…}}]]

[["a",["content",0,"text"],"make: Entering directory …\n"]]
[["#",0,["content",0,"text"]],["a",0,"cc -c src/a.c …\n"]]
[["a",0,"cc -c src/b.c …\n"]]
…
[["s",["details","spillPath"],"/tmp/pi-session-x/bash-8f2.log"]]
…
[["t",0,4096],["a","cc -c src/z.c\n"],["s",["truncation","totalBytes"],262144]]
```

Details 是一次 `s`，位于 20 次 flush 中的其中一次。`t` + `a` 是窗口滑动。当前 tracker 通过已验证的 overlap 恢复它；生产环境重新测量表明通用路径已经可以忽略，因此不增加显式追加/截断生产者 API（[decision](../01-delta/append-decision.md)）。

## 5. Harness 事件

```ts
{ type: "tool_start",  toolCallId: "call_7", toolName: "bash",
  args: { command: "make -j8" } }

{ type: "tool_update", toolCallId: "call_7", ops: [ … ] }

{ type: "tool_end",    toolCallId: "call_7", isError: false }
```

`tool_start` 只提供 identity——没有 `caps`，没有 `initial`。第一批是 base batch，因此初始状态通过 update channel 到达，caps 已包含在 `truncation.maxBytes`/`maxLines` 中。

`tool_end` 不携带 content 或 details。所有字节已经发出；重新发送会重复已有图片。

## 6. 持久存储

`pendingToolOutput(operationId, "call_7")` 以 operation 为**临时作用域**，因此位于 `<session>.op_….jsonl` 中，结算时 retire，而不是永久持久化在主日志中。Retirement 是 main-log `retireScope` record，因此与 settle write 原子提交；unlink 是重放该 record 的结果，不属于 transaction 本身（[scopes.md §5](../02-scopes/scopes.md)）。

这是一个 `list<WireOp[]>`，每次 flush 追加一个编码 batch；base batch 标记为 `"base"`，恢复时向后读取并用 `stopAtTag` 在此停止（[scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)）。Tracker 发出 structural op；producer 定期调用 `rebase()` 写入有界的 root replacement，限制 recovery replay。Durable interval 是 sink policy。Shell capture 只控制 source-state 和 transport publication；memo、terminal 和 recovery-base flush 由 `ToolOutput` 强制执行。

Recovery 从该 state 为新的 `ToolOutput` 取 seed——**不会删除它**；当前 `clearReplayCheckpoint` 正是删除它，这是一个 bug（`harness-tools.md` §7.4）。如果 bash 已将“溢写到 /tmp/…” memo 化后崩溃，丢弃该 state 的 replay 会创建第二个溢写文件并丢失第一个。

Memo write 和此 checkpoint 在同一个 transaction 中提交。二者都是临时作用域，因此进入同一个 sidecar；类型系统会拒绝混合不同作用域的 commit，所以不会静默回归。

## 7. Lane state 和 Facet

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void {
  switch (event.type) {
    case "tool_start":
      view.operation.tools.push({ id: event.toolCallId, name: event.toolName,
                                  args: event.args, output: undefined });
      return;
    case "tool_update": {
      const tool = view.operation.tools.find((t) => t.id === event.toolCallId);
      if (tool === undefined) return;                  // host will send a base batch
      tool.output = apply(tool.output, event.ops);
      return;
    }
    case "tool_end": {
      const i = view.operation.tools.findIndex(t => t.id === event.toolCallId);
      if (i >= 0) view.operation.tools.splice(i, 1);
      return;
    }
  }
}
```

普通 mutation，没有 Immer，也没有返回值。一个 view 从未见过的 tool event 什么也不做；宿主会发送 `replace`。

Lane facet 在 tracker 下运行同一个函数，因此 facet 自己的 op 会根据**自己的** shape 生成——它不必是 `LaneView`，通常也不是。Facet 永远不会写 op。

## 8. Wire 和 Consumer

```jsonc
{ "seq": 0, "ops": [["r",{"transcript":[],"operation":null}]] }
{ "seq": 1, "ops": [ … ] }
```

只有一种 shape：一批 op。第一批是 base batch，以 `r` 开始；之后全部是 delta。Gap、reconnect、provider reload 或无法完整应用 fold 的情况都走同一路径：发送新的 `replace`。

Consumer 是 `apply`——六个 verb，不了解 domain，没有 library，也没有 tool code，作用于它自己拥有的普通可变对象。

## 9. 本次运行的成本

256 KB 输出、约 20 次 flush、50 KB 窗口：

| | 当前 | 本设计 |
|---|---|---|
| durable writes | 每个 checkpoint 写入完整 `AgentToolResult` | structural op 加显式、定期、有界的 base batch |
| durable location | 永久位于主日志 | sidecar，结算时解除链接 |
| 每次 flush 的 wire | 完整 snapshot | 一个 `truncate` + 一个 `append` |
| 写入的 details | 每次 flush 重建完整值 | 一次 `set` |
| truncation logic | 在 `bash.ts` 中 | 在 exec env 中，由所有工具共享 |
| spill location | `/tmp`，由 OS 清理 | exec env，按 session 作用域 |

Details 这一行值得特别说明。Bash 的 details 没有变化——它们一直都很小。变化的是它们不再被放在每次 update 都整体替换的 container 中，因此目前没有任何工具需要增量修改 details。
