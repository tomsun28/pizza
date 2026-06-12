# JSON Event Stream Mode

```bash
pi --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating pi into other tools or custom UIs.

## Event Types

Events are defined in [`src/core/event-store/events.ts`](../src/core/event-store/events.ts). All events share the `EventBase` structure:

```typescript
interface EventBase {
  event_id: string;       // UUIDv7 (time-ordered)
  workspace_id: string;
  actor_id: string;       // "user" | "coder_agent" | "runtime" | "compactor"
  timestamp: number;      // Unix ms
  type: EventType;        // 53 event types
  payload: unknown;       // type-specific payload
  caused_by?: string;     // causal chain parent event_id
}
```

### Key Event Types

| Event | Actor | Description |
|---|---|---|
| `USER_MESSAGE` | user | User sends a message |
| `AGENT_MESSAGE_START` | coder_agent | LLM response begins |
| `AGENT_MESSAGE_CHUNK` | coder_agent | Streaming text/thinking delta |
| `AGENT_MESSAGE_END` | coder_agent | LLM response complete (contains content, usage, stop_reason) |
| `AGENT_TURN_START` | coder_agent | Turn begins (LLM call) |
| `AGENT_TURN_COMPLETED` | coder_agent | Turn finished (reason: stop/error/aborted) |
| `TOOL_EXECUTION_START` | runtime | Tool execution begins |
| `TOOL_EXECUTION_UPDATE` | runtime | Tool execution progress |
| `TOOL_EXECUTION_END` | runtime | Tool execution complete (result, is_error) |
| `COMPACTION_START` | compactor | Context compaction begins |
| `COMPACTION_END` | compactor | Compaction complete (summary, tokens_before/after) |
| `RETRY_SCHEDULED` | runtime | Error retry scheduled |
| `MODEL_CHANGED` | user | Model switched |

Full event type list: see [`src/core/event-store/types.ts`](../src/core/event-store/types.ts).

## Output Format

Each line is a JSON object. Events are emitted in real-time as the reactor processes:

```json
{"type":"USER_MESSAGE","payload":{"content":"List files"}}
{"type":"AGENT_MESSAGE_START","payload":{"model":{"provider":"anthropic","model_id":"claude-sonnet-4"}}}
{"type":"AGENT_MESSAGE_CHUNK","payload":{"chunk":{"kind":"text_delta","delta":"I'll list"}}}
{"type":"AGENT_MESSAGE_CHUNK","payload":{"chunk":{"kind":"text_delta","delta":" the files."}}}
{"type":"AGENT_MESSAGE_END","payload":{"content":[...],"usage":{"input":150,"output":20}}}
{"type":"AGENT_TURN_COMPLETED","payload":{"reason":"stop"}}
```

## Example

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "AGENT_MESSAGE_END")'
```
