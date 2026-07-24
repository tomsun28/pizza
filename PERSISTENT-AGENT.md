# 持久化 Agent 设计文档（`~/.pizza/main`）

## 1. 背景与动机

当前 Pizza 的所有 workspace 被一视同仁，差异只来自 `cwd`：

- **workspace 身份**：`deriveWorkspaceId(cwd)`，每个 cwd 一个独立 SQLite 事件库。
- **system prompt**：`buildSystemPrompt()` 输入只有 `customPrompt / appendSystemPrompt / contextFiles(AGENTS.md|CLAUDE.md) / skills / tools / cwd`，没有"身份/灵魂"概念。
- **资源加载**：`DefaultResourceLoader` 只从 `agentDir` + cwd 祖先链找 `AGENTS.md/CLAUDE.md`。
- **harness**：`createSessionFacade()` 对任何 cwd 走完全相同的装配。
- **compaction**：`SUMMARIZATION_PROMPT` 只保留 Goal/Constraints/Progress，身份信息会被压缩成普通文本丢失。

`~/.pizza/main` 要成为一个**常驻人格 agent**（类似 OpenClaw 的持久化 agent），与普通 per-project workspace 区别对待：拥有灵魂文件、长期记忆。

**单实例，可选常驻**：main agent 全局只允许一个实例运行。既支持前台交互模式（`pizza --main`，用完即退），也支持常驻后台模式（`pizza --main --daemon`，进程持续运行，多个用户会话在同一进程内交替创建和结束）。两种模式下记忆和灵魂机制完全一致，区别仅在于进程生命周期。

## 2. 设计目标

| 维度 | 普通 workspace | `~/.pizza/main` |
|---|---|---|
| 身份 | 无（通用 coding assistant） | 灵魂文件定义人格 |
| 记忆 | 仅当次会话 + AGENTS.md | 长期记忆库|
| 工作范围 | 绑定单个 cwd | 固定为 main dir（默认 `~/.pizza/main`，可配置），通过 delegate_agent 操作其它项目 |
| 压缩 | 标准 Goal/Progress 摘要 | 同左，灵魂/记忆靠每次重建 prompt 自我恢复 |

## 3. 文件布局

```
~/.pizza/
├── agent/                      # 全局（models/auth/settings/themes，已有）
└── main/                       # 持久化 agent 工作空间（新增）
    ├── SOUL.md                 # 灵魂文件：人格、价值观、沟通风格、长期目标
    ├── AGENTS.md               # main 自身的工作指令（可选，叠加在 SOUL 之上）
    ├── memory/                 # 长期记忆库（agent 可读写）
    │   ├── _index.md           # 记忆索引（自动维护）
    │   ├── user-profile.md     # 关于用户的长期事实
    │   └── projects.md         # 跨项目的工作上下文
```

### SOUL.md 形态

灵魂文件不是项目指令，是身份：

```markdown
---
description: Aria 的灵魂定义——跨项目、跨时间存在的长期编程伙伴人格。
tags: [identity, soul, persistent-agent, memory]
---
# Identity
你是 Aria，用户的长期编程伙伴。你跨项目、跨时间存在。

# Values
- 主动记忆用户偏好与历史决策
- 在新会话开始时回顾相关记忆
- ...

# Voice
简洁、直接、有判断力。
```

`AGENTS.md`（可选）叠加在 SOUL 之上，承载 main 自身的工作流指令（例如"每次会话结束前更新 memory/_index.md"），与项目级 AGENTS.md 区分。

## 3.1 `isMainAgent` 判定方式

判定方案：**cwd 匹配 main agent 工作目录**。main agent 的 cwd 固定为其工作目录（默认 `~/.pizza/main`），不指向其它项目。工作目录可通过 `--main-dir <path>` 配置。

- `pizza --main`：启动时进入 main agent 模式（前台交互），cwd = main dir
- `pizza --main --daemon`：常驻后台模式

`CreateSessionFacadeOptions` 增加 `isMainAgent?: boolean`，由 CLI 参数解析层注入。判定逻辑：`cwd === mainDir`。

### UI 集成

在客户端 UI（Desktop / Web）中，main agent 就是现有 **CHAT 菜单按钮**对应的 agent，不新增 UI 入口。用户点击 CHAT 时，底层连接的就是 main agent 的 session facade（`isMainAgent = true`）。其它 workspace（per-project）通过各自的 workspace pane 连接，`isMainAgent = false`。

