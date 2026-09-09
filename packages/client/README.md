# @earendil-works/pi-client

实验性 Pi 服务协议的传输无关客户端。

```ts
import { Client, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver bytes in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = await Client.connect({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const result = await client.request(
  { serverId: client.hello.serverId },
  { serviceId: "example.service", member: "read", args: [] },
);
```

客户端会验证物理端点报告的逻辑 `serverId` 是否符合预期。服务器级请求携带该 ID，每个 Session 请求都携带完整的实时目标 `{ serverId, sessionId, attachmentId }`。组合后的持久地址可以防止跨服务器或跨 Session 错误路由；服务器生成的 attachment ID 会拒绝切换或重新连接后的延迟帧。

类型化的服务器和 Session API 由应用拥有的 Chord 服务绑定提供。`createClientServiceTransport()` 将延迟解析的服务器或 Session 路由适配为 Chord 传输；`request()` 和 `subscribeService()` 是它的底层原语。客户端使用 Chord 的服务控制解析器和每个订阅独立的状态解码器；`pi-protocol` 只验证路由信封和严格 JSON 边界。服务订阅会返回完整的供应商快照；绑定安装快照后调用 `start()`，释放水合期间缓存的更新。`Client` 按顺序应用带外 attachment 变更，但不会构造类型化服务代理，也不会解释应用契约。

编码 Agent 的 `Transcript` 等应用观测 API 都是普通 Chord 服务。客户端不会解释它们的快照或更新。

断开连接或释放客户端时，待处理请求会在本地拒绝，但已接受的工作可能在 attachment 释放前于远端完成。客户端会清除实时 attachment 路由。它不会自动重连或重放请求。断开后，请调用 `reconnect()`，通过应用的管理服务重新 attach，并且只显式重复已知安全的操作。

实验性本地协调器只提供稳定端点并转发流量。可替换的服务器进程在公共客户端协议之外负责 Session 和 worker 生命周期。

按以下方式调用传输处理器：

- `handlers.onData(chunk)` for inbound bytes;
- `handlers.onClose()` for an orderly terminal close;
- `handlers.onError(error)` for transport failures.

传输工厂会为每次尝试创建新的已认证连接。请求通过 ID 关联，服务器失败会以 `ServerError` 暴露。

## Unix 域套接字

Node.js and Bun consumers can use the separate Unix transport:

```ts
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new Client({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});
await client.connect();
```

Unix 发现会扫描明确指定的物理路由目录，从文件名推导预期的服务器 ID，并通过现有握手进行验证：

```ts
import { discoverUnixServers } from "@earendil-works/pi-client/unix";

const routes = await discoverUnixServers({ directory: "/run/user/1000/pi" });
// [{ serverId: "...", path: "/run/user/1000/pi/<serverId>.sock" }]
```

格式错误的条目、非套接字、过期或无响应端点以及服务器 ID 不匹配的端点都会被忽略。发现过程是只读的，最多并发探测16个套接字。意外的文件系统和套接字错误会使发现失败。传入 `timeoutMs` 可以覆盖默认探测超时。

`ClientOptions.maxFrameLength` 限制协议负载大小。`maxPendingBytes` 限制 Unix 传输的排队输出。两端应配置匹配的限制。
