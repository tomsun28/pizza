# 纯事件驱动架构迁移计划

## 目标

将 pizza 从当前的"内核已换、外壳未换"中间态，彻底迁移为以 EventStore 为唯一真相来源的纯事件驱动架构。移除所有旧 adapter/bridge/translator 层。

## 设计原则

1. **EventStore 是唯一真相来源** — 所有状态（消息、会话、目标、配置变更）都从事件流投影得出
2. **Reactor 是唯一执行引擎** — 删除旧的 `Agent` 类和 `agent-loop.ts`，Reactor handler 表驱动一切
3. **Projection 替代命令式状态** — `state.messages` 数组不再存在，UI/扩展通过 projection 订阅事件流
4. **零 adapter 层** — 不做 EventStore → AgentEvent 翻译，不做旧 SessionManager 桥接。消费方直接订阅 TypedEvent
5. **扩展接口重定义** — 扩展系统的事件回调直接接收 EventStore 事件，而非旧的 AgentEvent

 ## 已删除的文件/代码
 
 | 文件 | 状态 | 阶段 |
 |---|---|---|
 | `src/core/runtime/runtime-adapter.ts` | ✅ 已删除 | Phase 5 |
 | `src/core/agent-session-runtime.ts` | ✅ 已删除 | Phase 7 |
 | `src/core/event-store-bridge.ts` | ✅ 已删除 | Phase 7 |
 | `src/core/agent/agent.ts` | ✅ 已删除 | Phase 9 |
 | `src/core/agent/event-sourced-adapter.ts` | ✅ 已删除 | Phase 9 |
 | `src/core/agent-session.ts` | ✅ 已删除 | Phase 9 |
 
 ## 保留的文件
 
 | 文件 | 用途 |
 |---|---|
 | `src/core/session-manager.ts` | `SessionManager.list/listAll` 用于 session picker；compaction 工具函数 |
 | `src/core/messages.ts` | `convertToLlm` 被 compaction-engine/extensions/interactive-mode 使用 |
 | `src/core/session-services.ts` | `createSessionServices()` 创建 cwd-bound 服务（auth/model/settings/resource） |
 | `src/core/agent/types.ts` | 域模型类型：`AgentMessage`, `AgentTool`, `ThinkingLevel`, `AgentState` 等 |

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

- [x] **4.2 `interactive-mode.ts` 迁移**
  - [x] `InteractiveMode.fromFacade()` 静态工厂方法：从 `CreateSessionFacadeResult` 创建 facade 模式的 InteractiveMode
  - [x] `subscribeToFacade()` + `handleModeEvent()`：订阅 `facade.subscribe()` 并通过 `mapTypedEventToModeEvents()` 转换 TypedEvent → ModeEvent
  - [x] 完整 ModeEvent 处理：turn_started/completed, message_committed, streaming_message_started/updated, tool_started/updated/finished, compaction_started/finished/aborted, retry_scheduled/aborted, model_changed, thinking_level_changed, runtime_error, agent_error
  - [x] Facade-aware 访问器层：`modelRegistryValue`, `extensionRunnerValue`, `resourceLoaderValue`, `currentModel`, `currentThinkingLevel`, `isStreaming`, `isCompacting`, `autoCompactionEnabled` 等
  - [x] Facade-aware 方法包装：`compactFacade()`, `getContextUsageFacade()`, `setModelFacade()`, `cycleModelFacade()`, `cycleThinkingLevelFacade()`, `navigateTreeFacade()` 等 24+ 方法
  - [x] `main.ts` interactive 路由：`InteractiveMode.fromFacade()` + `createSessionFacade()` 替代旧 `createAgentSessionRuntime()` 路径
  - [x] `applyRuntimeSettings()` / `bindCurrentSessionExtensions()` 双路径（facade + legacy）
  - [x] `setupAutocomplete()` / `setupExtensionShortcuts()` / `getRegisteredToolDefinition()` facade-aware
  - [x] `FooterComponent` 统一为 `FooterSessionInfo` 接口（Phase 5 移除 AgentSession 双路径）
