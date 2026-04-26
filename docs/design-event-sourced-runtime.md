# Event-Sourced Runtime 改造设计文档

> 改造范围：T-01 EventStore / T-02 Session Projection / T-03 Intent Layer
> 策略：全新架构，不兼容旧系统

---

## 1. 架构总览

### 1.1 当前架构（被替代）

```
User → AgentSession.prompt()
     → Agent.prompt() (LLM)
     → tool execution (直接 mutation)
     → sessionManager.appendMessage() (JSONL)
     → eventListeners (ephemeral UI notify)
```

核心问题：
- AgentSession 是 God Object（状态 + 逻辑 + 持久化 + UI事件 混合）
- LLM 直接执行 tool → 状态变更不经中间层
- EventBus 纯 ephemeral，不持久化
- Session 是核心结构，不是投影
- 无因果追踪，无 actor 标识

### 1.2 新架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          UI / Mode Layer                         │
│              (Interactive TUI / RPC / Print)                      │
│                   订阅 EventStore 实时流                          │
└──────────────────────────────┬───────────────────────────────────┘
                               │ subscribe
┌──────────────────────────────▼───────────────────────────────────┐
│                        EventStore                                 │
│              (唯一真实来源 / append-only / 持久化)                  │
│                                                                   │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │  Event Log (JSONL)                                      │    │
│   │  workspace_id + actor_id + caused_by + timestamp        │    │
│   └─────────────────────────────────────────────────────────┘    │
└───────┬──────────────────────────────────┬───────────────────────┘
        │ query                            │ append
        ▼                                  │
┌───────────────────┐              ┌───────┴───────────────────────┐
│ Session Projection│              │          Runtime               │
│ (view / filter)   │              │                               │
│                   │              │  ┌─────────────────────────┐  │
│ • context build   │              │  │    Intent Executor       │  │
│ • session list    │              │  │  (deterministic only)    │  │
│ • timeline view   │              │  └────────────┬────────────┘  │
└───────────────────┘              │               │               │
                                   │  ┌────────────▼────────────┐  │
                                   │  │     Agent Loop           │  │
                                   │  │  (LLM → emit intents)   │  │
                                   │  └─────────────────────────┘  │
                                   └───────────────────────────────┘
```

### 1.3 核心原则

1. **EventStore 是唯一真实来源** — 所有可观测状态均可从 event log 推导
2. **Session 是 Projection** — session = query(event_log, filter)
3. **LLM 只 emit intents** — 真正 mutation 由 deterministic IntentExecutor 执行
4. **所有事件 causally linked** — 每个 event 带 `caused_by` 追踪因果
5. **Actor 标识** — 每个 event 标记 `actor_id`（user / coder / runtime）

---

## 2. T-01: EventStore

### 2.1 Event Schema

```typescript
// src/core/event-store/types.ts

/**
 * 所有 event 的基础接口。
 * 不可变、append-only、因果关联、带时间戳。
 */
export interface EventBase {
  /** 全局唯一 event ID (UUIDv7, 时间排序) */
  event_id: string;

  /** 工作空间标识（一个 cwd 对应一个 workspace） */
  workspace_id: string;

  /** 产生此 event 的 actor */
  actor_id: ActorId;

  /** Unix ms 时间戳 */
  timestamp: number;

  /** 事件类型 */
  type: EventType;

  /** 事件负载（由 type 决定结构） */
  payload: unknown;

  /** 因果链：触发此 event 的 event_id */
  caused_by?: string;

  /** 认知聚类提示（辅助 session boundary 推断） */
  session_hint?: string;
}

/** Actor 标识 */
export type ActorId =
  | "user"
  | "coder_agent"
  | "runtime"       // deterministic runtime operations
  | "compactor"     // compaction subsystem
  | string;         // future: planner_agent, reviewer_agent, etc.

/** 全部事件类型 */
export type EventType =
  // User Events
  | "USER_MESSAGE"
  | "USER_APPROVAL"
  | "USER_REJECTION"
  | "USER_INTERRUPT"
  | "USER_CONFIG_CHANGE"
  // Agent Events (LLM output)
  | "AGENT_THINKING_START"
  | "AGENT_THINKING_END"
  | "AGENT_MESSAGE_START"
  | "AGENT_MESSAGE_CHUNK"
  | "AGENT_MESSAGE_END"
  | "AGENT_TURN_START"
  | "AGENT_TURN_END"
  // Intent Events (LLM proposals)
  | "INTENT_TOOL_CALL"
  | "INTENT_FILE_EDIT"
  | "INTENT_COMMAND_EXEC"
  // Execution Events (runtime deterministic)
  | "TOOL_EXECUTION_START"
  | "TOOL_EXECUTION_UPDATE"
  | "TOOL_EXECUTION_END"
  | "FILE_MUTATION_APPLIED"
  | "COMMAND_EXECUTED"
  // Session Lifecycle
  | "SESSION_CREATED"
  | "SESSION_BOUNDARY_INFERRED"
  | "SESSION_FORKED"
  // Compaction
  | "COMPACTION_START"
  | "COMPACTION_END"
  // Runtime
  | "CHECKPOINT_CREATED"
  | "MODEL_CHANGED"
  | "THINKING_LEVEL_CHANGED"
  | "RUNTIME_ERROR";
```

### 2.2 具体 Event Payload 定义

```typescript
// src/core/event-store/events.ts

import type { EventBase, EventType } from "./types.js";

/** User sends a message */
export interface UserMessageEvent extends EventBase {
  type: "USER_MESSAGE";
  payload: {
    content: string | ContentBlock[];
    images?: ImageContent[];
    /** 原始输入（expand 前） */
    raw_input?: string;
  };
}

