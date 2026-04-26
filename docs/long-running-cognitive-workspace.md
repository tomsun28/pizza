# 长期运行认知工作空间方案

> 面向当前 `pizza` 项目的下一阶段架构设计。
>
> 目标不是把现有 CLI Agent 改成更复杂的聊天机器人，而是把它演进为基于 Event-Sourced Runtime 的、可恢复、可回放、可分支、可观测、可长期调度的认知工作空间系统。

---

## 1. 背景与判断

当前项目已经具备 Coding Agent 的基础能力：

- CLI / TUI / Print / RPC 多种交互入口。
- `AgentSession` 管理一次 agent 运行过程。
- `SessionManager` 以 JSONL session tree 保存对话历史。
- Tool execution、compaction、extension、skills、settings、model resolver 等能力已经成型。
- 新增的 `src/core/event-store/*`、`src/core/projection/*`、`src/core/intent/*`、`src/core/runtime/*` 已经开始引入 Event-Sourced Runtime。
- `src/core/event-store-bridge.ts` 已经把旧 `AgentSession` 事件桥接到新的 EventStore，说明项目当前处于双轨迁移阶段。

现有系统的核心问题不是单点功能缺失，而是运行时事实源仍然分散：

- Session JSONL 仍承担历史事实源职责。
- Agent 推理、工具执行、UI 状态、文件 mutation、compaction 之间缺少统一因果链。
- Runtime 仍与本地执行环境、AgentSession 生命周期、工具实现强耦合。
- 长程任务只能依赖单个上下文不断压缩，缺少 Goal 级调度、阶段隔离、验收返工循环。
- UI 看到的是消息流，而不是完整可观测的活动时间线。

因此下一阶段的架构重心应从 Prompt / Tool 优化，提升到 Runtime Architecture、Event Architecture、Context Architecture 和 Brain / Runtime Separation。

---

## 2. 设计目标

系统需要支持：

- 长期运行：任务可跨小时、天、周推进。
- 可恢复：进程退出、机器重启、远端迁移后可继续执行。
- 可回放：从事件日志重建状态、上下文、工具结果和关键推理过程。
- 可分支：从任意事件点 fork 出新 session / task / workspace branch。
- 本地 / 云端统一运行：同一 Brain 面向不同 Runtime。
- Runtime 与 Agent Brain 解耦：Brain 负责认知，Runtime 负责确定性执行。
- 可观测：生产运行中的 agent 不是黑盒，用户和系统都能看到因果链、状态、进度和失败原因。
- 长程调度：Goal 驱动，多 session、多角色 agent、睡眠唤醒、被动触发、验收返工。
- 可扩展：为 Skills、MCP、插件、自学习技能、环境事件总线留下稳定 hook。

明确不以以下形态为目标：

- 聊天机器人 + Tool 调用。
- 单个 chat container 承载全部历史。
- 让 LLM 直接操作系统并把结果附着在对话消息里。

目标形态是：

> 持续运行的认知工作空间系统。

---

## 3. 核心原则

### 3.1 Event Log 是事实源

所有可观测状态都必须能够从 append-only event log 推导：

- 用户输入与审批。
- Agent 推理边界、消息、计划、决策。
- Tool intent、审批、执行开始、执行结果。
- 文件修改、命令执行、sandbox 状态。
- Memory 更新、Skill 学习、Goal 状态变化。
- Runtime 生命周期、checkpoint、恢复、迁移。

Session、Task、Goal、Memory、Timeline 都是 Event Log 的投影或索引，不是事实源。

### 3.2 Session 是认知投影视图

传统：

```text
Session = 数据容器 + 对话历史
```

目标：

```text
Session = query(EventLog, boundary/filter) 得到的认知阶段视图
```

Session 只保存引用：

```json
{
  "session_id": "sess_1",
  "workspace_id": "ws_123",
  "event_range": {
    "start_event_id": "evt_1000",
    "end_event_id": "evt_1100"
  },
  "summary_event_id": "evt_summary_12",
  "checkpoint_id": "ckpt_9"
}
```

### 3.3 Brain 与 Runtime 解耦

```text
Agent Brain = LLM + Prompt + Context + Planning + Decision Making
Agent Runtime = Tool Execution + Workspace State + Sandbox + Checkpoint
```

原则：