- [x] **4.3 `rpc-mode.ts` / `rpc-client.ts` 迁移**
  - [x] 新增 `runRpcModeWithFacade()`
  - [x] `main.ts --mode rpc` 路由到 `createSessionFacade()` + `runRpcModeWithFacade()`
  - [x] `rpc-client.ts` 的 `onEvent()` 回调接收 TypedEvent
  - [x] 核心命令 + session/stat 命令全部覆盖
  - [x] `compact`（等待 COMPACTION_END）、`bash`/`abort_bash`、`export_html`、`set_auto_retry`/`abort_retry`、queue modes
  - 旧 `runRpcMode()` 保留于向后兼容公共 API

- [x] **4.4 `print-mode.ts` 迁移**
  - [x] 新增 `runPrintModeWithFacade()`，直接订阅 `SessionFacade.subscribe()` 并输出 TypedEvent JSON
  - [x] text 模式从 `SessionProjection.buildContext()` 读取最终 assistant 消息，不依赖旧 `session.state.messages`
  - [x] `main.ts` 简单 print/json 路由切到 `SessionFacade`
        - 已覆盖：默认新会话、`--no-session`、`--continue`、`--resume`、`--fork`、`--session <id|event-session:...>`、自定义 `--session-dir`
  - [x] 移除 `main.ts` 中旧 `runPrintMode()` fallback

- [x] **4.5 测试**
  - [x] 为 ModeEventMapper 编写映射完整性测试
  - [x] headless-integration / session-facade / rpc-facade / print-mode 测试覆盖

### Phase 5: 清理旧代码

**目的**：删除所有被替代的旧代码。

 - [x] **5.1 删除旧运行时层**
   - [x] 删除 `runtime-adapter.ts`
   - [x] 删除 `agent-session-runtime.ts`（仅被 legacy `runPrintMode`/`runRpcMode` 使用）
   - [x] 删除 `event-store-bridge.ts`（仅被 `agent-session-runtime.ts` 使用）
   - 保留 `agent.ts` / `event-sourced-adapter.ts`（公共 API `createAgentSession()` 依赖）
   - 保留域模型类型 `AgentTool` / `AgentMessage` / `AgentState`
 
 - [x] **5.2 删除旧 Session 相关**
   - [x] `agent-session-runtime.ts` 和 `event-store-bridge.ts` 已删除
   - [x] `agent-session-services.ts` 清理：移除 `createAgentSessionFromServices` 及其依赖
   - `agent-session.ts` / `session-manager.ts` 保留于公共 API 向后兼容

- [x] **5.3 消息工厂**
  - [x] `messages.ts` 保留（`convertToLlm` 等仍被 compaction/extensions 使用）

- [x] **5.4 更新 `sdk.ts`**
  - [x] `createSessionFacade()` 纯事件驱动；`createAgentSession()` 保留兼容
  - [x] 移除 `useEventSourcedRuntime` 开关；接入 customTools 和 ExtensionRunner
  - [x] 更新 barrel exports

- [x] **5.5 更新 `main.ts`**
  - [x] 所有模式走 facade 路径，legacy 路径已删除（-309 行）
  - [x] 移除 `canUseFacadePrintRoute()`，直接内联 facade 路径

- [x] **5.6 清理 import 链**
  - [x] interactive-mode / footer 纯 facade；提取 `parseSkillBlock` / `SessionStats` 到独立模块
  - [x] 更新所有 barrel exports（index.ts, core/index.ts, sdk.ts, agent/index.ts, runtime/index.ts）

- [x] **5.7 更新测试**
  - [x] 删除 `runtime-adapter.test.ts`；更新 footer/interactive-mode 测试

- [x] **5.8 interactive-mode.ts 重构**
  - [x] 移除 legacy 构造函数和 `handleEvent` 处理器（~350 行），facade 非可选

- [x] **5.9 footer.ts 重构**
  - [x] 统一为 `FooterSessionInfo` 接口

- [x] **5.10 新增文件**
  - `src/core/skill-block-parser.ts` — `parseSkillBlock` / `ParsedSkillBlock`
  - `src/core/session-stats.ts` — `SessionStats` 接口

### Phase 6: 扩展系统最终适配

**目的**：确保扩展系统在纯事件驱动下工作，保持向后兼容的扩展 API。

**任务**：

- [x] **6.1 ExtensionContext 接口更新**
  - [x] `sessionManager` 已基于 EventStore（`ExtensionSessionManager` 含 `eventStore`/`projection`/`subscribe`）
  - [x] `getContextUsage()` 从 SessionProjection 获取 token 统计

