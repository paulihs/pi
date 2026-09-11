/**
 * 代理流式函数（streamFn）：为需要把 LLM 调用经由自有服务器转发的应用提供。
 * 由服务器统一管理鉴权，并将请求代理转发给各 LLM 提供商。
 */

// 内部导入：parseStreamingJson 用于在客户端增量解析工具调用的 JSON 参数
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";

/**
 * 代理模式下的消息事件流。
 * - 事件类型为 AssistantMessageEvent，与直连提供商时完全一致，
 *   调用方无需感知请求经过了代理。
 * - 最终结果为 AssistantMessage，从 done / error 终止事件中提取。
 */
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			// 终止事件判定：done 表示正常结束，error 表示失败，二者都会结束流
			(event) => event.type === "done" || event.type === "error",
			// 从终止事件中提取最终消息；error 事件携带的同样是已填充
			// stopReason / errorMessage 的 AssistantMessage
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * 代理协议事件类型 —— 服务器发送这些事件时已剥离 partial 字段，以减少带宽开销。
 * 客户端收到后据此在本地重建 partial 消息（见 processProxyEvent）。
 *
 * 与 AssistantMessageEvent 一一对应，区别在于：
 * - 去掉了 partial 字段；
 * - done / error 不携带完整消息对象（避免重复传输已流出的全部内容），
 *   只携带 usage、providerThinkingLevel 等元数据，客户端把它们合入
 *   本地累积的 partial 后即可拼出最终消息。
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| {
			type: "toolcall_start";
			contentIndex: number;
			id: string;
			toolName: string;
	  }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	// 正常结束：reason 只能是三种正常终止原因，并携带最终用量统计
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  }
	// 出错结束：reason 为 aborted（用户中止）或 error（失败），errorMessage 可选
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  };

/**
 * 可 JSON 序列化、可安全发送给代理服务器的流式选项子集。
 * 只从 SimpleStreamOptions 中挑选这些字段；signal / authToken / proxyUrl
 * 属于客户端本地细节，不在此列。
 */
type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "samplingParams"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** 用于中止本次代理请求的本地 AbortSignal */
	signal?: AbortSignal;
	/** 访问代理服务器的鉴权令牌 */
	authToken: string;
	/** 代理服务器地址（例如 "https://genai.example.com"） */
	proxyUrl: string;
}

/**
 * 经由服务器代理转发请求的流式函数，而不是直接调用 LLM 提供商。
 * 服务器在转发增量事件时会剥离 partial 字段以减少带宽，
 * 客户端在此处重建 partial 消息。
 *
 * 创建需要走代理的 Agent 时，把它作为 `streamFn` 选项传入。
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		samplingParams: options.samplingParams,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

/** 发起代理流式请求并返回事件流。网络与解析逻辑在后台异步执行。 */
export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// 初始化将在收到事件后逐步累积的 partial 消息
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "pending",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		// 用户中止时的处理：取消底层读取器以尽快释放连接
		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			// 向代理服务器发起请求，请求体包含模型、上下文与可序列化选项
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				// 非 2xx：尽量从响应体中解析出服务器返回的错误信息，
				// 解析失败时回退为状态码 + 状态文本
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// 响应体不是 JSON，忽略解析失败，保留默认错误信息
				}
				throw new Error(errorMessage);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			// SSE 缓冲区：一次 read 可能收到跨行的半条数据，未凑整行的部分留到下次拼接
			let buffer = "";
			// 是否已收到 done / error 终止事件，用于检测服务器中途断流
			let sawTerminalEvent = false;

			// 解析单行 SSE 数据："data: {...}" -> ProxyAssistantMessageEvent -> 本地事件
			const processLine = (line: string): void => {
				if (!line.startsWith("data: ")) return;
				const data = line.slice(6).trim();
				if (!data) return;
				const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
				// 把精简代理事件转换为标准 AssistantMessageEvent 并推给消费者
				const event = processProxyEvent(proxyEvent, partial);
				if (event) {
					if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
					stream.push(event);
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 每轮读取后检查中止状态，保证 abort 能及时生效
				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				// 以流式模式解码字节数据，并按行切分；最后一段可能不完整，留在 buffer
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					processLine(line);
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			// 最后一条事件可能不带换行符；冲刷解码器并处理缓冲区中的残留内容
			buffer += decoder.decode();
			if (buffer) {
				processLine(buffer);
			}

			if (!sawTerminalEvent) {
				// 收到干净的 EOF 却没有任何 done/error 事件，说明服务器中途断开了
				// 响应。这里主动报错，避免消费者永远等不到最终结果。
				partial.stopReason = "error";
				partial.errorMessage = "Connection closed by proxy server before the response completed";
				stream.push({
					type: "error",
					reason: "error",
					error: partial,
				});
			}

			stream.end();
		} catch (error) {
			// 网络错误、解析错误或用户中止统一走到这里：
			// 依据 abort 状态决定终止原因，并把错误信息写入 partial 后作为 error 事件发出
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			// 无论成败都要移除 abort 监听，避免泄漏
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * 处理一条代理事件：据此更新本地累积的 partial 消息，并生成对应的
 * 标准 AssistantMessageEvent 返回（由调用方推入事件流）。
 *
 * 返回 undefined 表示该事件无需向下游广播（例如 toolcall_end 且内容
 * 类型不匹配时的静默丢弃）；内容类型不匹配等协议错误则直接抛异常。
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		// 流开始：partial 已在 streamProxy 中初始化完毕，直接广播
		case "start":
			return { type: "start", partial };

		// 文本块开始：在 contentIndex 位置创建空的文本内容项
		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return {
				type: "text_start",
				contentIndex: proxyEvent.contentIndex,
				partial,
			};

		// 文本增量：把 delta 追加到对应文本项
		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		// 文本块结束：记录可选的内容签名（用于服务商侧的缓存/校验）
		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		// 思考块开始：在 contentIndex 位置创建空的思考内容项
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "thinking",
				thinking: "",
			};
			return {
				type: "thinking_start",
				contentIndex: proxyEvent.contentIndex,
				partial,
			};

		// 思考增量：把 delta 追加到对应思考项
		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		// 思考块结束：记录可选的思考签名
		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		// 工具调用开始：创建带空参数的工具调用内容项
		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return {
				type: "toolcall_start",
				contentIndex: proxyEvent.contentIndex,
				partial,
			};

		// 工具调用增量：服务器流式发送的是 JSON 参数原文（partialJson），
		// 客户端用容错的增量 JSON 解析器把它解析成 arguments 对象。
		// 整项浅拷贝一次以触发依赖引用相等性的响应式更新。
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // 触发响应式更新
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		// 工具调用结束：用服务器发来的完整 toolCall 覆盖本地累积值，
		// 并清理临时的 partialJson 字段。类型不匹配时静默忽略（返回 undefined）。
		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				Object.assign(content, proxyEvent.toolCall);
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		// 正常结束：把服务器给出的终止原因与用量统计合入本地 partial，
		// 构造出最终消息后广播 done 事件
		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "done", reason: proxyEvent.reason, message: partial };

		// 出错结束：与 done 类似，但终止原因为 aborted / error，
		// 并附带可选的错误信息
		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "error", reason: proxyEvent.reason, error: partial };

		// 兜底分支：穷尽性检查，未知事件类型只告警不抛错，保证前向兼容
		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
