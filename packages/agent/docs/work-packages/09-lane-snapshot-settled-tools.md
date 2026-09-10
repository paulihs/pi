# WP09 — LaneSnapshot 中已结算但尚未放置的工具

## 状态与基线

- 仓库：earendil-works/pi
- handoff 创建时分支：dev
- 基线提交：d14d6b22327d545d6a253f932165b63e48d7f9c8
- handoff 创建前用户确认 worktree clean。
- 本文是实现 handoff，并非规范 harness 说明；规范仍以 packages/agent/docs/harness.md 为准。
- 本文记录的是已实现的设计。

## 目标

在不可变 toolResult entry 放入 transcript 前，让所有已启动或已结算但尚未放置的工具调用持续出现在 LaneSnapshot.operation.runningTools 中：

~~~text
planned         → 不进入 runningTools
effect_pending  → runningTools(status: "running")
outcome_ready   → runningTools(status: "settled")
completed       → transcript 中的 toolResult entry
~~~

调用进入展示阶段后，runningTools 与已放置的 transcript 之间不能有空档或重叠。放置是按 source prefix 刷新，不是等待所有工具。每个调用在自己的 entry_added 时移出 runningTools，不能在 turn_end 时统一清除。

## 原始问题

一次调用在真实 effect 完成到 source-order tree placement 之间消失：

1. reducer.ts 的 tool_end 从 runningTools 移除调用；
2. lane.ts 的 captureLaneSnapshot 在 tools 分支只投影 effect_pending，跳过 outcome_ready；
3. 结果已经持久化到 pendingEntry(resultEntryId)，但新 snapshot 或重连 snapshot 无法展示；
4. 直到 entry_added 放入不可变 toolResult entry 后才重新出现。

并行批次 [A, B, C] 中，B 可以先结算但要等 A 才能按源顺序放置；如果 A 已放置，B 不必等待 C。因此 turn_end 清空全部工具行会导致早已进入 transcript 的结果短暂同时存在两处。

## 已确认的架构

Mini 不复制 structural object delta：

- lane-service.ts 发送一次完整初始 snapshot，之后转发 HarnessEvent；
- mini session.ts 通过 reduceLaneSnapshot() 折叠事件；
- reconnect/rebase 获取新的完整 snapshot；
- tool_update 携带完整替换式进度结果，而不是嵌套 diff。

当前持久化工具流程为：

~~~text
prepare
→ before_tool
→ intent commit（effect_pending + effective args），然后 tool_start
→ execute/update/checkpoint
→ after_tool
→ finalize
→ publishToolOutcome staging commit（pendingEntry + outcome_ready），然后 tool_end
→ materializeReady 按源顺序放置
→ entry_added
~~~

真实调用、立即 synthetic 调用、取消和恢复结果都经过 publishToolOutcome()。Lane.settleOperation() 在 commit-bound event 中先提交并发布进程内状态，再构造 event batch，公开 operation 等待交付。并行执行中，materializeReady 只在 outcome-completion promise resolve 后调度，因此 tool_end 在 staging 之后、placement 之前交付。

## 约定的 event 契约变化

不增加 tool_result_ready 或 tool_outcome_ready。tool_start/tool_end 改为表示工具调用处理与结果生命周期，而不只是外部真实 effect 生命周期。

### 新执行的真实调用

~~~text
intent commit
→ tool_start
→ tool_update*
→ execute/finalize
→ TX[pendingEntry + outcome_ready + cleanup]
→ tool_end
→ source-ordered placement
→ entry_added
~~~

### 新的 synthetic 调用

~~~text
TX[pendingEntry + outcome_ready]
→ tool_start
→ tool_end
→ source-ordered placement
→ entry_added
~~~

synthetic 包括 unknown tool、参数准备/校验失败、before_tool 拒绝或替换参数无效、assistant length/truncated call，以及 planned 或 effect admission 前的取消。staging transaction 的 post-commit event batch 先发 tool_start 再发 tool_end，因此 watcher 不会看到没有权威 staged state 的生命周期事件。

### 恢复

历史生命周期事件不重放：

- 恢复的 effect_pending 已由初始 snapshot 表示；
- safe replay 在清理 checkpoint 的 commit 发 recovery tool_start，在后续 outcome staging 发 tool_end；
- unsafe interruption synthesis 可以只发 recovery tool_end，因为初始 snapshot 已有 running 行；
- 已恢复为 outcome_ready 的调用在初始 snapshot 中就是 settled，无需先重放 end。

### tool_end 的含义

现在 tool_end 表示：

> 完整最终工具结果已经持久化 staging，调用已经处于 outcome_ready。

它是 reducer 从 running 到 settled 的权威转换，必须在 staging commit 后发出。旧的“真实执行”和“synthetic 结果”区别没有现有运行时消费者需要；不要未经约定增加 execution 字段。