/** LLM produces assistant message (final, after streaming completes) */
export interface AgentMessageEndEvent extends EventBase {
  type: "AGENT_MESSAGE_END";
  payload: {
    content: ContentBlock[];
    model: { provider: string; model_id: string };
    usage: TokenUsage;
    stop_reason: "stop" | "tool_use" | "length" | "error" | "aborted";
    error_message?: string;
  };
}

/** LLM proposes a tool call (intent, not yet executed) */
export interface IntentToolCallEvent extends EventBase {
  type: "INTENT_TOOL_CALL";
  payload: {
    tool_call_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    /** 是否需要用户批准 */
    requires_approval: boolean;
  };
}

/** User approves a pending intent */
export interface UserApprovalEvent extends EventBase {
  type: "USER_APPROVAL";
  payload: {
    /** 被批准的 intent event_id */
    intent_event_id: string;
  };
}

/** Runtime executes a tool (deterministic) */
export interface ToolExecutionEndEvent extends EventBase {
  type: "TOOL_EXECUTION_END";
  payload: {
    tool_call_id: string;
    tool_name: string;
    result: ContentBlock[];
    is_error: boolean;
    duration_ms: number;
    /** file mutations produced by this execution */
    file_mutations?: FileMutation[];
  };
}

/** Compaction completed */
export interface CompactionEndEvent extends EventBase {
  type: "COMPACTION_END";
  payload: {
    summary: string;
    first_kept_event_id: string;
    tokens_before: number;
    /** structured memory nodes extracted */
    memory_nodes?: MemoryNodeRef[];
  };
}

/** Model changed */
export interface ModelChangedEvent extends EventBase {
  type: "MODEL_CHANGED";
  payload: {
    provider: string;
    model_id: string;
    previous_provider?: string;
    previous_model_id?: string;
  };
}

// Supporting types
export interface ContentBlock {
  type: "text" | "image" | "thinking" | "tool_call";
  [key: string]: unknown;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
  cost: number;
}

export interface FileMutation {
  path: string;
  operation: "create" | "modify" | "delete";
  diff?: string;
}

export interface MemoryNodeRef {
  node_id: string;
  type: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mime_type: string;
}
```

### 2.3 EventStore 接口

```typescript
// src/core/event-store/store.ts

import type { EventBase, EventType } from "./types.js";

/** EventStore 查询过滤器 */
export interface EventQuery {
  /** 时间范围 */
  after?: string;       // event_id (UUIDv7 自然排序)
  before?: string;
  /** 按类型过滤 */
  types?: EventType[];
  /** 按 actor 过滤 */
  actor_ids?: string[];
  /** 按因果链过滤（返回此 event 的所有 descendants） */
  caused_by?: string;
  /** 按 session_hint 过滤 */
  session_hint?: string;
  /** 返回数量限制 */
  limit?: number;
  /** 是否逆序 */
  reverse?: boolean;
}

/** EventStore 订阅选项 */
export interface SubscribeOptions {
  /** 从哪个 event_id 之后开始接收（不含） */
  after?: string;
  /** 过滤条件 */
  types?: EventType[];
  actor_ids?: string[];
}

/** EventStore 接口 */
export interface EventStore {
  /** Workspace 标识 */
  readonly workspace_id: string;

  /** 追加事件（返回完整 event，含生成的 event_id 和 timestamp） */
  append(event: Omit<EventBase, "event_id" | "timestamp" | "workspace_id">): EventBase;

  /** 批量追加 */
  appendBatch(events: Omit<EventBase, "event_id" | "timestamp" | "workspace_id">[]): EventBase[];

  /** 查询事件 */
  query(filter: EventQuery): EventBase[];

  /** 获取单个 event */
  get(event_id: string): EventBase | undefined;

  /** 获取最新 N 个事件 */
  latest(count: number): EventBase[];

  /** 获取从某 event 到 root 的因果链 */
  getCausalChain(event_id: string): EventBase[];

  /** 实时订阅新事件 */
  subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void;

  /** 当前 event 总数 */
  readonly size: number;

  /** 最新 event_id */
  readonly head: string | undefined;
}
```

### 2.4 EventStore 实现（JSONL 持久化）

```typescript
// src/core/event-store/jsonl-store.ts

/**
 * 基于 JSONL 的 EventStore 实现。
 *
 * 物理存储：~/.pizza/agent/workspaces/<workspace_id>/events.jsonl
 *
 * 特性：
 * - append-only 写入
 * - 内存 index（byId Map + type index）
 * - 实时订阅（EventEmitter）
 * - UUIDv7 保证时间排序
 */
export class JsonlEventStore implements EventStore {
  // 内存索引
  private events: EventBase[] = [];
  private byId: Map<string, EventBase> = new Map();
  private byType: Map<string, EventBase[]> = new Map();
  private byCausedBy: Map<string, EventBase[]> = new Map();
  private subscribers: Map<number, { handler: Function; options?: SubscribeOptions }> = new Map();
  private nextSubId = 0;

  // 持久化
  private filePath: string;
  private flushed = false;

  constructor(
    readonly workspace_id: string,
    storagePath: string,
  ) {
    this.filePath = storagePath;
    this._loadFromDisk();
  }

  append(partial: Omit<EventBase, "event_id" | "timestamp" | "workspace_id">): EventBase {
    const event: EventBase = {
      ...partial,
      event_id: generateUUIDv7(),
      timestamp: Date.now(),
      workspace_id: this.workspace_id,
    };
    this._index(event);
    this._persist(event);
    this._notify(event);
    return event;
  }

  // ... query, subscribe, getCausalChain implementations
}
```

### 2.5 WorkspaceId 生成策略

```typescript
/**
 * workspace_id = deterministic hash of canonical cwd
 * 保证同一目录多次启动得到相同 workspace_id
 */
