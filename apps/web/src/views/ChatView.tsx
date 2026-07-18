import { useEffect, useRef, useState, useCallback } from "react";
import { sendCommandAwait, subscribeEvents, subscribeSidecarExit } from "@/lib/transport";
import type { RpcSessionState, TypedEvent } from "@/lib/types";
import { Conversation, type TimelineItem } from "@/components/Conversation";
import { Composer, type ComposerImage } from "@/components/Composer";
import { EmptyState } from "@/components/ui";

function blockToDataUrl(block: Record<string, unknown>): string | null {
	const data = block.data;
	if (typeof data !== "string" || !data) return null;
	const mime = (block.mime_type ?? block.mimeType ?? "image/png") as string;
	// Already a data URL?
	if (data.startsWith("data:")) return data;
	return `data:${mime};base64,${data}`;
}

/** Extract image data URLs from a message payload (content blocks + images array). */
function messageImages(message: unknown): string[] {
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	const out: string[] = [];
	if (Array.isArray(msg.content)) {
		for (const block of msg.content as Array<Record<string, unknown>>) {
			if (block && typeof block === "object" && block.type === "image") {
				const url = blockToDataUrl(block);
				if (url) out.push(url);
			}
		}
	}
	if (Array.isArray(msg.images)) {
		for (const img of msg.images as Array<Record<string, unknown>>) {
			const url = blockToDataUrl(img);
			if (url) out.push(url);
		}
	}
	return out;
}

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
				if (block.type === "image") return "";
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
	workspace,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
}) {
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [error, setError] = useState("");
	const activeAssistantRef = useRef<string | null>(null);
	const seenIdsRef = useRef<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);

	// Per-workspace conversation persistence.
	const itemsByWs = useRef<Map<string, TimelineItem[]>>(new Map());
	const seenIdsByWs = useRef<Map<string, Set<string>>>(new Map());
	const activeAssistantByWs = useRef<Map<string, string | null>>(new Map());
	const itemsRef = useRef<TimelineItem[]>([]);
	itemsRef.current = items;
	const prevWsRef = useRef<string | null>(null);

	// Save/restore conversation on workspace switch.
	useEffect(() => {
		const prevWs = prevWsRef.current;
		const newWs = workspace ?? "";
		if (prevWs !== newWs) {
			// Save current conversation under the old workspace.
			if (prevWs) {
				itemsByWs.current.set(prevWs, itemsRef.current);
				seenIdsByWs.current.set(prevWs, seenIdsRef.current);
				activeAssistantByWs.current.set(prevWs, activeAssistantRef.current);
			}
			// Restore conversation for the new workspace.
			setItems(itemsByWs.current.get(newWs) ?? []);
			seenIdsRef.current = seenIdsByWs.current.get(newWs) ?? new Set();
			activeAssistantRef.current = activeAssistantByWs.current.get(newWs) ?? null;
			setError("");
			prevWsRef.current = newWs;
		}
	}, [workspace]);

	// Load history from sidecar when sidecar becomes ready or workspace changes.
	useEffect(() => {
		if (!sidecarReady || !workspace) return;
		// If we already have cached items for this workspace, don't reload.
		if (itemsByWs.current.has(workspace)) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait({ type: "get_messages" });
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				const history: TimelineItem[] = [];
				for (const msg of messages) {
					const role = msg.role as string;
					if (role === "user") {
						const text = messageText(msg);
						const images = messageImages(msg);
						history.push({ id: `hist-${history.length}`, role: "user", title: "You", text, status: "", images: images.length > 0 ? images : undefined });
					} else if (role === "assistant") {
						const text = messageText(msg);
						const images = messageImages(msg);
						history.push({ id: `hist-${history.length}`, role: "assistant", title: "Pizza", text, status: "DONE", streaming: false, images: images.length > 0 ? images : undefined });
					} else if (role === "tool") {
						const toolName = String(msg.name ?? "tool");
						const result = msg.content as Array<Record<string, unknown>> | undefined;
						const resultText = result ? result.map((r) => (r.type === "text" ? String(r.text ?? "") : JSON.stringify(r))).join("\n") : "";
						history.push({ id: `hist-${history.length}`, role: "tool", title: toolName, text: "", status: "DONE", streaming: false, toolName, toolArgs: "", toolResult: resultText });
					}
				}
				if (!cancelled && history.length > 0) {
					setItems(history);
				}
			} catch (e) {
				console.error("[ChatView] loadHistory failed:", e);
			}
		})();
		return () => { cancelled = true; };
	}, [sidecarReady, workspace]);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [items]);

	const handleEvent = useCallback((event: TypedEvent & { _cwd?: string }) => {
		const eventCwd = event._cwd ?? "";
		const currentWs = workspace ?? "";
		const isForCurrent = eventCwd === currentWs;

		// Determine which seenIds and activeAssistant to use.
		const seenRef = isForCurrent ? seenIdsRef : { current: seenIdsByWs.current.get(eventCwd) ?? new Set<string>() };
		if (seenRef.current.has(event.event_id)) return;
		seenRef.current.add(event.event_id);
		if (!isForCurrent) {
			seenIdsByWs.current.set(eventCwd, seenRef.current);
		}

		const activeRef = isForCurrent ? activeAssistantRef : { current: activeAssistantByWs.current.get(eventCwd) ?? null };

		const updateItems = (fn: (prev: TimelineItem[]) => TimelineItem[]) => {
			if (isForCurrent) {
				setItems(fn);
			} else {
				const cached = itemsByWs.current.get(eventCwd) ?? [];
				itemsByWs.current.set(eventCwd, fn(cached));
			}
		};

		switch (event.type) {
			case "USER_MESSAGE": {
				const text = messageText(event.payload);
				const images = messageImages(event.payload);
				updateItems((prev) => [
					...prev,
					{ id: event.event_id, role: "user", title: "You", text, status: "", images: images.length > 0 ? images : undefined },
				]);
				break;
			}
			case "AGENT_MESSAGE_START": {
				const id = event.event_id;
				activeRef.current = id;
				if (isForCurrent) {
					activeAssistantRef.current = id;
				} else {
					activeAssistantByWs.current.set(eventCwd, id);
				}
				updateItems((prev) => [
					...prev,
					{ id, role: "assistant", title: "Pizza", text: "", status: "STREAMING", streaming: true },
				]);
				break;
			}
			case "AGENT_MESSAGE_CHUNK": {
				const id = activeRef.current;
				if (!id) break;
				const chunk = (event.payload as Record<string, unknown>)?.chunk as Record<string, unknown> | undefined;
				if (!chunk) break;
				if (chunk.kind === "text_delta" && typeof chunk.delta === "string") {
					updateItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, text: it.text + chunk.delta } : it)),
					);
				}
				break;
			}
			case "AGENT_MESSAGE_END": {
				const id = activeRef.current;
				if (id) {
					const payload = event.payload as Record<string, unknown> | undefined;
					const content = payload?.content;
					const text = content ? messageText({ content }) : "";
					const images = content ? messageImages({ content }) : [];
					updateItems((prev) =>
						prev.map((it) =>
							it.id === id
								? {
										...it,
										...(text ? { text } : {}),
										...(images.length > 0 ? { images } : {}),
										status: "DONE",
										streaming: false,
									}
								: it,
						),
					);
				}
				break;
			}
			case "AGENT_TURN_COMPLETED": {
				const id = activeRef.current;
				if (id) {
					updateItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, status: "DONE", streaming: false } : it)),
					);
					if (isForCurrent) {
						activeAssistantRef.current = null;
					} else {
						activeAssistantByWs.current.set(eventCwd, null);
					}
				}
				break;
			}
			case "INTENT_TOOL_CALL":
			case "TOOL_EXECUTION_START": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const toolName = payload.tool_name as string;
				const args = payload.arguments as Record<string, unknown> | undefined;
				const argsStr = args ? JSON.stringify(args, null, 2) : "";
				// INTENT_TOOL_CALL and TOOL_EXECUTION_START share the same tool_call_id.
				// Upsert so we don't create duplicate cards / clashing React keys.
				updateItems((prev) => {
					const existing = prev.find((it) => it.id === toolCallId);
					if (existing) {
						return prev.map((it) =>
							it.id === toolCallId
								? { ...it, title: toolName, toolName, toolArgs: argsStr || it.toolArgs }
								: it,
						);
					}
					return [
						...prev,
						{
							id: toolCallId,
							role: "tool",
							title: toolName,
							text: "",
							status: "RUNNING",
							streaming: true,
							toolName,
							toolArgs: argsStr,
						},
					];
				});
				break;
			}
			case "TOOL_EXECUTION_UPDATE": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const update = payload.update as string | undefined;
				if (update) {
					updateItems((prev) =>
						prev.map((it) =>
							it.id === toolCallId && it.role === "tool"
								? { ...it, toolResult: (it.toolResult ?? "") + update }
								: it,
						),
					);
				}
				break;
			}
			case "TOOL_EXECUTION_END": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const result = payload.result as Array<Record<string, unknown>> | undefined;
				const resultText = result
					? result.map((r) => (r.type === "text" ? String(r.text ?? "") : JSON.stringify(r))).join("\n")
					: "";
				const isError = payload.is_error === true;
				updateItems((prev) =>
					prev.map((it) =>
						it.id === toolCallId && it.role === "tool"
							? { ...it, status: isError ? "ERROR" : "DONE", streaming: false, toolResult: resultText || it.toolResult, isError }
							: it,
					),
				);
				break;
			}
			default:
				break;
		}
	}, [workspace]);

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
		async (message: string, images?: ComposerImage[]) => {
			setError("");
			const payloadImages = images?.map((img) => ({ data: img.data, mimeType: img.mimeType }));
			try {
				if (state?.isStreaming) {
					await sendCommandAwait({ type: "follow_up", message, images: payloadImages });
				} else {
					await sendCommandAwait({ type: "prompt", message, images: payloadImages });
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
				state={state}
				sidecarReady={sidecarReady}
				isRunning={isRunning}
				onSend={handleSend}
				onAbort={handleAbort}
			/>
		</div>
	);
}
