# 永续对话:移除 session 身份层

日期：2026-07-03
状态：待评审

---

## 1. 背景与动机

Pizza 已完成从「JSONL 文件 per-session」到「事件驱动 EventStore」的迁移（见 git
`df5c7ca`、`2a78eba`、`595ce45`）。数据层现在是：

- 一个 workspace = 一个 append-only `events.sqlite`（`workspace.ts:9`）
- 一个「session」= `SessionDescriptor`，本质是 `{event_range: {start_event_id,
  end_event_id}, parent_session_id}` —— 事件流上的一个**窗口/视图**，不持有消息
- 树结构由 `caused_by` 链自然涌现；`forkAt` / `forkFromSession` 只是「新开一个
  共享前缀的描述符」

但 TUI 的 slash 命令仍按旧心智模型（session 是一个可命名、可切换、有文件身份的
离散实体）设计。具体症状：

- `/session` 打印 `File:` / `ID:`，而那个「文件」就是全 workspace 共享的
  `events.sqlite`，对用户无意义
- `/fork` 与 `/clone` 都调 `runtime.fork(entryId)`，是同一操作的两个入口
- `/resume` / `/new` / `/name` 都假设存在离散 session 实体
- title 与 footer 展示 sessionName

**目标**：用户侧不再有「session」概念。取而代之的是一条**永续对话**——像一个长
期生存的人的持续记忆，不主动 `new`、不「恢复 session」，靠 compaction 自行管理
上下文相关性。分支能力以低心智形式（rewind / history）保留在底层。

---

## 2. 目标模型

### 2.1 永续对话 + 隐式分支

```
ORIGIN ── u₁ ── a₁ ── u₂ ── a₂ ── u₃ ── a₃   ← 被放弃的旧路径（留在事件库）
                        │
                        └─(rewind)── u₂' ── a₂' ── u₄ ── ... [HEAD = 当前]
```

不变量：

- 用户始终看到**一条线**：从开头到当前 HEAD 的因果链
- `/rewind` 从某个历史点分叉，**静默**建分支（新 `SessionDescriptor`，共享前
  缀）；旧路径不主动展示，但永远不丢
- **唯一的时间线操作是「从某点 rewind」**。「回到旧路径上的某个点」= 在
  `/history` 里定位它，从它 rewind —— 语义上等价于 resume，但模型里不存在
  「切回 session A」这个动作
- compaction 仍是唯一记忆管理；旧分支的事件最终被所有活动路径的窗口挤出

### 2.2 不变量：活动视图恒为 `{ORIGIN, HEAD}`

之前用户能通过 `/new` / `/fork` 切出不同 `event_range` 切片 → 多个视图。
之后活动视图恒为 `{ORIGIN(或 compaction 边界), HEAD}` 这一条连续视图。
分支发生时 `forkAt` 照样新建描述符、`caused_by` 照样建链，投影照样能从任意
分支点重建上下文。

---

## 3. 命令映射

| 现命令 | 之后 | 动作 |
|--------|------|------|
| `/session` | **删** → `/stats` | 只留 token/cost 诊断，去掉 File/ID/Name |
| `/new` | **删** | 对话不重启；换话题直接打字，compaction 处理 |
| `/resume` | **删** | 始终在唯一对话里；跨 session 选择器作废 |
| `/name` | **删** | 分支自动按「rewind 点首条消息 + 时间」打标签 |
| `/clone` | **删** | 并入 `/rewind`（从 leaf 分叉 = clone 语义） |
| `/fork` | → **`/rewind`** | 快速选一条历史 user message 分叉（原 `showUserMessageSelector` UX） |
| `/tree` | → **`/history`** | 全树浏览器 + 可选节点 rewind-from；取代 `/resume` + `/tree` |
| `/compact [instructions]` | **保留，提权** | 永续模型的核心记忆操作 |
| `/export` `/share` `/copy` `/import` | 保留 | 数据进出，与 session 无关 |
| `/model` `/scoped-models` `/settings` `/hotkeys` `/login` `/logout` `/quit` `/debug` `/reload` | 保留 | agent/环境配置，无关 |

