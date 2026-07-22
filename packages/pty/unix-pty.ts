/**
 * Minimal Unix PTY for the Bun-compiled standalone binary.
 *
 * `bun build --compile` strips node_modules, so `require("node-pty")` fails at
 * runtime. But a `.node` native addon CAN be required by absolute path. This
 * module loads node-pty's prebuilt `pty.node` (placed next to the binary at
 * `<bin-dir>/prebuilds/<platform>-<arch>/pty.node`) and reproduces the subset
 * of node-pty's UnixTerminal that the Terminal pane needs: spawn, onData,
const logPath = process.env.PIZZA_PTY_LOG === "0" ? null : "/tmp/pizza-pty.log";
 *
 * The write-path backpressure handling (CustomWriteStream) is ported from
 * node-pty (MIT, Microsoft/Daniel Imms) because without it high-volume output
 * / input can stall the event loop.
 *
 * On non-Bun / dev runs the caller should prefer the real `node-pty` package
 * (see pty-server.ts); this is the fallback.
 */

import { EventEmitter } from "node:events";
import { read, writeSync, openSync, appendFileSync } from "node:fs";

// Diagnostics: write to /tmp/pizza-pty.log so failures in the packaged app
// (where stdout/stderr are invisible) are diagnosable. Set PIZZA_PTY_LOG=0 to disable.
const logPath = process.env.PIZZA_PTY_LOG === "0" ? null : "/tmp/pizza-pty.log";
function log(msg: string): void {
	if (!logPath) return;
	try { appendFileSync(logPath, new Date().toISOString() + " " + msg + "\n"); } catch { /* ignore */ }
}
try { if (logPath) openSync(logPath, "a"); } catch { /* ignore */ }

export interface SpawnOptions {
	cwd: string;
	cols: number;
	rows: number;
	env: Record<string, string>;
	/** Absolute path to the directory containing pty.node + spawn-helper. */
	nativeDir: string;
	encoding?: string | null;
}

interface PtyNative {
	fork: (
		file: string,
		args: string[],
		parsedEnv: string[],
		cwd: string,
		cols: number,
		rows: number,
		uid: number,
		gid: number,
		utf8: boolean,
		helper: string,
		cb: (code: number, signal: string) => void,
	) => { pid: number; fd: number; pty: string };
	resize: (fd: number, cols: number, rows: number) => void;
}

/** Resolve the prebuild dir next to the current executable. */
export function resolveNativeDir(platform: string, arch: string): string {
	const os = platform;
	let parts: string[];
	if (os === "darwin") parts = ["darwin", arch === "arm64" ? "arm64" : "x64"];
	else if (os === "win32") parts = ["win32", arch === "arm64" ? "arm64" : "x64"];
	else parts = [os, arch];
	const tag = `${parts[0]}-${parts[1]}`;
	// In a bun --compile binary, process.execPath is the binary itself.
	const binDir = process.execPath
		? (require("node:path").dirname(process.execPath) as string)
		: process.cwd();
	return require("node:path").join(binDir, "prebuilds", tag);
}

/** Load the pty.node native addon from an absolute path. */
export function loadPtyNative(nativeDir: string): PtyNative {
	const file = require("node:path").join(nativeDir, "pty.node");
	return require(file) as PtyNative;
}

class WriteStream {
	private queue: Array<{ buffer: Buffer; offset: number }> = [];
	private immediate: ReturnType<typeof setImmediate> | undefined;
	constructor(private fd: number, private encoding: BufferEncoding) {}
	write(data: string | Buffer): void {
		const buf =
			typeof data === "string" ? Buffer.from(data, this.encoding) : Buffer.from(data);
		if (buf.byteLength === 0) return;
		this.queue.push({ buffer: buf, offset: 0 });
		if (this.queue.length === 1) this.pump();
	}
	private pump = (): void => {
		this.immediate = undefined;
		if (this.queue.length === 0) return;
		const task = this.queue[0];
		try {
			const written = writeSync(this.fd, task.buffer, task.offset, task.buffer.byteLength - task.offset);
			task.offset += written;
			if (task.offset < task.buffer.byteLength) {
				this.immediate = setImmediate(this.pump);
				return;
			}
			this.queue.shift();
			if (this.queue.length > 0) this.immediate = setImmediate(this.pump);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EAGAIN" || code === "ENOBUFS") {
				this.immediate = setImmediate(this.pump);
			} else {
				// Drop on persistent error (e.g. peer gone).
				this.queue.shift();
			}
		}
	};
	dispose(): void {
		if (this.immediate) clearImmediate(this.immediate);
		this.immediate = undefined;
		this.queue = [];
	}
}

