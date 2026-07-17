import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import Layout from "@/components/Layout";
import ChatView from "@/views/ChatView";
import HistoryView from "@/views/HistoryView";
import SettingsView from "@/views/SettingsView";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait } from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";

export default function App() {
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const sidecarStartedRef = useRef(false);

	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		(async () => {
			try {
				const initialState = await initSidecar();
				setState(initialState as RpcSessionState | null);
				setSidecarReady(true);
			} catch (e) {
				console.error("[init] FAILED:", e);
			}
		})();
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeSidecarExit((code) => {
				setSidecarExitCode(code);
				setSidecarReady(false);
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
	}, [sidecarReady]);

	useEffect(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
			.then((r) => setState(r.data?.state ?? null))
			.catch(() => {});
	}, [sidecarReady]);

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
						<Route path="/history" element={<HistoryView />} />
						<Route path="/settings" element={<SettingsView state={state} />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</PxlKitSurfaceProvider>
		</BrowserRouter>
	);
}
