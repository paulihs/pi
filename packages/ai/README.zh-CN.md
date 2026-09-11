# @earendil-works/pi-ai

统一的 LLM API，支持提供商集合、自动认证解析、令牌和成本追踪，以及会话中简单的上下文持久化和模型间移交。

**注意**：本库仅包含支持工具调用（函数调用）的模型，因为这对 agent 工作流至关重要。

## 目录

- [支持的提供商](#支持的提供商)
- [安装](#安装)
- [快速入门](#快速入门)
- [提供商与模型](#提供商与模型)
  - [提供商工厂](#提供商工厂)
  - [所有内置提供商](#所有内置提供商)
  - [查询模型](#查询模型)
  - [静态目录读取](#静态目录读取)
  - [动态提供商](#动态提供商)
- [认证](#认证)
  - [认证解析方式](#认证解析方式)
  - [转换请求头](#转换请求头)
  - [凭据存储](#凭据存储)
  - [环境变量](#环境变量)
- [工具](#工具)
  - [定义工具](#定义工具)
  - [处理工具调用](#处理工具调用)
  - [使用部分 JSON 流式传输工具调用](#使用部分-json-流式传输工具调用)
  - [验证工具参数](#验证工具参数)
  - [完整事件参考](#完整事件参考)
  - [压缩助手消息帧](#压缩助手消息帧)
- [图像输入](#图像输入)
- [图像生成](#图像生成)
- [思考/推理](#思维推理)
  - [统一接口 (streamSimple/completeSimple)](#统一接口-streamsimplecompletesimple)
  - [提供商特定选项 (stream/complete)](#提供商特定选项-streamcomplete)
  - [流式传输思考内容](#流式传输思考内容)
- [停止原因](#停止原因)
- [错误处理](#错误处理)
  - [中止请求](#中止请求)
  - [中止后继续](#中止后继续)
  - [调试提供商负载](#调试提供商负载)
- [自定义提供商](#自定义提供商)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#直接调用-api-实现)
  - [OpenAI 兼容设置](#openai-兼容设置)
- [测试用 Faux Provider](#测试用-faux-provider)
- [跨提供商移交](#跨提供商移交)
- [上下文序列化](#上下文序列化)
- [浏览器中使用](#浏览器中使用)
- [打包和摇树优化](#打包和摇树优化)
- [OAuth 提供商](#oauth-提供商)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-登录)
  - [编程式 OAuth](#编程式-oauth)
- [从旧的全局 API 迁移](#从旧的全局-api-迁移)
- [开发](#开发)
- [许可证](#许可证)

## 支持的提供商

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex** (ChatGPT Plus/Pro 订阅，需要 OAuth，见下文)
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI** (通过 Vertex AI 的 Gemini)
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (全局)** (有独立的中国版提供商)
- **MiniMax** (有独立的中国版提供商)
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI** (有独立的中国版提供商)
- **GitHub Copilot** (需要 OAuth，见下文)
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks** (使用 OpenAI 和 Anthropic 兼容 API)
- **Kimi For Coding** (Moonshot AI 订阅端点，使用 Anthropic 兼容 API)
- **Qwen Token Plan** (独立的个人版和现有目录，有独立的中国版提供商)
- **Xiaomi MiMo** (默认为 API 计费端点，为 `cn`/`ams`/`sgp` 区域提供独立的 Token Plan 提供商)
- **任何 OpenAI 兼容的 API**：Ollama、vLLM、LM Studio 等

## 安装

```bash
npm install @earendil-works/pi-ai
```

TypeBox 导出从 `@earendil-works/pi-ai` 重新导出：`Type`、`Static` 和 `TSchema`。

## 快速入门

你构建一个 `Models` 集合来注册提供商并流式传输。最快捷的方式是注册所有内置提供商；关心包大小的应用则单独注册所需的提供商（参见[提供商工厂](#提供商工厂)和[打包和摇树优化](#打包和摇树优化)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 注册了每个内置提供商的 Models 集合
const models = builtinModels();

// 同步查询集合
const model = models.getModel('openai', 'gpt-4o-mini')!;

// 使用 TypeBox Schema 定义工具，确保类型安全和验证
const tools: Tool[] = [{
  name: 'get_time',
  description: '获取当前时间',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: '可选时区（例如 America/New_York）' }))
  })
}];

// 构建对话上下文（轻松序列化和在模型间转移）
const context: Context = {
  systemPrompt: '你是一个有用的助手。',
  messages: [{ role: 'user', content: '现在几点？', timestamp: Date.now() }],
  tools
};

// 方案 1：流式传输，包含所有事件类型。
// 认证通过提供商解析（此处从环境变量获取 OPENAI_API_KEY）。
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`开始使用 ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[文本开始]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[文本结束]');
      break;
    case 'thinking_start':
      console.log('[模型正在思考...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[思考完成]');
      break;
    case 'toolcall_start':
      console.log(`\n[工具调用开始：索引 ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 工具参数正在流式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[为 ${partialCall.name} 流式传输参数]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\n调用的工具：${event.toolCall.name}`);
      console.log(`参数：${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\n完成：${event.reason}`);
      break;
    case 'error':
      console.error(`错误：${event.error.errorMessage}`);
      break;
  }
}

// 流式结束后获取最终消息，加入上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 如果有工具调用则处理
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : '未知工具';

  // 将工具结果加入上下文（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如有工具调用则继续
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('工具执行后：', continuation.content);
}

console.log(`总令牌数：${finalMessage.usage.input} 进，${finalMessage.usage.output} 出`);
console.log(`成本：$${finalMessage.usage.cost.total.toFixed(4)}`);

// 方案 2：获取完整响应，不流式传输
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`工具：${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

本节其余部分的示例代码假设已配置好 `models` 集合（注册了相关提供商）。

## 提供商与模型

**提供商 (provider)** 是运行时单元：它拥有自己的模型目录、认证（API 密钥解析、OAuth 流程）和其流式行为。**`Models` 集合**持有提供商并将每个请求路由到拥有该模型的提供商。

提供商内部共享 **API 实现**（协议层）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 和大多数其他提供商共享 `openai-completions`。混合 API 提供商（GitHub Copilot、OpenCode Zen）则按模型分发。

### 提供商工厂

对于只需要特定提供商的应用，每个内置提供商都有一个工厂，作为子路径导入，仅拉取该提供商的目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ... 每个提供商对应一个模块，参见"支持的提供商"列表

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

提供商工厂导入其模型目录和一个懒加载的 API 包装器。它们不导入其他提供商。借助打包器的代码分割功能，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）保留在懒加载中，仅在首次请求对应 API 的模型时加载。

### 所有内置提供商

对于想要全部内容的应用（如快速入门所示）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 注册了每个内置提供商的 Models 集合
```

这导入了所有目录和每个内置提供商工厂。这是一个显式的重量级入口。`builtinModels()` 接受与 `createModels()` 相同的选项（`credentials`、`authContext`）；`builtinProviders()` 返回提供商数组，供你自行注册到自己的集合中。

### 查询模型

读取操作是同步的，返回最后已知的列表：

```typescript
const providers = models.getProviders();           // 注册的 Provider 对象
const provider = models.getProvider('anthropic');  // 单个提供商

const all = models.getModels();                    // 所有提供商中的所有模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  上下文窗口：${m.contextWindow} 令牌`);
  console.log(`  视觉支持：${m.input.includes('image')}`);
  console.log(`  推理支持：${m.reasoning}`);
}
```

动态列出的模型类型为 `Model<Api>`。使用 `hasApi()` 守卫进行收缩，以获得 API 特定的选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream 选项完全带类型
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

对于想要使用生成的内置目录且具有完整字面类型（提供商 ID 和模型 ID 自动完成）的工具，独立于任何集合：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 带类型的 Model<'openai-responses'>
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

### 动态提供商

提供商可以拥有动态模型列表（例如 llama.cpp 服务器、实时 OpenRouter 列表）。读取保持同步；获取则是显式的异步动词：

```typescript
// getModels() 返回最后已知的列表（首次刷新前为空）
await models.refresh({ providers: ['llamacpp'] }); // 刷新一个提供商
await models.refresh();                            // 并发刷新所有提供商，尽力而为
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置提供商对 `refresh()` 是无操作（no-op）。参见 [createProvider()](#createprovider) 来构建动态提供商。

## 认证

每个提供商都管理自己的认证：如何解析 API 密钥（存储的凭据、环境变量、AWS 配置文件或 gcloud ADC 等环境源），以及在支持的条件下，OAuth 登录/刷新流程。

### 认证解析方式

当你调用 `models.stream()` 时，集合通过所属提供商解析认证并将其合并到请求中。请求级别的显式值永远优先：

```typescript
// 通过提供商解析（环境变量、存储的凭据、OAuth 令牌）：
await models.complete(model, context);

// 显式密钥优先于提供商可能解析的任何内容：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你可以在不发起请求的情况下检查解析结果。传入提供商 ID 以获取提供商范围的认证，或传入模型以包含其静态 `model.headers`：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`通过 ${modelAuth.source} 配置`); // 例如 "ANTHROPIC_API_KEY"、"OAuth"、"存储的凭据"
  console.log(modelAuth.auth.headers);             // 提供商认证头 + model.headers
} else {
  console.log('未配置');
}
```

两者的重载都会解析凭据、刷新过期的 OAuth（如需要），并且可能返回带有 `apiKey`、`headers` 或 `baseUrl` 的认证。`getAuth()` 对未配置的提供商返回 `undefined`，当出现真正错误时在 `ModelsError` 中拒绝（`"oauth"`：令牌刷新失败，凭据保留用于重新登录；`"auth"`：密钥解析或凭据存储失败）。请求路径将同样的故障作为流式错误暴露。

`getAuth()`、`checkAuth()`、`getAvailable()`、登录和注销接受可选的调用方取消，通过现有的选项或交互对象，且在无信号时保持无界。提供商 `login`、`ApiKeyAuth.check`、`ApiKeyAuth.resolve` 和 `OAuthAuth.refresh` 实现始终接收具体的信号，必须对其阻塞工作遵守信号。

### 转换请求头

`Models.stream()`、`complete()`、`streamSimple()` 和 `completeSimple()` 接受一个仅限 Models 的 `transformHeaders` 选项。它在提供商认证、`model.headers` 和显式 `options.headers` 合并之后运行，但在提供商调度之前：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

顺序为：

```text
提供商认证头 -> model.headers -> 显式 options.headers -> transformHeaders -> Provider.stream*()
```

头部名称按大小写不敏感合并。显式头部覆盖认证/模型头部，transform 具有最终控制权；返回 `null` 可抑制较低层的默认值，从而支持删除。

`transformHeaders` 属于 `Models`，不属于 `Provider`。`Models` 实现必须在调用 `Provider.stream*()` 之前消耗此选项并将其移除。`Provider` 实现继续接收普通的 `ApiStreamOptions` 或 `SimpleStreamOptions`，且从不自行处理 transform。使用此选项代替在 `stream*()` 之前调用 `getAuth(model)`，后者会双重解析请求认证。

### 凭据存储

存储的凭据（交互式输入的 API 密钥、OAuth 令牌）存在于 `CredentialStore` 中——每个提供商一个类型标记凭据。pi-ai 附带一个内存中的默认值；应用注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 接受相同选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

合约很小：`read(providerId)`、`list()` 用于非秘密的 `{ providerId, type }` 元数据枚举、`modify(providerId, fn)`（唯一的路径——序列化后的读写）、`delete(providerId)`。每个操作接受可选的取消选项。枚举不得解析秘密或执行配置的密钥命令。OAuth 令牌刷新在 `modify` 内运行，因此并发请求和进程无法重复刷新旋转令牌。一个存储的凭据*拥有*其提供商：环境变量仅在未存储任何东西时才被咨询，且刷新失败永远不会静默回退到环境变量密钥。

API 密钥凭据使用与 pi 的 `auth.json` 相同的判别符，可以携带提供商范围的环境/配置值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### 环境变量

内置提供商解析以下环境变量（Node.js；浏览器中需显式传递 `apiKey`）：

| 提供商 | 环境变量 |
|----------|--------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (全局) | `ZAI_API_KEY` |
| ZAI Coding Plan (中国) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (全球) | `MINIMAX_API_KEY` |
| MiniMax (中国) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (中国) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Qwen Token Plan (现有目录) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (个人) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (中国) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo (API 计费) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (中国) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (阿姆斯特丹) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (新加坡) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`qwen-token-plan-individual` 和 `qwen-token-plan` 共享国际端点和
`QWEN_TOKEN_PLAN_API_KEY`。个人提供商仅为其文档记录的个人订阅公开模型，而现有提供商保留更广泛的目录以保持向后兼容。存储的凭据仍按提供商作用域保存，因此在对应的提供商 ID 下保存密钥。

Amazon Bedrock 解析环境 AWS 凭据（`AWS_PROFILE`、访问密钥对、`AWS_BEARER_TOKEN_BEDROCK`、ECS 任务角色、Web 身份令牌）；其提供商拥有的登录流程支持bearer token、AWS 配置文件和现有凭据链。Vertex AI 解析显式密钥或 gcloud 应用默认凭据加上项目/位置，并提供用于 API 密钥、ADC 和服务账号文件的提供商拥有的登录流程。

## 工具

工具使 LLM 能够与外部系统交互。本库使用 TypeBox schemas 提供类型安全的工具定义，并使用 TypeBox 内置验证器和值转换工具自动验证。TypeBox schemas 可以序列化和反序列化为纯 JSON，使其适合分布式系统。

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// 使用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取某地的当前天气',
  parameters: Type.Object({
    location: Type.String({ description: '城市名称或坐标' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为了 Google API 兼容性，使用 StringEnum 辅助函数而不是 Type.Enum
// Type.Enum 生成 Google 不支持的 anyOf/const 模式

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: '预约会议',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 工具的约束采样

工具可以选择启用提供商侧约束采样。对于 JSON schema 工具，`strict: 'prefer'` 在受支持时使用提供商侧严格 schema 强制执行，否则回退到普通工具调用。`strict: 'require'` 在活动提供商/模型无法满足时使请求失败。设置 `constrainedSampling: false` 显式排除；其行为与省略该字段相同。

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: '编辑文件',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

严格 JSON schema 约束采样适用于 OpenAI、Anthropic、支持的 Amazon Bedrock Converse 模型、Mistral 和 Gemini 3 的 Google Generative AI 和 Vertex 适配器中的工具调用。Google 使用 `VALIDATED` 函数调用模式（或显式请求时的 `ANY`）；早期的 Gemini 版本对 `strict: 'prefer'` 回退，对 `strict: 'require'` 拒绝，因为它们不强制执行必需参数。Bedrock 严格工具能力由模型结构化输出元数据生成；自定义 Bedrock 模型可以通过 `compat.supportsStrictMode` 覆盖。OpenAI Responses 和 Chat Completions 也可以使用 OpenAI Lark 或正则语法变体发出语法约束自定义工具。如果提供了多个 OpenAI 变体，Lark 优先于正则。语法约束仅在活动模型支持语法工具时强制执行；否则工具回退到普通函数/JSON schema 处理。语法工具能力是模型元数据：生成的目录为端点上支持 OpenAI 自定义工具的 GPT-5+ 模型设置 `compat.supportsOpenAIGrammarTools`（OpenAI、OpenAI Codex、Azure OpenAI Responses、GitHub Copilot、opencode 和 Cloudflare AI Gateway）。OpenAI 拒绝 GPT-5 之前的模型对 `type: "custom"` 工具，代理网关（例如 OpenRouter）扭曲它们，因此标志在其他地方保持关闭。自定义模型定义可以通过 `compat` 选择加入。语法模型在非空支持变体的情况下拒绝语法配置。原生语法工具必须有对象参数 schema，且恰好有一个必需的字符串属性：

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: '应用补丁',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### 处理工具调用

工具结果使用内容块，可以包含文本和图像：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: '伦敦的天气如何？', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 使用参数执行你的工具
    // 参见"验证工具参数"节了解验证
    const result = await executeWeatherApi(block.arguments);

    // 将工具结果加入，包含文本内容
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具结果也可以包含图像（用于视觉支持的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: '显示温度趋势生成的图表' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 使用部分 JSON 流式传输工具调用

流式传输期间，工具调用参数会随着到达渐进解析。这使得在完成参数可用之前就可以实时更新 UI：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments 包含流式传输过程中部分解析的 JSON
    // 这允许用于渐进的 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 务必保守对待：参数可能不完整
      // 示例：即使在内容完整之前也显示文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`写入到：${toolCall.arguments.path}`);

        // 内容可能部分或缺失
        if (toolCall.arguments.content) {
          console.log(`内容预览：${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此时 toolCall.arguments 已完成（但尚未验证）
    const toolCall = event.toolCall;
    console.log(`工具完成：${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要注意事项：**
- 在 `toolcall_delta` 事件中，`arguments` 包含部分 JSON 的最佳努力解析
- 字段可能缺失或不完整——使用前务必检查存在性
- 字符串值可能在单词中间被截断
- 数组可能不完整
- 嵌套对象可能部分填充
- 最少情况下，`arguments` 总是至少是一个空对象 `{}`，绝不 `undefined`
- Google 提供商不支持函数调用流式传输。相反，你会收到一个带有完整参数的单一 `toolcall_delta` 事件。

### 验证工具参数

在实现自己的工具执行循环时，在使用工具之前使用 `validateToolCall` 验证参数：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 根据工具的 Schema 验证参数（无效参数时抛出异常）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... 将工具结果加入上下文
    } catch (error) {
      // 验证失败——返回错误作为工具结果，以便模型重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整事件参考

成功的生成遵循 `start → updates* → done`。生成开始后发生故障遵循 `start → updates* → error`。请求setup可能在进行开始之前失败，这种情况下流仅包含 `error`；`done` 和更新事件在 `start` 之前无效。直接 API `streamSimple()` 调用在缺少请求认证时同步抛出。

每个非终端事件的 `partial` 是共享的实时响应进展辅助对象。它故意不是事件时间快照：提供商可能在生成前进时变异同一条消息和内容块，即使较老的事件等待在流队列中。在处理事件时检查它，而不是将其保留为历史状态。文本和普通思考块在其 `*_start` 事件发射时为空，仅通过匹配的 `*_delta` 事件增长直到权威的 `*_end`；缩略处理的思考可能在开始时就已经完整且不发射任何 delta。`toolcall_start` 处的工具调用参数是提供商特定的；`toolcall_delta` 携带随后的 JSON 更新。

助手消息生成期间的全部流式事件：

| 事件类型 | 描述 | 关键属性 |
|------------|---------|------|
| `start` | 流开始 | `partial`: 初始助手消息结构 |
| `text_start` | 文本块开始 | `contentIndex`: 内容数组中的位置 |
| `text_delta` | 收到文本块 | `delta`: 新文本, `contentIndex`: 位置 |
| `text_end` | 文本块完成 | `content`: 完整文本, `contentIndex`: 位置 |
| `thinking_start` | 思考块开始 | `contentIndex`: 内容数组中的位置 |
| `thinking_delta` | 收到思考块 | `delta`: 新文本, `contentIndex`: 位置 |
| `thinking_end` | 思考块完成 | `content`: 完整思考, `contentIndex`: 位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`: 内容数组中的位置 |
| `toolcall_delta` | 工具参数流式传输 | `delta`: JSON 块, `partial.content[contentIndex].arguments`: 部分解析的参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`: 完整的但未通过 schema 验证的工具调用，带有 `id`、`name`、`arguments` |
| `done` | 流完成 | `reason`: 停止原因 ("stop", "length", "toolUse"), `message`: 最终助手消息 |
| `error` | 发生错误 | `reason`: 错误类型 ("error" 或 "aborted"), `error`: 带有部分内容的 AssistantMessage |

不同内容块的流式事件不保证连续。提供商可能在下同一个上游块中为文本、思考和工具调用发射 delta，pi 可能表现出相应交错事件，例如 `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`。消费者必须使用 `contentIndex` 将每个 delta/end 事件与其块关联，且不得假设一个块的 `*_start`/`*_delta`/`*_end` 序列不被其他块的事件打断。

### 压缩助手消息帧

`AssistantMessageFrameEncoder` 将一个流转换为紧凑、可持久的 `AssistantMessageFrame` 值。每流创建一个编码器，并按顺序输入每个事件。编码器理解 `partial` 是活性的：一个块启动事件在提供者已经排队的后来的 delta 后被消费，一次性捕获当前块，并且已覆盖的排队文本/思考 delta 不产生重复帧。它只保留每个开放块的计数器外加临时地，为已经推进的工具调用同步所需原始前缀。它永远不会为每个令牌克隆增长中的完整部分。

启动帧包含带有空内容的消息元数据。文本和思考帧在每个生成字符最多一次之前存储。已经在其启动事件被消费时推进的工具调用使用普通的 delta 恢复之前的一个紧凑 JSON 检查点。终止的 `done` 和 `error` 事件不产生帧，因为最终消息结算分开处理。预生成的 `error` 因此不产生任何帧。

`reduceAssistantMessageFrames()` 是标准纯约简器。它重建文本、思考和工具调用参数，包括由 `contentIndex` 识别的交错块，并拒绝损坏的序列。它对可迭代对象执行单次遍历，在没有启动帧时返回 `undefined`。结束帧用提供商权威完成的內容和元数据替换块。约简器不过渡用 TypeBox Schema 验证工具参数；在执行前调用 `validateToolCall`。

```typescript
import {
  AssistantMessageFrameEncoder,
  reduceAssistantMessageFrames,
  type AssistantMessageFrame,
} from '@earendil-works/pi-ai';

const encoder = new AssistantMessageFrameEncoder();
const frames: AssistantMessageFrame[] = [];
for await (const event of s) {
  const frame = encoder.encode(event);
  if (frame) frames.push(frame);
}

const reconstructedPartial = reduceAssistantMessageFrames(frames);
const finalMessage = await s.result(); // 分别持久化终端结算。
```

编码器拒绝重复的启动、启动前的事件、启动前的 `done`、终端事件后的事件、重复的块启动和块类型不匹配。启动前的 `error` 有效且返回无帧。

## 图像输入

具有视觉能力的模型可以处理图像。你可以透过 `input` 属性检查模型是否支持图像。如果你传递给非视觉模型图像，它们会被忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持图像
if (model.input.includes('image')) {
  console.log('模型支持视觉');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这幅图像中有什么？' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// 访问响应
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 图像生成

图像生成使用与文本/聊天生成分离的 API 表面，反映聊天端的设计：`ImagesModels` 集合保存 `ImagesProvider`，读取是同步的，认证通过所属提供商解析。图像生成是一次性 API：`generateImages()` 等待提供商响应并返回最终的 `AssistantImages` 结果——不要为此使用聊天/流 API。

### 基本图像生成

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

// 每个内置图像生成提供商；接受与 createModels() 相同的选项
const imagesModels = builtinImagesModels();

const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

// 认证通过提供商解析（此处为 OPENROUTER_API_KEY）；显式 apiKey 优先
const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: '在纯白背景上生成一个红色圆圈。' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

与聊天端相同，你可以从部分构建集合：`createImagesModels({ credentials?, authContext? })`、来自 `@earendil-works/pi-ai/providers/openrouter-images` 的 `openrouterImagesProvider()` 工厂，和用于自定义图像提供商的 `createImagesProvider({ id, auth, models, refreshModels?, api })`（带有 `imagesModels.refresh(provider?)` 的动态列表）。故障从不拒绝——它们返回带有 `stopReason: "error"` 的 `AssistantImages`。集合的提供商作用域的 `getAuth(providerId)` 工作方式与聊天端的相同。

旧的 global API (`getImageModel()` / `generateImages()` / `getImageProviders()` / `generateImages()`) 仍在[兼容入口](#从旧的全局-api-迁移)上可用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: '在纯白背景上生成一个红色圆圈。' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

某些模型也支持图像输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await imagesModels.generateImages(model, {
  input: [
    { type: 'text', text: '创建这个图像的蓝色背景变体。' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

在模型元数据上检查能力：

```typescript
console.log(model.input);   // ['text', 'image']
console.log(model.output);  // ['image'] 或 ['image', 'text']
```

### 注意事项和限制

- 图像模型位于 `ImagesModels` 集合中，聊天模型在 `Models` 集合中；两者是不同的表面。
- 使用 `generateImages()`，而非聊天/流 API。
- 图像生成模型不参与工具调用。
- 输出在 `AssistantImages.output` 中返回，可以包含 base64 编码的 `ImageContent` 块和 `TextContent` 块。
- 某些模型仅返回图像，另一些返回图像加文本。检查 `model.output`。
- 某些模型接受图像输入，另一些是文生图模型。检查 `model.input`。
- 与流 API 一样，图像生成支持 `apiKey`、`signal`、`headers`、`onPayload`、`onResponse` 等选项，结果可能包含 `stopReason`、`responseId` 和 `usage`。
- 如果你想要在对话中让模型分析图像或调用工具，使用支持图像输入的聊天 API 的常规模型。
- 目前，图像生成仅通过一个提供商可用，即 OpenRouter。

## 思维/推理

许多模型支持思考/推理能力，它们可以展示其内部思考过程。您可以通过 `reasoning` 属性检查模型是否支持推理。如果你向不支持推理的模型传递推理选项，它们将被忽略。

### 统一接口 (streamSimple/completeSimple)

```typescript
// 许多跨提供商的模型支持思考/推理
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或者 models.getModel('openai', 'gpt-5-mini');
// 或者 models.getModel('google', 'gemini-2.5-flash');
// 或者 models.getModel('xai', 'grok-4.6');

// 检查模型是否支持推理
if (model.reasoning) {
  console.log('模型支持推理/思考');
}

// 使用简化的推理选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: '求解：2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// 访问思考和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('思考：', block.thinking);
  } else if (block.type === 'text') {
    console.log('响应：', block.text);
  }
}
```

`xhigh` 和 `max` 是模型特定的、需显式开启的级别。使用 `getSupportedThinkingLevels(model)` 确定具体模型是否暴露任一水平；诸如 GPT-5.6 之类的模型可以同时暴露两者。

### 提供商特定选项 (stream/complete)

`models.stream()`/`complete()` 接受所属 API 的完整选项集。使用 `hasApi()` 动态查找的模型到你的 API 以获取完整选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅限 OpenAI Responses API
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 可选令牌限制
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 表示动态, 0 表示禁用
    }
  });
}
```

### 流式传输思考内容

当流式传输时，思考内容通过特定事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[模型开始思考]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式传输思考内容
      break;
    case 'thinking_end':
      console.log('\n[思考完成]');
      break;
  }
}
```

## 停止原因

每条 `AssistantMessage` 都包含一个 `stopReason` 字段，表示生成是如何结束的：

- `"pending"` — 只在不知道停止原因的 partial 消息中存在
- `"stop"` — 模型在此轮将生产的最终消息
- `"length"` — 输出达到最大令牌限制
- `"toolUse"` — 模型正在调用工具并期望工具结果
- `"error"` — 生成期间发生错误
- `"aborted"` — 请求通过中止信号取消

`AssistantMessage` 还可以包含 `responseId`，提供商特定的上游响应或消息标识符，在底层 API 暴露时。不要假定它在所有提供商中都存在。

## 错误处理

生成开始后的请求故障从不抛出：当请求以错误结束时（包括中止和工具调用验证故障），流式 API 发射 error 事件，最终消息携带详细信息。生成前的 setup 故障可能在没有 `start` 的情况下发射 `error`；生成开始后的故障先发射 `start`、任何观察到的更新，然后发射 `error`。直接 API `streamSimple()` 调用在缺少请求认证时同步抛出：

```typescript
// 在流式中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 是 "error" 或 "aborted"
    // event.error 是带有部分内容的 AssistantMessage
    console.error(`错误 (${event.reason}):`, event.error.errorMessage);
    console.log('部分内容：', event.error.content);
  }
}

// 最终消息将包含错误详情
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('请求失败：', message.errorMessage);
  // message.content 包含错误发生前接收的任何部分内容
  // message.usage 包含部分令牌计数和成本
}
```

当使用提供商集合时，认证故障（OAuth 刷新失败、未知提供商）作为带有 `stopReason: "error"` 的流错误暴露。直接 API `streamSimple()` 调用则在必需认证不存在时同步抛出：

### 中止请求

中止信号允许你取消正在进行的请求。被中止的请求带有 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: '写一个长故事', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 告诉你这是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? '已中止' : '错误'}：`, event.error.errorMessage);
  }
}

// 获取结果（如果被中止可能是部分的）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('请求被中止：', response.errorMessage);
  console.log('接收到的部分内容：', response.content);
  console.log('使用的令牌：', response.usage);
}
```

### 中止后继续

被中止的消息可以加入到对话上下文中，并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: '详细解释量子计算', timestamp: Date.now() }
  ]
};

// 第一个请求 2 秒后被中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 将部分响应加入到上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: '请继续', timestamp: Date.now() });

// 继续对话
const continuation = await models.complete(model, context);
```

### 调试提供商负载

使用 `onPayload` 回调来检查发送给提供商的请求负载。这对于调试请求格式问题或提供商验证错误很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('提供商负载：', JSON.stringify(payload, null, 2));
  }
});
```

回调由 `stream`、`complete`、`streamSimple` 和 `completeSimple` 支持。

## 自定义提供商

### createProvider()

`createProvider()` 从部分组成一个提供商：身份、认证、模型列表和 API 实现。用于本地推理服务器、代理或任何 OpenAI/Anthropic 兼容的端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 每个提供商声明认证；无键的本地服务器解析为配置的无键状态。
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于真实密钥的提供商，`envApiKeyAuth(displayName, envVars)` 提供标准行为（存储的凭优优先，然后是第一组的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('我的代理 API 密钥', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 提供商通过按 `model.api` 键控的映射传递；每个模型分派到其 API 的实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* 带有 api: 'anthropic-messages' 或 'openai-responses' 的模型 */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

提供商范围端点或请求变换属于提供商 API 实现：包装作为 `api` 传入的 `ProviderStreams`，使得每个请求都在调度之前经过变换。Cloudflare 提供商这样做来将账户/网关端点占位符从解析的提供商环境中具现化：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

动态模型列表使用 `fetchModels`。`Models.refresh()` 刷新每个配置的动态提供商，传递其有效的 API 密钥或刷新后的 OAuth 凭据。一个 `ModelsStore` 持久化动态目录；两者默认为内存中实现。它的 `read`、`write` 和 `delete` 操作接受可选取消，`Models` 将那些等待绑定到提供商刷新信号。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` 在其可选信号被省略时无界。提供商始终接收具体的 `RefreshModelsContext.signal` 且必须对其阻塞网络请求和其他阻塞工作遵守它。当调用方提供信号时，`Models.refresh()` 即使自定义提供商未能合作，也会取消后立即返回 `aborted: true`；提供商必须仍然遵守信号以停止其底层工作。

使用 `models.refresh({ providers: ['openrouter'] })` 限制工作到选定的提供商，`models.refresh({ allowNetwork: false })` 在不联网的情况下恢复持久化目录，或 `models.refresh({ force: true })` 绕过提供商新鲜度检查。模型读取保持同步并返回最后恢复或刷新的列表。

`createProvider()` 自动处理动态发布和持久化。手写 `Provider.refreshModels()` 实现接收只读 `context.stored` 快照并通过 `context.publish({ persist?, update? })` 发布。省略 `persist` 保持存储不变，传入 `ModelsStoreEntry` 以写入，或传入 `persist: null` 以删除。发布是按代数检查的；将同步的内存中目录更改放在 `update` 中而不是在发布前突变状态。

自定义模型可以携带 `headers`（例如，需要通过机器人检测的代理）和 `compat` 标志。`Models.getAuth(model)` 包括那些模型头部，流方法在显式请求头和 `transformHeaders` 之前合并它们。参见 [OpenAI 兼容设置](#openai-兼容设置)。

一些 OpenAI 兼容的服务器不理解推理能力模型使用的 `developer` 角色。对于那些提供商，设置 `compat.supportsDeveloperRole` 为 `false` 这样系统提示就被作为 `system` 消息发送。如果服务器也不支持 `reasoning_effort`，也把 `compat.supportsReasoningEffort` 设为 `false`。这通常适用于 Ollama、vLLM、SGLang 和类似的 OpenAI 兼容服务器。

使用模型级别的 `thinkingLevelMap` 来描述模型特定的思考控制。键是 pi 思考级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。缺少的标准级别通过 `high` 使用提供商默认值；`xhigh` 和 `max` 是需要非 null map条目的可选模式。字符串值发送到提供商，`null` 标记级别不受支持，map 可能跳过级别。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### 直接调用 API 实现

API 实现是可独立导入的。每个模块恰当地导出 `stream` 和 `streamSimple` 及其 API 的完整选项类型。直接调用绕过提供商认证——显式传递 `apiKey`：

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现居住在 `./api/<api-id>`：

| API id | Options 类型 |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

从自身导入 API 实现模块会加载其 SDK。`./api/<api-id>.lazy` 包装器（由提供商工厂使用）在有条件的运行时或捆绑器支持动态 import 分块时延迟加载。旧的原始 API 子路径从旧版本（`./anthropic`、`./google`、`./mistral`、`./openai-completions`、...）已被移除；使用 `@earendil-works/pi-ai/api/<api-id>`。

### OpenAI 兼容设置

`openai-completions` API 由许多提供商实现，带有一些小差异。默认情况下，该库基于 `baseUrl` 为少量已知 OpenAI 兼容提供商自动检测兼容设置（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` 模型，compat 字段支持 Responses 特定的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // 提供商是否支持 `store` 字段（默认：true）
  supportsDeveloperRole?: boolean;   // 提供商是否支持 `developer` 角色 vs `system`（默认：true）
  supportsReasoningEffort?: boolean; // 提供商是否支持 `reasoning_effort`（默认：true）
  supportsUsageInStreaming?: boolean; // 提供商是否支持 `stream_options: { include_usage: true }`（默认：true）
  supportsStrictMode?: boolean;      // 提供商是否支持工具定义中的 `strict`（默认：true）
  supportsOpenAIGrammarTools?: boolean; // 是否发射 OpenAI 自定义 Lark/正则语法工具；false 回退到普通函数工具（默认：false；生成的目录启用具备能力的模型）
  sendSessionAffinityHeaders?: boolean; // 从 `sessionId` 发送会话亲和数据（默认：false）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和格式：'openai' 使用 `prompt_cache_key`、`session_id`、`x-client-request-id` 和 `x-session-affinity`；'openai-nosession' 使用 `prompt_cache_key`、`x-client-request-id` 和 `x-session-affinity`；'openrouter' 使用 `x-session-id`（默认：自动检测）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名（默认：max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具结果是否需要 `name` 字段（默认：false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟一个 assistant 消息（默认：false）
  requiresThinkingAsText?: boolean;  // 思考块是否必须转换为文本（默认：false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 推理启用时是否所有重放的 assistant 消息都必须包含空的 reasoning_content（默认：DeepSeek 自动检测）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // 推理参数的格式：'openai' 使用 reasoning_effort，'openrouter' 使用 reasoning: { effort }，'deepseek' 使用 thinking: { type } 以及支持时加上 reasoning_effort，'together' 使用 reasoning: { enabled } 以及支持时加上 reasoning_effort，'baseten' 使用可配置的 chat_template_args 以及支持时加上 reasoning_effort，'zai' 使用 thinking: { type }，'qwen' 使用 enable_thinking，'chat-template' 使用可配置的 chat_template_kwargs，'qwen-chat-template' 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking，'string-thinking' 使用顶层 thinking，'ant-ling' 仅对映射的 efforts 使用 reasoning: { effort }（默认：openai）
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs 值；使用 $var 表示 pi 控制的思考值
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // thinkingFormat: 'baseten' 的 chat_template_args 值；使用 $var 表示 pi 控制的思考值
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // 从 thinkingBudgets 盖住推理令牌的顶层字段（vLLM / Qwen / llama.cpp）。默认关闭。
  supportsThinkingTokenBudget?: boolean; // thinkingTokenBudgetField: 'thinking_token_budget' 的别名（vLLM）。优先使用 thinkingTokenBudgetField。默认：false。
  cacheControlFormat?: 'anthropic';  // 系统提示、最后一个工具和最后一个用户/assistant 文本内容上的 Anthropic 风格 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好（默认：{}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好（默认：{}）
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // 提供商是否支持 `developer` 角色 vs `system`（默认：true）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和头部格式：'openai' 发送 `session_id` 和 `x-client-request-id`；'openai-nosession' 发送 `x-client-request-id`；'openrouter' 发送 `x-session-id`。不影响 `prompt_cache_retention: "24h"` 主体参数（默认：自动检测）
  supportsLongCacheRetention?: boolean; // 提供商是否支持 `prompt_cache_retention: "24h"`（默认：true）
  supportsStrictMode?: boolean;      // 提供商是否支持严格 JSON schema 函数工具（默认：false；构建的 OpenAI 模型元数据中启用）
  supportsOpenAIGrammarTools?: boolean; // 是否发射 OpenAI 自定义 Lark/正则语法工具；false 回退到普通函数工具（默认：false；生成的目录启用具备能力的模型）
}
```

如果没有设置 `compat`，库回退到基于 URL 的检测。如果 `compat` 部分设置，未指定的字段使用检测的默认值。这对以下场景有用：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准字段名
- **自托管端点**：可能有不同的功能支持

## 测试用 Faux Provider

`fauxProvider()` 构建一个内存中的提供商，带有脚本化响应，用于测试和演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // 可选
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: '总结 package.json 然后调用 echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('需要先检查包元数据。'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('现在我可以总结工具输出了。'),
    fauxText('这是摘要。')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 可选：为模型切换测试创建多个 faux 模型
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

注意事项：
- 响应按请求启动顺序从队列中消费。
- 如果队列为空，faux 提供商返回带有 `errorMessage: "No more faux responses queued"` 的助手错误消息。
- 使用 `faux.setResponses([...])` 替换剩余队列，使用 `faux.appendResponses([...])` 添加更多响应。
- `faux.models` 暴露全部 faux 模型。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回特定的一个。
- 使用 `fauxAssistantMessage(...)` 进行脚本化的助手回复。使用 `fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 构建内容块而不手动填写低级字段。
- 用量估计约为每 4 字符 1 个令牌。当存在 `sessionId` 且 `cacheRetention` 不为 `"none"` 时，提示缓存读取和写入会自动模拟。
- 工具调用参数通过 `toolcall_delta` 块增量流式传输。
- 默认情况下，每个流式块在各自微任务上发射。设置 `tokensPerSecond` 以真实时间编排块交付。
- 预期用法是每个句柄一个确定性脚本化流程。如果你需要独立的并发流程，创建具有不同 `provider` ID 的单独的 faux 提供商。

## 跨提供商移交

库支持在同一对话内不同 LLM 提供商之间的无缝移交。这允许你在对话中途切换模型同时保持上下文，包括思考块、工具调用和工具结果。

当从一个提供商的消息发送到不同提供商时，库自动将其转换为兼容格式：

- **用户和工具结果消息** 原样传递
- **来自同一提供商/API 的 assistant 消息** 保持不变
- **来自不同提供商的 assistant 消息** 将其思考块转换为带有 `<thinking>` 标签的文本
- **工具调用和常规文本** 保持不变

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// 从 Claude 开始
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: '25 * 18 等于多少？', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 切换到 GPT-5 —— 它会看到 Claude 的思考作为 <thinking> 标记文本
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: '这个计算正确吗？', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 切换到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: '原始问题是什么？', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有提供商都可以处理来自其他提供商的消息——文本、工具调用和结果（包括图像）、思考块（转换为带标签文本）以及带有部分内容的中止消息。这使灵活工作流成为可能：先用快速模型，切换到更有能力的模型进行复杂推理，或在提供商出现故障时保持连续性。

## 上下文序列化

`Context` 对象可以轻松序列化和反序列化，使用标准 JSON 方法，使得持久化对话、实现聊天历史或在服务间转移上下文变得简单：

```typescript
const context: Context = {
  systemPrompt: '你是一个有用的助手。',
  messages: [
    { role: 'user', content: '什么是 TypeScript？', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等。
localStorage.setItem('conversation', serialized);

// 稍后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: '多说说它的类型系统', timestamp: Date.now() });

// 用任意模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

模型只是可序列化的数据——没有附加功能或实现——所以持久化"使用哪个模型进行此对话"不过是 `JSON.stringify` 的事。

> **注意**：如果上下文包含图像（如图像部分所示以 base64 编码），它们也将被序列化。

## 浏览器中使用

该库支持浏览器环境。核心入口点和提供商工厂无副作用且干净打包。浏览器中没有环境变量，因此显式传递 API 密钥——或注入 `CredentialStore`（例如 localStorage 支持的）并让提供商认证从存储的凭据解析：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: '你好！', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API 密钥是很危险的。任何人都可以提取和滥用你的密钥。仅将此方法用于内部工具或演示。对于生产应用程序，请使用保持 API 密钥安全的后端代理。

浏览器兼容性说明：

- Amazon Bedrock (`bedrock-converse-stream`) 在浏览器环境中不受支持。它仍可以出现在模型列表中；调用在运行时失败。
- OAuth 登录流程是 Node-only 的。它们在懒加载后面载货 behind bundler-opaque imports，所以在注册的具备 OAuth 能力的提供商不会将 Node-only 代码拉入浏览器 bundle——实际上登录才会。
- 如果需要来自 Web 应用的 Bedrock 或基于 OAuth 的认证，使用服务端代理或后端服务。

## 打包和摇树优化

对小包，只导入你需要的提供商：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- `@earendil-works/pi-ai` 是核心入口点，不导入内置目录、提供商工厂或 SDK 实现。
- `@earendil-works/pi-ai/providers/<provider>` 导入该提供商的目录和懒加载 API 包装器。
- `@earendil-works/pi-ai/providers/all` 导入每个内置提供商工厂和所有目录。仅在你想要完整的内置集时使用它。
- 借助代码分割，提供商 SDK 保留在懒加载中，在首次请求该 API 的模型时加载。
- 无代码分割时，打包器折叠可达的懒 API 实现进入单 bundle。单提供商 bundle 然后包含该提供商的 SDK；`providers/all` 包含所有静态可见 SDK。Bedrock 是例外：其 AWS SDK 实现通过 bundler-opaque 的 Node-only 导入加载。
- 直接在 `@earendil-works/pi-ai/api/<api-id>` 导入 API 实现模块立即加载该 API 实现及其 SDK。

避免在新打包应用中 `@earendil-works/pi-ai/compat`；它保留旧的全局 API 并导入全内置目录表面。

对于单文件 Node ESM bundle，某些 SDK 依赖可能仍然使用动态 CommonJS `require()` 内部。如果你看到类似 `Dynamic require of "child_process" is not supported` 的错误，向 bundle 添加 Node `require` shim。使用 esbuild：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这只适用于 Node bundle；它不是浏览器或 Cloudflare Workers 的解决方法。

Bedrock 是 Node-only 的。像任何其他提供商一样注册它：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

正常 Node 包使用和代码分割 bundle 中，Bedrock 懒加载其 AWS SDK 实现。对于必须包含 Bedrock 支持的独立单文件 bundle，显式注册实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

那个显式覆盖打包了 AWS SDK。不带它的话，Bedrock 的透明运行时导入需要运行时包的 Bedrock 实现文件。

### 提供商范围的环境覆盖

在流选项中传递 `env` 以将提供商配置限定到请求级别。`env` 中的值优先于 process 环境变量用于提供商认证和配置，例如 Cloudflare 账户 ID、Azure OpenAI 设置、Vertex 项目/位置、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY`。

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

当一个进程需要在每个请求时使用不同的提供商设置，或环境不应泄漏到提供商调用时应使用此方法。

## OAuth 提供商

几个提供商支持 OAuth 认证而不是静态 API 密钥：

- **Anthropic** (Claude Pro/Max 订阅)
- **OpenAI Codex** (ChatGPT Plus/Pro 订阅，访问 GPT-5.x Codex 模型)
- **GitHub Copilot** (Copilot 订阅)
- **OpenRouter** (OAuth PKCE 生成用户控制的 API 密钥)

这些提供商中的每一个在 `provider.auth.oauth` 上都带有 `OAuthAuth`，包含三个操作：`login(interaction)` 使用提供商中立的 `AuthInteraction.prompt()`/`notify()` 协议并返回凭据、`refresh(credential, signal)` 刷新过期凭据（如适用）、和 `toAuth(credential)` 派生请求认证（GitHub Copilot 的每账号基础 URL 来自此处）。提供商登录交互和刷新调用始终携带具体的中止信号。刷新是自动的：`models.getAuth(providerId)` 和请求路径在凭据存储锁下刷新过期令牌，因此并发请求和进程无法重复刷新。OpenRouter 的 OAuth 流程改为返回永久 API 密钥，因此其刷新操作是无操作。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 持久化 CredentialStore
models.setProvider(anthropicProvider());

// 登录：Models 驱动流程并持久化凭据
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示本地回调服务器竞赛；当服务器赢时 p.signal 中止它们
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? '更多信息'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`打开：${event.url}`);
    if (event.type === 'device_code') console.log(`代码：${event.userCode} 在 ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// 从这里开始，请求自动解析和刷新令牌
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 登出
await models.logout('anthropic');
```

### Vertex AI

Vertex AI 模型支持 Google Cloud API 密钥或应用默认凭据 (ADC)。其提供商拥有的 API 密钥登录流程可以配置任一方法：

- **API 密钥**：设置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传递 `apiKey`。
- **本地开发 (ADC)**：运行 `gcloud auth application-default login`
- **CI/生产 (ADC)**：设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON 密钥文件

使用 ADC 时，还设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传递 `project`/`location`。使用 `GOOGLE_CLOUD_API_KEY` 时不需要 `project` 和 `location`。

```bash
# 本地（使用你的用户凭据）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/生产（服务账号密钥文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[应用默认凭据](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的认证方式：

```bash
npx @earendil-works/pi-ai login              # 交互式提供商选择
npx @earendil-works/pi-ai login anthropic    # 登录到特定提供商
npx @earendil-works/pi-ai list               # 列出可用提供商
```

凭据保存在当前目录的 `auth.json` 中。

### 编程式 OAuth

内置登录和刷新流程是私有提供商实现。使用提供商拥有的 `OAuthAuth`，它与 `CredentialStore` 组合并通过 `Models` 锁定自动刷新。`@earendil-works/pi-ai/oauth` 入口点仅保留编码代理扩展认证所需的类型声明。

提供商注意事项：

**OpenAI Codex**：需要 ChatGPT Plus 或 Pro 订阅。提供对 GPT-5.x Codex 模型的访问，具有扩展上下文窗口和推理能力。该库自动处理基于会话的提示缓存，当流选项中提供 `sessionId` 且 `cacheRetention` 不为 `"none"` 时。你可以在流选项中设置 `transport` 为 `"sse"`、`websocket` 或 `"auto"` 来选择 Codex Responses 传输。使用 WebSocket 和 `sessionId` 以及缓存启用时，连接按会话复用并在 5 分钟不活动后过期。

**Azure OpenAI (Responses)**：仅使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 和 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`。`AZURE_OPENAI_BASE_URL` 支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点自动规范化为 `.../openai/v1`。使用 `AZURE_OPENAI_API_VERSION`（默认为 `v1`）覆盖 API 版本如果需要。部署名称默认视为模型 ID，使用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 覆盖，使用逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）。有意不支持基于部署的传统 URL。

**GitHub Copilot**：如果你得到"请求的模型不可用"错误，请在 VS Code 中手动启用模型：打开 Copilot Chat，点击模型选择器，选择模型（警告图标），然后点击"Enable"。

## 从旧的全局 API 迁移

旧版本通过全局registry暴露全局 API：`stream()`/`complete()` 根据 `model.api` 分发，同步的 `getModel()`/`getModels()`/`getProviders()` 目录读取、`registerApiProvider()`、`getEnvApiKey()` 和每 API 懒加载流函数。那个表面在[兼容入口](#从旧的全局-api-迁移)保持不变：

```typescript
// 以前
import { getModel, complete } from '@earendil-works/pi-ai';

// 以后（逐字行为，只需改变导入路径）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

兼容是根入口点的超集，因此文件可以整体切换其导入路径。它将在未来版本中移除；迁移到 `createModels()` + 提供商工厂：

| 旧 | 新 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或 `providers/all` 中的 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或 `getBuiltin*` |
| `stream(model, ctx, opts)` (env-key 注入) | `models.stream(model, ctx, opts)` (提供商认证解析) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | `@earendil-works/pi-ai/api/anthropic-messages` 中的 `stream`，或集合中的提供商 |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## 开发

### 添加新提供商

添加新的 LLM 提供商需要对多个文件进行更改。分层布局：API 实现存储在 `src/api/` 中，提供商工厂在 `src/providers/` 中，稳定的生成目录包装器在 `src/providers/<id>.models.ts` 中，`src/models.generated.ts` 注册它们。此清单涵盖所有必要步骤：

#### 1. 核心类型 (`src/types.ts`)

- 将 API 标识符添加到 `KnownApi`（例如 `"bedrock-converse-stream"`），如果是新 API
- 将提供商名称添加到 `KnownProvider`（例如 `"amazon-bedrock"`）
- 将选项类型添加到 `ApiOptionsMap`

#### 2. API 实现 (`src/api/<api-id>.ts`，仅对新 API)

创建新的 API 实现文件（例如 `bedrock-converse-stream.ts`），导出恰好的 `stream` 和 `streamSimple`，外加：

- 扩展 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 将 `Context` 转换到提供商格式的 Message 转换函数
- 如果提供商支持工具则转换工具
- 解析响应以发射标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

添加懒加载包装器 `src/api/<api-id>.lazy.ts`（`<name>Api()` 通过 `lazyApi()`），以便提供商在不导入其 SDK 的情况下引用实现。在 `src/index.ts` 中添加任何应该从 `@earendil-works/pi-ai` 可用的根级别 `export type` 重新导出。

#### 3. 模型生成 (`scripts/generate-models.ts`、`scripts/generate-image-models.ts`)

- 添加逻辑来从提供商源获取和解析模型（例如 models.dev API）
- 通过 `scripts/generate-models.ts` 将聊天/工具可用提供商模型数据映射到标准化的 `Model` 接口；忽略的 `src/providers/data/<id>.json` 值按 API 水合分组，而稳定的 `src/providers/<id>.models.ts` 包装器直接从那些 JSON 键派生精确模型/API 类型
- 通过 `scripts/generate-image-models.ts` 将图像生成提供商模型数据映射到标准化的 `ImagesModel` 接口
- 处理提供商特定的怪异之处（定价格式、能力标志、模型 ID 转换）

#### 4. 提供商工厂 (`src/providers/<id>.ts`)

- 目录 + 认证 + 懒加载 API 包装器的 `createProvider()` 接线
- 认证：标准密钥提供商的 `envApiKeyAuth`、环境认证的自定义 `ApiKeyAuth`、存在 OAuth 流程的 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册工厂
- 如果是新 API：在 `src/compat.ts` 的内置列表中注册它，在 `package.json` 中添加包子路径出口

#### 5. 测试 (`test/`)

创建或更新测试文件以覆盖新提供商：

- `stream.test.ts` - 基础流式和工具使用
- `tokens.test.ts` - 令牌用量报告
- `abort.test.ts` - 请求取消
- `empty.test.ts` - 空消息处理
- `context-overflow.test.ts` - 上下文边界错误
- `image-limits.test.ts` - 图像支持（如适用）
- `unicode-surrogate.test.ts` - Unicode 处理
- `tool-call-without-result.test.ts` - 孤立工具调用
- `image-tool-result.test.ts` - 工具结果中的图像
- `total-tokens.test.ts` - 令牌计数准确性
- `cross-provider-handoff.test.ts` - 跨提供商上下文回放
- `providers.test.ts` - 提供商列出和认证解析

对于 `cross-provider-handoff.test.ts`，至少添加一个提供商/模型对。如果提供商暴露多个模型系列（例如 GPT 和 Claude），每系列至少添加一对。

对于具有非标认证的提供商（AWS、Google Vertex），创建像 `bedrock-utils.ts` 这样的实用程序，带有凭据检测帮助器。

#### 6. 编码代理集成 (`../coding-agent/`)

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中添加提供商的默认模型 ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量文档

更新 `README.md`：

- 在提供商部分添加提供商及其设置指令

#### 7. 文档

更新 `packages/ai/README.md`：

- 添加到支持的提供商表
- 记录任何提供商特定选项或认证要求
- 在环境变量部分添加到环境变量

#### 8. 更新日志

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加条目：

```markdown
### Added
- 添加了 [Provider Name] 提供商支持 ([#PR](链接) by [@作者](链接))
```

## 许可证

MIT
