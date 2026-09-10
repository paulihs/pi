# AgentHarness — 实现规范

章节使用 §N.M 作为交叉引用。本文件是规范文档；§0.9 标出已规定但尚未实现的部分。公开类型声明位于 §0.7 指定的源码中，本文只在类型形状本身构成规则时重复声明。

# Part 0 — 总览

## 0.1 这是什么

这是一个用于 agent conversation 的持久化 runtime。它保存 conversation 和 operation state，使被中断的工作可以继续，而不会重复已经结算的 effect。本文件是规范依据；未实现内容以 §0.9 为准。

## 0.2 系统模型

一个 Session 由四部分组成：

- immutable entry tree：包含 message、compaction、branch summary 和应用 custom entry；Branch 共享同一棵树，因此可以 branching、compaction、fork 和并行工作，同时保留历史；
- 绑定到类型化地址的 mutable values/lists：内置地址包括 session name、entry label，应用直接定义不易冲突的地址；
- Branch 与 AgentLane：Branch 是一条命名数据路径并拥有可移动 tip；AgentLane 叠加完整 model config、queue 和至多一个 operation；Session 可以从零个 Branch/lane 开始，main 只是普通显式名称；
- append-only usage ledger。

Session 层拥有全局持久化数据和 Branch capability。Harness 通过四个 primitive 驱动 lane：

- accept：持久化创建 operation；
- drive：推进指定 operation；
- requestAbort：持久化请求取消；
- inspectExecution：原子报告当前和最近终止的 execution。

prompt、resume、abort 等 convenience 只在进程内组合这些 primitive 和等待策略。serving layer 可以通过 alarm、job 或其他 host runtime 调用 drive。Harness 还拥有全局 tool/prompt-resource registry、hooks、被动 events 和 runtime configuration。

Operation 是一次被接受的 lane 工作单元：run、compaction 或 navigation。immutable metadata 记录 identity、intent 和起点；total current state 记录 phase、control 和 recovery data；queued input 属于 lane。acceptance 与 execution ownership 分离，接受后的 operation 可以暂时没有进程内 driver。完成时删除 operation-owned state 并写入一个 immutable result record。

每个异步公开的 harness/lane/Session/Branch/repository/storage 方法都接收末尾 Context；events.on()、hooks.on() 等同步注册不接收 Context，但 handler 执行时会收到。Context 用于独立的 telemetry parentage 和 RPC cancellation。共享 receiver 不保存 caller Context，也不通过 AsyncLocalStorage 查找 Context。RPC cancel/disconnect 只中断对应 invocation；Context abort 不会调用 requestAbort，也不会写 cancel_requested。trace 注入/提取和远程 telemetry parent 重建属于未来 T1。

Storage 提供三种 durable 形式上的原子事务和查询：pi.op.meta 每个 operation 写一次，pi.op.state 每次 transition 用完整当前 state 替换，tool checkpoint 只是有界辅助进度，不能证明 effect 完成。terminal transaction 删除 operation-owned value/list 并写 pi.result/{operationId}。事务永远不可部分可见。

## 0.3 三种存储

所有实现遵守四条规则：

~~~text
entries        conversation tree：只写一次、追加式
values/lists   当前可变状态：value 可替换，list 可追加或整表删除
usage ledger   成本历史：追加式 rows
~~~

每个 payload 必须位于 entry、绑定 value/list 或 ledger 中，不存在第四个位置。Entry 同时包含 placement 和 payload；Value 只保留当前值；ValueList 的元素按写入 seq 排列，只能整表删除。Branch index、search、stats 等后端 projection 可重建，没有 authority。

事务把 entry/usage insert 和 value/list write 全部原子提交，并使用严格递增的 sequence。每次 durable transition 都用完整 total state 替换 operationState；恢复读取它并从负责的 procedure 开始，不重放 journal，也不从缺失数据猜位置。大 payload 放在 sibling operation-owned address 或通过 ID 引用，terminal transaction 删除它们。

Provider request 和真实 tool call 通常采用 intent → uncertain effect → settlement 两次提交；intent 记录“即将执行什么以及将使用哪些 response/usage ID”。Hook 使用 replay contract，结果在消费它的事务中持久化，崩溃可能重新执行 hook；有副作用的 hook 必须幂等。

## 0.4 示例：Slack thread

用户在有 400 条历史的 channel 发消息，应用将 lane 锚定到 channel tip 后调用 lane.prompt。规范写入顺序如下：

~~~text
TX[写入 user entry、更新 branch tip、写 operation meta/state=starting、更新 lane state]
… 第一次 drive 获得工作；before_drive 后 before_run …
TX[写入注入消息、必要时更新 tip、state=checkpoint]
TX[state=assistant.ready]
TX[state=effect_pending，预留 response/usage ID]
… provider stream，期间是 uncertain window …
TX[向 pending assistant frame list 追加一帧]
TX[写 assistant entry、usage、tip，删除 frame list，state=tools]
TX[写 tool args、state=tool effect_pending]
… tool 运行，bounded checkpoint 可替换 pending tool output …
TX[写 pending tool result，state=outcome_ready]
TX[放置 tool result entry、tip，state=checkpoint]
… 后续 turn …
TX[删除 operation values/lists，写 pi.result/O，lane 回到 idle]
~~~

