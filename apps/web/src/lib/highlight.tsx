import { type ReactNode, Children, isValidElement, cloneElement } from "react";

/**
 * Search-match highlighting helpers shared by the chat search bar and the
 * conversation renderers. Keeping the logic here lets every surface (user
 * bubbles, tool cards, thinking blocks, markdown) highlight matches
 * consistently and lets the active match render in a distinct color.
 */

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive substring test. Empty query never matches. */
export function textMatches(haystack: string | undefined | null, query: string): boolean {
	if (!query || !haystack) return false;
	return haystack.toLowerCase().includes(query.toLowerCase());
}

/**
 * Split `text` around case-insensitive occurrences of `query` and wrap each
 * match in a <mark>. When `active` is true the marks use the "active" style
 * (the currently-focused match) so the user can tell it apart from the rest.
 *
 * Returns the original string as a single node when there is no query, so the
 * non-search render path is zero-cost.
 */
export function highlightText(text: string, query: string, active = false): ReactNode {
	if (!query) return text;
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	const out: ReactNode[] = [];
	let i = 0;
	let key = 0;
	let idx = lower.indexOf(q, i);
	while (idx >= 0) {
		if (idx > i) out.push(text.slice(i, idx));
		out.push(
			<mark
				key={key++}
				className={active ? "chat-search-mark-active" : "chat-search-mark"}
			>
				{text.slice(idx, idx + q.length)}
			</mark>,
		);
		i = idx + q.length;
		idx = lower.indexOf(q, i);
	}
	if (i < text.length) out.push(text.slice(i));
	return out;
}

/**
 * Walk an arbitrary React node tree and highlight string leaves in place.
 *
 * Used to highlight matches inside markdown output: react-markdown gives us a
 * tree of DOM-string elements (p, li, strong, a, code, …) plus the occasional
 * custom component (our CodeBlock). We recurse into DOM-string elements so
 * inline text is covered, and pass custom components through untouched (their
 * own renderers decide whether to highlight). This is what makes nested inline
 * markup (e.g. a bold link) highlight correctly without double-processing.
 */
export function highlightNodes(nodes: ReactNode, query: string, active = false): ReactNode {
	if (!query) return nodes;
	return Children.map(nodes, (child) => {
		if (typeof child === "string") return highlightText(child, query, active);
		if (typeof child === "number") return child;
		if (isValidElement(child)) {
			// Recurse only into plain DOM elements. Custom components keep their
			// own children handling (e.g. CodeBlock renders a `code` string prop).
			if (typeof child.type === "string") {
				return cloneElement(child, {}, highlightNodes(child.props.children, query, active));
			}
			return child;
		}
		return child;
	});
}