# Pizza 架构现状

最后更新：2026-05-29

本文档反映 pizza 当前真实的代码组织，覆盖运行时、Agent 抽象、事件溯源、扩展点。
历史决策与已完成的迁移阶段见 `STAGE3_REMAINING.md`。

---

## 1. 运行时分层

pizza 当前并存 **两套运行时**：

```
┌──────────────────────────────────────────┐
│  Modes (interactive / rpc / print)       │
└─────────────┬────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────┐
│  AgentSession  (3000+ 行)                │
│  - 持有 Agent 实例 + SessionManager     │
│  - 扩展系统 / 工具注册 / 系统提示组装    │
│  - Compaction / branch summary           │
│  - Bash 执行 / HTML 导出 / 滚动           │
└─────────────┬────────────────────────────┘
              │
              ▼
┌──────────────┴───────────────┬──────────────────────┐
│  Agent (旧 loop, 主路径)     │  EventSourcedRuntime │
│  src/core/agent/             │  src/core/runtime/   │
│  (本次会话从 pi-agent-core   │  (sidecar, 暂未驱动业务)
│   迁入并 owned)              │                      │
└──────────────────────────────┴──────────────────────┘
```

### 1.1 旧运行时 (`src/core/agent/`)

**入口**：`AgentSession` → `Agent` → `agent-loop`

- `agent.ts` (430 行)：有状态包装，持有消息/工具/模型/订阅；暴露 `prompt/continue/steer/followUp/abort/waitForIdle/reset` 等方法
- `agent-loop.ts` (585 行)：低级 turn 循环，处理流式响应、工具并行/串行执行、steering/follow-up 队列
- `types.ts`：所有公共类型（`AgentMessage`、`AgentTool`、`AgentEvent`、`AgentLoopConfig` 等）
- `index.ts`：唯一对外入口

> 这套代码原本来自 `@mariozechner/pi-agent-core` npm 包，2026-05-29 内聚为 pizza 自有代码，npm 依赖彻底移除。

### 1.2 新运行时 (`src/core/runtime/` + `src/core/event-store/`)

**入口**：`EventSourcedRuntime` → `Reactor` → `EventStore` (SQLite)

- `event-store/`：Append-only 事件存储，按 workspace 分库
- `runtime/reactor.ts` (931 行)：事件驱动的 turn 循环，handler 表替代 while-loop
- `runtime/runtime.ts`：组装 store + reactor + intentExecutor
- `runtime/runtime-adapter.ts`：把新运行时桥接成旧 `AgentSessionRuntime` 接口（session 操作仍 delegate 给旧）
- `projection/`：从事件流派生 session / timeline / goal 状态
- `intent/`：工具调用的 classification + approval gating

**当前角色**：作为 sidecar 跟旧运行时并行跑，记录所有事件供 timeline / projection / checkpoint 使用，但 **prompt / 流式响应 / extension hooks 仍走旧路径**。

---

## 2. 待完成迁移（Stage 4-6）

把旧 `Agent` loop 完全替换为 reactor 还需要：

### 2.1 reactor 基建补齐
- [ ] LLM streaming chunk 事件：reactor 当前跳过 chunk，UI 看不到打字效果
- [ ] 新增事件类型：BASH_EXECUTION / CUSTOM_MESSAGE / BRANCH_SUMMARY
- [ ] `event-to-message.ts` 支持完整 `AgentMessage[]` 重建（目前只处理 3 种事件）
- [ ] reactor 暴露 `beforeToolCall` / `afterToolCall` hook（extension 拦截依赖）
- [ ] compaction 在事件溯源下的语义：作废旧事件 + 注入 summary 事件，而不是覆盖 `state.messages`

### 2.2 AgentSession 改造
- [ ] 54 处 `this.agent.*` 调用改写
- [ ] `_handleAgentEvent` 9 种 `AgentEvent` 映射到对应 `EventBase`
- [ ] `state.messages` 读取改为 `projection.buildContext()`
- [ ] `state.messages = ...` 写入改为事件追加

### 2.3 消费方迁移
- [ ] `interactive-mode.ts` (4916 行) 订阅 9 种 `AgentEvent` → 订阅 `EventStore`
- [ ] `rpc-mode.ts` / `rpc-client.ts` 同上
- [ ] `compaction/compaction.ts` (839 行) 重写为事件流操作

---

## 3. 关键文件入口

| 文件 | 用途 |
|---|---|
| `src/cli.ts` | CLI 入口 |
| `src/core/sdk.ts` | `createAgentSession()` 工厂 |
| `src/core/agent-session.ts` | 主 AgentSession 类 |
| `src/core/agent-session-runtime.ts` | 包装 AgentSession + EventStore |
| `src/core/agent/index.ts` | 旧 Agent loop（pizza owned） |
| `src/core/runtime/runtime.ts` | EventSourcedRuntime |
| `src/core/runtime/reactor.ts` | 事件驱动 turn 循环 |
| `src/core/event-store/sqlite-store.ts` | 事件存储 SQLite 实现 |
| `src/core/projection/session-projection.ts` | LLM 上下文构建 |
| `src/core/extensions/loader.ts` | 扩展加载（jiti） |
| `src/modes/interactive/interactive-mode.ts` | 交互模式 TUI |
| `src/modes/rpc/rpc-mode.ts` | RPC 模式 |

---

## 4. 外部依赖

唯一保留的运行时核心依赖：

- `@mariozechner/pi-ai`：LLM 协议层（streamSimple、Provider、Model 类型）
- `@mariozechner/pi-tui`：TUI 渲染
- `@mariozechner/jiti`：扩展加载（带 virtualModules 支持）
- `@sinclair/typebox`：工具参数 schema

不再依赖：

- ❌ `@mariozechner/pi-agent-core`（2026-05-29 移除，代码已内聚到 `src/core/agent/`）

为兼容历史扩展中 `import "@mariozechner/pi-agent-core"`，`extensions/loader.ts` 的 alias / virtualModules 把该 specifier 映射到本地 `src/core/agent/index.js`。
