# 持久化 Agent 设计文档（`~/.pizza/main`）

## 1. 背景与动机

当前 Pizza 的所有 workspace 被一视同仁，差异只来自 `cwd`：

- **workspace 身份**：`deriveWorkspaceId(cwd)`，每个 cwd 一个独立 SQLite 事件库。
- **system prompt**：`buildSystemPrompt()` 输入只有 `customPrompt / appendSystemPrompt / contextFiles(AGENTS.md|CLAUDE.md) / skills / tools / cwd`，没有"身份/灵魂"概念。
- **资源加载**：`DefaultResourceLoader` 只从 `agentDir` + cwd 祖先链找 `AGENTS.md/CLAUDE.md`。
- **harness**：`createSessionFacade()` 对任何 cwd 走完全相同的装配。
- **compaction**：`SUMMARIZATION_PROMPT` 只保留 Goal/Constraints/Progress，身份信息会被压缩成普通文本丢失。

`~/.pizza/main` 要成为一个**常驻人格 agent**（类似 OpenClaw 的持久化 agent），与普通 per-project workspace 区别对待：拥有灵魂文件、长期记忆、跨项目连续、压缩不丢灵魂。

## 2. 设计目标

| 维度 | 普通 workspace | `~/.pizza/main` |
|---|---|---|
| 生命周期 | 一次任务一个 session | 一条连续意识，跨 session 续接 |
| 身份 | 无（通用 coding assistant） | 灵魂文件定义人格 |
| 记忆 | 仅当次会话 + AGENTS.md | 长期记忆库，跨 session 累积 |
| 工作范围 | 绑定单个 cwd | 可指向任意项目 cwd |
| 压缩 | 标准 Goal/Progress 摘要 | 同左，灵魂/记忆靠每次重建 prompt 自我恢复 |
| 启动 | 默认新 session | 同左，连续性靠灵魂+记忆而非 session 续接 |

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
    │   ├── projects.md         # 跨项目的工作上下文
    │   └── <topic>.md          # 按主题累积的记忆
    └── journal/                # 可选：agent 自省日志（每次会话末尾追加）
```

**不引入自定义 config.json**。main agent 的配置覆盖（model / thinking / compaction 阈值等）走现有 `SettingsManager` 的 scoped settings 机制（`~/.pizza/agent/settings.json` 或 cwd 级 settings），不新增配置文件。

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
  /** 是否为持久化 agent，影响默认 guidelines 措辞 */
  isPersistent?: boolean;
}
```

拼接顺序（main 路径）：

1. `# Identity` ← `soulFile.content`（**永不压缩**，见第 7 节）
2. `# Long-Term Memory` ← `longTermMemory`（每次启动从 `memory/*.md` 装载）
3. 原有正文（tools / guidelines / builtinCommands）
4. `# Project Context` ← 当前指向项目的 AGENTS.md（如果 main 被指向某 repo）
5. skills / environment / breadcrumb

`isPersistent` 时替换默认 guidelines：把"Be concise in your responses"之类换成持久化措辞，例如"开始新话题前先回顾相关长期记忆"、"当学到关于用户的稳定事实时，用 memory 工具持久化"。

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

- `~/.pizza/main/SOUL.md` → `getSoulFile()`
- `~/.pizza/main/memory/*.md` → `getLongTermMemory()`
- 仍调用 `loadProjectContextFiles` 加载当前 project 的 AGENTS.md（main 可被 `--cwd` 指向某 repo）

`createSessionFacade` 的 `buildPromptForTools` 把这两个值透传给 `buildSystemPrompt`。

## 6. Harness 差异化（核心）

在 `createSessionFacade`（`src/core/session-facade-factory.ts`）增加 `isMainAgent` 分支。

### 6.1 长期记忆：直接用现有文件工具

不引入专用 `memory` 工具。`~/.pizza/main/memory/*.md` 就是普通 markdown 文件，agent 用现有的 `read` / `write` / `edit` / `grep` 直接操作：

- 读：`read ~/.pizza/main/memory/user-profile.md`
- 写：`write ~/.pizza/main/memory/<topic>.md ...`
- 搜索：`grep -r "keyword" ~/.pizza/main/memory/`

连续性靠两点保证，都不需要新工具：
1. **启动时加载**：`getLongTermMemory()` 把 `memory/*.md` 装载进 system prompt（见第 5 节）
2. **guidelines 引导**：`isPersistent` 时在 guidelines 里写明 memory 目录路径和写入时机（"学到关于用户的稳定事实时，写入 `~/.pizza/main/memory/` 下对应文件"）


## 8. 落地顺序

1. `buildSystemPrompt` 加 `soulFile / longTermMemory / isPersistent`（纯加法，不破坏现有）
2. `ResourceLoader` 加 `getSoulFile / getLongTermMemory`
3. `createSessionFacade` 加 `isMainAgent` 分支 + 透传灵魂/记忆