任意两个事务之间进程死亡，重启都从 lane 所需的 durable values 判断最后完成的边界。provider stream 中死亡是唯一真正不确定的窗口；已经提交的 frame prefix 可用于合成 settlement 和 reconnect 展示，但不能证明 provider 最终结果。另一个 lane 可以在同一共享历史上独立运行。

## 0.5 示例：tool 中途崩溃

模型返回两个 tool call。harness 先提交 batch plan，再为 call 0 持久化 exact args 和 replay: "never" 的 intent。tool 删除文件、按有界频率报告进度，每两秒 checkpoint；一次 checkpoint 提交后进程崩溃：

~~~text
TX[assistant entry + 2 calls、tip、state=tools]
TX[tool args、state=effect_pending、replay=never]
TX[pending tool output = bounded checkpoint]
CRASH
~~~

重启读取 operation state，看到 replay=never，因此不重新执行删除。后续 drive 使用最新 checkpoint 和 interruption warning，在预留 result ID 下写 synthetic error，再按正常 source order placement。没有 checkpoint 时只包含 warning；如果 replay=safe，则使用持久化 args 重跑。

## 0.6 非目标

- 不保证外部 effect exactly once；有副作用的 hook 必须按 operation ID 幂等；
- 不恢复 provider stream；frame 只保存可重建的最新 partial；
- 不支持多个可写 owner；一个 host 同时只能持有一个 writable Session，read-only repository work 可以并行；
- 不负责 work scheduling、platform alarm、abandoned session 扫描、hosted lease 或 HTTP receipt；
- 不做 replication；
- 不提供 durable value write history；Value 只保存当前值，list 只保存未整表删除的元素；
- 不把 entry/usage 删除作为 runtime 功能；compaction 改变 provider context，不是擦除。合规级擦除只允许 administrative precise rewrite。

## 0.7 记法与 source type

TX[a,b,c] 表示一个按该顺序写入的 atomic commit。写入词汇是 insert entry、insert usage、setValue、deleteValue、appendList、deleteList。示例中的 namespace/key 是持久化地址展示，不是 API 的第二个 key 参数。

ID 使用 UUIDv7，示例可缩写为 e_*、u_*、op_*。S(next) 表示用 next 替换 operationState，L(next) 表示替换 laneState。明确标记为规范的规则、transition/race 表和 invariant 属于契约。

源码路径约定：src/... 相对于 packages/agent；session/types.ts 等相对于 packages/agent/src/harness；docs/... 相对于 packages/agent。AgentMessage、AgentTool、AgentToolResult、QueueMode、ThinkingLevel 来自 agent；Model、Models、Tool、Usage、RetryPolicy、StopReason、AssistantMessage 和 provider 类型来自 ai；AiContext 用于区分 provider request Context 与 harness invocation Context。AssistantMessageFrame、Encoder、reducer 来自 ai，harness 不定义第二套 codec/reducer。Context 和 ContextKey 来自 harness/context.ts。

QueueMode 为 all 或 one-at-a-time。RetryPolicy 的 maxRetries/baseDelayMs 必须为有限非负安全整数，disabled retry 归一化为一次 attempt，延迟运算饱和到 Number.MAX_SAFE_INTEGER。CompactionSettings 的 token 数同样必须合法。结构请求强制 deferred=false。SettledAssistantMessage 排除 pending stopReason。provider dispatch 在请求时通过 Models 解析 durable { provider, modelId }，缺失 registry entry 以内嵌错误返回。

## 0.8 校验边界

内部 pi object 是受信任的类型化值；Session、storage、procedure 和进程内 extension 不做 runtime shape validation 或 defensive clone。Storage 仍强制 atomicity、seq、unique ID 和 parent existence；后端按需序列化/解析。runtime schema validation 只放在不受信任的 wire boundary，未来 protocol slice 再定义 TypeBox schema。

Attachment 只校验发布最小 lane/operation projection 所需的关系。详细引用由消费方校验：watch 校验它需要的 pending/entry discriminant 和 message role，drive 校验 transition input；可选 assistant frame 和 tool checkpoint 可以缺失。

## 0.9 实现状态

WP00–WP07 已完成：operation graph、public lane runtime、SQLite host ownership alignment 已落地。Part 9 是 conformance 要求，不表示每一行都有独立测试。已知未完成项包括 JSONL snapshot compaction、远程 Session/C1、trace propagation/T1、后续 mobile assistant-output handoff 和其他文档明确标记的工作。具体状态以各节和 work package 为准。

# Part 1 — Storage

## 1.1 模型

Storage 是一个 Session 范围的原子提交器和查询器。地址由 kind、namespace、key 绑定；值和列表使用同一套类型化地址。单次 commit 的写入可混合 entry、usage、scalar value、list append/delete，全部成功或全部不可见。

## 1.2 Identity

