# Pi evals

Pi evals 是面向 Pi 工作流的、由模型驱动的行为检查。它将真实的 `AgentSession` 适配到 `vitest-evals`，在隔离的临时项目和 Agent 目录中运行，并附带原生 Pi 会话产物。
可以用它测量端到端行为，并比较 Prompt、工具、Skill、模型或其他框架配置。

## 运行 evals

在仓库根目录使用默认供应商和模型运行：

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
```

等价的环境变量是：

```bash
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol npm run eval
```

CLI 参数优先，并会成为未显式选择模型的框架默认值。供应商和模型必须同时提供。如果每个执行的框架都配置了自己的模型，也可以不提供默认模型。认证来自 Pi 的普通 `ModelRuntime`，包括 Pi 订阅凭据和供应商 API Key 环境变量。

其他参数会转发给 Vitest：

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

每次执行都会打印一个被忽略的 `.eval/` 产物目录。`runs.jsonl` 会索引已完成的框架运行，以及 `sessions/` 下附带的原生 Pi 会话 JSONL。这些文件可能包含 Prompt、响应、源代码和工具输出。

## 编写 evals

通用测试套件、评判器、断言和规范化轨迹指南请遵循 [`vitest-evals`](https://github.com/getsentry/vitest-evals)。Pi 专用 eval 使用 `src/pi-harness.ts` 中的 `createPiCodingAgentHarness(...)`，每个 `describeEval(...)` 测试套件绑定一个框架：

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Pi smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### 配置 Pi 框架

`createPiCodingAgentHarness(...)` 接受：

- `name`：用于报告和比较的稳定框架标识。
- `model`：可选的 `{ provider, id }` 选择，会覆盖运行器的默认模型。
- `noTools`：Pi 的工具禁用配置。
- `transformSystemPrompt`：在 eval 开始前转换完整的默认 Prompt。
- `output`：将最终响应和 `AgentSession` 转换为 JSON 安全的领域结果。

显式选择模型后，模型比较框架就不再依赖运行器默认模型：

```ts
const harness = createPiCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

一次运行可以接受单个 Prompt，也可以接受 Prompt 与 reload 步骤序列。当之前的 Prompt 创建或修改了 Pi 资源时，reload 步骤很有用：

```ts
const result = await run([
	{ type: "prompt", content: "Create a Pi extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### 转换框架输出

使用 `output` 暴露场景特有且 JSON 安全的行为，无需把这些行为加入通用 Pi 适配器：

```ts
const harness = createPiCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

使用 `result.output` 断言应用行为。使用 `result.session` 断言模型和工具轨迹，可以使用 `toolCalls(...)` 等 `vitest-evals` 辅助函数。

### 编写比较型 eval 集合

Use `evalHarnessTable(...)` with Vitest's native `describe.for(...)` to run the same inputs against multiple harnesses.
Harnesses may differ by prompt, tools, skills, model, or any other Pi configuration:

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

比较型测试套件应使用确定性评判器或模型评判器记录正确性，并设置 `judgeThreshold: null`。这样低分会作为观测结果保留，而不会让 Vitest 执行失败。硬断言只用于测试套件不变量和基础设施契约。`expect.soft(...)` 仍会使测试失败，不能作为评分机制。

Pi 框架会在删除临时工作区前保存原生会话 JSONL 快照。仅用于 eval 的 `afterEach` Hook 会在报告器运行前，将该快照注册到明确的 Vitest 测试任务上。

框架名称在一个 eval 集合中必须稳定且唯一。分组键优先将重复次数与非空字符串 `input.id` 组合；如果没有 `input.id`，则使用严格规范化 JSON 输入的 SHA-256 哈希。单个处理使用 `candidate`，多个处理使用 `candidates`。每个候选项只与声明的基线比较。对于每个匹配的输入和重复项，报告器根据每次运行记录的平均评判分数计算通过率提升，并将分数至少为 `1` 视为通过。提升值是候选项通过率减去基线通过率，单位为百分点。缺失的评判分数会报告为不完整观测。Token、延迟和估算成本仍作为候选项减基线的配对差值单独记录；缺失的遥测数据保持不可用。如果确实需要随机化执行顺序，请使用 Vitest 内置的序列打乱功能。

关于比较型 eval 方法、重复策略、可信评判器和遥测数据解读，请参阅 [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) 指南。
