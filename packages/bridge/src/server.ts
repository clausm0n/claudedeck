import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, RemoteInfo, ServerMessage, SessionAction, SessionSummary } from '@claudedeck/shared'
import { PROTOCOL_VERSION } from '@claudedeck/shared'
import type { BridgeConfig } from './config.js'
import { SessionRegistry, type HookPayload, type StatuslinePayload } from './sessions.js'
import { capturePane, lastTmuxError, listPanes, paneRunsClaude, sendKeys, sendText } from './tmux.js'
import { createStt } from './stt.js'
import { resolveCommand, resolveCommandLocal, spokenToCommand } from './command.js'
import { createLlm } from './llm.js'
import { RemoteBridge } from './remotes.js'
import { VERSION } from './version.js'
import { log } from './log.js'

interface Client {
  ws: WebSocket
  subscribed?: string
  audio?: { chunks: Buffer[]; sessionId?: string; sampleRate: number; startedAt: number }
  alive: boolean
}

const ACTION_KEYS: Record<Exclude<SessionAction, 'keys' | 'continue' | 'kill'>, string[]> = {
  approve: ['y'],
  approve_all: ['2'],
  deny: ['Escape'],
  interrupt: ['Escape'],
  cycle_mode: ['BTab'],
  enter: ['Enter'],
  ctrl_c: ['C-c'],
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

/** Budget for the read-only command-resolving agent (claude -p): startup + a couple of tool turns. */
const REFINE_MS = 30_000

/** Hook posts are small JSON blobs; anything bigger is not ours. */
const MAX_BODY = 1024 * 1024

/** Built glasses app (packages/app/dist), served at /app/ so no dev server is needed. */
export function appDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'dist')
}

