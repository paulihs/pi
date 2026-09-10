# pi — 设计交接文档

按编号顺序执行。每个单元都自包含且可独立测试；后续单元会使用前置单元的结果。

```
01-harness/
  01-delta/            操作词汇、跟踪器、应用器、编解码器   [已并入 CHORD]
  02-scopes/           存储作用域和列表标签                 [第 1 步可执行]
  03-execenv/          有界 Shell 输出、捕获、溢写           [生产代码 + 测试]
  04-tool-output/      ToolOutput 接收器                     [仅规格]
  05-assistant-output/ assistant 局部输出，与 04 对称         [仅规格]
02-plugins/
  01-facets/            facet 系统                            [仅规格]
  02-sandbox/           isolated-vm 膜                        [代码 + 412 个测试]
```

以干净的 `origin/dev` checkout 为基础。

## 先读这里

**三个单元交付可运行代码，四个单元是规格说明。** 上表已标明具体情况。不要假设文档描述的内容已经存在。

**`01-delta/FINDINGS.md` 是历史证据，不是实现队列。** 生产代码位于 `packages/chord/src/delta/index.ts`：刷新时的脏跟踪修复了 D1，生产环境重新测量后关闭了 D2。显式追加/截断 API 已被拒绝，见 [`01-harness/01-delta/append-decision.md`](01-harness/01-delta/append-decision.md)。交接目录旁的代码仍是原型和基准测试证据。

**如果文档与代码不一致，以代码为准**——修正文档，并在 commit 中说明。

**先移植测试，再实现代码。** 每组测试的注释解释了它防护的失败，而且其中一些失败是静默的：输出错误但不抛异常。

**使用 `node --experimental-strip-types` 做基准测试，绝不要通过转译器。** 通过 `tsx` 测量该模块会使结果膨胀 2.6 倍。`FINDINGS.md` 的 D5 列出了另外五个测量陷阱，每个陷阱都曾导致看似有把握但错误的结论。

## 单元状态

| 单元 | 交付内容 | 状态 |
| --- | --- | --- |
| **01-delta** | `packages/chord` 中的生产实现和测试；此处为原型证据 | 已落地；D1 已修复，生产环境重新测量后拒绝显式文本 API |
| **02-scopes** | 规格 + [可执行的第 1 步交接](01-harness/02-scopes/implementation-handoff.md) + `scopes.variance.ts` | 第 1 步作用域/列表标签可执行但未实现；JSONL Chord 编码/地址驻留延后到另行批准的第 2 步 |
| **03-execenv** | `packages/agent` 中的生产实现；此处为原型证据 | 基于源的自适应输出、延迟溢写背压和 bash 迁移已落地；bash 的临时检查点节奏下一步移交给 `ToolOutput` |
| **04-tool-output** | 规格 + 设计说明 | **未构建。** 所有操作编码测量都依赖的部分 |
| **05-assistant-output** | 规格 | 未构建。形态与 04 相同；之后处理 |
| **02-plugins/01-facets** | 规格，约 1800 行 | 未构建。§14 已重写以匹配 sandbox PoC |
| **02-plugins/02-sandbox** | 可运行 PoC，412 个断言 | `npm install && npm run audit` |

## 建议顺序

1. **`02-scopes` 第 1 步**——遵循[可执行的实现交接](01-harness/02-scopes/implementation-handoff.md)；在单独的第 2 步开始前停止并等待批准。
2. **`04-tool-output`**——复用已落地的自适应发布器，处理通用工具、Chord 事件/持久批次、终端刷新和原子 memo 检查点。
3. **05，然后是 `02-plugins`。**

## `origin/dev` 上与此设计无关的现存问题

- `drive/tools.ts:257`——`clearReplayCheckpoint` 会在重新执行可安全重放的工具前删除 `pendingToolOutput`。memo 存在时，重放工具会跳过工作且不产生输出，因此当前 memo 化工作会丢失输出。应从它取种子（`harness-tools.md` §7.4）。
- `runtime/progress.ts:44`——`commitWrite(item)` 会在调用时捕获值，而写入采用 fire-and-forget，因此旧检查点可能在新检查点之后落盘。
- memo 和检查点是两个事务（`drive/tools.ts:112` 对比 `progress.ts:44`）。它们必须合并为一个事务（`harness-tools.md` §7.5）。

**预期测试变动：** `retireScope` 替代逐地址删除后，九个断言旧清理写集合的测试会失败。这就是正在落地的变更。

## 环境

- 所有交付的 `.ts` 文件均要求 Node 22+。它们在无需构建步骤和依赖的情况下通过 `node --experimental-strip-types` 运行。
- 在 pi 仓库中，从包目录运行测试：`cd packages/agent && npx vitest run --config vitest.harness.config.ts`。根 vitest 配置不会为 `@earendil-works/pi-ai` 设置 alias；包级 harness 配置会设置。
- 从仓库根目录使用 `npx tsgo --noEmit` 做类型检查。**基线约有 788 个既有错误**，几乎全部在 `packages/ai/test`。只统计：`grep "error TS" | grep -E "packages/(agent|session-backends)/src"`。
- `packages/ai` 无法离线构建——构建时会获取模型数据。
