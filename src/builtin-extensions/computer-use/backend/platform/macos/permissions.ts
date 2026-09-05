import type { ExtensionContext } from "../../pi-shim.js";
import { ensurePermissions, type PermissionKind, type PermissionStatus } from "../../permissions.js";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.js";
import type { PlatformReadyState } from "../types.js";
import { HELPER_APP_PATH, macosHelper } from "./helper.js";
import { assertPlatformArchitecture } from "../architecture.js";

const GRANT_INSTRUCTIONS =
	"Grant Accessibility and Screen Recording to pi-computer-use.app in System Settings → Privacy & Security. " +
	"Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const SIGNING_MIGRATION_WARNING =
	"If these permissions were enabled before this install/update, macOS invalidated the old grants because " +
	"pi-computer-use.app was re-signed. Re-enable both toggles for the newly signed helper. " +
	"If a toggle is already on, switch it off and on again.";

const macosPermissionKinds = [
	{ kind: "accessibility" as const, openOption: "Open Accessibility Settings (missing)" },
	{ kind: "screenRecording" as const, openOption: "Open Screen Recording Settings (missing)" },
];

function permissionStatusSummary(status: PermissionStatus): string {
	const lines = [
		`Accessibility: ${status.accessibility ? "granted" : "missing"}`,
		`Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
	];
	if (status.screenRecordingPreflight && !status.screenRecording) {
		lines.push(
			"(Screen Recording reads granted in the TCC database but a live capture probe failed — " +
			"the grant likely belongs to a different app identity, or the helper needs a restart.)",
		);
	}
	return lines.join("; ");
}

function permissionPrompt(status: PermissionStatus, helperPath: string, hint?: string): string {
	return [
		"pi-computer-use needs macOS permissions for its helper app.",
		permissionStatusSummary(status),
		"",
		`Helper: pi-computer-use.app (${helperPath})`,
		hint,
		"",
		`Important: ${SIGNING_MIGRATION_WARNING}`,
		"",
		"pi-computer-use.app is already listed in the pane(s) — enable its toggle, then choose Recheck.",
	].filter(Boolean).join("\n");
}

function missingPermissionMessage(kinds: PermissionKind[]): string {
	return `Still missing after restart: ${kinds.join(" and ")}. ${SIGNING_MIGRATION_WARNING} Then choose Recheck again.`;
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await macosHelper.command<any>("checkPermissions", {}, { signal });
	const rawSource = result?.source;
	return {
		accessibility: toBoolean(result?.accessibility),
		// Authoritative: the helper's live ScreenCaptureKit probe.
		screenRecording: toBoolean(result?.screenRecordingCapturable),
		// Keep the preflight value separate: disagreement means stale per-process
		// TCC cache or a grant row belonging to another app identity.
		screenRecordingPreflight: toBoolean(result?.screenRecordingPreflight),
		source: rawSource && typeof rawSource === "object"
			? {
				// macOS attributes Accessibility / Screen Recording grants to the
				// responsible process at the top of the launch chain. "helper-app"
				// is the canonical installed app via LaunchServices; "caller" means
				// grants would attach to the launching app instead.
				attribution: rawSource.attribution === "helper-app" ? "helper-app" : "caller",
				pid: Math.trunc(toFiniteNumber(rawSource.pid, 0)) || undefined,
				parentPid: Math.trunc(toFiniteNumber(rawSource.parentPid, 0)) || undefined,
				executablePath: toOptionalString(rawSource.executablePath),
				parentPath: toOptionalString(rawSource.parentPath),
				parentBundleId: toOptionalString(rawSource.parentBundleId),
				os: toOptionalString(rawSource.macOS),
			}
			: undefined,
	};
}

async function registerPermissions(signal?: AbortSignal): Promise<void> {
	// Raises the Accessibility prompt and performs a real ScreenCaptureKit
	// capture attempt so pi-computer-use.app is pre-listed in both Settings
	// panes; the user only flips toggles, no "+" path picking.
	await macosHelper.command("registerPermissions", {}, { signal, timeoutMs: 15_000 });
}

export async function ensureMacosReady(
	ctx: ExtensionContext,
	state: PlatformReadyState,
	signal?: AbortSignal,
): Promise<PlatformReadyState> {
	await macosHelper.ensureInstalled(signal);
	if (!(await macosHelper.ensureDaemon(signal))) {
		throw new Error(`pi-computer-use helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`);
	}
	const helperDiagnostics = await macosHelper.ensureProtocol(signal);
	assertPlatformArchitecture("macOS", helperDiagnostics);

	const now = Date.now();
	const cachedStatus = state.permissionStatus;
	const canUseCachedPermissions =
		cachedStatus?.accessibility &&
		cachedStatus.screenRecording &&
		now - state.lastPermissionCheckAt < 2_000;
	if (canUseCachedPermissions) {
		return { ...state, helperDiagnostics };
	}

	let permissionStatus = await checkPermissions(signal);
	let lastPermissionCheckAt = now;

	if (!permissionStatus.accessibility || !permissionStatus.screenRecording) {
		// Attribution "caller" means the helper is not running as the
		// canonical installed app — grants would attach to the wrong identity.
		const attributionHint = permissionStatus.source?.attribution === "caller"
			? `Warning: the helper is not running as the installed pi-computer-use.app (executable: ${permissionStatus.source?.executablePath ?? "unknown"}). Grants made now would attach to the launching app instead. Restart Pi so the canonical helper is used.`
			: undefined;
		permissionStatus = await ensurePermissions(
			ctx,
			{
				kinds: macosPermissionKinds,
				copy: {
					nonInteractiveError: (helperPath) => `pi-computer-use setup requires an interactive session. Start pi in interactive mode. ${GRANT_INSTRUCTIONS}\nHelper path: ${helperPath}`,
					prompt: permissionPrompt,
					incompleteError: (helperPath) => `pi-computer-use setup is incomplete. ${GRANT_INSTRUCTIONS} Helper path: ${helperPath}`,
					readyMessage: "pi-computer-use is ready.",
					stillMissing: missingPermissionMessage,
				},
				checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
				registerPermissions: (permissionSignal) => registerPermissions(permissionSignal ?? signal),
				openPermissionPane: async (kind, permissionSignal) => {
					await macosHelper.command("openPermissionPane", { kind }, { signal: permissionSignal ?? signal });
				},
				restartHelper: (permissionSignal) => macosHelper.restart(permissionSignal ?? signal),
				permissionHint: attributionHint,
			},
			HELPER_APP_PATH,
			signal,
		);
		lastPermissionCheckAt = Date.now();
	}

	return { permissionStatus, lastPermissionCheckAt, helperDiagnostics };
}
