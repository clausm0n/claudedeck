#!/usr/bin/env node
// Fake bridge for screenshots/demos: serves fabricated sessions and terminals
// over the ClaudeDeck protocol. No real machine, user or project names.
//   node packages/app/scripts/mock-bridge.mjs [port]
//   evenhub-simulator "http://127.0.0.1:7788/app/?bridge=ws%3A%2F%2F127.0.0.1%3A7799%2Fws%3Ftoken%3Dmock"
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2] ?? 7799)
const now = Date.now()
const m = (min) => now - min * 60_000

const sessions = [
  { id: 's1', machine: 'macbook', name: 'webapp · Add login page', cwd: '/home/dev/webapp', status: 'needs_permission', statusSince: m(0.3), lastActivity: m(0.3), source: 'hook', pane: '%1', model: 'Fable 5', contextPct: 42,
    tool: { name: 'Bash', summary: 'npm test' }, lastLine: 'The form validates now. I will run the test suite to confirm.' },
  { id: 's2', machine: 'devbox', name: 'api-server · Rate limiting', cwd: '/home/dev/api-server', status: 'working', statusSince: m(2), lastActivity: m(0.1), source: 'hook', pane: '%2', model: 'Sonnet 5', contextPct: 61,
    tool: { name: 'Edit', summary: 'src/middleware/limiter.ts' }, lastLine: 'Adding a sliding-window limiter with per-route budgets.' },
  { id: 's3', machine: 'macbook', name: 'docs · Release notes', cwd: '/home/dev/docs', status: 'idle', statusSince: m(14), lastActivity: m(14), source: 'hook', pane: '%3', model: 'Fable 5', contextPct: 18,
    lastLine: 'Draft written to CHANGELOG.md — want me to open a PR?' },
  { id: 'term:%4', machine: 'macbook', name: 't1', cwd: '/home/dev/webapp', status: 'idle', statusSince: m(5), lastActivity: m(5), source: 'tmux', kind: 'shell', command: 'zsh', pane: '%4', lastLine: 'dev@macbook webapp %' },
  { id: 'term:%5', machine: 'devbox', name: 'build', cwd: '/home/dev/api-server', status: 'working', statusSince: m(1), lastActivity: m(0.2), source: 'tmux', kind: 'shell', command: 'npm', pane: '%5', lastLine: 'webpack compiled with 2 warnings in 4213 ms' },
]

const details = {
  s1: { lastUser: 'Add a login page with email + password and client-side validation.',
    lastAssistant: 'Added src/pages/Login.tsx with an email/password form, inline validation and a submit handler that posts to /api/login. Wired the route in App.tsx and a "Sign in" link in the header.\n\nThe form validates now. I will run the test suite to confirm nothing else broke.' },
  s2: { lastUser: 'Add rate limiting to the public API.',
    lastAssistant: 'Plan: a sliding-window limiter in src/middleware/limiter.ts keyed by API token, with per-route budgets from config/limits.json, and 429 responses carrying Retry-After.\n\nWriting the middleware now; tests next.' },
  s3: { lastUser: 'Write release notes for 2.4.',
    lastAssistant: 'Draft written to CHANGELOG.md:\n\n2.4.0\n- Sliding-window rate limiting for the public API\n- Login page with client-side validation\n- 14 bug fixes\n\nWant me to open a PR?' },
  'term:%4': { lastUser: '', lastAssistant: 'dev@macbook webapp % git status\nOn branch feature/login\nnothing to commit, working tree clean\ndev@macbook webapp % npm test\n\n Test Suites: 12 passed, 12 total\n Tests:       84 passed, 84 total\ndev@macbook webapp %' },
  'term:%5': { lastUser: '', lastAssistant: 'dev@devbox api-server % npm run build\n\n> api-server@2.4.0 build\n> webpack --mode production\n\nasset main.js 412 KiB [emitted]\nwebpack compiled with 2 warnings in 4213 ms' },
}

const wss = new WebSocketServer({ port, path: '/ws' })
wss.on('connection', ws => {
  const send = (msg) => ws.send(JSON.stringify(msg))
  send({ type: 'hello', machine: 'macbook', version: '0.3.0', protocol: 1, stt: { available: true, backend: 'whisper-cpp' }, tmux: true })
  send({ type: 'sessions', sessions })
  ws.on('message', data => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    switch (msg.type) {
      case 'ping': return send({ type: 'pong' })
      case 'subscribe': {
        const s = sessions.find(x => x.id === msg.sessionId)
        if (s) send({ type: 'session', session: { ...s, ...details[s.id] } })
        return
      }
      case 'screen': return send({ type: 'screen', sessionId: msg.sessionId, lines: (details[msg.sessionId]?.lastAssistant ?? '').split('\n') })
      case 'action': return send({ type: 'ack', of: msg.action, ok: true })
      case 'send': return send({ type: 'ack', of: 'send', ok: true })
      case 'audio_start': return send({ type: 'ack', of: 'audio_start', ok: true })
      case 'audio_stop': return send({ type: 'transcript', sessionId: msg.sessionId, text: 'ping google.com -c 4', raw: 'ping google dot com dash c four', seconds: 2.1 })
      case 'terminal_new': return send({ type: 'ack', of: 'terminal_new', ok: true, message: 'term:%4' })
    }
  })
})
console.log(`mock bridge on ws://127.0.0.1:${port}/ws (any token)`)