- [x] **6.2 Extension 事件回调**
  - [x] `ExtensionRunner.bindEventStore(store)` 订阅 EventStore 并映射为 ExtensionEvent
  - [x] 所有事件映射已实现：USER_MESSAGE, AGENT_MESSAGE_START/END, TOOL_EXECUTION_START/END, AGENT_TURN_*, MODEL_CHANGED
  - [x] 保持旧的 event shape 不变（扩展代码不需要改）

- [x] **6.3 Extension 的 session 操作**
  - [x] `newSession()` / `fork()` / `switchSession()` 通过 EventSourcedRuntime 事件驱动
  - [x] `navigateTree()` 通过 SessionProjection range 修改

- [x] **6.4 测试**
  - [x] 所有扩展测试通过（63 tests）

### Phase 7: 清理 legacy mode 函数和孤立文件

**目的**：删除所有不再被 main.ts 调用的 legacy mode 函数和由此成为孤立的文件。

**任务**：

- [x] **7.1 删除 legacy mode 函数**
  - [x] 删除 `runPrintMode()`（print-mode.ts，~94 行）
  - [x] 删除 `runRpcMode()`（rpc-mode.ts，~680 行）
  - [x] 更新 modes/index.ts 和 src/index.ts barrel exports

- [x] **7.2 删除孤立文件**
  - [x] 删除 `agent-session-runtime.ts`（仅被 runPrintMode/runRpcMode 使用）
  - [x] 删除 `event-store-bridge.ts`（仅被 agent-session-runtime.ts 使用）

- [x] **7.3 清理 agent-session-services.ts**
  - [x] 移除 `createAgentSessionFromServices()` 函数
  - [x] 移除 `CreateAgentSessionFromServicesOptions` 接口
  - [x] 移除对 `createAgentSession`、`SessionManager`、`ThinkingLevel`、`SessionStartEvent` 的死引用
  - [x] 保留 `createAgentServices()` 和 `AgentSessionServices`（仍被 main.ts 使用）

- [x] **7.4 清理测试文件**
  - [x] 删除 `test/rpc-prompt-response-semantics.test.ts`（测试 runRpcMode）
  - [x] 删除 `test/event-translator-streaming.test.ts`（测试 event-sourced-adapter）
  - [x] 删除 `test/agent-session-runtime-events.test.ts`（测试 agent-session-runtime）
  - [x] 删除 `test/agent-session-branching.test.ts`（测试 agent-session-runtime）
  - [x] 删除 `test/session-cwd.test.ts`（测试 agent-session-runtime）
  - [x] 删除 `test/suite/agent-session-runtime.test.ts`（测试 agent-session-runtime）
  - [x] 删除 `test/suite/regressions/2860-replaced-session-context.test.ts`（测试 agent-session-runtime）
  - [x] 删除 `test/suite/regressions/2753-reload-stale-resource-settings.test.ts`（测试 agent-session-runtime）
  - [x] 更新 `test/print-mode.test.ts`（移除 runPrintMode 测试）
  - [x] 删除 `examples/sdk/13-session-runtime.ts`（演示 agent-session-runtime）

- [x] **7.5 验证**
  - [x] `npm run build` 通过
  - [x] 115 test files, 1169 tests pass

