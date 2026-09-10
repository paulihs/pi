# Coding-Agent 应用宿主与 Facet

应用无关的 facet、service 和 replicated-state runtime 由 @earendil-works/chord 提供。本文件规定 Pi 如何把它与 Pi 自有的 service contract、进程角色、路由和 lifecycle 组合起来。

> 状态：实验性 facet/service 架构设计规范。

本文假设读者已经理解 AgentHarness、AgentLane、Session、Branch、SessionRepo 和 invocation Context。service transport 语义见 rpc.md，telemetry 模型见 telemetry.md。

## 总览

coding agent 在多个独立进程中组装，分为三层：

1. facet kernel：负责同步 setup、依赖组装、本地/连接 service binding、activation、资源 ownership、setup failure cleanup、reload 和逆依赖顺序 disposal。它理解 service 与 remote service source，但不理解 Harness、tool、TUI 或 coding-agent policy；
2. application host：拥有一种具体 runtime，并提供其具体 service 的 runtime facet。session host 通常运行在专用 session worker 中并拥有真实 Harness；presentation host 拥有 TUI 或未来 web；server host 拥有 SessionRepo、worker 管理、认证、attachment 和 presentation/worker 路由；
3. extension：可分发按 host 区分的 facet bundle。没有一个被所有进程共同加载的 aggregate extension object；每个 host 只加载为本进程构建的 facet。

初始拓扑：

~~~text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
~~~

presentation 和 session worker 都连接 server；不存在 presentation→session-worker 直连，server 将 service call 路由到选定 worker。多 server 路由和 server hierarchy 不在范围内。

session worker 通常拥有一个 Session，每个 session facet 按该 Session 实例化；server facet 每个 server 进程只实例化一次，服务所有 session/presentation，因此只能用于真正 server-wide 的 concern。Host/client 是连接角色，不是固定进程类型。

## 为什么采用这种结构

- authority 留在正确位置：provider credential、tool execution、session extension data 只在 session worker，session record/worker control 只在 server；
- 一个 feature 仍保持一致：tool、dialog、renderer 共享一个 JSON contract，但每个 facet 使用本 host 的代码；
- 新 presentation 只是 presentation-side 工作，不改 session/server；
- server state 保持 server-wide，避免把 per-session state 错放到共享 facet；
- built-in、runtime capability 和 extension 共用一套 facet 机制；
- 可分层测试：service fixture、loopback contract、真实 TUI→server→worker transport 分别测试。

## 一个 feature 的多个独立 facet

不存在 CodingAgentPlugin runtime interface。server、Session worker、TUI、web 运行在不同进程，不能共享一个包含所有 host facet 的 JavaScript object。

进程内单元是：

~~~ts
interface Facet {
  readonly id: string;
  setup(env: FacetEnvironment): void;
}
~~~

每个进程加载适合自身的 Facet[]。setup 是同步声明，异步初始化放在 onActivate()。Feature 由共享 contract bundle 加若干独立解析的 server/session/TUI/web bundle 组成；连接它们的是共享 service ID 和 wire contract，而不是 aggregate object 或 definePlugin() wrapper。

推荐包结构：

~~~text
question-extension/
  contract.ts       JSON DTO 和 service token
  session.ts        dialog authority 和 tool contribution
  tui.ts            terminal dialog/renderer
  web.ts            可选 browser dialog/renderer
  exports           host 到独立可加载 bundle 的未解析映射
~~~

browser build 不能 import session.ts；session process 不能 import TUI/DOM code。

question extension 的流程：

~~~text
model 调用 question tool
→ session facet 添加 invocation-keyed dialog service
→ 所有连接的 TUI/web facet 观察同一个 service instance
→ 第一个 accepted answer 为所有 presentation 结算
→ session facet 返回 durable tool result
→ 关闭 instance，同时关闭所有 presentation dialog
~~~

没有 presentation 连接时 question 保持 pending；后来连接的 TUI/web 获取同一个 pending question。

## 加载和连接 host

loader 比 extension manifest 更小：

~~~ts
interface LoadedFacets {
  readonly facets: readonly Facet[];
  dispose(): Promise<void>;
}

interface FacetLoader {
  load(): Promise<LoadedFacets>;
}
~~~

每个 host 接收静态、组合或 extension-backed loader。loader 负责一个 loaded module generation 的资源；facet host 负责 active environment。启动时加载 facet、组装 service graph、激活；host retire 后才 dispose generation。

