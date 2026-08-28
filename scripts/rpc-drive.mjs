#!/usr/bin/env node
/**
 * End-to-end simulation driver: talks JSONL to a pizza binary in rpc mode
 * (the same protocol Pizza.app spawns) and exercises the queued-message
 * semantics against a real LLM:
 *
 *   S1  plain prompt completes
 *   S2  follow_up queued mid-tool-round runs as its own turn afterwards
 *   S3  steer mid-tool-round aborts the turn and runs as a new turn
 *   S4  abort drops a queued follow-up (USER_FOLLOWUP_DROPPED, never runs)
 *   S5  runtime is still healthy afterwards (not wedged)
 *
 * Usage:
 *   node scripts/rpc-drive.mjs [path-to-pizza-binary]
 *   # default binary: /Applications/Pizza.app/Contents/Resources/pizza
 *   # (any `pizza --mode rpc` capable build works, e.g. dist/pizza)
 *
 * Requires a configured model (auth.json / settings.json defaults).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const BIN = process.argv[2] ?? "/Applications/Pizza.app/Contents/Resources/pizza";
const cwd = mkdtempSync(join(tmpdir(), "pizza-desktop-sim-"));
writeFileSync(join(cwd, "note.txt"), "hello from sim\n");

const proc = spawn(BIN, ["--mode", "rpc"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
proc.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

const rl = readline.createInterface({ input: proc.stdout });
const events = [];
const responses = new Map();
const waiters = [];
let nextId = 1;
let cursor = 0; // highest sequence seen

function send(type, extra = {}) {
	const id = `cmd-${nextId++}`;
	return new Promise((resolve) => {
		responses.set(id, resolve);
		proc.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
	});
}

rl.on("line", (line) => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.type === "response") {
		if (msg.id && responses.has(msg.id)) {
			responses.get(msg.id)(msg);
			responses.delete(msg.id);
		}
		return;
	}
	events.push(msg);
	if (typeof msg.sequence === "number") cursor = Math.max(cursor, msg.sequence);
	if (process.env.SIM_DEBUG) console.log(`  [dbg] seq=${msg.sequence ?? "?"} ${msg.type} ${JSON.stringify(msg.payload ?? {}).slice(0, 100)}`);
	for (const w of [...waiters]) {
		if (msg.type === w.type && w.pred(msg) && (msg.sequence ?? 0) > w.minSeq) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(msg);
		}
	}
});

/**
 * Wait until the number of events of `type` matching `pred` reaches `targetN`.
 * Count-based (not cursor-based): robust regardless of when events arrive
 * relative to command acks (stdout buffering can delay acks arbitrarily).
 */
function waitForCount(type, targetN, timeoutMs = 120000, pred = () => true) {
	const matches = () => events.filter((e) => e.type === type && pred(e));
	return new Promise((resolve, reject) => {
		const check = () => {
			const m = matches();
			if (m.length >= targetN) { clearInterval(poll); clearTimeout(t); resolve(m[m.length - 1]); }
		};
		const poll = setInterval(check, 50);
		const t = setTimeout(() => {
			clearInterval(poll);
			reject(new Error(`timeout waiting for ${targetN}x ${type} (have ${matches().length})`));
		}, timeoutMs);
		check();
	});
}

