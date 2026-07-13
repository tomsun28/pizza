# 基于分支树的历史内容记忆方案

## 1. 背景与目标

当前 Pizza 的事件源架构以 `EventStore` 为唯一真相源，所有用户输入、Agent 输出、工具执行、文件变更都作为不可变事件追加。`SessionProjection` 与 `SessionManager` 在此基础上提供了会话视图与切分能力，现有能力包括：

- `session_split` 工具：自动在话题漂移时切分会话。
- `SESSION_FORKED` / `SESSION_BOUNDARY_INFERRED` 事件：记录会话分叉与边界。
- `branch-summarization.ts`：在分支跳转时生成摘要，避免上下文丢失。
- `tree-selector.ts`：以 ASCII 树展示 `SessionTreeNode`。

本方案的目标是在这些已有能力之上，引入一棵**显式的历史记忆树（History Tree）**，让 Agent 能够：

- 通过工具主动跳回历史树中的任意节点继续对话。
- 在旧节点上重开（fork）出新的分支。
- 通过树视图浏览、检索、摘要历史内容。
- 每个树节点都直接映射到事件日志中的具体事件点。
- 控制树的规模，避免历史节点无限膨胀。

## 2. 核心概念

| 概念 | 说明 | 与现有代码的映射 |
|---|---|---|
| **Event Log** | 唯一真相源，所有事件追加存储。 | `SqliteEventStore` |
| **History Tree** | 由历史 Session 组成的树，每个节点是一次会话。 | `SessionIndex` / `sessions.json` |
| **Node** | 历史树节点，对应一个 `SessionDescriptor`。 | `SessionDescriptor` |
| **Current Leaf** | 当前活跃 session。 | `SessionManager.activeSessionId` |
| **Branch** | 从某个 Session fork 出的新会话。 | `SESSION_FORKED` + `SessionDescriptor` |
| **Summary Node** | 被压缩或摘要后的会话分支。 | `BRANCH_SUMMARY` / `COMPACTION_END` |

关键点：**历史树节点就是 Session**。节点只保存 session 元数据（id、标题、父 session、event_range），不直接存储消息。消息内容通过 `event_range` 从 `EventStore` 按需重建。

## 3. 历史树 = Session 树

`SessionManager` 已维护 `sessions` 索引，其中 `SessionDescriptor` 包含：

```typescript
interface SessionDescriptor {
  session_id: string;
  thread_id: string;
  workspace_id: string;
  event_range: { start_event_id: string; end_event_id: string };
  summary_event_id?: string;
  name?: string;
  created_by: "user_explicit" | "fork";
  boundary_reason?: string;
  parent_session_id?: string;
  created_at: number;
}
```

由 `session_id`、`parent_session_id`、`event_range` 已可直接构成一棵历史树。`SessionManager` 的 `listSessions()` 提供所有 session，运行时按 `parent_session_id` 组织成树。

**不需要新增 `history-tree.json`。** 历史树直接使用 `SessionIndex`（`sessions.json`）作为索引；需要查看或跳转时，再按 `event_range` 查询 `SqliteEventStore` 中的事件。

## 4. 与事件日志的映射

每个历史树节点（Session）通过 `event_range` 映射到事件日志：

- `start_event_id`：该 session 的起点事件。
- `end_event_id`：该 session 的终点事件，`"HEAD"` 表示仍在继续。
- `summary_event_id`：可选，指向 `COMPACTION_END` 摘要事件。

### 4.1 节点到事件点

- `view`：直接使用 `SessionProjection(descriptor).buildContext()` 重建该 session 的上下文。
- `jump`：切换到某个历史 session 并继续。若目标 session 仍活跃（`end_event_id === "HEAD"`），直接 `SessionManager.switchTo(session_id)`；若已关闭，从它的 `start_event_id` 创建新 session，相当于“重开”。
- `fork`：从目标 session 的 `end_event_id` 创建新 session，作为该 session 的后续分支。

### 4.2 需要新增/复用的事件

复用：

- `SESSION_CREATED`：记录 session 创建。
- `SESSION_FORKED`：记录 session 分叉。
- `SESSION_BOUNDARY_INFERRED`：记录 session 切分。
- `BRANCH_SUMMARY`：记录分支摘要。
- `COMPACTION_END`：记录压缩摘要。

可选新增（审计）：

- `HISTORY_TREE_JUMP_REQUESTED` / `HISTORY_TREE_JUMPED`：记录 Agent 跳转请求与完成。

## 5. Agent 操作接口：`history_tree` 工具

```typescript
interface HistoryTreeToolInput {
  action: "jump" | "fork" | "view" | "list" | "summarize";
  session_id?: string;
  query?: string;          // 用于 list 搜索标题或内容
  filters?: {
    from?: number;         // 时间戳
    to?: number;
  };
  reason?: string;
}
```

### 5.1 各 action 语义

- **list**：返回历史树的可读摘要列表。格式：`[{session_id, name, created_at, is_active, depth, parent_session_id, child_count}]`。
- **view**：返回某个 `session_id` 的上下文摘要（前 N 条消息），不切换当前会话。
- **jump**：切换到指定 `session_id` 继续对话。活跃 session 直接 `switchTo`；已关闭 session 从 `start_event_id` 创建新 session。
- **fork**：从指定 `session_id` 的 `end_event_id` 创建新 session，生成 `SESSION_FORKED` 事件。
- **summarize**：对某个 session 的完整分支生成 `BRANCH_SUMMARY` 并记录到 `summary_event_id`。

