#!/bin/sh
# auto-self-optimize.sh — periodic "is pizza running? if not, start a
# self-optimization pass" watchdog. Intended to be driven by launchd
# (com.tomsun28.pizza.self-optimize.plist, every 30 min).
#
# Logic:
#   1. If a Pizza main agent is already alive (main lock PID live), exit —
#      the user is actively using pizza; don't pile on.
#   2. Otherwise, launch ONE headless, time-boxed self-review/optimization
#      turn against this repo on a dedicated branch. Safe by construction:
#      branch (never main), no push, no force, no deletions, bounded runtime,
#      full log.
#
# Override knobs via environment (launchd <env> or shell):
#   PIZZA_BIN       pizza executable (default: installed Pizza.app binary)
#   PIZZA_REPO      repo to optimize (default: this script's repo)
#   PIZZA_MODEL     model pattern, e.g. "openai/gpt-4o-mini"
#   PIZZA_TIMEOUT_S per-run wall-clock budget (default: 900 = 15 min)
#   PIZZA_BRANCH    git branch for auto changes (default: auto/self-optimize)

set -eu

PIZZA_REPO="${PIZZA_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
PIZZA_BIN="${PIZZA_BIN:-/Applications/Pizza.app/Contents/Resources/pizza}"
PIZZA_TIMEOUT_S="${PIZZA_TIMEOUT_S:-900}"
PIZZA_BRANCH="${PIZZA_BRANCH:-auto/self-optimize}"
LOG_DIR="$PIZZA_REPO/.pizza-auto-optimize"
mkdir -p "$LOG_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="$LOG_DIR/run-$STAMP.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

log "=== auto-self-optimize start ==="
log "repo=$PIZZA_REPO bin=$PIZZA_BIN timeout=${PIZZA_TIMEOUT_S}s branch=$PIZZA_BRANCH"

# --- 1. Is a Pizza interactive agent already running? ----------------------
# The user's desktop/interactive agent runs as `pizza --mode rpc`. If any such
# process is alive, the user is actively using pizza — skip to avoid piling on.
# (The main lock at ~/.pizza/main/.lock is NOT a reliable signal: the app can
# run without holding it, and a crashed/restarted main agent releases it. So we
# probe live processes instead, and treat a live main-lock PID as a backup.)
if pgrep -f -- "--mode rpc" >/dev/null 2>&1; then
    log "interactive pizza agent running (--mode rpc) — nothing to do."
    exit 0
fi
MAIN_LOCK="$HOME/.pizza/main/.lock"
if [ -f "$MAIN_LOCK" ]; then
    PID=$(cat "$MAIN_LOCK" 2>/dev/null | tr -dc '0-9')
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        log "main agent alive via lock (pid $PID) — nothing to do."
        exit 0
    fi
fi

# --- 2. Launch one bounded self-optimization turn ---------------------------
cd "$PIZZA_REPO"
# Ensure a dedicated branch exists (create from current HEAD, don't touch main).
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    log "not a git repo — aborting (refusing to edit without version control)."
    exit 1
fi
git fetch -q >/dev/null 2>&1 || true
START_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)
log "current branch: $START_BRANCH"
git checkout -B "$PIZZA_BRANCH" >/dev/null 2>&1 || {
    log "could not create/checkout $PIZZA_BRANCH — aborting."
    exit 1
}

PROMPT='You are running a scheduled, autonomous self-improvement pass on your OWN source repo. Do exactly ONE focused thing, then stop:
1. Pick a small, safe, high-value improvement (a bug, a smell, missing test, a clarity/robustness fix). Avoid big refactors.
2. Make the change. Keep it minimal and isolated.
3. Verify it: run the relevant test file(s) with `PIZZA_OFFLINE=1 npx vitest --run --no-file-parallelism --poolOptions.forks.singleFork <file>` (or `npm run build` for type-only changes). Do not commit if anything fails.
4. Commit on the current branch (auto/self-optimize) with a clear conventional message.
Hard rules: never push, never force-push, never delete branches/tags, never commit to main, never run destructive git commands, never change CI secrets/auth. If you are unsure a change is safe, make NO change and just report findings. Summarize what you did (or decided not to do) in 3-5 bullets.'

MODEL_ARGS=""
if [ -n "${PIZZA_MODEL:-}" ]; then
    MODEL_ARGS="--model $PIZZA_MODEL"
fi

log "launching headless pizza (print mode, ephemeral session)..."
# Run with a wall-clock timeout. macOS has no `timeout`, so use a background
# job + sleep+kill watchdog.
"$PIZZA_BIN" --no-session --print $MODEL_ARGS "$PROMPT" >>"$LOG" 2>&1 &
AGENT_PID=$!
( sleep "$PIZZA_TIMEOUT_S"; if kill -0 "$AGENT_PID" 2>/dev/null; then log "timeout — killing agent pid $AGENT_PID"; kill -TERM "$AGENT_PID" 2>/dev/null || true; fi ) &
WATCH_PID=$!

wait "$AGENT_PID" 2>/dev/null && RC=$? || RC=$?
kill "$WATCH_PID" 2>/dev/null || true
log "agent exited (rc=$RC)."

# Restore the user's original branch so we don't leave them on the auto branch.
git checkout -q "$START_BRANCH" >/dev/null 2>&1 || true

log "=== done ==="
