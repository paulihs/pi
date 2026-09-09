# @earendil-works/pi-server

新持久化 Session 和 Agent Harness 接口的实验性本地服务器。

当前实现支持服务器级和 Session 级 facet 服务路由，以及多 presentation attachment。`RoutedServerServiceHost.attachClient()` 会创建一个连接级服务器服务端点，并提供范围受限的 attachment 管理能力。`RoutedSessionHandle.attachClient()` 返回 presentation 级 Session 能力。它的 `invokeService()` 会将不透明的 service/member 信封转发到选定的 Session 端点；服务器会验证 attachment 路由，但不会加载 facet 契约。

- 服务器服务调用和订阅通过连接的 `RoutedServerServiceAttachment` 不透明地路由；
- 应用拥有的 `SessionDirectory` 将私有目录投影为可安全用于 presentation 的复制状态；
- 应用拥有的 `SessionManagement` 创建、删除、attach 和 detach Session，不会在业务结果中暴露路由 ID；
- 路由器安装或清除实时路由后，attachment 变更会通过带外消息发布；
- Session 服务调用通过 `invokeService` 路由，服务器不会解码业务负载；
- 服务订阅更新仍限定在请求对应的 attachment 内；
- transcript 等应用观测会作为普通服务状态路由，不依赖服务器拥有的业务 Schema。

一个 Session 可以有多个 presentation attachment。在同一连接上重复执行 `attach` 是幂等的；每个成功的 attachment 都有服务器生成的 `attachmentId`，且只作为路由控制数据传递。Session 请求携带 `{ serverId, sessionId, attachmentId }`，服务器会拒绝过期或不匹配的路由。连接丢失会拒绝本地响应，但只有在已接收的服务调用完成后才会释放 attachment。Host 决定何时 presentation 需求为零且 worker 本地 Harness 活动允许回收 worker。服务器关闭时会关闭所有路由中的 Session handle，释放其 worker 和 Session writer 所有权。

```ts
import { randomUUID } from "node:crypto";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  type RoutedServerServiceHost,
  type RoutedSessionHandle,
  type ServerHost,
  SessionAmbiguousError,
  SessionNotFoundError,
} from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";

async function startServer(
  serverServices: RoutedServerServiceHost,
  openRoutedSession: (session: Session) => Promise<RoutedSessionHandle>,
) {
  const sessions = new MemorySessionRepo();
  const host: ServerHost = {
    serverServices,
    async resolveSession(sessionId, context) {
      const matches = (await sessions.list(undefined, context))
        .filter((metadata) => metadata.id === sessionId);
      if (matches.length === 0) {
        throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
      }
      if (matches.length > 1) throw new SessionAmbiguousError();
      return matches[0];
    },
    async openSession(metadata, context) {
      const session = await sessions.open(metadata, context);
      try {
        return await openRoutedSession(session);
      } catch (error) {
        try {
          await session.close(context);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Harness creation and Session cleanup failed",
          );
        }
        throw error;
      }
    },
  };

  const serverId = randomUUID();
  const server = createUnixServer(host, {
    serverId,
    path: getUnixSocketPath(serverId, "/run/user/1000/pi"),
  });
  await server.start();
  return server;
}
```

应用需要提供服务器服务 Host、受限的 Session resolver 和路由 Session 工厂。Session 发现和管理是应用拥有的服务；协议服务器仅在路由 attachment 时向 resolver 请求元数据。Host 负责获取 worker 本地的 Session 和 Harness。失败会在该 worker 中清理。打开的 JavaScript Session 和 Harness 都不会跨越进程边界。

`serverId` 是启动器提供的逻辑身份，而不是套接字地址。Unix 预设要求明确的物理 `path`；`getUnixSocketPath()` 根据调用方选择的目录推导路径。请选择短且私有的运行时目录，不要从没有长度上限的主目录路径推导路由。长期运行的启动器替换服务器进程时可以复用相同的 ID 和路径。

`Server` 通过 `ServerListener` 组合传输；对端认证仍属于应用策略，实验性 Unix 传输不会实现。Unix 子模块提供 `createUnixListener()` 和 `createUnixServer()`。底层路由信封验证、CBOR 和分帧来自 `@earendil-works/pi-protocol`；Chord 负责服务控制解析、错误码、快照和更新，以及每个订阅的复制状态编码器。

服务器和 worker 生命周期在公共 Pi 协议之外管理。可替换的应用服务器将连接 attachment 转换为私有需求更新；worker 将带 generation 标记的需求与权威 Harness 活动结合。实验性协调器只提供稳定路由，并报告通用的服务器 generation 连接变更。