extension resolver 可以加入 identity、排序、version selection、package isolation 和按进程 source resolution，但输出仍是每个进程独立的 FacetLoader。kernel 执行 setup、验证完整 graph、绑定 dependency，再按 provider→consumer 激活；setup failure/shutdown 按逆依赖顺序释放。

同一 Session 同时只能由一个进程拥有 authority；worker replacement 必须先关闭旧 owner。presentation/worker 使用一条 multiplexed connection，facet 不处理 socket、request ID、cancellation frame、routing namespace 或 reconnect buffer。

不支持任意 undeclared object remoting、function/class/Map/Set 序列化、remote hook/tool execution、offline presentation write、automatic mutation replay、universal remote AgentHarness 或 serialized UI tree。

## Service 连接 host facet

Facet 通过 service 跨进程通信。token 给 contract 提供 identity：

~~~ts
function defineService<T>(id: string, options?: { local?: boolean }): Service<T>;
~~~

默认 service 可远程发布；{ local: true } 只允许本地。provide(service, implementation) 注册 singleton；provideMany(service) 注册 multi-instance ownership 并返回 ServiceSpawner；consumer 用 use(service) 或 observe(service, handler)。一个 token 在同一 generation 只能使用一种 mode，混用是 assembly/protocol error。

~~~ts
interface ServiceSpawner<T> {
  spawn(key: string, implementation: T): () => void;
}
~~~

TypeScript interface 不提供 runtime member metadata，facet 不维护第二套 descriptor。跨 remote boundary 时 runtime 识别函数为 remote method，识别 Chord ReplicatedState，拒绝不支持成员，并向 transport 发布 member table。local service 可以使用任意 object contract。

singleton use() 同步返回稳定 lazy proxy，即使远端 provider 尚未连接；成员按使用创建 slot，attachment 时与 provider 宣布的 kind 校验。multi-instance 由 provideMany/observe 提供，spawn 返回幂等 close function，live key 必须唯一。observer 先接收当前实例，再按顺序接收 add/replace/remove；每个实例初始 state hydrate 后启动带新 Context 的 handler task。关闭实例会 abort task context、拒绝新调用、让已接纳调用完成；重用 closed key 会创建新 generation，旧 proxy 不能访问替代实例。

实例成员的结构 identity 为 service、key、generation、member。切换 Session 前先终止旧实例 tasks，再 hydrate 新 Session instances。

### Dependency 声明与组装

Facet setup 期间的 service API call 就是 dependency declaration。kernel 不反射被擦除的 TypeScript interface，作者不维护 requires/provides 双表。setup 完成后 host 用本地 provision 和 remote catalogue 匹配 use/observe，拒绝缺 provider、duplicate offer/owner、singleton/keyed mismatch、cycle 和非法 remote implementation。

use/observe 是 hard requirement；optional dependency 需要未来单独 acquisition API，不能从 call failure 推断。只有 env.use/env.observe 取得的 dependency 进入 lifecycle graph；直接 import 另一个 extension 的 live implementation 不受支持。

models service 示例包含 method、replicated state 和多个 consumer：

~~~ts
export interface Models {
  readonly state: ReplicatedState<ModelsState>;
  cycleThinking(context: Context): Promise<void>;
  refresh(context: Context): Promise<void>;
  select(model: ModelRef, context: Context): Promise<void>;
}

export const Models = defineService<Models>("pi.models");
~~~

所有 remote contract 必须是 strict JSON；业务缺失用 null，不用 undefined。未 hydrate 的 ReplicatedState.value === undefined 是本地 control-plane readiness，不是传输值；Context 不序列化。

### Session facet 与 TUI facet

Session facet 直接拥有 provider registry、Models state 和 select/refresh/cycleThinking 实现；TUI facet 通过 env.use(Models) 和 env.use(Tui) 注册 commands，选择 model、调用 service、渲染 replicated state。TUI 没有 credential、registry 或 refresh 逻辑，web facet 使用同一 contract。

### Service 语义

一个 service 是 one owner/many consumers。singleton 由一个 owner 提供，多个 consumer 使用；keyed service 由一个 owner spawn A/B，所有 observer 看到相同实例。Local proxy 绑定本地 slot；remote proxy 断开时调用失败，state 尚未 hydrate 时没有 value。切换 Session 和 reload 期间必须按 generation fence 处理旧 proxy。