export interface MinimalPty {
	pid: number;
	onData(cb: (data: string) => void): void;
	onExit(cb: (exitCode: number) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

export function spawnMinimalPty(file: string, args: string[], opt: SpawnOptions): MinimalPty {
	log(`spawnMinimalPty: file=${file} cwd=${opt.cwd} cols=${opt.cols}x${opt.rows} nativeDir=${opt.nativeDir}`);
	let pty: ReturnType<typeof loadPtyNative>;
	try {
		pty = loadPtyNative(opt.nativeDir);
		log("spawnMinimalPty: native module loaded");
	} catch (e) {
		log(`spawnMinimalPty: loadPtyNative FAILED: ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
	const helper = require("node:path").join(opt.nativeDir, "spawn-helper");
	log(`spawnMinimalPty: helper=${helper} exists=${require("node:fs").existsSync(helper)}`);
	const emitter = new EventEmitter();
	const encoding: BufferEncoding | null =
		opt.encoding === undefined ? "utf8" : (opt.encoding as BufferEncoding | null);

	const env = { ...opt.env };
	env.PWD = opt.cwd;
	env.TERM = env.TERM || "xterm-256color";
	delete (env as Record<string, string>).TMUX;
	delete (env as Record<string, string>).TMUX_PANE;

	const parsedEnv: string[] = [];
	for (const k of Object.keys(env)) {
		const v = env[k];
		if (v !== undefined && v !== null) parsedEnv.push(`${k}=${v}`);
	}

	const utf8 = encoding === "utf8";
	let emittedExit = false;

	let term: { pid: number; fd: number; pty: string };
	try {
		term = pty.fork(
			file,
			args,
			parsedEnv,
			opt.cwd,
			opt.cols,
			opt.rows,
			-1,
			-1,
			utf8,
			helper,
			(code: number, signal: string) => {
				log(`spawnMinimalPty: native onexit code=${code} signal=${signal} pid=${term.pid}`);
				if (emittedExit) return;
				emittedExit = true;
				emitter.emit("exit", code);
			},
		);
		log(`spawnMinimalPty: fork OK pid=${term.pid} fd=${term.fd} pty=${term.pty}`);
	} catch (e) {
		log(`spawnMinimalPty: fork THREW: ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}

	const writeStream = new WriteStream(term.fd, encoding || "utf8");

	// Read the master fd directly with an async fs.read loop. This avoids
	// tty.ReadStream, which under Bun's compiled runtime mis-handles the
	// initial EAGAIN on a freshly forked PTY and closes the stream prematurely
	// (killing the shell's output). EAGAIN = no data yet, keep polling; EIO/EOF
	// = child exited, stop and let the native onexit drive the exit event.
	let reading = true;
	const buf = Buffer.alloc(65536);
	const readLoop = (): void => {
		if (!reading) return;
		read(term.fd, buf, 0, buf.length, null, (err, bytesRead) => {
			if (!reading) return;
			if (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EAGAIN" || code === "EWOULDBLOCK") {
					// No data yet; yield and retry shortly.
					setTimeout(readLoop, 10);
					return;
				}
				if (code === "EIO" || code === "EOF") {
					log("spawnMinimalPty: read loop end (EIO/EOF)");
				reading = false;
				onReadEnd();
					return;
				}
				log(`spawnMinimalPty: read loop error code=${code} msg=${err.message}`);
				reading = false;
				onReadEnd();
				return;
			}
			if (bytesRead === 0) {
				log("spawnMinimalPty: read loop end (0 bytes / EOF)");
				reading = false;
				onReadEnd();
				return;
			}
			const text = encoding ? buf.subarray(0, bytesRead).toString(encoding) : buf.subarray(0, bytesRead).toString();
			emitter.emit("data", text);
			setImmediate(readLoop);
		});
	};
	// Safety net: if the read stream ends but the native onexit never fires,
	// emit a synthetic exit after a grace period so the client isn't left hanging.
	const onReadEnd = (): void => {
		setTimeout(() => {
			if (!emittedExit) {
				log("spawnMinimalPty: grace timeout — emitting exit(-1) (onexit never fired)");
				emittedExit = true;
				emitter.emit("exit", -1);
			}
		}, 500);
	};
	setImmediate(readLoop);


	return {
		pid: term.pid,
		onData: (cb) => emitter.on("data", cb),
		onExit: (cb) => emitter.on("exit", cb),
		write: (data) => writeStream.write(data),
		resize: (cols, rows) => {
			if (cols > 0 && rows > 0) { pty.resize(term.fd, cols, rows); }
		},
		kill: (signal) => {
			try { process.kill(term.pid, signal || "SIGHUP"); } catch { /* ignore */ }
		},
	};
}