### 3.1 `/rewind` 语义

- 入口：列出历史 user message（粒度 = 用户提问点），用户选一条
- 行为：`runtime.fork(entryId)` 在该点建分支；活动指针指向新分支
- 渲染：当前视图切换为「分叉点之前 + 新对话」；分叉出的旧路径进入 `/history`
- 与原 `/fork` 的 `showUserMessageSelector` UX 一致，仅改命名与文案

### 3.2 `/history` 语义

- 复用 `TreeSelectorComponent`（原 `/tree`）
- 展示完整事件树，含被放弃的分支
- 节点可选 → 「rewind from here」触发 `/rewind`
- 保留原 tree 的 filter 模式（no-tools / user-only / labeled-only / all）
- 删除 label 编辑能力（`app.tree.editLabel`）—— 分支不命名

### 3.3 `/stats` 语义

- 从老 `handleSessionCommand` 抽出 token / cost 部分
- 不含 File / ID / Name / sessionName 行
- 显示：user / assistant / toolCalls / toolResults 计数 + input/output/cache/cost

---

## 4. 受影响表面（7 处）

### 4.1 Slash 命令分发
- 文件：`src/modes/interactive/interactive-mode.ts:2466-2582`
- 删 `/session` `/new` `/resume` `/name` `/clone` 分支；`/fork` → `/rewind`、
  `/tree` → `/history`；新增 `/stats`

### 4.2 终端标题
- 文件：`interactive-mode.ts:849-855`
- `Pizza - <sessionName> - <cwd>` → `Pizza - <cwd>`

### 4.3 Footer
- 文件：`src/modes/interactive/components/footer.ts:128, 157-162, 275-284`
- 删 `sessionName` 段（`pwd • sessionName` → `pwd`）
- 删 `getFromSession("sessionName")` 分支与 `getSessionName()` 调用

### 4.4 `/resume` 选择器组件
- 文件：`src/modes/interactive/components/session-selector.ts`、
  `session-selector-search.ts`
- 跨 session 列表 / 重命名 / 删除 / scope / sort 整套 UI → 删
- `showSessionSelector()`（`interactive-mode.ts:4247`）→ 删
- `TreeSelectorComponent` 升级承载 `/history`

### 4.5 启动选择器 + `--resume`
- 文件：`src/cli/session-picker.ts`、`src/main.ts`（`--resume`/`--continue`/
  `--session`/`--fork` flag 处理，`validateForkFlags` 在 `main.ts:180`）
- **默认行为**：无 flag 时自动 resume 永续对话（最新活动 leaf）；不存在则自动创建
- `--resume <id>` → `--rewind <id>`（跳到某分支点启动）
- `--continue` 行为并入默认（永续即 continue）
- 移除启动期 TUI 选择器（`selectSession`）：默认直接进入永续对话。需跳到特定分支时用 `--rewind <id>`

### 4.6 CLI flags 收敛
- 文件：`src/main.ts:180-186`、`src/cli/args.ts`
- `--session` / `--continue` / `--resume` / `--fork` 收敛为 `--rewind [id]`
- 默认 = 回到永续对话

### 4.7 RPC mode
- 文件：`src/modes/rpc/rpc-mode.ts:350-371`、`rpc-types.ts`
- `set_session_name` → 删
- `new_session` → `rewind`（带可选目标点；无目标 = 从当前 leaf 继续，等价原
  `new_session` 无 parent 的「开新分支」语义在新模型下退化为 no-op，需澄清）
- `RpcSessionState.sessionName` → 删
- `sessionFile` / `sessionId` 保留（内部 ref，RPC 客户端仍需定位活动分支）

---

## 5. 内部架构姿态