## 每种 facet kind 的能力边界

这是最重要的隔离：

- **Session facet** 与真实 AgentHarness/AgentLane/Session/Branch 同进程，可直接访问 provider credentials、tool execution、durable values、operation procedure、Branch data 和 Session mutation line。它可以提供 session-owned service 和 tool contribution，但不能把 raw Session、credential、tool result 或 unbounded data 暴露给 presentation；
- **server facet** 只访问 server-wide SessionRepo、worker registry、auth、routing、attachment 和 server service，不访问任意 Session 的 provider/tool authority；
- **presentation facet** 只通过 service contract 访问 remote state/method，并拥有本地 UI、input 和 presentation lifecycle；不能直接导入 session implementation；
- **shared contract** 只包含 JSON DTO、Service token 和 type definition，不拥有运行时 authority。

## Local service 与窄 remote facade

Local service 可使用 process-local object，但仍通过 token 和 lifecycle graph 管理。远程暴露应提供窄 facade：方法参数、返回值、state 都是严格 JSON，Context 在声明位置由 proxy 消费而不序列化。不要把 Session、AgentHarness、filesystem handle、function、class、Map、Set 或原始 provider/tool object 作为 remote service。

## ReplicatedState

ReplicatedState 是 service-owned state projection，不是 durable storage。provider 持有 authority，consumer 得到 snapshot 和有序 update；late joiner 先 hydrate 完整 value，再接收后续 updates。state update 必须是 JSON-safe，disconnect/reconnect 用完整 snapshot 重建。

snapshot/update race 由 host buffering 处理：先建立绑定，再取得 snapshot，之后应用 buffered update。更新序列由 host connection 管理；gap 或 reconnect 时请求 fresh snapshot。不要把 transport revision 写入业务 state，也不要把 replicated state 当 read-modify-write serialization。

## Contribution registry

多个 facet 可以向一个已定义 registry 贡献 tool、command、resource 或 renderer。registry owner 负责 setup 期声明、去重、activation、reload 和 disposal。contribution 是 code/config，而不是可被 presentation 随意上传的 object；Session facet 的 tool contribution 仍只在 Session authority 执行。

## Context、cancellation 与 telemetry

每个跨 host service method 的 Context 是控制面参数。proxy 从 wire 参数中剥离它，由本地 request wrapper 使用 abortSignal、telemetry parent 和 routing metadata；不把它放进业务 JSON。断开只取消对应调用/观察 task，不自动取消 durable operation。telemetry correlation 保留 Session/lane/operation/request ID，但不能把它们无条件当 provider cache key。

## Service-owned jobs

长生命周期 job 属于 service/facet generation。它使用 setup 时获得的 service handle 和自己的 Context，由 facet own，并在 close/reload/disconnect 时停止。job 不在 setup 中等待，不保存已失效的 proxy，也不在 uncertain RPC 后盲目重放 mutation。

## Server：目录、管理与路由

server 拥有 SessionRepo、session record、worker registry、认证、attachment 和连接路由。server service 只提供真正 server-wide 数据。

### Server host services

典型 service 包括 session directory、worker management、auth identity、selected-session attachment 和 presentation routing。它们输出 JSON-safe DTO，不泄露 Session worker 的 provider/tool authority。

### Shared contract 与 server facet

directory service 暴露 Session metadata、open/closed 状态、display name 和 select/create/delete 等受控方法。server facet 管理 repository/worker，TUI picker facet 使用 directory service 展示和选择 Session。picker 不直接打开文件或控制 worker。

### Attaching、switching、routed call

presentation 先选择 Session，再向 server 请求 attachment；server 启动/选择 worker、建立 attachment binding 并转发 LaneSnapshot/event。切换时旧 attachment task/proxy 失效，新的 Session snapshot 完整 hydrate。

presentation → server → selected session worker 的 routed call 由 host infrastructure 处理 request ID、Context、cancellation、连接复用和返回错误。facet 只看到 typed service proxy，不处理 routing protocol。

## Session-owned deferred interaction：question extension

### Shared contracts

question service 使用 strict JSON 的 question ID、prompt、options、answer 和 submitAnswer(Context)。question ID 是 owner 生成的 service key，不由 client 自选来取得权限。

### Session facet：添加 dialog service

