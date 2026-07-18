import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../packages/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Interactive example of using coding-agent via RpcClient.
 * Usage: npx tsx test/rpc-example.ts
 */

async function main() {
	const client = new RpcClient({
		cliPath: join(__dirname, "../dist/cli.js"),
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		args: ["--no-session"],
	});

	// Stream events to console
	client.onEvent((event) => {
		if (event.type === "AGENT_MESSAGE_CHUNK") {
			const payload = event.payload as { chunk?: { delta?: string; content?: string } };
			process.stdout.write(payload.chunk?.delta ?? payload.chunk?.content ?? "");
		}

		if (event.type === "TOOL_EXECUTION_START") {
			const payload = event.payload as { tool_name?: string };
			console.log(`\n[Tool: ${payload.tool_name ?? "tool"}]`);
		}

		if (event.type === "TOOL_EXECUTION_END") {
			const payload = event.payload as { result?: unknown };
			console.log(`[Result: ${JSON.stringify(payload.result).slice(0, 200)}...]\n`);
		}
	});

	await client.start();

	const state = await client.getState();
	console.log(`Model: ${state.model?.provider}/${state.model?.id}`);
	console.log(`Thinking: ${state.thinkingLevel ?? "off"}\n`);

	// Handle user input
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	let isWaiting = false;

	const prompt = () => {
		if (!isWaiting) process.stdout.write("You: ");
	};

	rl.on("line", async (line) => {
		if (isWaiting) return;
		if (line.trim() === "exit") {
			await client.stop();
			process.exit(0);
		}

		isWaiting = true;
		await client.promptAndWait(line);
		console.log("\n");
		isWaiting = false;
		prompt();
	});

	rl.on("SIGINT", () => {
		if (isWaiting) {
			console.log("\n[Aborting...]");
			client.abort();
		} else {
			client.stop();
			process.exit(0);
		}
	});

	console.log("Interactive RPC example. Type 'exit' to quit.\n");
	prompt();
}

main().catch(console.error);
