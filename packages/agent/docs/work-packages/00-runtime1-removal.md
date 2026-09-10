# WP00 — 移除 Runtime1

## 状态

已完成。无标签。Runtime2 是唯一的公开实现。在其执行路径尚未完成前不要发布。

## 目标

让 Runtime2 成为唯一公开的 Harness 实现，删除 Runtime1 及其过时测试，然后在添加 Runtime2 行为之前停止。

## 前置条件

- 已批准的 acceptance/hook 重设计和持久性交接已存在于 `harness.md`、`values.md`、`assistant-durability.md` 和 `tool-durability.md` 中。
- 现有测试是证据，不是权威。

## 工作顺序

1. **统一契约。** 将已批准的 acceptance/hook 重设计并入 `harness.md`，包括持久化的 `starting`、无 hook 的原子 acceptance、driver 所有的 `before_run`、`before_drive`、请求本地的 system-prompt 转换、可信恢复，以及移除进程来源的激活语义。审计 §§0.4、1.2、3.1–3.6、4.1–4.2、4.5、5.1–5.2、5.5–5.6 和第 8–9 部分；删除所有过时的 `BeforeResumePrepared`、`before_resume`、`resumeData`、`systemPromptOverride`、稳定 ID 路由、预留，以及 `fresh | continue | resume` 激活引用。当 `harness.md` 和其关联交接文档拥有活动契约后，删除过时的 runtime 规划文档。
2. **删除前先收集场景。** 检查 `agent-harness-runtime.test.ts`、`agent-harness-r2/r3/r4.test.ts` 和旧的 `restore.test.ts`。在详细的未来条目或临时分类清单中保留独有场景；明确丢弃旧的 reservation、`before_resume`、`resumeData`、持久化 hook prompt override、语义恢复审计，以及 `outcome_ready` 之前的工具崩溃行为。
3. **移除仅 Runtime1 的公开成员。** 删除 `before_resume`、`BeforeResumePrepared`、`resumeData`、`systemPromptOverride` 和稳定 hook-ID 路由。添加已批准的 `before_drive` 和 `transform_context` 形态。更新 telemetry schema 源文件并重新生成其文档。这里不要实现 `starting` 或 acceptance 行为。
4. **切换工厂。** 添加 `packages/agent/src/harness/runtime2/index.ts`，让 `agent-harness.ts` 指向它，并添加构造函数选择回归测试。验证 experimental coding-agent worker 仍能创建 Harness、订阅事件并关闭它。
5. **删除下面列出的 Runtime1 源码和测试。**
6. **在 `main` 或 pull-request 分支更新 `[Unreleased]`**，记录公开破坏性移除和暂时未完成的工厂。仓库策略禁止在 `dev` 上修改 changelog，因此 WP00 只记录这一步，不在此处执行面向发布的修改。
7. 运行保留的测试和检查。修复每一个失败；不要恢复兼容性垫片。

## 删除

```text
packages/agent/src/harness/runtime/**
packages/agent/src/harness/restore.ts
packages/agent/test/harness/agent-harness-runtime.test.ts
packages/agent/test/harness/agent-harness-r2.test.ts
packages/agent/test/harness/agent-harness-r3.test.ts
packages/agent/test/harness/agent-harness-r4.test.ts
packages/agent/test/harness/restore.test.ts
packages/agent/test/harness/scratch/r1.ts
packages/agent/test/harness/scratch/r2.ts
packages/agent/test/harness/scratch/r3.ts
packages/agent/test/harness/scratch/r4.ts
```

## 保留

- 所有 `test/harness/runtime2/**` 测试；
- Session、Branch、存储、repository、backend-conformance 和 instrumentation 测试；
- 执行 assistant/tool/primitives 测试；
- config、hooks、events、telemetry、compaction 和 branch-summary 代码/测试；
- 根据精简后的公开契约更新 `types.test.ts`；
- `packages/agent/src/agent-loop.ts` 保持不变。

不要将过时的 Runtime1 测试套件参数化到 Runtime2，也不要保留 Runtime1 smoke 套件。

## 验收

- 没有源文件导入 `harness/runtime/*`。
- 公开的 `AgentHarness.create()` 选择 Runtime2。
- Runtime2 的创建、事件、检查、关闭和故障测试通过。
- 以下 coding-agent 测试通过：
  - `experimental-remote-runtime.test.ts`
  - `experimental-session-worker-manager.test.ts`（替代已移除的 `experimental-session-worker.test.ts` 的上游测试）
  - `experimental-session-worker-lifecycle.test.ts`
- 每个修改过的测试都单独通过。
- Agent 和根目录 TypeScript 检查通过。
- `git diff --check` 和 `npm run check` 通过。

## 结果

- 已接受的 hook/drive 契约在 `harness.md` 中是规范性的；过时的 acceptance/resume 契约已不存在。
- Runtime1 源码、校验式恢复、过时套件以及 R1–R4 scratch 场景已删除。
- `AgentHarness.create()` 通过 `runtime2/index.ts` 解析；构造函数选择回归测试对此进行了证明。
- 场景收集为未来条目补充了缺失的 tool-close、identity-preflight、recovery-ordering、turn-bracket 和 telemetry 场景。
- 本交接文档起草后，上游增加了两个真实的远程 prompt 测试。它们仍然存在但被跳过，并要求 R2 重新启用，因为 Runtime2 执行尚未完成。worker 创建、附加、生命周期、操作关联和关闭覆盖已通过。

## 非目标

- 不实现有界 value/list。
- 不实现 `starting` 或原子 acceptance。
- 不实现 drive owner、provider、retry、deferred 或 tool 执行。
- 不做 Runtime1 parity 工作、兼容层、考古标签或发布。

## 停止条件

Runtime1 已不存在、Runtime2 是公开工厂、保留的覆盖率为绿色且所有检查通过后停止。报告删除内容和收集到的场景；不要开始另一个工作包。