export function deriveWorkspaceId(cwd: string): string {
  const canonical = resolve(cwd).replace(/\\/g, "/");
  return `ws_${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}
```

### 2.6 存储布局

```
~/.pizza/agent/workspaces/
  ws_a1b2c3d4e5f6/
    events.jsonl          # 主事件日志（所有事件）
    meta.json             # workspace 元数据 { cwd, created_at, ... }
    checkpoints/          # future: checkpoint snapshots
    memory/               # future: memory graph
```

---

## 3. T-02: Session Projection

### 3.1 设计原则

Session 不再是数据的持有者。Session 是对 EventStore 的一种 **查询视图**。

- Session 不存储消息
- Session 只存储：事件范围引用 + 摘要引用 + 元数据
- Session boundary 可自动推断或手动创建
- 多个 session 可以并存（同一 event 可属于多个 session 视图）

### 3.2 Session Projection 接口

```typescript
// src/core/projection/types.ts

/** Session 定义 — 纯引用结构 */
export interface SessionDescriptor {
  session_id: string;
  workspace_id: string;
  /** 此 session 覆盖的事件范围 [start, end] (inclusive) */
  event_range: {
    start_event_id: string;
    end_event_id: string;     // "HEAD" = 追踪最新
  };
  /** 摘要引用 (compaction event_id) */
  summary_event_id?: string;
  /** 用户自定义名称 */
  name?: string;
  /** 创建方式 */
  created_by: "user_explicit" | "auto_inferred" | "fork";
  /** 推断原因 */
  boundary_reason?: "intent_shift" | "file_drift" | "time_gap" | "user_explicit";
  /** 父 session (fork 来源) */
  parent_session_id?: string;
  /** 创建时间 */
  created_at: number;
}

/** Session 列表存储 */
export interface SessionIndex {
  sessions: SessionDescriptor[];
}
```

### 3.3 SessionProjection 服务

```typescript
// src/core/projection/session-projection.ts

import type { EventStore } from "../event-store/store.js";
import type { SessionDescriptor } from "./types.js";

/**
 * SessionProjection 从 EventStore 派生 LLM 上下文。
 *
 * 核心方法：buildContext() — 替代原 buildSessionContext()
 */
export class SessionProjection {
  constructor(
    private store: EventStore,
    private descriptor: SessionDescriptor,
  ) {}

  /**
   * 构建 LLM 可用的上下文消息列表。
   *
   * 逻辑：
   * 1. 从 event_range 内查询所有 context-relevant events
   * 2. 如果有 summary_event_id，先注入 compaction summary
   * 3. 将 events 转换为 AgentMessage[] 格式
   * 4. 应用 token budget 截断
   */
  buildContext(options?: BuildContextOptions): BuiltContext {
    const events = this.store.query({
      after: this.getEffectiveStart(),
      before: this.descriptor.event_range.end_event_id === "HEAD"
        ? undefined
        : this.descriptor.event_range.end_event_id,
      types: CONTEXT_RELEVANT_EVENT_TYPES,
    });

    const messages = this.eventsToMessages(events);

    // Inject compaction summary if present
    if (this.descriptor.summary_event_id) {
      const summaryEvent = this.store.get(this.descriptor.summary_event_id);
      if (summaryEvent) {
        messages.unshift(this.summaryToMessage(summaryEvent));
      }
    }

    return { messages, events, descriptor: this.descriptor };
  }

  /**
   * 获取 session 的时间线视图（用于 UI）
   */
  getTimeline(): TimelineEntry[] {
    // 按时间排列所有事件，标注类型和 actor
    const events = this.store.query({
      after: this.descriptor.event_range.start_event_id,
    });
    return events.map(e => ({
      event_id: e.event_id,
      type: e.type,
      actor_id: e.actor_id,
      timestamp: e.timestamp,
      summary: this.summarizeEvent(e),
    }));
  }

  /** Fork: 创建新 session 从指定 event 开始分支 */
  fork(at_event_id: string): SessionDescriptor {
    return {
      session_id: generateUUIDv7(),
      workspace_id: this.store.workspace_id,
      event_range: {
        start_event_id: at_event_id,
        end_event_id: "HEAD",
      },
      created_by: "fork",
      parent_session_id: this.descriptor.session_id,
      created_at: Date.now(),
    };
  }
}

/** 参与 LLM context 的事件类型 */
const CONTEXT_RELEVANT_EVENT_TYPES: EventType[] = [
  "USER_MESSAGE",
  "AGENT_MESSAGE_END",
  "TOOL_EXECUTION_END",
  "COMPACTION_END",
  "FILE_MUTATION_APPLIED",
];

export interface BuildContextOptions {
  /** token 预算 */
  max_tokens?: number;
  /** 是否包含 tool execution details */
  include_tool_details?: boolean;
}

export interface BuiltContext {
  messages: AgentMessage[];
  events: EventBase[];
  descriptor: SessionDescriptor;
}

export interface TimelineEntry {
  event_id: string;
  type: EventType;
  actor_id: string;
  timestamp: number;
  summary: string;
}
```

### 3.4 Session Boundary Inferrer

```typescript
// src/core/projection/boundary-inferrer.ts

import type { EventBase } from "../event-store/types.js";

export interface BoundaryDecision {
  should_split: boolean;
  reason?: "intent_shift" | "file_drift" | "time_gap" | "tool_pattern_change";
  suggested_name?: string;
}

/**
 * 自动推断 session 边界。
 *
 * 基于以下信号：
 * 1. 时间间隔 > threshold (e.g., 2 hours)
 * 2. 用户消息语义突变（topic change）
 * 3. 操作文件集合大幅切换
 * 4. 工具使用模式变化
 */
export class SessionBoundaryInferrer {
  constructor(private config: BoundaryConfig = DEFAULT_BOUNDARY_CONFIG) {}

  /**
   * 给定最近 N 个事件，判断是否应该创建新的 session boundary
   */
  evaluate(recentEvents: EventBase[], newEvent: EventBase): BoundaryDecision {
    // 1. Time gap check
    if (this.hasTimeGap(recentEvents, newEvent)) {
      return { should_split: true, reason: "time_gap" };
    }

    // 2. File drift check
    if (this.hasFileDrift(recentEvents, newEvent)) {
      return { should_split: true, reason: "file_drift" };
    }

    // 3. Intent shift (requires semantic comparison, can use simple heuristics first)
    if (this.hasIntentShift(recentEvents, newEvent)) {
      return { should_split: true, reason: "intent_shift" };
    }

    return { should_split: false };
  }

  private hasTimeGap(recent: EventBase[], next: EventBase): boolean {
    if (recent.length === 0) return false;
    const last = recent[recent.length - 1];
    return (next.timestamp - last.timestamp) > this.config.time_gap_ms;
  }

  private hasFileDrift(recent: EventBase[], next: EventBase): boolean {
    // Compare file sets in recent tool executions vs new event
    // Threshold: > 80% new files = drift
    return false; // Phase 2 implementation
  }

  private hasIntentShift(recent: EventBase[], next: EventBase): boolean {
    // Phase 3: semantic comparison of user messages
    return false;
  }
}

export interface BoundaryConfig {
  time_gap_ms: number;
  file_drift_threshold: number;
  min_events_for_session: number;
}

const DEFAULT_BOUNDARY_CONFIG: BoundaryConfig = {
  time_gap_ms: 2 * 60 * 60 * 1000, // 2 hours
  file_drift_threshold: 0.8,
  min_events_for_session: 3,
};
```

### 3.5 SessionManager (新版 — 纯 index 管理)

```typescript
// src/core/projection/session-manager.ts

/**
 * 新版 SessionManager — 只管理 session descriptors。
 *
 * 存储：~/.pizza/agent/workspaces/<workspace_id>/sessions.json
 *
 * 不再存储消息，不再持有 tree structure。
 * 树形结构由 EventStore 的 caused_by 链自然形成。
 */
export class SessionManager {
  private sessions: Map<string, SessionDescriptor> = new Map();
  private activeSessionId: string | undefined;
  private inferrer: SessionBoundaryInferrer;

  constructor(
    private store: EventStore,
    private storagePath: string,
  ) {
    this.inferrer = new SessionBoundaryInferrer();
    this._loadIndex();
    this._subscribeToEvents();
  }

  /** 获取或创建 active session */
  getActiveSession(): SessionProjection {
    if (!this.activeSessionId) {
      this.createSession("user_explicit");
    }
    const desc = this.sessions.get(this.activeSessionId!)!;
    return new SessionProjection(this.store, desc);
  }

  /** 创建新 session */
  createSession(created_by: SessionDescriptor["created_by"], name?: string): SessionDescriptor {
    const desc: SessionDescriptor = {
      session_id: generateUUIDv7(),
      workspace_id: this.store.workspace_id,
      event_range: {
        start_event_id: this.store.head ?? "ORIGIN",
        end_event_id: "HEAD",
      },
      name,
      created_by,
      created_at: Date.now(),
    };
    this.sessions.set(desc.session_id, desc);
    this.activeSessionId = desc.session_id;
    this._persistIndex();

    // Emit session created event
    this.store.append({
      actor_id: "runtime",
      type: "SESSION_CREATED",
      payload: { session_id: desc.session_id, name, created_by },
    });

    return desc;
  }

  /** Fork 当前 session */
  forkAt(event_id: string): SessionDescriptor {
    const active = this.getActiveSession();
    const forked = active.fork(event_id);
    this.sessions.set(forked.session_id, forked);
    this.activeSessionId = forked.session_id;
    this._persistIndex();

    this.store.append({
      actor_id: "runtime",
      type: "SESSION_FORKED",
      payload: {
        new_session_id: forked.session_id,
        parent_session_id: forked.parent_session_id,
        fork_at_event_id: event_id,
      },
    });

    return forked;
  }

  /** 列出所有 sessions */
  listSessions(): SessionDescriptor[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** 切换 active session */
  switchTo(session_id: string): void {
    if (!this.sessions.has(session_id)) {
      throw new Error(`Session not found: ${session_id}`);
    }
    this.activeSessionId = session_id;
    this._persistIndex();
  }

  /** 自动边界推断（订阅 EventStore 新事件） */
  private _subscribeToEvents(): void {
    this.store.subscribe((event) => {
      if (event.type !== "USER_MESSAGE") return;

      const recent = this.store.latest(20);
      const decision = this.inferrer.evaluate(recent, event);

      if (decision.should_split) {
        // 结束当前 session 的 event_range
        const current = this.sessions.get(this.activeSessionId!);
        if (current && current.event_range.end_event_id === "HEAD") {
          // 找到最新的非 USER_MESSAGE event 作为结束点
          const lastEvent = recent[recent.length - 2]; // event before current
          if (lastEvent) {
            current.event_range.end_event_id = lastEvent.event_id;
          }
        }
        // 创建新 session
        this.createSession("auto_inferred", decision.suggested_name);

        this.store.append({
          actor_id: "runtime",
          type: "SESSION_BOUNDARY_INFERRED",
          payload: {
            reason: decision.reason,
            new_session_id: this.activeSessionId,
          },
          caused_by: event.event_id,
        });
      }
    }, { types: ["USER_MESSAGE"] });
  }
}
```

---

## 4. T-03: Intent Layer

### 4.1 设计原则

LLM 的 tool calls 不再直接执行。流程变为：

```
LLM outputs tool_call
  → classify intent (sync, fast)
  → if auto-approvable: emit INTENT_TOOL_CALL → execute → emit TOOL_EXECUTION_END
  → if requires approval: emit INTENT_TOOL_CALL(requires_approval=true) → wait USER_APPROVAL → execute
```

### 4.2 Intent 分类器

```typescript
// src/core/intent/classifier.ts

export type IntentRisk = "safe" | "moderate" | "dangerous";

export interface IntentClassification {
  risk: IntentRisk;
  requires_approval: boolean;
  category: IntentCategory;
  affected_files?: string[];
  description: string;
}

export type IntentCategory =
  | "file_read"        // safe: read, ls, find, grep
  | "file_write"       // moderate: write, edit
  | "file_delete"      // dangerous: rm, unlink
  | "shell_safe"       // safe: echo, cat, pwd
  | "shell_moderate"   // moderate: npm install, git commit
  | "shell_dangerous"  // dangerous: rm -rf, sudo, curl | bash
  | "network"          // moderate: fetch, curl
  | "unknown";         // dangerous by default

/**
 * 分类器：根据 tool_name + arguments 判断风险等级和是否需要批准。
 *
 * 默认策略：
 * - file_read, shell_safe: auto-approve
 * - file_write, shell_moderate, network: auto-approve (可配置)
 * - file_delete, shell_dangerous: always require approval
 */
export class IntentClassifier {
  constructor(private config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG) {}

  classify(toolName: string, args: Record<string, unknown>): IntentClassification {
    // Built-in tool classification
    switch (toolName) {
      case "read":
      case "find":
      case "grep":
      case "ls":
        return { risk: "safe", requires_approval: false, category: "file_read", description: `Read ${args.path ?? ""}` };

      case "write":
        return {
          risk: "moderate",
          requires_approval: this.config.approve_writes,
          category: "file_write",
          affected_files: [String(args.path)],
          description: `Write to ${args.path}`,
        };

      case "edit":
        return {
          risk: "moderate",
          requires_approval: this.config.approve_edits,
          category: "file_write",
          affected_files: [String(args.path)],
          description: `Edit ${args.path}`,
        };

      case "bash":
        return this._classifyBashCommand(String(args.command ?? ""));

      default:
        return {
          risk: "moderate",
          requires_approval: this.config.approve_unknown,
          category: "unknown",
          description: `Execute ${toolName}`,
        };
    }
  }

  private _classifyBashCommand(command: string): IntentClassification {
    const trimmed = command.trim();

    // Dangerous patterns
    const dangerousPatterns = [
      /\brm\s+-[a-z]*r/i,
      /\bsudo\b/,
      /\bcurl\b.*\|\s*bash/,
      /\bchmod\s+777/,
      /\b>\s*\/dev\//,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmed)) {
        return { risk: "dangerous", requires_approval: true, category: "shell_dangerous", description: `DANGEROUS: ${trimmed}` };
      }
    }

    // Safe patterns
    const safePatterns = [
      /^(echo|cat|pwd|ls|find|grep|head|tail|wc|date|whoami)\b/,
      /^git\s+(status|log|diff|branch|show)\b/,
    ];
    for (const pattern of safePatterns) {
      if (pattern.test(trimmed)) {
        return { risk: "safe", requires_approval: false, category: "shell_safe", description: trimmed };
      }
    }

    // Everything else is moderate
    return {
      risk: "moderate",
      requires_approval: this.config.approve_shell_moderate,
      category: "shell_moderate",
      description: trimmed,
    };
  }
}

export interface ClassifierConfig {
  approve_writes: boolean;
  approve_edits: boolean;
  approve_shell_moderate: boolean;
  approve_unknown: boolean;
}

const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  approve_writes: false,       // auto-approve writes
  approve_edits: false,        // auto-approve edits
  approve_shell_moderate: false, // auto-approve moderate shell
  approve_unknown: true,       // require approval for unknown tools
};
```

### 4.3 Intent Executor

```typescript
// src/core/intent/executor.ts

import type { EventStore } from "../event-store/store.js";
import type { IntentClassification, IntentClassifier } from "./classifier.js";

/**
 * IntentExecutor — 唯一允许执行 mutations 的组件。
 *
 * 职责：
 * 1. 接收 INTENT_TOOL_CALL event
 * 2. 分类风险
 * 3. 如需批准 → 等待 USER_APPROVAL event
 * 4. 执行 tool → emit TOOL_EXECUTION_START/END events
 * 5. 记录 file mutations
 */
export class IntentExecutor {
  private pendingApprovals: Map<string, PendingIntent> = new Map();

  constructor(
    private store: EventStore,
    private classifier: IntentClassifier,
    private toolRegistry: ToolRegistry,
    private approvalHandler?: ApprovalHandler,
  ) {
    // 订阅 approval events
    this.store.subscribe((event) => {
      if (event.type === "USER_APPROVAL") {
        this._handleApproval(event);
      } else if (event.type === "USER_REJECTION") {
        this._handleRejection(event);
      }
    }, { types: ["USER_APPROVAL", "USER_REJECTION"] });
  }

  /**
   * 处理一个 tool call intent。
   *
   * 返回 tool 执行结果（用于回传给 LLM）。
   * 如果需要 approval 则 await 直到用户响应。
   */
  async execute(intent: IntentToolCallEvent): Promise<ToolExecutionResult> {
    const classification = this.classifier.classify(
      intent.payload.tool_name,
      intent.payload.arguments,
    );

    // Emit classification info
    const intentEvent = this.store.append({
      actor_id: "runtime",
      type: "INTENT_TOOL_CALL",
      payload: {
        ...intent.payload,
        requires_approval: classification.requires_approval,
        classification,
      },
      caused_by: intent.event_id,
    });

    // If approval required, wait
    if (classification.requires_approval) {
      const approved = await this._waitForApproval(intentEvent.event_id, classification);
      if (!approved) {
        return {
          content: [{ type: "text", text: "Tool execution rejected by user." }],
          is_error: true,
        };
      }
    }

    // Execute
    return this._executeTool(intentEvent);
  }

  private async _executeTool(intentEvent: EventBase): Promise<ToolExecutionResult> {
    const { tool_name, arguments: args, tool_call_id } = intentEvent.payload as any;
    const tool = this.toolRegistry.get(tool_name);

    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${tool_name}` }], is_error: true };
    }

    // Emit start
    this.store.append({
      actor_id: "runtime",
      type: "TOOL_EXECUTION_START",
      payload: { tool_call_id, tool_name, arguments: args },
      caused_by: intentEvent.event_id,
    });

    const startTime = Date.now();
    try {
      const result = await tool.execute(args);

      // Emit end
      this.store.append({
        actor_id: "runtime",
        type: "TOOL_EXECUTION_END",
        payload: {
          tool_call_id,
          tool_name,
          result: result.content,
          is_error: result.isError ?? false,
          duration_ms: Date.now() - startTime,
          file_mutations: result.fileMutations,
        },
        caused_by: intentEvent.event_id,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.store.append({
        actor_id: "runtime",
        type: "TOOL_EXECUTION_END",
        payload: {
          tool_call_id,
          tool_name,
          result: [{ type: "text", text: errorMsg }],
          is_error: true,
          duration_ms: Date.now() - startTime,
        },
        caused_by: intentEvent.event_id,
      });
      return { content: [{ type: "text", text: errorMsg }], is_error: true };
    }
  }

  private _waitForApproval(intentEventId: string, classification: IntentClassification): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(intentEventId, { resolve, classification });
      // Notify UI via approval handler
      this.approvalHandler?.requestApproval(intentEventId, classification);
    });
  }

  private _handleApproval(event: EventBase): void {
    const { intent_event_id } = event.payload as any;
    const pending = this.pendingApprovals.get(intent_event_id);
    if (pending) {
      this.pendingApprovals.delete(intent_event_id);
      pending.resolve(true);
    }
  }

  private _handleRejection(event: EventBase): void {
    const { intent_event_id } = event.payload as any;
    const pending = this.pendingApprovals.get(intent_event_id);
    if (pending) {
      this.pendingApprovals.delete(intent_event_id);
      pending.resolve(false);
    }
  }
}

