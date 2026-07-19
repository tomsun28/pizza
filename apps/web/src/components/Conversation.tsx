import { useState } from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import {
	Terminal,
	ChevronRight,
	Copy,
	Check,
	ThumbsUp,
	ThumbsDown,
	Brain,
	Loader2,
	AlertCircle,
} from "lucide-react";

export interface TimelineItem {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	title: string;
	text: string;
	status: string;
	streaming?: boolean;
	/** Accumulated reasoning/thinking text (assistant messages). */
	thinking?: string;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	isError?: boolean;
	/** Attached images as data URLs (for user messages). */
	images?: string[];
}

const COLLAPSE_LINES = 12;

function useCopy(): [boolean, (text: string) => void] {
	const [copied, setCopied] = useState(false);
	const copy = (text: string) => {
		void navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return [copied, copy];
}

/** Long monospace block that collapses to a preview by default. */
function CollapsibleCode({ text, isError }: { text: string; isError?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const lines = text.split("\n");
	const long = lines.length > COLLAPSE_LINES;
	const shown = long && !expanded ? lines.slice(0, COLLAPSE_LINES).join("\n") : text;
	return (
		<div className="relative">
			<pre
				className={cn(
					"overflow-x-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-xs leading-relaxed",
					isError ? "bg-danger/5 text-danger" : "bg-bg/60 text-muted",
				)}
			>
				{shown}
				{long && !expanded && <span className="text-muted/60">{"\n…"}</span>}
			</pre>
			{long && (
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					className="mt-1 font-mono text-[10px] uppercase tracking-widest text-accent hover:opacity-80"
				>
					{expanded ? "Show less" : `Show ${lines.length - COLLAPSE_LINES} more lines`}
				</button>
			)}
		</div>
	);
}

/** Collapsible reasoning/thinking block, collapsed by default. */
function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mb-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted transition-colors hover:text-fg"
			>
				<Brain className={cn("h-3.5 w-3.5", streaming && "animate-pulse text-accent")} />
				<span>{streaming ? "Thinking…" : "Thought process"}</span>
				<ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
			</button>
			{open && (
				<div className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted">
					<div className="whitespace-pre-wrap break-words">{text}</div>
				</div>
			)}
		</div>
	);
}

function formatToolArgs(toolArgs?: string): string {
	if (!toolArgs) return "";
	try {
		const obj = JSON.parse(toolArgs);
		if (obj && typeof obj === "object" && typeof obj.command === "string") {
			return obj.command;
		}
		return JSON.stringify(obj, null, 2);
	} catch {
		return toolArgs;
	}
}

function ToolCard({ item }: { item: TimelineItem }) {
	const command = formatToolArgs(item.toolArgs);
	const running = item.streaming && !item.toolResult;
	return (
		<div className="my-4 flex justify-start">
			<div
				className={cn(
					"w-full max-w-full overflow-hidden rounded-xl border bg-surface-2/40",
					item.isError ? "border-danger/30" : "border-border",
				)}
			>
				<div className="flex items-center justify-between gap-3 px-3.5 py-2">
					<span className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-fg">
						<Terminal className="h-3.5 w-3.5 text-accent" />
						{item.toolName || item.title}
					</span>
					<span
						className={cn(
							"flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest",
							item.isError ? "text-danger" : running ? "text-accent" : "text-muted",
						)}
					>
						{running && <Loader2 className="h-3 w-3 animate-spin" />}
						{item.isError && <AlertCircle className="h-3 w-3" />}
						{item.status}
					</span>
				</div>
				<div className="space-y-2 px-3.5 pb-3">
					{command && (
						<div className="rounded-md bg-bg/60 px-3 py-2 font-mono text-xs leading-relaxed text-fg">
							<span className="mr-1.5 select-none text-accent">$</span>
							<span className="whitespace-pre-wrap break-words">{command}</span>
						</div>
					)}
					{item.toolResult && <CollapsibleCode text={item.toolResult} isError={item.isError} />}
					{running && !item.toolResult && (
						<span className="font-mono text-xs text-accent">running…</span>
					)}
				</div>
			</div>
		</div>
	);
}

