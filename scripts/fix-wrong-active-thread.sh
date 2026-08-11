#!/bin/bash
# One-time fix for the "wrong active thread" bug.
# Reclassifies scheduler-origin threads (whose earliest session was created_by
# 'schedule') from status='active' to status='background', so the deterministic
# active-thread selection picks the real interactive thread on next load.
#
# Usage: ./fix_active_thread.sh [events.sqlite path]
set -euo pipefail
DB="${1:-$HOME/.pizza/agent/workspaces/ws_9d6dd8fe9a55/events.sqlite}"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB" >&2; exit 1
fi

echo "DB: $DB"
echo "=== threads BEFORE ==="
sqlite3 "$DB" "SELECT rowid, thread_id, status, COALESCE(name,'') FROM threads ORDER BY rowid;"

# For each active thread, find its earliest session's created_by.
# If that is 'schedule', it is a scheduler-origin thread -> background.
sqlite3 "$DB" <<SQL
UPDATE threads
SET status = 'background'
WHERE status = 'active'
  AND thread_id IN (
    SELECT s.thread_id
    FROM sessions s
    WHERE s.created_by = 'schedule'
    GROUP BY s.thread_id
    HAVING MIN(s.created_at) = (
      SELECT MIN(s2.created_at) FROM sessions s2 WHERE s2.thread_id = s.thread_id
    )
  );
SQL

echo "=== threads AFTER ==="
sqlite3 "$DB" "SELECT rowid, thread_id, status, COALESCE(name,'') FROM threads ORDER BY rowid;"