- Brain 不直接操作系统。
- Runtime 不负责推理。
- Brain 只产出 intent。
- Runtime 对 intent 做权限、确定性执行、记录和回放。

### 3.4 Runtime > Prompt

Prompt 仍然重要，但长期运行系统的可靠性来自：

- Event-sourced state。
- 确定性 Runtime。
- 可恢复 checkpoint。
- 可裁剪 context projection。
- Goal / Session 生命周期。
- 工具执行与文件 mutation 的可验证记录。

---

## 4. 当前项目基线

### 4.1 已有模块

当前仓库里已经存在以下基础：

| 能力 | 当前文件 | 现状 |
| --- | --- | --- |
| Event schema | `src/core/event-store/types.ts` | 已定义 `EventBase`、`EventType`、actor、payload 基础类型 |
| EventStore 接口 | `src/core/event-store/store.ts` | 已支持 append、query、latest、subscribe、causal chain |
| JSONL EventStore | `src/core/event-store/jsonl-store.ts` | 已支持按日 JSONL 文件、内存索引、实时订阅 |
| Workspace id | `src/core/event-store/workspace.ts` | 已基于 cwd 派生 workspace id |
| Event bridge | `src/core/event-store-bridge.ts` | 已将旧 AgentSession 事件并行写入 EventStore |
| Session Projection | `src/core/projection/session-projection.ts` | 已从 EventStore 构建 LLM context 和 timeline |
| Session Manager | `src/core/projection/session-manager.ts` | 已管理 session descriptor，而不是直接保存消息 |
| Boundary Inferrer | `src/core/projection/boundary-inferrer.ts` | 已具备 session boundary 推断入口 |
| Intent Layer | `src/core/intent/*` | 已有 intent classifier、executor、approval flow |
| EventSourcedRuntime | `src/core/runtime/runtime.ts` | 已初步组装 Store + Projection + IntentExecutor + AgentLoop |
| Legacy Runtime | `src/core/agent-session-runtime.ts` | 仍是当前主运行路径，并通过 bridge 写 EventStore |

### 4.2 当前差距

已有架构方向正确，但距离“持续运行认知工作空间”还缺少：

- SQLite EventStore：当前 JSONL 适合早期验证，但不适合复杂寻址、索引、关联查询和长期数据治理。
- 完整因果链：bridge 写入的旧事件目前缺少稳定 `caused_by` 关联。
- Deterministic intent replay：工具执行结果已经记录，但仍未形成可完整 replay 的执行事务模型。
- Checkpoint system：缺少 workspace state、runtime state、sandbox state 的 checkpoint / restore。
- Goal system：尚无 Goal、Task、Subtask、Reviewer、Tester 等长程调度实体。
- Runtime abstraction：当前 `EventSourcedRuntime` 仍偏本地进程内组装，缺少 Local / Cloud / Container Runtime 统一接口。
- Tool 基座优化：read / edit / search / bash 仍需要围绕行号、hash、patch、token 效率重构。
- UI projection：Event timeline 尚未成为 TUI / RPC / GUI 的第一等数据源。
- Memory / Skill 自学习：已有 skills 系统，但缺少事件化 memory 与自学习 skill agent。

---

## 5. 目标架构

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         Interaction Layer                           │
│      CLI / TUI / GUI / RPC / Web / Feishu / Weixin / Webhook         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ external events
┌───────────────────────────────▼─────────────────────────────────────┐
│                          Event System                               │
│       SQLite EventStore + Event Bus + Subscription + Indexes         │
│                 append-only / causal / replayable                    │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │ query/project                  │ append
┌───────────────▼──────────────┐       ┌────────▼─────────────────────┐
│          Projections          │       │           Runtime             │
│ Session / Task / Goal / UI    │       │ Local / Cloud / Container     │
│ Memory / Timeline / Metrics   │       │ Tool / Sandbox / Checkpoint   │
└───────────────┬──────────────┘       └────────┬─────────────────────┘
                │ context                         │ deterministic result
┌───────────────▼──────────────────────────────────▼──────────────────┐
│                           Agent Brain                               │
│      Planner / Coder / Reviewer / Tester / Skill Learner             │
│             LLM + Prompt + Context Projection + Policy               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Event System

### 6.1 Event Schema

当前 `EventBase` 可作为第一版基础，但需要补充 sequence、schema version、trace 和 idempotency 字段，便于 SQLite 索引、跨 runtime 同步和 replay。

