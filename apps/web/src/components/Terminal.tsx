import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Terminal — a real interactive terminal (xterm.js) backed by a local PTY
 * exposed over WebSocket by the sidecar (`packages/pty/pty-server.ts`).
 *
 * Each mounted instance owns one WS connection → one PTY shell. When the pane
 * is closed/unmounted the shell is killed. `ptyPort` comes from the session
 * state (`get_state` → `ptyPort`); if it is missing the PTY server could not
 * start and we show a graceful message.
 */
export default function Terminal({ workspace, ptyPort }: { workspace?: string | null; ptyPort?: number }) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error" | "unavailable">(
		ptyPort ? "connecting" : "unavailable",
	);

	useEffect(() => {
		if (!ptyPort) {
			setStatus("unavailable");
			return;
		}
		const container = containerRef.current;
		if (!container) return;

		const term = new XTerm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 12,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();
		xtermRef.current = term;
		fitRef.current = fit;

		setStatus("connecting");

		let closedByUs = false;
		const wsUrl = `ws://127.0.0.1:${ptyPort}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		const send = (obj: Record<string, unknown>): void => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
		};

		const spawn = (): void => {
			const cols = term.cols ?? 80;
			const rows = term.rows ?? 24;
			send({ type: "spawn", cwd: workspace ?? undefined, cols, rows });
		};

		ws.onopen = () => {
			setStatus("ready");
			spawn();
		};
		ws.onmessage = (ev) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			switch (msg.type) {
				case "output":
					if (typeof msg.data === "string") term.write(msg.data);
					break;
				case "ready":
					break;
				case "exit":
					term.writeln(`\r\n\x1b[33m[${t("terminal.exited")}${typeof msg.exitCode === "number" ? " " + msg.exitCode : ""}]\x1b[0m`);
					break;
				case "error":
					setStatus("error");
					term.writeln(`\r\n\x1b[31m${typeof msg.message === "string" ? msg.message : "error"}\x1b[0m`);
					break;
			}
		};
		ws.onerror = () => {
			setStatus("error");
			term.writeln(`\r\n\x1b[31m${t("terminal.connectionError")}\x1b[0m`);
		};
		ws.onclose = () => {
			if (!closedByUs) setStatus("error");
		};

		const disposableInput = term.onData((data) => send({ type: "input", data }));
		const disposableResize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

		const onResize = (): void => { try { fit.fit(); } catch { /* ignore */ } };
		const resizeObserver = new ResizeObserver(onResize);
		resizeObserver.observe(container);
		// Fit once layout settles.
		const fitTimer = setTimeout(() => { try { fit.fit(); } catch { /* ignore */ } }, 0);

		return () => {
			closedByUs = true;
			clearTimeout(fitTimer);
			resizeObserver.disconnect();
			disposableInput.dispose();
			disposableResize.dispose();
			try { ws.close(); } catch { /* ignore */ }
			wsRef.current = null;
			term.dispose();
			xtermRef.current = null;
			fitRef.current = null;
		};
	}, [ptyPort, workspace, t]);

	// The container is always mounted; xterm paints into it when a ptyPort exists.
	return (
		<div className="relative h-full w-full bg-bg">
			<div ref={containerRef} className="h-full w-full" />
			{status === "unavailable" && (
				<div className="absolute inset-0 flex items-center justify-center px-4 text-center">
					<div className="font-mono text-xs text-muted">{t("terminal.unavailable")}</div>
				</div>
			)}
			{status === "error" && (
				<div className="pointer-events-none absolute right-2 top-2 rounded bg-surface-2/80 px-1.5 py-0.5 font-mono text-[10px] text-danger">
					{t("terminal.connectionError")}
				</div>
			)}
		</div>
	);
}
