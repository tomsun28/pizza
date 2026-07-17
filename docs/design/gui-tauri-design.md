# Pizza GUI 设计方案（Tauri + React）

## 1. 背景与目标

Pizza 已具备四种运行模式：`interactive`（TUI）、`print`、`rpc`（JSONL over stdin/stdout）、`gui`（HTTP + SSE）。所有模式共享同一个 `SessionFacade` 事件流——UI、LLM 上下文、session 树都是 `EventStore` 的 projection。

本方案的目标是**把 GUI 从"内嵌在 `server.ts` 字符串里的单文件 SPA"升级为 Tauri 桌面应用**，第一版覆盖：

- 对话流 + 工具调用展示（流式、中止、follow up、steer）
- 历史树 / 分支（浏览、jump、fork、view，对应 `branch-tree-history-memory.md`）
- 模型切换 / Thinking 级别 / Settings

核心约束：**GUI 不引入任何独立的业务状态**。它只是 `SessionFacade` 的又一个 projection 消费者，和 TUI / RPC 完全对等。

## 2. 现状分析

| 模式 | 入口 | 协议 | 能力覆盖 |
|---|---|---|---|
| `interactive` | `pizza` | 终端 + ink | 全部（含历史树、settings、skills、extensions） |
| `rpc` | `pizza rpc` | JSONL stdin/stdout | 几乎全部（model/thinking/fork/session/messages/commands/extension UI） |
| `gui` | `pizza gui` | HTTP + SSE | 仅 prompt/abort/steer/follow_up/bootstrap |
| `print` | `pizza -p` | stdout | 一次性 |

**关键发现**：`pizza rpc` 的协议（<ref_file file="/Users/gongchao/work/agent/pizza/src/modes/rpc/rpc-types.ts" />）已经覆盖了第一版 GUI 要的几乎所有能力，而 `pizza gui` 的 HTTP 协议反而最简陋。这意味着——**GUI 后端不应该继续扩展 HTTP 协议，而应该直接复用 RPC 协议**。

## 3. 架构总览

```
┌─────────────────────────────────────────────────────┐
│  Tauri 桌面壳（Rust，~3MB）                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  WebView（Chromium / WebKit）                  │  │
│  │  React + Vite SPA（gui-app/ 产物）             │  │
│  │  ┌─────────────┐  ┌──────────────────────┐    │  │
│  │  │ 对话面板     │  │ 历史树面板            │    │  │
│  │  │ Composer     │  │ Settings/Model 面板   │    │  │
│  │  └─────────────┘  └──────────────────────┘    │  │
│  └───────────────▲───────────────────────────────┘  │
│                  │ Tauri IPC（invoke / event）       │
│  ┌───────────────┴───────────────────────────────┐  │
│  │  Rust sidecar 桥（src-tauri/src/bridge.rs）     │  │
│  │  - spawn `pizza rpc` 子进程                     │  │
│  │  - stdin 写 JSONL command                       │  │
│  │  - stdout 读 JSONL response / event             │  │
│  │  - 转发为 Tauri event 给 WebView                │  │
│  └───────────────▲───────────────────────────────┘  │
└──────────────────┼──────────────────────────────────┘
                   │ stdin/stdout JSONL
        ┌──────────┴──────────┐
        │  pizza rpc 子进程    │  ← 现有代码，零改动
        │  SessionFacade       │
        │  EventStore(SQLite)  │
        │  SessionProjection   │
        └─────────────────────┘
```

**为什么是 sidecar 而不是 in-process Node？**
- Tauri 2.x 的 Node sidecar 是一等公民，`pizza rpc` 本就是为"嵌入其他应用"设计的（见 `rpc-mode.ts` 头注释）。
- 进程隔离：agent 的 bash 执行、文件写入崩溃不会拖垮窗口；窗口重启不丢 session（EventStore 已持久化）。
- 零后端改动：`pizza rpc` 协议、`SessionFacade`、`EventStore` 全部原样复用。
- 未来可平滑支持远程模式（sidecar 跑在另一台机器，前端连 JSONL over WebSocket）。

## 4. 集成路径选择

### 路径 A：Tauri WebView 加载 `pizza gui` 的 HTTP server
- 优点：现有 `server.ts` 几乎不动。
- 缺点：HTTP 协议要补 model/thinking/history_tree/session 等一堆端点，重复造 RPC 轮子；SSE 在 WebView 里不如 Tauri event 顺滑；要处理端口冲突。

### 路径 B（推荐）：Tauri sidecar 跑 `pizza rpc`，前端走 Tauri IPC
- 优点：协议现成、能力最全、进程隔离、无端口冲突、可远程化。
- 缺点：要写一层 Rust 桥接（~200 行），把 JSONL 转成 Tauri event。
- 代价远小于"给 HTTP 协议补全能力 + 维护两套协议"。