```ts
interface EventBase {
  event_id: string;          // UUIDv7
  sequence: number;          // workspace 内单调递增
  workspace_id: string;
  runtime_id: string;
  actor_id: string;
  timestamp: number;
  type: EventType;
  payload: unknown;
  caused_by?: string;
  correlation_id?: string;   // 一次用户请求 / goal tick / webhook 的 trace
  session_hint?: string;
  schema_version: number;
  idempotency_key?: string;  // 重试写入去重
}
```

### 6.2 SQLite 存储

建议从当前 JSONL EventStore 迁移到 SQLite 主存储，JSONL 保留为 export / debug / append mirror。

```sql
create table events (
  sequence integer primary key autoincrement,
  event_id text not null unique,
  workspace_id text not null,
  runtime_id text not null,
  actor_id text not null,
  timestamp integer not null,
  type text not null,
  payload_json text not null,
  caused_by text,
  correlation_id text,
  session_hint text,
  schema_version integer not null default 1,
  idempotency_key text
);

create index idx_events_workspace_sequence
  on events(workspace_id, sequence);

create index idx_events_workspace_type_sequence
  on events(workspace_id, type, sequence);

create index idx_events_caused_by
  on events(caused_by);

create index idx_events_correlation
  on events(correlation_id);
```

### 6.3 Event 类型分层

第一阶段保留当前 `EventType`，第二阶段扩展为以下域：

| 域 | 代表事件 |
| --- | --- |
| User | `USER_MESSAGE`、`USER_APPROVAL`、`USER_INTERRUPT` |
| Brain | `AGENT_TURN_START`、`AGENT_PLAN_UPDATED`、`AGENT_DECISION_MADE` |
| Intent | `INTENT_TOOL_CALL`、`INTENT_FILE_EDIT`、`INTENT_COMMAND_EXEC` |
| Runtime | `RUNTIME_STARTED`、`RUNTIME_PAUSED`、`RUNTIME_RESUMED`、`RUNTIME_ERROR` |
| Tool | `TOOL_STARTED`、`TOOL_COMPLETED`、`TOOL_FAILED` |
| Workspace | `FILE_READ`、`FILE_PATCH_APPLIED`、`COMMAND_EXECUTED` |
| Checkpoint | `CHECKPOINT_CREATED`、`CHECKPOINT_RESTORED` |
| Session | `SESSION_CREATED`、`SESSION_BOUNDARY_INFERRED`、`SESSION_FORKED` |
| Goal | `GOAL_CREATED`、`GOAL_PLANNED`、`GOAL_TICK_STARTED`、`GOAL_COMPLETED` |
| Task | `TASK_CREATED`、`TASK_ASSIGNED`、`TASK_REVIEWED`、`TASK_ACCEPTED` |
| Memory | `MEMORY_EXTRACTED`、`MEMORY_UPDATED`、`MEMORY_RETRIEVED` |
| Skill | `SKILL_DISCOVERED`、`SKILL_CREATED`、`SKILL_UPDATED`、`SKILL_USED` |
| Environment | `WEBHOOK_RECEIVED`、`SCHEDULE_FIRED`、`API_REQUESTED` |

### 6.4 事件写入边界

所有副作用必须遵守：

```text
Intent event -> approval/risk policy -> execution start -> deterministic side effect -> execution end -> optional projection update
```

禁止 Brain 或 UI 绕过 Runtime 直接修改 workspace state。

---

## 7. Runtime 抽象层

### 7.1 Runtime Interface

目标是让同一个 Brain 能跑在 Local Runtime、Cloud Runtime、Container Runtime 上。

```ts
interface Runtime {
  readonly runtime_id: string;
  readonly workspace_id: string;
  readonly kind: "local" | "cloud" | "container";

  executeTool(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
  createCheckpoint(request: CheckpointRequest): Promise<CheckpointRef>;
  restoreCheckpoint(ref: CheckpointRef): Promise<void>;
  getStatus(): Promise<RuntimeStatus>;
  subscribeEvents(after?: string): AsyncIterable<EventBase>;
}
```

### 7.2 Runtime 职责

Runtime 负责：

- 工具执行。
- 文件系统与 workspace state。
- Shell / process / sandbox。
- 权限审批执行点。
- Checkpoint / restore。
- Runtime 状态上报。
- 本地 / 远端执行环境差异屏蔽。

