/**
 * Slack channel relay — SCAFFOLD.
 *
 * Structure is complete; the only part left is wiring @slack/bolt's app_mention
 * / message events. See the TODO below. Bolt docs: https://slack.dev/bolt-js/tutorial/getting-started
 *
 * Env:
 *   SLACK_BOT_TOKEN        xoxb-… token
 *   SLACK_SIGNING_SECRET   from the app config
 *   PIZZA_WORKSPACE        target workspace
 *   PIZZA_ROUTES           "#channel=workspace,…" for per-channel routing (optional)
 *
 * Note: Bolt's HTTP receiver needs a public endpoint (Socket Mode avoids that —
 * set SLACK_APP_TOKEN for socket-mode, staying closer to local-first).
 */

import { ChannelRuntime, parseRoutes, provenance, runChannel } from "@tomsun28/pizza-channel-core";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");

if (!BOT_TOKEN || !SIGNING_SECRET) {
	console.error("Missing SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET.");
	process.exit(1);
}
if (!WORKSPACE && Object.keys(ROUTES).length === 0) {
	console.error("Set PIZZA_WORKSPACE (or PIZZA_ROUTES) so Slack messages have a target.");
	process.exit(1);
}

void runChannel(async (runtime: ChannelRuntime) => {
	// TODO(slack): wire @slack/bolt, e.g. (Socket Mode to stay local-first):
	//
	//   import { App } from "@slack/bolt";
	//   const app = new App({ token: BOT_TOKEN, signingSecret: SIGNING_SECRET, socketMode: Boolean(process.env.SLACK_APP_TOKEN), appToken: process.env.SLACK_APP_TOKEN });
	//   app.event("app_mention", async ({ event, say, client }) => {
	//     const channel = `#${event.channel}`;
	//     const workspace = ROUTES[channel] ?? WORKSPACE;
	//     const reply = await runtime.deliver(workspace!, event.text, provenance("slack", channel));
	//     for (const part of chunk(reply, 2900)) await say(part);
	//   });
	//   await app.start();
	//
	// Verify the exact event/payload shape against the current @slack/bolt version.

	console.warn("[slack] scaffold: implement the SDK wiring at the TODO in src/index.ts");
	const noop = (): Promise<void> => Promise.resolve();
	return noop;
});

function chunk(text: string, size = 2900): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}