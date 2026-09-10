# Facet 沙箱 — isolated-vm

**未修改的 pi facet 代码运行在没有环境权限的 V8 isolate 中。** 使用完整 JIT，因此性能约为原生的 1.8 倍，而不是 WASM 解释器的 8–17 倍。

```bash
npm install
npm run demo     # a facet: contributions, components, commands, callbacks
npm run audit    # escape audit — the interesting one
npm run bench    # crossing cost, isolate cost, 300 components
npm test         # 412 property assertions
```

Node 22+（`--experimental-strip-types`）。QuickJS-WASM 等价实现见 `../facet-sandbox-poc`。

## 安全声明，以及它为什么是结构性的

isolated-vm **可以被不安全地使用**，这正是 `facets.md` §14.2 反对它的原因。陷阱在于把宿主对象的实时句柄交给 guest——通过 `derefInto()`，或者通过宿主调用返回 `Reference`；之后 guest 就能沿着该对象的原型链进入宿主 realm。

本膜通过**构造方式而不是使用者小心谨慎**让这种情况不可能发生：

1. `encode()` 是宿主值进入 guest 的唯一方式，它使用带 replacer 的 `JSON.stringify`。**输出是字符串。** 字符串不能携带引用。
2. 宿主可调用对象不会跨越边界。它们会变成 `hostTable` 中的整数 id，而 `hostTable` 完全位于宿主侧。guest 收到的是一个**数字**。
3. 只向 guest 提供**一个** `Reference`——`__invokeRef`，即唯一的调用入口。
4. `derefInto()` 只使用一次，作用于 guest **自己的**全局对象。任何宿主对象都不会作为它的参数。

guest 对宿主的完整视图只有 `{ number, string }`。不存在对象图，也就没有可供遍历的对象。

### 审计结果（`npm run audit`）

```
Ambient authority:
  require / process / fetch          ["undefined","undefined","undefined"]
  global names visible               64 globals

Classic escape ladders:
  Function('return process')()       undefined
  constructor walk on host data      undefined

The isolated-vm Reference footgun:
  __invokeRef.deref()                blocked: TypeError   ("Cannot dereference
                                     this from current isolate")
  __invokeRef.copySync()             blocked: TypeError
  __invokeRef.getSync('constructor') blocked: TypeError
  derefInto() is callable?           inert (object)
  invoke derefInto() result          blocked: TypeError
  host globals via derefInto()       no host globals

Resource bounds:
  spinning guest interrupted         after 205ms
  isolate usable afterwards          true
```

第一版草稿中的一个探针产生了**误报**：通过测试 `f.deref === undefined` 来证明返回的宿主函数是 Proxy 而不是 Reference。该膜会为**每个**属性返回一个 proxy，因此 `f.deref` 为真值。这不是泄漏——调用它会路由到 `hostFn["deref"]`，该属性不存在，随后在宿主侧抛错。当前审计改为调用它，而不是检查它是否不存在。

## 性能

| | isolated-vm | QuickJS | 原生 |
| --- | --- | --- | --- |
| 300 个 Markdown 组件，小 | **70 ms** | 494 ms | 约 40 ms |
| 300 个 Markdown 组件，典型 | **108 ms** | 1118 ms | 64 ms |
| 300 个 Markdown 组件，大 | **419 ms** | 4260 ms | 约 150 ms |
| 146 KB bundle 加载 | **35 ms** | 104 ms | — |
| 膜穿越 | **4.5 µs** | 7–17 µs | — |
| 每个 compartment | 1080 KB，5.5 ms | **77 KB，0.8 ms** | — |

**典型大小约为原生的 1.8 倍。** QuickJS 为 8–17 倍，并且输入越大越慢。

Isolate 的内存开销是 **QuickJS runtime 的 14 倍**（1080 KB 对 77 KB），创建速度也更慢。对于少量 facet 这无关紧要；对于数百个 facet 则不可接受。

这里**存在** `Intl.Segmenter`，这是在 QuickJS 下复用 `packages/tui` 组件的唯一硬阻塞点。仅这一点就可能决定方案。

## 限制