Runtime 不负责：

- 任务规划。
- Prompt 组织。
- 选择下一步认知策略。
- Memory 语义判断。

### 7.3 当前项目落点

短期实现上：

- 将 `src/core/runtime/runtime.ts` 的 `EventSourcedRuntime` 拆成 Brain-facing orchestrator 与 `RuntimeAdapter`。
- 将 `IntentExecutor` 的工具执行能力下沉到 `LocalRuntimeAdapter`。
- 保留 `AgentSessionRuntime` 作为 legacy adapter，直到 EventSourcedRuntime 接管主路径。

---

## 8. Brain 层

Brain 是认知层，包含：

- Planner：把 Goal 拆成阶段和任务。
- Coder：完成具体 coding / edit / shell 工作。
- Reviewer：基于事件、diff、测试结果做验收。
- Tester：独立构造测试、运行测试、解释失败。
- Memory Agent：从事件中抽取长期记忆。
- Skill Learner：识别可复用流程并生成 / 更新 skill。

Brain 的输出不应是“直接执行”，而是：

```ts
type BrainOutput =
  | { type: "message"; content: ContentBlock[] }
  | { type: "intent"; intent: ToolIntent | FileEditIntent | CommandIntent }
  | { type: "plan"; goal_id: string; tasks: TaskSpec[] }
  | { type: "memory_update"; candidates: MemoryCandidate[] }
  | { type: "sleep"; wake_at: number; reason: string };
```

---

## 9. Session System

### 9.1 Session 定义

Session 是系统推断出的任务认知区间，用于：

- 限制 context drift。
- 稳定 reasoning focus。
- 控制 attention window。
- 为 Goal 生命周期提供阶段性边界。
- 为回放、fork、验收提供结构化视图。

### 9.2 Boundary Inference

当前 `SessionBoundaryInferrer` 可继续扩展。推断依据：

- Intent shift：用户目标或任务类型明显变化。
- Idle time：长期空闲后重新触发。
- Cognitive load：上下文复杂度、token 压力、工具调用密度升高。
- File drift：操作文件集合变化过大。
- Goal phase：规划、实现、测试、验收、返工等阶段切换。

### 9.3 Projection 输出

一个 SessionProjection 应至少能输出：

- LLM context。
- UI timeline。
- 文件活动摘要。
- 工具调用摘要。
- 当前风险和未完成审批。
- 与 Goal / Task 的关联。

---

## 10. Goal 与长程任务

### 10.1 Goal 生命周期

长程任务不应在单个上下文中一直跑，而应以 Goal 为顶层驱动。

```text
GOAL_CREATED
  -> GOAL_CLASSIFIED(long_running=true)
  -> GOAL_PLANNED
  -> TASK_CREATED...
  -> SESSION_CREATED(phase=planning)
  -> SESSION_CREATED(phase=implementation)
  -> SESSION_CREATED(phase=testing)
  -> SESSION_CREATED(phase=review)
  -> TASK_ACCEPTED / TASK_REWORK_REQUESTED
  -> GOAL_COMPLETED
```

### 10.2 多 Session / 多 Agent 验收返工

建议内置如下角色：

| 角色 | 职责 |
| --- | --- |
| Planner Agent | 拆解 Goal，生成任务图和验收标准 |
| Worker Agent | 在 workspace session 中完成具体任务 |
| Test Agent | 独立运行测试、补充测试、复现问题 |
| Review Agent | 代码审查、检查需求覆盖、判断是否返工 |
| Memory Agent | 在阶段结束后沉淀长期记忆 |
| Skill Agent | 判断是否生成 / 更新可复用 skill |

这些 agent 不需要一直运行，而是由事件触发：

- 用户输入。
- 定时器。
- webhook。
- 文件变更。
- 上一个 task 完成。
- reviewer 请求返工。
- sleep 到期。

### 10.3 Goal Storage

Goal 也不保存完整运行数据，只保存引用和状态索引：

```json
{
  "goal_id": "goal_1",
  "workspace_id": "ws_123",
  "status": "running",
  "root_event_id": "evt_100",
  "task_refs": ["task_1", "task_2"],
  "active_session_id": "sess_3",
  "acceptance_event_id": "evt_900"
}
```

事实仍在 EventStore 中。

---