ID 使用 UUIDv7，时间前缀用于排序和诊断。operation/response/usage/entry 的引用必须显式保存。Follower ID 可继承 leader 的 48-bit 时间前缀，但仍是独立 ID。对象 identity 不等于持久化 identity；地址的 namespace/key/kind 决定位置。

## 1.3 绑定 values 和 lists

value<T>(namespace,key?) 表示一个 replaceable durable value；list<T>(namespace,key?) 表示一个 append-only durable list。构造后调用方只传地址，不再传第二个 key。namespace 非空，pi 和 pi.* 保留给内置地址，组件不得含 U+0000；空 key 合法。标量和列表不能共享物理地址；变更 namespace、key、kind 或不兼容值形状需要 migration。

应用直接定义自己的地址，例如 value<MyState>("my-app.state") 和 list<MyEvent>("my-app.events")，不需要 declaration merging、global type map、registry 或 catalog。内置地址集中在 session/values.ts。

scanValues 只接受已绑定的 prefix address，扫描相同 namespace 且 key 以其 key 开头的 scalar；没有任意跨 namespace dump。普通 get/set/delete 使用 exact address。

## 1.4 Transactions

每个 write 获得全局递增 seq；同一事务中的写入按数组顺序分配。事务失败时 entry、usage、value、list 都不可见。Memory 在应用状态改变前完成验证和序列化，JSONL 保证一个事务一行，SQLite 使用既有 BEGIN IMMEDIATE。

Session 通过一个 mutation line 实现 read → decide → commit → process-local publication；Storage 自己仍负责 commit atomicity 和 seq，不与 mutation line 合并。

## 1.5 Queries

Entry query 支持 Branch、tip、parent、type、cursor、order、limit 和 compaction boundary；value read 返回最新值及 seq；list read 以 seq cursor 分页，默认 asc、有界 limit，不提供无界读全表 helper。Branch scan 的 stopAtType 在排序后生效，context read 通常 newestFirst 后反转为正序。

## 1.6 Usage ledger

Usage 是 append-only，不能被 terminal cleanup 或 fork 复制。每个结算 attempt 必须同时写 response 和 usage；getStats 从 ledger 计算，fork 的 usage 从零开始。v3 import 需要 aggregate adjustment row，以保持迁移前后的总量不变。

## 1.7 Backends

### Memory

Memory 用 map 保存当前 scalar 和 list elements，并保留全局 nextSeq。事务先 prepare，再原子应用 entries、values、lists、usage 和 stats。snapshot/fork 必须保留原 seq，不能让对象 identity 充当 durable identity。

### JSONL

JSONL 的一个物理行表示一个完整事务；replay 遇到不完整尾行时丢弃整行。主文件 header 保存 format/storage version 和必要 high-water 信息。snapshot rewrite 原子写临时文件再替换；不得把删除记录重新解释成 value history。sidecar 规则见 scopes handoff。

### SQLite

SQLite 使用 scalar current-value table、list element table、entry/branch index 和 usage ledger。写入事务以 BEGIN IMMEDIATE 开始；列表按复合主键分页，EXPLAIN QUERY PLAN 不应出现临时排序。Session identity 和 host ownership 属于 repository lifecycle，不由数据库自行推断。

## 1.8 为什么采用 write-once + values/lists

Entry 适合不可变 conversation history；Value 适合当前状态；List 适合不可变的有序增量。把所有内容都放入 event log 会让恢复依赖重放和压缩，把所有内容都放在 value 中又会重复写完整对象。三种存储各自表达一种生命周期，projection 可重建且不拥有 authority。

# Part 2 — Conversation tree

## 2.1 Entries

Entry 是 immutable、write-once、带 ID 和 parentId 的 conversation record。message、compaction、branch summary 和 custom entry 共用树。payload 与 placement 在同一 row 中，不允许悬挂 entry。

## 2.2 Placement

需要先持久化但尚未放入树的完整内容放在 pi.pending.entry/{entryId}。placement transaction 同时写正式 entry、移动 Branch tip、删除 pending value。取消/terminal cleanup 删除未放置 payload；未放置内容不能被当作 transcript 历史。

## 2.3 Branches 与 AgentLanes

Branch 是命名路径和当前 tip 的数据 capability，只提供 branch-relative read 和 append。AgentLane 叠加 model config、queues 和 operation。Session/Harness 可以没有 main；main 是显式创建的普通名称。AgentHarness 通过 composition 管理 lanes，不能继承 AgentLane。

## 2.4 Session metadata 与 application values

Session 拥有 metadata、name、entry labels、global values/lists、usage 和 Branch discovery。应用直接构造自己的地址；pi.* 是内置保留前缀。label 通过 target entry ID 绑定，precise rewrite/fork 必须明确 label policy。

## 2.5 Branch query 与 context

Branch query 默认相对于当前 tip，可按 type、parent、cursor、order、limit 读取。compaction boundary 将读取限制到最新 segment；reader 不把 Branch query 误当全树搜索。Context 是调用 authority，不进入 durable business data。

## 2.6 Branch index

