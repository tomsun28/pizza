# Pizza

Pizza is a terminal coding agent. It helps you read files, execute commands, edit code, and write new files.

Based on [pi-mono](https://github.com/badlogic/pi-mono). Thanks to pi-mono.

## Quick Start

```bash
npm install -g pizza
```

Set your API key:

```bash
export ZAI_API_KEY=...
pizza
```

Or use interactive login:

```bash
pizza
/login  # Select your provider
```

## Commands

| Command | Description |
|---------|-------------|
| `/login` | OAuth authentication |
| `/model` | Switch models |
| `/settings` | Configure options |
| `/new` | Start new session |
| `/quit` | Exit |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel |
| Ctrl+L | Select model |
| Shift+Tab | Cycle thinking level |

## CLI Usage

```bash
# Interactive mode
pizza

# With initial prompt
pizza "List all .ts files in src/"

# Continue last session
pizza -c

# Non-interactive
pizza -p "Summarize this codebase"
```

