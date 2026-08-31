import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { sendCommandAwait, subscribeEvents, subscribeSidecarExit } from "@/lib/transport";
import type { RpcSessionState, TypedEvent } from "@/lib/types";
import { Conversation, type TimelineItem } from "@/components/Conversation";
import { ChatSearch } from "@/components/ChatSearch";
import { Search, X } from "lucide-react";
import { textMatches } from "@/lib/highlight";
import { Composer, type ComposerImage, type LoadedFileAttachment } from "@/components/Composer";
import { EmptyState, Spinner } from "@/components/ui";
import { approveToolCall, rejectToolCall } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { LayoutOutletContext } from "@/components/Layout";

function blockToDataUrl(block: Record<string, unknown>): string | null {
	const data = block.data;
	if (typeof data !== "string" || !data) return null;
	const mime = (block.mime_type ?? block.mimeType ?? "image/png") as string;
	// Already a data URL?
	if (data.startsWith("data:")) return data;
	return `data:${mime};base64,${data}`;
}

function isInternalContinuationSessionEvent(event: TypedEvent): boolean {
	const payload = event.payload as Record<string, unknown> | undefined;
	return Boolean(
		payload?.background === true ||
		(typeof payload?.context_parent_session_id === "string" && payload.context_parent_session_id),
	);
}

const CHAT_RENDER_EVENT_TYPES = new Set<string>([
	"USER_MESSAGE",
	"USER_FOLLOWUP_QUEUED",
	"AGENT_MESSAGE_START",
	"AGENT_MESSAGE_CHUNK",
	"AGENT_MESSAGE_END",
	"AGENT_TURN_COMPLETED",
	"INTENT_TOOL_CALL",
	"TOOL_EXECUTION_START",
	"TOOL_EXECUTION_UPDATE",
	"TOOL_EXECUTION_END",
	"SESSION_BOUNDARY_INFERRED",
	"SCHEDULED_TASK_FIRED",
]);

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

interface ExtractedToolCall {
	id: string;
	name: string;
	args: string;
}

/**
 * Extract file attachments from a user message payload. The agent receives
 * these as discrete `files` objects (not inlined into the text), so we
 * surface them on the agent row so the user can see what was attached.
 */
function messageFiles(message: unknown): Array<{
	absolutePath: string;
	mimeType: string;
	name: string;
	size: number;
}> {
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	const out: Array<{ absolutePath: string; mimeType: string; name: string; size: number }> = [];
	if (Array.isArray(msg.files)) {
		for (const f of msg.files as Array<Record<string, unknown>>) {
			if (!f || typeof f !== "object") continue;
			const absolutePath = typeof f.absolutePath === "string" ? f.absolutePath : "";
			const name = typeof f.name === "string" ? f.name : absolutePath.split("/").pop() ?? "file";
			const mimeType = typeof f.mimeType === "string" ? f.mimeType : "";
			const size = typeof f.size === "number" ? f.size : 0;
			if (absolutePath) out.push({ absolutePath, mimeType, name, size });
		}
	}
	const content = typeof msg.content === "string" ? msg.content : "";
	for (const match of content.matchAll(/<file\s+path="([^"]+)"\s*\/?>/g)) {
		const absolutePath = match[1];
		if (!absolutePath || out.some((file) => file.absolutePath === absolutePath)) continue;
		out.push({
			absolutePath,
			mimeType: "",
			name: absolutePath.split("/").pop() ?? "file",
			size: 0,
		});
	}
	return out;
}

