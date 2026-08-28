#!/bin/sh
# ClaudeDeck statusline. Claude Code pipes a JSON status blob on stdin every few
# seconds; we forward it to the bridge (model, context %, session name) and print
# a compact status line for the terminal.
PORT="${CLAUDEDECK_PORT:-7788}"
# Ancestor pids (nearest first) — the bridge picks the `claude` process among
# them and uses it to notice when the session exits.
ANC=""; P=$$; i=0
while [ $i -lt 6 ] && [ -n "$P" ] && [ "$P" != "1" ] && [ "$P" != "0" ]; do
  P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
  [ -n "$P" ] && ANC="$ANC $P"
  i=$((i + 1))
done
INPUT=$(cat)
printf '%s' "$INPUT" | curl -s -m 1 -o /dev/null \
  -X POST "http://127.0.0.1:${PORT}/statusline" \
  -H 'content-type: application/json' \
  -H "x-tmux-pane: ${TMUX_PANE:-}" \
  -H "x-ancestors:${ANC}" \
  --data-binary @- >/dev/null 2>&1 &

if command -v node >/dev/null 2>&1; then
  printf '%s' "$INPUT" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{const j=JSON.parse(d);
    const m=j.model?.display_name||"";
    const pct=j.context_window?.used_percentage;
    const dir=(j.workspace?.current_dir||j.cwd||"").split("/").pop();
    const name=j.session_name?` · ${j.session_name}`:"";
    const ctx=(pct==null)?"":` · ctx ${Math.round(pct)}%`;
    process.stdout.write(`${m}${ctx} · ${dir}${name} · deck`);
  }catch{process.stdout.write("deck")}
});'
else
  printf 'deck'
fi
