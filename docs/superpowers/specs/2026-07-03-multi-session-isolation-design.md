# 单 Workspace 多 Session 隔离

日期：2026-07-03
状态：待评审

---

## 1. 背景与目标

Pizza 需要支持服务端多用户/多请求。选择了「单 workspace 多 session」模型：
多个 session 共享同一个 `events.sqlite`，但各自看到独立的上下文。

**当前问题**：`SessionProjection.buildContext()` 用位置范围查询
（`store.query({after, before})`），同 workspace 内所有 session 的事件会互相
串入上下文。

---

## 2. 隔离机制：session_hint 标签

`EventBase.session_hint`（`types.ts:45`）已是 SQLite 列 + 索引 + query 过滤器，
且当前所有事件均为 null（无人赋值）。

**方案**：

1. 每个 `EventSourcedRuntime` 实例绑定一个 `sessionId`
2. 该 runtime 追加的**所有事件**都带 `session_hint: sessionId`
3. `buildContext()` 在 query 里加 `session_hint: descriptor.session_id`
4. 结果：每个 session 只看到自己的事件，天然隔离

**为何不用 caused_by**：`prompt()` 追加 USER_MESSAGE 时不设 caused_by
（`runtime.ts:197`），每条 USER_MESSAGE 是因果链根节点，链不跨 turn。递归 CTE
只能拿到单个 turn 的事件，无法覆盖整个 session 历史。改 causal 模型风险大
（影响 followup replay、boundary inferrer），不划算。

---

## 3. 架构

```
Server 进程
  └─ Workspace (1× events.sqlite)
       ├─ SqliteEventStore (1 实例, 共享)
       ├─ ExtensionRunner (1 实例, 按 session_hint 过滤事件)
       ├─ SessionManager (1 实例, 管理所有 SessionDescriptor)
       │
       ├─ Session A
       │    ├─ SessionDescriptor (session_id_A)
       │    ├─ EventSourcedRuntime (_isProcessing_A, sessionId=A)
       │    ├─ SessionProjection (query: session_hint=A)
       │    └─ SessionFacade
       │
       └─ Session B
            ├─ SessionDescriptor (session_id_B)
            ├─ EventSourcedRuntime (_isProcessing_B, sessionId=B)
            ├─ SessionProjection (query: session_hint=B)
            └─ SessionFacade
```

不变量：
- **EventStore 单例**：所有 session 共享一个 `SqliteEventStore`（同一 SQLite 文件）
- **Runtime 多例**：每个 session 独立 `EventSourcedRuntime`（独立 `_isProcessing`）
- **并发安全**：Node 单线程 + SQLite 写序列化；多 runtime 交错 append 安全
- **Extension 隔离**：ExtensionRunner 过滤事件到当前 session 的 `session_hint`

---

## 4. 改动清单

### 4.1 EventAppendInput 默认 session_hint

- 文件：`src/core/event-store/store.ts`、`src/core/runtime/runtime.ts`
- `EventSourcedRuntime` 构造时接收 `sessionId`，在所有 `store.append()` 调用里
  注入 `session_hint: this.sessionId`
- 影响的 append 点（runtime.ts）：
  - `prompt()` USER_MESSAGE（197）
  - `steer()` USER_INTERRUPT（277）
  - `followUp()` USER_FOLLOWUP_QUEUED（289）
  - `compact()` COMPACTION_REQUESTED（301）
  - `setModel()` MODEL_CHANGED（316）
  - `setThinkingLevel()` THINKING_LEVEL_CHANGED（335）
  - `setTools()` USER_CONFIG_CHANGE（356）
  - `setSystemPrompt()` USER_CONFIG_CHANGE（370）
  - `abort()` USER_INTERRUPT（251）
  - `approve()` USER_APPROVAL（427）
  - `reject()` USER_REJECTION（438）
  - `createCheckpoint()` CHECKPOINT_CREATED（496）
  - `restoreCheckpoint()` CHECKPOINT_RESTORED（508）
  - `RUNTIME_STARTED`（141）
- Reactor 内的 `_emit()`（reactor.ts:232）也需注入 session_hint

### 4.2 buildContext 按 session_hint 过滤

- 文件：`src/core/projection/session-projection.ts:59`
- `store.query({after, before, types})` → 加 `session_hint: descriptor.session_id`

### 4.3 SessionManager 支持多 active session

- 文件：`src/core/projection/session-manager.ts`
- `activeSessionId: string | undefined` → 保持（SessionManager 仍管理全局描述符）
- 新增 `getSession(sessionId): SessionProjection`（按 ID 取投影，不改全局 active）

### 4.4 工厂支持 per-session facade

- 文件：`src/core/session-facade-factory.ts`
- 新增 `createSessionFacadeForSession(store, sessionManager, sessionId, ...)` 
  轻量工厂：复用 store + extensionRunner，新建 runtime + projection + facade
- 现有 `createSessionFacade()` 保持不变（CLI 单用户场景）

### 4.5 ExtensionRunner 按 session_hint 过滤

- 文件：`src/core/extensions/runner.ts`
- 扩展订阅 EventStore 时，过滤 `event.session_hint === currentSessionId`
- 或：每个 session 的 ExtensionRunner 只订阅自己的事件

---

## 5. 非目标

- 不改 SQLite schema（session_hint 列已存在）
- 不改 caused_by 因果模型（USER_MESSAGE 仍为根）
- 不实现 HTTP server / 多用户认证（本次只做隔离层）
- 不改 CLI 单用户路径（`createSessionFacade()` 行为不变）
- 不做 session 生命周期管理（创建/销毁/超时回收）

---

## 6. 验收标准

- [ ] 同一 workspace 内两个 session 的事件不互相串入 buildContext
- [ ] 每个 runtime 的 `_isProcessing` 独立（A 处理时 B 可同时处理）
- [ ] compaction 按 session_hint 隔离（A 压缩不影响 B）
- [ ] ExtensionRunner 只看到当前 session 的事件
- [ ] 现有单用户 CLI 路径不受影响
- [ ] `npm run check` + 全量测试通过
