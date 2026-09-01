/* ------------------------------------------------------------------------- *
 * confirmDialog / alertDialog — promise-based replacements for the native
 * window.confirm()/alert(), styled like the rest of the app. A single
 * <ConfirmHost /> (components/ui.tsx) must be mounted once near the app
 * root; callers then use
 *   if (!(await confirmDialog({ message }))) return;
 * If no host is mounted (e.g. unit tests), falls back to window.confirm.
 * ------------------------------------------------------------------------- */

export interface ConfirmOptions {
	/** Dialog title. Defaults to a generic "Confirm" / "Notice" label. */
	title?: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Renders the confirm button in the danger tone (destructive actions). */
	danger?: boolean;
	/** Alert mode: single OK button, always resolves true. */
	alert?: boolean;
}

export type ConfirmRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

let confirmHostHandler: ((req: ConfirmRequest) => void) | null = null;

/** Registered by <ConfirmHost /> on mount. */
export function setConfirmHostHandler(handler: ((req: ConfirmRequest) => void) | null): void {
	confirmHostHandler = handler;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
	if (!confirmHostHandler) {
		// Host not mounted — degrade gracefully to the native dialogs.
		if (opts.alert) {
			window.alert(opts.message);
			return Promise.resolve(true);
		}
		return Promise.resolve(window.confirm(opts.message));
	}
	const handler = confirmHostHandler;
	return new Promise((resolve) => {
		handler({ ...opts, resolve });
	});
}

export function alertDialog(opts: Omit<ConfirmOptions, "alert">): Promise<boolean> {
	return confirmDialog({ ...opts, alert: true });
}