这意味着：
- Desktop 的 `BridgeState` 需要识别 CHAT 对应的 sidecar 进程为 main agent，启动时加 `--main` flag
- Web 端的 transport 层同理，CHAT 连接的 RPC 通道走 main agent 进程
- UI 侧无需感知"灵魂/记忆"概念，这些完全在 system prompt 层面处理

## 4. System Prompt 拼接改造

在 `buildSystemPrompt`（`src/core/system-prompt.ts`）增加可选段，**仅 main agent 传入**，普通 workspace 行为不变。

`BuildSystemPromptOptions` 扩展：

```ts
export interface BuildSystemPromptOptions {
  // ...existing...
  /** 灵魂文件，置于 prompt 最顶部（main agent 专用） */
  soulFile?: { path: string; content: string };
  /** 长期记忆条目，置于灵魂之后、正文之前 */
  longTermMemory?: Array<{ path: string; content: string }>;
  /** 是否为 main agent，影响 guidelines 措辞与拼接顺序 */
  isMainAgent?: boolean;
}
```

拼接顺序（main 路径）：

1. `# Identity` ← `soulFile.content`（**永不压缩**，见第 7 节）
2. `# Long-Term Memory` ← `longTermMemory`（每次启动从 `memory/*.md` 装载）
3. 原有正文（tools / guidelines / builtinCommands）
4. `# Project Context` ← 当前指向项目的 AGENTS.md（如果 main 被指向某 repo）
5. skills / environment / breadcrumb

`isMainAgent` 时**追加** main agent guidelines（不替换原有 tool-related guidelines，因为部分 guidelines 依赖 tool availability，如 `hasCli`）。在现有 guidelines 列表末尾追加（`{memoryDir}` 为实际记忆目录路径，由 `--memory-dir` 决定）：

- "开始新话题前先回顾相关长期记忆"
- `"当学到关于用户的稳定事实时，写入 ${memoryDir} 下对应文件"`
- `"发现记忆中过时或不准确的信息时，主动更新或删除对应文件"`
- "你可以通过 `delegate_agent` 工具将任务委派到其它项目目录的子 agent（见第 8 节）"

## 5. 资源加载器特化

`ResourceLoader` 接口扩展（`src/core/resource-loader.ts`）：

```ts
export interface ResourceLoader {
  // ...existing...
  getSoulFile?(): { path: string; content: string } | undefined;
  getLongTermMemory?(): Array<{ path: string; content: string }>;
}
```

在 `DefaultResourceLoader.reload()` 里，当 `isMainAgent` 时额外加载：

- `{soulPath}`（默认 `~/.pizza/main/SOUL.md`）→ `getSoulFile()`
- `{memoryDir}/*.md`（默认 `~/.pizza/main/memory/`）→ `getLongTermMemory()`
- 仍调用 `loadProjectContextFiles` 加载当前 project 的 AGENTS.md（main 可被 `--cwd` 指向某 repo）

`createSessionFacade` 的 `buildPromptForTools` 把这两个值透传给 `buildSystemPrompt`。

### 5.1 `_index.md` 一致性检查

`_index.md` 由 LLM 通过 guidelines 引导维护，但 LLM 可能漏更新或格式错误。`getLongTermMemory()` 启动加载时应**扫描 `memory/` 目录**，对比 `_index.md` 中列出的条目：

- 目录中有文件但 `_index.md` 未列出 → 自动补一行占位条目（文件名 + "(unindexed)"）
- `_index.md` 列出但目录中不存在 → 标记为 stale

这保证选择性加载不会因 `_index.md` 过时而漏掉记忆文件。

## 6. Harness 差异化（核心）

在 `createSessionFacade`（`src/core/session-facade-factory.ts`）增加 `isMainAgent` 分支。

### 6.1 长期记忆：直接用现有文件工具

不引入专用 `memory` 工具。`~/.pizza/main/memory/*.md` 就是普通 markdown 文件，agent 用现有的 `read` / `write` / `edit` / `grep` 直接操作：

- 读：`read ~/.pizza/main/memory/user-profile.md`
- 写：`write ~/.pizza/main/memory/<topic>.md ...`
- 搜索：`grep -r "keyword" ~/.pizza/main/memory/`

连续性靠两点保证，都不需要新工具：
1. **加载时注入**：`getLongTermMemory()` 把 `memory/*.md` 装载进 system prompt（见第 5 节）
2. **guidelines 引导**：`isMainAgent` 时在 guidelines 里写明 memory 目录路径和写入时机

