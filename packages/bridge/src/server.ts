import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, ServerMessage, SessionAction, SessionSummary } from '@claudedeck/shared'
import { PROTOCOL_VERSION } from '@claudedeck/shared'
import type { BridgeConfig } from './config.js'
import { SessionRegistry, type HookPayload, type StatuslinePayload } from './sessions.js'
import { capturePane, lastTmuxError, listPanes, paneRunsClaude, sendKeys, sendText } from './tmux.js'
import { createStt } from './stt.js'
import { RemoteBridge } from './remotes.js'
import { log } from './log.js'

const VERSION = '0.2.0'

interface Client {
  ws: WebSocket
  subscribed?: string
  audio?: { chunks: Buffer[]; sessionId?: string; sampleRate: number; startedAt: number }
  alive: boolean
}

const ACTION_KEYS: Record<Exclude<SessionAction, 'keys' | 'continue'>, string[]> = {
  approve: ['y'],
  approve_all: ['2'],
  deny: ['Escape'],
  interrupt: ['Escape'],
  cycle_mode: ['BTab'],
  enter: ['Enter'],
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

/** Built glasses app (packages/app/dist), served at /app/ so no dev server is needed. */
export function appDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'dist')
}

export function startServer(cfg: BridgeConfig, registry: SessionRegistry): http.Server {
  const stt = createStt(cfg)
  const clients = new Set<Client>()
  const remotes = (cfg.remotes ?? []).map(r => new RemoteBridge(r.name, r.url))
  const appDist = appDistDir()

  const allSessions = (): SessionSummary[] => [...registry.list(), ...remotes.flatMap(r => r.sessions)]
  const remoteFor = (id: string) => remotes.find(r => r.owns(id))

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()

    const local = isLoopback(req.socket.remoteAddress)
    const token = url.searchParams.get('token') ?? req.headers['x-claudedeck-token']
    const authed = local || token === cfg.token

    if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/statusline')) {
      if (!authed) return void res.writeHead(401).end()
      const body = await readBody(req)
      let payload: HookPayload | StatuslinePayload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        return void res.writeHead(400).end('bad json')
      }
      const pane = header(req, 'x-tmux-pane')
      const ancestors = (header(req, 'x-ancestors') ?? '').split(/\s+/).map(Number).filter(n => n > 1)
      if (url.pathname === '/hook') {
        registry.applyHook(payload as HookPayload, { tmuxPane: pane, ancestors })
      } else {
        registry.applyStatusline(payload as StatuslinePayload, { tmuxPane: pane, ancestors })
      }
      // Hooks that parse JSON output treat `{}` as "no decision".
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          machine: cfg.machine,
          version: VERSION,
          sessions: allSessions().length,
          remotes: remotes.map(r => ({ name: r.name, state: r.state, sessions: r.sessions.length, error: r.lastError || undefined })),
          app: fs.existsSync(path.join(appDist, 'index.html')),
        }),
      )
      return
    }
    if (url.pathname === '/debug') {
      if (!local) return void res.writeHead(401).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      const panes = await listPanes()
      const claudePanes: string[] = []
      let paneError = ''
      for (const p of panes) {
        try {
          if (await paneRunsClaude(p)) claudePanes.push(p.id)
        } catch (err) {
          paneError = (err as Error).message
        }
      }
      res.end(JSON.stringify({ path: process.env.PATH, tmux: registry.tmuxAvailable, tmuxError: lastTmuxError, paneError, panes: panes.map(p => `${p.id} pid=${p.pid} cmd=${p.command}`), claudePanes, sessions: registry.dump() }, null, 2))
      return
    }
    if (url.pathname === '/sessions') {
      if (!authed) return void res.writeHead(401).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(allSessions(), null, 2))
      return
    }
    if (url.pathname === '/app') {
      res.writeHead(302, { location: '/app/' + url.search }).end()
      return
    }
    if (url.pathname.startsWith('/app/')) {
      // The built app is public (it holds no secrets); the token travels in ?bridge=.
      const rel = url.pathname.slice('/app/'.length) || 'index.html'
      const file = path.normalize(path.join(appDist, rel))
      if (!file.startsWith(appDist)) return void res.writeHead(403).end()
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (!fs.existsSync(path.join(appDist, 'index.html'))) {
          res.writeHead(503, { 'content-type': 'text/plain' }).end('glasses app not built — run `npm run build` in the claudedeck repo')
          return
        }
        return void res.writeHead(404).end('not found')
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      fs.createReadStream(file).pipe(res)
      return
    }
    res.writeHead(404).end('claudedeck bridge')
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') return void socket.destroy()
    const token = url.searchParams.get('token')
    if (token !== cfg.token && !isLoopback(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return void socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })

  const send = (c: Client, msg: ServerMessage) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg))
  }

  const broadcastSessions = () => {
    const msg: ServerMessage = { type: 'sessions', sessions: allSessions() }
    for (const c of clients) send(c, msg)
  }

  registry.on('change', (ids: string[]) => {
    broadcastSessions()
    for (const c of clients) {
      if (c.subscribed && !remoteFor(c.subscribed) && (ids.length === 0 || ids.includes(c.subscribed))) {
        const d = registry.detail(c.subscribed)
        if (d) send(c, { type: 'session', session: d })
      }
    }
  })

  for (const r of remotes) {
    r.on('sessions', () => broadcastSessions())
    r.on('detail', d => {
      for (const c of clients) if (c.subscribed === d.id) send(c, { type: 'session', session: d })
    })
    r.on('ack', a => {
      for (const c of clients) send(c, a)
    })
    r.on('error', m => log(`remote ${r.name}: ${m}`))
    r.start()
  }

  wss.on('connection', async (ws, req) => {
    const client: Client = { ws, alive: true }
    clients.add(client)
    log(`ws connect from ${req.socket.remoteAddress} (${clients.size} clients)`)
    send(client, {
      type: 'hello',
      machine: cfg.machine,
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      stt: { available: await stt.available(), backend: stt.name },
      tmux: registry.tmuxAvailable,
    })
    send(client, { type: 'sessions', sessions: allSessions() })

    ws.on('pong', () => (client.alive = true))
    ws.on('close', () => {
      clients.delete(client)
      log(`ws close (${clients.size} clients)`)
    })
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        if (client.audio) client.audio.chunks.push(Buffer.from(data as Buffer))
        return
      }
      let msg: ClientMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return send(client, { type: 'error', message: 'bad json' })
      }
      try {
        await handle(client, msg)
      } catch (err) {
        send(client, { type: 'error', message: (err as Error).message })
      }
    })
  })

  async function handle(c: Client, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        return
      case 'ping':
        return send(c, { type: 'pong' })
      case 'subscribe': {
        c.subscribed = msg.sessionId
        const r = remoteFor(msg.sessionId)
        if (r) {
          if (!r.forward(msg)) send(c, { type: 'error', message: `remote ${r.name} not connected` })
          return
        }
        const d = registry.detail(msg.sessionId)
        if (d) send(c, { type: 'session', session: d })
        else send(c, { type: 'error', message: 'no such session' })
        return
      }
      case 'unsubscribe':
        c.subscribed = undefined
        return
      case 'screen': {
        const r = remoteFor(msg.sessionId)
        if (r) {
          const lines = await r.screen(msg.sessionId, Math.min(200, msg.lines ?? 60))
          return send(c, { type: 'screen', sessionId: msg.sessionId, lines })
        }
        const s = registry.get(msg.sessionId)
        if (!s?.pane) return send(c, { type: 'error', message: 'session has no tmux pane' })
        const lines = await capturePane(s.pane, Math.min(200, msg.lines ?? 60))
        return send(c, { type: 'screen', sessionId: msg.sessionId, lines })
      }
      case 'action': {
        const r = remoteFor(msg.sessionId)
        if (r) {
          if (!r.forward(msg)) send(c, { type: 'ack', of: msg.action, ok: false, message: `remote ${r.name} not connected` })
          return
        }
        const s = registry.get(msg.sessionId)
        if (!s?.pane) return send(c, { type: 'ack', of: msg.action, ok: false, message: 'no tmux pane for this session' })
        log(`action ${msg.action} → ${s.name} (${s.pane})`)
        if (msg.action === 'continue') await sendText(s.pane, 'continue', true)
        else if (msg.action === 'keys') await sendKeys(s.pane, (msg.keys ?? '').split(/\s+/).filter(Boolean))
        else await sendKeys(s.pane, ACTION_KEYS[msg.action])
        return send(c, { type: 'ack', of: msg.action, ok: true })
      }
      case 'send': {
        const r = remoteFor(msg.sessionId)
        if (r) {
          if (!r.forward(msg)) send(c, { type: 'ack', of: 'send', ok: false, message: `remote ${r.name} not connected` })
          return
        }
        const s = registry.get(msg.sessionId)
        if (!s?.pane) return send(c, { type: 'ack', of: 'send', ok: false, message: 'no tmux pane for this session' })
        log(`send "${msg.text.slice(0, 60)}" → ${s.name}`)
        await sendText(s.pane, msg.text, msg.enter !== false)
        return send(c, { type: 'ack', of: 'send', ok: true })
      }
      case 'audio_start':
        // Dictation is always transcribed on the hub, even for remote sessions.
        c.audio = { chunks: [], sessionId: msg.sessionId, sampleRate: msg.sampleRate ?? 16000, startedAt: Date.now() }
        return send(c, { type: 'ack', of: 'audio_start', ok: true })
      case 'audio_cancel':
        c.audio = undefined
        return send(c, { type: 'ack', of: 'audio_cancel', ok: true })
      case 'audio_stop': {
        const a = c.audio
        c.audio = undefined
        if (!a) return send(c, { type: 'ack', of: 'audio_stop', ok: false, message: 'not recording' })
        const pcm = Buffer.concat(a.chunks)
        const seconds = pcm.length / 2 / a.sampleRate
        log(`transcribe ${seconds.toFixed(1)}s of audio`)
        if (pcm.length < a.sampleRate * 2 * 0.4) {
          return send(c, { type: 'transcript', sessionId: a.sessionId, text: '', seconds })
        }
        const text = await stt.transcribe(pcm, a.sampleRate)
        return send(c, { type: 'transcript', sessionId: a.sessionId, text, seconds })
      }
    }
  }

  // Periodic snapshot so the glasses refresh ages and notice stale sockets.
  setInterval(() => broadcastSessions(), 30_000).unref()

  // Heartbeat: drop dead phones.
  setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        clients.delete(c)
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }, 20_000).unref()

  server.listen(cfg.port, cfg.host, () => {
    log(`claudedeck bridge ${VERSION} listening on ${cfg.host}:${cfg.port} as "${cfg.machine}"`)
    if (remotes.length) log(`relaying remotes: ${remotes.map(r => r.name).join(', ')}`)
    log(fs.existsSync(path.join(appDist, 'index.html')) ? `serving glasses app at /app/ from ${appDist}` : 'glasses app not built (npm run build) — /app/ disabled')
  })
  server.on('close', () => remotes.forEach(r => r.stop()))
  return server
}

function isLoopback(addr?: string): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return s && s.trim() ? s.trim() : undefined
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
