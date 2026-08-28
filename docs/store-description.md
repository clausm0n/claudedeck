ClaudeDeck puts your Claude Code sessions — and your terminals — on your glasses. See every session across your machines at a glance (status, running tool, model, context %), approve or deny permission prompts, interrupt, send "continue", dictate prompts and shell commands, open new terminals, and peek at the raw screen — hands off the keyboard.

SETUP (about 5 minutes; macOS or Linux, Node 22, tmux)
1. git clone https://github.com/clausm0n/claudedeck && cd claudedeck && npm install && npm run build && npm link -w @claudedeck/bridge
2. claudedeck install-hooks — adds Claude Code hooks + statusline to ~/.claude/settings.json (backup kept)
3. claudedeck install-service — the bridge runs at login (launchd)
4. Add "source <repo>/scripts/claude-tmux.sh" to ~/.zshrc: every `claude` now runs in tmux so the glasses can type into it; `deck` does the same for any terminal tab
5. Reach the bridge from your phone: same Wi-Fi works as-is (ws://). From anywhere: install Tailscale on both, enable Serve + HTTPS in the Tailscale admin console, then `tailscale serve --bg --https=443 http://127.0.0.1:7788`
6. Pair: run `claudedeck pair --open`, then in ClaudeDeck's phone page tap Scan QR and photograph the code (or `claudedeck url --copy` and paste into Add bridge)
7. Optional dictation: brew install whisper-cpp && claudedeck setup-stt large-v3-turbo
Repeat steps 1–3 on every machine; `claudedeck remote add` relays them through one hub.

GLASSES CONTROLS
swipe: move · tap: open / run · double-tap: back · hold: hide display · tap-then-hold: menu (approve, approve all, deny, interrupt, continue, dictate, raw terminal, reconnect). Inside a session, hold = push-to-talk dictation; review the transcript before it is sent.

PRIVACY
The app connects only to bridge URLs you add. Audio is transcribed on your own machine (whisper.cpp). Nothing goes through third-party servers. Source: github.com/clausm0n/claudedeck
