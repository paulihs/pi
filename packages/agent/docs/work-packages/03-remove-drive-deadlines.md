# WP03 — 移除 Drive Deadline

## 状态

已完成。`DriveOptions.deadline` 和 `DriveOutcome` 的 `yielded` 分支已从公开类型、活动文档、未来包需求、不变量、竞态和测试中移除。过时的 `runtime2.md` 已删除。聚焦测试、`npm run check` 和 `./test.sh` 均通过。

WP02 已在 `beac75ecc` 完成。保留无关的并发源代码工作，尤其是当前 `packages/agent/src/harness/runtime2/lane.ts` 变更、JSONL/fork 工作、plugins、RPC 和 experimental 目录。

## 问题

`DriveOptions.deadline` 及对应的 `DriveOutcome { kind: "yielded" }` 不提供正确性边界。

Deadline 只会在开始下一次 transition 或 effect 之前检查。已经准入的 provider/tool/hook 可能运行超过 deadline，而宿主仍可能终止进程：

```text
check deadline
→ admit provider or tool
→ host limit expires while the effect is running
→ process dies with durable effect_pending
```

未知结果恢复仍然是必需的。因此 deadline 无法阻止进程丢失、限制已准入工作、保证 effect 恰好执行一次，也不会简化恢复。Flue 风格的工具 memo 化依赖稳定的 invocation ID 和持久 memo，而不是 Drive deadline。

相反，Deadline 处理给持久核心增加了 wall-clock 策略：

- 与持久状态无关的 `yielded` 公开结果；
- hook/effect/transition 前的安全边界检查；
- deadline 与 retry timer 的仲裁；
- deadline 与 effect 准入的竞态；
- yield 的 convenience loop 和 event-bracket 行为。

宿主已经负责调度和终止。进程丢失是一个受控崩溃边界，需从持久操作状态恢复。

## 决策

完全移除 Drive deadline：

```ts
interface DriveOptions {
  operationId: string;
  waitForRetry?: boolean;
  pollDeferred?: boolean;
}

type DriveOutcome =
  | { kind: "settled"; operationId: string; outcome: TerminalOperationOutcome }
  | { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
  | { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle }
  | { kind: "action_required"; operationId: string; action: ActionInfo };
```

WP03 中没有 deprecated alias、被忽略的 `deadline` 字段、兼容性 overload、替代时间戳选项或替代 pause 标记。

下一版 drive package 使用直接的持久 transition。确定性测试会阻塞 commit，并控制 hooks、providers、tools 和 timers，但不会增加生产执行屏障。

## 宿主行为

宿主拥有执行预算：

```text
invoke drive
→ terminal or durable waiting result: schedule normally
→ planned shutdown: stop routing/releasing work and close session processes
→ forced termination: replacement attaches and recovers durable open operations
```

按 session 分进程的宿主可以在退出前停止路由工作并关闭，然后将进程终止作为不合作 provider、tool、hook、storage 或 event listener 的硬 fence。该运行策略不要求 `DriveOptions` 中存在 wall-clock 字段。

WP03 不增加 `stopAfterCheckpoint`、`pause`、`quiesce` 或进程内崩溃模拟。这些想法仍在直接持久 drive 设计之外。进程内进程丢失模拟不是公开核心原语：旧 continuation 需要 fence，而进程隔离是可靠机制。

## 工作内容

### 公开类型

在 `packages/agent/src/harness/agent-harness.ts` 中：

- 删除 `DriveOptions.deadline`；
- 删除 `DriveOutcome` 的 `yielded` 分支；
- 保持 expected-id fence、retry waiting、deferred waiting 和 manual action 分支不变。

当前没有 Runtime2 drive 实现，因此本工作包不增加执行行为或 owner。

### 规范文档

完整更新 `packages/agent/docs/harness.md`：

