# 纯事件驱动架构迁移计划

## 目标

将 pizza 从当前的"内核已换、外壳未换"中间态，彻底迁移为以 EventStore 为唯一真相来源的纯事件驱动架构。移除所有旧 adapter/bridge/translator 层。

## 设计原则

1. **EventStore 是唯一真相来源** — 所有状态（消息、会话、目标、配置变更）都从事件流投影得出
2. **Reactor 是唯一执行引擎** — 删除旧的 `Agent` 类和 `agent-loop.ts`，Reactor handler 表驱动一切
3. **Projection 替代命令式状态** — `state.messages` 数组不再存在，UI/扩展通过 projection 订阅事件流
4. **零 adapter 层** — 不做 EventStore → AgentEvent 翻译，不做旧 SessionManager 桥接。消费方直接订阅 TypedEvent
5. **扩展接口重定义** — 扩展系统的事件回调直接接收 EventStore 事件，而非旧的 AgentEvent

## 要删除的文件/代码

| 文件 | 原因 |
|---|---|
| `src/core/agent/agent.ts` | 旧的 Agent 类，被 EventSourcedRuntime + Reactor 替代 |
| `src/core/agent/event-sourced-adapter.ts` | adapter 层，包含 EventStoreToAgentEventTranslator 和 buildLlmClientFromStreamFn 等桥接代码 |
| `src/core/event-store-bridge.ts` | 旧 SessionManager → EventStore 双写桥接 |
| `src/core/runtime/runtime-adapter.ts` | EventSourcedRuntimeHost adapter，把新运行时包装成旧 AgentSessionRuntime 接口 |
| `src/core/agent-session-runtime.ts` | 包装 AgentSession + EventStore 的中间层，新架构下由 EventSourcedRuntime 直接暴露 |
| `src/core/agent-session.ts` | 3000+ 行的命令式 AgentSession 类，拆分为轻量的 SessionFacade |
| `src/core/session-manager.ts` | 旧的基于 JSON 文件的 SessionManager，被 `projection/session-manager.ts` 替代 |
| `src/core/agent-session-services.ts` | 为旧 AgentSession 提供服务的工厂，随 AgentSession 一起删除 |
| `src/core/messages.ts` | 旧的 create*Message 工厂函数，事件模型下消息由事件投影生成 |

## 架构层次（迁移后）

```
┌──────────────────────────────────────────────────────────────┐
│  Modes (interactive / rpc / print)                            │
│  直接订阅 EventStore，消费 TypedEvent                          │
└──────────────────────┬───────────────────────────────────────┘
                       │ subscribe(TypedEvent)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  SessionFacade (轻量门面，~300 行)                             │
│  - prompt / steer / followUp / abort / compact               │
│  - model/thinking 工具管理                                    │
│  - 扩展生命周期                                              │
│  持有 EventSourcedRuntime，不持有命令式 state                   │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  EventSourcedRuntime                                          │
│  - 持有 EventStore (SQLite)                                   │
│  - 持有 Reactor（turn 循环引擎）                               │
│  - 持有 SessionProjection（上下文构建）                        │
│  - 持有 SessionManager（会话描述管理）                         │
│  - 持有 IntentExecutor + Classifier                           │
│  - 持有 CompactionEngine                                      │
│  - 暴露 subscribe() / prompt() / abort() / compact()         │
└──────────────────────┬───────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────────┐
    │ EventStore│ │ Reactor  │ │ Projections  │
    │ (SQLite)  │ │ (handler │ │ session/     │
    │           │ │  table)  │ │ timeline/    │
    └──────────┘ └──────────┘ │ goal/         │
                               └──────────────┘
```

## 阶段划分

### Phase 1: 补齐 EventStore 事件覆盖

**目的**：让 EventStore 能表达当前 `AgentSessionEvent` 的所有语义，使得消费方迁移后不会丢失信息。

**任务**：

- [x] **1.1 补充缺失事件类型到 `events.ts`**
  - `COMPACTION_ABORTED` — 用户取消 compaction（区分于 `COMPACTION_END` 正常完成）
  - `RETRY_ABORTED` — 用户取消重试
  - `AGENT_ERROR` — 运行时级别错误（区别于 `RUNTIME_ERROR`，后者是系统级）
  - 确认 `BashExecutionEvent` / `CustomMessageEvent` / `BranchSummaryEvent` 已有（已确认存在）

