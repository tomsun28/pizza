> Pizza can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to Pizza's agent capabilities. Use it to embed Pizza in other applications, build custom interfaces, or integrate with automated workflows.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

## Quick Start

```typescript
import { createSessionFacade } from "pizza";

const { facade } = await createSessionFacade();

facade.subscribe((event) => {
  if (event.type === "AGENT_MESSAGE_CHUNK") {
    const chunk = (event.payload as { chunk: { kind: string; delta?: string } }).chunk;
    if (chunk.kind === "text_delta" && chunk.delta) {
      process.stdout.write(chunk.delta);
    }
  }
});

await facade.prompt("What files are in the current directory?");
```

## Installation

```bash
npm install pizza
```

The SDK is included in the main package. No separate installation needed.

## Core Concepts

### createSessionFacade()

The main factory function. Creates a `SessionFacade` — the lightweight entry point for agent interaction.

`createSessionFacade()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. If you do not provide one, it uses `DefaultResourceLoader` with standard discovery.

```typescript
import { createSessionFacade } from "pizza";

// Minimal: defaults with DefaultResourceLoader
const { facade } = await createSessionFacade();

// With explicit options
const { facade } = await createSessionFacade({
  cwd: process.cwd(),
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  thinkingLevel: "medium",
  tools: ["read", "bash", "edit", "write"],
  storagePath: ":memory:", // in-memory EventStore (no persistence)
});
```

### SessionFacade

The `SessionFacade` is the sole entry point for modes and extensions. It does **not** hold transcript state — conversation data is read from EventStore projections.

```typescript
// Send a prompt
await facade.prompt("List all TypeScript files in src/");

// Steer: interrupt current turn with new message
facade.steer("Actually, only show files modified today");

// Follow-up: queue a message for after current turn
facade.followUp("After that, also check the tests");

// Abort current execution
facade.abort();

// Wait for agent to finish processing
await facade.waitForIdle();

// Request context compaction
facade.compact();

// Change model mid-session
facade.setModel("anthropic", "claude-sonnet-4-20250514");

// Change thinking level
facade.setThinkingLevel("high");

// Subscribe to real-time events
facade.subscribe((event) => {
  console.log(event.type, event.payload);
});

// Read conversation messages (from EventStore projection)
const context = facade.getProjection().buildContext();
context.messages.forEach((msg) => {
  console.log(msg.role, msg.content);
});

// Dispose when done
facade.dispose();
```

### Events

Subscribe to the EventStore event stream for real-time updates. Events are `TypedEvent` objects with a `type` and `payload`.

```typescript
facade.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "AGENT_MESSAGE_CHUNK": {
      const chunk = (event.payload as { chunk: { kind: string; delta?: string } }).chunk;
      if (chunk.kind === "text_delta" && chunk.delta) {
        process.stdout.write(chunk.delta);
      }
      break;
    }

    // Tool execution
    case "TOOL_EXECUTION_START":
      console.log(`Tool: ${event.payload.tool_name}`);
      break;
    case "TOOL_EXECUTION_UPDATE":
      // Streaming tool output
      break;
    case "TOOL_EXECUTION_END":
      console.log(`Result: ${event.payload.is_error ? "error" : "success"}`);
      break;

    // Message lifecycle
    case "AGENT_MESSAGE_START":
      // LLM response starting
      break;
    case "AGENT_MESSAGE_END":
      // LLM response complete (contains full content + usage)
      break;

    // Turn lifecycle
    case "AGENT_TURN_START":
      break;
    case "AGENT_TURN_COMPLETED":
      // Turn finished. event.payload.reason: "stop" | "tool_use" | "error" | "aborted"
      break;

    // Compaction
    case "COMPACTION_START":
    case "COMPACTION_END":
    case "COMPACTION_ABORTED":
      break;

    // Retry
    case "RETRY_SCHEDULED":
    case "RETRY_ABORTED":
      break;

    // Model/thinking changes
    case "MODEL_CHANGED":
    case "THINKING_LEVEL_CHANGED":
      break;

    // Errors
    case "RUNTIME_ERROR":
    case "AGENT_ERROR":
      console.error(event.payload.error);
      break;
  }
});
```

## Options Reference

### Directories

```typescript
const { facade } = await createSessionFacade({
  // Working directory for tool execution and resource discovery
  cwd: process.cwd(), // default

  // Global config directory
  agentDir: "~/.pizza/agent", // default (expands ~)
});
```

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.pizza/extensions/`)
- Project skills:
  - `.pizza/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.pizza/prompts/`)