## LaneSnapshot 类型

agent-harness.ts 中的 runningTools 用同一个 result 字段表示进度和最终输出，不再保留 partialResult：

~~~ts
type SnapshotTool =
  | {
      status: "running";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: AgentToolResult<unknown>; // 最新完整进度快照
    }
  | {
      status: "settled";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: AgentToolResult<unknown>;  // 完整最终结果
      isError: boolean;
    };
~~~

tool_update.partialResult 仍可在 event API 中使用该名称；reducer 把它写入 snapshot 行的 result。Mini 传输的是语义事件而不是结构 diff，因此 tool_end 即使与最后一次 update 相同，也携带完整最终结果。

## 精确 reducer 行为

文件：packages/agent/src/harness/runtime/reducer.ts。

### tool_start

使用 matchingOperation(snapshot, event.runId)，按 toolCallId upsert，设置 running、toolName、args；替换已有行时清理 settled-only 字段，不保留旧最终结果。upsert 是必要的，因为 watch 可能先捕获持久化的 effect_pending，再收到缓冲的 tool_start。

### tool_update

使用 matchingOperation，而不是直接使用 snapshot.operation；找到对应行后，只有 running 行才用 event.partialResult 替换 result。错误 operation 或不存在的行忽略。

### tool_end

使用 matchingOperation，按当前 batch 的 toolCallId 找已有行，将其替换为 settled，保留 args，使用 event.result 和 event.isError。不能创建新行。最终结果在放置前继续展示。

### entry_added

如果 event.entry 是 role 为 toolResult 的 message，按 batch-local toolCallId 从 runningTools 移除，再更新 transcript。不要在 turn_end 清理工具行。

## 权威 snapshot capture 行为

文件：packages/agent/src/harness/runtime/lane.ts 的 captureLaneSnapshot()，tools 分支。assistant entry 只加载一次。

### planned

跳过，尚未进入展示阶段。

### completed

跳过，其 toolResult entry 应已在 captured transcript 中。

### effect_pending

校验 assistant.message.content[sourceIndex] 是匹配的 toolCall；读取必需的 operationToolArgs 和可选的 pendingToolOutput。投影为：

~~~ts
{
  status: "running",
  toolCallId: block.id,
  toolName: block.name,
  args: persistedArgs,
  ...(checkpoint === undefined ? {} : { result: checkpoint })
}
~~~

### outcome_ready

校验源 tool-call block，读取 pendingEntry(call.resultEntryId)，要求 payload 是 role=toolResult 的 message，并校验 staged toolCallId/toolName。读取存在的 operationToolArgs；若不存在，使用 source block arguments。立即 synthetic 调用没有写 operationToolArgs 是合法的。

从 staged ToolResultMessage 和持久化终止标记重建 canonical AgentToolResult，投影为 settled、result、isError。event 和 capture 必须以完全相同方式规范化 optional details、usage、addedToolNames、terminate。不匹配或缺失的 staged result 是展示数据损坏，snapshot capture 必须 fault。

## 运行时 event 生产变化

主要文件：runtime/drive/tools.ts；相关 helper 在 execution/tools.ts 和 runtime/drive/tool-placement.ts。

ToolOutcome 要同时保留 staged ToolResultMessage、tool_end.result、tool_end.isError 以及取消归一化后的 terminate，避免 post-commit 重新构造时丢失信息。synthetic helper 也必须携带 canonical result，但不能凭空给 transcript 增加 details。

新执行通过 publishToolIntent() 将 tool_start 绑定到保存 effective args 和 effect_pending 的 commit；公开 operation 等待 event 交付后才允许 executeToolCall()。未写 effect intent 的 synthetic 调用在 outcome staging commit 中按 tool_start、tool_end 顺序发事件。safe recovery 的 checkpoint-clear commit 发 recovery tool_start；已经通过初始 snapshot 恢复的 unsafe effect_pending 不再次发 start。

删除 performToolInvocation() 当前 staging 前的 tool_end。publishToolOutcome() 在同一 staging command 的 events callback 中发 tool_end，携带 runId、turnId、toolCallId、toolName、canonical result、isError、归一化 terminate 和必要的 recovery 标记。args 只属于 tool_start。

因为 Lane.command() 等待 event delivery，runParallel() 又从 outcome promise 调度 materialization，顺序必须是：

~~~text
staging commit
→ tool_end delivery
→ source-ready message lifecycle
→ placement commit
→ entry_added
~~~

审计所有 publishToolOutcome() 调用：立即结果、intent 后取消、正常完成、safe replay、unsafe recovery、planned 取消、effect_pending 取消，以及 performToolInvocation() 内同步 AbortRequested 路径。

## Mini 与其他展示消费者

### Mini

mini/tui/view.ts 的 MiniTui.apply()：

