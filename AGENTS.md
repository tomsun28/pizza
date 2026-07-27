# AGENTS.md

> 此文件同时作为本仓库的 `AGENTS.md` 和 `CLAUDE.md`(`CLAUDE.md` 是一个指向本文件的软链,以便各类 AI 编码工具都能读到同一份指引)。

## 1. 项目简介

**Pizza**(`@tomsun28/pizza`)是一个事件驱动的个人 AI 编码助手(Coding Agent)。
所有对话、工具调用、文件改动都以不可变事件的形式写入 `EventStore`(SQLite),UI、LLM 上下文、会话树都是这条事件流的"投影"。

底层来源于 [Pi](https://github.com/badlogic/pi-mono) 开源项目,在此基础上重构了 turn cycle(用状态机替代 `while true` 循环)、统一了多种运行模式(TUI / RPC / GUI / Print),并引入了"持久化 Agent"(`~/.pizza/main`)概念。

## 2. 目录结构速览

```
pizza/
├── apps/
│   ├── desktop/          # Tauri 桌面应用 (Rust + 前端), 启动 sidecar
│   └── web/              # Web 版 UI
├── packages/             # 可独立交付的子包
│   ├── cli/              # CLI 参数解析、初始消息构建
│   ├── tui/              # 终端 UI(Ink / React)
│   ├── rpc/              # JSON-RPC 协议层
│   ├── http-bridge/      # HTTP 网关
│   ├── pty/              # 伪终端(底层调用 node-pty)
│   └── protocol/         # 各模块共享的消息 / 事件类型
├── src/
│   ├── core/             # 核心:EventStore、SessionFacade、main-agent 等
│   ├── modes/            # 运行模式(Interactive / RPC / GUI / Print)
│   ├── utils/            # 工具函数 + vendor 工具查找
│   ├── bun/              # Bun 运行时入口(用于 --compile 打包)
│   ├── main.ts           # CLI 总入口
│   └── cli.ts            # `pizza` 命令的 bin 入口
├── scripts/              # 构建辅助脚本
├── test/                 # Vitest 测试
└── resources/            # 文档配图等
```

## 3. 关键开发约定

### 3.1 环境要求
- **Node.js ≥ 22.5.0**(`engines` 字段已声明,低于此版本 `node-pty` 等原生模块会失败)
- 桌面端开发还需要:Rust toolchain、Tauri CLI (`cargo tauri`)、平台原生依赖
- 包管理:npm / bun / pnpm 都可(仓库同时提交了 `package-lock.json` 和 `bun.lock`),但 CI 默认走 npm

### 3.2 常用命令

```bash
# 安装依赖
npm install          # 或 bun install

# 运行测试(默认走离线,避免线上 API 抖动)
PIZZA_OFFLINE=1 npm test

# 跑真实 API 的测试(需要相应 provider key)
npm run test:online

# 类型检查 + 监听构建
npm run dev

# 完整构建
npm run build                  # 仅产出 dist/
npm run build:binary           # 产出 dist/pizza (Bun --compile 二进制)
npm run build:desktop          # 跑 Tauri 打包

# 桌面端开发热重载
npm run dev:desktop

# 桌面端生产打包
npm run build:desktop
```

### 3.3 架构要点
- **turn cycle 不是 `while true`**:见 `src/core/`,事件通过事件处理表驱动状态机。
- **所有运行模式共享 `SessionFacade`**:TUI / RPC / GUI / Print 都从同一事件流投影。
- **`~/.pizza/main/` 是常驻 Agent**:主 Agent 拥有 SOUL.md(人格)与 long-term memory(`memory/`),启动时走 `--main` flag,由 `acquireMainLock` 互斥。
- **桌面端 sidecar 启动**:`apps/desktop/src/bridge.rs` 中的 `init_sidecar` 是 Tauri 与 `pizza --mode rpc` 的桥梁。
- **vendor 工具**:`fd` 和 `rg` 通过 `scripts/download-vendor-tools.mjs` 下载到 `dist/vendor/bin/`,桌面端打包时只复制当前平台到 `apps/desktop/vendor-bin/`。

### 3.4 命名与风格
- TypeScript:`tab` 缩进(见 `tsconfig.build.json` 与 `packages/protocol`),双引号字符串,行尾分号。
- Rust:Tauri 端用 `tab` 缩进,遵循 rustfmt 默认。
- 提交和 PR 标题遵循 Conventional Commits 规范(见下文 §4)。

## 4. PR / Commit 命名规则

本仓库的 PR 标题必须遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范
(`.github/PULL_REQUEST_TEMPLATE.md` 已明确要求)。merge 后 GitHub squash 会自动附加 `(#PR号)` 后缀,**作者写 PR 标题时不要自己加**。

### 4.1 格式

```
<type>(<scope>): <subject>
```

其中:
- **`<type>`** 必填,常用取值:`feat`(新功能)、`fix`(修复)、`chore`(杂项维护)、`ci`(CI/CD)、`docs`(文档)、`refactor`(重构)、`test`(测试)、`perf`(性能)、`build`(构建系统)、`style`(格式)。
- **`<scope>`** 可选,描述影响的模块。仓库内常见 scope:`desktop`、`cli`、`web`、`ui`、`tui`、`main-agent`、`event-store`、`rpc`、`protocol`、`ci`、`release`、`infra`、`bridge`。
- **`<subject>`** 简短描述,要求:
  - 全小写,首字母也小写
  - 祈使句、现在时(`add` / `fix` / `bump` / `pass` / `remove`,不用 `added` / `fixed` / `passes`)
  - 不超过 72 字符
  - **末尾不加句号**
  - 不要以大写字母或类型前缀开头

### 4.2 真实样本(直接对照风格写)

```
chore: bump version to 0.1.10 (#26)
feat(ui): add message timestamps and remove Tools tab from plugins
fix(cli): preserve backslashes inside quotes in builtin command parsing (#25)
feat(desktop): pass login-shell PATH to the sidecar (#15)
fix(event-store): enable WAL + busy_timeout to prevent SQLITE_BUSY  (#12)
fix(desktop): bundle only current platform's vendor binaries (#9)
refactor: restructure project to monorepo layout
```

### 4.3 反例(不要这样写)

```
❌ Add new feature                  (缺 type)
❌ feat: Add new feature.           (大写、句号)
❌ FEAT: add new feature            (type 大写)
❌ feat(desktop): Added login path  (过去式)
❌ feat(desktop): add new feature (closes #27)   (作者自己写 PR 号)
❌ feat(scope1, scope2): ...        (scope 不支持多选)
```

### 4.4 Body 与 Footer(可选)

如果改动比较复杂,可以加 body 说明动机、影响范围、向后兼容性。涉及到 issue 时,在 footer 用 `Fixes #123`、`Refs #456` 关联。仓库的 PR 模板里就留了 `Fixes #<issue_number>` 的位置。

## 5. 给 AI 编码助手的工作约定

- **优先读入口文件再下结论**:`src/main.ts` 是 CLI 入口,`apps/desktop/src/bridge.rs::init_sidecar` 是桌面端 sidecar 启动的唯一入口。
- **桌面端 stderr 不要 `inherit`**:`bridge.rs` 中的 sidecar stderr 应当 `Stdio::piped()` 捕获,这样 sidecar 崩溃时错误信息能传到 UI(`pizza --main` 锁失败等场景依赖于此)。
- **改动 main-agent 锁**:见 `src/core/main-agent.ts::acquireMainLock`,同时监听 `exit` + 信号(SIGINT/SIGTERM/SIGHUP),避免 Bun `--compile` 二进制在信号下不触发 `exit` 事件。
- **不要自动 push 到 main**:本仓库的默认分支是 `main`,改动应放新分支,通过 PR 合并。
- **跑测试前先 `PIZZA_OFFLINE=1`**:避免线上模型 API 抖动让测试 flake。
- **不要在改动里夹带 PAT / API key / 个人凭据**:被发现后会被 reviewer 直接挡回。