Branch index 是可重建 projection，用于高效的 parent/path/segment 查询，不拥有树内容 authority。compaction 可以创建 segment，扫描通过 base/parent chain 得到完整上下文；SQLite query plan 必须使用 index，不得退化为全表扫描或临时 b-tree。

## 2.7 Forks

Fork 选择 branch scope 或 tree scope。Branch fork 复制选定路径和规定的 lane/config；tree fork 复制完整不可变树、所有 tips 和配置 lane。两种 fork 都排除 usage、pi.result、pi.op.*、pi.pending.* 和活动 operation；目标 nextSeq 不得复用源 seq。应用值/list 的 tree/branch 策略以 WP08 和 values.md 为准。JSONL fork 不得修改 source，SQLite source snapshot 必须位于一个一致边界。

## 2.8 Session 与 repository 边界

Session 负责一个打开的 storage/backend、global data、Branch capability 和唯一 mutation line。Repository 负责 create/open/list/delete/fork、物理身份、reservation、host lifecycle 和 close。Storage 不强制 host ownership，repository/host layer 负责它。

### Search

Search 是 Session/repository 旁的读取服务，不是 AgentLane 的 Branch API，也不改变树的 authority。索引可重建，结果必须明确 source Session/Branch 和 cursor 语义。

## 2.9 Precise rewrite

Precise rewrite 是 administrative copy-retained-and-swap：根据 retain policy 复制 entry、当前值、列表、metadata 和必要 index 到临时 store，再原子替换。它不是普通 runtime deletion，也不能凭 seq 截止线重建已被替换的 value 历史。对于被删除 tip 的 result record/label，必须选择 retain-dangling 或 delete 并写明 policy。

# Part 3 — Operation state machine

## 3.1 Operations

Operation 类型为 run、compaction、navigation。每个 operation 有 immutable meta、complete current state、一个 lane owner（最多一个进程内 Drive）和 result record。接受不等于已经开始执行。

## 3.2 Durable restart point

operationState(operationId) 是唯一 restart authority。每次 transition 写入完整 total state，不依赖之前 state。Control 与 settings、latestAssistantEntryId、intent、attempt 和恢复数据一起保存。恢复从当前 leaf 的负责人开始，不能从缺失 entry、event 或列表猜测阶段。

当前 flat leaf 包括：

~~~text
starting
checkpoint
assistant.ready
assistant.effect_pending
assistant.retry_wait
tools
deferred.suspended
deferred.effect_pending
summary.deciding
summary.ready
summary.effect_pending
summary.retry_wait
navigation.ready_to_commit
~~~

Control 只有 running 或 cancel_requested。queued input 属于 lane inbox，不属于 operation。

## 3.3 Lane state 与 restore projection

Lane.state 保存 tip、lane config、inbox、current operation ID、last operation ID 和需要 dispatch 的 operation projection。Attachment 只读取 Branch tip、lane config/state、operation meta/state、可选 last result；它不 hydration transcript、frames、tool checkpoint 或 queues。presentation 由 watch 在 mutation line 上按需捕获。

## 3.4 Atomic transition rule

一个受支持的 transition 由一个 procedure 负责：在线外准备/执行 effect，在线内读当前权威 projection，准备 write set，最多 commit 一次，发布 process-local state 和 event batch，然后返回。commit 和 publication 的 continuation 必须同步绑定 event recipients；mutation 不等待 listener delivery，公开 operation 等待。

## 3.5 Graph

Graph 是 operation leaf 与 procedure 的闭合映射，不使用可扩展 action DSL。dispatcher 直接按 state.at switch。所有 exit 必须写入新的 leaf、等待状态或 terminal suffix；没有未声明的“保留旧状态”路径。

## 3.6 Acceptance

Acceptance 只规范化并持久化 caller input、operation metadata 和 starting state，不启动 provider、tool、hook、timer 或 Drive。idle lane 中选取可消费的 inbox item，先放置已捕获消息，再放 request prompt；一次 acceptance 只做一个 atomic commit。

Acceptance 不做 registry preflight。model/tool 缺失在真实执行边界以 configuration failure 或 synthetic tool result 返回；unknown resource 不能让 operation 在预测状态中等待。

## 3.7 Assistant generation

assistant procedure 先提交 intent，预留 response/usage ID，随后 provider stream；settlement 将完整 response、usage、下一状态和 frame-list cleanup 原子提交。provider stream 不等待每个 frame 的 storage，frame append 在 Session mutation line 上同步排队，并给每个 promise 绑定 fault observer。settlement 等待最新 append promise，FIFO 使此前 append 已完成。

### Streamed frame persistence

只有可转换的非终止 provider event 追加 frame；done/error 不追加。frame list 是辅助恢复数据，不能证明请求成功或完成。每个 append 都校验同 operation/attempt/response identity，terminal settlement 删除精确列表。

### Classification order

先处理配置和 effect admission，再区分成功、retry、deferred、aborted、overflow、error。未知 provider 结果合成可展示但明确不确定的 response；不能从 partial frame 推断 effect completion。

## 3.8 Tools

