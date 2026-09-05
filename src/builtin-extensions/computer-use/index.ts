/**
 * Built-in extension: computer-use
 *
 * Desktop automation for Pizza, powered by the vendored pi-computer-use
 * backend (MIT, https://github.com/injaneity/pi-computer-use). The model gets
 * structured UI observation tools (accessibility outlines + refs) instead of
 * raw screenshot+coordinate clicking:
 *
 *   find roots (@r) -> observe_ui (stateId + @e refs) -> search/expand/inspect
 *   -> act_ui (transactional actions with optional expect postconditions)
 *
 * Design alignment with Pizza:
 * - CLI-first surface: everything is exposed through the single dynamic
 *   built-in cli command `_computer_use` (same bridge executors the upstream
 *   tools used), so no per-operation tool schemas are injected into context.
 * - Browser automation stays with the agent-browser built-in: the vendored
 *   backend ships no browser surface at all (the upstream CDP browser trio and
 *   browser_page roots are removed in-tree). Web -> agent-browser, desktop
 *   apps -> computer-use.
 * - `/computer` manages the lifecycle: install (native helper app),
 *   status, uninstall, disable, enable. Disable persists via
 *   `settings.disabledBuiltinExtensions`.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { execCommand } from "../../core/exec.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  ExtensionContext,
} from "../../core/extensions/types.js";
import {
  ensureComputerUseSetup,
  executeAct,
  executeExpandUi,
  executeFind,
  executeInspectUi,
  executeObserve,
  executeReadText,
  executeSearchUi,
  executeWaitFor,
  reconstructStateFromBranch,
  shutdownComputerUseSession,
} from "./backend/bridge.js";
import { loadComputerUseConfig } from "./backend/config.js";
import {
  computerUseBuiltinCommand,
  formatConfigStatus,
  helperInstalled,
  macosHelperAppPath,
} from "./cli-command.js";

/** Upstream package version the vendored backend was taken from. */
export const UPSTREAM_VERSION = "0.5.1";

/** Human-readable helper identity shown in System Settings / Activity Monitor. */
export const HELPER_DISPLAY_NAME = "Pizza Computer Use";
/** Bundle folder name (and Info.plist CFBundleName fallback) for the helper app. */
export const HELPER_FOLDER_NAME = "pizza-computer-use.app";
export const COMPUTER_USE_EXTENSION_ID = "computer-use";
const UPSTREAM_PACKAGE = "@injaneity/pi-computer-use";

/** Stable id used in `settings.disabledBuiltinExtensions`. */

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type?: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type ?? "info");
  } else {
    console.log(message);
  }
}

// ============================================================================
// Helper availability / install
// ============================================================================

interface InstallResult {
  ok: boolean;
  message: string;
}

/** BuiltinExtension.checkInstalled shape: probe the native helper binary. */
export async function checkComputerUseInstalled(
  _cwd: string,
): Promise<{ installed: boolean; version?: string }> {
  return { installed: helperInstalled() };
}

/**
 * Install the native helper by reusing the upstream package's own setup
 * script (checksum-verified, handles signing/permissions pre-registration).
 * We install the pinned upstream package into a Pizza cache dir and invoke
 * its setup script from there, so no binaries live in Pizza's repo.
 */
