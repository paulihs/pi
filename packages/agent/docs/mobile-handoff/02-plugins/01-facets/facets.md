# Plugin 与 Facet 架构

> 状态：设计规范。本文件与 plugins.md 不一致时，以本文件为准。传输 framing 见 rpc.md。

## 1. 系统形状

一个 plugin 最多有三个按 host 类型区分的入口：

~~~text
my-plugin/
  contract.ts    service token + JSON DTO，共享且不导入 host
  server.ts      server facet，可选
  worker.ts      session-worker facet，可选
  tui.ts         presentation facet，可选
~~~

入口在运行时互不连接，只共享 contract.ts 中的 token。每个入口由 esbuild 构建为独立 JavaScript 文件。

Facet 是进程内单元，由静态 manifest 和 construct function 组成。Host 是组装 facet graph 的进程，可以是 server、session worker 或 presentation。连接拓扑是树：

~~~text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
~~~

## 2. Token

Token 是 service contract 的 identity，携带 phantom type、稳定 ID、是否可 RPC 以及 mode：

~~~ts
type ServiceMode = "singleton" | "keyed" | "peer";

interface Service<T, M extends ServiceMode = ServiceMode> {
  readonly id: string;
  readonly mode: M;
  readonly rpc: boolean;
  readonly __type?: T;
}

function defineService<T>(id: string, options?: { rpc?: boolean }): Service<T, "singleton">;
function defineKeyedService<T>(id: string, options?: { rpc?: boolean }): Service<T, "keyed">;
function definePeerService<T>(id: string, options?: { rpc?: boolean }): Service<T, "peer">;
~~~

| mode | 实例 | consumer 声明 | consumer 获得 |
| --- | --- | --- | --- |
| singleton | 一个，所有人共享 | uses | service |
| keyed | 多个，所有人可见 | observes | 每个实例一个 task |
| peer | 每个连接一个，只对该 peer 可见 | uses | service |

peer 用于 per-client state；host 按 peer 懒创建实例并只向该 peer 宣布。从 client 角度它只有一个实例，因此使用 uses。mode 属于 token contract，provider 不能改变；RPC 默认开启，{ rpc: false } 的 token 永不远程公布。

## 3. Facet

Facet 的 manifest 有 uses、provides、observes 三个纯 token 字段：

- uses：需要的 singleton；
- provides：实现的 singleton/keyed/peer service；
- observes：监听 keyed service instances。

construct 只在 kernel 校验完整 graph 并构造依赖后运行，返回真实对象而不是稍后才有效的 proxy。construct 同步执行，只负责连线和返回 provision，不做 I/O；异步初始化放到 onActivate，关闭前执行 onDeactivate。

| 阶段 | 是否同步 | 可调用依赖 | 用途 |
| --- | --- | --- | --- |
| construct | 是 | 否 | 连接对象，返回 provision |
| activate | 否 | 是 | I/O、订阅、初始 fetch |
| deactivate | 否 | 是 | disposal 前有序关闭 |

将 declaration 与 construction 分开，成本是每个 token 多写一次，收益是第三方 facet 运行前即可做纯 manifest 校验，且 construct 内的类型真实可用。setup side effect 产生 disconnected lazy proxy 的旧方案已被替代。

ConstructContext 通过 ctx.use() 取得 uses 中声明的 service，通过 ctx.owner() 取得 keyed owner handle，通过 ctx.state() 创建 host-built replicated state，并注册 onActivate/onDeactivate。ctx.use() 是按 token 的 typed lookup，不使用位置 tuple 或字符串 bag。owner handle 由 kernel 提供，construct 返回 implementation。

## 4. 返回类型与完整性

construct 返回 provide()/watch() 生成的 Entry 数组：

~~~ts
function provide<T>(token: Service<T, "singleton">, impl: T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "keyed">, factory: (key: string, scope: InstanceScope) => T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "peer">, factory: (principal: Principal, scope: InstanceScope) => T): ProvideEntry<typeof token>;

function watch<T>(
  token: Service<T, "keyed">,
  handler: (instance: Instance<T>, context: Context) => void | Promise<void>,
): WatchEntry<typeof token>;
~~~

返回 token 的 union 必须与 provides + observes 双向可赋值：既不能漏实现，也不能返回未声明 token。使用 array 而不是 object map，因为 token 是 object，不能作为 key；字符串 key 会重新引入 manifest/construct 脱节。

question-session facet 的典型流程是：ctx.use(Tools)，ctx.owner(QuestionDialogs)，在 tool execution 中按 invocation ID 调用 dialogs.add()，factory 关闭 facet-private pending map，finally 中 close instance 并清理 pending。construct 只执行一次。

## 5. 顺序与循环

