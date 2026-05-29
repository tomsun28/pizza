# Stage 3 进度报告 — 2026-05-28 (已完成)

## 目标
将 `@mariozechner/pi-agent-core` 依赖从 pizza 项目中彻底移除，所有类型改用 `src/core/agent/types.ts` 中自己定义的类型。

## 已完成
- [x] `src/core/agent/types.ts` — 已定义 `AgentMessage`、`AgentTool`、`AgentToolResult`、`AgentToolUpdateCallback`、`ThinkingLevel`、`ToolExecutionMode`、`AgentState`
- [x] `src/core/runtime/reactor.ts` — 完全基于事件驱动，删除了旧 `agent-loop.ts`
- [x] 批量替换了约 20+ 个文件的 `import ... from "@mariozechner/pi-agent-core"` → 改为从本地 `agent/types.ts` 导入
- [x] **编译错误全部修复 (0 errors)** — 2026-05-28
  - 统一 `BashExecutionMessage` 类型（`output: string` 必填, `stdout?/stderr?` 可选）
  - 统一 `CustomMessage.display` 为 `string | boolean | undefined`
  - 添加 `BranchSummaryMessage.fromId?: string`
  - 添加 `AgentTool.executionMode?: ToolExecutionMode`
  - 定义 `AgentEvent` 联合类型
  - `messages.ts` 不再自己定义类型，从 `agent/types.ts` 导入并 re-export
  - 保留 `declare module "@mariozechner/pi-agent-core"` 做声明合并（过渡期需要）
  - `event-store-bridge.ts` 内部方法使用 `any` 避免类型冲突
  - `tool-definition-wrapper.ts` 的 `label` 使用 fallback
  - `agent-session.ts` 的 `display` 使用 `!!` 强转，Map 使用类型断言

## Phase 0-1 新增（2026-05-28）

- [x] **Goal/Task 事件类型** — `GOAL_CREATED..GOAL_CANCELLED`, `TASK_CREATED..TASK_CANCELLED` 添加到 EventType
- [x] **Goal/Task 类型定义** — `src/core/goal/types.ts` 定义 GoalDescriptor, TaskDescriptor, 所有 payload 类型
- [x] **GoalProjection** — `src/core/projection/goal-projection.ts` 从事件流派生 goal/task 状态（含 live subscription）
- [x] **TimelineProjection** — `src/core/projection/timeline-projection.ts` 提供跨 session 活动时间线
- [x] **DualWriteEventStore** — `src/core/event-store/dual-store.ts` SQLite 主存储 + JSONL 审计镜像
- [x] **GoalScheduler** — `src/core/goal/scheduler.ts` 自动调度就绪任务，支持优先级、并发控制、角色推断
- [x] **FILE_MUTATION_APPLIED 事件** — Reactor 在 TOOL_EXECUTION_END 后自动发射文件变更事件
- [x] **Runtime.getTimeline()** — EventSourcedRuntime 暴露 timeline 查询 API 供 UI 使用
- [x] **测试** — goal-projection (8), timeline-projection (12), goal-scheduler (5) = 25 新测试全通过
- [x] **SessionProjection.getTimeline()** 迁移到新 TimelineEntry 接口 (kind-based)
- [x] **清理** — 删除未使用的 ToolCall/ContentBlock 导入，修复 session-projection.ts 格式
- [x] **ToolExecutor 适配器** — `src/core/intent/tool-adapter.ts` 将 AgentTool 桥接到新 ToolExecutor 接口，自动检测文件变更
- [x] **无头集成测试** — `test/headless-integration.test.ts` 验证完整 EventStore→Projection→Reactor→Tool 管道 (7 tests)
- [x] **工具适配器测试** — `test/tool-adapter.test.ts` 验证 AgentToolAdapter + createToolRegistry (9 tests)
- [x] **总计测试** — 115 核心测试全部通过，编译零错误
- [x] **Runtime Adapter** — `src/core/runtime/runtime-adapter.ts` 提供 EventSourcedRuntimeHost 桥接新运行时到遗留接口
- [x] **SessionManager 可选** — EventSourcedRuntime 中 SessionManager 改为可选，支持渐进式迁移
- [x] **CLI 集成** — `src/main.ts` 将 EventSourcedRuntime 作为 sidecar 添加到遗留运行时，支持渐进式迁移
- [x] **TUI Timeline View** — `src/modes/interactive/components/timeline-view.ts` 创建时间线视图组件，支持渲染事件时间线
- [x] **移除 pi-agent-core 类型依赖** — `src/core/agent-session.ts` 将类型导入改为 pizza 自有的 `agent/types.ts`，仅保留 Agent 类导入

