# ExecutionEnv：有界 Shell 输出

**状态：已在生产源码中实现。** 本文旁边的原型文件是历史证据；生产代码位于：

- `packages/agent/src/harness/utils/adaptive-publisher.ts`
- `packages/agent/src/harness/utils/output-capture.ts`
- `packages/agent/src/harness/env/nodejs.ts`
- `packages/agent/src/harness/tools/bash.ts`

同一发布器在通用 `ToolOutput` 中的使用仍见 `04-tool-output`，目前属于设计工作。

## 1. 问题

旧版 `Shell.exec()` 会在 `NodeExecutionEnv` 中累积完整字符串：

```ts
stdout += chunk;
stderr += chunk;
```

bash 只有在这些字符串已经构建完成后才截断。于是 `cat 1gb.txt` 会在 worker 中先物化 1 GB 数据，工具层的任何上限都来不及发挥作用。

溢写也应该发生在字节产生的位置。如果执行是远程的，worker 上的溢写文件对模型的 `read` 和 `grep` 工具不可访问；如果在传输后才创建溢写文件，则必须先把完整的 1 GB 通过连接发送出去。

## 2. 边界

现在 `ExecutionEnv` 负责：

- 有界的头部或尾部视图；
- 完整的字节和行总数；
- 视图首次超过限制后，延迟创建源端本地溢写文件；
- 带有界写流背压的持久源端本地溢写；
- 最新有界状态的自适应发布；
- 结算前强制进行最终发布。

它不会返回或保留独立的 `stdout` 和 `stderr` 值。两条管道共同输入一个按到达顺序排列、对模型可见的文本视图，与 bash 和 `ToolOutput` 一致；如果要在尾部淘汰过程中保留流样式，就需要 Harness 没有暴露的分段保留状态。文本由更新折叠而成，`ShellExecResult` 只包含退出以及截断/溢写元数据。

bash 只负责命令语义和模型可见的页脚。它旧有的滚动缓冲区、溢写创建、100 ms 节流和完整输出累积都已移除。现有的两秒持久检查点请求会暂时保留，直到 `ToolOutput` 接管持久节奏。

## 3. 契约

```ts
interface ShellOutputLimits {
  maxBytes: number;
  maxLines: number;
  retain?: "head" | "tail";
}

interface ShellOutputCaptureOptions {
  limits: ShellOutputLimits;
  spill?: boolean;
}

type ShellOutputTruncation = Omit<TruncationResult, "content">;

interface ShellOutputMetadata {
  truncation: ShellOutputTruncation;
  spillPath?: string;
  lastLineBytes?: number;
}

interface ShellOutputView extends ShellOutputMetadata {
  text: string;
}

type ShellOutputUpdate =
  | { kind: "replace"; output: ShellOutputView }
  | { kind: "append"; text: string; metadata: ShellOutputMetadata }
  | { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
  | { kind: "metadata"; metadata: ShellOutputMetadata };

interface ShellExecResult extends ShellOutputMetadata {
  exitCode: number;
}
```

`drop` 统计 JavaScript 字符串 code unit，与 `slice()` 一致。更新按顺序排列。消费者使用 `applyShellOutputUpdate()` 应用它们。

完整替换会建立初始状态，或在没有可验证重叠时执行恢复。append 只携带增长的后缀。slide 删除前缀并追加新后缀。metadata 更新会移动总数或溢写路径，而无需重新发送文本。

兼容性 helper `executeShellWithCapture()` 仍返回一个有界的最终视图。其 `onChunk` 回调只接收初始文本、追加文本和 slide 文本；metadata 以及周转后的替换不会被错误标记为新字节。

## 4. 自适应发布

`AdaptivePublisher` 只保留最新的脏状态。中间的进程写入不会变成输出更新队列。

策略是 Harness 全局策略，而不是每个工具单独配置：

```ts
minIntervalMs = 100;
targetBytesPerSecond = 100 * 1024;
nextDelayMs = max(minIntervalMs, encodedUpdateBytes * 1000 / targetBytesPerSecond);
```

