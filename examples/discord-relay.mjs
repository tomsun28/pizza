/** NOTE: this is a zero-build single-file demo. The real, maintained package lives at packages/channels/discord (@tomsun28/pizza-channel-discord). Use that for anything serious. */
/**
 * Discord ↔ Pizza gateway relay (thin "external message channel").
 *
 * This is the minimal skeleton for ONE of pizza's "channels" (Discord / Lark /
 * Slack / Telegram / webhook): an external chat platform whose messages get
 * delivered into a workspace agent, with the agent's reply relayed back out.
 *
 * Why this is thin: the gateway already does the heavy lifting. We only
 *   1. receive a Discord message,
 *   2. hand it to the gateway via a synchronous `tell` (carrying provenance),
 *   3. post the returned reply back to Discord.
 * No event-stream plumbing, no agent lifecycle, no state — the gateway owns the
 * agent pool, serializes concurrent tells, and routes the reply back to us.
 *
 * Provenance is the whole point: every delivered message carries
 *   from: { kind: "discord", id: "#dev-alerts" }
 * so the agent sees a uniform <message from="discord:#dev-alerts"> block — the
 * same envelope used by agent tells, cron ticks, watchers and webhooks.
 *
 * ── Architecture ──────────────────────────────────────────────────────
 *
 *   Discord ──(@bot / DM)──▶ discord.js client
 *       onMessageCreate(msg):
 *         workspace = ROUTES[msg.channel.name]      // channel → workspace map
 *         reply = await gw.tell(workspace, msg.text, {kind:"discord", id:`#${msg.channel.name}`})
 *         msg.reply(reply)
 *                                   │
 *                                   ▼  tell (Layer-1, sync, with `from`)
 *                          [pizza gateway daemon]  ──▶ [workspace agent (Reactor)]
 *                                                         sees from="discord:#dev-alerts",
 *                                                         returns final assistant text
 *
 * ── Run ─────────────────────────────────────────────────────────────────
 *
 *   1. Build pizza:        npm run build
 *   2. Install discord.js: npm i discord.js        # example-only dep, not added to pizza
 *   3. Create a Discord bot, get its token, invite it to your server.
 *   4. Configure (env, see CONFIG below) and run:
 *
 *        DISCORD_TOKEN=xxx \
 *        PIZZA_ROUTES='#dev-alerts=myrepo,#general=myrepo' \
 *        node examples/discord-relay.mjs
 *
 * ── Maps to ChannelConfig (apps/web/src/lib/channels.ts) ───────────────
 *
 *   ChannelConfig.token     → DISCORD_TOKEN        (bot token)
 *   ChannelConfig.server    → guild filter         (which server, optional)
 *   ChannelConfig.channel   → routing key + the `id` in `from` provenance
 *   ChannelConfig.workspace → the pizza workspace cwd/name that `tell` targets
 *   ChannelConfig.enabled   → whether this route is active
 *
 * In a real build, ROUTES below is built from the persisted ChannelConfigs the
 * Channels tab manages; here it comes from PIZZA_ROUTES for a standalone demo.
 */

import { Client, GatewayIntentBits } from "discord.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayClient, ensureGateway, gatewaySocketPath } from "../dist/packages/gateway/index.js";

// ── Config ───────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
/** "#channelA=workspaceA,#channelB=workspaceB" — Discord channel → pizza workspace (cwd or name). */
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");
/** Only answer @mentions of the bot or DMs. Set PIZZA_ANSWER_ALL=1 to reply to every message. */
const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";
/** Per-message tell timeout (ms). The gateway queues same-agent tells, so allow for a full turn. */
const TELL_TIMEOUT_MS = Number(process.env.PIZZA_TELL_TIMEOUT ?? 120_000);
const AGENT_DIR = process.env.PIZZA_AGENT_DIR ?? join(homedir(), ".pizza", "agent");

if (!DISCORD_TOKEN) {
	console.error("Missing DISCORD_TOKEN. Create a bot at https://discord.com/developers/applications.");
	process.exit(1);
}
if (Object.keys(ROUTES).length === 0) {
	console.error('Missing PIZZA_ROUTES, e.g. PIZZA_ROUTES="#dev-alerts=myrepo,#general=myrepo".');
	process.exit(1);
}

function parseRoutes(raw) {
	const out = {};
	for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
		const [channel, workspace] = pair.split("=").map((s) => s.trim());
		if (channel && workspace) out[channel] = workspace;
	}
	return out;
}

// ── Gateway client (one long-lived connection, reused for every message) ──

const socketPath = await ensureGateway(AGENT_DIR, gatewaySocketPath());
const gw = new GatewayClient({ socketPath, connectTimeout: 5_000 });
await gw.connect();
console.log(`[relay] connected to gateway ${socketPath}`);
console.log(`[relay] routes: ${Object.entries(ROUTES).map(([c, w]) => `${c}→${w}`).join(", ")}`);

// ── Discord client ───────────────────────────────────────────────────────

const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
	],
});

discord.on("ready", () => console.log(`[relay] logged in as ${discord.user.tag}`));

discord.on("messageCreate", async (msg) => {
	// Never loop on our own or other bots' messages.
	if (msg.author.bot) return;

	const channelName = msg.channel.name ? `#${msg.channel.name}` : "dm";
	const workspace = ROUTES[channelName];
	// Only handle channels we have a route for.
	if (!workspace) return;
	// By default respond only to @mentions or DMs; ANSWER_ALL opts into everything.
	const isMention = msg.mentions.has(discord.user.id);
	const isDm = msg.channel.isDMBased?.();
	if (!ANSWER_ALL && !isMention && !isDm) return;

	// Strip the @bot mention so the agent gets the clean prompt text.
	const text = msg.content.replace(/<@!?\d+>/g, "").trim();
	if (!text) return;

	// Reflect "typing" while the agent works — it may take a while.
	await msg.channel.sendTyping().catch(() => {});
	const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8_000);

	try {
		// The core: deliver to the workspace agent with Discord provenance.
		// `tell` is synchronous — it resolves with the agent's final reply text.
		// Concurrent tells to the same workspace are serialized by the gateway.
		const reply = await gw.tell(
			workspace,
			text,
			{ kind: "discord", id: channelName }, // → agent sees: <message from="discord:#dev-alerts">
			TELL_TIMEOUT_MS,
		);
		// Discord caps messages at 2000 chars; split if the agent wrote a long reply.
		for (const chunk of chunkText(reply, 1900)) {
			await msg.reply(chunk);
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[relay] tell failed for ${channelName}→${workspace}:`, reason);
		await msg.reply(`⚠️ Could not reach the agent (${reason}).`).catch(() => {});
	} finally {
		clearInterval(typing);
	}
});

function chunkText(text, size) {
	if (!text) return [];
	const chunks = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

// ── Graceful shutdown ────────────────────────────────────────────────────

async function shutdown() {
	console.log("[relay] shutting down…");
	await gw.disconnect().catch(() => {});
	await discord.destroy().catch(() => {});
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await discord.login(DISCORD_TOKEN);