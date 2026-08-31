/**
 * Adaptive-thinking fallback for providers that reject budget-based thinking.
 */

import {
	createAssistantMessageEventStream,
	type Model,
	streamSimple,
} from "@earendil-works/pi-ai/compat";

/**
 * Detect the provider error that says budget-based thinking is unsupported
 * and adaptive thinking (thinking.type "adaptive" + output_config.effort)
 * must be used instead. Newer Claude models behind relays emit this while
 * arbitrary model ids may not be in pi-ai's built-in adaptive-thinking index,
 * so we learn it from the provider itself instead of matching model names.
 */
function isAdaptiveThinkingRejection(event: unknown): boolean {
	if ((event as { type?: string })?.type !== "error") return false;
	const message =
		(event as { error?: { errorMessage?: unknown } })?.error?.errorMessage ??
		(event as { errorMessage?: unknown })?.errorMessage;
	if (typeof message !== "string") return false;
	return message.includes("thinking.type.enabled") && message.includes("is not supported");
}

/**
 * Wrap a stream call with a one-shot adaptive-thinking fallback.
 *
 * When the provider rejects budget-based thinking for a model that isn't
 * flagged `compat.forceAdaptiveThinking`, retry once with the flag enabled and
 * remember the decision in the registry so subsequent requests go straight to
 * adaptive. No model id is hardcoded: any current or future model that answers
 * with this error is handled, and models that accept budget thinking (or that
 * were explicitly configured) are untouched.
 */
export function streamWithAdaptiveThinkingFallback(
	model: Model<any>,
	registry: { rememberAdaptiveThinking(model: Model<any>): Model<any> },
	call: (model: Model<any>) => ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
	// Already adaptive (explicit config or learned earlier): nothing to fall back from.
	if ((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true) {
		return call(model);
	}

	const out = createAssistantMessageEventStream();
	void (async () => {
		let iterator = call(model)[Symbol.asyncIterator]();
		let retried = false;
		try {
			while (true) {
				const { value: event, done } = await iterator.next();
				if (done || !event) return;
				if (!retried && isAdaptiveThinkingRejection(event)) {
					retried = true;
					const patched = registry.rememberAdaptiveThinking(model);
					iterator = call(patched)[Symbol.asyncIterator]();
					continue; // drop the error event and stream the retry instead
				}
				out.push(event);
				if (event.type === "done" || event.type === "error") return;
			}
		} catch (error) {
			out.push({ type: "error", error } as any);
		}
	})();
	return out;
}