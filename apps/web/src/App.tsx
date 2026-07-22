import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import Layout from "@/components/Layout";
import ChatView from "@/views/ChatView";
import SettingsView from "@/views/SettingsView";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait, listWorkspaces } from "@/lib/transport";
import { BrandIcon } from "@/components/BrandIcon";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function AppInner() {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(null);
	const [waitingForWorkspace, setWaitingForWorkspace] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
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
		// Navigate back to chat page when selecting a workspace.
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
				// Only process state updates for the active workspace.
				if (typed._cwd && typed._cwd !== workspace) return;
				// Refresh state on model/thinking changes, and when the agent
				// turn starts (isStreaming → true) or completes (isStreaming → false).
				// Skip intermediate AGENT_TURN_END/REQUESTED during multi-tool turns
				// to avoid flooding get_state requests that time out.
				if (typed.type === "MODEL_CHANGED" || typed.type === "THINKING_LEVEL_CHANGED" || typed.type === "AGENT_TURN_COMPLETED" || typed.type === "AGENT_TURN_START") {
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

	if (initError) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
						<BrandIcon size={48} className="text-danger" />
						<p className="font-mono text-sm text-fg">{t("chat.failedToStartWorkspace")}</p>
						<p className="font-mono text-xs text-muted">{initError}</p>
						<button
							type="button"
							onClick={() => {
								setInitError(null);
								startWithWorkspace("~/.pizza/main");
							}}
							className="mt-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80"
						>
							{t("common.backToChat")}
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
								onSelectWorkspace={handleSelectWorkspace}
								onNewWorkspace={handleNewWorkspace}
							onDeleteWorkspace={handleDeleteWorkspace}
							/>
						}
					>
						<Route
							index
							element={
								<ChatView
									state={state}
									sidecarReady={sidecarReady}
									sidecarExitCode={sidecarExitCode}
				workspace={workspace}
								/>
							}
						/>
						<Route path="/settings" element={<SettingsView state={state} onRefreshState={refreshState} />} />
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
