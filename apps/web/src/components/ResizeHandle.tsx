import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A thin draggable divider. Emits a running size via `onResize`, given the
 * pointer delta from drag start applied to the size captured at drag start.
 *
 * - orientation "vertical": a vertical bar the user drags horizontally
 *   (used between the main pane and the right dock). Dragging left grows the
 *   dock, so the delta is inverted via `invert`.
 * - orientation "horizontal": a horizontal bar dragged vertically
 *   (used above the bottom dock).
 */
export function ResizeHandle({
	orientation,
	getSize,
	onResize,
	invert = false,
	className,
}: {
	orientation: "vertical" | "horizontal";
	/** Current size at the moment the drag begins. */
	getSize: () => number;
	/** Called with the new size (clamped by the caller if desired). */
	onResize: (next: number) => void;
	invert?: boolean;
	className?: string;
}) {
	const startRef = useRef({ pos: 0, size: 0 });

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			startRef.current = {
				pos: orientation === "vertical" ? e.clientX : e.clientY,
				size: getSize(),
			};
		},
		[orientation, getSize],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!(e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) return;
			const cur = orientation === "vertical" ? e.clientX : e.clientY;
			let delta = cur - startRef.current.pos;
			if (invert) delta = -delta;
			onResize(startRef.current.size + delta);
		},
		[orientation, invert, onResize],
	);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
	}, []);

	return (
		<div
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			className={cn(
				"group shrink-0 bg-transparent transition-colors hover:bg-accent/30",
				orientation === "vertical" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
				className,
			)}
		/>
	);
}
