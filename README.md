# Pizza

Pizza is an event-driven agent. Every conversation, tool call, and file edit is an event in an immutable log. Your UI, the LLM context, and the session tree are all projections of that log.

[简体中文](./README.zh-CN.md)

## About It

Pizza’s shell comes from Pi -> Pizza. Thanks to Pi for open sourcing.

- **Reactor-driven turn cycle**
  Unlike `Pi, Claude Code, and Codex`, Pizza does not run the agent loop as a brittle `while true` loop. Each turn is a state machine driven by an event-handler table. The result: interrupts, retries, parallel tool calls, and mid-turn failures can all be handled reliably.

- **The log is the single source of truth**
  Every message, model call, tool result, and file change is written to an immutable `EventStore` (SQLite). The UI, the LLM context, and the session tree are all live projections of that log. State is no longer hidden in mutable objects — it can be rebuilt, audited, and replayed, because the log is the single source of truth.

- **Only one execution tool — the CLI**
  JSON is program-friendly at the API level but not model-friendly. Pizza aggressively gives the model only one tool: the `CLI Tool`. The model uses it to call `read`, `write`, `edit`, and other command-line commands. Surprisingly, it performs better and is more stable.

- **Why New Session**
  In Pizza, you do not need to manually create a new session. Think of it as a long-term task for a friend you can chat with for ten years. A friend will manage their own context — not through compression.

- **All interfaces share the same runtime**
  The interactive TUI, JSON-RPC server, and one-shot print mode all consume the same `SessionFacade` event stream. Script it, embed it, or chat with it directly in the terminal — it is the same agent.

- **Git log-like branch tree memory**
  Sessions can fork from any earlier message. Rewind, branch, compare. Restart your life anytime, anywhere.

## Quick Start

```bash
npm install -g pizza
export ZAI_API_KEY=your_zai_api_key
pizza
```
