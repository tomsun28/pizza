/**
 * Timeline View Component
 *
 * Renders the event-sourced timeline in the TUI.
 * Shows a chronological feed of all activity: messages, tool executions, file mutations, etc.
 */

import { Container, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { TimelineEntry } from "../../../core/projection/timeline-projection.js";
import { theme } from "../theme/theme.js";

export interface TimelineViewOptions {
	/** Maximum number of entries to show */
	maxEntries?: number;
	/** Show timestamps */
	showTimestamps?: boolean;
}

export class TimelineViewComponent extends Container {
	private entries: TimelineEntry[] = [];
	private maxEntries: number;
	private showTimestamps: boolean;
	private contentText: Text;

	constructor(ui: TUI, options: TimelineViewOptions = {}) {
		super();
		this.maxEntries = options.maxEntries ?? 20;
		this.showTimestamps = options.showTimestamps ?? true;

		this.addChild(new Spacer(1));
		this.contentText = new Text("", 1, 1, (text: string) => theme.fg("muted", text));
		this.addChild(this.contentText);
	}

	/**
	 * Update the timeline with new entries.
	 */
	setEntries(entries: TimelineEntry[]): void {
		this.entries = entries.slice(-this.maxEntries);
		this.updateDisplay();
	}

	/**
	 * Append a single entry to the timeline.
	 */
	appendEntry(entry: TimelineEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const lines: string[] = [];

		if (this.entries.length === 0) {
			lines.push("No activity yet.");
		} else {
			for (const entry of this.entries) {
				const timestamp = this.showTimestamps
					? `[${new Date(entry.timestamp).toLocaleTimeString()}] `
					: "";
				const kindIcon = this.getKindIcon(entry.kind);
				const summary = entry.summary.length > 60
					? entry.summary.slice(0, 60) + "..."
					: entry.summary;
				lines.push(`${timestamp}${kindIcon} ${summary}`);
			}
		}

		this.contentText.setText(lines.join("\n"));
	}

	private getKindIcon(kind: TimelineEntry["kind"]): string {
		switch (kind) {
			case "user_message":
				return "👤";
			case "agent_message":
				return "🤖";
			case "tool_execution":
				return "🔧";
			case "file_mutation":
				return "📝";
			case "goal_event":
				return "🎯";
			case "task_event":
				return "✅";
			case "session_boundary":
				return "📋";
			case "compaction":
				return "🗜️";
			case "error":
				return "❌";
			case "checkpoint":
				return "💾";
			default:
				return "•";
		}
	}
}
