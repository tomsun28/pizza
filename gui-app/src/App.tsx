import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import { FolderOpen } from "lucide-react";
import Layout from "@/components/Layout";
import ChatView from "@/views/ChatView";
import SettingsView from "@/views/SettingsView";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait, listWorkspaces } from "@/lib/transport";
import { Button } from "@/components/ui";
import { BrandIcon } from "@/components/BrandIcon";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function App() {
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(null);
	const [waitingForWorkspace, setWaitingForWorkspace] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const sidecarStartedRef = useRef(false);

	const refreshWorkspaces = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const list = await listWorkspaces();
			setWorkspaces(list);
		} catch (e) {
			console.error("[workspaces] list error:", e);
		}
	}, []);

	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

	const startWithWorkspace = useCallback(async (cwd?: string) => {
		setWaitingForWorkspace(true);
		try {
			const initialState = await initSidecar(cwd);
			if (cwd) setWorkspace(cwd);
			// If we got a non-empty state, it's a freshly spawned sidecar.
			// If empty, the sidecar was already running — state will arrive via rpc_response event.
			const hasState = initialState && Object.keys(initialState).length > 0;
			if (hasState) {
				setState(initialState as unknown as RpcSessionState);
			}
			setSidecarReady(true);
			// For already-running sidecar, request state explicitly.
			if (!hasState) {
				void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
					.then((r) => setState(r.data?.state ?? null))
					.catch(() => {});
			}
			refreshWorkspaces();
		} catch (e) {
			console.error("[init] FAILED:", e);
		} finally {
			setWaitingForWorkspace(false);
		}
	}, [refreshWorkspaces]);

	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		if (isTauri()) {
			// In Tauri: show workspace picker, don't auto-init
			setWaitingForWorkspace(false);
		} else {
			// Browser: auto-init with dev bridge
			startWithWorkspace();
		}
	}, [startWithWorkspace]);

	const handlePickDirectory = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const dialog = await import("@tauri-apps/plugin-dialog");
			const selected = await dialog.open({ directory: true, multiple: false, title: "Select project directory" });
			if (typeof selected === "string") {
				await startWithWorkspace(selected);
			}
		} catch (e) {
			console.error("[workspace] dialog error:", e);
		}
	}, [startWithWorkspace]);

	const handleSelectWorkspace = useCallback(async (cwd: string) => {
		if (workspace === cwd && sidecarReady) return;
		// If sidecar is already running, switching is instant — no loading screen.
		if (sidecarReady) {
			setWorkspace(cwd);
			await startWithWorkspace(cwd);
		} else {
			await startWithWorkspace(cwd);
		}
	}, [workspace, sidecarReady, startWithWorkspace]);

	useEffect(() => {
		if (!sidecarReady) return;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeSidecarExit((code, cwd) => {
				// Only mark as not ready if the exited sidecar was the active one.
				if (!cwd || cwd === workspace) {
					setSidecarExitCode(code);
					setSidecarReady(false);
				}
			});
			unlisteners.push(un1);
			const un2 = await subscribeEvents((event) => {
				const typed = event as { type: string };
				if (typed.type === "MODEL_CHANGED" || typed.type === "THINKING_LEVEL_CHANGED" || typed.type === "AGENT_TURN_COMPLETED") {
					void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
						.then((r) => setState(r.data?.state ?? null))
						.catch(() => {});
				}
			});
			unlisteners.push(un2);
		})();
		return () => unlisteners.forEach((fn) => fn());
	}, [sidecarReady, workspace]);

	useEffect(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
			.then((r) => setState(r.data?.state ?? null))
			.catch(() => {});
	}, [sidecarReady]);

	// In Tauri mode, show workspace picker before loading main UI
	const showWorkspacePicker = isTauri() && !sidecarReady && !waitingForWorkspace;

	if (showWorkspacePicker) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex flex-col items-center gap-6">
						<BrandIcon size={48} className="text-accent" />
						<div className="text-center">
							<h1 className="font-mono text-xl font-bold uppercase tracking-widest text-fg">Pizza</h1>
							<p className="mt-2 font-mono text-sm text-muted">Select a project directory to start</p>
						</div>
						<Button
							tone="accent"
							iconLeft={<FolderOpen className="h-4 w-4" />}
							onClick={handlePickDirectory}
						>
							Open Directory
						</Button>
						{sidecarExitCode !== null && (
							<p className="text-sm text-danger">Sidecar exited (code {sidecarExitCode})</p>
						)}
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
						<p className="font-mono text-sm text-muted">Starting...</p>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	return (
		<BrowserRouter>
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
								/>
							}
						/>
						<Route path="/settings" element={<SettingsView state={state} />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</PxlKitSurfaceProvider>
		</BrowserRouter>
	);
}