- [x] **1.2 完善 `event-to-message.ts` 转换**
  - 当前只处理 `USER_MESSAGE` / `AGENT_MESSAGE_END` / `TOOL_EXECUTION_END` / `COMPACTION_END` / `BASH_EXECUTION` / `CUSTOM_MESSAGE` / `BRANCH_SUMMARY`
  - 补充：`FILE_MUTATION_APPLIED` → 通知类消息
  - 确保 `buildContext()` 能从事件流完整重建 LLM 可消费的 `AgentMessage[]`

- [x] **1.3 Reactor 补齐 reactor 控制事件**
  - `AGENT_TURN_COMPLETED` 已经存在但需确认 reactor 在 followUp / steer 场景也正确发射
  - 补充 followUp/steer 排队逻辑到 reactor handler 表中（当前在 Agent 类内部）

- [x] **1.4 测试**
  - 单元测试：每种新事件类型 → 正确投影为 AgentMessage
  - 集成测试：完整 USER_MESSAGE → AGENT_MESSAGE_END → TOOL_EXECUTION_END → TOOL_RESULTS_AGGREGATED 循环

### Phase 2: 增强 EventSourcedRuntime 公共 API

**目的**：让 EventSourcedRuntime 暴露所有当前 `AgentSession` 暴露的操作，成为自足的运行时。

**任务**：

- [x] **2.1 `EventSourcedRuntime` 接口扩展**
  - `prompt(text, images?)` — 已有
  - `steer(text)` — 发射 USER_INTERRUPT + 重新进入 turn（需在 reactor 中实现）
  - `followUp(text)` — 发射 USER_FOLLOWUP_QUEUED
  - `abort()` — 发射 USER_INTERRUPT，reactor 清理
  - `compact(options?)` — 发射 COMPACTION_REQUESTED
  - `setModel(provider, modelId)` — 发射 MODEL_CHANGED
  - `setThinkingLevel(level)` — 发射 THINKING_LEVEL_CHANGED
  - `subscribe(listener)` — 已有（EventStore.subscribe）
  - `getProjection()` — 返回 SessionProjection
  - `getTimeline(options?)` — 已有
  - `getTools()` / `setTools(tools)` — 工具注册管理
  - `getSystemPrompt()` / `setSystemPrompt(prompt)` — 系统提示词管理
  - `waitForIdle()` — Promise，在 AGENT_TURN_COMPLETED 后 resolve

- [x] **2.2 CompactionEngine 从 AgentSession 中提取**
  - 创建 `src/core/compaction/compaction-engine.ts`
  - 从 `AgentSession._handleAutoCompaction()` / `compact()` 提取逻辑
  - 输入：EventStore + SessionProjection + LLMClient（用于生成 summary）
  - 输出：发射 COMPACTION_START / COMPACTION_END 事件
  - compaction 语义改为：标记旧事件为 voided（通过 COMPACTION_END.first_kept_event_id），不删除事件

- [x] **2.3 RetryPolicy 在 reactor 中实现**
  - reactor 已有 `onLlmCallFailed` handler 和 `RETRY_SCHEDULED` 事件
  - 补充：在 `AGENT_TURN_COMPLETED.reason = "error"` 时也触发 retry
  - 补充：abort retry 的支持（RETRY_ABORTED 事件）

- [x] **2.4 并发 guard**
  - EventSourcedRuntime.prompt() 中检查是否有活跃 turn
  - 活跃 turn 期间第二次 prompt() 抛异常（与旧 Agent 行为一致）
  - steer / followUp 是唯一允许的排队操作

- [x] **2.5 测试**
  - 对每个新 API 方法编写单元测试
  - 集成测试：完整交互场景（prompt → tool → followUp → compact）

### Phase 3: 新增 SessionFacade 门面

**目的**：创建一个轻量级的门面类，替代旧的 `AgentSession`，作为 modes 和扩展的交互入口。

**任务**：

- [x] **3.1 创建 `src/core/session-facade.ts`**
  - 持有 EventSourcedRuntime
  - 持有 SettingsManager（读取配置）
  - 持有 ExtensionRunner（扩展系统）
  - 持有 ModelRegistry（模型解析）
  - 暴露 prompt / steer / followUp / abort / compact / subscribe 等方法
  - 暴露 model / thinkingLevel / tools 的 getter/setter（内部发射事件）
  - **不持有** messages 数组、不持有 state 对象