工具流程为 prepare → before_tool → intent commit → execute/update/checkpoint → after_tool → finalize → outcome staging → source-order placement。ToolCall 状态包括 planned、effect_pending、outcome_ready、completed。每个 tool result 使用预留 entry ID，out-of-order result 先放 pendingEntry，只有 source prefix 可放置时才进入树。

replay=never 的 effect 不重跑，恢复时用 checkpoint 或 interruption synthesis；replay=safe 可以用持久化 args 重跑。Invocation memo 和 tool checkpoint 都是 operation-owned 辅助数据，不能成为 completion authority。tool_end 的具体含义以 WP09 为准：最终结果 staging 后才发出，outcome_ready 在 placement 前仍显示为 settled。

## 3.9 Summary generation：compaction 与 navigation summary

Summary procedure 先准备 bounded source context，再提交 structural intent，调用 provider，提交 summary result 或 retry/deferred。Compaction 改变后续 provider context，不删除旧 entry；navigation summary 为 tip replacement 准备 commit。SummaryTask 的 boundary 决定 finish、resume_checkpoint 或 commit_navigation。

## 3.10 Navigation

Navigation 是 operation family，不是把 Branch fork 混入普通 run。它可以创建 summary/prepare 状态，最终提交新 tip 或返回失败；移动后的 tip 可能使远程 snapshot 需要 rebase。

## 3.11 Inbox、queues、deferred writes

所有 queued input 属于 LaneState.inbox，item 为 { entryId, kind }，kind 是 steer、followUp、nextRun 或 write。tag 只表示消费资格，不能重排 admission order。不同边界按 mode 选择 eligible item；nextRun 不在运行中消费，followUp 只在 may_finish 前可消费。

运行中 append 的完整 entry 先写 pendingEntry，再把 ID 放入 inbox；idle append 在一次事务中先放 queued writes，再放新 entry。abort 只 drain/return steer 与 followUp，nextRun/write 保留。structural operation 中允许 write 继续排队。

## 3.12 Checkpoint 与 boundary procedure

checkpoint 是每轮之间的 durable resting leaf。boundary planner 选择 inbox item、threshold compaction、continuation、before_run_end 和 finish；一次 decision 最多一次 commit，不能提交回 checkpoint。hook 在 mutation line 外运行，返回后从当前 state replanning，过期 hook result 丢弃。

## 3.13 Terminal transaction 与 result record

terminal suffix 包含 procedure cleanup、写 immutable pi.result/{operationId}、laneState 回到 idle 并保留 inbox、发布 terminal event。operation result 由 operationId 直接读取，不依赖 entry dereference。durable cancel_requested 下的 terminal status 必须是 aborted；任何其他 terminal status 都表示 terminal control 仍是 running。

# Part 4 — Execution、recovery、abort、close

## 4.1 Live operation task

一个 lane 只有一个进程内 Drive pass。第一个匹配 caller 安装，后续 caller join；没有 caller ownership transfer。invocation cancellation 只拒绝该 caller observation，不能自动写 durable abort。

## 4.2 Effect gate

Effect gate 在进程内同步仲裁 cancellation 与 effect admission。必须覆盖 provider、tool、hook、timer 和 deferred fetch/cancel 等 effect。abort-first 不执行 effect；admission-first 使用该 operation 的 signal。没有公开 standalone operation signal。

## 4.3 Session mutation line

Mutation line 保护有界 read-decide-commit-publication。callback 可以读、准备、最多 commit 一次、发布 projection 和绑定 event recipient，但不能执行/等待 provider、tool、hook、timer 或异步 delivery。Storage 的 commit serializer 与 Session line 独立存在。

## 4.4 Attachment 与 open-operation inventory

create attachment 恢复最小 lane/operation projection，返回 open operation inventory；不创建 implicit main，不解析 model/tool registry，不读取详细 presentation。Projection corruption 使 create 失败；可选 frame/checkpoint 缺失合法。watch 后续在 line 上完成 bounded snapshot capture。

## 4.5 Drive 与 crash recovery

drive 依据 expected operation ID 安装/加入 pass；旧 ID 不影响当前 operation。恢复只读取 durable state，按 leaf procedure 继续。provider uncertainty、tool replay policy、deferred handle 和 checkpoint 规则分别决定重跑、合成 interruption 或等待。每个 crash prefix 都必须与 uninterrupted recovery 对照，不能只重复从初始 prefix 调用。

## 4.6 Abort 与 cancellation reconciliation

requestAbort 先设置 beginAbort gate，提交 cancel_requested，再 signalAbort。reconciliation 处理每个 leaf 的 effect、retry/deferred、tool、summary、queued input 和 terminal suffix。取消不会在普通 procedure 中伪造成功；queued steer/followUp 的 drain-and-return 结果只存在返回值中，若返回丢失，其内容按产品决策不可恢复。nextRun/write 保留。

## 4.7 Close：受控崩溃