**结论：走路径 B。** `src/modes/gui/server.ts` 作为"浏览器快速预览"保留（不删，但不再扩展），桌面应用走 RPC sidecar。

## 5. 目录结构

```
pizza/
├── src/                      # 现有 agent 核心（不动）
├── src/modes/
│   ├── gui/server.ts         # 保留，浏览器预览用
│   └── rpc/                  # sidecar 协议源（复用）
├── gui-app/                  # 新增：React 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── lib/
│   │   │   ├── rpc-client.ts       # 封装 Tauri invoke → JSONL
│   │   │   ├── event-stream.ts     # 订阅 Tauri event
│   │   │   └── types.ts            # 从 rpc-types.ts 生成（共享）
│   │   ├── components/
│   │   │   ├── Conversation/
│   │   │   ├── Composer/
│   │   │   ├── HistoryTree/
│   │   │   ├── ModelSettings/
│   │   │   └── ToolCall/
│   │   └── views/
│   │       ├── ChatView.tsx
│   │       └── TreeView.tsx
│   └── dist/                 # Vite 产物，Tauri 加载
├── src-tauri/                # 新增：Tauri 壳
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs
│   │   └── bridge.rs         # sidecar spawn + JSONL 桥
│   └── icons/
└── package.json              # 根，加 gui 相关 scripts
```

## 6. Rust 桥接层（src-tauri/src/bridge.rs）

职责：

1. **启动 sidecar**：`tauri_plugin_shell` 的 `ShellExt::shell().sidecar("pizza")`，args = `["rpc"]`。从 stdout 读到的第一个 `get_state` 响应判定就绪。
2. **command 转发**：暴露 `#[tauri::command] rpc_command(cmd: RpcCommand)`，把传入的 JSON 写到子进程 stdin（`serializeJsonLine` 格式），返回 `id` 用于关联。
3. **事件转发**：stdout 每行 JSON 解析后：
   - `type: "response"` → `app.emit("rpc_response", payload)`，前端按 `id` resolve 对应 Promise。
   - typed event → `app.emit("rpc_event", event)`，前端 `event-stream.ts` 订阅。
   - `extension_ui_request` → `app.emit("extension_ui_request", req)`，前端弹原生对话框，结果通过 `rpc_command` 回写 `extension_ui_response`。
4. **生命周期**：窗口关闭时 `kill` sidecar；sidecar 意外退出时 `app.emit("sidecar_exit", code)`，前端提示重启。
5. **工作目录**：Tauri 启动时让用户选/拖入项目目录，作为 sidecar 的 `cwd`。

```rust
#[tauri::command]
async fn rpc_command(state: State<BridgeState>, cmd: serde_json::Value) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut line = serde_json::json!({ "id": id, ...cmd.as_object().unwrap().clone() });
    let mut stdin = state.stdin.lock().await;
    writeln!(stdin, "{}", serde_json::to_string(&line).unwrap()).map_err(|e| e.to_string())?;
    Ok(id)
}
```

## 7. 协议扩展（仅历史树）

RPC 协议已覆盖 model/thinking/fork/session/messages/commands。**唯一需要新增的是历史树命令**，对齐 `branch-tree-history-memory.md` 的 `history_tree` 工具语义：

```typescript
// 新增到 rpc-types.ts 的 RpcCommand 联合
| { id?: string; type: "history_tree"; action: "list" | "view" | "jump" | "fork" | "summarize";
    sessionId?: string; query?: string; reason?: string }

// 新增 RpcResponse
| { id?: string; type: "response"; command: "history_tree"; success: true;
    data: { action: "list"; nodes: HistoryTreeNode[] }
      | { action: "view"; messages: AgentMessage[]; summary?: string }
      | { action: "jump" | "fork"; sessionId: string }
      | { action: "summarize"; summaryEventId: string } }

interface HistoryTreeNode {
  sessionId: string;
  name?: string;
  createdAt: number;
  isActive: boolean;
  depth: number;
  parentSessionId?: string;
  childCount: number;
  archived: boolean;
}
```

后端在 `rpc-mode.ts` 加一个 `history_tree` command handler，调用 `SessionManager.listSessions()` + 按 `parent_session_id` 组树，`jump`/`fork` 复用现有 `switchTo` / `SESSION_FORKED` 逻辑。**不引入新事件类型**（design doc 已说明复用 `SESSION_FORKED` 等）。

## 8. 前端模块划分