model 调用 question tool 后，Session facet 在一个 invocation-keyed service instance 中保存 prompt/options/answer 状态，等待第一个合法 answer。answer 的 durable result 与 operation/tool settlement 由 Session authority 完成；不把 dialog control 交给 TUI。

### TUI 与 web facet：观察每个 dialog

TUI/web 使用 observe(QuestionDialogs)，在 state hydrate 后创建 native panel，提交答案通过 service method 完成。没有连接的 presentation 时 dialog 仍 pending；late observer 获取同一个 instance。instance 关闭时各 panel 的 Context abort 并清理订阅/widget。

### Durability 与 worker replacement

question 的 authoritative record 属于 Session。worker crash 后重新扫描 pending records，重新 spawn service instance；已接受但尚未完成的 answer 使用 stable invocation/memo/operation ID 恢复，不能重复提交。presentation reconnect 必须 hydrate 新 proxy，不得盲目重放 uncertain submit。

## Lifecycle 与 disposal

资源 ownership 按 dependency graph 管理。setup 注册资源但不运行异步工作；activation 按 provider→consumer；dispose 按 consumer→provider，且重复 close 幂等。每个 facet 只能释放自己拥有的资源，host 负责清理连接、request、observation 和 generation。

## Reload facet

### Shape-preserving provider replacement

若 service graph shape 不变，loader 可装载新 generation，先准备并校验 replacement，再停止旧 provider、切换同一 service slot、重新 hydrate state。singleton proxy、captured method、ReplicatedState facade 保持 identity；替换期间调用失败而不排队，state 暂时 unhydrated。已接受调用不自动 replay/cancel，应由 authoritative state 或 stable operation ID reconcile。

### Shape change 与 process replacement

requirements、provision、mode、facet membership 或 process authority 的变化属于 structural change，需要重新组装 graph 或重启；FacetHost.reload 拒绝此类变化。reload coordinator 在 graph 外：

1. 控制不属于待替换 graph；
2. 独立加载 server/session/presentation bundle；
3. shape-preserving 使用 reload，structural change 先构建/校验 candidate；Session authority 变化先停止旧 worker、释放 ownership；
4. 允许各 host 暂时 generation skew；
5. 失败时报告，不能假装回滚已提交的 Session record、文件写入、subprocess effect 或已切换 host。

ReplicatedState 只是 projection；replacement provider 从 durable record/config 重建完整 snapshot。keyed instance 需要 durable application record 才能跨 worker restart 恢复为新 generation。

worker replacement 有 route gap：

~~~text
旧 worker 停止并释放 Session ownership
→ selected Session 逻辑仍选中但暂不可用
→ 新 worker 打开 Session 并重建 services
→ server 创建新的 attachment binding
→ presentation hydrate 新的 singleton/keyed snapshot
~~~

不要因 uncertain response 盲目 retry mutation；prompt 等操作必须通过 stable operation ID 或 authoritative reconciliation 处理。

## Connection loss、错误与安全

- presentation disconnect：server 取消 client active request、关闭 observed instance task；Session-owned work 按策略继续；
- Session worker disconnect/crash：server 失败 routed call 并关闭 worker instance task；presentation 看到 degraded attachment，但 directory 仍可用；
- process 与 server 断连：connected server/session service 不可用，Session worker 失去 server service，unattended policy 决定是否退出；
- reconnect/reattach 总是从 fresh authoritative snapshot hydrate；旧 proxy/frame 失效，不能盲目 replay uncertain mutation。

Wire error 是 { code, message } JSON envelope；未知异常归 internal_error，不暴露 stack。remote service 只接受受信 token、function 和 branded ReplicatedState；local service 不远程发现。business args/result/state 必须是 JSON；client 不能伪造 Context position、instance generation、selected Session routing 或他人 cancellation target；credential、prompt、completion、tool args/result、filesystem content 只有显式 contract 才可暴露。

## Host composition

facet kernel 只理解 service，不理解应用。完整产品为 server authority、每个 Session worker、每个 presentation 分别提供独立 facet set。共享 contract 只提供 service token 和 JSON DTO，不意味着 provider/consumer 共用 bundle。

## 开放决策

在 extension layer 正式化前仍需决定：Extension identity、版本到 host bundle 的映射、manifest/source selection、排序、package exports、trust、跨进程 version skew、结构化 graph replacement、各 host capability、directory state 可见范围、auth/authorization/version negotiation/error code、optional dependency、多 Session presentation、replicated-state flow control/gap recovery、keyed service 以外的 returned reference，以及 facet kernel/service RPC/coding-agent contract 的 package boundary。