interface PendingIntent {
  resolve: (approved: boolean) => void;
  classification: IntentClassification;
}

export interface ApprovalHandler {
  requestApproval(intentEventId: string, classification: IntentClassification): void;
}

export interface ToolExecutionResult {
  content: ContentBlock[];
  is_error: boolean;
  fileMutations?: FileMutation[];
}

export interface ToolRegistry {
  get(name: string): { execute(args: Record<string, unknown>): Promise<ToolExecutionResult> } | undefined;
}
```

### 4.4 Agent Loop (新版)

```typescript
// src/core/runtime/agent-loop.ts

import type { EventStore } from "../event-store/store.js";
import type { IntentExecutor } from "../intent/executor.js";
import type { SessionProjection } from "../projection/session-projection.js";

/**
 * AgentLoop — 单 Agent 的 LLM 调用循环。
 *
 * 替代原 AgentSession 中的 prompt + _handleAgentEvent 逻辑。
 *
 * 职责：
 * 1. 从 SessionProjection 构建 context
 * 2. 调用 LLM
 * 3. LLM 产出 tool_call → 交给 IntentExecutor
 * 4. 所有中间状态通过 EventStore append 记录
 * 5. 循环直到 LLM stop（无 tool_call）
 */
export class AgentLoop {
  constructor(
    private store: EventStore,
    private intentExecutor: IntentExecutor,
    private llmClient: LLMClient,
    private config: AgentLoopConfig,
  ) {}

