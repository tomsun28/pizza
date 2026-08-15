# Pizza Channels

External message integrations (Discord / Lark / Slack / Telegram / webhook) that
deliver inbound messages into a Pizza workspace agent and relay the agent's
replies back out. Each platform is its own sub-package so its heavy SDK stays
isolated from the core agent.

```
external platform ──message──▶ channel adapter ──▶ channel-core ──tell──▶ gateway ──▶ workspace agent
external platform ◀──reply──── channel adapter ◀─── channel-core ◀──reply─── gateway ◀─── workspace agent
```

## Why this is thin

The gateway already owns the hard parts — agent pool, lifecycle, the uniform
`MessageSource` provenance envelope, and serialization of concurrent messages.
A channel adapter only:

1. receives a platform message,
2. calls `runtime.deliver(workspace, text, { kind, id })` (the synchronous tell),
3. posts the returned reply back to the platform.

So every adapter is ~60 lines of platform glue on top of `channel-core`.

## Provenance

Each delivered message carries `from: { kind: "<platform>", id: "<source>" }`,
rendered inside the agent as a uniform `<message from="discord:#dev-alerts">`
block — the same envelope agent `_tell`s, cron ticks, and watchers use. New
platforms add a `kind` value, nothing else changes.

## Layout

```
packages/channels/
  core/      @tomsun28/pizza-channel-core     shared engine (runtime, provenance, harness)
  discord/   @tomsun28/pizza-channel-discord  discord.js — FULL
  webhook/   @tomsun28/pizza-channel-webhook  plain node http, no SDK — FULL
  telegram/  @tomsun28/pizza-channel-telegram grammy — FULL
  lark/      @tomsun28/pizza-channel-lark     @larksuiteoapi/node-sdk — FULL
  slack/     @tomsun28/pizza-channel-slack    @slack/bolt — SCAFFOLD
```

## Build & run

Channels are workspace packages. Build the core agent first (it provides the
`@tomsun28/pizza/gateway` client), then build + run the channel you want — each
is independent.

```bash
# 1. build the core agent (provides the gateway client types/runtime)
npm run build

# 2. e.g. Discord
npm install                       # installs channel deps incl. discord.js
npm run build -w @tomsun28/pizza-channel-discord
DISCORD_TOKEN=xxx PIZZA_ROUTES='#dev-alerts=myrepo' \
  npm start -w @tomsun28/pizza-channel-discord

# 3. e.g. Lark / Feishu (WebSocket long connection, no public endpoint needed)
npm run build -w @tomsun28/pizza-channel-lark
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx PIZZA_WORKSPACE=myrepo \
  npm start -w @tomsun28/pizza-channel-lark

# 4. e.g. webhook (no SDK)
npm run build -w @tomsun28/pizza-channel-webhook
PIZZA_WORKSPACE=myrepo WEBHOOK_TOKEN=secret \
  npm start -w @tomsun28/pizza-channel-webhook
# curl -s localhost:3002/ -H 'content-type: application/json' -H 'authorization: Bearer secret' \
#   -d '{"message":"hi","source":"ci-bot"}'
```

> Adding `packages/channels/*` to the root workspaces means a plain `npm install` will
> pull every channel's platform SDK. If you only use one channel and want a
> leaner install, remove the others from the root `workspaces` array (or delete
> their directories) — they are fully independent packages.

## Add a new channel

1. Copy `packages/channels/webhook` (simplest) or `packages/channels/discord`.
2. Bump the package name, swap the platform SDK + `messageCreate` handler.
3. Call `runtime.deliver(workspace, text, provenance("<kind>", sourceId))` on the
   inbound message, post the reply back.
4. Add the `kind` to `ChannelType` in `channel-core` (and the UI `ChannelType`).

## Connection to the Channels UI tab

`apps/web/src/lib/channels.ts` defines `ChannelConfig` (the persisted UI config:
type/token/server/channel/workspace). Each adapter's env routes mirror the same
`channel → workspace` mapping; wiring the adapter to read live `ChannelConfig`s
(instead of env) is a future gateway RPC (`list_channels` / `save_channel`) — the
`channel-core` types are already shape-compatible for that drop-in.