- Context files (`AGENTS.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.pizza/agent/skills/`)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context file (`AGENTS.md`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, createSessionFacade, ModelRegistry } from "pizza";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
const customModel = modelRegistry.find("my-provider", "my-model");

// List available models (those with valid API keys)
const available = await modelRegistry.getAvailable();

const { facade } = await createSessionFacade({
  model: available[0],
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh
  authStorage,
  modelRegistry,
});
```

### Tools

```typescript
// Select specific built-in tools
const { facade } = await createSessionFacade({
  tools: ["read", "bash", "grep", "find", "ls"], // read-only mode
});

// All coding tools (default)
const { facade } = await createSessionFacade({
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
});
```

Available tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

For custom tools, see [extensions](./extensions.md) — custom tools are registered via the extension system using `pizza.registerTool()`.

### Storage

```typescript
// In-memory EventStore (no persistence, useful for tests)
const { facade } = await createSessionFacade({
  storagePath: ":memory:",
});

// Persistent EventStore at custom path
const { facade } = await createSessionFacade({
  storagePath: "/path/to/events.db",
});
```

### Settings

```typescript
import { SettingsManager } from "pizza";

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const { facade } = await createSessionFacade({
  settingsManager,
});
```

### Resource Loader

```typescript
import { DefaultResourceLoader } from "pizza";

const loader = new DefaultResourceLoader({ cwd: process.cwd() });
const { facade } = await createSessionFacade({ resourceLoader: loader });
```

For a completely custom resource loader, implement the `ResourceLoader` interface:

```typescript
import { createExtensionRuntime, type ResourceLoader } from "pizza";

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a minimal assistant.",
  getAppendSystemPrompt: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { facade } = await createSessionFacade({ resourceLoader });
```

## API Reference

### createSessionFacade(options?)

Returns `{ facade: SessionFacade }`.

| Option | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Working directory |
| `agentDir` | `string` | `~/.pizza/agent` | Global config directory |
| `model` | `Model` | First available | LLM model to use |
| `thinkingLevel` | `ThinkingLevel` | `"medium"` | Thinking level |
| `tools` | `string[]` | All coding tools | Built-in tool names |
| `customTools` | `ToolDefinition[]` | `[]` | Additional tool definitions |
| `storagePath` | `string` | Auto-derived | EventStore SQLite path (`:memory:` for in-memory) |
| `authStorage` | `AuthStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `ModelRegistry` | `ModelRegistry.create(authStorage)` | Model resolution |
| `settingsManager` | `SettingsManager` | `SettingsManager.create()` | Settings |
| `resourceLoader` | `ResourceLoader` | `DefaultResourceLoader` | Extension/skill/context discovery |
| `extensions` | `ExtensionFactory[]` | Discovered | Extension factories |
| `sessionDir` | `string` | Auto-derived | Session directory |

### SessionFacade Methods

| Method | Description |
|---|---|
| `prompt(text, images?)` | Send user message, drive reactor to completion |
| `steer(text, images?)` | Interrupt current turn with new message |
| `followUp(text, images?)` | Queue message for after current turn |
| `abort()` | Abort current execution |
| `compact(options?)` | Request context compaction |
| `waitForIdle()` | Promise that resolves when agent finishes |
| `subscribe(handler, options?)` | Subscribe to EventStore event stream |
| `setModel(provider, modelId)` | Change model |
| `setThinkingLevel(level)` | Change thinking level |
| `getProjection()` | Get SessionProjection for context queries |
| `getTools()` / `setTools(tools)` | Tool management |
| `getModel()` / `getThinkingLevel()` | Current settings |
| `dispose()` | Clean up resources |

## Run Modes

The SDK exports run mode utilities for building custom interfaces:

```typescript
import {
  InteractiveMode,
  runPrintModeWithFacade,
  runRpcModeWithFacade,
} from "pizza";
```

- `InteractiveMode` — Full TUI. Use `InteractiveMode.fromFacade()` to create from a facade.
- `runPrintModeWithFacade(facade, options)` — Single-shot execution (text or JSON output).
- `runRpcModeWithFacade(facade, options)` — JSON-RPC over stdio.

## Architecture

The SDK is built on an event-sourced architecture:

- **EventStore** (SQLite) is the single source of truth — all state derives from the event log
- **Reactor** drives agent turns via a handler table (14 handlers)
- **SessionProjection** builds LLM context from events
- **IntentExecutor** is the sole component authorized to execute tool mutations

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the full architecture overview.