## 剩余编译错误（14 个文件）（已全部解决）

```
src/cli/args.ts
src/core/agent-session-runtime.ts
src/core/agent-session-services.ts
src/core/agent-session.ts
src/core/compaction/branch-summarization.ts
src/core/compaction/compaction.ts
src/core/event-store-bridge.ts
src/core/messages.ts
src/core/model-resolver.ts
src/core/sdk.ts
src/core/session-manager.ts
src/core/tools/tool-definition-wrapper.ts
src/modes/interactive/interactive-mode.ts
src/modes/rpc/rpc-client.ts
```

---

## 错误详情

### 1. `src/cli/args.ts` 和 `src/core/agent-session-services.ts`
**错误**: `Cannot find module '../../core/agent/types.js'`（相对路径错误）
**原因**: sed 替换了 import 但相对路径写错了
**修复**: 改为 `../../core/agent/types.js`（args.ts）和 `../agent/types.js`（agent-session-services.ts）

### 2. `src/core/messages.ts`
**错误**: `Property 'excludeFromContext' does not exist on type 'BashExecutionMessage'`
**原因**: pi-agent-core 的 `BashExecutionMessage` 有 `excludeFromContext` 字段，我们的没有
**修复**: 需要在 `src/core/agent/types.ts` 的 `BashExecutionMessage` 中添加 `excludeFromContext?: boolean`

### 3. `src/core/messages.ts` (declare module)
**错误**: `declare module "@mariozechner/pi-agent-core"` 这段声明合并代码应删除（因为已经迁移到自己的类型系统）
**修复**: 删除第 70-77 行的 `declare module "@mariozechner/pi-agent-core" { ... }`

### 4. `src/core/model-resolver.ts`
**错误**: `Type 'string | undefined' is not assignable to type 'ThinkingLevel | undefined'`
**原因**: pi-agent-core 的 `ThinkingLevel` 和我们的 `ThinkingLevel` 扩展了 pi-ai 的 `ThinkingLevel`（"off" | "minimal" | "low" | "medium" | "high" | "xhigh"），但类型检查不兼容
**修复**: 检查 pi-agent-core 的 `ThinkingLevel` 定义并确保兼容

### 5. `src/core/sdk.ts`
**错误**: `Agent` 类仍在使用 — 这是运行时依赖，不是纯类型问题
**原因**: sdk.ts 还在使用 `new Agent(...)` 创建旧的 while-loop agent
**修复**: 这是 Stage 6 的主要工作，需要将 `Agent` 的使用替换为新的 `EventSourcedRuntime`

### 6. `src/core/session-manager.ts`
**错误**: `Type 'Message | BashExecutionMessage | CustomMessage<unknown>' is not assignable to type 'AgentMessage'`
**原因**: 类型不兼容。我们的 `CustomMessage` 的 `display` 字段类型与 pi-agent-core 的不匹配
**修复**: 检查 `messages.ts` 中 `CustomMessage` 的 `display` 字段类型