uses/provides 静态可见，kernel 在运行任何 facet 前对 graph 做拓扑排序。missing provider、duplicate singleton owner 和 cycle 都在 manifest 层报告，不执行 facet code。Facet cycle 拒绝；真实的 call-time 循环必须显式使用 deferred(token)，而不是让所有 service 都变成晚绑定的 unusable proxy。

同一个 facet 内两个 service 互相需要时，直接在 construct 中构造对象、手动连引用并返回；这是普通 JavaScript，不进入 kernel graph。对称互依通常说明应合并为一个 service 或两个 facade 共享一个 private object。

## 6. Host、连接与 authority 方向

Host 只能依赖它连接到的上游，连接形成树。每个 host 本地排序，remote provision 视为已经满足的 leaf。

- session worker 可 use server token，例如 spawn_subagent 需要 server session management；
- presentation 可 use server token；
- presentation 消费 session service 时，远端 provider 从其视角是 server，由 server 路由；
- 不存在 presentation 与 worker 直连。

### 6.1 Server 不依赖 worker

server 必须先于 worker 构造，因此不能 use worker service。反向信息使用 reporting registry：

~~~text
worker uses SessionStatusReporting 并 push
→ server 聚合到 SessionStatusView replicated state
→ presentation 读取聚合结果
~~~

依赖仍向上，数据可以向下。server 的 aggregate 初始为空；worker 出现、注册、消失都由连接生命周期处理，crashed worker 是已知连接的移除。

## 7. Facet delivery 与 generation

presentation 初始不携带 plugin facet，只有 host service Tui。plugin facet 作为已构建 bundle 通过 wire 到达。

| generation | source | 生命周期 | 示例 |
| --- | --- | --- | --- |
| connection | server | 一个 server connection | session picker |
| attachment | session worker | 一个 attachment | question dialog、chat |

切换 Session 只拆除/重建 attachment generation，picker 继续工作。attachment 依赖 connection；connection 不能依赖可随时消失的 attachment。

worker 根据工作目录决定随 attachment 发送哪些 TUI bundle，因为 plugin 可来自全局或 Session cwd。目录中的第三方代码将在用户 presentation 进程执行，trust policy 必须在发布前确定。

## 8. 启动与 handshake

### 8.1 Presentation connect

~~~text
TUI → server: connect
server → TUI: server RPC catalogue + connection bundle
TUI: assemble、validate、construct connection generation
~~~

### 8.2 Reaching a session

pi、pi --resume、pi --session <id> 最终都进入同一个 attach；--resume 只是启动时调用 picker command。创建请求携带 cwd，因为 server 需要据此启动 worker，worker 也据此解析 local plugin。

### 8.3 Attach

~~~text
TUI → server: attach(sessionId)
server: authorize，拆旧 attachment，绑定 worker route
server → worker: client attached
worker → server: session RPC catalogue + TUI bundles
server → TUI: catalogue + bundles
TUI: assemble、validate、construct attachment generation
worker/server: hydrate state
~~~

TUI kernel 在拿到 worker catalogue 后一次完成校验，不存在 provisional/degraded resolution。

### 8.4 Worker startup

worker 先连接 server，取得 server catalogue，再加载 global/cwd-local plugin、组装并 construct；worker 对 server token 的依赖在 attachment 前就完成。

## 9. Replication 原语

跨连接只有三类内容：

### 9.1 Service call

普通 request/response，适合 select、submitAnswer 等 action 和不变化内容的一次读取。参数/返回严格 JSON；proxy 去掉 Context，endpoint 重建它。

### 9.2 Replicated state

一个 authoritative writer、多个 reader。stream 发送一个 base op batch，再发送 delta batch；六种操作 vocabulary 见 delta.md。full-value replication 是 producer 每次显式 root replacement/rebase 的退化配置，不是另一个 primitive。

Facet 不手写 op。provider 正常修改 state object，tracker 记录并发送操作：

~~~ts
const tail = scope.state(TranscriptState, initial);

tail.mutate((s) => {
  s.entries.push(entry);
  s.entries[0].text += chunk;
  delete s.pending;
});
~~~

consumer 只应用 op，不运行 provider code，不知道 mutation name。这样 reload 不会因 registry 改变而对同一输入产生不同结果，非 JavaScript consumer 也只需实现固定操作词汇。x=undefined 归一化为 delete。

### 9.3 Contribution registry

多个 facet 可向一个 registry 贡献 tool、command、resource 或 renderer。registry owner 负责 setup 声明、去重、activation、reload 和 disposal。贡献是 code/config，不是 presentation 可上传的任意 object；tool 仍只在 Session authority 执行。

## 10. 隔离与资源 ownership

每个 host/connection/session 都有明确 authority。handle 是 host-built binding，拥有自己的 disposer；不提供独立 own()/unsubscribe handle，避免泄漏。local { rpc:false } service 可返回 raw implementation，是例外。