close 不是 abort。它封闭 mutation admission，等待此前已接纳的 callback/end/commit，拒绝新的 local observation，观察 detached failure，最后关闭 Session。close 不写取消 marker、不生成 synthetic result、不替换 Drive。若 effect window 尚未 settlement，重开按 durable state 恢复。

## 4.8 Faults

Fault 是不可恢复的 process/runtime/storage 错误。required payload corruption 必须由消费它的 attachment/watch/drive fault；可选辅助数据缺失不自动 fault。fault 会封闭 Harness、观察后台失败并按 close 规则结束，不能把损坏状态静默修复成下一阶段。

# Part 5 — Public surface

## 5.1 Lane surface

AgentLane 直接提供 Branch 的 getTipId、findEntries、findEntry、appendMessage、appendCustomEntry，以及 accept、drive、requestAbort、inspectExecution、watch、resume、abort、queue、configuration、getLastResult 等 operation API。没有 sessionTree 或嵌套 Branch。

### Results

Operation result、SuspendedRun、AbortResult 和 inspection 类型必须区分 durable record、deferred observation 和 process-local wait。已结算 operation 可通过 drive(id) 或 getResult(id) 直接取得 immutable record。

## 5.2 Harness

AgentHarness 是 AgentLane 的 manager，不继承 AgentLane。它拥有 lane(name)、lanes()、global config、models、resources、hooks、events、watchSession 和 close。lane 是原子 get-or-create；新 Session/Harness 没有隐式 main，显式请求 lane("main") 才创建它。

### Options

Options 包含模型 identity、stream/retry/compaction/queue 设置、resources/tools、metadata 和 callbacks。构造器/setter 在 publication 前拒绝非法值。Model identity 是 { provider, modelId } 字符串，不持有进程内 Model object。Context 始终作为公开异步方法末尾参数。

## 5.3 Session 与 Branch

Session 提供 global metadata、entry/usage query、typed values/lists、name/labels、branch/createBranch、beginMutation、mutate、close。Branch 只提供路径/tip query 和直接 append。read 绕过 mutation line；read-decide-write 使用 mutate。Repository 负责物理生命周期和 fork。

## 5.4 Snapshots 与 subscription

LaneSnapshot 包含 lane、tip、transcript、lastResult、configuration、operation projection、queues、pendingWrites、stats 和 faulted。snapshot 不复制 registry 配置以外的隐式全局状态。watch 在 mutation line 上同步注册 watcher、复制 live presentation、完成有界 durable read，再返回 handle；buffered event 保留 emitting Context。

runningTools 的 running/settled 表示 effect progress/final staged result；outcome_ready 在 entry_added 前保留在 snapshot，entry_added 只移除自己的 row。reduceLaneSnapshot 是远程复制的规范 fold；navigation_end 返回 rebase，WatchHandle.resnapshot 获取新 snapshot。

## 5.5 Events

事件是观察，不是恢复日志；历史 lifecycle 不重放。commit-bound event 必须在同一 commit continuation 中绑定 recipients，mutation 不等待 delivery。事件包括 run_start/end、turn、step、message、tool_start/update/end、entry_added、queue_update、value_update、config_update、compaction/navigation、fault、usage 和 lane_created。

tool_end 表示 final result 已 staging；run_suspend 仍保持 operation open；in-run compaction_start/end 是 segment bracket，只有对应 operation family 的 terminal end 才结束 operation。事件带 runId/operation context 和必要的 startedAt；watcher 只收到注册之后绑定的事件。

## 5.6 Hooks

Hook pipeline 包括 before_run、before_drive、before_run_end、transform_context、before_request、before_payload、after_response、before_tool、after_tool、before_compaction、before_navigation。Hook 是受 replay contract 约束的 effect，结果在消费它的 commit 中落地；不在 mutation line 上等待。Hook context 明确，不能保存全局 caller context。

## 5.7 Harness execution blocks

Execution block 负责 provider/tool/summary 等外部 effect，必须通过 effect gate，并在 intent/settlement 边界写 durable state。它们不能访问原始 Session，也不能绕过 lane procedure。

### Assistant streaming

provider event 转换为 pi-ai AssistantMessageFrame 后同步 enqueue 到 pending list，监听每个写入 promise 的 fault；done/error 不追加。settlement 等待 latest append，再原子删除 frame list、写 response/usage/state。

### Tool phases

Tool call 先写 intent 和 effective args，再执行 effect。进度 checkpoint 有界且可替换；结果先 staging，按 assistant source order 放置。safe replay 可重跑，never replay 必须合成 interruption。memo/checkpoint/result entry 的 lifecycle 和 cleanup 由 tool durability 规范定义。

## 5.8 Telemetry

Telemetry span 是 observation，不是 durable state。AI request、harness run/turn/step/tool/hook/sleep、session write 等 schema 保持低基数属性约束；response ID、operation ID 等高基数字段只在允许位置使用。prompt、tool output、assistant frame 和 value payload 不进入 telemetry。Context 用于 parentage，不能写入业务 storage。

# Part 6 — Future：partitioned retention（Postgres）

