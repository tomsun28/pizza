import { useEffect, useRef, useState, useCallback } from "react";
import { sendCommandAwait, subscribeEvents, subscribeSidecarExit } from "@/lib/transport";
import type { RpcSessionState, TypedEvent } from "@/lib/types";
import { Conversation, type TimelineItem } from "@/components/Conversation";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/ui";

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<Record<string, unknown>>)
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return String(block.text ?? "");
				if (block.type === "thinking") return "";
				if (block.type === "toolCall") return "Tool call: " + String(block.name ?? "tool");
				if (block.type === "image") return "[image]";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export default function ChatView({
	state,
	sidecarReady,
	sidecarExitCode,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
}) {
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [error, setError] = useState("");
	const activeAssistantRef = useRef<string | null>(null);
	const seenIdsRef = useRef<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [items]);

	const handleEvent = useCallback((event: TypedEvent) => {
		const seenRef = seenIdsRef;
		if (seenRef.current.has(event.event_id)) return;
		seenRef.current.add(event.event_id);
		switch (event.type) {
			case "USER_MESSAGE": {
				const text = messageText(event.payload);
				setItems((prev) => [
					...prev,
					{ id: event.event_id, role: "user", title: "You", text, status: "" },
				]);
				break;
			}
			case "AGENT_MESSAGE_START": {
				const id = event.event_id;
				activeAssistantRef.current = id;
				setItems((prev) => [
					...prev,
					{ id, role: "assistant", title: "Pizza", text: "", status: "STREAMING", streaming: true },
				]);
				break;
			}
			case "AGENT_MESSAGE_CHUNK": {
				const id = activeAssistantRef.current;
				if (!id) break;
				const chunk = (event.payload as Record<string, unknown>)?.chunk as Record<string, unknown> | undefined;
				if (!chunk) break;
				if (chunk.kind === "text_delta" && typeof chunk.delta === "string") {
					setItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, text: it.text + chunk.delta } : it)),
					);
				}
				break;
			}
			case "AGENT_MESSAGE_END": {
				const id = activeAssistantRef.current;
				if (id) {
					const payload = event.payload as Record<string, unknown> | undefined;
					const content = payload?.content;
					if (content) {
						const text = messageText({ content });
						if (text) {
							setItems((prev) =>
								prev.map((it) => (it.id === id ? { ...it, text, status: "DONE", streaming: false } : it)),
							);
						} else {
							setItems((prev) =>
								prev.map((it) => (it.id === id ? { ...it, status: "DONE", streaming: false } : it)),
							);
						}
					} else {
						setItems((prev) =>
							prev.map((it) => (it.id === id ? { ...it, status: "DONE", streaming: false } : it)),
						);
					}
				}
				break;
			}
			case "AGENT_TURN_COMPLETED": {
				const id = activeAssistantRef.current;
				if (id) {
					setItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, status: "DONE", streaming: false } : it)),
					);
					activeAssistantRef.current = null;
				}
				break;
			}
			default:
				break;
		}
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeEvents((event) => handleEvent(event as TypedEvent));
			unlisteners.push(un1);
			const un2 = await subscribeSidecarExit((code) => {
				if (code !== null) {
					setError(`Sidecar exited (code ${code})`);
				}
			});
			unlisteners.push(un2);
		})();
		return () => unlisteners.forEach((fn) => fn());
	}, [sidecarReady, handleEvent]);

	const handleSend = useCallback(
		async (message: string) => {
			setError("");
			try {
				if (state?.isStreaming) {
					await sendCommandAwait({ type: "follow_up", message });
				} else {
					await sendCommandAwait({ type: "prompt", message });
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[state?.isStreaming],
	);

	const handleAbort = useCallback(async () => {
		try {
			await sendCommandAwait({ type: "abort" });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const isRunning = state?.isStreaming ?? false;

	return (
		<div className="flex h-full flex-col">
			<div ref={scrollRef} className="flex-1 overflow-y-auto">
				{items.length === 0 ? (
					<div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
						<EmptyState
							title="Pizza"
							description={
								sidecarReady
									? "Ready. Ask anything about this project."
									: sidecarExitCode !== null
										? `Sidecar exited (code ${sidecarExitCode})`
										: "Starting..."
							}
						/>
					</div>
				) : (
					<Conversation
						items={items}
						sidecarReady={sidecarReady}
						sidecarExitCode={sidecarExitCode}
					/>
				)}
			</div>
			{error && (
				<div className="mx-auto max-w-3xl px-6 pb-2">
					<div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
						{error}
					</div>
				</div>
			)}
			<Composer
				sidecarReady={sidecarReady}
				isRunning={isRunning}
				onSend={handleSend}
				onAbort={handleAbort}
			/>
		</div>
	);
}