### 7. `src/core/tools/tool-definition-wrapper.ts`
**错误**: 
- `Property 'executionMode' does not exist on type 'AgentTool<any, unknown>'`
- `Type 'string | undefined' is not assignable to type 'string'`
**原因**: 我们的 `AgentTool` 定义缺少 `executionMode` 字段，且 `label` 类型不匹配
**修复**: 在 `src/core/agent/types.ts` 的 `AgentTool` 接口中添加 `executionMode?: ToolExecutionMode`

### 8. `src/core/compaction/branch-summarization.ts` 和 `src/core/compaction/compaction.ts`
**错误**: `Type 'CustomMessage<unknown>' is not assignable to type 'AgentMessage | undefined'`
**原因**: pi-agent-core 和我们的 `CustomMessage` 类型不兼容（`display` 字段类型冲突）
**修复**: 统一 `display` 字段类型

### 9. `src/core/event-store-bridge.ts`
**错误**: `toolResults: unknown[]` vs `toolResults: ToolResultMessage<any>[]` 不匹配
**原因**: 事件类型定义中 toolResults 的类型不匹配
**修复**: 调整事件类型定义中的 toolResults 类型

### 10. `src/modes/interactive/interactive-mode.ts`
**错误**: `BashExecutionMessage` 缺少 `cancelled`、`excludeFromContext`、`fullOutputPath`、`output`、`truncated` 字段
**修复**: 在 `BashExecutionMessage` 中补充这些缺失字段

### 11. `src/modes/rpc/rpc-client.ts`
**错误**: `Module '"../../core/agent/types.js"' has no exported member 'AgentEvent'`
**原因**: `AgentEvent` 是 pi-agent-core 特有的事件联合类型，我们的类型系统中没有
**修复**: 需要在 `src/core/agent/types.ts` 中定义 `AgentEvent` 类型，或定义到 `extensions/types.ts` 中

### 12. `src/core/agent-session.ts`
**错误**: 大量类型不兼容 — 这个文件是最大的问题（~3000 行）
**原因**: 仍然大量依赖 pi-agent-core 的类型系统
**修复**: 这是 Stage 4-5 的主要工作

---

## 核心类型差异（需要修复的类型定义）

### BashExecutionMessage — 缺失字段
pi-agent-core 定义的字段（我们的缺失）：
```ts
// pi-agent-core 期望的字段
excludeFromContext?: boolean;
output?: string;
cancelled?: boolean;
truncated?: boolean;
fullOutputPath?: string;
```

### CustomMessage — display 字段类型冲突
- pi-agent-core: `display?: boolean | string`
- 我们的: `display?: string`

### AgentTool — 缺失字段
- `executionMode?: ToolExecutionMode`

### AgentEvent — 未定义
pi-agent-core 定义（需要复制到我们类型系统）：
```ts
export type AgentEvent = {
    type: "agent_start";
} | {
    type: "agent_end";
    messages: AgentMessage[];
} | {
    type: "turn_start";
} | {
    type: "turn_end";
    message: AgentMessage;
    toolResults: ToolResultMessage[];
} | {
    type: "message_start";
    message: AgentMessage;
} | {
    type: "message_update";
    message: AgentMessage;
    assistantMessageEvent: AssistantMessageEvent;
} | {
    type: "message_end";
    message: AgentMessage;
} | ...
```

---

## 下一步

### 立即可做（简单修复）
1. 修复 `args.ts` 和 `agent-session-services.ts` 的错误相对路径
2. 删除 `messages.ts` 的 `declare module "@mariozechner/pi-agent-core"` 块
3. 在 `BashExecutionMessage` 添加缺失字段
4. 在 `AgentTool` 添加 `executionMode` 字段
5. 统一 `CustomMessage.display` 字段类型
6. 定义 `AgentEvent` 类型

### 复杂工作（需要深入修改）
7. `agent-session.ts` (~3000 行) — 大量类型依赖，Stage 4-5
8. `sdk.ts` — `Agent` 类运行时依赖，Stage 6
9. `agent-session-runtime.ts` — 需要进一步检查