- [x] **3.2 扩展系统接口适配**
  - `ExtensionContext.sessionManager` 类型从旧的 `ReadonlySessionManager` 改为基于 EventStore 的新接口
  - `ExtensionContext.signal` / `ExtensionContext.abort()` 从 reactor 的 abortController 获取
  - 扩展事件回调（before_provider_request, after_provider_response, before_agent_start 等）改为直接从 EventStore 事件流中获取上下文

- [x] **3.3 ExtensionRunner 事件适配**
  - ExtensionRunner 直接订阅 EventStore
  - `ToolCallEvent` / `ToolResultEvent` 等从 `TOOL_EXECUTION_START/END` 事件构建
  - `ContextEvent` 从 `AGENT_MESSAGE_END` 事件构建
  - 保持扩展 API 不变（扩展代码不需要改），但内部数据来源换成事件流

- [x] **3.4 测试**
  - SessionFacade 单元测试
  - 扩展系统在 SessionFacade 下的集成测试

### Phase 4: Modes 层迁移

**目的**：interactive / rpc / print 三种模式直接订阅 EventStore TypedEvent。

**任务**：

- [x] **4.1 定义 ModeEventMapper**
  - `src/modes/event-mapper.ts`
  - 将 TypedEvent 映射为 mode 需要的 UI 动作（不是映射回旧 AgentEvent）
  - 映射示例：
    ```
    AGENT_MESSAGE_START  → 创建 streaming 组件
    AGENT_MESSAGE_CHUNK  → 更新 streaming 内容
    AGENT_MESSAGE_END    → 定稿 assistant 消息
    TOOL_EXECUTION_START → 创建工具组件
    TOOL_EXECUTION_UPDATE→ 更新工具进度
    TOOL_EXECUTION_END   → 定稿工具结果
    AGENT_TURN_START     → 显示 loading
    AGENT_TURN_COMPLETED → 隐藏 loading
    COMPACTION_START     → 显示 compaction loader
    COMPACTION_END       → 重建 chat
    RETRY_SCHEDULED      → 显示 retry 倒计时
    MODEL_CHANGED        → 更新 footer
    ```
  - 这是新的 UI 事件协议，替代旧的 AgentEvent switch-case

- [ ] **4.2 `interactive-mode.ts` 迁移**
  - `subscribeToAgent()` 改为订阅 `sessionFacade.subscribe()`
  - `handleEvent(event: AgentSessionEvent)` 改为 `handleEvent(event: TypedEvent)`
  - 删除对 `session.state.messages` 的直接读取
  - 消息重建从 `projection.buildContext()` 获取
  - `getMessages()` 改为 `sessionFacade.getProjection().buildContext()`

- [ ] **4.3 `rpc-mode.ts` / `rpc-client.ts` 迁移**
  - RPC 协议中事件格式改为 TypedEvent JSON
  - `rpc-client.ts` 的 `onEvent()` 回调接收 TypedEvent
  - `waitForIdle()` 改为 `sessionFacade.waitForIdle()`

- [ ] **4.4 `print-mode.ts` 迁移**
  - 最简单的 mode，直接 subscribe TypedEvent 输出 JSON

- [ ] **4.5 测试**
  - 为 ModeEventMapper 编写映射完整性测试
  - 头部集成测试验证 interactive mode 完整流程

### Phase 5: 清理旧代码

**目的**：删除所有被替代的旧代码。

**任务**：

- [ ] **5.1 删除旧 Agent 相关**
  - 删除 `src/core/agent/agent.ts`（600 行）
  - 删除 `src/core/agent/event-sourced-adapter.ts`（620 行）
  - 删除 `src/core/agent/types.ts` 中的 `AgentEvent` 联合类型和 `StreamFn` 等旧 loop 类型
  - 保留 `AgentTool` / `AgentMessage` / `AgentState` 等域模型类型（它们仍被使用）
  - 清理 `src/core/agent/index.ts` 的导出

- [ ] **5.2 删除旧 Session 相关**
  - 删除 `src/core/agent-session.ts`（3000 行）
  - 删除 `src/core/agent-session-runtime.ts`（365 行）
  - 删除 `src/core/agent-session-services.ts`（相关行）
  - 删除 `src/core/session-manager.ts`（1045 行）
  - 删除 `src/core/event-store-bridge.ts`（362 行）
  - 删除 `src/core/runtime/runtime-adapter.ts`（210 行）

