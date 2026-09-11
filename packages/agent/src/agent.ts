/**
 * Agent：低层 agent loop 的状态化封装。
 *
 * 本模块实现 {@link Agent} 类，它负责：
 * - 持有当前会话记录（messages）、工具列表（tools）和模型等配置；
 * - 跟踪运行时状态（流式输出中的消息、待完成的工具调用、错误信息）；
 * - 维护 steering / follow-up 两条待处理消息队列，并在合适的时机注入；
 * - 提供单次运行的活性管理：中止（abort）、等待空闲（waitForIdle）。
 *
 * 事件流向：低层 `runAgentLoop` / `runAgentLoopContinue` 产出
 * {@link AgentEvent}；`processEvents` 先根据事件更新内部状态，
 * 再按订阅顺序 await 所有监听器。
 */
import type {
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

/**
 * 默认的记录转 LLM 过滤器：只保留 provider 能理解的角色
 * （user、assistant、toolResult），其余全部丢弃。
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

/** 全零的用量/费用统计，用于合成的错误或中止消息。 */
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 占位模型，在分配真实模型前使用。 */
const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

/**
 * {@link AgentState} 的内部可写视图。
 *
 * 放宽了运行时持有的字段（`isStreaming`、`streamingMessage`、
 * `pendingToolCalls`、`errorMessage`），以便 Agent 在运行过程中更新它们。
 */
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/**
 * 构建初始可变状态。
 *
 * 对 `tools` 和 `messages` 做防御性拷贝，避免调用方随后修改自己的数组时
 * 影响运行中的 agent 状态。
 */
function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** 构造 {@link Agent} 的选项。 */
export interface AgentOptions {
	/**
	 * 初始状态：systemPrompt、model、tools、messages、thinkingLevel 等。
	 * 每个字段都可以省略，缺省值见 {@link createMutableAgentState}。
	 */
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	/**
	 * 把 AgentMessage 记录转换为发给 LLM 的 Message 数组。
	 * 默认实现 {@link defaultConvertToLlm} 只保留 provider 能理解的角色。
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/**
	 * 在把上下文发给模型前对消息列表做最后处理（如压缩、裁剪历史）。
	 * 返回的新数组只影响本次请求，不会替换内部记录；但消息对象与记录共享，
	 * 不要原地修改消息对象本身。
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 实际执行流式请求的函数；不传则用 {@link getDefaultStreamFn} 的默认实现。 */
	streamFn: StreamFn;
	/** 按 provider 名称返回 API key；供 streamFn 取凭据用。 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 每次发往 provider 的请求载荷回调（调试/日志用）。 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** 每次收到 provider 响应（含 SSE 事件）的回调（调试/日志用）。 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/**
	 * 工具调用执行前的拦截钩子：可放行、拒绝或修改输入。
	 * 返回 undefined 表示放行。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/**
	 * 工具调用执行后的钩子：可检查/修改工具结果。
	 * 返回 undefined 表示不修改。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** 每个 turn 结束后询问是否提前终止整个循环（返回 true 则不再继续）。 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	/**
	 * 在每个后续 turn 开始前调用。
	 * 设置了 {@link AgentOptions.prepareNextTurnWithContext} 时会被忽略。
	 */
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/**
	 * 在每个后续 turn 开始前调用，返回对本轮生效的状态更新
	 * （替换 messages / tools / systemPrompt / model / reasoning）。
	 * 优先级高于 {@link AgentOptions.prepareNextTurn}。
	 */
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** steering 消息的 drain 策略；默认 "one-at-a-time"。 */
	steeringMode?: QueueMode;
	/** follow-up 消息的 drain 策略；默认 "one-at-a-time"。 */
	followUpMode?: QueueMode;
	/** 会话标识，转发给支持缓存感知后端的 provider。 */
	sessionId?: string;
	/** 按思考级别分配 token 预算，转发给 streamFn。 */
	thinkingBudgets?: ThinkingBudgets;
	/** 首选传输方式（如 HTTP / WebSocket）；默认 "auto"。 */
	transport?: Transport;
	/** 对 provider 建议的重试等待时间设置上限（毫秒）。 */
	maxRetryDelayMs?: number;
	/** 同一 assistant 消息中多个工具调用的执行策略；默认 "parallel"。 */
	toolExecution?: ToolExecutionMode;
}

/**
 * agent 循环消费的待处理消息 FIFO 队列。
 *
 * `mode` 控制每次 drain 释放多少消息："all" 清空整个队列；"one-at-a-time"
 * 只返回最旧的一条，其余留在队列里等下一次 drain。
 */
class PendingMessageQueue {
	/** 内部存储，按入队顺序排列；drain 时整体替换为新数组。 */
	private messages: AgentMessage[] = [];
	/** drain 策略，运行中可通过 Agent 的 setter 切换。 */
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	/** 把一条消息追加到队尾。 */
	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	/** 队列是否非空。 */
	hasItems(): boolean {
		return this.messages.length > 0;
	}

	/**
	 * 按 `mode` 取走消息："all" 一次性取走并清空；"one-at-a-time"
	 * 只取走最旧的一条。空队列返回 `[]`。
	 */
	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

/**
 * 单次进行中 prompt/continuation 的簿记信息。
 *
 * `promise` 在本次运行及其被 await 的监听器全部结束后 resolve
 * （是 {@link Agent.waitForIdle} 的底层实现）；`abortController` 提供本次
 * 运行的中止信号。
 */
type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * 低层 agent loop 的状态化封装。
 *
 * `Agent` 持有当前会话记录、发出生命周期事件、执行工具，
 * 并提供 steering / follow-up 消息的排队 API。
 */
export class Agent {
	/** 内部可变状态；通过 `state` getter 以只读视图对外暴露。 */
	private _state: MutableAgentState;
	/**
	 * 生命周期事件监听器集合（保持订阅顺序）。
	 * subscribe() 返回的取消函数就是从这个 Set 里删除。
	 */
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	/** steering 队列：当前 turn 结束后注入的用户插话。 */
	private readonly steeringQueue: PendingMessageQueue;
	/** follow-up 队列：仅当 agent 本来就要停止时才消费的消息。 */
	private readonly followUpQueue: PendingMessageQueue;

	/**
	 * 记录 -> LLM 消息的转换函数。
	 * 公开可变，允许使用方在构造后替换。
	 */
	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 发送前对上下文做最后处理的钩子；见 {@link AgentOptions.transformContext}。 */
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 实际执行流式请求的函数。 */
	public streamFunction: StreamFn;
	/** 按 provider 取 API key 的回调。 */
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 请求载荷回调。 */
	public onPayload?: SimpleStreamOptions["onPayload"];
	/** 响应回调。 */
	public onResponse?: SimpleStreamOptions["onResponse"];
	/** 工具调用前拦截钩子。 */
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	/** 工具调用后钩子。 */
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	/** 每个 turn 后询问是否停止循环的钩子。 */
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	/** 每个 turn 前的更新钩子（无上下文版本）。 */
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** 每个 turn 前的更新钩子（带上下文版本，优先于 prepareNextTurn）。 */
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/**
	 * 当前进行中的运行簿记；空闲时为 undefined。
	 * 单次运行约束（prompt/continue/reset 互斥）就靠它判断。
	 */
	private activeRun?: ActiveRun;
	/** 会话标识，转发给支持缓存感知后端的 provider。 */
	public sessionId?: string;
	/** 按思考级别分配的 token 预算，转发给 streamFn。 */
	public thinkingBudgets?: ThinkingBudgets;
	/** 首选传输方式，转发给 streamFn。 */
	public transport: Transport;
	/** 对 provider 建议的重试等待时间设置上限（毫秒）。 */
	public maxRetryDelayMs?: number;
	/** 同一 assistant 消息中多个工具调用的执行策略。 */
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions) {
		// 兼容旧的编译产物使用方：可能省略 options 或 streamFn，
		// 尽管当前 API 要求必传。
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		// 状态：initialState 里的 tools/messages 会被防御性拷贝。
		this._state = createMutableAgentState(runtimeOptions.initialState);
		// 钩子与回调：未提供的保持 undefined，由循环侧自行判空。
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.shouldStopAfterTurn = runtimeOptions.shouldStopAfterTurn;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
	}

	/**
	 * 订阅 agent 生命周期事件。
	 *
	 * 监听器的 promise 会按订阅顺序被 await，并计入当前运行的结果集；
	 * 监听器同时会收到当前运行的中止信号。
	 *
	 * `agent_end` 是一次运行的最后一个事件，但 agent 要等该事件的全部
	 * 监听器执行完毕后才算真正空闲。
	 *
	 * @returns 取消订阅函数；调用后该监听器不再收到后续事件。
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 当前 agent 状态。
	 *
	 * 给 `state.tools` / `state.messages` 赋值时会拷贝传入数组的顶层。
	 */
	get state(): AgentState {
		return this._state;
	}

	/** 控制 steering 队列消息的 drain 方式。 */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** 控制 follow-up 队列消息的 drain 方式。 */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/**
	 * Queue a message to be injected after the current assistant turn finishes.
	 *
	 * steering 消息会在当前 turn 的工具调用结束后、下一次模型请求前被注入，
	 * 实现"边跑边插话"。若在空闲时入队，则由下一次运行开始时的首次轮询
	 * 消费；队列在 drain 时按 {@link Agent.steeringMode} 释放。
	 */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/**
	 * Queue a message to run only after the agent would otherwise stop.
	 *
	 * follow-up 消息不会打断当前循环：只有当循环准备收尾时才取出，
	 * 作为新一轮用户输入继续运行。适合"等这轮结束后再做某事"的场景。
	 */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** 清空 steering 队列。 */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** 清空 follow-up 队列。 */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** 清空 steering 和 follow-up 两个队列。 */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** 任一队列仍有待处理消息时返回 true。 */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** 当前运行的中止信号；空闲时为 undefined。 */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** 中止当前运行（如有）。 */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * 等待当前运行及其全部被 await 的监听器结束。
	 *
	 * 在 `agent_end` 的监听器执行完毕后 resolve。
	 *
	 * 空闲时立即 resolve（返回已完成的 promise），可安全 await。
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/**
	 * 清空会话记录、运行时状态和排队消息。
	 *
	 * 注意：不清除 tools / systemPrompt / model 等配置，只清记录与运行时状态。
	 * 运行中调用会抛错（先 abort 并 waitForIdle）。
	 */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/**
	 * 从文本、单条消息或一批消息启动新的 prompt。
	 *
	 * 同一时刻只允许一次运行；若 agent 正忙则抛错，调用方应改用
	 * {@link Agent.steer} / {@link Agent.followUp} 排队或等待空闲。
	 * 文本输入会被包装成一条 user 消息（可附带图片）。
	 * 返回的 promise 在本次运行及其监听器全部结束后才 resolve。
	 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		// 文本/消息/消息数组统一转成消息数组，再启动一次完整运行。
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/**
	 * 从当前会话记录继续运行。最后一条消息必须是 user 或工具结果。
	 *
	 * 两种分支：
	 * - 记录以 user/toolResult 结尾：直接从记录恢复循环（例如上次被中止
	 *   在工具调用中途，补上工具结果后继续）。
	 * - 记录以 assistant 结尾：循环无法自然推进，此时退而求其次——
	 *   先尝试取 steering 队列、再取 follow-up 队列作为新输入；
	 *   两者都为空则抛错。
	 */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			// 记录以 assistant 消息结尾，唯一的推进方式是把队列中的消息
			// 作为新的用户输入注入。优先 steering，其次 follow-up；都为空则抛错。
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, {
					skipInitialSteeringPoll: true,
				});
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		// 最后一条是 user/toolResult：循环可以从这里自然续跑。
		await this.runContinuation();
	}

	/**
	 * 把 prompt() 的入参归一化为用于启动循环的消息列表。
	 *
	 * - 消息数组：原样返回；
	 * - 单条消息：包成长度为 1 的数组；
	 * - 字符串：包装成一条 user 消息（可附加图片内容块）。
	 */
	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		// 可选图片追加到文本之后，组成同一 user 消息的多模态内容。
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	/** 以 `messages` 作为新的用户输入运行 agent 循环。 */
	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/** 不注入新用户输入，直接从现有记录恢复运行循环。 */
	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/** 对当前记录与配置做快照；循环在副本上工作。 */
	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	/**
	 * 用当前 agent 配置组装本次运行的循环配置。
	 *
	 * `skipInitialSteeringPoll` 让 continue() 跳过第一次 steering 拉取
	 * （它已经自己从队列里取走了 steering 消息）。
	 * 生命周期钩子通过 `signal` getter 拿到实时的中止信号。
	 */
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		const shouldStopAfterTurn = this.shouldStopAfterTurn;
		return {
			model: this._state.model,
			// "off" 不下发 reasoning 参数；其余级别原样传给模型。
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			// 钩子包装：循环只接受不带 signal 的签名，这里统一补上
			// 当前运行的 abort signal。
			shouldStopAfterTurn: shouldStopAfterTurn
				? async (context) => await shouldStopAfterTurn(context, this.signal)
				: undefined,
			// prepareNextTurnWithContext 优先；否则退回无上下文版本，
			// 丢弃循环传入的 context 参数。
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			// 循环在合适时机轮询 steering 队列。continue() 场景下首次轮询
			// 跳过（消息已被 continue() 自己取走），用完即恢复默认行为。
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			// 循环收尾时轮询 follow-up 队列，取到消息就继续下一轮。
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	/**
	 * 在单次运行约束和生命周期簿记下执行 `executor`。
	 *
	 * 标记 agent 为 streaming；executor 抛出的错误会被转换成合成的
	 * assistant 失败消息（见 {@link handleRunFailure}）；最后总会清理
	 * 运行时状态（见 {@link finishRun}）。
	 */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		// 在 finishRun() 中 resolve；waitForIdle() 等待的就是这个 promise。
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		// 先注册 activeRun，再开始执行：注册后其他入口（prompt/continue/reset）
		// 会因单次运行约束而抛错。
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		// 每次运行开始时清掉上一次运行遗留的错误信息。
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			// 循环抛错时主动收尾：合成失败消息并广播给监听器，
			// 保证监听器总能看到完整的 agent_end。
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	/**
	 * 发出一条携带运行错误的合成 assistant 消息，让监听器观察到与正常运行
	 * 相同的 message_start/turn_end/agent_end 事件序列。`aborted` 用于区分
	 * 用户主动中止和意外失败。
	 */
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			// 空文本内容：错误信息放在 errorMessage 字段而非正文里。
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			// aborted=true 表示是 abort() 触发的正常中止，而非意外失败。
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		// 手工按正常顺序补发四个事件，保证监听器（如 UI 渲染）
		// 不需要为失败路径写特殊的状态机。
		await this.processEvents({
			type: "message_start",
			message: failureMessage,
		});
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({
			type: "turn_end",
			message: failureMessage,
			toolResults: [],
		});
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	/**
	 * 清理运行时持有的状态并释放 idle promise。
	 *
	 * 在 finally 中调用，无论成功、失败还是中止都会执行；
	 * resolve 之后 `waitForIdle()` 的等待者才被唤醒。
	 */
	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * 先根据循环事件更新内部状态，再依次 await 监听器。
	 *
	 * `agent_end` 只表示不会再有循环事件发出。真正空闲要等到该事件的全部
	 * 监听器执行完毕，且 `finishRun()` 清理完运行时状态之后。
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				// 消息已定稿：丢弃流式视图，追加进记录。
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				// 写时拷贝，让持有旧引用的消费方看到一致的快照。
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				// 同 tool_execution_start 的写时拷贝。
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				// 记录本 turn 的错误（如有），供消费方在运行结束后检查。
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				// 运行结束，丢弃残留的流式视图（正常路径下 message_end 已清）。
				this._state.streamingMessage = undefined;
				break;
		}

		// 监听器按订阅顺序串行 await。某个监听器抛异常会中断后续监听器
		// 并向上传播（由 runWithLifecycle 捕获后走失败收尾路径）。
		// 这里依赖 activeRun 仍然存在——runWithLifecycle 只在循环完全
		// 退出（含监听器执行完）后才调用 finishRun()。
		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
