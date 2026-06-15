/**
 * Hello Tool - Minimal custom tool example
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "pizza";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pizza: ExtensionAPI) {
	pizza.registerTool(helloTool);
}
