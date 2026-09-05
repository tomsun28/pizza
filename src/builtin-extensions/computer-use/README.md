# computer-use (built-in extension)

Desktop app automation for Pizza, powered by a vendored copy of the
[pi-computer-use](https://github.com/injaneity/pi-computer-use) backend
(MIT license — see `LICENSE.upstream`), pinned to upstream `v0.5.1`.

## How it works

The model gets 8 structured desktop tools instead of raw screenshot +
coordinate clicking:

```
find_roots -> observe_ui (stateId + @e refs) -> search_ui / expand_ui / inspect_ui
           -> act_ui (transactional actions, optional `expect` postconditions)
           -> read_text / wait_for
```

- Native helper: a small Swift (macOS) / Rust (Windows, Linux) bridge that
  talks to the OS accessibility APIs. Vendored backend drives it over a local
  socket (`~/Library/Caches/pi-computer-use/bridge.sock`).
- Browser automation intentionally stays with the `agent-browser` built-in:
  the upstream CDP trio (`launch_browser` / `navigate_browser` /
  `evaluate_browser`) is NOT registered. Web -> agent-browser, desktop ->
  computer-use.

## Lifecycle

- `/computer install` — installs the pinned upstream npm package into
  `~/.pizza/agent/computer-use/pkg` and runs its checksum-verified setup
  script (installs `~/Applications/pi-computer-use.app` on macOS). Grant
  Accessibility + Screen Recording when prompted.
- `/computer status` — helper + permission + config status.
- `/computer uninstall` — removes the helper app.
- `/computer disable|enable` — persists to `settings.disabledBuiltinExtensions`.

## Configuration

`~/.pizza/agent/extensions/pi-computer-use.json` or `.pizza/computer-use.json`
in the project:

```json
{ "headless": false, "cursor_overlay": true, "browser_use": false }
```

Env overrides: `PI_COMPUTER_USE_HEADLESS`, `PI_COMPUTER_USE_CURSOR_OVERLAY`.

## Updating the vendored backend

The vendored sources live in `backend/` with a single integration shim
(`backend/pi-shim.ts`) that maps pi's type imports to Pizza's own
(`AgentToolResult`, `ExtensionContext`, `getAgentDir`). To update:

1. Check upstream releases + the pinned `UPSTREAM_VERSION` in `index.ts`.
2. Copy `src/**` from the new version into `backend/`.
3. Re-apply the import rewrite (`@earendil-works/pi-coding-agent` ->
   `./pi-shim.js`, relative `.ts` specifiers -> `.js`).
4. `npx tsc -p tsconfig.build.json --noEmit` and run the tests.