### 6.2 首次运行初始化

第一次 `pizza --main` 时 `~/.pizza/main/` 不存在。初始化逻辑：

1. 创建 `~/.pizza/main/` + `~/.pizza/main/memory/` 目录
2. 写入默认 `SOUL.md` 模板（包含 Identity/Values/Voice 占位段，提示用户自定义）
3. 创建 `memory/_index.md`（空索引）+ `memory/user-profile.md`（空模板）
4. 输出提示："Main agent 已初始化，编辑 ~/.pizza/main/SOUL.md 定义你的人格"

## 7. Compaction 策略

main agent 的 compaction 与普通 workspace 相同（`SUMMARIZATION_PROMPT` 保留 Goal/Constraints/Progress），但有两个关键区别：

### 7.1 灵魂文件永不压缩

`SOUL.md` 放在 system prompt 最顶部，不属于对话历史。compaction 只压缩 EventStore 中的对话消息，system prompt 在每次 `refreshSystemPromptWithBreadcrumb` 或新一轮 turn 时从 `buildPromptForTools` 重建。因此灵魂文件天然不受 compaction 影响。

### 7.2 长期记忆持久化在磁盘文件中

长期记忆以 markdown 文件形式存储在 `memory/` 目录下。agent 通过 `read`/`write`/`edit`/`grep` 工具操作这些文件，这些 tool call 会进入 EventStore 对话历史，**会被 compaction 压缩**。但记忆文件本身持久存在于磁盘上，不受 compaction 影响。

compaction 后，记忆不会丢失，因为：
1. **文件在磁盘**：`memory/*.md` 是真实文件，compaction 只压缩 EventStore 中的对话消息
2. **system prompt 重建**：每次 session 边界通过 `getLongTermMemory()` 从磁盘重新加载到 system prompt

**时序问题**：agent 在会话中途写入新记忆文件后，当前会话的 system prompt 不会自动更新——`refreshSystemPromptWithBreadcrumb`（`session-facade-factory.ts:437`）只调用 `buildPromptForTools`，后者读取的是 `resourceLoader` **已缓存的值**，不会重新执行 `reload()` 去读 `memory/*.md`。

由于 main agent 是**常驻后台进程**，进程不会在 session 之间重启，因此不能依赖"下次进程启动"来刷新记忆。解决方案：在 `session_split` 等会话边界事件触发 `refreshSystemPromptWithBreadcrumb` 时，**先调用 `resourceLoader.reload()` 再重建 prompt**。这样每次新 session 开始时都会从磁盘重新加载记忆。

修改点：`refreshSystemPromptWithBreadcrumb`（`session-facade-factory.ts:437`）在 `isMainAgent` 时改为：

```ts
const refreshSystemPromptWithBreadcrumb = async (): Promise<string> => {
  if (isMainAgent) {
    await resourceLoader.reload();  // 重新读 memory/*.md
  }
  systemPrompt = buildPromptForTools(activeToolDefinitions);
  // ...
};
```

guidelines 中应告知 agent："写入记忆后，在下一个 session（session_split 后）自动加载到 system prompt。"

### 7.3 记忆加载策略：只加载索引

`getLongTermMemory()` 只装载 `memory/_index.md` 到 system prompt，不加载其它记忆文件。agent 通过 `read`/`grep` 工具按需读取具体记忆文件，通过 `write`/`edit` 更新。

这样：
- system prompt 只增加索引的 token 开销（可控）
- agent 从索引中得知有哪些记忆文件及摘要，需要时自行 `read` 加载
- 无需 token 预算截断逻辑

guidelines 中应引导 agent："记忆索引在 system prompt 中，需要查看具体记忆时用 `read` 读取对应文件。"

## 8. 跨 Workspace 编排

main agent 的核心能力之一是**指挥其它 workspace 的 agent**。当前架构中每个 workspace 完全独立（`deriveWorkspaceId(cwd)` → 独立 SQLite EventStore），不存在 sub-agent spawning 或跨 workspace 通信机制。

### 8.1 现有 RPC 通信基础设施

Pizza 已有成熟的进程间通信体系，可直接复用：

