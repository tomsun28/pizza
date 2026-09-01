# Gateway — Agent Pool, Messaging & Desktop Backbone

The **gateway** is a single long-running daemon (`pizza --mode gateway`) that
owns every background agent process. It started as the router for `_tell`
agent-to-agent messaging and has since become the desktop app's backbone: the
GUI, `_tell`, and the task scheduler all share one agent pool.

Responsibilities:

1. **Agent pool** — one `RpcClient`-managed agent process per workspace cwd.
   Every consumer (GUI window, `_tell`, scheduler) reuses the same live agent;
   nothing spawns bare sidecars anymore.
2. **Message routing** — `_tell` messages flow through the gateway, never
   agent-to-agent directly. Replies are relayed back automatically.
3. **Channel multiplexing** — desktop windows `attach` to workspaces over one
   socket connection; events fan out to every subscriber, rpc responses return
   to the requesting channel only.
4. **Scheduler guard** — any workspace with runnable scheduled tasks is
   guaranteed a live agent (spawned if missing, pinned against idle eviction).
   Scheduled tasks keep firing after the GUI quits — the daemon outlives it.
5. **Auto-start & upgrade** — clients spawn the daemon on demand (like
   `ssh-agent`) and replace it on version mismatch after draining busy agents.

```
  GUI window        _tell (agent A)      scheduler guard (internal tick)
      │ attach/rpc        │ tell                 │ getOrCreateAgent
      └──────────► ~/.pizza/gateway.sock ◄───────┘
                          │
                    ┌─────┴──────┐
                    │  Gateway    │
                    └─────┬──────┘
                 ┌────────┼────────┐
            RpcClient  RpcClient  RpcClient
            (~/.pizza/main) (/proj-a) (/proj-b)
```

## Files

| File | Responsibility |
|------|---------------|
| `packages/gateway/protocol.ts` | Wire types (JSONL over Unix socket / named pipe) |
| `packages/gateway/gateway-server.ts` | Daemon: socket server, agent pool, router, channels, scheduler guard |
| `packages/gateway/gateway-client.ts` | One-shot client: connect → `tell()` → disconnect |
| `packages/gateway/channel-client.ts` | Persistent channel client (attach / rpc / event stream) |
| `packages/gateway/gateway-lifecycle.ts` | `ensureGateway()` — auto-start, version check, restart |
| `packages/gateway/scheduler-guard.ts` | Disk scan: which cwds have runnable scheduled tasks |
| `packages/gateway/jsonl.ts` | JSONL line reader/serializer |
| `src/core/tools/tell.ts` | The `_tell` built-in command |
| `apps/desktop/src/gateway_channel.rs` | Rust channel client (desktop bridge) |

## Wire Protocol

Newline-delimited JSON over a single socket connection
(`~/.pizza/gateway.sock`; named pipe on Windows).

**Messaging & control:**

```json
{ "type": "tell", "id": "req_1", "to": "web", "message": "...", "from": { "kind": "agent", "id": "/proj/pizza" } }
{ "type": "ping" }
{ "type": "status" }
{ "type": "shutdown" }
```

Responses: `tell_result` (delivery ack), `pong`, `status_result` (uptime,
version, per-agent busy/queue), `shutdown_ok`.

**Channel protocol (persistent connections, e.g. desktop windows):**

```json
{ "type": "attach", "workspace": "~/.pizza/main" }
{ "type": "rpc", "workspace": "...", "frame": { "id": "...", "type": "get_state" } }
{ "type": "detach", "workspace": "..." }
{ "type": "list" }
```

Responses: `attach_ok`, `rpc` (response frame with the request's id — errors
come back as `success:false` frames carrying the same id, so clients never
hang on a lost request), `list_result`. Agent events fan out to all attached
channels as `rpc` frames.

## `_tell` — Asynchronous by Design

`_tell send` returns a **delivery ack** (`messageId`) immediately; it never
blocks on the reply. When the receiving agent's turn settles, the gateway
relays its final assistant text back to the sender as a new inbound message.

Every delivery is wrapped with sender provenance:

```
<message from="agent:web" id="m_lr4f2k" relay="auto">
what is in package.json?
</message>
```

- `from` is `kind:id` — uniform across source kinds (`agent:`, and future
  `cron:` / `watcher:` / `webhook:` triggers reuse the same envelope).
- `relay="auto"` marks deliveries whose reply the gateway routes back
  automatically — the receiver just answers normally, no explicit tell-back.

```bash
pizza --mode gateway                     # manual start (normally auto-started)
_tell list                               # show known workspaces
_tell send --to web --message "..."      # returns ack; reply arrives later
_tell send web "fix the bug"             # positional form
```

## Agent Pool Semantics

- Keyed by workspace cwd; the main agent (`~/.pizza/main`) is spawned with
  `--main` and holds the main single-instance lock.
- **Concurrent spawn requests for the same cwd are deduped** onto one
  in-flight promise. (Without this, the scheduler-guard tick racing a channel
  rpc spawned twin processes; the lock-race loser's teardown evicted the
  winner from the pool, orphaning a live lock-holder and permanently wedging
  the workspace — the desktop "stuck on Starting..." bug.)
- Concurrent tells to the same agent are serialized (queued).
- Idle agents are torn down after 10 minutes — unless busy, subscribed to by
  a live channel, or pinned by the scheduler guard.
- If an agent process dies on its own, its pool entry is evicted immediately.

## Desktop Integration

The Tauri bridge speaks the channel protocol (`gateway_channel.rs`): each
window attaches to its workspace, rpc frames carry Layer-0 commands, and the
gateway daemon — not the GUI — owns all agent processes. Closing the GUI
leaves agents (and scheduled tasks) running.

## Future Ideas

- **Presence** — expose busy/idle per agent to `_tell list`.
- **`_broadcast`** — send one message to all known workspaces.
- **External triggers** — cron/watcher/webhook events delivered through the
  same `MessageSource` envelope (`kind` ≠ agent), no new message types needed.