function AssistantActions({ text, visible }: { text: string; visible: boolean }) {
	const [copied, copy] = useCopy();
	const [feedback, setFeedback] = useState<null | "up" | "down">(null);
	return (
		<div
			className={cn(
				"mt-2 flex items-center gap-1 transition-opacity",
				visible ? "opacity-100" : "pointer-events-none opacity-0",
			)}
		>
			<button
				type="button"
				onClick={() => copy(text)}
				className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
				title="Copy"
			>
				{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
			<button
				type="button"
				onClick={() => setFeedback((f) => (f === "up" ? null : "up"))}
				className={cn(
					"flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-2",
					feedback === "up" ? "text-success" : "text-muted hover:text-fg",
				)}
				title="Good response"
			>
				<ThumbsUp className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={() => setFeedback((f) => (f === "down" ? null : "down"))}
				className={cn(
					"flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-2",
					feedback === "down" ? "text-danger" : "text-muted hover:text-fg",
				)}
				title="Bad response"
			>
				<ThumbsDown className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

function UserBubble({ item }: { item: TimelineItem }) {
	const [copied, copy] = useCopy();
	const [hover, setHover] = useState(false);
	return (
		<div
			className="my-4 flex flex-col items-end"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5">
				{item.images && item.images.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.images.map((src, i) => (
							<img
								key={i}
								src={src}
								alt="attachment"
								className="max-h-48 rounded-md border border-border object-contain"
							/>
						))}
					</div>
				)}
				{item.text && (
					<div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
						{item.text}
					</div>
				)}
			</div>
			{item.text && (
				<button
					type="button"
					onClick={() => copy(item.text)}
					className={cn(
						"mt-1 flex h-7 w-7 items-center justify-center rounded-md text-muted transition-opacity hover:bg-surface-2 hover:text-fg",
						hover ? "opacity-100" : "pointer-events-none opacity-0",
					)}
					title="Copy"
				>
					{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
				</button>
			)}
		</div>
	);
}

function AssistantMessage({ item }: { item: TimelineItem }) {
	const [hover, setHover] = useState(false);
	return (
		<div
			className="my-4 flex justify-start"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<div className="w-full max-w-full">
				{item.thinking && <Thinking text={item.thinking} streaming={item.streaming} />}
				{item.images && item.images.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{item.images.map((src, i) => (
							<img
								key={i}
								src={src}
								alt="attachment"
								className="max-h-48 rounded-md border border-border object-contain"
							/>
						))}
					</div>
				)}
				{item.text ? (
					<Markdown>{item.text}</Markdown>
				) : item.streaming ? (
					<span className="inline-flex items-center gap-2 text-sm text-muted">
						<Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
					</span>
				) : null}
				{item.streaming && item.text && (
					<span className="ml-0.5 animate-pulse text-accent">▋</span>
				)}
				{!item.streaming && item.text && <AssistantActions text={item.text} visible={hover} />}
			</div>
		</div>
	);
}

export function Conversation({
	items,
}: {
	items: TimelineItem[];
	sidecarReady: boolean;
	sidecarExitCode: number | null;
}) {
	if (items.length === 0) {
		return <div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center gap-4 text-center text-muted" />;
	}

	return (
		<div className="mx-auto max-w-3xl px-6 pb-32 pt-4">
			{items.map((item) => {
				if (item.role === "user") return <UserBubble key={item.id} item={item} />;
				if (item.role === "tool") return <ToolCard key={item.id} item={item} />;
				// Skip empty assistant bubbles (turns that produced only tool calls).
				if (!item.streaming && !item.text && !item.thinking && !(item.images && item.images.length > 0)) {
					return null;
				}
				return <AssistantMessage key={item.id} item={item} />;
			})}
		</div>
	);
}
