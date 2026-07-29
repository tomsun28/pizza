/**
 * POSIX-aware shell word splitter shared by builtin command parsing and the
 * intent classifier.
 *
 * Quoting semantics (POSIX shell):
 *   - single quotes: every character is literal; backslash never escapes
 *   - double quotes: backslash is special only before $ ` " \ and newline;
 *     before any other char the backslash itself is kept literally
 *   - unquoted: a backslash escapes the next character (a trailing backslash
 *     is kept literally)
 *
 * Whitespace outside quotes separates words.
 */

export interface SplitShellWordsMeta {
	/**
	 * Number of quote *delimiter* characters the splitter consumed as quoting
	 * (i.e. a " or ' that opened/closed a quoted region), as opposed to a
	 * literal quote kept in the output. When a positional command argument is
	 * reconstructed by joining several words AND quote delimiters were consumed,
	 * the caller almost certainly meant the quote characters literally (e.g.
	 * `secret("X", "Y")`) but the splitter treated them as quoting and silently
	 * dropped them — that is the "quote stripping" corruption we detect.
	 */
	quoteDelimitersConsumed: number;
}

export function splitShellWords(input: string): string[] {
	return splitShellWordsWithMeta(input).words;
}

export function splitShellWordsWithMeta(input: string): { words: string[]; meta: SplitShellWordsMeta } {
	const words: string[] = [];
	let current = "";
	// Active quote context: undefined (unquoted), "'" (single), or '"' (double).
	let quote: "'" | '"' | undefined;
	let quoteDelimitersConsumed = 0;

	// Inside double quotes a backslash only escapes these characters; before
	// any other char the backslash itself is kept literally. (String.fromCharCode
	// is used for the newline entry to avoid escape-sequence ambiguity.)
	const doubleEscapable = new Set(["$", "`", '"', "\\", String.fromCharCode(10)]);

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		if (quote === "'") {
			// Single quote: everything is literal until the closing quote.
			if (char === "'") {
				quote = undefined;
				quoteDelimitersConsumed++;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === '"') {
			// Double quote: backslash is special only before $ ` " \ and newline.
			if (char === "\\" && next !== undefined && doubleEscapable.has(next)) {
				current += next;
				i++;
			} else if (char === '"') {
				quote = undefined;
				quoteDelimitersConsumed++;
			} else {
				current += char;
			}
			continue;
		}

		// Unquoted.
		if (char === "\\") {
			if (next !== undefined) {
				current += next;
				i++;
			} else {
				// A trailing backslash is kept literally.
				current += "\\";
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			quoteDelimitersConsumed++;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	// An unterminated quote keeps whatever was collected (best-effort); a
	// trailing backslash was already handled inside the loop.
	if (current.length > 0) {
		words.push(current);
	}
	return { words, meta: { quoteDelimitersConsumed } };
}