  /**
   * 运行一次完整的 agent 交互（可能包含多个 LLM turns）。
   *
   * 入口：一个 USER_MESSAGE event 已经 append 到 store。
   * 出口：LLM stop_reason = "stop"（无 tool_call）
   */
  async run(triggerEventId: string): Promise<void> {
    let currentCausedBy = triggerEventId;

    // Emit agent thinking start
    this.store.append({
      actor_id: "coder_agent",
      type: "AGENT_THINKING_START",
      payload: {},
      caused_by: currentCausedBy,
    });

    while (true) {
      // 1. Build context from projection
      const context = this.config.projection.buildContext({
        max_tokens: this.config.contextBudget,
      });

      // 2. Emit turn start
      const turnStart = this.store.append({
        actor_id: "coder_agent",
        type: "AGENT_TURN_START",
        payload: { message_count: context.messages.length },
        caused_by: currentCausedBy,
      });

      // 3. Call LLM
      const response = await this.llmClient.complete({
        messages: context.messages,
        systemPrompt: this.config.systemPrompt,
        model: this.config.model,
        tools: this.config.tools,
      });

      // 4. Emit message end
      const msgEnd = this.store.append({
        actor_id: "coder_agent",
        type: "AGENT_MESSAGE_END",
        payload: {
          content: response.content,
          model: { provider: response.provider, model_id: response.model },
          usage: response.usage,
          stop_reason: response.stopReason,
          error_message: response.errorMessage,
        },
        caused_by: turnStart.event_id,
      });

      currentCausedBy = msgEnd.event_id;

      // 5. If no tool calls, we're done
      const toolCalls = response.content.filter(c => c.type === "tool_call");
      if (toolCalls.length === 0 || response.stopReason !== "tool_use") {
        break;
      }

      // 6. Execute tool calls through IntentExecutor
      for (const toolCall of toolCalls) {
        const result = await this.intentExecutor.execute({
          event_id: msgEnd.event_id,
          workspace_id: this.store.workspace_id,
          actor_id: "coder_agent",
          timestamp: Date.now(),
          type: "INTENT_TOOL_CALL",
          payload: {
            tool_call_id: toolCall.id,
            tool_name: toolCall.name,
            arguments: toolCall.arguments,
            requires_approval: false, // will be determined by executor
          },
        } as any);

        // Tool result is already recorded in EventStore by IntentExecutor
        // The next loop iteration will pick it up via buildContext()
      }

      // 7. Emit turn end
      this.store.append({
        actor_id: "coder_agent",
        type: "AGENT_TURN_END",
        payload: { tool_calls_count: toolCalls.length },
        caused_by: currentCausedBy,
      });
    }

    // Emit thinking end
    this.store.append({
      actor_id: "coder_agent",
      type: "AGENT_THINKING_END",
      payload: {},
      caused_by: currentCausedBy,
    });
  }
}