export async function runComputerUseInstall(
  _cwd: string,
): Promise<InstallResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      message: `computer-use install currently supports macOS only (detected ${process.platform}).`,
    };
  }
  const pkgDir = path.join(getAgentDir(), "computer-use", "pkg");
  await mkdir(pkgDir, { recursive: true });
  const npmInstall = await execCommand(
    "npm",
    [
      "install",
      `${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION}`,
      "--no-save",
      "--loglevel",
      "error",
    ],
    pkgDir,
    { timeout: 300_000 },
  );
  if (npmInstall.code !== 0) {
    return {
      ok: false,
      message: `npm install failed (exit ${npmInstall.code}):\n${npmInstall.stderr.trim()}`,
    };
  }
  const setupScript = path.join(
    pkgDir,
    "node_modules",
    ...UPSTREAM_PACKAGE.split("/"),
    "scripts",
    "setup-helper.mjs",
  );
  if (!existsSync(setupScript)) {
    return {
      ok: false,
      message: `Setup script not found in installed package: ${setupScript}`,
    };
  }
  const setup = await execCommand(
    process.execPath,
    [setupScript, "--runtime"],
    pkgDir,
    { timeout: 300_000 },
  );
  if (setup.code !== 0) {
    return {
      ok: false,
      message: `Helper setup failed (exit ${setup.code}):\n${(setup.stderr || setup.stdout).trim()}`,
    };
  }
  // Rebrand the helper bundle to Pizza (folder + display name + ad-hoc re-sign).
  const rebrand = await rebrandHelperApp();
  if (!rebrand.ok) {
    return {
      ok: false,
      message: `Helper installed, but rebranding failed: ${rebrand.message}`,
    };
  }
  return {
    ok: true,
    message: `Helper installed at ${macosHelperAppPath()}. Grant Accessibility + Screen Recording when prompted (System Settings → Privacy & Security), then run /computer status.`,
  };
}

/**
 * Rename the upstream helper bundle (pi-computer-use.app -> pizza-computer-use.app)
 * and patch its display name. Editing Info.plist invalidates the upstream code
 * seal, so the bundle is re-signed ad-hoc; macOS will treat it as a new TCC
 * identity and the user re-grants permissions once.
 */
async function rebrandHelperApp(): Promise<InstallResult> {
  const legacy = path.join(os.homedir(), "Applications", "pi-computer-use.app");
  const target = macosHelperAppPath();
  if (existsSync(legacy) && !existsSync(target)) {
    await execCommand("mv", [legacy, target], os.homedir(), {
      timeout: 30_000,
    });
  }
  if (!existsSync(target))
    return { ok: false, message: `${target} not found after setup.` };
  const plist = path.join(target, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    await execCommand(
      "plutil",
      ["-replace", key, "-string", HELPER_DISPLAY_NAME, plist],
      os.homedir(),
      { timeout: 30_000 },
    );
  }
  const sign = await execCommand(
    "codesign",
    ["--force", "--deep", "--sign", "-", target],
    os.homedir(),
    { timeout: 120_000 },
  );
  if (sign.code !== 0) {
    return { ok: false, message: `codesign failed: ${sign.stderr.trim()}` };
  }
  return { ok: true, message: "rebranded" };
}

