/**
 * Pizza-side OAuth provider registry.
 *
 * pi-ai 0.84 removed the global OAuth provider registry
 * (registerOAuthProvider/getOAuthProviders/getOAuthApiKey) and moved OAuth
 * flows onto `Provider.auth.oauth` (`OAuthAuth`). Pizza keeps its own small
 * registry with the legacy callback surface (`OAuthLoginCallbacks`) that the
 * TUI login dialogs and extensions are written against, and adapts the new
 * built-in `OAuthAuth` flows to it.
 */

import type { AuthEvent, AuthPrompt, ModelAuth, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

export type OAuthProviderId = string;

/**
 * Legacy OAuth provider interface that pizza's TUI and extension API are
 * written against. Built-in providers are adapted from pi-ai's new
 * `OAuthAuth`; extensions may register their own implementations.
 */
export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	/** Run the login flow, return credentials to persist */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	/** Whether login uses a local callback server and supports manual code input */
	usesCallbackServer?: boolean;
	/** Refresh expired credentials, return updated credentials to persist */
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	/** Convert credentials to API key string for the provider (sync) */
	getApiKey(credentials: OAuthCredentials): string;
	/** Optional: modify models for this provider (e.g., update baseUrl) */
	modifyModels?(models: any[], credentials: OAuthCredentials): any[];
}

/** Request-auth extras derivable from an OAuth credential (per-credential baseUrl/headers) */
export interface OAuthAuthExtras {
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
}

/** Providers whose login flow uses a local callback server (manual paste supported) */
/** Providers whose login flow uses a local callback server (manual paste supported).
 * Device-code flows: github-copilot, kimi-coding, xai. */
const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex", "openrouter", "radius"]);

function callbacksToInteraction(callbacks: OAuthLoginCallbacks): {
	signal: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
} {
	const signal = callbacks.signal ?? new AbortController().signal;
	return {
		signal,
		async prompt(prompt) {
			switch (prompt.type) {
				case "select":
					return (
						(await callbacks.onSelect({
							message: prompt.message,
							options: prompt.options.map((o) => ({
								id: o.id,
								label: o.label,
								...(o.description ? { description: o.description } : {}),
							})),
						})) ?? ""
					);
				case "manual_code":
					return (await callbacks.onManualCodeInput?.()) ?? "";
				default:
					// "text" | "secret"
					return callbacks.onPrompt({
						message: prompt.message,
						placeholder: prompt.placeholder,
						allowEmpty: prompt.type !== "secret",
					});
			}
		},
		notify(event) {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode({
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						intervalSeconds: event.intervalSeconds,
						expiresInSeconds: event.expiresInSeconds,
					});
					break;
				case "info":
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
	};
}

/** Strip the `type` discriminator so credentials merge cleanly into auth storage */
function toCredentials(credential: OAuthCredential): OAuthCredentials {
	const { type: _type, ...rest } = credential;
	return rest;
}

/** Adapt a new-style pi-ai OAuthAuth flow to pizza's legacy interface */
function adaptOAuthAuth(id: string, name: string, oauth: OAuthAuth): OAuthProviderInterface {
	return {
		id,
		name,
		usesCallbackServer: CALLBACK_SERVER_PROVIDERS.has(id),
		async login(callbacks) {
			const credential = await oauth.login(callbacksToInteraction(callbacks));
			return toCredentials(credential);
		},
		async refreshToken(credentials) {
			const refreshed = await oauth.refresh(credentials as OAuthCredential, new AbortController().signal);
			return toCredentials(refreshed);
		},
		getApiKey(credentials) {
			// All built-in flows authenticate with the access token
			return credentials.access;
		},
	};
}

/** Custom (extension-registered) providers, overriding built-ins by id */
const customProviders = new Map<string, OAuthProviderInterface>();

/** Built-in providers adapted from pi-ai's provider catalog (lazily built) */
let builtinAdapted: OAuthProviderInterface[] | undefined;

function getBuiltinAdapted(): OAuthProviderInterface[] {
	if (!builtinAdapted) {
		builtinAdapted = getBuiltinProvidersCached().flatMap((provider) => {
			const oauth = provider.auth.oauth;
			if (!oauth) return [];
			const name = oauth.isSubscription && oauth.loginLabel ? oauth.loginLabel : oauth.name || provider.name;
			return [adaptOAuthAuth(provider.id, name, oauth)];
		});
	}
	return builtinAdapted;
}

/**
 * Get all registered OAuth providers (built-ins + custom).
 * Custom providers replace built-ins with the same id.
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	const byId = new Map<string, OAuthProviderInterface>();
	for (const provider of getBuiltinAdapted()) {
		byId.set(provider.id, provider);
	}
	for (const [id, provider] of customProviders) {
		byId.set(id, provider);
	}
	return [...byId.values()];
}

/** Get an OAuth provider by ID */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customProviders.get(id) ?? getBuiltinAdapted().find((p) => p.id === id);
}

/** Register a custom OAuth provider (replaces a built-in with the same id) */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customProviders.set(provider.id, provider);
}

/** Unregister a custom OAuth provider. No effect on built-ins. */
export function unregisterOAuthProvider(id: string): void {
	customProviders.delete(id);
}

/** Remove all custom providers, restoring built-ins. */
export function resetOAuthProviders(): void {
	customProviders.clear();
}


/** Cached `builtinProviders()` — cheap to construct but avoid rebuilding on every request. */
let builtinProvidersCache: ReturnType<typeof builtinProviders> | undefined;
function getBuiltinProvidersCached(): ReturnType<typeof builtinProviders> {
	return (builtinProvidersCache ??= builtinProviders());
}
/**
 * Derive request-auth extras (per-credential baseUrl/headers) from an OAuth
 * credential. Returns undefined for providers without an OAuth flow or when
 * a custom (extension) provider overrides the built-in one.
 */
export async function getOAuthAuthExtras(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthAuthExtras | undefined> {
	if (customProviders.has(providerId)) return undefined;
	const provider = getBuiltinProvidersCached().find((p) => p.id === providerId);
	const oauth = provider?.auth.oauth;
	if (!oauth) return undefined;
	const auth: ModelAuth = await oauth.toAuth(credentials as OAuthCredential);
	return {
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		headers: auth.headers as Record<string, string> | undefined,
	};
}
