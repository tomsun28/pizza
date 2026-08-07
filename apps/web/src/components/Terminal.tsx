import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme, type Theme } from "@/lib/theme";

/**
 * Terminal — a real interactive terminal (xterm.js) backed by a local PTY
 * exposed over WebSocket by the sidecar (`packages/pty/pty-server.ts`).
 *
 * Each mounted instance owns one WS connection → one PTY shell. When the pane
 * is unmounted the shell is killed. `ptyPort` comes from the session state
 * (`get_state` → `ptyPort`); if it is missing the PTY server could not start
 * and we show a graceful message.
 *
 * `visible` controls whether the pane is currently shown (e.g. the active tab
 * in a multi-tab dock). The xterm instance is kept mounted while hidden so the
 * PTY session survives tab switches; when visibility returns we re-fit the
 * terminal to its new pixel size.
 *
 * The terminal's color theme follows the app theme (light/dark) — the same
 * tokens used by the rest of the UI (`--bg`, `--fg`, …). Switching themes
 * updates the xterm colors live without restarting the shell.
 */

/** xterm.js theme derived from the app's CSS tokens. */
function xtermTheme(theme: Theme): Record<string, string> {
	if (theme === "dark") {
		return {
			background: "#0a0a0f",
			foreground: "#dcd8d0",
			cursor: "#dcd8d0",
			cursorAccent: "#0a0a0f",
			selectionBackground: "#1a1a2e",
			black: "#0a0a0f",
			red: "#ff5c68",
			green: "#7ee787",
			yellow: "#e3b341",
			blue: "#6cb6ff",
			magenta: "#d2a8ff",
			cyan: "#76e3ea",
			white: "#dcd8d0",
			brightBlack: "#8888aa",
			brightRed: "#ff8b96",
			brightGreen: "#9bf2a0",
			brightYellow: "#f0c674",
			brightBlue: "#9cc4ff",
			brightMagenta: "#e6c2ff",
			brightCyan: "#a0f0f7",
			brightWhite: "#fffdf8",
		};
	}
	return {
		background: "#f5f4ee",
		foreground: "#1f1e1b",
		cursor: "#1f1e1b",
		cursorAccent: "#f5f4ee",
		selectionBackground: "#d6d2c7",
		black: "#1f1e1b",
		red: "#b42318",
		green: "#1a7f37",
		yellow: "#9a6700",
		blue: "#0969da",
		magenta: "#8250df",
		cyan: "#1b7c83",
		white: "#6b685f",
		brightBlack: "#6b685f",
		brightRed: "#d1242f",
		brightGreen: "#2da44e",
		brightYellow: "#bf8700",
		brightBlue: "#218bff",
		brightMagenta: "#a371f7",
		brightCyan: "#3192aa",
		brightWhite: "#1f1e1b",
	};
}

export default function Terminal({
	workspace,
	ptyPort,
	visible = true,
}: {
	workspace?: string | null;
	ptyPort?: number;
	visible?: boolean;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
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
			theme: xtermTheme(theme),
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

		const onResize = (): void => {
			// Skip fitting while the pane is hidden (zero size) — we re-fit on
			// visibility change instead, which avoids collapsing the PTY to 0×0.
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			try { fit.fit(); } catch { /* ignore */ }
		};
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
		// theme is intentionally read at creation time only; live theme
		// changes are handled by the separate effect below so the PTY session
		// is never restarted on a theme switch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ptyPort, workspace, t]);

	// Apply theme changes live to the existing xterm instance without
	// restarting the shell. xterm picks up `options.theme` on assignment.
	useEffect(() => {
		const term = xtermRef.current;
		if (!term) return;
		term.options.theme = xtermTheme(theme) as unknown as typeof term.options.theme;
	}, [theme]);

	// Re-fit when the pane becomes visible again (e.g. switching back to its
	// tab). While hidden the container has zero size, so we must wait until it
	// is shown to compute correct cols/rows.
	useEffect(() => {
		if (!visible) return;
		const fit = fitRef.current;
		const container = containerRef.current;
		if (!fit || !container) return;
		// Defer two frames so layout has flushed the display change.
		const id = requestAnimationFrame(() => requestAnimationFrame(() => {
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			try { fit.fit(); } catch { /* ignore */ }
		}));
		return () => cancelAnimationFrame(id);
	}, [visible]);

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
