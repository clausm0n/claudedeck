#!/bin/sh
# ClaudeDeck hook relay. Claude Code pipes the hook JSON on stdin; we forward it
# to the local bridge together with the tmux pane we're running in. Always exits
# 0 so a stopped bridge never blocks Claude.
PORT="${CLAUDEDECK_PORT:-7788}"
# Set by the bridge for its own helper `claude -p` calls — they are not sessions.
[ -n "${CLAUDEDECK_SILENT:-}" ] && { [ -t 0 ] || cat >/dev/null; exit 0; }
# Ancestor pids (nearest first) — the bridge picks the `claude` process among
# them and uses it to notice when the session exits.
ANC=""; P=$$; i=0
while [ $i -lt 6 ] && [ -n "$P" ] && [ "$P" != "1" ] && [ "$P" != "0" ]; do
  P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
  [ -n "$P" ] && ANC="$ANC $P"
  i=$((i + 1))
done
EVENT="$1"
PAYLOAD=$(cat)
curl -s -m 2 -o /dev/null \
  -X POST "http://127.0.0.1:${PORT}/hook" \
  -H 'content-type: application/json' \
  -H "x-tmux-pane: ${TMUX_PANE:-}" \
  -H "x-ancestors:${ANC}" \
  -H "x-hook-event: ${EVENT:-}" \
  --data-binary "$PAYLOAD" >/dev/null 2>&1
exit 0
