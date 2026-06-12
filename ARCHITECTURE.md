# Pizza 架构

最后更新：2026-06-11

---

## 1. 架构总览

Pizza 是一个纯事件驱动的 coding agent。EventStore (SQLite) 是唯一的真相来源，Reactor 以 handler 表驱动 agent turn 循环，所有可观测状态从事件流投影得出。

```
┌──────────────────────────────────────────────────────────────┐
│  CLI 入口 (src/cli.ts)                                       │
│  → builtin 命令 / main(args)                                 │
├──────────────────────────────────────────────────────────────┤
│  主编排 (src/main.ts)                                        │
│  参数解析 → createSessionFacade() → 模式路由                 │
├──────────────────────────────────────────────────────────────┤
│  运行模式                                                     │
│  ┌───────────────┬───────────────┬───────────────┐          │
│  │ Interactive   │ RPC           │ Print         │          │
│  │ (TUI)         │ (JSON-RPC)    │ (单次)        │          │
│  └───────┬───────┴───────┬───────┴───────┬───────┘          │
│          └───────────────┼───────────────┘                   │
│                          │ ModeEvent                         │
│  ┌───────────────────────▼────────────────────┐              │
│  │  ModeEventMapper                           │              │
│  │  TypedEvent → ModeEvent (19 种 UI 动作)    │              │
│  └───────────────────────┬────────────────────┘              │
├──────────────────────────┼───────────────────────────────────┤
│  SessionFacade (轻量门面) │                                   │
│  ├ prompt / steer / followUp / abort / compact              │
│  ├ subscribe → EventStore 事件流                             │
│  └ 持有 EventSourcedRuntime, ExtensionRunner, Settings      │
├──────────────────────────┼───────────────────────────────────┤
│  EventSourcedRuntime ────┘                                   │
│  ├ 持有 EventStore (SQLite)                                  │
│  ├ 持有 Reactor（turn 循环引擎）                              │
│  ├ 持有 SessionProjection（上下文构建）                       │
│  ├ 持有 SessionManager（会话描述管理）                        │
│  ├ 持有 IntentExecutor + Classifier                          │
│  └ 持有 CompactionEngine                                     │
├──────────────────────────────────────────────────────────────┤
│           ┌─────────────┼──────────────┐                     │
│           ▼             ▼              ▼                     │
│     ┌───────────┐ ┌───────────┐ ┌───────────────┐           │
│     │ EventStore│ │  Reactor  │ │  Projections  │           │
│     │ (SQLite)  │ │ (handler  │ │  session      │           │
│     │           │ │   table)  │ │  timeline     │           │
│     └───────────┘ └───────────┘ │  goal         │           │
│                                 │  event-to-msg │           │
│                                 └───────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **EventStore 是唯一真相来源** — 所有状态从事件流投影得出
2. **Reactor 是唯一执行引擎** — handler 表驱动一切，无 while-loop
3. **Projection 替代命令式状态** — 不存在 `state.messages` 数组
4. **零 adapter 层** — 消费方直接订阅 TypedEvent
5. **扩展接口稳定** — 扩展系统内部订阅 EventStore，但 API 保持不变

---

## 2. 核心事件流（Reactor Turn Cycle）

```
USER_MESSAGE
    │
    ▼
[_onUserMessage] → AGENT_TURN_REQUESTED
    │
    ▼
[_onAgentTurnRequested] → buildContext() → AGENT_TURN_START → LLM_CALL_REQUESTED
    │
    ▼
[_onLlmCallRequested] → AGENT_MESSAGE_START → await LLM → AGENT_MESSAGE_CHUNK* → AGENT_MESSAGE_END
    │
    ▼
[_onAgentMessageEnd]
    ├─ stop_reason ≠ "tool_use" → AGENT_TURN_END → AGENT_TURN_COMPLETED
    │
    └─ stop_reason = "tool_use" → INTENT_TOOL_CALL × N
         │
         ▼
    [_onIntentToolCall] → classify → approval gate → TOOL_EXECUTION_START/END
         │
         ▼
    [_onToolExecutionEnd] → FILE_MUTATION_APPLIED → join tracker → TOOL_RESULTS_AGGREGATED
         │
         ▼
    [_onToolResultsAggregated] → AGENT_TURN_END → AGENT_TURN_REQUESTED  ← 循环回
         │
         ▼
    [_onAgentTurnCompleted]
         ├─ followUpQueue? → USER_MESSAGE ──→ 循环回顶部
         ├─ error? → RETRY_SCHEDULED → 延时后重新进入 AGENT_TURN_REQUESTED
         ├─ compaction needed? → COMPACTION_REQUESTED
         └─ idle → reactor settles，prompt() Promise resolve