- [ ] **5.3 删除旧消息工厂**
  - 删除 `src/core/messages.ts` 中的 `create*Message()` 工厂
  - `BashExecutionMessage` / `CustomMessage` 等接口类型移入 `agent/types.ts` 或 `event-store/types.ts`

- [ ] **5.4 更新 `sdk.ts`**
  - `createAgentSession()` 改为创建 SessionFacade + EventSourcedRuntime
  - 移除 `useEventSourcedRuntime` 开关（永远为 true）
  - 返回类型从 `AgentSession` 改为 `SessionFacade`
  - 更新 examples/ 下的示例代码

- [ ] **5.5 更新 `main.ts`**
  - 移除 `createEventSourcedRuntimeHost` 调用
  - 直接使用 `createAgentSession()` 返回的 SessionFacade
  - 移除 `AgentSessionRuntime` 相关的包装代码

- [ ] **5.6 清理 import 链**
  - 全局搜索 `from ".*agent-session"` / `from ".*session-manager"` / `from ".*agent/agent"`
  - 确保没有残留引用

- [ ] **5.7 更新测试**
  - 删除引用旧 AgentSession / Agent / SessionManager 的测试
  - 更新 `test/compaction.test.ts` 改为基于事件的测试
  - 更新 `test/session-manager/` 下的测试改为测试 projection/session-manager
  - 更新 `test/headless-integration.test.ts` 改为纯事件流测试

### Phase 6: 扩展系统最终适配

**目的**：确保扩展系统在纯事件驱动下工作，保持向后兼容的扩展 API。

**任务**：

- [ ] **6.1 ExtensionContext 接口更新**
  - `sessionManager` 属性改为基于 EventStore 的只读查询接口
  - 新增 `eventStore` 属性（或 `subscribe()` 方法）让扩展可以订阅事件流
  - `getContextUsage()` 从 SessionProjection 获取 token 统计

- [ ] **6.2 Extension 事件回调**
  - `before_agent_start` — 在 AGENT_TURN_REQUESTED handler 中触发
  - `before_provider_request` — 在 LLM_CALL_REQUESTED handler 中触发
  - `after_provider_response` — 在 AGENT_MESSAGE_END handler 中触发
  - `tool_call` — 在 TOOL_EXECUTION_START 之前触发
  - `tool_result` — 在 TOOL_EXECUTION_END 之后触发
  - 保持旧的 event shape 不变（扩展代码不需要改），但内部由 reactor handler 触发

- [ ] **6.3 Extension 的 session 操作**
  - `newSession()` / `fork()` / `switchSession()` 改为通过事件驱动
  - `navigateTree()` 改为修改 SessionProjection 的 range
  - `sendMessage()` / `sendUserMessage()` 改为发射事件

- [ ] **6.4 测试**
  - 验证现有扩展（examples/extensions/）在新的 SessionFacade 下正常工作

---

## 文件变更预估

| 操作 | 文件 | 预估行数 |
|---|---|---|
| 新增 | `src/core/session-facade.ts` | ~400 |
| 新增 | `src/modes/event-mapper.ts` | ~300 |
| 新增 | `src/core/compaction/compaction-engine.ts` | ~250 |
| 重写 | `src/core/runtime/runtime.ts` | ~500 |
| 重写 | `src/core/sdk.ts` | ~300 |
| 重写 | `src/modes/interactive/interactive-mode.ts` | 事件处理部分重写 |
| 删除 | 7 个旧文件 | ~6600 行净减 |
| 修改 | `src/core/agent/types.ts` | 删除旧 AgentEvent，保留域类型 |
| 修改 | `src/main.ts` | 简化入口 |
| 修改 | 测试文件 | 按需更新 |

## 风险和注意事项

1. **扩展兼容性**：`ExtensionFactory` 接口签名需要保持稳定。内部实现改为事件驱动，但扩展写法不变。
2. **性能**：每次 `buildContext()` 都要查询 EventStore。对长会话需要确保查询效率（SQLite 索引、compaction 截断）。
3. **compaction 语义变更**：从"覆写 messages 数组"变为"标记事件范围"。COMPACTION_END 的 `first_kept_event_id` 是关键。
4. **流式体验**：AGENT_MESSAGE_CHUNK 事件的延迟直接影响用户体验。需要确保 reactor handler 不阻塞 chunk 发射。
5. **渐进式部署**：Phase 1-2 可以独立完成且不影响现有功能。Phase 3-4 是破坏性变更。Phase 5-6 是清理。
