# agent-browser (built-in)

Fast native-Rust browser automation CLI for AI agents. Chrome/Chromium via CDP — no Playwright/Puppeteer dependency. Accessibility-tree snapshots with compact `@eN` refs let you interact with pages in ~200–400 tokens instead of parsing raw HTML.

`agent-browser` is a shell command — call it through the `cli` tool, just like `git` or `npm`. Do NOT register it as a separate tool.

## Install (first time only)

```bash
agent-browser --version        # check if already installed
```

If `agent-browser` is not on PATH, tell the user to run `/browser install` (or, manually: `npm i -g agent-browser && agent-browser install`). Do not attempt web automation until it is installed.

## The core loop

```bash
agent-browser open <url>        # 1. Open a page
agent-browser snapshot -i       # 2. See interactive elements only (with refs @e1, @e2...)
agent-browser click @e3         # 3. Act on a ref from the snapshot
agent-browser snapshot -i       # 4. Re-snapshot after ANY page change
```

**Refs (`@e1`, `@e2`, ...) are assigned fresh on every snapshot. They go stale the moment the page changes** — after clicks that navigate, form submits, dynamic re-renders, dialog opens. Always re-snapshot before your next ref interaction.

## Read agent-friendly text

```bash
agent-browser read https://example.com/article          # fetch without launching Chrome
agent-browser read                                       # read rendered DOM of the active tab
agent-browser read https://docs.example.com --filter auth
```

## Screenshots (works with the vision read tool)

```bash
agent-browser screenshot page.png        # save a screenshot
agent-browser screenshot --full page.png # full page
# then read it back as an image:
# _read page.png
```

## Interaction cheat-sheet

```bash
agent-browser fill @e3 "text"            # clear + fill
agent-browser type @e3 "text"            # type into element
agent-browser press Enter                # key press (Enter, Tab, Control+a)
agent-browser select @e3 "value"         # dropdown
agent-browser scroll down 500            # scroll
agent-browser wait --load networkidle    # wait for network idle
agent-browser get text @e1               # get text by ref
agent-browser get title                  # page title
agent-browser get url                    # current url
agent-browser close                      # close session when done
```

## Guidelines

- Always re-snapshot before interacting with a ref after the page may have changed.
- Run `agent-browser close` (or `close --all`) when the browser task is finished so headless Chrome does not linger.
- For long browser workflows, prefer `agent-browser batch "..." "..."` to avoid per-command startup overhead.
- Screenshots are the most reliable way to verify visual state — read them back with `_read` and reason about what you see.