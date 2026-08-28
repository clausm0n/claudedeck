# ClaudeDeck — Claude Code on Even Realities G2

Glance at every Claude Code session you have running, approve tool calls,
interrupt, dictate prompts, and peek at the raw terminal — from the G2 glasses,
over Tailscale. The Claude Code sessions stay exactly where they are (in a
terminal on your machine); ClaudeDeck only watches and pokes them.

```
 G2 glasses ──BLE──▶ Even App WebView (this plugin) ──WebSocket / Tailscale──▶ claudedeck bridge (per machine)
                                                                               ├─ Claude Code hooks   → session state
                                                                               ├─ statusline JSON     → model, context %
                                                                               ├─ transcript .jsonl   → last message / tool
                                                                               └─ tmux send-keys/capture-pane → input & screen
```

## Packages

| Package | What it is |
|---|---|
| `packages/bridge` | `claudedeck` — Node daemon that runs on every machine where you run Claude Code. Receives hook + statusline posts on `127.0.0.1:7788`, scans tmux for `claude` processes, serves sessions to the glasses over WebSocket, injects input via tmux, and (optionally) transcribes dictation with whisper.cpp. |
| `packages/app` | The Even Hub plugin (Vite + TS). Glasses UI + a phone-side page for configuring bridges. |
| `packages/shared` | Wire protocol types. |

## Requirements

