# Pi Agent Telemetry Schema

<!-- 由 generate-telemetry-docs.ts 生成，请勿手工编辑。 -->

## AI 请求 schema

Schema version：1

### pi.ai.request

向 AI provider 发起的一次逻辑请求。

- 父级：root 或任意调用方 span
- 默认状态：ok
- 错误条件：操作抛出异常或返回错误结果

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.ai.operation | string | 是 | stream, fetch_deferred, cancel_deferred, generate_images |  | 逻辑 provider 操作 |
| pi.ai.provider | string | 是 |  |  | 选中的 provider ID |
| pi.ai.model | string | 是 |  |  | 请求的 model ID |
| pi.ai.api | string | 是 |  |  | provider API ID |
| pi.ai.streaming | boolean | 是 |  |  | 操作是否返回流 |
| pi.ai.deferred | boolean | 否 |  |  | 操作是否请求或参与 deferred 执行 |

#### 结束属性

所有结束属性都是可选的完成信息补充。

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.ai.response.model | string |  |  | 实际响应 model |
| pi.ai.response.id | string |  | 高基数 | provider 响应 ID |
| pi.ai.response.stop_reason | string | stop, length, tool_use, error, aborted, deferred |  | 归一化的终止响应原因 |
| pi.ai.http.status_code | number |  |  | 最终 HTTP 状态码 |
| pi.ai.usage.input_tokens | number |  |  | 上报的输入 token 数 |
| pi.ai.usage.output_tokens | number |  |  | 上报的输出 token 数 |
| pi.ai.usage.cache_read_tokens | number |  |  | 上报的缓存读取 token 数 |
| pi.ai.usage.cache_write_tokens | number |  |  | 上报的缓存写入 token 数 |
| pi.ai.usage.reasoning_tokens | number |  |  | 上报的推理 token 数 |
| pi.ai.usage.total_tokens | number |  |  | 上报的总 token 数 |
| pi.ai.usage.cost | number |  |  | 上报的总成本 |
| pi.ai.stream.chunk_count | number |  |  | 流式更新块数量 |
| pi.ai.stream.time_to_first_chunk_ms | number |  |  | 到第一个更新块的耗时，单位毫秒 |
| pi.ai.error.type | string |  | 低基数 | provider 或传输错误类别 |

#### Events

没有声明的 span event。

## Harness schema

Schema version：1

### pi.harness.run

一次已被进程内接受的 run invocation。

- 父级：root 或调用方拥有的外部 span
- 默认状态：ok
- 错误条件：run 失败或抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.session.id | string | 是 |  | 高基数 | Session ID |
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.operation.recovery | boolean | 是 |  |  | 本次 invocation 是否恢复持久化工作 |
| pi.operation.kind | string | 是 | run |  | run 操作类型 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.operation.outcome | string | completed, aborted, failed, suspended |  | run invocation 结果 |
| pi.error.code | string |  | 低基数 | 稳定的 operation 错误码 |
| pi.error.type | string |  | 低基数 | 低基数 operation 错误类别 |

#### Events

没有声明的 span event。

### pi.harness.compaction

一次已被进程内接受的手动 compaction invocation。

- 父级：root 或调用方拥有的外部 span
- 默认状态：ok
- 错误条件：compaction 失败或抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.session.id | string | 是 |  | 高基数 | Session ID |
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.operation.recovery | boolean | 是 |  |  | 本次 invocation 是否恢复持久化工作 |
| pi.operation.kind | string | 是 | compaction |  | compaction 操作类型 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.operation.outcome | string | completed, declined, aborted, failed |  | compaction invocation 结果 |
| pi.error.code | string |  | 低基数 | 稳定的 operation 错误码 |
| pi.error.type | string |  | 低基数 | 低基数 operation 错误类别 |

#### Events

没有声明的 span event。

### pi.harness.navigation

一次已被进程内接受的 navigation invocation。

- 父级：root 或调用方拥有的外部 span
- 默认状态：ok
- 错误条件：navigation 失败或抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.session.id | string | 是 |  | 高基数 | Session ID |
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.operation.recovery | boolean | 是 |  |  | 本次 invocation 是否恢复持久化工作 |
| pi.operation.kind | string | 是 | navigation |  | navigation 操作类型 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.operation.outcome | string | completed, declined, aborted, failed |  | navigation invocation 结果 |
| pi.error.code | string |  | 低基数 | 稳定的 operation 错误码 |
| pi.error.type | string |  | 低基数 | 低基数 operation 错误类别 |

#### Events

没有声明的 span event。

### pi.harness.checkpoint

一次 run checkpoint。

- 父级：pi.harness.run
- 默认状态：ok
- 错误条件：checkpoint 工作抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.checkpoint.kind | string | 是 | normal, abort_reconcile |  | checkpoint 用途 |

#### 结束属性

所有结束属性都是可选的完成信息补充；没有声明的属性。

#### Events

没有声明的 span event。

### pi.harness.turn