未来可将 immutable entries、当前 values、lists 和 usage ledger 按 Session/tenant/retention partition。必须保持 Entry/Value/List/Usage 的 authority、全局顺序、atomic commit 和 Branch semantics；应用层不能依赖特定后端。Postgres 不是当前 runtime 的必要实现。

# Part 7 — Schema evolution

持久化 schema 包含 format/storage version、地址 namespace/key/kind、entry type、durable state leaf 和 result record。改变字段、地址语法或 value shape 必须明确 migration；不增加静默 coercion。WIP format 可以原地替换，但不能在未获批准时增加兼容 decoder。Migration 必须有界处理 lists，并保持 seq、cursor、usage totals 和 fork policy。

# Part 8 — Work packages

WP00–WP09 按依赖顺序实现：先做持久化模型和运行时基础，再做 atomic acceptance、durable drive、Session/Branch/Lane 分离、scoped storage、tool/assistant output、fork streaming 和 LaneSnapshot settled tools。每个 package 明确 mandatory reading、scope、tests、validation 和 stop condition。历史 handoff 不应被当前实现悄悄改写，除非 package 明确要求文档对齐。

# Part 9 — Invariants 与 tests

## 9.1 Invariants

核心不变量包括：

1. 每个 durable operation 有唯一 immutable meta 和完整 operation state；
2. operationState 是唯一 restart authority，恢复不靠缺失数据推断；
3. 一个 transaction 原子提交，seq 严格按 admission order；
4. Entry immutable，Value 只保留当前值，List 元素 immutable 且只能整表删除；
5. Entry placement 与 pending payload 在一个事务中完成；
6. usage 与每次 settled attempt 同时提交；
7. operation-owned auxiliary state 不能证明 effect 完成；
8. terminal transaction 删除 operation-owned state 并写 pi.result；
9. durable cancel_requested 下 terminal result 必须 aborted；
10. 每个 lane 至多一个当前 operation 和一个 process-local Drive；
11. Drive 的 stale ID 不影响新 operation；
12. Session 没有 implicit main，AgentHarness 不是 AgentLane；
13. Branch 是纯数据路径，AgentLane 直接暴露 Branch surface；
14. Session read 绕过 line，coherent read-decide-write 必须用 mutation line；
15. mutation callback 不执行或等待外部 effect；
16. close 不等于 abort；
17. provider/tool intent 先于 uncertain effect，settlement 之后才宣布完成；
18. safe/never replay 遵守各自规则；
19. frame/checkpoint 有界、受 effect identity fence 保护；
20. Tool result 按 source order placement，runningTools 与 transcript 不重叠；
21. event recipient 在 commit continuation 中绑定，watch snapshot + buffer 无 gap/duplicate；
22. event 是 observation，不是 replay log；
23. Context 不持久化、不由 shared receiver 保存；
24. registry absence 不变成 durable predictive waiting；
25. fork 不复制 usage、result、operation/pending 状态；
26. repository 负责 host ownership、identity、reservation 和 close；
27. JSONL/SQLite/Memory 的逻辑状态一致；
28. list cursor、seq、snapshot compaction 保持语义；
29. Branch index 可重建且不拥有 authority；
30. precise rewrite 不用 seq cutoff 恢复 value 历史；
31. 所有支持的 operation leaf 都能 drive/reconcile；
32. no-commit callback 合法，commit capability 至多消费一次；
33. direct Session/Branch reads 不接受第二个 key；
34. AgentHarness lane acquisition 原子并在 publication 前绑定 lane_created recipient；
35. 每个 committing lane job 在看到 commit 后发布 owned projection 和完整 event batch；
36. receiver 不保留 invocation Context 或 telemetry default；
37. model/tool registry 缺失以内嵌 configuration/synthetic outcome 表达；
38. beginMutation 获取一条 line，commit 不释放，end 才释放；mutate 总是在 finally 中 end。

## 9.2 Race catalog

所有列出的 race 都必须测试两个顺序：

- prompt vs prompt：一个 accept 成功，一个 LaneBusy；
- accept 与 drive 前崩溃：无 acceptance 则重试，有则恢复 starting；
- drive(A) vs drive(A)：一个安装，另一个 join；
- stale A vs current B：A 被拒绝，B 不受影响；
- requestAbort vs settlement：marker 先则 aborted，terminal 先则完成；
- abort vs tool staging：取消状态下真实结果或先完成的结果都只结算一次；
- checkpoint/frame append vs settlement：settlement 等待 latest，晚到更新被 fence；
- tool B 先结算 vs tool A：B 先 staging，但 placement 等 A；
- abort vs before_run_end：stale hook result 丢弃或 follow-up 先提交；
- cancelQueued vs boundary consume：cancelled/already_consumed/not_found；
- setModel vs generation：使用旧或新 snapshot；
- abort vs structural commit：aborted 或 completed；
- nextRun vs acceptance：本 run 捕获或留给下一次；
- structural A vs continuation B：B 接受或竞争 acceptance 赢得；
- drain response vs process/transport loss：返回 payload 或按契约丢失；
- attachment vs resume、watcher vs publication、close vs attachment；
- concurrent Context：各自保留 telemetry parent 和 abort signal；
- close vs settlement：未结算保持 effect_pending，或 settlement 先提交。