## 11. Checkpoint System

### 11.1 Checkpoint 内容

Checkpoint 需要覆盖：

- Workspace state：文件树、git commit / diff、未跟踪文件、关键二进制产物 hash。
- Runtime state：运行中进程、环境变量、cwd、sandbox 配置。
- EventStore head：checkpoint 对应的事件点。
- Session / Goal projection refs。
- Tool execution state：长命令、后台任务、pending approval。

### 11.2 Checkpoint 策略

建议分层：

- Git-backed checkpoint：适合 coding workspace，使用临时 commit / patch bundle。
- File snapshot checkpoint：适合非 git workspace。
- Runtime metadata checkpoint：保存进程、sandbox、pending task。
- Remote checkpoint：云端运行时上传 artifact bundle。

### 11.3 事件模型

```text
CHECKPOINT_REQUESTED
CHECKPOINT_CREATED
CHECKPOINT_RESTORE_REQUESTED
CHECKPOINT_RESTORED
CHECKPOINT_FAILED
```

Checkpoint ref 进入 SessionDescriptor / GoalDescriptor，支持从任务阶段恢复。

---

## 12. 基础工具优化

基础工具是长期运行系统的“手眼脚”，应优先优化 token 效率、确定性和可回放性。

### 12.1 Read

目标：

- 返回行号。
- 返回行 hash。
- 支持范围读取。
- 支持结构化 metadata。
- 支持大文件摘要 + 精读二段式。

示例输出：

```json
{
  "file": "src/core/runtime/runtime.ts",
  "range": [1, 120],
  "lines": [
    { "n": 1, "hash": "h1", "text": "import ..." }
  ],
  "file_hash": "sha256:..."
}
```

### 12.2 Edit

目标：

- 替换当前字符串原始匹配模式。
- 改为基于行号 + 行 hash + file hash 的 patch。
- 支持文件不存在时创建文件。
- 替代 Write，统一 mutation 入口。
- 每次 edit 产出 `FILE_PATCH_APPLIED` 事件。

Patch 请求：

```json
{
  "file": "src/foo.ts",
  "base_file_hash": "sha256:...",
  "ops": [
    {
      "type": "replace",
      "start_line": 10,
      "end_line": 14,
      "start_hash": "h10",
      "end_hash": "h14",
      "content": "..."
    }
  ]
}
```

### 12.3 Search / Glob

目标：

- 文件搜索和内容搜索统一进入 CLI-first 工具。
- 内容搜索返回文件、行号、行 hash、上下文窗口。
- 搜索结果可直接作为 Edit 的定位依据。

### 12.4 Bash

目标：

- 强化 CLI bash 作为基础能力。
- 将 web search、web reader、package inspection 等能力逐步内置为 bash 可调用能力或 Runtime tool plugin。
- 每次命令执行记录：
  - command。
  - cwd。
  - env allowlist。
  - exit code。
  - stdout / stderr 摘要与 artifact ref。
  - duration。
  - 是否产生文件 mutation。

---

## 13. Memory 与 Skill 自学习

### 13.1 Memory

Memory 不应是简单聊天摘要，应从事件中抽取结构化节点：

- 用户偏好。
- 项目约定。
- 常用命令。
- 长期目标。
- workspace 事实。
- 错误经验。
- 决策记录。

Memory 写入必须事件化：

```text
MEMORY_EXTRACTED -> MEMORY_APPROVED(optional) -> MEMORY_UPDATED
```

个人助理可以跨 workspace 使用长期 memory；workspace agent 只拿必要最小上下文。

### 13.2 Skill 自学习

Skill Agent 在任务后检查：

- 是否出现重复操作序列。
- 是否有稳定的领域流程。
- 是否有可沉淀的命令、脚本、prompt、检查清单。
- 现有 skill 是否需要更新。

事件：

```text
SKILL_REUSE_CANDIDATE_DETECTED
SKILL_CREATED
SKILL_UPDATED
SKILL_USED
```

当 skills / MCP 数量很大时，默认不全量塞进 prompt，而是：

- 建立 skill index。
- 根据任务意图做搜索发现。
- 超过阈值自动切换到 retrieval 模式。
- 只注入被选中 skill 的必要 instruction。

---

## 14. 环境多感知事件总线

Agent 触发源从“人发消息”扩展为统一事件：