一次 assistant response 及其 tool batch。

- 父级：pi.harness.run
- 默认状态：ok
- 错误条件：turn 工作抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.turn.id | string | 是 |  | 高基数 | invocation 内部的 turn ID |

#### 结束属性

没有声明的结束属性。

#### Events

没有声明的 span event。

### pi.harness.step

一次可持久化的 retry attempt。

- 父级：pi.harness.turn、pi.harness.checkpoint、pi.harness.compaction、pi.harness.navigation
- 默认状态：ok
- 错误条件：attempt 重试、失败或抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.step.kind | string | 是 | assistant, compaction, branch_summary |  | 可重试的 step 类型 |
| pi.step.attempt | number | 是 |  |  | 从 1 开始的持久化 attempt 序号 |
| pi.compaction.reason | string | 否 | manual, threshold, overflow |  | compaction 触发原因 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.step.outcome | string | succeeded, retry, failed, aborted, deferred, overflow |  | attempt 结果 |

#### Events

没有声明的 span event。

### pi.harness.tool

一次原始 phase-2 tool execution。

- 父级：pi.harness.turn、pi.harness.run
- 默认状态：ok
- 错误条件：原始 phase-2 执行返回错误

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.turn.id | string | 否 |  | 高基数 | invocation 内部的活动 turn ID |
| pi.tool.name | string | 是 |  |  | tool 名称 |
| pi.tool.call_id | string | 是 |  | 高基数 | tool call ID |
| pi.tool.replay | string | 是 | never, safe |  | 声明的 replay 策略 |
| pi.tool.recovery | boolean | 是 |  |  | 是否为恢复执行 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.tool.is_error | boolean |  |  | 原始 phase-2 执行是否返回错误 |

#### Events

没有声明的 span event。

### pi.harness.hook

一次已注册 hook handler invocation。

- 父级：root 或任意调用方 span
- 默认状态：ok
- 错误条件：handler 抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.lane.name | string | 是 |  | 高基数 | lane 名称 |
| pi.operation.id | string | 否 |  | 高基数 | 接受后对应的持久化 operation ID |
| pi.hook.name | string | 是 | before_run, before_drive, before_run_end, transform_context, before_request, before_payload, after_response, before_tool, after_tool, before_compaction, before_navigation |  | hook 名称 |
| pi.hook.registration_id | string | 否 |  |  | 可选的 hook 注册元数据 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.hook.outcome | string | completed, skipped, blocked, failed |  | handler 结果 |

#### Events

没有声明的 span event。

### pi.harness.sleep

一次 retry delay。

- 父级：pi.harness.run、pi.harness.compaction、pi.harness.navigation、pi.harness.turn、pi.harness.checkpoint
- 默认状态：ok
- 错误条件：sleep 工作抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.operation.id | string | 是 |  | 高基数 | 持久化 operation ID |
| pi.sleep.delay_ms | number | 是 |  |  | 请求的延迟，单位毫秒 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.sleep.outcome | string | elapsed, aborted |  | 延迟结果 |

#### Events

没有声明的 span event。

### pi.harness.event_handler

一次被动事件监听器 invocation。

- 父级：root 或任意调用方 span
- 默认状态：ok
- 错误条件：监听器抛出异常

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.event.type | string | 是 | run_start, run_resume, run_suspend, operation_abort, run_end, fault, handler_error, turn_start, turn_end, retry_scheduled, retry_start, retry_end, message_start, message_update, message_end, tool_start, tool_update, tool_end, entry_added, queue_update, value_update, config_update, compaction_start, compaction_end, navigation_start, navigation_end, lane_created, usage | 低基数 | 已交付的 harness event 类型 |
| pi.lane.name | string | 否 |  | 高基数 | lane 级 event 的 lane 名称 |

#### 结束属性

没有声明的结束属性。

#### Events

没有声明的 span event。

### pi.session.write

一次已提交的 Session 事务。

- 父级：root 或任意调用方 span
- 默认状态：ok
- 错误条件：Storage 拒绝该事务

#### 开始属性

| 名称 | 类型 | 必填 | 取值 | 备注 | 说明 |
|---|---|---:|---|---|---|
| pi.session.id | string | 是 |  | 高基数 | Session ID |
| pi.lane.name | string | 否 |  | 高基数 | 调用方提供时的 lane 名称 |
| pi.operation.id | string | 否 |  | 高基数 | 调用方提供时的持久化 operation ID |
| pi.session.item_count | number | 是 |  |  | 事务中的写入数量 |
| pi.session.item_kinds | string[] | 是 | elements: entry, usage, value, list |  | 事务中出现的不同写入类型 |

#### 结束属性

| 名称 | 类型 | 取值 | 备注 | 说明 |
|---|---|---|---|---|
| pi.session.first_seq | number |  |  | 事务中的第一个提交序号 |
| pi.session.last_seq | number |  |  | 事务中的最后一个提交序号 |

#### Events

没有声明的 span event。