## 9.3 Test tiers

Tier A：针对 13 个 leaf，构造、close、reopen、drive，检查下一 transition/wait/terminal result；覆盖每个 recovery prefix、operation family、配置失败、取消、terminal cleanup、pi.result、lane inbox、representation exclusivity。每个受控 commit 边界都比较发布的 Lane.state 与 fresh restore result。

Tier B：使用 instrumented Storage decorator 记录每笔 commit 的精确写入顺序；faux provider/tool/hook 与 commit 交错，捕获 effect-before-intent、漏等 frame/checkpoint、错误 tool placement、缺失 cleanup、late reservation 和 leaked values。

Tier C：用 gated commits 和受控 hook/provider/tool/timer 对 §9.2 的每个 race 测两个顺序。

Cross-cutting：

- Memory、JSONL、SQLite 共享 conformance，结果一致；
- attachment/watch 验证最小 projection、bounded reads、corruption fault、recipient binding、无 gap/duplicate；
- convenience 与 accept/drive/requestAbort primitive composition 产生 byte-identical durable state；
- effect gate 只允许规定的 admission path；
- Context、signal ownership、ledger completeness 和 query plan 都要独立测试；
- SQLite 所有可写事务使用 BEGIN IMMEDIATE，branch segment chain 无 gap/duplicate；
- JSONL torn transaction 不暴露半笔 list/entry，snapshot 保留 cursor 和 seq。

# Appendix A — 术语表

| 术语 | 含义 |
|---|---|
| Pending entry | 在 pi.pending.entry 中等待 placement/cancellation/cleanup 的完整内容 |
| Inbox | lane-owned、按 admission order 排列的 tagged queue |
| Result record | immutable 的 pi.result/{operationId} terminal disposition |
| Continuation run | structural convenience 在仍有 queued conversational input 时创建的新普通 run |
| Operation status | running、open、aborting 的 process-relative observation |
| Open operation | attachment 返回的当前 durable work inventory |
| Attachment | 恢复最小 lane/operation projection，不启动执行 |
| Drive | 一个 lane-owned 的进程内执行 pass |
| Effect | commit、provider request、tool、hook、timer 等非纯计算 |
| Effect gate | effect admission 与 cancellation 的同步仲裁 |
| Reserved ID | 在内容存在前预留的 ID |
| Follower ID | 与 leader 共享时间前缀的独立 ID |
| Session mutation line | Session-wide serialization point 及其 read/one-commit capability |
| Control | 每个 leaf 的 running/cancel_requested 标志 |
| Checkpoint/boundary pass | turn 间的 durable leaf 及解决它的 one-decision procedure |
| Tool checkpoint | pi.pending.tool_output 中有界 live update，不能证明完成 |
| Assistant frame | pi.pending.assistant_frame 中可 replay 的 pi-ai frame，不能证明完成 |
| Outcome ready | tool final result 已 durable，等待 source-order placement |
| Invocation memo | 工具 invocation 范围内的 replay-safe durable value |
| Terminal transaction | 写 universal terminal suffix 的 commit |
| Segment | Branch index 中指向旧 Branch 而非复制它的范围 |
| Precise rewrite | administrative copy-retained-and-swap rebuild |

# Appendix B — Coding-agent v3 format 兼容

v3 指 legacy coding-agent JSONL session format。旧文件必须原样打开并恢复 idle。加载 normalization 规则：

- custom_message 转为 custom agent message；
- label/session_info 转为 session name/entry label value，文件后出现者优先；
- model_change、thinking_level_change、active_tools_change 节点不进入新树；沿选定 physical main path 取每类最近值，重建普通完整 main-lane config 和 idle state；最近值不支持时不回退更旧历史；active tools 缺失归一化为 []，model/thinking 缺失则 main 保持 data-only；
- 被丢弃节点的保留 child 重新挂到最近保留 ancestor；
- legacy compaction 的 firstKeptEntryId 转为 retainedTail，format 4 不暴露该字段；
- details、usage、fromHook、ISO timestamp 和 parentSession path 按现有规则转换；
- 首次 format-4 write 追加 source:v3-import 的 aggregate usage adjustment，保持 ledger totals；
- v3 ID 在 import 时重新生成带原 timestamp prefix 的 UUIDv7，并重写已知 parent/tip/label/fromId/usage 引用；opaque payload 内部 ID 不重写。

只读 open 不修改文件并从 normalized snapshot 算 stats。首次 format-4 write 使用临时文件和 atomic rename 持久化 normalization。open legacy-v3 fork 在普通非空 commit 前拒绝；closed v3 source 可进行不修改源文件的 tree fork，branch fork 需有完整可重建 main lane，data-only main 拒绝。

# Appendix C — 开放问题

1. Overflow detection 仍是 heuristic，但规范的 normalization 是权威；保留原始 reason 到 errorMessage；
2. pending-payload 的 deliberate double write 可能产生 write amplification，应在 pathological payload 下测量后再优化。