## 必需测试

覆盖 setup-derived provision/requirement、late access guard、missing/duplicate provider、mode、cycle、activation/reverse disposal；local/connected singleton、strict JSON、keyed hydration、generation fence、cancellation、Session routing；cold state、snapshot/update race、buffering、disconnect cleanup、replacement snapshot；static/combined loader 和 shape-preserving provider reload 的稳定 handle。

还要覆盖 extension discovery、按进程隔离 bundle、graph reload、worker handoff、host capability、contribution registry、认证路由、telemetry propagation、keyed provider replacement/activation failure，以及 question 和 collaborative review 示例。

## Collaborative diff review：可持久化共享侧栏

Diff review 从 presentation 发起。用户要求检查 working-tree diff，Session 生成一个共享 review；所有 TUI/web presentation 展示同一 patch 和 comment，授权用户可添加 comment 或一次性提交 review。

~~~text
DiffReviewManager                    singleton service
  createReview()
    → 持久化 immutable patch
    → 添加 DiffReviews[reviewId]

DiffReviews[reviewId]                 keyed service
  document                           immutable patch state
  activity                           durable comments/status
  addComment()                       commit 后 publish
  submit()                           freeze、enqueue 一个 prompt、close
~~~

keyed instance 是实时 projection，extension-owned record 是 durable authority。每个确认的 comment 在 worker restart 后保留；prompt 被 durable accept 后才删除 record。

### Shared remote contract

DiffCommentInput 包含稳定 commentId、path、side、line、body；DiffComment 增加 authenticated author/createdAt；document 保存 reviewId/patch；activity 保存 revision/comments/status。client 不提供 patch、author 或 review ID；Session 从 bounded immutable patch 和 Context identity 生成它们。commentId 只是 idempotency key，不授予 authority。

### Narrow local durability capabilities

Session facet 使用三个 local capability：working-tree diff source、串行 review store、带 enqueueOnce 的 prompt queue。一个 durable review record 保存 immutable patch、revisioned comments、status 和可选 frozen submission。local capability 使用 { local: true } service，不出现在共享 extension contract。

### 为什么 record mutation 需要 critical region

每个 storage call 虽然原子，但应用的 read-modify-write 跨多个 await。两个 submit 可以都读到 open，分别 freeze 为 subm-A/subm-B，随后 enqueue 两个 prompt。解决办法是按 review ID 的 FIFO、non-reentrant async mutex；addComment、freezeForSubmission、complete 都必须进入同一 region。已在队列中的 aborted caller 被移除且不执行 fn；进入后在 finally 释放。critical region 可由 storage CAS 或 repository serialized capability 替代，但必须保留每个 review 的 linearizable read-modify-write。

### Session facet

activation 扫描 pending review records，为每条创建 DiffReviews instance 并发布 document/activity；frozen submission 通过 enqueueOnce 恢复。createReview snapshot diff 后创建 record/instance；submit 原子 freeze comment/submission ID、publish submitting、enqueueOnce，完成后删除 record/关闭 instance。comment 先提交则进入 frozen prompt，freeze 后到达则 review_closed；complete/close 幂等。

### TUI 与 web facets

两者都 observe(DiffReviews)，hydrate 后打开 native panel，订阅 activity，转发 comment/submit，instance context abort 时关闭。patch 只发送一次，activity 立即提供当前 comments；late client 看到同一 review。提交时 prompt 包含 immutable patch 和 frozen comments。viewer roster/cursor 属于另一个 live state，不写 review record。

## 延后：基于 delta 的 replicated state

DeltaState 不属于初始 facet-service/RPC contract。只有具体 feature 证明 full-value ReplicatedState 成本过高，且模式在多个 feature 重复时才增加。

未来的 DeltaState<S,D> 可保留 ReplicatedState 的同步 value/snapshot hydration，并在 hydrate 后发送 typed delta。provider 提供 apply(delta, context) 和 replace(value, context)，共享纯 reducer 更新 replica。host 负责 revision、hydration race buffer、连续帧检查、gap/reconnect 后 fresh snapshot。它只解决 live replication，不解决 durable storage、mutation serialization、multi-writer merge、offline edit 或 automatic mutation replay；durable canvas 仍需自行串行化 mutation 和持久化 delta。