**保留 `SessionManager` / `SessionDescriptor` 作为内部分支簿记，只剥掉用户可见
的身份层。**

保留（承重，不动）：
- `SessionProjection`（`session-projection.ts`）—— `buildContext()` 走事件构建 LLM
  上下文。Reactor 喂模型全靠它，一行不改
- `SessionManager.getActiveSession()`（`session-manager.ts:61`）—— 返回活动投影
- `createSession` / `forkAt` / `forkFromSession` —— rewind 用的分支创建

删除（用户身份层）：
- `SessionManager.renameSession` / `switchSession`
- `SessionDescriptor.name` 不再由用户设置；分支自动标签（rewind 点首条消息预览
  + 时间戳），仅供 `/history` 显示

遗留标记（本次不动，后续可纯化）：
- `SessionDescriptor.event_range` 在新模型下退化为常量 `{ORIGIN, HEAD}`。本次
  保留字段不动，仅停止让用户切片。未来（B2）可考虑「从 HEAD 反向走 caused_by」
  彻底替换 event_range，不在本次 scope。

---

## 6. 已决策项

| 决策 | 选择 | 理由 |
|------|------|------|
| `/reset`（彻底清空）| **不提供** | 永续模型靠 compaction 自然遗忘；破坏性清空与「长期生存」心智冲突。需要时可手动删 workspace 目录 |
| `/stats` 单独命令 | **保留** | cost/明细 footer 放不下；token 统计对长对话有诊断价值 |
| 内部姿态 | **B1**（保留 machinery，剥身份层）| `caused_by` 树 + fork + projection 已可用；改动小、风险低。B2 纯化留作后续 |

---

## 7. 非目标（out of scope）

- 不重写 `SessionProjection` / EventStore / Reactor
- 不删除 `SessionDescriptor` / `SessionManager`（仅删 rename/switch + 用户可见层）
- 不做 B2（event_range → caused_by 反向遍历的纯化）
- 不改扩展系统 API（扩展向后兼容，见 `ARCHITECTURE.md:215`）
- 不动 compaction 引擎本身（仅 `/compact` 命令提权）
- 不实现「跨 workspace 对话合并 / 迁移」

---

## 8. 风险与开放问题

1. **启动期分支定位**：用户多次 rewind 后，启动时「最新活动 leaf」是哪条？
   需明确「最新活动」= 最近写入事件的分支 leaf。`sessions.json` 已记
   `created_at`，可据此排序。
2. **`new_session` RPC 语义**：原无 parent 的 `new_session` 是「开全新 session」。
   新模型下「全新」无意义（永续）。需决定：报错？还是 no-op？倾向 no-op +
   返回当前活动 ref。
3. **扩展兼容**：若有第三方扩展调用 `set_session_name` / 监听
   `SESSION_CREATED`，删命令会破坏。需 grep 扩展 API 表面确认影响面（实施期
   检查 `src/core/extensions/types.ts`）。
4. **`/export` 范围**：导出活动路径还是全树？倾向活动路径（用户所见），保持
   现状。

---

## 9. 验收标准

- [ ] TUI 中无 `/session` `/new` `/resume` `/name` `/clone` 命令
- [ ] `/rewind` 能从历史 user message 分叉，旧路径可在 `/history` 看到
- [ ] `/history`（原 `/tree`）展示全树，节点可触发 rewind-from
- [ ] `/stats` 显示 token/cost，无 File/ID/Name
- [ ] 终端标题、footer 不再出现 sessionName
- [ ] `pizza` 无 flag 启动 → 自动回到永续对话（最新活动 leaf）
- [ ] `--rewind <id>` 能跳到指定分支点启动
- [ ] RPC `set_session_name` 移除、`new_session` 行为澄清
- [ ] 分支创建后 `SessionProjection.buildContext()` 仍正确返回新分支上下文
- [ ] 现有扩展加载与运行不报错