- 人对话。
- API 调用。
- 定时任务。
- agent sleep / wake。
- webhook。
- 外部系统回调。
- 文件变更。
- CI / test result。
- 远端 workspace 状态变化。

所有触发统一进入 EventStore：

```text
EXTERNAL_EVENT_RECEIVED
SCHEDULE_FIRED
WEBHOOK_RECEIVED
AGENT_WAKE_REQUESTED
```

Runtime 根据事件决定是否启动对应 Brain tick。

---

## 15. 交互形态

底层使用同一套 Runtime / Memory / Event 架构，上层交互可以不同。

### 15.1 Workspace Agent

面向具体项目 / 任务：

- 生命周期较短。
- 与 workspace 强绑定。
- 上下文精简、专注交付。
- UI 以 Task 为核心，而不是聊天历史。
- 右侧展示当前 task 的事件时间线。
- 展示 runtime status，本地 / 远程 / container 状态清晰可见。
- 支持一键进入对应 shell 环境。
- 支持任务进度、todo list、验收状态。

### 15.2 个人助理 Agent

作为特殊 workspace：

- 长期存在。
- 记住用户、偏好、长期目标。
- 管理多个 workspace。
- 跨 workspace reasoning。
- 可以通过 CLI、GUI、RPC、Web、飞书、微信等入口交互。
- 定时执行“每日梦境”：把日常交互和 workspace 历史沉淀为长期 memory。
- 当任务变专业或需要文件操作时，主动创建 / 跳转 workspace agent。

---

## 16. 可观测性

生产中的 Agent 不能是黑盒。UI / RPC 应基于 Event Projection 提供：

- 当前 runtime 状态。
- 当前 Goal / Task / Session。
- 活动时间线。
- 工具调用输入输出摘要。
- 文件变更 diff。
- checkpoint 列表。
- pending approval。
- 错误事件与 retry 链路。
- token、cost、duration、tool latency。
- causality graph：某次修改由哪个用户输入、哪个 plan、哪个 tool call 导致。

EventStore 的订阅能力应成为 UI 更新的主通道。

---

## 17. 与当前代码的落地路线

### Phase 0：稳定双轨桥接

目标：确保旧系统运行不受影响，同时完整收集事件。

工作项：

- 完善 `EventStoreBridge` 的 `caused_by` 链。
- 为 tool start / end 增加 duration、arguments hash、result hash。
- 为 user message 记录 raw input、images、session file ref。
- 为 legacy session id 写入 `session_hint`。
- 补齐 bridge 单测，确保 bridge 异常不影响主流程。

### Phase 1：SQLite EventStore

目标：把 EventStore 从验证用 JSONL 升级为可长期寻址的事实源。

工作项：

- 新增 `src/core/event-store/sqlite-store.ts`。
- 保持 `EventStore` 接口不变，新增 sequence 查询。
- 增加 migration：JSONL -> SQLite。
- 增加 export：SQLite -> JSONL。
- 将 `JsonlEventStore` 降级为 mirror / debug backend。
- 更新测试覆盖 query、subscribe、causal chain、idempotency。

### Phase 2：Session Projection 接管上下文

目标：Session 不再保存消息历史，而是由 EventStore projection 构建上下文。

工作项：

- 将当前 `AgentSession` 的 context build 接入 `SessionProjection.buildContext()`。
- 将 compaction 输出写为 `COMPACTION_END` event，并由 projection 注入。
- Session tree 的 fork 迁移为 event range fork。
- TUI / RPC session list 改读 session descriptor + timeline projection。

### Phase 3：Runtime Adapter

目标：建立 Local / Cloud / Container 统一 Runtime 抽象。

工作项：

- 新增 `src/core/runtime/types.ts` 定义 `RuntimeAdapter`。
- 将 `IntentExecutor` 的工具执行依赖改为 adapter。
- 实现 `LocalRuntimeAdapter`。
- 将 shell、file edit、search、read 的执行结果标准化为 runtime events。
- 预留 `CloudRuntimeAdapter` / `ContainerRuntimeAdapter`。

### Phase 4：Tool 基座重构

目标：提高 token 效率和 patch 准确性。

工作项：

- Read 返回行号、行 hash、file hash。
- Edit 支持 line/hash patch，替代 Write。
- Search 返回行号 + hash + context。
- Bash 记录结构化执行 metadata。
- 所有文件 mutation 统一生成 `FILE_PATCH_APPLIED` 或 `FILE_MUTATION_APPLIED`。