~~~text
running：
  markExecutionStarted()
  若有 result：updateResult(result + isError:false, true)

settled：
  不调用 markExecutionStarted()
  updateResult(result + isError, false)
~~~

等待 placement 时保留最终结果；entry_added 后 transcript 同步提供不可变 ToolResultMessage，runningTools 行才消失。

### 其他共享消费者

对 packages/coding-agent/src/experimental/client-tui-chat.ts 应采用同等处理。编辑前阅读 modes/interactive/components/tool-execution.ts，确认 updateResult(result, isPartial) 语义。

## 测试

### Reducer 测试

reducer.test.ts 构造 [0,1,2]：

1. 三个调用都 running；
2. 2 先结算；
3. 0 结算并在 1 仍运行时放置；
4. 1 结算；
5. placement 按源顺序放置 1、2；
6. 每次 settlement/placement 后，每个展示中的调用恰好位于 runningTools 或 transcript toolResult 之一；
7. 2 被 0 阻塞时仍以 settled 和最终 result 保留；
8. 每个 entry_added 只移除对应行。

另测错误 runId 的 tool_update 不改变当前 operation、tool_start 不重复 upsert、tool_end 只结算已有 batch 行。

### Capture/watch 测试

watch.test.ts 覆盖 planned（省略）、带 checkpoint 的 effect_pending（running/result）、无 checkpoint 的 effect_pending、带 effective args 的真实 outcome_ready、无 operationToolArgs 且回退源参数的 synthetic outcome_ready，以及已在 transcript 中的 completed。验证 staged 内容、isError、args、无重复，并覆盖 pendingEntry 缺失/不匹配 corruption。

### 运行时工具测试

drive-tools.test.ts 断言真实流程为 intent commit < tool_start < tool_update* < staging commit < tool_end < entry_added；synthetic 为 staging commit < tool_start < tool_end < entry_added，且无 effect、无 after_tool；覆盖 planned cancellation、unsafe recovery、B 先结束但保持 settled、source-order placement、staging 后 crash 不重放。旧规范要求 tool_end 在 staging 前，现已有意反转。

### 类型和 event catalog

审计 types.test.ts 与 telemetry.ts。不增加新 event 名称；tool_end 不带 args，但语义改变。

### Mini 回归

运行真实 mini abort smoke test：执行 sleep 20，约两秒后发送 Escape，确认 Command aborted、耗时、toolErrorBg 的 ANSI 48;2;60;40;40；确认 durable session 有 isError:true 的 tool result 且 operation 状态为 aborted。另测后完成工具在 in-order placement 前最终结果持续可见。

## 文档变化

完整阅读并更新 harness.md 与 tool-durability.md 中关于以下旧规则的表述：

- tool_end 在 staging 前；
- tool_start/tool_end 仅表示真实 effect；
- synthetic 不发送生命周期；
- outcome_ready 不进入 runningTools；
- snapshot 使用 partialResult 字段。

新文档必须说明 tool_end 是 staging 后的持久化证据，fresh synthetic 有 start/end，恢复事件不历史重放，outcome_ready 直到 placement 仍以 settled 投影，entry_added 把 settled presentation 移入 transcript，统一 result 字段在 running 时为进度、settled 时为最终结果。

不要顺便修改 response.ts 与 tool-placement.ts 的 recovery turn_end 差异。

## 完成后需重新完整阅读

核心规范和实现：harness.md、tool-durability.md、agent-harness.ts、reducer.ts、lane.ts、drive/tools.ts、tool-placement.ts、execution/tools.ts、runtime/types.ts、session/types.ts、events.ts、telemetry.ts。

测试：reducer.test.ts、watch.test.ts、drive-tools.test.ts、types.test.ts 及其 helper。

Mini：mini session.ts、lane-service.ts、protocol.ts、view.ts、client-tui-chat.ts、interactive/components/tool-execution.ts。

编辑前检查 git status 和当前 diff，因为多个 Pi session 可能共享 worktree。

## 校验命令

按仓库根目录规范，完成后运行相关 reducer/watch/drive-tools/types focused Vitest、npm run check；最终运行 ./test.sh。不要运行 npm test、完整 Vitest 或 npm run build，除非用户明确要求。

若进行 delegated review，使用 provider anthropic、model claude-fable-5，并保持 extensions 开启。

## 非目标

- 不做 Mini 的通用 structural-delta transport；
- 不优化避免 tool_end 和 entry_added 各传一次最终结果；
- 不改变 source-prefix placement；
- 不在 turn_end 清理；
- 不改变 tool effect replay/durability 规则；
- after_tool 仍只对真实 fresh/safe replay effect 执行；
- 不处理 response.ts 与 tool-placement.ts 的 recovery turn_end 差异；
- 不增加未经明确要求的兼容层；
- 不提交，除非用户要求。