| 模块 | 职责 | 对应 RPC 命令 |
|---|---|---|
| `Conversation` | 消息流、流式增量、markdown/diff 渲染 | `get_messages` + 事件流 |
| `Composer` | 输入、Send/Follow up/Steer/Abort | `prompt` / `follow_up` / `steer` / `abort` |
| `ToolCall` | 工具调用卡片（read/write/edit/bash/grep...） | `tool_started`/`tool_updated`/`tool_finished` 事件 |
| `HistoryTree` | 树视图、jump/fork/view/summarize | `history_tree` |
| `ModelSettings` | 模型列表、切换、thinking 级别 | `get_available_models` / `set_model` / `set_thinking_level` |
| `ExtensionUI` | 原生对话框（select/confirm/input/editor） | `extension_ui_request` / `extension_ui_response` |

状态管理：React Context + `useSyncExternalStore` 订阅 Tauri event 流，不引入 Redux/Zustand（第一版复杂度不够）。

## 9. 复用现有渲染逻辑

`src/core/export-html/` 已有成熟的 markdown / 代码高亮 / diff / ansi 渲染（`template.js`、`template.css`、`ansi-to-html.ts`、`tool-renderer.ts`）。复用方式：

1. 把 `template.js` 里与 DOM 强耦合的部分抽成纯函数模块（`renderMarkdown`、`renderDiff`、`renderTool`），放到 `src/core/export-html/renderers.ts`。
2. `gui-app` 通过 Vite 把这些纯函数 + `template.css` 作为共享 chunk 引入。
3. TUI 的 `components/`（ink）不复用——它是 terminal 渲染，范式不同；但**渲染逻辑的输入数据结构**（`AgentMessage`、tool event）是共享的，前端按相同结构渲染即可。

## 10. 构建与打包

### 根 package.json 新增 scripts
```jsonc
{
  "scripts": {
    "gui:dev": "vite --config gui-app/vite.config.ts",
    "gui:build": "vite build --config gui-app/vite.config.ts",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "build:gui": "npm run build && npm run gui:build && npm run tauri:build"
  }
}
```

### Tauri sidecar 配置（tauri.conf.json）
```jsonc
{
  "bundle": {
    "externalBin": ["binaries/pizza"]
  },
  "app": {
    "windows": [{ "title": "Pizza", "width": 1200, "height": 800 }],
    "security": { "csp": "default-src 'self'; img-src 'self' data:" }
  }
}
```

`binaries/pizza` 是 `npm run build:binary` 产出的单文件二进制（项目已有 `bun build --compile` 脚本）。Tauri 会按平台后缀（`pizza-aarch64-apple-darwin` 等）打包。

### 分发产物
- macOS：`.dmg` / `.app`
- Windows：`.msi` / `.exe`
- Linux：`.AppImage` / `.deb`

体积预估：Tauri 壳 ~3MB + WebView（系统自带，macOS/Win 不打包）+ pizza 二进制 ~40MB。

## 11. 实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | Rust 桥接 + sidecar 启动 + `get_state`/`get_messages`/`prompt`/`abort` 跑通 | 能对话的空壳窗口 |
| P1 | Conversation + Composer + ToolCall 组件，流式渲染 | 功能对标现有 `pizza gui` |
| P2 | `history_tree` RPC 命令 + HistoryTree 组件 | 历史树/分支可视化 |
| P3 | ModelSettings + ExtensionUI 原生对话框 | 对齐 TUI 能力 |
| P4 | 打包（dmg/msi/AppImage）、自动更新、托盘 | 可分发产品 |

每个阶段独立可验证，P0 完成即证明集成路径可行。

## 12. 与现有 `pizza gui` HTTP 模式的关系

- **保留** `src/modes/gui/server.ts`：作为"无需 Tauri 工具链、浏览器快速预览"的轻量入口，适合 CI / 远程 / 调试。
- **不再扩展**其 HTTP 协议：新能力（历史树等）只加到 RPC 协议，HTTP 模式保持现状。
- 长期看 HTTP 模式可由"前端连远程 RPC sidecar over WebSocket"取代，届时 `server.ts` 可退役。

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| Tauri 引入 Rust 工具链，CI 复杂度上升 | Tauri 构建独立于现有 `tsc` 流水线，单独 workflow |
| sidecar 进程管理（僵尸、端口） | 用 `tauri_plugin_shell` 托管生命周期，窗口关闭即 kill |
| WebView 渲染差异（macOS WebKit vs Win WebView2） | 复用 export-html 已验证的 CSS，限制 CSP，不依赖平台私有 API |
| RPC 协议演进要同步前端类型 | `rpc-types.ts` 通过 `json-ts` 或手写 d.ts 共享给 `gui-app/src/lib/types.ts` |
| 历史树规模（500 节点）渲染卡顿 | 虚拟列表（`@tanstack/react-virtual`），默认折叠非当前路径 |
