# ClaudeDeck: make every `claude` you launch controllable from the glasses.
#
# Source this from ~/.zshrc / ~/.bashrc:
#   source ~/Projects/evenapp_G2/scripts/claude-tmux.sh
#
# `claude` then runs inside its own tmux session (one per launch, named after
# the directory), attached in the current terminal tab. Your tab looks and
# behaves the same (status bar hidden, mouse scroll on), but the bridge now has
# a pane to type into, so approve / interrupt / dictate work. Closing the tab
# (or an SSH drop) ends the session, exactly like plain `claude` would — no
# hidden sessions linger. Set CLAUDEDECK_PERSIST=1 to keep them instead
# (`claude-sessions` lists them, `tmux attach -t <name>` resumes).
#
# Inside an existing tmux pane, or when not on a TTY, it just runs claude.

claude() {
  if [ -n "$TMUX" ] || [ ! -t 1 ] || ! command -v tmux >/dev/null 2>&1; then
    command claude "$@"
    return $?
  fi
  local dir name n cmd
  dir=$(basename "$PWD" | tr -c 'A-Za-z0-9_.-' '_')
  n=1
  while tmux has-session -t "cc-${dir}-${n}" 2>/dev/null; do n=$((n + 1)); done
  name="cc-${dir}-${n}"
  cmd="command claude"
  if [ $# -gt 0 ]; then cmd="$cmd $(printf '%q ' "$@")"; fi
  local persist=off
  [ -n "${CLAUDEDECK_PERSIST:-}" ] && persist=on
  tmux new-session -d -s "$name" -c "$PWD" -x "$(tput cols)" -y "$(tput lines)" "$cmd" &&
    tmux set-option -t "$name" status off \; set-option -t "$name" mouse on >/dev/null &&
    tmux attach-session -t "$name" \; set-option -t "$name" destroy-unattached "$([ "$persist" = on ] && echo off || echo on)"
  # If we got here by a clean detach/exit and the session survived, clean up.
  if [ "$persist" = off ] && tmux has-session -t "$name" 2>/dev/null; then tmux kill-session -t "$name" 2>/dev/null; fi
}

# Reattach to any Claude Code sessions still running in tmux.
claude-sessions() { tmux list-sessions -F '#{session_name}  #{pane_current_path}  (#{session_attached} attached)' 2>/dev/null | grep '^cc-' || echo 'no claude tmux sessions'; }

# Put the current terminal tab under tmux so the glasses can see it and type
# into it (ClaudeDeck lists every tmux pane as a terminal). Re-running `deck`
# with the same name re-attaches. Terminals opened from the glasses are named
# t1, t2, … — take one over with `tmux attach -t t1`.
deck() {
  local name=${1:-"term-$(basename "$PWD" | tr -c 'A-Za-z0-9_.-' '_')"}
  if [ -n "$TMUX" ]; then echo "already inside tmux"; return 0; fi
  tmux new-session -A -s "$name" -c "$PWD" \; set-option -t "$name" status off \; set-option -t "$name" mouse on
}
