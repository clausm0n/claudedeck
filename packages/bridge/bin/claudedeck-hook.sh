#!/bin/sh
# ClaudeDeck hook relay. Claude Code pipes the hook JSON on stdin; we forward it
# to the local bridge together with the tmux pane we're running in. Always exits
# 0 so a stopped bridge never blocks Claude.
PORT="${CLAUDEDECK_PORT:-7788}"
EVENT="$1"
PAYLOAD=$(cat)
curl -s -m 2 -o /dev/null \
  -X POST "http://127.0.0.1:${PORT}/hook" \
  -H 'content-type: application/json' \
  -H "x-tmux-pane: ${TMUX_PANE:-}" \
  -H "x-hook-event: ${EVENT:-}" \
  --data-binary "$PAYLOAD" >/dev/null 2>&1
exit 0