### Phase 5：Checkpoint

目标：支持恢复、回滚、分支。

工作项：

- 新增 checkpoint service。
- Git workspace 使用 patch bundle / temp commit。
- 非 git workspace 使用 file snapshot。
- checkpoint 与 event head 绑定。
- 支持 restore 后 fork 新 session。
- UI 暴露 checkpoint timeline。

### Phase 6：Goal System

目标：支持长程任务与多 agent 验收返工。

工作项：

- 新增 GoalDescriptor / TaskDescriptor。
- 新增 goal projection。
- 新增 scheduler，根据事件触发 agent tick。
- 新增 planner / worker / tester / reviewer 角色配置。
- 支持 sleep / wake。
- 支持 reviewer 返工事件。

### Phase 7：Personal Assistant 与 Memory / Skill

目标：形成个人助理 + workspace agent 双层形态。

工作项：

- 建立个人助理特殊 workspace。
- 建立 memory event schema 与 memory index。
- 建立 skill discovery index。
- 实现 skill learner 的候选识别和人工确认。
- 实现每日总结 / 梦境任务。
- workspace agent 从个人助理只拉取必要上下文。

---

## 18. 推荐目录演进

```text
src/core/
  event-store/
    types.ts
    store.ts
    sqlite-store.ts
    jsonl-store.ts
    migrations.ts
    workspace.ts
  runtime/
    types.ts
    runtime.ts
    local-runtime.ts
    cloud-runtime.ts
    container-runtime.ts
    checkpoint.ts
    agent-loop.ts
  projection/
    session-projection.ts
    task-projection.ts
    goal-projection.ts
    timeline-projection.ts
    memory-projection.ts
  intent/
    classifier.ts
    executor.ts
    policy.ts
  goal/
    types.ts
    scheduler.ts
    planner.ts
    task-runner.ts
  memory/
    types.ts
    extractor.ts
    store.ts
  skills/
    discovery.ts
    learner.ts
```

---

## 19. 关键工程约束

- Event append 必须是唯一写事实路径。
- 任何投影都可以删除并重建。
- 任何 Runtime 副作用都必须产生事件。
- Brain 输出必须先成为 intent，再由 Runtime 执行。
- 长程任务不能依赖单个无限增长上下文。
- UI 不应直接读内部对象状态，应订阅 EventStore projection。
- 文件 edit 必须具备定位校验，避免旧内容漂移导致误改。
- 本地 / 云端 runtime 的差异不能泄露给 Brain。
- Memory / Skill 自动沉淀默认应可审计、可撤销。

---

## 20. 第一批可执行任务

建议优先做以下 8 个任务：

1. 为 `EventStoreBridge` 补完整因果链和 session hint。
2. 增加 `SqliteEventStore`，保持现有 `EventStore` 接口兼容。
3. 将 EventStore schema 增加 `sequence`、`runtime_id`、`correlation_id`、`schema_version`。
4. 将当前 `JsonlEventStore` 改为可选 mirror backend。
5. 让 TUI / RPC 能订阅 EventStore 并展示 task timeline 最小闭环。
6. 定义 `RuntimeAdapter`，把 tool execution 从 Brain loop 中抽离。
7. 重构 Read / Edit 为 line-hash patch 模型。
8. 新增 Goal / Task 事件 schema 和 projection，不急于实现多 agent，先建立数据模型。

---

## 21. 成功标准

第一阶段成功标准：

- 关闭进程后，重新启动能从 EventStore 恢复最近任务状态。
- 任意一次 tool call 能追溯到触发它的 user message / agent decision。
- UI 能展示完整活动时间线，而不是只展示聊天消息。
- Session context 能由 EventStore projection 构建。
- 文件修改可以通过事件定位、审计和回放。

长期成功标准：

- 一个 Goal 可以跨多天被唤醒、推进、暂停、恢复。
- Goal 可以自动拆成多个 session 和 task。
- Reviewer / Tester 能基于事件和 checkpoint 独立验收。
- 本地和云端 runtime 使用同一个 Brain。
- 个人助理能跨 workspace 记忆与调度，但 workspace agent 保持上下文专注。
- Skills 能被搜索发现、复用、学习和演进，而不是全量塞入 prompt。

