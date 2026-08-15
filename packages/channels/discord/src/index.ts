/**
 * Discord channel relay — a thin adapter on top of channel-core.
 *
 * Receives Discord messages, hands them to the workspace agent via the gateway
 * (with Discord provenance), and posts the agent's reply back. All the heavy
 * lifting (agent pool, provenance envelope, concurrent-tell serialization,
 * timeouts) lives in channel-core / the gateway — this file only knows Discord.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-discord
 *   DISCORD_TOKEN=xxx PIZZA_ROUTES='#dev-alerts=myrepo,#general=myrepo' \
 *     npm start -w @tomsun28/pizza-channel-discord
 *
 * Env:
 *   DISCORD_TOKEN    bot token (https://discord.com/developers/applications)
 *   PIZZA_ROUTES     "#channel=workspace,…" — which Discord channel → which agent workspace
 *   PIZZA_ANSWER_ALL set "1" to reply to every message (default: only @bot / DMs)
 *   PIZZA_TELL_TIMEOUT  per-message timeout ms (default 120000)
 */

import { Client, GatewayIntentBits, type Message } from "discord.js";
import {
	ChannelRuntime,
	parseRoutes,
	provenance,
	runChannel,
} from "@tomsun28/pizza-channel-core";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");
const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";

if (!DISCORD_TOKEN) {
	console.error("Missing DISCORD_TOKEN. Create a bot at https://discord.com/developers/applications.");
	process.exit(1);
}
if (Object.keys(ROUTES).length === 0) {
	console.error('Missing PIZZA_ROUTES, e.g. PIZZA_ROUTES="#dev-alerts=myrepo,#general=myrepo".');
	process.exit(1);
}

/** Discord caps a message at 2000 chars; split long agent replies. */
function chunk(text: string, size = 1900): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

void runChannel(async (runtime: ChannelRuntime) => {
	const discord = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
	});

	discord.once("ready", () => console.log(`[discord] logged in as ${discord.user?.tag}`));

	discord.on("messageCreate", async (msg: Message) => {
		if (msg.author.bot) return; // never loop on bots

		const channelName = msg.channel.isDMBased() ? "dm" : `#${msg.channel.name ?? "unknown"}`;
		const workspace = ROUTES[channelName];
		if (!workspace) return; // no route for this channel

		// Default: answer only @mentions or DMs. ANSWER_ALL replies to everything.
		const isMention = msg.mentions.users.has(discord.user!.id);
		if (!ANSWER_ALL && !isMention && !msg.channel.isDMBased()) return;

		const text = msg.content.replace(/<@!?\d+>/g, "").trim(); // strip the @bot mention
		if (!text) return;

		// Reflect "typing" while the agent works (it may take a while). Not every
		// channel kind can be typed in (e.g. partial group DMs), hence the guard.
		const typeable = msg.channel.isSendable() ? msg.channel : undefined;
		await typeable?.sendTyping().catch(() => {});
		const typing = setInterval(() => void typeable?.sendTyping().catch(() => {}), 8_000);

		try {
			const reply = await runtime.deliver(workspace, text, provenance("discord", channelName));
			for (const part of chunk(reply)) await msg.reply(part);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[discord] deliver failed for ${channelName}→${workspace}:`, reason);
			await msg.reply(`⚠️ Could not reach the agent (${reason}).`).catch(() => {});
		} finally {
			clearInterval(typing);
		}
	});

	await discord.login(DISCORD_TOKEN);
	return async () => {
		discord.removeAllListeners();
		await discord.destroy();
	};
});