function hideFileRefs(text: string): string {
	return text
		.replace(/^\s*<file\s+path="[^"]+"\s*\/?>\s*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Extract toolCall blocks (id, name, JSON args) from an assistant message. */
function messageToolCalls(message: unknown): ExtractedToolCall[] {
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	if (!Array.isArray(msg.content)) return [];
	const out: ExtractedToolCall[] = [];
	for (const block of msg.content as Array<Record<string, unknown>>) {
		if (block && typeof block === "object" && (block.type === "toolCall" || block.type === "tool_call")) {
			const args = (block.arguments ?? {}) as unknown;
			out.push({
				id: String(block.id ?? block.tool_call_id ?? ""),
				name: String(block.name ?? block.tool_name ?? "tool"),
				args: args && typeof args === "object" ? JSON.stringify(args) : String(args ?? ""),
			});
		}
	}
	return out;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((r) => {
			const b = r as Record<string, unknown>;
			return b?.type === "text" ? String(b.text ?? "") : "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageThinking(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (!Array.isArray(msg.content)) return "";
	return (msg.content as Array<Record<string, unknown>>)
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "thinking") return String(block.thinking ?? block.text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return hideFileRefs(msg.content);
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<Record<string, unknown>>)
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return String(block.text ?? "");
				if (block.type === "thinking") return "";
				if (block.type === "toolCall") return "";
				if (block.type === "image") return "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/** Build a TimelineItem[] from a get_messages response, matching tool cards to results. */
function buildTimelineFromMessages(
	messages: Array<Record<string, unknown>>,
	t: (key: string) => string,
): TimelineItem[] {
	const history: TimelineItem[] = [];
	// Track tool cards by tool_call_id so toolResult messages can fill them.
	const toolCardById = new Map<string, TimelineItem>();
	for (const msg of messages) {
		const role = msg.role as string;
		const ts = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
		if (role === "user") {
			const text = messageText(msg);
			const images = messageImages(msg);
			const files = messageFiles(msg);
			history.push({ id: `hist-${history.length}`, role: "user", title: t("common.you"), text, status: "", images: images.length > 0 ? images : undefined, files: files.length > 0 ? files : undefined, timestamp: ts });
		} else if (role === "assistant") {
			const text = messageText(msg);
			const thinking = messageThinking(msg);
			const images = messageImages(msg);
			if (text || thinking || images.length > 0) {
				history.push({ id: `hist-${history.length}`, role: "assistant", title: t("common.pizza"), text, status: "DONE", streaming: false, thinking: thinking || undefined, images: images.length > 0 ? images : undefined, timestamp: ts });
			}
			// Emit a tool card for each tool call in the assistant message.
			for (const call of messageToolCalls(msg)) {
				const card: TimelineItem = {
					id: call.id || `hist-tool-${history.length}`,
					role: "tool",
					title: call.name,
					text: "",
					status: "DONE",
					streaming: false,
					toolName: call.name,
					toolArgs: call.args,
				};
				history.push(card);
				if (call.id) toolCardById.set(call.id, card);
			}
		} else if (role === "toolResult" || role === "tool") {
			const toolCallId = String(msg.toolCallId ?? msg.tool_call_id ?? "");
			const resultText = toolResultText(msg.content);
			const isError = msg.isError === true || msg.is_error === true;
			const existing = toolCallId ? toolCardById.get(toolCallId) : undefined;
			if (existing) {
				existing.toolResult = resultText;
				existing.isError = isError;
				existing.status = isError ? "ERROR" : "DONE";
			} else {
				// Orphan result (no matching call) — still show it.
				history.push({ id: `hist-${history.length}`, role: "tool", title: String(msg.toolName ?? msg.name ?? "tool"), text: "", status: isError ? "ERROR" : "DONE", streaming: false, toolName: String(msg.toolName ?? msg.name ?? "tool"), toolResult: resultText, isError });
				// (title intentionally uses raw tool name, not translated)
			}
		}
	}
	return history;
}

/**
 * Does a timeline item contain the (case-insensitive) search query in any of
 * its textual fields? Used to build the match list for the chat search bar.
 */
function itemMatchesQuery(item: TimelineItem, query: string): boolean {
	return [
		item.text,
		item.thinking,
		item.title,
		item.toolName,
		item.toolArgs,
		item.toolResult,
	].some((f) => textMatches(f, query));
}

export default function AgentView({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	workspaces,
	waitingForWorkspace,
	onRefreshState,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	workspaces?: import("@/lib/types").WorkspaceMeta[];
	waitingForWorkspace?: boolean;
	onRefreshState?: () => void;
}) {
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const { t } = useTranslation();
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [error, setError] = useState("");
	// True while history is being fetched from the sidecar (get_messages).
	// Shows a loading indicator instead of the empty state so the user gets
	// visual feedback that data is loading, which is especially important on
	// first visit to a workspace with a long conversation history.
	const [loadingHistory, setLoadingHistory] = useState(false);
	const activeAssistantRef = useRef<string | null>(null);
	const seenIdsRef = useRef<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	// Track whether the user is pinned to the bottom of the scroll area.
	// Auto-scroll (on new items / streaming) only fires when the user is
	// already at the bottom — if they've scrolled up to read earlier content,
	// we don't yank them back down. Reset to true on workspace/session switch.
	const pinnedToBottomRef = useRef(true);

	// Per-workspace conversation persistence.
	const itemsByWs = useRef<Map<string, TimelineItem[]>>(new Map());
	const seenIdsByWs = useRef<Map<string, Set<string>>>(new Map());
	const activeAssistantByWs = useRef<Map<string, string | null>>(new Map());
	const itemsRef = useRef<TimelineItem[]>([]);
	const stateRef = useRef<RpcSessionState | null>(state);
	itemsRef.current = items;
	stateRef.current = state;
	const prevWsRef = useRef<string | null>(null);

	// Keep latest t in a ref so closures created in effects can read it
	// without re-subscribing on every language change.
	const tRef = useRef(t);
	useEffect(() => { tRef.current = t; }, [t]);

	// --- Session-switch reload (jump/fork from BranchTreeExplorer) ---
	// When the active session changes via SESSION_FORKED or SESSION_JUMPED,
	// the AgentView's current items belong to the OLD session. We clear them
	// and re-fetch get_messages for the NEW active session. Debounced so a
	// fork (which emits both SESSION_CREATED + SESSION_FORKED) only reloads
	// once. A session_split emits SESSION_BOUNDARY_INFERRED instead, handled
	// separately below (a lightweight trim, not a full reload, so an
	// in-flight streaming turn isn't interrupted).
	const sessionSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reloadForSessionSwitch = useCallback(() => {
		const ws = workspace ?? "";
		// Clear the per-workspace cache so a later workspace switch doesn't
		// restore the stale (pre-switch) conversation.
		itemsByWs.current.delete(ws);
		seenIdsByWs.current.delete(ws);
		activeAssistantByWs.current.delete(ws);
		// Reset current state — the new active session's messages will
		// replace whatever we were showing.
		setItems([]);
		seenIdsRef.current = new Set();
		activeAssistantRef.current = null;
		setError("");
		// Re-fetch the new active session's messages.
		setLoadingHistory(true);
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait({ type: "get_messages" }, 30000);
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				const history = buildTimelineFromMessages(messages, tRef.current);
				if (!cancelled) setItems(history);
				onRefreshState?.();
			} catch {
				// Silently ignore — the empty state will show.
			} finally {
				if (!cancelled) setLoadingHistory(false);
			}
		})();
		return () => { cancelled = true; };
	}, [workspace, onRefreshState]);

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
		// If we already have cached items for this workspace (from a previous
		// visit this session), don't reload — the save/restore mechanism already
		// restored them. Otherwise, fetch from sidecar.
		const cached = itemsByWs.current.get(workspace);
		if (cached && cached.length > 0) return;
		setLoadingHistory(true);
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait({ type: "get_messages" }, 30000);
				if (cancelled) return;
				const data = (r as unknown as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
				const messages = (data?.messages as Array<Record<string, unknown>> | undefined) ?? [];
				const history = buildTimelineFromMessages(messages, tRef.current);
				if (!cancelled && history.length > 0) {
					setItems(history);
				}
			} catch {
				// Silently ignore — history will load on next workspace switch.
			} finally {
				if (!cancelled) setLoadingHistory(false);
			}
		})();
		return () => { cancelled = true; };
	}, [sidecarReady, workspace]);

	// Track whether the user is pinned to the bottom of the scroll area.
	// Key insight: we must distinguish "user actively scrolled up" from
	// "content grew at the bottom while user was at bottom." A fixed px
	// threshold fails because when content is prepended (progressive
	// rendering) or appended (streaming), scrollHeight grows and the
	// distanceFromBottom increases even though the user didn't scroll.
	//
	// Solution: compare scrollTop to its previous value. If scrollTop
	// DECREASED, the user scrolled up → unpin. If scrollTop increased or
	// stayed same (programmatic scroll or content growth), check distance
	// from bottom with a tiny threshold to re-pin.
	const lastScrollTopRef = useRef(0);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			// User scrolled up (scrollTop decreased) → stop auto-scrolling.
			// Small tolerance (2px) to avoid flapping from sub-pixel rounding.
			if (el.scrollTop < lastScrollTopRef.current - 2) {
				pinnedToBottomRef.current = false;
			} else {
				// User scrolled down or programmatic scroll — re-pin if
				// close to bottom (within 10px).
				const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
				pinnedToBottomRef.current = distanceFromBottom < 10;
			}
			lastScrollTopRef.current = el.scrollTop;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// Auto-scroll to bottom when new items arrive — but only if the user is
	// already pinned to the bottom. If they've scrolled up to read, leave
	// them where they are. Uses scrollTop/scrollHeight (not scrollIntoView)
	// here because this fires on streaming appends where the DOM is already
	// laid out — the layout is stable, just taller.
	useLayoutEffect(() => {
		if (!pinnedToBottomRef.current) return;
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [items]);

	// Reset pin-to-bottom on workspace / session switch so the new conversation
	// starts scrolled to the latest message. The actual scroll-to-bottom is
	// handled by the Conversation component's progressive-render anchor, so
	// here we only reset the pin state (not the scroll position, which would
	// be wrong since items haven't loaded yet).
	useEffect(() => {
		pinnedToBottomRef.current = true;
		lastScrollTopRef.current = 0;
	}, [workspace]);

	const handleEvent = useCallback((event: TypedEvent & { _cwd?: string }) => {
		const eventCwd = event._cwd ?? "";
		const currentWs = workspace ?? "";
		const isForCurrent = eventCwd === currentWs;
		const activeState = stateRef.current;
		const eventSessionId = typeof (event as unknown as { session_id?: unknown }).session_id === "string"
			? (event as unknown as { session_id: string }).session_id
			: undefined;
		const eventThreadId = typeof event.thread_id === "string" ? event.thread_id : undefined;
		const payloadSessionId = typeof (event.payload as Record<string, unknown> | undefined)?.sessionId === "string"
			? (event.payload as Record<string, unknown>).sessionId as string
			: undefined;
		const isRenderEvent = CHAT_RENDER_EVENT_TYPES.has(event.type);
		const isScheduledCompletionForCurrent =
			event.type === "SCHEDULED_TASK_COMPLETED" &&
			payloadSessionId === activeState?.sessionId;
		const isScheduledFiredForCurrent =
			event.type === "SCHEDULED_TASK_FIRED" &&
			payloadSessionId === activeState?.sessionId;
		const belongsToCurrentSession =
			!isRenderEvent ||
			isScheduledCompletionForCurrent ||
			isScheduledFiredForCurrent ||
			(eventSessionId && eventSessionId === activeState?.sessionId) ||
			(payloadSessionId && payloadSessionId === activeState?.sessionId) ||
			(!eventSessionId && eventThreadId && eventThreadId === activeState?.threadId) ||
			(!eventSessionId && !eventThreadId && event.type !== "SCHEDULED_TASK_FIRED");
		if (isForCurrent && !belongsToCurrentSession) {
			return;
		}

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

		// INTENT_TOOL_CALL and TOOL_EXECUTION_START share the same tool_call_id.
		// Upsert so we don't create duplicate cards / clashing React keys.
		const toolCardUpsert = (
			toolCallId: string,
			toolName: string,
			argsStr: string,
			approval?: TimelineItem["pendingApproval"],
		) => {
			updateItems((prev) => {
				const existing = prev.find((it) => it.id === toolCallId);
				if (existing) {
					return prev.map((it) =>
						it.id === toolCallId
							? {
									...it,
									title: toolName,
									toolName,
									toolArgs: argsStr || it.toolArgs,
									...(approval ? { pendingApproval: approval } : {}),
								}
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
						status: approval ? "PENDING" : "RUNNING",
						streaming: !approval,
						toolName,
						toolArgs: argsStr,
						...(approval ? { pendingApproval: approval } : {}),
					},
				];
			});
		};

		switch (event.type) {
			case "USER_MESSAGE": {
				const text = messageText(event.payload);
				const images = messageImages(event.payload);
				const files = messageFiles(event.payload);
				// When a queued follow-up is drained, the reactor emits a real
				// USER_MESSAGE whose caused_by points at the USER_FOLLOWUP_QUEUED
				// event we already rendered as a (queued) user bubble. Promote
				// that bubble in place (swap its id + clear the queued flag)
				// instead of appending a duplicate.
				const causedBy = typeof event.caused_by === "string" ? event.caused_by : undefined;
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => {
					if (causedBy) {
						const idx = prev.findIndex((it) => it.id === causedBy && it.queued);
						if (idx >= 0) {
							const next = [...prev];
							next[idx] = { ...next[idx]!, id: event.event_id, queued: false, status: "", timestamp: ts };
							return next;
						}
					}
					return [
						...prev,
						{ id: event.event_id, role: "user", title: tRef.current("common.you"), text, status: "", images: images.length > 0 ? images : undefined, files: files.length > 0 ? files : undefined, timestamp: ts },
					];
				});
				break;
			}
			case "USER_FOLLOWUP_QUEUED": {
				// A follow-up sent while the agent is running is queued and only
				// delivered (as a real USER_MESSAGE) after the current turn ends.
				// Render it immediately as a "queued" user bubble so the user gets
				// feedback; it is promoted in place when the drained USER_MESSAGE
				// arrives (matched via caused_by).
				const text = messageText(event.payload);
				const images = messageImages(event.payload);
				const files = messageFiles(event.payload);
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => [
					...prev,
					{ id: event.event_id, role: "user", title: tRef.current("common.you"), text, status: "", images: images.length > 0 ? images : undefined, files: files.length > 0 ? files : undefined, queued: true, timestamp: ts },
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
				const ts = typeof event.timestamp === "number" ? event.timestamp : undefined;
				updateItems((prev) => [
					...prev,
					{ id, role: "assistant", title: tRef.current("common.pizza"), text: "", status: "STREAMING", streaming: true, timestamp: ts },
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
				} else if (chunk.kind === "thinking_delta" && typeof chunk.delta === "string") {
					updateItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, thinking: (it.thinking ?? "") + chunk.delta } : it)),
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
					const thinking = content ? messageThinking({ content }) : "";
					const images = content ? messageImages({ content }) : [];
					const stopReason = String(payload?.stop_reason ?? "");
					const errorMessage = payload?.error_message
						? String(payload.error_message)
						: "";
					const isError = stopReason === "error" || Boolean(errorMessage);
					const fallbackText = isError && !text
					? errorMessage || tRef.current("agent.agentError", { reason: stopReason || "no response" })
						: text;
					updateItems((prev) =>
						prev.map((it) =>
							it.id === id
								? {
										...it,
										...(fallbackText ? { text: fallbackText } : {}),
										...(thinking ? { thinking } : {}),
										...(images.length > 0 ? { images } : {}),
										status: isError ? "ERROR" : "DONE",
										streaming: false,
										isError: isError || undefined,
									}
								: it,
						),
					);
					if (isError && errorMessage) {
						setError(errorMessage);
					}
				}
				break;
			}
				case "SCHEDULED_TASK_FIRED": {
					// Render a non-intrusive system notice in the timeline so the user
					// can see "your scheduled task just fired" inline. The follow-up
					// USER_MESSAGE will arrive as a regular event right after.
					if (!isForCurrent) break;
					const payload = event.payload as Record<string, unknown> | undefined;
					const taskId = (payload?.taskId as string) ?? "";
					const firedAt = typeof payload?.at === "number" ? (payload.at as number) : Date.now();
					updateItems((prev) => [
						...prev,
						{
							id: event.event_id,
							role: "system",
							title: tRef.current("schedule.triggeredNotice", { name: taskId }),
							text: "",
							status: "",
							timestamp: firedAt,
						},
					]);
					break;
				}
				case "SCHEDULED_TASK_COMPLETED": {
					if (isScheduledCompletionForCurrent) {
						reloadForSessionSwitch();
					}
					break;
				}
				case "AGENT_TURN_COMPLETED": {
				const id = activeRef.current;
				const payload = event.payload as Record<string, unknown> | undefined;
				const reason = String(payload?.reason ?? "");
				const errorMessage = payload?.error_message
					? String(payload.error_message)
					: "";
				const isError = reason === "error" || Boolean(errorMessage);
				if (id) {
					updateItems((prev) =>
						prev.map((it) =>
							it.id === id
								? {
										...it,
										status: isError ? "ERROR" : "DONE",
										streaming: false,
										isError: isError || undefined,
									}
								: it,
						),
					);
					if (isForCurrent) {
						activeAssistantRef.current = null;
					} else {
						activeAssistantByWs.current.set(eventCwd, null);
					}
				}
				if (isError && errorMessage) {
					setError(errorMessage);
				}
				break;
			}
			case "INTENT_TOOL_CALL": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				const toolName = payload.tool_name as string;
				const args = (payload.arguments as Record<string, unknown> | undefined) ?? {};
				const argsStr = JSON.stringify(args, null, 2);
				const classification = payload.classification as Record<string, unknown> | undefined;
				// When safe mode is on, risky tool calls require explicit approval
				// before they execute. Render the approval inline on the tool card
				// (only for the active workspace; background ones just block).
				const requiresApproval = payload.requires_approval === true && isForCurrent;
				const approval = requiresApproval
					? {
							intentEventId: event.event_id,
							risk: classification?.risk as string | undefined,
							category: classification?.category as string | undefined,
							description: classification?.description as string | undefined,
							affectedFiles: classification?.affected_files as string[] | undefined,
							status: "pending" as const,
						}
					: undefined;
				toolCardUpsert(toolCallId, toolName, argsStr, approval);
				break;
			}
			case "TOOL_EXECUTION_START": {
				const payload = event.payload as Record<string, unknown>;
				const toolCallId = payload.tool_call_id as string;
				// Execution started -> the tool was approved (or did not need approval).
				// Transition the card out of pending-approval into running.
				updateItems((prev) =>
					prev.map((it) =>
						it.id === toolCallId && it.role === "tool"
							? { ...it, pendingApproval: undefined, status: "RUNNING", streaming: true }
							: it,
					),
				);
				toolCardUpsert(
					toolCallId,
					payload.tool_name as string,
					payload.arguments ? JSON.stringify(payload.arguments, null, 2) : "",
				);
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
			case "SESSION_BOUNDARY_INFERRED": {
				// A session_split created a new active session mid-turn. The new
				// session's start boundary is the most recent USER_MESSAGE, so
				// trim items to keep only that message onward. This refreshes the
				// header title (first user message) to reflect the new session
				// WITHOUT a full reload (which would clear the streaming pointer
				// and drop in-flight assistant chunks). Any assistant item after
				// the boundary is preserved so streaming continues uninterrupted.
				if (!isForCurrent) break;
				updateItems((prev) => {
					let idx = -1;
					for (let i = prev.length - 1; i >= 0; i--) {
						if (prev[i].role === "user" && prev[i].text.trim()) { idx = i; break; }
					}
					if (idx <= 0) return prev; // nothing to trim
					return prev.slice(idx);
				});
				break;
			}
			case "SESSION_CREATED":
			case "SESSION_FORKED":
			case "SESSION_JUMPED": {
				if (isInternalContinuationSessionEvent(event)) break;
				// The active session changed (user started a new session,
				// jumped/forked from the BranchTreeExplorer, or replayed
				// from the Timeline). Our current items belong to the OLD
				// session — reload from get_messages for the NEW active
				// session. Only react to events for the current workspace.
				// Debounced so a fork (which emits SESSION_CREATED +
				// SESSION_FORKED in quick succession) only triggers one
				// reload.
				if (!isForCurrent) break;
				if (sessionSwitchTimer.current) clearTimeout(sessionSwitchTimer.current);
				sessionSwitchTimer.current = setTimeout(() => {
					sessionSwitchTimer.current = null;
					reloadForSessionSwitch();
				}, 200);
				break;
			}
			default:
				break;
		}
	}, [workspace, reloadForSessionSwitch]);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeEvents((event) => handleEvent(event as TypedEvent));
			if (cancelled) { un1(); return; }
			unlisteners.push(un1);
			const un2 = await subscribeSidecarExit((code) => {
				if (code !== null) {
					setError(tRef.current("agent.sidecarExited", { code }));
				}
			});
			if (cancelled) { un2(); return; }
			unlisteners.push(un2);
		})();
		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, [sidecarReady, handleEvent]);

	// Cancel any pending session-switch reload on unmount.
	useEffect(() => {
		return () => {
			if (sessionSwitchTimer.current) clearTimeout(sessionSwitchTimer.current);
		};
	}, []);

	const handleSend = useCallback(
		async (message: string, images?: ComposerImage[], files?: LoadedFileAttachment[]) => {
			setError("");
			const payloadImages = images?.map((img) => ({ data: img.data, mimeType: img.mimeType }));
			// prompt/follow_up responses only arrive after the entire agent turn
			// completes (incl. all tool calls). All streaming content arrives via
			// the event subscription independently, so we fire-and-forget the command
			// and only catch immediate send errors (e.g. sidecar not running).
			try {
				const payloadFiles = files?.map((f) => ({
					absolutePath: f.absolutePath,
					mimeType: f.mimeType,
					name: f.name,
					size: f.size,
				}));
				const cmd = state?.isStreaming
					? { type: "follow_up", message, images: payloadImages, files: payloadFiles }
					: { type: "prompt", message, images: payloadImages, files: payloadFiles };
				sendCommandAwait(cmd, 600000).catch((e) => {
					setError(e instanceof Error ? e.message : String(e));
				});
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[state?.isStreaming],
	);

	const handleAbort = useCallback(async () => {
		try {
			await sendCommandAwait({ type: "abort" }, 5000);
			// Abort may not always emit AGENT_TURN_COMPLETED, so proactively
			// refresh state to update isStreaming and flip the button back.
			void sendCommandAwait<RpcSessionState>({ type: "get_state" })
				.then((_r) => {
					// setState lives in App.tsx — we can't call it directly, but
					// the App-level event listener will also catch any turn-completed
					// event. As a fallback, mark the active assistant item as done.
					setItems((prev) =>
						prev.map((it) =>
							it.role === "assistant" && it.streaming
								? { ...it, status: "DONE", streaming: false }
								: it,
						),
					);
				})
				.catch(() => {});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	// Resolve an inline tool-call approval (approve/reject). Optimistically
	// updates the card, then fires the RPC; reverts on failure.
	const handleResolveApproval = useCallback(
		(intentEventId: string, toolCallId: string, approved: boolean) => {
			setItems((prev) =>
				prev.map((it) =>
					it.id === toolCallId && it.pendingApproval
						? {
								...it,
								pendingApproval: { ...it.pendingApproval, status: approved ? "approved" : "rejected" },
								status: approved ? it.status : "REJECTED",
								streaming: approved ? it.streaming : false,
							}
						: it,
				),
			);
			(async () => {
				try {
					if (approved) {
						await approveToolCall(intentEventId);
					} else {
						await rejectToolCall(intentEventId);
					}
				} catch (e) {
					// Revert the optimistic update on failure.
					setItems((prev) =>
						prev.map((it) =>
							it.id === toolCallId && it.pendingApproval
								? { ...it, pendingApproval: { ...it.pendingApproval, status: "pending" }, status: "PENDING", streaming: false }
								: it,
						),
					);
					setError(e instanceof Error ? e.message : String(e));
				}
			})();
		},
		[],
	);

	// --- Chat search (⌘/Ctrl+F) ---
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [matchIndex, setMatchIndex] = useState(0);
	// Incremented to imperatively (re)focus the search input — bumped on every
	// ⌘/Ctrl+F and on open via the header button so the bar re-selects its text
	// even when it was already open.
	const [focusSignal, setFocusSignal] = useState(0);
	const trimmedQuery = searchQuery.trim();

	// Ordered list of item ids that contain the current query.
	const matchIds = useMemo(() => {
		if (!searchOpen || !trimmedQuery) return [];
		return items.filter((it) => itemMatchesQuery(it, trimmedQuery)).map((it) => it.id);
	}, [items, searchOpen, trimmedQuery]);

	// Keep matchIndex in range when the match list shrinks (typing narrows
	// results). Clamp to 0 rather than the last valid index so the highlight
	// always lands on a real match.
	useEffect(() => {
		if (matchIndex > 0 && matchIndex >= matchIds.length) {
			setMatchIndex(0);
		}
	}, [matchIndex, matchIds.length]);

	const activeMatchId = matchIds.length > 0 ? matchIds[Math.min(matchIndex, matchIds.length - 1)] : null;
	const goNextMatch = useCallback(() => {
		setMatchIndex((i) => (matchIds.length ? (i + 1) % matchIds.length : 0));
	}, [matchIds.length]);
	const goPrevMatch = useCallback(() => {
		setMatchIndex((i) => (matchIds.length ? (i - 1 + matchIds.length) % matchIds.length : 0));
	}, [matchIds.length]);

	// Global shortcut: ⌘/Ctrl+F opens (or re-focuses) the search bar and
	// prevents the browser/webview native find bar. The bar is never toggled
	// closed by the shortcut (matches editors/browsers); use Escape or the
	// header button to dismiss. Escape is only handled here while open so we
	// never swallow it from other controls.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (mod && (e.key === "f" || e.key === "F")) {
				e.preventDefault();
				setSearchOpen(true);
				setFocusSignal((s) => s + 1);
			} else if (e.key === "Escape" && searchOpen) {
				setSearchOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [searchOpen]);

	// Only pass a query to the conversation while the bar is open; this also
	// clears highlights the instant the bar is dismissed.
	const activeQuery = searchOpen ? trimmedQuery : "";

	const isRunning = state?.isStreaming ?? false;

	// Session title: first user message (like Codex/ChatGPT), else workspace name.
	const firstUserText = items.find((it) => it.role === "user" && it.text.trim())?.text.trim() ?? "";
	const wsName = workspace ? workspace.replace(/\/+$/, "").split("/").pop() || "" : "";
	const sessionTitle = firstUserText
		? (firstUserText.length > 60 ? firstUserText.slice(0, 60).trimEnd() + "…" : firstUserText)
		: wsName || t("agent.newSession");

	return (
		<div className="flex h-full flex-col">
			<div
				data-tauri-drag-region
				className={cn(
					"relative flex h-11 shrink-0 items-center border-b border-border bg-surface/80 pr-[96px] backdrop-blur transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			>
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={firstUserText || sessionTitle}>
					{sessionTitle}
				</span>
				<button
					type="button"
					onClick={() => setSearchOpen((o) => { if (!o) setFocusSignal((s) => s + 1); return !o; })}
					title={t("search.toggleHint")}
					className={cn(
					"absolute right-[84px] top-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-2",
					searchOpen ? "text-accent" : "text-muted/60 hover:text-muted",
				)}
				>
					{searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
				</button>
				{searchOpen && (
					<ChatSearch
						query={searchQuery}
						onQueryChange={(q) => { setSearchQuery(q); setMatchIndex(0); }}
						matchIndex={matchIds.length > 0 ? Math.min(matchIndex, matchIds.length - 1) : 0}
						matchCount={matchIds.length}
						onPrev={goPrevMatch}
						onNext={goNextMatch}
						onClose={() => setSearchOpen(false)}
					focusSignal={focusSignal}
					/>
				)}
			</div>
			<div ref={scrollRef} className="flex-1 overflow-y-auto">
				{items.length === 0 ? (
					<div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
						{loadingHistory || waitingForWorkspace ? (
							<div className="flex flex-col items-center gap-3">
								<Spinner />
								<p className="font-mono text-xs text-muted">{t("common.loadingHistory")}</p>
							</div>
						) : (
							<EmptyState
								title={t("common.pizza")}
								description={
									sidecarReady
										? t("agent.readyPrompt")
										: sidecarExitCode !== null
											? t("agent.sidecarExited", { code: sidecarExitCode })
											: t("common.starting")
								}
							/>
						)}
					</div>
				) : (
				<Conversation
					items={items}
					sidecarReady={sidecarReady}
					sidecarExitCode={sidecarExitCode}
					onResolveApproval={handleResolveApproval}
					searchQuery={activeQuery}
					activeMatchId={activeMatchId}
				/>
				)}
			</div>
			{error && (
				<div className="mx-auto max-w-3xl px-6 pb-2">
					<div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
						{error.split("\n").map((line, i) => (
							<div key={i} className={i === 0 ? "" : "mt-0.5 text-xs opacity-70"}>
								{line}
							</div>
						))}
					</div>
				</div>
			)}
			<Composer
				state={state}
				workspace={workspace}
				workspaces={workspaces}
				sidecarReady={sidecarReady}
				isRunning={isRunning}
				onSend={handleSend}
				onAbort={handleAbort}
				onRefreshState={onRefreshState}
			/>
		</div>
	);
}
