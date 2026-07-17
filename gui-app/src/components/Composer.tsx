import { useState } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "./ui";
import { cn } from "@/lib/utils";

export function Composer({
	sidecarReady,
	isRunning,
	onSend,
	onAbort,
}: {
	sidecarReady: boolean;
	isRunning: boolean;
	onSend: (message: string) => void;
	onAbort: () => void;
}) {
	const [input, setInput] = useState("");

	const handleSend = () => {
		const message = input.trim();
		if (!message || !sidecarReady) return;
		onSend(message);
		setInput("");
	};

	return (
		<div className="border-t border-border bg-surface px-6 py-4">
			<div className="mx-auto max-w-3xl">
				<div
					className={cn(
						"flex items-end gap-3 rounded-lg border border-border bg-surface-2 p-3",
					)}
				>
					<textarea
						className="flex-1 resize-none bg-transparent text-sm text-fg outline-none placeholder:text-muted"
						placeholder={
							sidecarReady
								? "ask pizza to work on this project..."
								: "waiting for sidecar..."
						}
						rows={2}
						value={input}
						disabled={!sidecarReady}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								handleSend();
							}
						}}
					/>
					<div className="flex items-center gap-2">
						{isRunning && (
							<Button
								tone="danger"
								variant="outline"
								size="sm"
								onClick={onAbort}
								iconLeft={<Square className="h-3.5 w-3.5" />}
							>
								Stop
							</Button>
						)}
						<Button
							tone="accent"
							variant="solid"
							size="sm"
							onClick={handleSend}
							disabled={!sidecarReady || !input.trim()}
							iconLeft={<Send className="h-3.5 w-3.5" />}
						>
							Send
						</Button>
					</div>
				</div>
				<div className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-muted">
					enter to send · shift+enter for newline
				</div>
			</div>
		</div>
	);
}