- Node ≥ 22, `tmux` (`brew install tmux`) — Claude Code must run **inside a tmux pane** for input injection (`approve`, `interrupt`, dictation). Sessions outside tmux are still listed read-only.
- Tailscale on the machine(s) and on the phone (the phone's Even App must reach the bridge).
- Even Hub tooling: `npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator`.
- Optional dictation: `brew install whisper-cpp` then `claudedeck setup-stt large-v3-turbo` (1.6 GB; ~1.5 s per 5 s of speech on an M-series Mac with Metal). `base.en`/`small.en` are smaller, less accurate options. `stt.prompt` in `~/.claudedeck/config.json` biases recognition toward dev vocabulary — edit it to add your project names.

## Quick start — "my whole terminal stack, from anywhere"

```bash
npm install && npm run build
CLI="node $PWD/packages/bridge/dist/cli.js"

$CLI install-hooks        # hooks + statusline into ~/.claude/settings.json (backup kept)
$CLI install-service      # launchd agent: bridge runs at login and restarts if it dies
launchctl load -w ~/Library/LaunchAgents/com.claudedeck.bridge.plist
$CLI setup-stt large-v3-turbo   # optional dictation (brew install whisper-cpp first)

source scripts/claude-tmux.sh   # add to ~/.zshrc: every `claude` now runs in its own tmux pane
$CLI qr                   # QR → scan in the Even App (Even Hub tab → developer section → Scan QR)
```

The bridge serves the built glasses app itself at `http://<tailscale-ip>:7788/app/`, so nothing else needs to run. `claudedeck qr` encodes that URL with the bridge address + token; scan it once. Use `claudedeck qr --lan` while the phone has no Tailscale yet.

**Phone side:** install the Tailscale app, sign in to the same tailnet. From then on the glasses reach this Mac from any network (the Mac must be awake — a desktop like a Mac Studio makes the better always-on hub; see below).

### Hub mode: other machines through one address

A bridge only sees Claude Code running **on its own machine** — an SSH tab shows up locally as `ssh`, and the remote Claude's hooks post to the remote's `localhost`. Run a bridge on each machine and let this one relay it, so the phone only ever talks to the hub:

```bash
# on the remote (Node >= 22; tmux for input):
git clone <repo> ~/claudedeck && cd ~/claudedeck && sh scripts/bootstrap-bridge.sh   # prints its ws://…?token=… URL

# on the hub:
claudedeck remote add studiom3 ws://<remote-ip>:7788/ws?token=<remote token>
launchctl kickstart -k gui/$(id -u)/com.claudedeck.bridge                            # restart to connect
```

Remote sessions appear in the same list tagged `@<machine>`; approvals, typed prompts, raw screen and dictation (transcribed on the hub) are forwarded. If the hub can only reach the remote via SSH, tunnel it: `ssh -N -L 7789:127.0.0.1:7788 user@remote` and add the remote as `ws://127.0.0.1:7789/ws?token=…`.

`claudedeck remote ls | rm <name>` manage the list (`~/.claudedeck/config.json` → `remotes`).

### Dev loop

```bash
npm run app:dev            # Vite on :5173 with hot reload
npm run app:qr -- --lan    # QR pointing at the dev server (+ bridge seeded); --ts for the Tailscale IP
npm run app:sim            # evenhub-simulator with automation port 9898
```

### Packaging (later)

`npm run app:pack` builds `claudedeck.ehpk`. A packaged app must use `wss://`; put the bridge behind Tailscale TLS:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7788
# → wss://<machine>.<tailnet>.ts.net/ws?token=...
```

and list that origin in `packages/app/app.json` → `permissions[network].whitelist` (full origins, no wildcards). The dev sideload (`evenhub qr`) works with plain `ws://`.

## Glasses controls

Layout is always header / body (8 lines) / footer. All screens update flicker-free.

| Screen | swipe | tap | double-tap | tap-then-hold |
|---|---|---|---|---|
| **Sessions** (root) | move cursor | open session | exit dialog | contextual menu |
| **Session** | page through last message | actions | back | contextual menu (hold alone = push-to-talk dictation) |
| **Actions** | move cursor | run | back | |
| **Dictate** | — | stop & transcribe | cancel | |
| **Review transcript** | select Send / Retry / Cancel | run | cancel | |
| **Raw terminal** | scroll | refresh | back | |

Contextual menu (OS overlay, up to 10 items): Approve (y) · Approve all similar (2) · Deny/Esc · Interrupt · Send "continue" · Dictate · Raw terminal · All sessions · Reconnect bridges.

Row format on the Sessions screen: `> ? evenapp_G2 @machine NEEDS OK 12s  Bash: npm test`. Glyphs: `?` needs OK, `>` working, `-` idle, `~` compacting, `!` error, `x` ended. Needs-attention sessions sort first.

## How session state is derived

| Signal | Source | Gives |
|---|---|---|
| Hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SessionEnd`, …) | `bin/claudedeck-hook.sh` → `POST /hook` (async, never blocks Claude) | authoritative status transitions, current tool, `$TMUX_PANE` |
| Statusline | `bin/claudedeck-statusline.sh` → `POST /statusline` | model, context %, session name — and it fires for sessions started *before* the hooks were installed |
| Transcript | `~/.claude/projects/<slug>/<id>.jsonl` tail | last assistant text, last user prompt, pending tool |
| tmux | `list-panes` + process tree, `capture-pane` | sessions with no hook data yet; screen heuristics (`esc to interrupt`, permission dialogs) |

The bridge listens on `0.0.0.0` but requires the token for anything except loopback (`/hook`, `/statusline`). `~/.claudedeck/config.json` holds `port`, `token`, `machine`, `stt`. Logs: `~/.claudedeck/bridge.log`.

## Bridge CLI

```
claudedeck start | install-hooks [--no-statusline] | uninstall-hooks | info | token [--rotate] | qr [--lan]
claudedeck setup-stt [large-v3-turbo|small.en|base.en|...] | install-service | status
claudedeck remote add <name> <ws-url> | rm <name> | ls
```

`GET /health`, `GET /sessions?token=…` are handy for debugging; the simulator can be driven with `--automation-port 9898` (`/api/screenshot/glasses`, `/api/input`).

## Development

```bash
npm run bridge:dev      # tsx watch
npm run app:dev
npm run app:sim         # evenhub-simulator with automation port 9898
npm run typecheck
```

Key files: `packages/bridge/src/sessions.ts` (state machine), `packages/app/src/glasses/screens/*` (one class per screen), `packages/app/src/glasses/display.ts` (3-row layout + upgrade queue), `packages/shared/src/index.ts` (protocol).

## Known limits / next ideas

- Input injection needs tmux. A non-tmux session is visible but read-only — `scripts/claude-tmux.sh` makes that automatic.
- `approve` types `y`, `approve_all` types `2`, `deny`/`interrupt` send `Esc` — matching Claude Code's permission dialog. If no dialog is open, `y`/`2` land in the prompt box; the Actions screen only offers them when the session is in `needs_permission`.
- The `PermissionRequest` hook could answer permissions directly (its JSON reply is honoured), which would remove the tmux dependency for approvals but would hide the terminal prompt while the glasses decide. Left as an opt-in idea.
- Android may suspend the WebView in the background; the app reconnects on foreground and re-sends the current frame.
- Transcript JSONL is an internal format; the parser is tolerant but may need touch-ups on Claude Code upgrades.