export interface AgentLoopConfig {
  projection: SessionProjection;
  systemPrompt: string;
  model: ModelConfig;
  tools: ToolDefinition[];
  contextBudget: number;
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface ModelConfig {
  provider: string;
  model_id: string;
  thinking_level?: string;
}
```

---

## 5. Runtime 组装

### 5.1 新 Runtime 入口

```typescript
// src/core/runtime/runtime.ts

/**
 * EventSourcedRuntime — 替代原 AgentSessionRuntime。
 *
 * 组装 EventStore + SessionProjection + IntentExecutor + AgentLoop。
 * 为 UI 层提供统一接口。
 */
export class EventSourcedRuntime {
  readonly store: EventStore;
  readonly sessionManager: SessionManager;
  readonly intentExecutor: IntentExecutor;
  private agentLoop: AgentLoop | null = null;
  private _isRunning = false;

  constructor(config: RuntimeConfig) {
    // 1. Create EventStore
    this.store = new JsonlEventStore(
      deriveWorkspaceId(config.cwd),
      config.storagePath,
    );

    // 2. Create SessionManager (manages session descriptors)
    this.sessionManager = new SessionManager(
      this.store,
      config.sessionIndexPath,
    );

    // 3. Create IntentExecutor
    const classifier = new IntentClassifier(config.classifierConfig);
    this.intentExecutor = new IntentExecutor(
      this.store,
      classifier,
      config.toolRegistry,
      config.approvalHandler,
    );
  }