state value 跨边界必须是 borrowed immutable JSON，宿主在交给 facet 前 harden/freeze；replica 内部 buffer 仍可变，因为 delta apply 需要原地修改。网络访问是 binding，不是 ambient endowment。

presentation/TUI 可使用 compartment；Session/server 是否也对 cwd plugin 使用 compartment 是开放决策。web DOM 是 ambient object graph，单靠 lockdown 不能保证 cleanup；强隔离升级路径是每 facet 一个 iframe 或 declarative-only component。当前规则是让 ctx.dom.on 和 ctx.timer.every 等安全路径最容易使用，同时不假装 web escape 已被封闭。

Facet 的 async 代码由 host 控制恢复。disposal 分别负责 cancel root Context（停止 operation）、unwind driver（执行 finally，停止 continuation）和逆序释放 registration（停止 effects）。

## 11. Protocol：向 foreign client 暴露 service

两端若不是同一套 TypeScript token，需要可获取的 schema。schema 按 service opt-in；没有 protocol block 的 service 不进入 catalogue，HTTP router 返回 no_such_member。

协议定义 service methods 和 state value schema。方法参数使用一个 object 而不是 positional，字段名能保留到 TypeScript、JSON Schema 和 request body，新增 optional field 不改变 arity。只有 root replacement value 需要 schema，mutation recipe 不离开 provider。

schema 必须与接口双向匹配：protocol.methods 的每个 key 都是 service member，params/result 的 Static type 与接口互相可赋值，protocol.state 的每个 key 都是匹配 State<T>。省略就是不发布。

路由：

~~~text
GET  /v1/catalogue
POST /v1/call/{service}/{member}
POST /v1/call/{service}/{key}/{member}
GET  /v1/state/{service}/{member}               SSE
GET  /v1/state/{service}/{key}/{member}         SSE
~~~

peer service 不接收 key，server 按 authenticated session 解析 peer，client 不能访问其他 peer。SSE 首批永远是 base batch，id 由 binding 添加；不接受 Last-Event-ID，重连重新发 base + buffered batch。未知 id、gap、provider reload 都走同一路径。closed keyed instance 以 closed event 结束。

格式类似 JSON-Patch 但不是 RFC 6902：path 是数组，append/truncate/splice 不是 RFC verb。catalogue 明确声明六种 op；若外部 client 确实要求 RFC 6902，server 可经 content negotiation 提供有损转换，但成本由该 client 承担。

catalogue 中的 member 是兼容性承诺，应从一开始标 stability marker；version negotiation 仍是开放项。

## 12. 与 plugins.md 的差异

| 主题 | plugins.md | 本文 |
| --- | --- | --- |
| dependency | setup side effect 推导 | 静态 uses/provides/observes |
| setup handle | disconnected lazy proxy | 校验后真实对象 |
| validation | 运行 facet code 后 | 纯 manifest |
| mode | call site 决定 | token 属性 |
| cycle | 通过 lazy 容忍 | 拒绝，显式 deferred escape |
| replication | full value，DeltaState 延后 | 一个 primitive，root + 六 verb |
| hydration | snapshot 与 buffering 分开 | stream 第一批就是 base |
| presentation facet | 本地加载 | server/worker 发送 |
| server↔worker | 未规定 | reporting registry |
| authority | method 内检查 | Context principal + view/handle |
| per-client state | 未覆盖 | peer mode |
| resource ownership | explicit own | binding 隐式自销毁 |
| UI mounting | 未明确 | slot claim/add，host disposal 时卸载 |
| isolation | trusted code | presentation facet compartment |
| foreign client | 未覆盖 | opt-in protocol + JSON Schema/HTTP/SSE |
| lifecycle | setup | construct/activate/deactivate |

## 13. 开放决策

待决定：cwd session facet 是否 compartment、CheckComplete 错误体验、roles 来源、handle table 归属、guest access 的授予/撤销、protocol version negotiation、high-frequency state flow control、startup 后 lane discovery、reduceLaneSnapshot 是否成为 draft mutator、deferred() 是否保留、tracker property test、需要周期 rebase 的 durable value，以及 facet kernel/service RPC/coding-agent contract 的 package boundary。

## 14. 必需测试

覆盖 manifest provision/requirement、late access guard、missing/duplicate provider、mode、cycle、activation/reverse disposal；local/connected singleton、strict JSON、keyed hydration、generation fence、cancellation、Session routing；cold state、snapshot/update race、buffer、disconnect cleanup、replacement snapshot；loader、reload、worker handoff、capability、contribution、auth routing、telemetry、keyed replacement、question 和 collaborative review。

## 15. 完成条件

插件可以按 host 独立加载；所有 dependency 在 facet code 运行前校验；mode、token、generation 和 authority 边界可静态/运行时验证；三类 replication 和 foreign protocol 行为一致；resource disposal、reload、disconnect、worker replacement 和 durable reconciliation 有测试；开放决策完成后再将本设计提升为最终规范。