- **RPC 协议**（`packages/protocol/index.ts`）：JSON-over-stdio，支持 `prompt`/`steer`/`follow_up`/`abort`/`get_state`/`get_messages` 等完整命令集
- **RPC 服务端**（`packages/rpc/rpc-mode.ts`）：`runRpcModeWithFacade(facade)` 接管 stdin/stdout，将 `SessionFacade` 暴露为 JSON 命令接口，所有 EventStore 事件实时推送到 stdout
- **RPC 客户端**（`packages/rpc/rpc-client.ts`）：`RpcClient` 类封装了子进程 spawn + 命令发送 + 事件接收 + 等待完成的完整流程
- **Desktop 多 Sidecar**（`apps/desktop/src/bridge.rs`）：`BridgeState` 已实现按 cwd 管理多个 `pizza --mode rpc` 子进程的编排器，事件按 cwd 标签路由

### 8.2 分阶段方案

#### Phase 1：Shell 委派（零代码改动）

在 `isMainAgent` guidelines 中告知 main agent 可以用 `cli` 工具直接调用 pizza CLI：

```bash
pizza --cwd /path/to/project "fix the auth bug in login.ts"
```

- **优点**：零代码改动，立即可用
- **缺点**：同步阻塞，输出是纯文本，无法中途 steer/abort，main agent context 被子 agent 输出撑大

#### Phase 2：`delegate_agent` 工具 + `RpcClient`（同步模式）

在 `createSessionFacade` 的 `isMainAgent` 分支中注册 `delegate_agent` 工具，内部使用 `RpcClient`：

```ts
// delegate 工具核心逻辑（伪代码）
async function delegate(args: {
  cwd: string;
  task: string;
  timeout?: number;
}): Promise<ToolExecutionResult> {
  // ⚠️ cliPath 必须是绝对路径，且需区分 node 模式与二进制模式
  // RpcClient 默认 cliPath = "dist/cli.js" 是相对路径，spawn cwd = 委派目标目录，会找不到
  const isBinary = !process.argv[1]?.endsWith('.js'); // bun compile 后 process.execPath 是二进制
  const cliPath = isBinary
    ? process.execPath              // 编译后的单文件二进制
    : process.argv[1];              // node 模式下当前 cli.js 绝对路径

  const client = new RpcClient({
    cwd: args.cwd,
    cliPath,                        // 必须显式传入绝对路径
    // 共享 ~/.pizza/agent 凭证（见下方 Auth 注意事项）
  });
  await client.start();

  try {
    // promptAndWait = prompt + collectEvents(直到 AGENT_TURN_COMPLETED)
    await client.promptAndWait(args.task, undefined, args.timeout ?? 120000);
    const text = await client.getLastAssistantText();
    return {
      content: [{ type: "text", text: text ?? "(no response)" }],
      is_error: false,
    };
  } finally {
    await client.stop();
  }
}
```

> **⚠️ 二进制分发注意**：`RpcClient` 默认 `cliPath = "dist/cli.js"` 且 `spawn("node", ...)` 硬编码。`package.json` 的 `build:binary`（`bun build --compile`）产物既无 `node` 也无 `dist/cli.js`。`delegate` 实现时**必须**显式传入 `cliPath` 绝对路径，并在二进制模式下使用 `process.execPath`。

- **优点**：结构化结果返回（只把最终摘要给 main agent，不撑大 context）；子 agent 有独立 EventStore、独立 compaction；`RpcClient` 已有全部所需 API（`promptAndWait`、`getLastAssistantText`），无需改动 `packages/rpc/`
- **缺点**：每次 delegate 都 spawn 新进程（启动开销 ~100ms）；同步阻塞，main agent 等待子 agent 完成
- **Auth 共享**：`RpcClient` spawn 的子进程继承 `process.env`，默认读取 `~/.pizza/agent/auth.json`，与 main agent 共享同一套凭证。
  > **⚠️ agentDir 对齐**：如果 main agent 使用了非默认 `agentDir`（如 `--agent-dir /custom/path`），子进程仍走默认 `getAgentDir()`，会读错 auth 文件。此时需在 `RpcClientOptions.env` 中显式传递 `PIZZA_AGENT_DIR` 或在子进程 args 中加 `--agent-dir`。

#### Phase 3：异步 delegate_agent + 事件流

扩展 `delegate_agent` 工具支持 `mode: "async"`，引入 `AgentOrchestrator` 管理常驻子 agent：

