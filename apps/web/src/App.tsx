import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import Layout from "@/components/Layout";
import AgentView from "@/views/AgentView";
import SettingsView from "@/views/SettingsView";
import PluginsView from "@/views/PluginsView";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait, listWorkspaces, restartSidecar } from "@/lib/transport";
import { BrandIcon } from "@/components/BrandIcon";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function AppInner() {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(null);
	const [waitingForWorkspace, setWaitingForWorkspace] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [streamingCwds, setStreamingCwds] = useState<Set<string>>(new Set());
	const sidecarStartedRef = useRef(false);
	// Auto-restart bookkeeping: per-cwd restart count, reset to 0 when a
	// sidecar becomes ready. Capped at 3 attempts with exponential backoff
	// to avoid crash loops.
	const restartCountRef = useRef(0);
	const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshWorkspaces = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const list = await listWorkspaces();
			// Filter out the Chat workspace (~/.pizza/main) — it's shown separately as Chat.
			setWorkspaces(list.filter((ws) => !ws.cwd.endsWith("/.pizza/main")));
		} catch (e) {
			console.error("[workspaces] list error:", e);
		}
	}, []);

	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

	const [initError, setInitError] = useState<string | null>(null);
	const startWithWorkspace = useCallback(async (cwd?: string) => {
		setWaitingForWorkspace(true);
		setInitError(null);
		try {
			const initialState = await initSidecar(cwd);
			// Expand ~ to home directory so workspace state matches Rust side.
			let expandedCwd = cwd;
			if (cwd && cwd.startsWith("~") && isTauri()) {
				try {
					const { homeDir } = await import("@tauri-apps/api/path");
					const home = await homeDir();
					expandedCwd = cwd.replace("~", home);
				} catch { /* keep ~ */ }
			}
			if (expandedCwd) setWorkspace(expandedCwd);
			// If we got a non-empty state, it's a freshly spawned sidecar.
			// If empty, the sidecar was already running — state will arrive via rpc_response event.
			const hasState = initialState && Object.keys(initialState).length > 0;
			if (hasState) {
				setState(initialState as unknown as RpcSessionState);
			}
			setSidecarReady(true);
			// For already-running sidecar, request state explicitly.
			if (!hasState) {
				void sendCommandAwait<RpcSessionState>({ type: "get_state" })
					.then((r) => setState(r.data ?? null))
					.catch(() => {});
			}
			refreshWorkspaces();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[init] FAILED:", msg);
			setInitError(msg);
			// If the directory doesn't exist, refresh workspaces so the stale
			// entry can be cleaned up by the user.
			if (msg.includes("does not exist")) {
				refreshWorkspaces();
			}
		} finally {
			setWaitingForWorkspace(false);
		}
	}, [refreshWorkspaces]);

	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		if (isTauri()) {
			// In Tauri: auto-start with Chat (persistent agent at ~/.pizza/main)
			startWithWorkspace("~/.pizza/main");
		} else {
			// Browser: auto-init with dev bridge
			startWithWorkspace();
		}
	}, [startWithWorkspace]);

	const handleNewWorkspace = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const dialog = await import("@tauri-apps/plugin-dialog");
			const selected = await dialog.open({ directory: true, multiple: false, title: t("layout.selectProjectDirectory") });
			if (typeof selected === "string") {
				await startWithWorkspace(selected);
			}
		} catch (e) {
			console.error("[workspace] dialog error:", e);
		}
	}, [startWithWorkspace, t]);

	const handleSelectWorkspace = useCallback(async (cwd: string) => {
		if (workspace === cwd && sidecarReady) return;
		// Navigate back to agent page when selecting a workspace.
		navigate("/");
		// startWithWorkspace sets workspace AFTER initSidecar completes,
		// so get_messages goes to the correct sidecar.
		await startWithWorkspace(cwd);
	}, [workspace, sidecarReady, startWithWorkspace, navigate]);

	const handleDeleteWorkspace = useCallback((workspaceId: string) => {
		setWorkspaces((prev) => prev.filter((ws) => ws.workspace_id !== workspaceId));
	}, []);

	// Refresh the session state from the sidecar. Used after settings that
	// don't emit a dedicated event (e.g. toggling safe mode) so the root
	// state stays in sync for components that read from it.
	const refreshState = useCallback(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
	}, [sidecarReady]);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeSidecarExit((code, cwd) => {
				// Only mark as not ready if the exited sidecar was the active one.
				if (!cwd || cwd === workspace) {
					setSidecarExitCode(code);
					setSidecarReady(false);
					// Auto-restart with exponential backoff (max 3 attempts).
					// The count is reset to 0 whenever a sidecar becomes ready,
					// so a fresh crash after a healthy run still gets 3 retries.
					const cwdToRestart = workspace;
					if (cwdToRestart && restartCountRef.current < 3) {
						restartCountRef.current += 1;
						const attempt = restartCountRef.current;
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
						console.warn(`[sidecar] exited (code=${code}), auto-restart attempt ${attempt}/3 in ${delay}ms`);
						if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
						restartTimerRef.current = setTimeout(() => {
							restartTimerRef.current = null;
							// Guard against the user having switched workspaces in the meantime.
							setWorkspace((current) => {
								if (current === cwdToRestart) {
									void startWithWorkspace(cwdToRestart);
								}
								return current;
							});
						}, delay);
					} else if (cwdToRestart) {
						console.warn(`[sidecar] exited, giving up auto-restart after 3 attempts`);
					}
				}
			});
			if (cancelled) { un1(); return; }
			unlisteners.push(un1);
			const un2 = await subscribeEvents((event) => {
				const typed = event as { type: string; _cwd?: string };
				// Track per-workspace streaming state for ALL workspaces
				// so the sidebar can show blinking indicators even for
				// non-active workspaces.
				if (typed._cwd && (typed.type === "AGENT_TURN_START" || typed.type === "AGENT_TURN_COMPLETED")) {
					setStreamingCwds((prev) => {
						const next = new Set(prev);
						if (typed.type === "AGENT_TURN_START") {
							next.add(typed._cwd!);
						} else {
							next.delete(typed._cwd!);
						}
						return next;
					});
				}
				// Only process state updates for the active workspace.
				if (typed._cwd && typed._cwd !== workspace) return;
				// Refresh state on model/thinking changes, and when the agent
				// turn starts (isStreaming → true) or completes (isStreaming → false).
				// Skip intermediate AGENT_TURN_END/REQUESTED during multi-tool turns
				// to avoid flooding get_state requests that time out.
				if (
					typed.type === "MODEL_CHANGED" ||
					typed.type === "THINKING_LEVEL_CHANGED" ||
					typed.type === "AGENT_TURN_COMPLETED" ||
					typed.type === "AGENT_TURN_START" ||
					typed.type === "SESSION_CREATED" ||
					typed.type === "SESSION_FORKED" ||
					typed.type === "SESSION_JUMPED"
				) {
					void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
						.then((r) => setState(r.data ?? null))
						.catch(() => {});
				}
			});
			if (cancelled) { un2(); return; }
			unlisteners.push(un2);
		})();
		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, [sidecarReady, workspace, startWithWorkspace]);

	// Reset the auto-restart counter once a sidecar is healthy, and clean up
	// any pending restart timer on unmount.
	useEffect(() => {
		if (sidecarReady) {
			restartCountRef.current = 0;
		}
	}, [sidecarReady]);

	useEffect(() => {
		return () => {
			if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
		};
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" })
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
		// Delayed re-fetch: the sidecar may emit MODEL_CHANGED before our
		// event listener is registered, leaving state.model stale. This
		// catches any missed events shortly after sidecar ready / workspace switch.
		const timer = setTimeout(() => {
			void sendCommandAwait<RpcSessionState>({ type: "get_state" })
				.then((r) => setState(r.data ?? null))
				.catch(() => {});
		}, 800);
		return () => clearTimeout(timer);
	}, [sidecarReady, workspace]);

	// First-run / unconfigured-key detection: when the sidecar comes up but
	// `state.model` is undefined, no provider has an API key configured yet.
	// Redirect the user into a setup-mode Settings page instead of dumping
	// them into an empty agent they can't actually use.
	useEffect(() => {
		if (!sidecarReady) return;
		if (!state) return;
		if (state.model !== undefined) return;
		// Only redirect once per workspace, and only if the user isn't
		// already on the setup settings page (avoid stealing the back button).
		// Read the path off `window` rather than `useLocation` on purpose: we
		// deliberately do NOT want this effect re-running on every navigation,
		// otherwise an unconfigured user gets yanked back here the moment they
		// try to visit /plugins or anywhere else.
		if (!window.location.pathname.startsWith("/settings")) {
			navigate("/settings?setup=true", { replace: true });
		}
	}, [sidecarReady, state, navigate]);

	// After the user configures a key, the sidecar is restarted and a new
	// state arrives with `state.model !== undefined`. Pull them back out of
	// the setup-mode Settings page automatically. Doing it here (rather
	// than inside SettingsView.handleConfigured) avoids a race where the
	// local `setState` hasn't propagated before navigate fires, which
	// would let the redirect-above re-trigger and bounce them back.
	useEffect(() => {
		if (!state || state.model === undefined) return;
		if (!location.pathname.startsWith("/settings")) return;
		if (new URLSearchParams(location.search).get("setup") !== "true") return;
		navigate("/", { replace: true });
	}, [state, navigate, location.pathname, location.search]);

	if (initError) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
						<BrandIcon size={48} className="text-danger" />
						<p className="font-mono text-sm text-fg">{t("agent.failedToStartWorkspace")}</p>
						<p className="font-mono text-xs text-muted">{initError}</p>
						<button
							type="button"
							onClick={() => {
								setInitError(null);
								startWithWorkspace("~/.pizza/main");
							}}
							className="mt-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80"
						>
							{t("common.backToAgent")}
						</button>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	if (waitingForWorkspace && !sidecarReady) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex flex-col items-center gap-4">
						<BrandIcon size={48} className="text-accent" />
						<p className="font-mono text-sm text-muted">{t("common.starting")}</p>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	return (
		<PxlKitSurfaceProvider surface="pixel">
			<Routes>
					<Route
						element={
							<Layout
								state={state}
								sidecarReady={sidecarReady}
								sidecarExitCode={sidecarExitCode}
								workspace={workspace}
								workspaces={workspaces}
								streamingCwds={streamingCwds}
								onSelectWorkspace={handleSelectWorkspace}
								onNewWorkspace={handleNewWorkspace}
							onDeleteWorkspace={handleDeleteWorkspace}
							/>
						}
					>
						<Route
							index
							element={
								<AgentView
									state={state}
									sidecarReady={sidecarReady}
									sidecarExitCode={sidecarExitCode}
				workspace={workspace}
				workspaces={workspaces}
				onRefreshState={refreshState}
								/>
							}
						/>
						<Route path="/settings" element={
							<SettingsView
								state={state}
								onRestartSidecar={async () => {
									if (!workspace) return;
									// restart_sidecar (Rust) returns the entire JSON-RPC
									// response envelope `{id, type, command, success,
									// data: {...}}` from the new sidecar's first
									// get_state. Unwrap the `.data` payload before
									// feeding it into `state`, otherwise state.model
									// stays undefined and the navigate-back useEffect
									// below never fires.
									const newStateJson = await restartSidecar(workspace);
									try {
										const parsed = JSON.parse(newStateJson);
										const data = parsed?.data ?? parsed;
										if (data && typeof data === "object" && Object.keys(data).length > 0) {
											setState(data as unknown as RpcSessionState);
										}
									} catch {
										// Best-effort: if parsing fails, the sidecar's
										// own MODEL_CHANGED event will still propagate a
										// fresh state via subscribeEvents → get_state.
									}
								}}
							/>
						} />
					<Route path="/plugins" element={<PluginsView />} />
					<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
			</Routes>
		</PxlKitSurfaceProvider>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppInner />
		</BrowserRouter>
	);
}
