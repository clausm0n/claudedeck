# ClaudeDeck: make every `claude` you launch controllable from the glasses.
#
# Source this from ~/.zshrc / ~/.bashrc:
#   source ~/Projects/evenapp_G2/scripts/claude-tmux.sh
#
# `claude` then runs inside its own tmux session (one per launch, named after
# the directory), attached in the current terminal tab. Your tab looks and
# behaves the same (status bar hidden, mouse scroll on), but the bridge now has
# a pane to type into, so approve / interrupt / dictate work. Bonus: closing
# the tab no longer kills the session — `tmux attach -t cc-<dir>-<n>` resumes.
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
  tmux new-session -d -s "$name" -c "$PWD" -x "$(tput cols)" -y "$(tput lines)" "$cmd" &&
    tmux set-option -t "$name" status off \; set-option -t "$name" mouse on \; set-option -t "$name" destroy-unattached off >/dev/null &&
    tmux attach-session -t "$name"
}

# Reattach to any Claude Code sessions still running in tmux.
claude-sessions() { tmux list-sessions -F '#{session_name}  #{pane_current_path}  (#{session_attached} attached)' 2>/dev/null | grep '^cc-' || echo 'no claude tmux sessions'; }