const count = (type) => events.filter((e) => e.type === type).length;
const lastAssistantText = () => {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type === "AGENT_MESSAGE_END") {
			const c = (e.payload ?? {}).content ?? [];
			const texts = c.filter((b) => b.type === "text").map((b) => b.text).join("");
			if (texts.trim()) return texts;
		}
	}
	return "";
};
const fail = (m) => { console.error(`❌ ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`✅ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
	const compl = () => count("AGENT_TURN_COMPLETED");

	// ── S1: normal prompt runs to completion ──────────────────────────────
	let r = await send("prompt", { message: "Reply with exactly: PONG1" });
	if (!r.success) fail(`S1 prompt rejected: ${JSON.stringify(r)}`);
	await waitForCount("AGENT_TURN_COMPLETED", compl() + 1, 120000);
	/PONG1/.test(lastAssistantText())
		? ok("S1 prompt completed, assistant replied PONG1")
		: fail(`S1 unexpected reply: ${lastAssistantText().slice(0, 60)}`);

	// ── S2: follow_up during a running turn is delivered after it ─────────
	// The tool (sleep 3) runs for ~3s; poll until a tool round is in flight,
	// then queue the follow-up mid-turn.
	r = await send("prompt", { message: "Use the cli tool to run exactly: sleep 3 && echo done-slow — then reply DONE-SLOW." });
	if (!r.success) fail(`S2 prompt rejected: ${JSON.stringify(r)}`);
	const s2Starts = count("TOOL_EXECUTION_START");
	await waitForCount("TOOL_EXECUTION_START", s2Starts + 1, 120000);
	const s2Ends = count("TOOL_EXECUTION_END");
	// Tool still executing? (sleep 3 gives us a window). If it already ended,
	// the follow_up still must be delivered after the turn — both outcomes valid.
	const midTurn = count("TOOL_EXECUTION_END") === s2Ends;
	console.log(`  [S2] tool round in flight (midTurn=${midTurn})`);
	r = await send("follow_up", { message: "Reply with exactly: QUEUED-RAN" });
	if (!r.success) fail(`S2 follow_up rejected: ${JSON.stringify(r)}`);
	const s2Done = compl();
	await waitForCount("AGENT_TURN_COMPLETED", s2Done + 2, 180000); // slow turn + follow-up turn
	const s2Text = lastAssistantText();
	/QUEUED-RAN/.test(s2Text)
		? ok(`S2 queued follow_up ran as its own turn (replied: ${s2Text.slice(0, 40)})`)
		: fail(`S2 follow-up turn answered something else: ${s2Text.slice(0, 80)}`);

	// ── S3: steer during a running turn interrupts + delivers ─────────────
	const s3Starts = count("TOOL_EXECUTION_START");
	r = await send("prompt", { message: "Use the cli tool to run exactly: sleep 12 && echo never — then reply NEVER." });
	await waitForCount("TOOL_EXECUTION_START", s3Starts + 1, 120000);
	const s3AbortBase = events.filter((e) => e.type === "AGENT_TURN_COMPLETED" && (e.payload ?? {}).reason === "aborted").length;
	r = await send("steer", { message: "Reply with exactly: STEERED" });
	if (!r.success) fail(`S3 steer rejected: ${JSON.stringify(r)}`);
	await waitForCount("AGENT_TURN_COMPLETED", s3AbortBase + 1, 60000, (e) => (e.payload ?? {}).reason === "aborted");
	ok("S3 turn aborted on steer");
	const s3Done = compl();
	await waitForCount("AGENT_TURN_COMPLETED", s3Done + 1, 120000);
	const s3Text = lastAssistantText();
	/STEERED/.test(s3Text)
		? ok(`S3 steer content delivered as new turn (replied: ${s3Text.slice(0, 40)})`)
		: fail(`S3 steer turn answered something else: ${s3Text.slice(0, 80)}`);

	// ── S4: abort with a queued follow_up drops it ────────────────────────
	const s4Starts = count("TOOL_EXECUTION_START");
	r = await send("prompt", { message: "Use the cli tool to run exactly: sleep 12 && echo never2 — then reply NEVER2." });
	await waitForCount("TOOL_EXECUTION_START", s4Starts + 1, 120000);
	await send("follow_up", { message: "SHOULD-BE-DROPPED" });
	const st = await send("get_state");
	console.log(`  [S4] state: ${JSON.stringify(st.data ?? st.result ?? {}).slice(0, 220)}`);
	const s4AbortBase = events.filter((e) => e.type === "AGENT_TURN_COMPLETED" && (e.payload ?? {}).reason === "aborted").length;
	const s4DropBase = count("USER_FOLLOWUP_DROPPED");
	await send("abort");
	await waitForCount("USER_FOLLOWUP_DROPPED", s4DropBase + 1, 60000);
	ok("S4 follow-up dropped on abort");
	await waitForCount("AGENT_TURN_COMPLETED", s4AbortBase + 1, 60000, (e) => (e.payload ?? {}).reason === "aborted");
	await sleep(2000);
	const ranAnyway = events.some((e) => e.type === "USER_MESSAGE" && JSON.stringify(e.payload ?? {}).includes("SHOULD-BE-DROPPED"));
	ranAnyway ? fail("S4 dropped follow-up ran anyway") : ok("S4 dropped follow-up did not run");

	// ── S5: runtime still healthy ─────────────────────────────────────────
	const s5Done = compl();
	r = await send("prompt", { message: "Reply with exactly: FINAL" });
	if (!r.success) fail(`S5 prompt rejected: ${JSON.stringify(r)}`);
	await waitForCount("AGENT_TURN_COMPLETED", s5Done + 1, 120000);
	/FINAL/.test(lastAssistantText())
		? ok("S5 final prompt completed with FINAL — runtime not wedged")
		: fail(`S5 unexpected reply: ${lastAssistantText().slice(0, 60)}`);

	console.log(`\n=== SUMMARY: completions=${count("AGENT_TURN_COMPLETED")} userMessages=${count("USER_MESSAGE")} toolStarts=${count("TOOL_EXECUTION_START")} dropped=${count("USER_FOLLOWUP_DROPPED")} ===`);
	console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: ALL PASS");
} catch (e) {
	fail(`driver error: ${e.message}`);
} finally {
	proc.kill();
	setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
