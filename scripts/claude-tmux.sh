# ClaudeDeck: make every `claude` you launch controllable from the glasses.
#
# Source this from ~/.zshrc / ~/.bashrc:
#   source ~/Projects/evenapp_G2/scripts/claude-tmux.sh
#
# `claude` then runs inside its own tmux session (one per launch, named after
# the directory), attached in the current terminal tab. Your tab looks and
# behaves the same (status bar hidden, mouse scroll on), but the bridge now has
# a pane to type into, so approve / interrupt / dictate work.
#
# Persistence: in a local terminal the session ends with its tab, exactly like
# plain `claude` would — no hidden sessions linger. Over SSH the session is
# kept instead, so a dropped connection does not kill a running Claude
# (`claude-sessions` lists them, `claude` re-attaches to a detached one, or
# `tmux attach -t =<name>`). Override with CLAUDEDECK_PERSIST=1 / =0.
#
# One-shot invocations (`claude -p …`, `--version`, `doctor`, `mcp`, …) and
# calls from inside tmux, from a non-TTY, or without tmux run claude directly.

# A stale `alias claude=…` (claude migrate-installer used to write one) would
# otherwise turn this definition into a parse error.
unalias claude 2>/dev/null

claude() {
  if [ -n "$TMUX" ] || [ ! -t 1 ] || ! command -v tmux >/dev/null 2>&1; then
    command claude "$@"
    return $?
  fi
  # Non-interactive forms: no TUI, nothing for the glasses to drive.
  case "${1:-}" in
    -p|--print|-v|--version|-h|--help|doctor|update|install|mcp|config|plugin|auth|login|logout|setup-token|migrate-installer)
      command claude "$@"
      return $?
      ;;
  esac
  local a
  for a in "$@"; do
    case "$a" in
      -p|--print|--version|--help) command claude "$@"; return $? ;;
    esac
  done

  local dir name n cmd persist cols lines
  # Session names are tmux targets: no '.' (window.pane syntax) and no
  # trailing newline-turned-'_' from tr.
  dir=$(printf '%s' "${PWD##*/}" | tr -c 'A-Za-z0-9_-' '_')
  [ -n "$dir" ] || dir=root

  # Over SSH keep the session by default; locally it dies with the tab.
  persist=off
  if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then persist=on; fi
  case "${CLAUDEDECK_PERSIST:-}" in
    1|on|yes|true) persist=on ;;
    0|off|no|false) persist=off ;;
  esac

  # Re-attach to a detached session for this directory (SSH drop, or a
  # persisted one) instead of starting a second Claude next to it.
  if [ $# -eq 0 ]; then
    local detached
    detached=$(tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null | awk -v p="^cc-${dir}-[0-9]+$" '$1 ~ p && $2 == 0 { print $1; exit }')
    if [ -n "$detached" ]; then
      echo "claudedeck: re-attaching to $detached (CLAUDEDECK_NEW=1 for a fresh session)" >&2
      if [ -z "${CLAUDEDECK_NEW:-}" ]; then
        tmux attach-session -t "=$detached"
        return $?
      fi
    fi
  fi

  n=1
  while tmux has-session -t "=cc-${dir}-${n}" 2>/dev/null; do n=$((n + 1)); done
  name="cc-${dir}-${n}"
  # Resolve the real binary now (a PATH the pane might not have, e.g. nvm).
  local bin
  # `command -v` would report this function; ask for the file explicitly.
  bin=$(whence -p claude 2>/dev/null || type -P claude 2>/dev/null)
  [ -n "$bin" ] || bin="$HOME/.local/bin/claude"
  [ -n "$bin" ] && [ -x "$bin" ] || bin=claude
  cmd=$(printf '%q ' "$bin" "$@")
  cols=$(tput cols 2>/dev/null || echo 120)
  lines=$(tput lines 2>/dev/null || echo 36)
  # Address the session by its id ($N) from here on: ids are exact, names are
  # prefix-matched by tmux (cc-foo-1 would also hit cc-foo-10) and
  # set-option does not accept the `=name` exact form.
  local sid
  sid=$(tmux new-session -d -P -F '#{session_id}' -s "$name" -c "$PWD" -x "$cols" -y "$lines" "$cmd" 2>/dev/null)
  if [ -z "$sid" ]; then
    echo "claudedeck: tmux could not start a session — running claude directly" >&2
    command claude "$@"
    return $?
  fi
  # A command that exits at once (binary missing, bad flag) leaves no session
  # to attach to; say so instead of a bare tmux error.
  if ! tmux has-session -t "$sid" 2>/dev/null; then
    echo "claudedeck: '$cmd' exited immediately — is claude on PATH? running it directly" >&2
    command claude "$@"
    return $?
  fi
  tmux set-option -t "$sid" status off \; set-option -t "$sid" mouse on >/dev/null
  if [ "$persist" = on ]; then
    tmux set-option -t "$sid" destroy-unattached off >/dev/null
    tmux attach-session -t "$sid"
    if tmux has-session -t "$sid" 2>/dev/null; then
      echo "claudedeck: $name kept running — \`claude\` here re-attaches, \`claude-sessions\` lists" >&2
    fi
  else
    tmux attach-session -t "$sid" \; set-option -t "$sid" destroy-unattached on
    # If we got here by a clean detach/exit and the session survived, clean up.
    tmux has-session -t "$sid" 2>/dev/null && tmux kill-session -t "$sid" 2>/dev/null
  fi
  return 0
}

# Reattach to any Claude Code sessions still running in tmux.
claude-sessions() { tmux list-sessions -F '#{session_name}  #{pane_current_path}  (#{session_attached} attached)' 2>/dev/null | grep '^cc-' || echo 'no claude tmux sessions'; }

# Put the current terminal tab under tmux so the glasses can see it and type
# into it (ClaudeDeck lists every tmux pane as a terminal). Re-running `deck`
# with the same name re-attaches. Terminals opened from the glasses are named
# t1, t2, … — take one over with `tmux attach -t =t1`.
deck() {
  local name=${1:-"term-$(printf '%s' "${PWD##*/}" | tr -c 'A-Za-z0-9_-' '_')"}
  if [ -n "$TMUX" ]; then echo "already inside tmux"; return 0; fi
  tmux new-session -A -s "$name" -c "$PWD" \; set-option -t "$name" status off \; set-option -t "$name" mouse on
}
