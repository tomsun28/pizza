/**
 * Lark / Feishu channel relay — SCAFFOLD.
 *
 * Structure is complete (runtime, provenance, deliver call, graceful shutdown);
 * the only part left is wiring the Lark SDK's inbound-message event. See the
 * TODO below. @larksuiteoapi/node-sdk docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/sdk-reference
 *
 * Env:
 *   LARK_APP_ID / LARK_APP_SECRET   app credentials from the Feishu developer console
 *   PIZZA_WORKSPACE                 target workspace
 *   PIZZA_ROUTES                    "#chatId=workspace,…" for per-chat routing (optional)
 */

import { ChannelRuntime, parseRoutes, provenance, runChannel } from "@tomsun28/pizza-channel-core";

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const WORKSPACE = process.env.PIZZA_WORKSPACE;
const ROUTES = parseRoutes(process.env.PIZZA_ROUTES ?? "");

if (!APP_ID || !APP_SECRET) {
	console.error("Missing LARK_APP_ID / LARK_APP_SECRET.");
	process.exit(1);
}
if (!WORKSPACE && Object.keys(ROUTES).length === 0) {
	console.error("Set PIZZA_WORKSPACE (or PIZZA_ROUTES) so Lark messages have a target.");
	process.exit(1);
}

void runChannel(async (runtime: ChannelRuntime) => {
	// TODO(lark): create the client + register the message event, e.g.:
	//
	//   import * as lark from "@larksuiteoapi/node-sdk";
	//   const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu });
	//   const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.info });
	//   wsClient.start({
	//     eventDispatcher: new lark.EventDispatcher({}).register({
	//       "im.message.receive_v1": async (data) => {
	//         const chatId = data.message.chat_id ?? "dm";
	//         const text = JSON.parse(data.message.content ?? "{}").text ?? "";
	//         const workspace = ROUTES[`#${chatId}`] ?? WORKSPACE;
	//         const reply = await runtime.deliver(workspace!, text, provenance("lark", chatId));
	//         await client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, content: JSON.stringify({ text: reply }) } });
	//       },
	//     }),
	//   });
	//
	// Verify the exact event name / payload shape against the current SDK version
	// before shipping. Lark can also deliver via HTTP webhook (event subscription)
	// instead of the long-poll WSClient — pick whichever fits your deployment.

	console.warn("[lark] scaffold: implement the SDK wiring at the TODO in src/index.ts");
	const noop = (): Promise<void> => Promise.resolve();
	return noop;
});