  /** 处理用户输入 */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (this._isRunning) {
      // Queue as steering (interrupt current turn)
      this.store.append({
        actor_id: "user",
        type: "USER_INTERRUPT",
        payload: { content: text, images },
      });
      return;
    }

    this._isRunning = true;

    // 1. Append user message event
    const userEvent = this.store.append({
      actor_id: "user",
      type: "USER_MESSAGE",
      payload: { content: text, images },
    });

    // 2. Get active session projection
    const projection = this.sessionManager.getActiveSession();

    // 3. Create and run agent loop
    this.agentLoop = new AgentLoop(
      this.store,
      this.intentExecutor,
      this.config.llmClient,
      {
        projection,
        systemPrompt: this.config.systemPrompt,
        model: this.config.model,
        tools: this.config.tools,
        contextBudget: this.config.contextBudget,
      },
    );

    try {
      await this.agentLoop.run(userEvent.event_id);
    } finally {
      this._isRunning = false;
      this.agentLoop = null;
    }
  }

  /** 中断当前运行 */
  abort(): void {
    this.store.append({
      actor_id: "user",
      type: "USER_INTERRUPT",
      payload: {},
    });
    // Agent loop should check for interrupts
  }

  /** 批准一个 pending intent */
  approve(intentEventId: string): void {
    this.store.append({
      actor_id: "user",
      type: "USER_APPROVAL",
      payload: { intent_event_id: intentEventId },
    });
  }

  /** 拒绝一个 pending intent */
  reject(intentEventId: string): void {
    this.store.append({
      actor_id: "user",
      type: "USER_REJECTION",
      payload: { intent_event_id: intentEventId },
    });
  }

  /** 订阅实时事件（UI 用） */
  subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
    return this.store.subscribe(handler, options);
  }

  /** Fork session at specific event */
  fork(eventId: string): SessionDescriptor {
    return this.sessionManager.forkAt(eventId);
  }

  /** 切换 session */
  switchSession(sessionId: string): void {
    this.sessionManager.switchTo(sessionId);
  }
}
```

---

## 6. 模块目录结构

```
src/core/
├── event-store/
│   ├── types.ts              # EventBase, EventType, ActorId
│   ├── events.ts             # 具体 event payload 类型定义
│   ├── jsonl-store.ts        # JSONL 实现
│   ├── workspace.ts          # workspace_id 推导 + 存储布局
│   └── index.ts
├── projection/
│   ├── types.ts              # SessionDescriptor, BuildContextOptions
│   ├── session-projection.ts # SessionProjection (context builder)
│   ├── session-manager.ts    # Session index 管理
│   ├── boundary-inferrer.ts  # 自动边界推断
│   ├── event-to-message.ts   # Event → AgentMessage 转换器
│   └── index.ts
├── intent/
│   ├── types.ts              # IntentClassification, IntentCategory
│   ├── classifier.ts         # 风险分类器
│   ├── executor.ts           # 确定性执行器
│   └── index.ts
├── runtime/
│   ├── agent-loop.ts         # LLM 调用循环
│   ├── runtime.ts            # EventSourcedRuntime (顶层组装)
│   ├── compaction.ts         # Compaction (基于 EventStore)
│   └── index.ts
└── tools/                    # 保留现有 tools，适配新接口
    ├── bash.ts
    ├── edit.ts
    ├── read.ts
    ├── write.ts
    ├── ...
    └── registry.ts           # ToolRegistry 适配
