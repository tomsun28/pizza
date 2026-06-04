# 跳过测试评估报告

## 概览
共 12 个被跳过的测试分布在 4 个文件中。

---

## 1. agent-session-queue.test.ts (5个测试)

### 评估结果

| 测试 | 状态 | 建议 | 原因 |
|------|------|------|------|
| delivers all steering messages in one batch in all mode | ⚠️ 需要改造 | 删除或简化 | "all" 模式在 reactor 架构下概念不同，现在使用 followUpQueue 机制 |
| delivers all follow-up messages in one batch in all mode | ⚠️ 需要改造 | 删除或简化 | 同上 |
| queues custom messages with deliverAs steer while streaming | 🔧 可实现 | 修复启用 | steer() 只提取文本，需要支持自定义消息完整内容 |
| queues custom messages with deliverAs followUp while streaming | 🔧 可实现 | 修复启用 | 同上 |
| injects nextTurn custom messages into the next prompt | 🔧 可实现 | 修复启用 | nextTurn 机制存在，但内容未合并到 LLM 上下文 |

### 技术细节

**问题 1-2: "all" 模式测试**
- 原架构支持 steeringMode/followUpMode: "all" | "one-at-a-time"
- 新架构使用 reactor 的 steer/followUp 方法，批量行为不同
- 建议：如果这些模式不再支持，删除测试；如果仍支持，改造验证新行为

**问题 3-5: 自定义消息和 nextTurn**
- `steer()` 和 `followUp()` 只提取文本 (`_extractText`)，丢失了 custom 消息的元数据
- nextTurn 消息被推送到 `_pendingNextTurnMessages`，但内容未合并到用户消息供 LLM 使用
- 修复点：在 `agent-session.ts` 的 `prompt()` 中（行 1055-1058）需要合并 nextTurn 消息内容到 userContent

---

## 2. agent-session-model-extension.test.ts (5个测试)

### 评估结果

| 测试 | 状态 | 建议 | 原因 |
|------|------|------|------|
| allows extension tool_call handlers to block tool execution | ❌ 需要实现 | 暂时跳过保留 | reactor 未集成 tool_call 扩展钩子 |
| allows extension tool_result handlers to modify tool results | ❌ 需要实现 | 暂时跳过保留 | reactor 未集成 tool_result 扩展钩子 |
| allows extension context handlers to modify messages before the LLM call | ❌ 需要实现 | 暂时跳过保留 | reactor 未调用 emitContext |
| allows extension input handlers to transform or handle input | ❌ 需要实现 | 暂时跳过保留 | reactor 未集成 input 处理 |
| allows before_agent_start handlers to inject custom messages and modify the system prompt | 🔧 部分可用 | 修复启用 | 已部分实现，但消息内容合并需完善 |

### 技术细节

**问题 1-4: 扩展钩子未集成到 reactor**
- 扩展 runner 中定义了 `emitToolCall`, `emitToolResult`, `emitContext`, `emitInput` 等方法
- 但在 reactor 架构中，这些方法未被调用
- 需要集成点：
  - `reactor.ts`: `_onIntentToolCall` 前调用 `emitToolCall`
  - `reactor.ts`: `_onToolExecutionEnd` 后调用 `emitToolResult`
  - `reactor.ts`: `_onLlmCallRequested` 前调用 `emitContext`
  - `runtime.ts`: `prompt()` 方法中调用 `emitInput`

**问题 5: before_agent_start**
- 已在 `agent-session.ts` 中实现（行 1060-1086）
- 但消息内容合并只在扩展消息处理中，nextTurn 未处理
- 建议修复后启用

---

## 3. git-update.test.ts (1个测试)

### 评估结果

| 测试 | 状态 | 建议 |
|------|------|------|
| tests skipped in offline mode | ✅ 正常 | 保持现状 |

### 说明
- 第 21-25 行的条件跳过是正常的
- 当 `PI_OFFLINE=1` 时跳过需要真实 git 操作的测试
- 不是架构迁移相关的问题

---

## 4. 2791-fswatch-error-crash.test.ts (1个测试)

### 评估结果

| 测试 | 状态 | 建议 |
|------|------|------|
| issue #2791 fs.watch error event crashes process | ⚠️ 环境相关 | 可选：启用或删除 |

### 说明
- 这是一个回归测试，验证 FSWatcher 的错误处理
- 当前使用 `describe.skip` 整个跳过
- 注释说明在某些 Node.js 版本或测试配置中不可靠
- 建议：
  - 方案 A: 保持跳过，这是一个已知的环境问题
  - 方案 B: 尝试启用，观察 CI 稳定性
  - 方案 C: 删除（如果该问题已不再相关）

---

## 实施建议优先级

### 高优先级（核心功能）
1. **修复 nextTurn 测试** - 简单修复，高价值
2. **修复 steer/followUp 自定义消息** - 确保流式期间自定义消息工作正常

### 中优先级（扩展集成）
3. **实现 reactor 的扩展钩子集成** - 需要较多工作
4. **决定是否保留 "all" 模式** - 产品决策

### 低优先级（可选）
5. **评估 2791 回归测试** - 环境相关问题

---

## 工作量估算

| 任务 | 估算时间 |
|------|----------|
| 修复 nextTurn 测试 | 30分钟 |
| 修复 steer/followUp 自定义消息 | 1-2小时 |
| 删除/简化 "all" 模式测试 | 30分钟 |
| reactor 集成扩展钩子 (5个) | 1-2天 |
| 完善 before_agent_start | 30分钟 |

**总计：简单修复约半天，完整扩展集成约2-3天**