**预算不会嵌套。** 超时只限制一次 `evalSync`。被宿主重新进入的 guest 函数——贡献的回调、组件方法——使用的是 `callGuestRef` 自己的预算，而不是外层预算。在 `property-test.ts` 中有明确断言：外层预算为 50 ms 时，一个失控回调运行了 5005 ms。要限制 facet 总耗时，需要单独计费。

**异步是 settle 回调，不是原生 promise。** `applySync` 是同步的，因此宿主 Promise 不能跨边界。宿主返回一个 token，guest 基于它构建真正的 Promise，宿主再通过回调使其 settle。已验证：宿主事件循环 tick 了 22 次期间，guest 连续执行了两次 `await`。

**原生 addon，以及真实存在的 ABI 矩阵。** `isolated-vm` 提供预构建包，只有没有匹配项时才回退到 `node-gyp rebuild`——这就是安装需要几秒而不是一小时的原因。它**不是在构建 V8**；V8 已经在 Node 二进制中。但覆盖范围很窄：

| 版本 | engines | 预构建包 |
| --- | --- | --- |
| **6.2.0** | `>=22.0.0` | linux-x64/arm64、darwin-arm64、win32-x64 — abi127、abi137 |
| 7.0.1 | `>=24.0.0` | — |
| 7.0.0 | `>=26.0.0` | — |

所有版本都缺少 darwin-**x64**。在 Node 22 上安装 `isolated-vm@7` 会回退到源码构建，在没有 Python 和 C++ 工具链时**失败**——已在此处验证。还要注意，尽管 7.0.1 已存在，6.2.0 仍是 npm 上的 `latest`，因为它晚一天发布。

该项目**不是废弃软件**——从 6.0.1（2025 年 7 月）到 7.0.1（2026 年 8 月）持续积极发布。§14.2 中关于“维护模式”的说法已经过时，应予修正。真正的风险不同：采用它会将最低 Node 版本绑定到它的要求，而且他们在一年内先后从 6.x 中放弃 Node 20、从 7.x 中放弃 Node 22。发布 SEA 构建会把这一风险从每个用户的安装过程转移到 CI。

**内存：引用会释放，但释放是延迟的。** 从 QuickJS 膜移植而来的 `WeakRef` + `FinalizationRegistry` 驻留表无需修改且运行正常——20,000 次穿越最终变为 **0 个存活引用**。但终结并不及时：强制 GC 200 ms 后仍有 5,000 个引用存活。在持续 churn 下，引用累积速度会超过回收速度，一个 32 MB isolate 确实触发过上限。

因此结论是 API 规则，而不是膜修复：**不要在热路径创建引用。** 构造时的 `slots.claim(factory)` 永远只需要一个引用；每一帧返回新闭包的组件方法则每帧需要一个引用。

**达到 `memoryLimit` 会干净地终止 facet。** 它会抛出可捕获的 `"Isolate was disposed during execution due to memory limit"`，宿主仍然存活——但 isolate 已死亡且不可恢复，因此 teardown 必须容忍 isolate 已经被销毁。对它调用 `dispose()` 会抛出 `"Isolate is already disposed"`；膜会对此进行保护。

> **不要对受压的 isolate 调用 `isolate.getHeapStatisticsSync()`。** 测试中它会**终止整个进程**——这是硬崩溃，不是异常。膜中已移除 `heapMB()` helper，而没有将其交付。

**仍然是一个进程、一个引擎。** 独立 isolate 比 SES 强得多，但 Figma 选择 QuickJS 的理由是：*不同的 VM* 无法混淆对象，因为两者表示不同。这里的保证来自 V8 isolate 边界加膜的约束——很强，并且在结构上由上文强制执行，但不属于同一类保证。

## 文件

- `src/membrane.ts`——膜。安全论证位于文件头部注释。
- `src/facet-example.js`——未修改的 facet 代码：`ctx.use()`、带闭包的 `slots.claim()`、返回给宿主的类实例、订阅回调。
- `src/demo-facet.ts`——加载它并执行四次边界穿越。
- `src/escape-audit.ts`——上面的审计。
- `src/property-test.ts`——412 个断言：随机 `JsonValue` 双向往返、跨越边界的身份、可调用对象、错误传播、GC 时引用释放、双向原型污染、预算、异步、销毁。
- `src/bench.ts`——上面的数据。
- `src/markdown-bundle.js`——真实的 pi `Markdown` 组件，由 esbuild 打包。