```

---

## 7. 数据流示意

### 7.1 正常交互

```
User types "fix the auth bug"
  │
  ├─→ store.append({ actor: "user", type: "USER_MESSAGE", payload: { content: "fix..." } })
  │
  ├─→ SessionBoundaryInferrer.evaluate() → no split
  │
  ├─→ AgentLoop.run(user_event_id)
  │     │
  │     ├─→ projection.buildContext() → messages[]
  │     ├─→ llmClient.complete(messages) → response with tool_calls
  │     │
  │     ├─→ store.append({ actor: "coder_agent", type: "AGENT_MESSAGE_END", ... })
  │     │
  │     ├─→ IntentExecutor.execute(tool_call: "edit auth.ts")
  │     │     ├─→ classifier.classify("edit", { path: "auth.ts" }) → safe, auto-approve
  │     │     ├─→ store.append({ type: "INTENT_TOOL_CALL", ... })
  │     │     ├─→ store.append({ type: "TOOL_EXECUTION_START", ... })
  │     │     ├─→ tool.execute() → result
  │     │     └─→ store.append({ type: "TOOL_EXECUTION_END", ... })
  │     │
  │     └─→ (loop: LLM sees tool result → generates final response → stop)
  │
  └─→ UI receives all events via store.subscribe()
```

### 7.2 需要审批

```
LLM proposes: bash("rm -rf /tmp/old")
  │
  ├─→ classifier.classify("bash", ...) → dangerous, requires_approval=true
  ├─→ store.append({ type: "INTENT_TOOL_CALL", requires_approval: true })
  ├─→ UI shows approval dialog
  │
  ├─ [User clicks Approve]
  │     ├─→ store.append({ type: "USER_APPROVAL", intent_event_id: "..." })
  │     └─→ IntentExecutor._handleApproval() → resolves promise → execute
  │
  └─ [User clicks Reject]
        ├─→ store.append({ type: "USER_REJECTION", intent_event_id: "..." })
        └─→ IntentExecutor._handleRejection() → resolves promise → return error to LLM
```

### 7.3 Session Fork

```
User invokes /fork at event E42
  │
  ├─→ sessionManager.forkAt("E42")
  │     ├─→ creates new SessionDescriptor { event_range: { start: "E42", end: "HEAD" } }
  │     └─→ store.append({ type: "SESSION_FORKED", ... })
  │
  └─→ 新 session 从 E42 开始，共享 E42 之前的所有事件
      后续事件只出现在新 session 的 event_range 内
```

---

## 8. 与现有模块的映射

| 旧模块 | 新模块 | 策略 |
|---|---|---|
| `SessionManager` (JSONL tree) | `EventStore` + `SessionManager`(index only) | **全部重写** |
| `AgentSession._handleAgentEvent` | `AgentLoop.run()` | **全部重写** |
| `AgentSession._installAgentToolHooks` | `IntentExecutor` | **替代** |
| `AgentSession.prompt()` | `EventSourcedRuntime.prompt()` | **替代** |
| `event-bus.ts` | `EventStore.subscribe()` | **删除**，EventStore 自带订阅 |
| `AgentSessionRuntime` (switch/fork) | `EventSourcedRuntime` + `SessionManager` | **替代** |
| `buildSessionContext()` | `SessionProjection.buildContext()` | **重写** |
| `compaction/` | `runtime/compaction.ts` (基于 EventStore) | **重写** |
| `tools/` | 保留实现，通过 `ToolRegistry` 适配 | **适配** |
| `extensions/` | Phase 2 重新接入 (通过 EventStore subscribe) | **暂保留接口** |

---

## 9. 迁移计划

### Phase A: EventStore 基础层 (T-01)

1. 实现 `event-store/types.ts` — Event Schema
2. 实现 `event-store/jsonl-store.ts` — JSONL 持久化 + 内存索引
3. 实现 `event-store/workspace.ts` — workspace_id 推导 + 目录结构
4. 单元测试：append, query, subscribe, getCausalChain

### Phase B: Projection 层 (T-02)

5. 实现 `projection/types.ts` — SessionDescriptor
6. 实现 `projection/event-to-message.ts` — Event → AgentMessage 转换
7. 实现 `projection/session-projection.ts` — buildContext
8. 实现 `projection/session-manager.ts` — session index CRUD
9. 实现 `projection/boundary-inferrer.ts` — 基础版（time gap only）
10. 单元测试：context building, fork, session switch

### Phase C: Intent 层 (T-03)

11. 实现 `intent/classifier.ts` — tool call 风险分类
12. 实现 `intent/executor.ts` — 确定性执行 + approval gate
13. 单元测试：classification, approval flow

### Phase D: Runtime 组装

14. 实现 `runtime/agent-loop.ts` — LLM 循环
15. 实现 `runtime/runtime.ts` — 顶层 Runtime 组装
16. 适配 `tools/` — ToolRegistry interface
17. 实现 `runtime/compaction.ts` — 基于 EventStore 的 compaction
18. 集成测试：full prompt → response → tool execution flow

### Phase E: Mode 适配

19. 适配 Interactive Mode — subscribe EventStore 替代旧 event listener
20. 适配 RPC Mode — RPC 命令映射到 EventSourcedRuntime
21. 适配 Print Mode

---

## 10. 关键技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Event ID 格式 | UUIDv7 | 时间有序 + 全局唯一 |
| 持久化格式 | JSONL (一行一事件) | 兼容 append-only、可流式读取 |
| 内存索引 | Map (byId, byType, byCausedBy) | O(1) 查找 |
| Session 存储 | 单独 sessions.json | 轻量，与 event log 解耦 |
| Approval 模型 | EventStore 内 event 驱动 | 可回放、可审计 |
| Context build | 从 EventStore query + filter | 替代树遍历，更灵活 |
| Streaming | EventStore.subscribe 实时推送 | UI 层只需订阅 |
| 工具执行 | IntentExecutor 串行 | 避免并发 file mutation 冲突 |