### 5.2 LLM 使用示例

- 用户：“回到之前改 `cli/args.ts` 的地方。”
  1. Agent `list` 搜索 `cli/args.ts`。
  2. Agent `view` 对应 session 确认上下文。
  3. Agent `jump` 到目标 session。

- 用户：“试试另一种实现方案。”
  1. Agent `fork` 当前 session。
  2. 新分支从当前 session 的 `end_event_id` 继续，原 session 保持不变。

## 6. 上下文重建与分支摘要

### 6.1 跳回旧 session 时的上下文

- `jump` 到目标 session 时，如果其 `summary_event_id` 存在，先注入 `compactionSummary` 或 `branchSummary`。
- 使用 `SessionProjection` 按 `event_range` 查询 `EventStore`，构建消息列表。
- 如果 `jump` 离开了一条有未提交探索的兄弟分支，先生成该分支的 `BRANCH_SUMMARY`，再注入新上下文。
- 不复制事件，只改变 `SessionDescriptor.event_range`。

### 6.2 复用 `branch-summarization.ts`

`collectEntriesForBranchSummary` 与 `generateBranchSummary` 可以收集从当前 leaf 到目标 session 之间的 `SessionEntry`，生成摘要并写入 `BRANCH_SUMMARY` 事件。

## 7. 树规模控制（重点）

历史树节点是 session，所以规模由 session 数量控制。

### 7.1 Session 数量控制

- 配置 `max_sessions_per_workspace`（例如 500）。
- 每个 workspace 的 `sessions.json` 只保留最近/最常访问的 session。
- 当 session 数量超过阈值，将旧的、非当前路径的 session 归档。

### 7.2 归档策略

- 对旧 session 调用 `CompactionEngine`，将 `event_range` 内事件压缩为 `COMPACTION_END`。
- 归档后保留 `SessionDescriptor`，但将 `event_range` 替换为摘要，`summary_event_id` 指向压缩事件。
- 被归档 session 仍可通过 `view` 查看摘要，但不再默认展开完整时间线。

### 7.3 树视图分层

给 Agent 展示时，不必返回整棵树：

- 当前路径（root → current leaf）完整。
- 兄弟分支只返回一级。
- 更深分支按需 `expand`。
- `list` 支持 `cursor` / `limit` 分页。

### 7.4 最大深度与宽度

```typescript
interface HistoryTreePolicy {
  max_sessions_per_workspace: number; // 例如 500
  max_branch_depth: number;            // 例如 50
  max_children_per_session: number;    // 例如 20
  archive_after_idle_ms: number;       // 例如 7 天
}
```

超过阈值时，优先归档 `last_accessed_at` 最旧、且非当前路径的分支。

## 8. 与现有模块的集成

### 8.1 核心模块

- `SessionManager`：已有 `listSessions()`、`switchTo()`、`getSession()`、`forkAt()`、`createSession()`。新增 `jumpToSession(session_id)`、`forkFromSession(session_id)` 即可。
- `EventStoreExtensionSessionManager`：暴露 `historyTree` 方法给工具。
- `EventStore`：无需改动，按 `event_range` 查询事件。
- `TimelineProjection` / `SessionProjection`：用于 `view` 与 `jump` 的上下文。
- `CompactionEngine`：用于归档旧 session。

### 8.2 工具注册

在 `src/core/tools/index.ts` 新增 `createHistoryTreeToolDefinition`，在 `session-facade-factory.ts` 注册到 `availableToolDefinitions`。

### 8.3 UI 集成

- `tree-selector.ts` 直接复用 `SessionTreeNode` 或新增 `SessionHistoryTreeNode` 展示。
- `interactive-mode.ts` 新增 `/history` 或 `/sessions` slash 命令。
- 快捷键：`Ctrl-H` 呼出历史 session 选择器。

### 8.4 持久化

- 直接使用 `~/.pizza/agent/workspaces/<workspace_id>/sessions.json`。
- 不新增 `history-tree.json`。
- 将来若要把 session 索引迁移到 `SqliteEventStore`，需要给 `SESSION_CREATED` 事件增加 `start_event_id` 字段，并补充 `SESSION_ENDED` 事件记录 `end_event_id`，否则无法从事件日志重建 `event_range`。

## 9. 实现阶段

1. **阶段 1：复用 `SessionManager` 构建历史树**
   - 在 `SessionManager` 或 `HistoryTreeManager` 中按 `parent_session_id` 组织 session 树。
   - 提供 `list` / `view` 查询接口。

2. **阶段 2：Agent 工具**
   - 实现 `history_tree` 的 `list` / `view`。
   - 注册工具。

3. **阶段 3：跳转与分支**
   - 实现 `jump` / `fork`。
   - 复用 `branch-summarization.ts` 生成离开分支摘要。
   - 集成 `SessionManager`。

4. **阶段 4：规模控制**
   - 实现 session 数量限制、LRU 归档、`COMPACTION_END` 压缩。

5. **阶段 5：UI 集成**
   - 扩展 `tree-selector` 与 `interactive-mode`。
   - 增加 slash 命令与快捷键。

## 10. 待确认问题

- 历史树是按 `thread_id` 隔离，还是按 `workspace_id` 全局？
- `jump` 是否允许跨 `workspace_id`？
- 是否需要把 `SessionIndex` 迁移到 `SqliteEventStore` 以单源化？
- 是否允许 Agent 自动 `jump` 而不经用户确认？
- 归档后是否删除 `sessions.json` 中的 `SessionDescriptor`，还是保留并标记 `archived`？