- 从非目标/概览中移除安全 yield 调度语言；
- 在 §3.6、§5.6 的 `before_drive` 行和不变量 22 中，只删除 deadline 部分的取消/deadline 前置条件表述；取消前置条件保留；
- 从 drive-pass 伪代码中删除 deadline 检查和 yielded 返回；
- 从 pass joining、retry waiting、便利组合、恢复和公开方法说明中移除 deadline 策略；
- 从 `DriveOptions` 移除 `deadline`，从 `DriveOutcome` 移除 `yielded`；
- 删除 deadline 专属的事件/turn 要求；
- 从 `before_drive` hook 时机中移除 deadline 语言；
- 从未来工作条目中移除 deadline/yield 要求；
- 用明确的“无 wall-clock 策略”不变量替换不变量 25，同时保留“已准入 effect 要么正常结算，要么在任务丢失后恢复”的规则；
- 从竞态目录移除 deadline 竞态；
- 更新 drive-pass 术语表。

不要修改通用 RPC timeout/deadline 文档，或无关的进程/模型目录 timeout。这些是 invocation/transport 策略，不是 `AgentLane.drive` 策略。

删除过时的 `packages/agent/docs/runtime2.md`；`harness.md` 和关联 handoff 是活动工作的唯一实现计划和历史记录。

在交接文档和 Part 8 中标记 WP02 完成。添加 WP03 作为具体清理工作包。保留以前的 R2/R3 drive 行作为历史性的未来候选项，去掉 deadline/yield 要求，直到审查后的直接 drive 交接替换它们。

### 删除

- `packages/agent/docs/runtime2.md`

### 类型测试

扩展 `packages/agent/test/harness/types.test.ts`：

- 断言 `keyof DriveOptions` 恰好是 `"operationId" | "waitForRetry" | "pollDeferred"`；
- 断言 `DriveOutcome["kind"]` 不包含 `"yielded"`；
- 添加 `@ts-expect-error` 覆盖，证明调用者不能提供 `deadline`；
- 保留现有 drive/result 签名。

编辑后运行聚焦类型测试。

### 下游兼容性

搜索 protocol、server、coding-agent、examples 和 tests，查找结构镜像或 exhaustive `DriveOutcome` switch。只更新公开移除强制要求的编译期/类型兼容性。Coding-agent experimental worker/remote-runtime 行为和测试不在范围内。

当前 protocol Harness schema 暴露 prompt/run/watch DTO，而不是 `DriveOptions` 或 `DriveOutcome`；除非最终搜索证明有必要，否则不应修改 protocol。

## 非目标

WP03 不实现或重新设计：

- `drive`、`resume`、prompt convenience、operation ownership 或 latest-result lookup；
- manual action 或自动 barrier release；
- provider/tool 执行、恢复、重试 timer、deferred polling、abort 或终端结算；
- checkpoint pause/quiesce；
- close 准入变更；
- worker/RPC 取消或 experimental remote prompting；
- 存储/schema/迁移行为。

## 必需检查

```bash
# No drive deadline/yield contract remains in active harness docs or source.
rg -n 'deadline|yield' \
  packages/agent/src/harness \
  packages/agent/test/harness \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages

cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/types.test.ts

cd "$(git rev-parse --show-toplevel)"
git diff --check
npm run check
./test.sh
```

移除 grep 可能仍会命中本交接文档中的历史问题说明。必须逐一检查剩余匹配；活动 API、规范行为、未来验收标准或测试预期都不得保留已移除的契约。

## 审查

实现前：

1. Fable 根据完整文档/源码审查本交接文档。
2. 按用户明确要求，由 `openai-codex/gpt-5.6-sol` 以 high thinking level 审查。
3. 解决所有发现并重复，直到没有发现。

实现后，对最终文档/类型 diff 重复两次审查。

## 停止条件

满足以下条件后停止：

- `DriveOptions` 没有 wall-clock budget；
- `DriveOutcome` 没有 `yielded` 分支；
- 活动规范文档没有 deadline/yield 行为；
- 未来 drive 条目没有隐藏的 deadline 要求；
- 类型测试证明移除已生效；
- 无关的 timeout/deadline API 保持不变；
- 聚焦测试、`npm run check` 和 `./test.sh` 通过；
- 最终 Fable 和 Codex 审查没有发现。

不要在本工作包中开始直接持久 drive 的实现。
