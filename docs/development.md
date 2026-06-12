# Development

## Setup

```bash
git clone <repo-url>
cd pizza
npm install
npm run build
```

Run from source:

```bash
node dist/cli.js
```

Pizza keeps the caller's current working directory.

## Testing

```bash
npm test                          # Run all tests (offline mode)
npm test -- test/specific.test.ts # Run specific test
```

Tests run with `PI_OFFLINE=1` by default (no API keys needed). Use `npm run test:online` for tests requiring network.

## Project Structure

```
src/
  cli.ts                    # CLI entry point
  main.ts                   # Main orchestration, arg parsing → mode routing
  config.ts                 # Paths, version, config resolution
  core/
    agent/types.ts           # Domain model types (AgentMessage, AgentTool, etc.)
    event-store/             # EventStore (SQLite append-only log)
      events.ts              # 53 concrete event payload types
      sqlite-store.ts        # SQLite implementation
      store.ts               # EventStore interface
    runtime/
      reactor.ts             # Event-driven turn loop (handler table)
      runtime.ts             # EventSourcedRuntime (store + reactor + projection)
      pi-ai-client.ts        # LLM client adapter
      policies.ts            # RetryPolicy, CompactionPolicy interfaces
    projection/
      session-projection.ts  # LLM context builder from events
      event-to-message.ts    # Event → AgentMessage conversion
      timeline-projection.ts # Activity timeline view
      session-manager.ts     # Session descriptor CRUD
    intent/
      classifier.ts          # Tool call risk classification
      executor.ts            # Sole authorized mutation executor
      tool-adapter.ts        # AgentTool → ToolExecutor bridge
    compaction/
      compaction-engine.ts   # Context compression via LLM summarization
      compaction.ts          # Compaction utilities
    extensions/
      runner.ts              # Extension lifecycle + EventStore subscription
      loader.ts              # jiti-based extension loading
      types.ts               # Extension API type definitions
    session-facade.ts        # Lightweight facade for modes/extensions
    session-facade-factory.ts # Factory that assembles all components
    tools/                   # Built-in tool definitions (bash, edit, read, write, grep, find, ls)
  modes/
    event-mapper.ts          # TypedEvent → ModeEvent mapping
    interactive/             # TUI mode
    rpc/                     # JSON-RPC over stdio
    print-mode.ts            # Single-shot execution
```

## Architecture

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the full architecture overview.

Key concepts:
- **EventStore** is the single source of truth — all state derives from the event log
- **Reactor** drives agent turns via a handler table, not a while-loop
- **Projections** build views (LLM context, timeline, goals) from events
- **SessionFacade** is the sole entry point for modes and extensions

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pizza",
    "configDir": ".pizza"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork.

## Debug Command

`/debug` (hidden) writes to `~/.pizza/agent/pizza-debug.log`.