export function startServer(cfg: BridgeConfig, registry: SessionRegistry): http.Server {
  const stt = createStt(cfg)
  const llm = createLlm(cfg)
  const clients = new Set<Client>()
  const remotes = (cfg.remotes ?? []).map(r => new RemoteBridge(r.name, r.url))
  const appDist = appDistDir()

  const allSessions = (): SessionSummary[] => [...registry.list(), ...remotes.flatMap(r => r.sessions)]
  const remoteFor = (id: string) => remotes.find(r => r.owns(id))
  const remotesInfo = (): RemoteInfo[] => remotes.map(r => r.info())
  const subscribersOf = (r: RemoteBridge) => [...clients].filter(c => c.subscribed && r.owns(c.subscribed))

  /**
   * A client stops watching its session. The remote keeps streaming details for
   * a subscription nobody reads unless told, so forward the unsubscribe when the
   * last watcher of that remote leaves (unless it is only switching sessions
   * on the same remote — the next subscribe replaces it).
   */
  const releaseSubscription = (c: Client, keep?: RemoteBridge) => {
    const old = c.subscribed
    c.subscribed = undefined
    const r = old ? remoteFor(old) : undefined
    if (r && r !== keep && subscribersOf(r).length === 0) r.unsubscribe()
  }

  /**
   * Dictated shell command → real command line, resolved by the bridge that
   * owns the terminal (it explores the pane's directory read-only). Any
   * failure falls back to the rule-based draft so dictation never stalls.
   */
  const refineFor = async (sessionId: string, heard: string, draft: string): Promise<string> => {
    const r = remoteFor(sessionId)
    if (r) {
      const ack = await r.forwardRequest({ type: 'refine', sessionId, heard, draft }, 'refine', REFINE_MS + 5000)
      if (ack.ok && ack.message) return ack.message
      log(`refine on ${r.name} failed: ${ack.message ?? 'no reply'} — using the rule-based draft`)
      return draft
    }
    try {
      return await resolveLocally(heard, draft, registry.get(sessionId)?.cwd)
    } catch (err) {
      log(`refine failed: ${(err as Error).message} — using the rule-based draft`)
      return draft
    }
  }

  /** The configured transform on this bridge: the local model, or the cloud `claude -p` agent (opt-in). */
  const resolveLocally = (heard: string, draft: string, cwd?: string): Promise<string> => {
    if (cfg.stt.shellTransform === 'claude') return resolveCommand(heard, draft, { cwd, model: cfg.stt.shellModel, timeoutMs: REFINE_MS })
    return resolveCommandLocal(heard, draft, { cwd, llm, timeoutMs: REFINE_MS })
  }

  const server = http.createServer((req, res) => {
    // An aborted hook POST or a thrown handler must never take the daemon down.
    handleHttp(req, res).catch(err => {
      log(`http ${req.method} ${req.url}: ${(err as Error).message}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()

    const local = isLocalRequest(req)
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
          protocol: PROTOCOL_VERSION,
          sessions: allSessions().length,
          remotes: remotes.map(r => ({
            name: r.name,
            machine: r.host || undefined,
            state: r.state,
            version: r.version,
            protocol: r.protocol,
            tmux: r.tmux,
            outdated: r.outdated,
            canTerminal: r.canTerminal,
            sessions: r.sessions.length,
            lastSeenAgo: r.lastSeenAt ? Math.round((Date.now() - r.lastSeenAt) / 1000) : undefined,
            error: r.lastError || undefined,
          })),
          llm: { backend: cfg.llm.backend, model: llm.modelName, running: llm.running, transform: cfg.stt.shellTransform, problem: await llm.problem() },
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
      res.end(
        JSON.stringify(
          {
            version: VERSION,
            path: process.env.PATH,
            tmux: registry.tmuxAvailable,
            tmuxError: lastTmuxError,
            paneError,
            panes: panes.map(p => `${p.id} pid=${p.pid} cmd=${p.command}`),
            claudePanes,
            clients: [...clients].map(c => ({ subscribed: c.subscribed, alive: c.alive })),
            remotes: remotesInfo(),
            sessions: registry.dump(),
          },
          null,
          2,
        ),
      )
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
  }

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') return void socket.destroy()
    const token = url.searchParams.get('token')
    if (token !== cfg.token && !isLocalRequest(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return void socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })

  const send = (c: Client, msg: ServerMessage) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg))
  }

  const broadcastSessions = () => {
    const msg: ServerMessage = { type: 'sessions', sessions: allSessions(), remotes: remotesInfo() }
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
    // Acks are answered per request now (RemoteBridge.request); only strays land here.
    r.on('ack', (a: { of: string; ok: boolean; message?: string }) => log(`remote ${r.name}: unmatched ack ${a.of} ok=${a.ok}${a.message ? ` (${a.message})` : ''}`))
    r.on('error', (m: string, handled: boolean) => {
      log(`remote ${r.name}: ${m}`)
      // Not consumed by a pending request/screen → it answers a subscribe
      // (e.g. "no such session"); tell whoever is watching that remote.
      if (!handled) for (const c of subscribersOf(r)) send(c, { type: 'error', message: `${r.name}: ${m}` })
    })
    r.start()
  }

  wss.on('connection', (ws, req) => {
    const client: Client = { ws, alive: true }
    clients.add(client)
    // Register every handler before the first await: an unhandled 'error'
    // event exits the process, and a subscribe sent right after the client's
    // hello would otherwise be dropped.
    ws.on('error', err => log(`ws error from ${req.socket.remoteAddress}: ${err.message}`))
    ws.on('pong', () => (client.alive = true))
    ws.on('close', () => {
      clients.delete(client)
      releaseSubscription(client)
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
    log(`ws connect from ${req.socket.remoteAddress} (${clients.size} clients)`)
    stt
      .available()
      .catch(() => false)
      .then(available => {
        send(client, {
          type: 'hello',
          machine: cfg.machine,
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          stt: { available, backend: stt.name },
          tmux: registry.tmuxAvailable,
          remotes: remotesInfo(),
        })
        send(client, { type: 'sessions', sessions: allSessions(), remotes: remotesInfo() })
      })
  })

  async function handle(c: Client, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        return
      case 'ping':
        return send(c, { type: 'pong' })
      case 'subscribe': {
        const r = remoteFor(msg.sessionId)
        if (c.subscribed !== msg.sessionId) releaseSubscription(c, r)
        c.subscribed = msg.sessionId
        if (r) {
          if (!r.forward(msg)) send(c, { type: 'error', message: `${r.name} is not connected` })
          return
        }
        const d = registry.detail(msg.sessionId)
        if (d) send(c, { type: 'session', session: d })
        else send(c, { type: 'error', message: 'no such session' })
        return
      }
      case 'unsubscribe':
        releaseSubscription(c)
        return
      case 'screen': {
        const r = remoteFor(msg.sessionId)
        if (r) {
          // Rejections carry the remote's reason (or a 5 s timeout) and reach the client as an error.
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
          // 0.2.0 remotes have no key mapping for these: they would throw, not ack.
          if (r.outdated && (msg.action === 'kill' || msg.action === 'ctrl_c')) return send(c, { type: 'ack', of: msg.action, ok: false, message: r.outdatedMessage() })
          return send(c, await r.forwardRequest(msg, msg.action))
        }
        const s = registry.get(msg.sessionId)
        if (!s?.pane) return send(c, { type: 'ack', of: msg.action, ok: false, message: 'no tmux pane for this session' })
        log(`action ${msg.action} → ${s.name} (${s.pane})`)
        if (msg.action === 'kill') await registry.killPaneOf(s.id)
        else if (msg.action === 'continue') await sendText(s.pane, 'continue', true)
        else if (msg.action === 'keys') await sendKeys(s.pane, (msg.keys ?? '').split(/\s+/).filter(Boolean))
        else await sendKeys(s.pane, ACTION_KEYS[msg.action])
        return send(c, { type: 'ack', of: msg.action, ok: true })
      }
      case 'send': {
        const r = remoteFor(msg.sessionId)
        if (r) return send(c, await r.forwardRequest(msg, 'send'))
        const s = registry.get(msg.sessionId)
        if (!s?.pane) return send(c, { type: 'ack', of: 'send', ok: false, message: 'no tmux pane for this session' })
        log(`send "${msg.text.slice(0, 60)}" → ${s.name}`)
        await sendText(s.pane, msg.text, msg.enter !== false)
        return send(c, { type: 'ack', of: 'send', ok: true })
      }
      case 'terminal_new': {
        if (msg.machine && msg.machine !== cfg.machine) {
          const nack = (message: string) => send(c, { type: 'ack', of: 'terminal_new', ok: false, message })
          const r = remotes.find(x => x.machine === msg.machine || x.name === msg.machine)
          if (!r) return nack(`no bridge named ${msg.machine}`)
          if (r.state !== 'open') return nack(`${r.name} is not connected${r.lastError ? ` (${r.lastError})` : ''}`)
          // Answer the common failure instantly and actionably instead of after the app's 10 s timeout.
          if (r.outdated) return nack(r.outdatedMessage())
          if (r.tmux === false) return nack(`tmux not available on ${r.name}`)
          // The remote creates the session and rescans before acking; 8 s stays under the app's 10 s.
          return send(c, await r.request({ type: 'terminal_new', cwd: msg.cwd }, 'terminal_new', 8000))
        }
        if (!registry.tmuxAvailable) return send(c, { type: 'ack', of: 'terminal_new', ok: false, message: 'tmux not available on this bridge' })
        const id = await registry.createTerminal(msg.cwd)
        log(`terminal ${id} created`)
        return send(c, { type: 'ack', of: 'terminal_new', ok: true, message: id })
      }
      case 'refine': {
        // Resolve on the bridge that owns the pane: only it can look at the directory.
        const r = remoteFor(msg.sessionId)
        if (r) return send(c, await r.forwardRequest(msg, 'refine', REFINE_MS + 5000))
        if (cfg.stt.shellTransform === 'off' || cfg.stt.shellTransform === 'rules') return send(c, { type: 'ack', of: 'refine', ok: false, message: `shellTransform is '${cfg.stt.shellTransform}' on ${cfg.machine} (set it to 'local' and run claudedeck setup-llm there)` })
        const s = registry.get(msg.sessionId)
        const draft = msg.draft || spokenToCommand(msg.heard)
        try {
          const text = await resolveLocally(msg.heard, draft, s?.cwd)
          return send(c, { type: 'ack', of: 'refine', ok: true, message: text })
        } catch (err) {
          return send(c, { type: 'ack', of: 'refine', ok: false, message: `refine failed on ${cfg.machine}: ${(err as Error).message}` })
        }
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
        const target = a.sessionId ? allSessions().find(s => s.id === a.sessionId) : undefined
        const shell = target?.kind === 'shell'
        const heard = await stt.transcribe(pcm, a.sampleRate, shell ? cfg.stt.shellPrompt : undefined)
        let text = heard
        if (shell && target && cfg.stt.shellTransform !== 'off' && heard) {
          text = spokenToCommand(heard)
          if (cfg.stt.shellTransform === 'local' || cfg.stt.shellTransform === 'claude') text = await refineFor(target.id, heard, text)
          log(`command: "${heard}" → "${text}"`)
        }
        return send(c, { type: 'transcript', sessionId: a.sessionId, text, raw: shell && text !== heard ? heard : undefined, seconds })
      }
      default: {
        // A message this build does not know (newer app or hub). Silence here
        // is what made "+ new terminal" hang against a 0.2.0 remote — always answer.
        const type = (msg as { type?: string }).type ?? '?'
        return send(c, { type: 'ack', of: type, ok: false, message: `unsupported message '${type}' on ${cfg.machine} (claudedeck ${VERSION}) - update this bridge` })
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
        releaseSubscription(c)
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }, 20_000).unref()

  server.on('listening', () => {
    log(`claudedeck bridge ${VERSION} listening on ${cfg.host}:${cfg.port} as "${cfg.machine}"`)
    if (remotes.length) log(`relaying remotes: ${remotes.map(r => r.name).join(', ')}`)
    log(fs.existsSync(path.join(appDist, 'index.html')) ? `serving glasses app at /app/ from ${appDist}` : 'glasses app not built (npm run build) — /app/ disabled')
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Uncaught this would exit 1 and launchd would respawn us every 10 s
      // with nothing in bridge.log. Wait for the other instance to go away.
      log(`port ${cfg.port} is busy - retrying in 3 s`)
      void whoHoldsPort(cfg.port).then(who => {
        if (who) log(`another bridge already serves port ${cfg.port}: ${who} (stop it, or run this one with a different port)`)
      })
      setTimeout(() => server.listen(cfg.port, cfg.host), 3000)
      return
    }
    log(`server error: ${err.message}`)
    process.exit(1)
  })
  server.listen(cfg.port, cfg.host)
  server.on('close', () => {
    remotes.forEach(r => r.stop())
    llm.stop()
  })
  return server
}

async function whoHoldsPort(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return undefined
    const h = (await res.json()) as { machine?: string; version?: string }
    return h.machine ? `${h.machine} claudedeck ${h.version ?? '?'}` : undefined
  } catch {
    return undefined
  }
}

function isLoopback(addr?: string): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')
}

/**
 * Loopback peer that is not a reverse proxy. `tailscale serve` (the TLS front
 * for packaged apps) forwards from 127.0.0.1 with X-Forwarded-For set, and
 * those connections must present the token like any other remote client.
 */
function isLocalRequest(req: http.IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && !header(req, 'x-forwarded-for')
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return s && s.trim() ? s.trim() : undefined
}

/** Body as text; an aborted or oversized request yields '' instead of a rejection (never crash on a `curl -m` cut short). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        chunks.length = 0
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
    req.on('aborted', () => resolve(''))
    req.on('close', () => resolve(''))
  })
}