空闲后的第一个脏状态会立即发布。截止时间前收到的写入会折叠到最新有界状态。一个尾部定时器保证最终发布。终结会绕过一次截止时间，但仍受保留上限限制。

发布器在调用消费者前提交其基线。如果消费者应用更新后抛错，终结时也不会再次发出同一个 delta。命令会以 `callback_error` 失败。

### 工作负载行为

| 工作负载 | 结果 |
| --- | --- |
| 在上限内完成 | 立即发布初始状态、小型追加、强制发布最终状态 |
| 低于上限的涓流 | 独立写入立即发布；持续写入最多每 100 ms 一次 |
| 超过上限的全速输出 | 完整周转会产生按上限大小限制的替换，间隔由编码大小决定 |
| 超过上限后的涓流 | 小型且经过验证的 `slide` 更新保持响应；不会重新发送完整窗口 |
| 突发后静默 | 一个前导更新和一个尾部更新 |
| 错误、超时或中止 | 错误结算前强制发布最新有界状态 |

在 50 KB 上限、100 KB/s 目标下，重复的完整周转约稳定在每秒两次更新。超过上限后的较小 slide 仍使用 100 ms 下限。

速率上限是摊销意义上的。空闲后立即更新和强制终端更新可能各自产生一次受上限约束的突发。

## 5. 捕获和溢写

当解码后的、按行感知的工作缓冲区超过上限的四倍时，`OutputCapture` 会将其裁回上限的两倍。尾部模式丢弃旧文本；头部模式保留原始前缀。这样可以摊销 UTF-8 裁剪，而不是对每个进程 chunk 都重新扫描保留窗口。

溢写创建是延迟的。在超过上限之前，源端最多保留创建完整归档所需的有界前缀。超过上限后，它会：

1. 暂停 stdout 和 stderr，在执行环境内创建文件；
2. 打开一个持久追加流，high-water mark 限制为 8 MB；
3. 按到达顺序写入保留的原始前缀和后续原始 chunk；
4. 在写入器接受数据时立即恢复；
5. 只有当 `write()` 报告背压时才再次暂停，并在 `drain` 后恢复。

这既避免无界的 promise 链，也避免每个进程 chunk 都执行一次异步文件打开/追加循环。溢写创建或流写入失败会终止子进程并使执行失败，而不是发布丢失数据的成功结果。

溢写路径一旦可用，就作为 metadata 强制发布。最终输出刷新前会等待溢写写入完成。

Node 流在溢写路径中保持 raw，以获得吞吐量和精确的归档字节。`OutputCapture` 使用一个流式 `TextDecoder`，因此读取边界不会拆分 code point；无效的显示控制字符只从有界快照中移除，不会通过扫描完整 raw 流来移除。行总数包含最后一个未以换行结束的行，即使某一行超过工作缓冲区，`lastLineBytes` 仍保持精确。

## 6. 远程执行

当 worker 与执行环境同机时，更新在进程内传递，该发布器主要用于限制捕获工作。`ToolOutput` 仍是下游事件/持久化限速器。

当执行环境与 worker 物理分离时，同样的有界更新会跨越传输边界。全速输出不会传输完整流：中间写入在源端折叠，完整流保留在源端本地溢写文件中。

每个真实的高成本边界都有自己的发布器实例。同机部署可以绕过传输序列化；绕过 `ExecutionEnv` 的自定义工具仍会经过未来的 `ToolOutput` 发布器。

## 7. 剩余工作

- 将通用自定义工具组合、文本保留、事件发布和持久节奏移入 `ToolOutput`。
- 在下游边界用 Chord 操作替代完整的 `AgentToolResult` progress。
- 让 memo 和输出检查点持久化使用一个原子事务。
- 从持久输出而不是删除后的内容中为重放取种子。
- 将溢写文件放入环境所有的 session 目录，并在 session 生命周期结束加崩溃保留下限后清理。
- 决定图片和结构化详情的明确限制；文本已有上限，这些值尚未限制。
- 定义原始二进制输出行为。当前 shell 输出仍是有损 UTF-8 文本。