export async function runComputerUseUninstall(
  _cwd: string,
): Promise<InstallResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      message: `computer-use uninstall currently supports macOS only (detected ${process.platform}).`,
    };
  }
  const helperApp = macosHelperAppPath();
  const legacyApp = path.join(
    os.homedir(),
    "Applications",
    "pi-computer-use.app",
  );
  let removedAny = false;
  for (const app of [helperApp, legacyApp]) {
    if (!existsSync(app)) continue;
    try {
      await rm(app, { recursive: true, force: true });
      removedAny = true;
    } catch (error) {
      return {
        ok: false,
        message: `Failed to remove ${app}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!removedAny) return { ok: true, message: "Helper app not installed." };
  const pkgDir = path.join(getAgentDir(), "computer-use", "pkg");
  await rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
  return {
    ok: true,
    message: `Helper app removed (${helperApp}). Remember to revoke its Accessibility/Screen Recording entries if you want.`,
  };
}

/** Persist enable/disable for this built-in extension in settings.json. */
function persistDisabled(cwd: string, disabled: boolean): void {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setBuiltinExtensionDisabled(COMPUTER_USE_EXTENSION_ID, disabled);
}

// ============================================================================
// Prompt hint (injected only when the helper is installed)
// ============================================================================

function promptHint(): string {
  return `## computer-use (built-in)

Desktop app automation via structured UI observation (accessibility outlines, not raw coordinates). For web pages, prefer agent-browser; use this only for native desktop apps.

Interface — the _computer_use cli command (pure single commands, no shell operators):

  _computer_use roots                       # list controllable app roots as @r refs
  _computer_use observe --root @r3          # capture one root -> stateId + @e element refs
  _computer_use search <stateId> --text OK --role button
  _computer_use expand <stateId> --ref @e10 --depth 3
  _computer_use inspect <stateId> --ref @e10
  _computer_use act <stateId> --actions '[{"action":"click","ref":"@e25"}]'
  _computer_use read <stateId> --ref @e9 --offset 100
  _computer_use wait <stateId> --text DONE --timeout-ms 8000

Loop: roots -> observe -> search/act with the returned stateId (never re-observe after act; the result contains the successor stateId). Complex payloads (actions/expect) are single JSON strings; run "_computer_use --help" for the full subcommand reference. /computer manages the helper.`;
}

const USAGE = `Usage:
  /computer install     Install the native helper app (macOS; downloads pinned upstream release)
  /computer status      Helper install + permission status and active config
  /computer uninstall   Remove the helper app
  /computer disable     Disable this built-in extension (persists across sessions)
  /computer enable      Re-enable this built-in extension
  /computer help        Show this help`;

// ============================================================================
// Extension factory
// ============================================================================

export const createComputerUseExtension: ExtensionFactory = (
  pizza: ExtensionAPI,
) => {
  // The _computer_use cli command: same engine, invoked through the cli tool's
  // dynamic built-in interception (in-process, shares the stateId/@ref state).
  pizza.registerBuiltinCommand(computerUseBuiltinCommand);

  pizza.registerCommand("computer", {
    description: "Manage the built-in computer-use desktop automation helper.",
    async handler(args, ctx) {
      const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();
      const cwd = ctx.cwd;
      switch (subcommand) {
        case "install": {
          notify(
            ctx,
            `Installing ${UPSTREAM_PACKAGE}@${UPSTREAM_VERSION} (helper download)…`,
            "info",
          );
          const result = await runComputerUseInstall(cwd);
          notify(ctx, result.message, result.ok ? "info" : "error");
          return;
        }
        case "uninstall": {
          const result = await runComputerUseUninstall(cwd);
          notify(ctx, result.message, result.ok ? "info" : "error");
          if (result.ok) {
            notify(
              ctx,
              "Tip: the built-in extension stays registered; tools will fail fast until the helper is reinstalled. Use /computer disable to hide it.",
              "info",
            );
          }
          return;
        }
        case "status": {
          const lines = [
            `Built-in extension: ${COMPUTER_USE_EXTENSION_ID} (enabled)`,
            `Helper installed: ${helperInstalled() ? "yes" : "no"}${helperInstalled() ? ` (${macosHelperAppPath()})` : ""}`,
          ];
          if (!helperInstalled()) {
            lines.push("Run /computer install to install it.");
          }
          try {
            loadComputerUseConfig(cwd);
            lines.push(formatConfigStatus(cwd));
          } catch {
            // config problems should not hide install status
          }
          notify(ctx, lines.join("\n"), "info");
          return;
        }
        case "disable": {
          persistDisabled(cwd, true);
          notify(
            ctx,
            "computer-use built-in extension disabled. Reloading…",
            "info",
          );
          await ctx.reload();
          return;
        }
        case "enable": {
          persistDisabled(cwd, false);
          notify(
            ctx,
            "computer-use built-in extension enabled. Reloading…",
            "info",
          );
          await ctx.reload();
          return;
        }
        case "help":
        default: {
          notify(ctx, USAGE, "info");
          return;
        }
      }
    },
  });

  pizza.on("before_agent_start", (event) => {
    if (!helperInstalled()) return;
    const sep = event.systemPrompt.endsWith("\n") ? "\n" : "\n\n";
    return { systemPrompt: event.systemPrompt + sep + promptHint() };
  });

  pizza.on("session_start", async (_event, ctx) => {
    if (!helperInstalled()) return;
    loadComputerUseConfig(ctx.cwd);
    reconstructStateFromBranch(ctx);
    if (!ctx.hasUI) return;
    try {
      await ensureComputerUseSetup(ctx as ExtensionContext);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    }
  });

  pizza.on("session_shutdown", async () => {
    await shutdownComputerUseSession();
  });
};