```

---

## 3. 分层详解

### 3.1 EventStore (`src/core/event-store/`)

Append-only 事件存储，按 workspace 分库。

| 文件 | 行数 | 用途 |
|---|---|---|
| `types.ts` | 173 | EventBase、EventType（53 种事件类型）、支持类型 |
| `events.ts` | 583 | 每种事件的具体 payload 接口 |
| `store.ts` | 117 | EventStore 接口（append/subscribe/query/getCausalChain） |
| `sqlite-store.ts` | 330 | SQLite 实现，UUIDv7 event_id，同步通知 subscriber |
| `workspace.ts` | 85 | workspace ID 推导、路径计算 |

**事件类型分类（53 种）**：

| 类别 | 事件 |
|---|---|
| 用户 (6) | USER_MESSAGE, USER_APPROVAL, USER_REJECTION, USER_INTERRUPT, USER_FOLLOWUP_QUEUED, USER_CONFIG_CHANGE |
| Agent (8) | AGENT_THINKING_START/END, AGENT_MESSAGE_START/CHUNK/END, AGENT_TURN_START/END, AGENT_ERROR |
| Intent (3) | INTENT_TOOL_CALL, INTENT_FILE_EDIT, INTENT_COMMAND_EXEC |
| 执行 (7) | TOOL_EXECUTION_START/UPDATE/END, FILE_MUTATION_APPLIED, BASH_EXECUTION, CUSTOM_MESSAGE, BRANCH_SUMMARY |
| 会话 (4) | SESSION_CREATED, SESSION_BOUNDARY_INFERRED, SESSION_FORKED, SESSION_ENTRY_APPENDED |
| Compaction (4) | COMPACTION_REQUESTED/START/END/ABORTED |
| 运行时 (10+) | RUNTIME_STARTED/PAUSED/RESUMED, MODEL_CHANGED, THINKING_LEVEL_CHANGED, RUNTIME_ERROR, CHECKPOINT_*, RETRY_* |
| Goal/Task (13) | GOAL_CREATED..CANCELLED, TASK_CREATED..CANCELLED |

### 3.2 Reactor (`src/core/runtime/reactor.ts`, 1117 行)

事件驱动 turn 循环引擎。14 个 handler 函数替代传统 while-loop。

**关键机制**：
- **TurnTracker** — join-pattern，追踪并行工具执行，所有工具完成后才发 TOOL_RESULTS_AGGREGATED
- **followUpQueue** — 跟进消息队列，turn 完成后自动 drain
- **retryTimers** — 重试计时器，支持指数退避和用户取消
- **因果链遍历** — 通过 `store.getCausalChain()` 追溯重试次数、定位 assistant message
- **并发 guard** — `_isProcessing` 防止并发 prompt，steer/followUp 是唯一允许的排队操作

### 3.3 EventSourcedRuntime (`src/core/runtime/runtime.ts`, 589 行)

组装 store + reactor + projection 的运行时容器。

**核心 API**：
- `prompt(text, images?)` — 创建 Reactor → 追加 USER_MESSAGE → waitUntilSettled
- `steer(text)` → USER_INTERRUPT
- `followUp(text)` → USER_FOLLOWUP_QUEUED
- `abort()` → USER_INTERRUPT + reactor.interrupt()
- `compact()` → COMPACTION_REQUESTED
- `subscribe(handler)` → EventStore.subscribe()
- `setModel() / setThinkingLevel()` → 配置变更 + 事件

**Reactor 生命周期**：每次 `prompt()` 创建新 Reactor，完成后销毁。EventStore 跨 prompt 持久。

### 3.4 Projections (`src/core/projection/`)

从事件流构建物化视图。

| 文件 | 行数 | 用途 |
|---|---|---|
| `session-projection.ts` | 303 | 从事件查询构建 LLM 上下文（`buildContext()`） |
| `event-to-message.ts` | 305 | 8 种事件 → `AgentMessage[]` 转换 |
| `timeline-projection.ts` | 363 | 时间线视图，支持分页查询 |
| `session-manager.ts` | 317 | 会话描述 CRUD（create/fork/switch/list） |
| `goal-projection.ts` | 361 | 目标/任务状态追踪 |
| `boundary-inferrer.ts` | 168 | 会话边界推断 |

**Compaction 语义**：`COMPACTION_END.first_kept_event_id` 标记裁剪点。旧事件不删除，投影查询时跳过。

### 3.5 IntentSystem (`src/core/intent/`)

工具执行的安全门。

| 文件 | 行数 | 用途 |
|---|---|---|
| `classifier.ts` | 264 | 按工具名/参数分类风险等级（file_read→file_delete, shell_safe→shell_dangerous） |
| `executor.ts` | 326 | 唯一授权执行变更的组件，审批门 → 执行 → 记录文件变更 |
| `tool-adapter.ts` | 180 | AgentTool 桥接到 ToolExecutor 接口 |

### 3.6 SessionFacade (`src/core/session-facade.ts`, 141 行)

轻量门面，modes 和扩展的唯一交互入口。不持有 transcript state。

**持有**：EventSourcedRuntime, SettingsManager, ExtensionRunner（可选）, ModelRegistry（可选）, ResourceLoader（可选）

**工厂**：`createSessionFacade()` (`session-facade-factory.ts`, 586 行) 组装所有组件。

### 3.7 CompactionEngine (`src/core/compaction/compaction-engine.ts`, 356 行)

实现 `CompactionPolicy` 接口：
- 阈值触发：token 超过 `context_window × threshold`（默认 75%）
- 溢出强制：超过 context_window 时强制压缩
- 使用 LLM 生成摘要，支持增量更新

### 3.8 扩展系统 (`src/core/extensions/`)

| 文件 | 行数 | 用途 |
|---|---|---|
| `types.ts` | 1534 | 扩展 API 类型定义 |
| `runner.ts` | 1154 | 扩展生命周期管理，订阅 EventStore 映射为 ExtensionEvent |
| `loader.ts` | 618 | jiti 动态加载扩展 |
| `session-context.ts` | 297 | 基于 EventStore 的 ExtensionSessionManager |

扩展 API 保持向后兼容。扩展代码无需修改即可运行。

---

## 4. 运行模式

### 4.1 InteractiveMode (`src/modes/interactive/interactive-mode.ts`, 5153 行)

TUI 界面，基于 `@mariozechner/pi-tui`。通过 `SessionFacade.subscribe()` + `ModeEventMapper` 订阅事件。

### 4.2 RPC Mode (`src/modes/rpc/`, 519+521 行)

JSON-RPC over stdio。支持 prompt/abort/compact/bash/export_html 等命令。

### 4.3 Print Mode (`src/modes/print-mode.ts`, 133 行)

单次执行。text 模式输出最终 assistant 文本，json 模式输出事件流 JSON。

### 4.4 ModeEventMapper (`src/modes/event-mapper.ts`, 248 行)

TypedEvent → 19 种 ModeEvent 的映射层，替代旧的 AgentEvent switch-case。

---

## 5. 工具系统 (`src/core/tools/`)

6 个内置工具定义，每个包含 LLM schema + 执行逻辑：

| 工具 | 文件 | 行数 |
|---|---|---|
| bash | `bash.ts` | 485 |
| edit | `edit.ts` | 487 |
| find | `find.ts` | 545 |
| grep | `grep.ts` | 384 |
| ls | `ls.ts` | 229 |
| read | `read.ts` | 273 |
| write | `write.ts` | 281 |

通过 `createToolRegistry()` 注册到 IntentExecutor。

---

## 6. 外部依赖

核心运行时依赖：
- `@mariozechner/pi-ai` — LLM 协议层（streamSimple, Provider, Model）
- `@mariozechner/pi-tui` — TUI 渲染
- `@mariozechner/jiti` — 扩展加载
- `@sinclair/typebox` — 工具参数 schema

---

## 7. 关键文件索引

| 文件 | 用途 |
|---|---|
| `src/cli.ts` | CLI 入口 |
| `src/main.ts` | 主编排 |
| `src/core/sdk.ts` | 公共 SDK（createSessionFacade + tool factories） |
| `src/core/session-facade.ts` | SessionFacade 门面 |
| `src/core/session-facade-factory.ts` | SessionFacade 工厂 |
| `src/core/runtime/runtime.ts` | EventSourcedRuntime |
| `src/core/runtime/reactor.ts` | Reactor (turn 循环引擎) |
| `src/core/event-store/sqlite-store.ts` | EventStore SQLite 实现 |
| `src/core/event-store/events.ts` | 事件 payload 定义 |
| `src/core/projection/session-projection.ts` | LLM 上下文构建 |
| `src/core/projection/event-to-message.ts` | 事件 → 消息转换 |
| `src/core/intent/executor.ts` | IntentExecutor（唯一变更执行器） |
| `src/core/compaction/compaction-engine.ts` | CompactionEngine |
| `src/core/extensions/runner.ts` | ExtensionRunner |
| `src/modes/event-mapper.ts` | TypedEvent → ModeEvent 映射 |
| `src/modes/interactive/interactive-mode.ts` | 交互模式 TUI |
