# @earendil-works/pi-protocol

实验性 Pi 协议的运行时无关路由信封、CBOR 编码和字节流分帧。

协议版本 `8` 定义了：

- 用于标识逻辑 `serverId` 的版本握手；
- 明确的服务器和 Session 请求目标；
- 携带不透明严格 JSON 负载的关联请求和响应；
- 请求取消、不透明订阅更新和带外 attachment 变更；
- 非空的不透明错误码和有大小限制的传输消息。

A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. The combined route fences calls to one logical server, durable Session, and live presentation attachment. Management `attach()` and `detach()` return no routing identifiers; the server publishes the selected live route in an out-of-band `attachment` message. Disconnecting releases only that presentation's attachment after admitted calls settle.

Chord 负责这些信封内部负载的语义：`{ serviceId, instance?, member, args }` 调用、`$chord.service` 控制词汇、服务目录、订阅快照和更新、服务错误码，以及复制状态的独立 Delta 路径编解码器。`pi-protocol` 只验证每个不透明负载是否为严格 JSON，不验证也不导出 Chord 语法。客户端和服务器在服务适配器边界通过 `@earendil-works/chord` 解析这些值。

Session 目录状态、管理结果、transcript、模型、插件和其他所有应用值都保持为不透明服务数据。真实的 `Session` 和 `AgentHarness` 仍然只存在于进程内。服务器和 Session 调用会不透明地路由到所属供应商，再由 Chord 和应用进行验证和调用。

服务器和 worker 生命周期有意放在该公共协议之外。实验性本地协调器只是一个不透明消息路由器；每个可替换的服务器进程负责私有生命周期协议。

每个线帧由四字节无符号大端序负载长度和一个确定长度的 CBOR 项组成。`encodeClientMessage()` 和 `encodeServerMessage()` 会验证并编码完整帧。`ClientMessageDecoder` 和 `ServerMessageDecoder` 可以处理任意的流分片和合并。

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

所有信封 Schema 都会拒绝未知对象属性，编解码器还会递归拒绝非 JSON 的不透明负载，包括非有限数字、字节数组、`undefined`、原型和循环引用。信封违规、格式错误的 CBOR 和无效分帧会抛出 `ProtocolValidationError`。负载专用适配器必须在解码后执行自己的语义验证。传输必须保持字节顺序。实验性传输未实现对端认证和已认证服务上下文。

默认限制为每个 CBOR 负载/帧 16 MiB、数组元素或 Map 条目 1,000,000 个，以及嵌套项 64 层。该协议仍处于实验阶段，不提供兼容性保证。