```ts
// 异步模式：返回 agent_id，事件通过 SUB_AGENT_EVENT 转发到 main EventStore
async function delegate(args: {
  cwd: string;
  task: string;
  mode: "async";
}): Promise<ToolExecutionResult> {
  const client = new RpcClient({ cwd: args.cwd });
  await client.start();
  const agentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 子 agent 事件回流到 main agent 的 EventStore
  client.onEvent((event) => {
    store.append({
      actor_id: "sub_agent",
      type: "SUB_AGENT_EVENT",
      payload: { agent_id: agentId, event },
      thread_id: currentThreadId(),
    });
  });

  void client.prompt(args.task);  // fire and forget
  return {
    content: [{ type: "text", text: `Delegated to ${agentId}. Use check_delegate to query status.` }],
    is_error: false,
  };
}
```

`AgentOrchestrator` 结构与 desktop 的 `BridgeState`（`bridge.rs:130`）一致，只是从 Rust 移到 TypeScript：

```ts
class AgentOrchestrator {
  private subAgents = new Map<string, RpcClient>();

  async spawn(cwd: string): Promise<string> { /* ... */ }
  async delegate(agentId: string, task: string): Promise<void> { /* ... */ }
  async steer(agentId: string, message: string): Promise<void> { /* ... */ }
  async abort(agentId: string): Promise<void> { /* ... */ }
  async getStatus(agentId: string): Promise<RpcSessionState> { /* ... */ }
  async dispose(agentId: string): Promise<void> { /* ... */ }
}
```

- **优点**：子 agent 常驻，可连续下达多个任务；支持 steer/abort；事件流可观测
- **缺点**：复杂度最高；多 LLM 连接并发管理；需要并发数限制（semaphore）

### 8.3 `delegate_agent` 工具定义

```ts
// 仅在 isMainAgent 时注册，普通 workspace 不暴露
{
  name: "delegate_agent",
  description: "将任务委派到另一个项目目录的子 agent 执行",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "目标项目目录" },
      task: { type: "string", description: "委派的任务描述" },
      timeout: { type: "number", description: "超时毫秒数（默认 120000）" },
    },
    required: ["cwd", "task"],
  },
  promptSnippet: "delegate_agent: 在另一个项目目录中启动子 agent 执行任务，返回最终结果",
  promptGuidelines: [
    "使用 delegate 工具将跨项目的任务委派给子 agent，避免在当前 context 中处理其它项目的代码",
    "delegate 返回的是子 agent 的最终回复摘要，中间过程不会进入当前 context",
  ],
}
```

### 8.4 记忆与编排的协作

`~/.pizza/main/memory/projects.md` 作为 main agent 的"项目注册表"，维护跨项目的工作上下文：

```markdown
# Projects

## pizza (~/code/agent/pizza)
- 状态：活跃开发
- 上次委派：2026-07-22 修复 auth 模块的 token 刷新 bug
- 待办：review PR #42

## my-app (~/code/my-app)
- 状态：维护中
- 上次委派：2026-07-20 升级依赖到 React 19
```

main agent 在 `delegate` 完成后自动更新 `projects.md`（通过 guidelines 引导，不需要专用工具）。

## 9. 落地顺序

1. **定义 `isMainAgent` 触发条件**：CLI 加 `--main` flag，`CreateSessionFacadeOptions` 加 `isMainAgent` 字段（不依赖 cwd 判定）
2. **首次运行初始化**：创建 `~/.pizza/main/` 目录结构 + 默认 SOUL.md 模板 + 单实例 lockfile
3. `buildSystemPrompt` 加 `soulFile / longTermMemory / isMainAgent`（纯加法，不破坏现有）
4. `ResourceLoader` 加 `getSoulFile / getLongTermMemory`（只加载 `_index.md`）+ `_index.md` 一致性检查
5. `createSessionFacade` 加 `isMainAgent` 分支 + 透传灵魂/记忆
6. **memory 刷新**：`refreshSystemPromptWithBreadcrumb` 在 `isMainAgent` 时先 `reload()` 再重建 prompt
7. Phase 1：在 `isMainAgent` guidelines 中加入 shell 委派提示（零代码改动，注意二进制分发下的执行路径）
8. Phase 2：在 `createSessionFacade` 的 `isMainAgent` 分支注册 `delegate_agent` 工具（基于 `RpcClient`，**必须处理 `cliPath` 绝对路径 + 二进制适配 + agentDir 对齐**）
9. Phase 3：引入 `AgentOrchestrator` + 异步 `delegate` + `SUB_AGENT_EVENT` 事件类型
   - **同步修改 `event-store/types.ts` 的 `EventType` union**
   - **在 `projection/session-projection.ts` 和 `timeline-projection.ts` 的 switch 中加 fallback 处理**