**保留的公共 API 代码**：
 **保留的公共 API 代码**：
 以下文件因 `createAgentSession()` 公共 SDK API 而保留：
 - `agent.ts` + `event-sourced-adapter.ts`（Agent 类）
 - `agent-session.ts`（AgentSession 类）
 - `session-manager.ts`（SessionManager，同时用于 main.ts session picker）
 - `messages.ts`（convertToLlm 被 compaction/extensions/interactive-mode 使用）
 
 ### Phase 8: 废弃 legacy SDK API + 迁移 examples
 
 **目的**：将 `createAgentSession()` 标记为 deprecated，迁移所有 SDK examples 到 `createSessionFacade()`。
 
 **任务**：
 
 - [x] **8.1 废弃 `createAgentSession()`**
   - [x] 添加 `@deprecated` JSDoc 到 `createAgentSession()`, `CreateAgentSessionOptions`, `CreateAgentSessionResult`
   - [x] 指向 `createSessionFacade()` 替代方案
 
 - [x] **8.2 迁移 SDK examples**
   - [x] 全部 12 个 `examples/sdk/*.ts` 从 `createAgentSession()` 迁移到 `createSessionFacade()`
   - [x] 事件订阅从 `AgentEvent` 改为 `TypedEvent`（`AGENT_MESSAGE_CHUNK` 等）
   - [x] `session.state.messages` 改为 `facade.getProjection().buildContext()`
   - [x] `SessionManager.inMemory()` 改为 `storagePath: ':memory:'`
   - [x] 删除 `examples/sdk/13-session-runtime.ts`（演示已删除的 API）
 
 - [x] **8.3 验证**
   - [x] `npm run build` 通过
   - [x] 115 test files, 1169 tests pass
 
 **仍保留的代码**：
 无。所有 legacy API 已删除。
 
 ### Phase 9: 删除 deprecated API 及全部 legacy 代码
 
 **目的**：实现"零 adapter 层"目标。删除 `createAgentSession()`、`Agent` 类、`AgentSession` 类及其全部测试。
 
 **任务**：
 
 - [x] **9.1 删除 legacy 源文件**
   - [x] 删除 `src/core/agent/agent.ts`（Agent 类）
   - [x] 删除 `src/core/agent/event-sourced-adapter.ts`（adapter 层）
   - [x] 删除 `src/core/agent-session.ts`（3000+ 行 AgentSession 类）
 
 - [x] **9.2 清理 sdk.ts**
   - [x] 移除 `createAgentSession()`、`CreateAgentSessionOptions`、`CreateAgentSessionResult`
   - [x] 移除所有 legacy imports（Agent, AgentSession, SessionManager, convertToLlm, etc.）
   - [x] sdk.ts 现在只导出 `createSessionFacade` + tool factories + 类型
 
 - [x] **9.3 更新 barrel exports**
   - [x] `agent/index.ts` 只导出 types（域模型）
   - [x] `src/index.ts` 移除 `CreateAgentSessionOptions` 导出，添加 `createSessionFacade` 导出
 
 - [x] **9.4 更新 main.ts**
   - [x] `CreateAgentSessionOptions` → `CreateSessionFacadeOptions`
   - [x] `scopedModels` 从 session options 移到独立变量
 
 - [x] **9.5 删除 legacy 测试（33 个文件，~8000 行）**
   - [x] 28 个直接使用 AgentSession/Agent/createAgentSession 的测试
   - [x] 5 个依赖已删除 test-harness/utilities 的测试
 
 - [x] **9.6 验证**
   - [x] `npm run build` 通过
   - [x] 90 test files, 986 tests pass
 
 **迁移完成**：所有设计原则已实现。
 1. ✅ EventStore 是唯一真相来源
 2. ✅ Reactor 是唯一执行引擎（Agent 类已删除）
 3. ✅ Projection 替代命令式状态（AgentSession 已删除）
 4. ✅ 零 adapter 层（event-sourced-adapter / event-store-bridge 已删除）
 5. ✅ 扩展接口已重定义

 ---
 
 ## 实际变更统计
 
 | 操作 | 范围 | 数量 |
 |---|---|---|
 | 删除源文件 | `agent.ts`, `event-sourced-adapter.ts`, `agent-session.ts`, `agent-session-runtime.ts`, `event-store-bridge.ts`, `runtime-adapter.ts` | 6 |
 | 重写 | `sdk.ts` (350→35 行), `agent/index.ts` | 2 |
 | 删除测试 | 33 个 legacy test 文件 + 2 个 helper (test-harness.ts, utilities.ts) | ~8000 行 |
 | 迁移 | 12 SDK examples → `createSessionFacade()` | 12 |
 
 ## 架构验证
 
 1. **扩展兼容性**：`ExtensionFactory` 接口签名保持稳定。扩展写法不变。
 2. **性能**：`buildContext()` 查询 EventStore，SQLite 索引 + compaction 截断保证效率。
 3. **compaction 语义**：`COMPACTION_END` 的 `first_kept_event_id` 标记事件范围。
 4. **流式体验**：`AGENT_MESSAGE_CHUNK` 事件延迟取决于 reactor handler 不阻塞。