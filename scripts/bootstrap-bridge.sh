#!/bin/sh
# Bootstrap the ClaudeDeck bridge on a machine (run this ON that machine).
#
#   git clone https://github.com/clausm0n/claudedeck.git ~/claudedeck && cd ~/claudedeck && sh scripts/bootstrap-bridge.sh
#   or from your laptop:             ssh HOST 'cd ~/claudedeck && sh scripts/bootstrap-bridge.sh'
#
# What it does: npm install + build, install Claude Code hooks + statusline,
# start the bridge (launchd on macOS, nohup elsewhere), print the URL to add
# in the glasses app. Idempotent — safe to re-run after `git pull`.
set -eu
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; exit 1; }; }
need node "install Node >= 22"
need npm "comes with Node"
command -v tmux >/dev/null 2>&1 || echo "note: tmux not found — sessions will be read-only until you install it (brew install tmux / apt install tmux)"

echo "== install + build"
npm install --no-audit --no-fund
npm run build

CLI="node $(pwd)/packages/bridge/dist/cli.js"

echo "== hooks + statusline into ~/.claude/settings.json"
$CLI install-hooks

echo "== start bridge"
if [ "$(uname -s)" = "Darwin" ]; then
  $CLI install-service
  PLIST="$HOME/Library/LaunchAgents/com.claudedeck.bridge.plist"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load -w "$PLIST"
  sleep 1
else
  mkdir -p "$HOME/.claudedeck"
  pkill -f 'bridge/dist/cli.js start' >/dev/null 2>&1 || true
  nohup $CLI start >"$HOME/.claudedeck/nohup.log" 2>&1 &
  sleep 1
  echo "(started with nohup; add it to systemd/cron @reboot to survive reboots)"
fi

echo "== shell wrapper (claude runs inside tmux so the glasses can control it)"
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  if ! grep -q 'claude-tmux.sh' "$rc"; then
    printf '\n# ClaudeDeck: run claude inside tmux so the G2 glasses can control it\n[ -f "%s/scripts/claude-tmux.sh" ] && source "%s/scripts/claude-tmux.sh"\n' "$(pwd)" "$(pwd)" >> "$rc"
    echo "added to $rc (open a new shell, then launch claude as usual)"
  fi
done

echo "== bridge info"
$CLI info
echo
echo "Optional dictation on this machine:  brew install whisper-cpp && $CLI setup-stt large-v3-turbo"
