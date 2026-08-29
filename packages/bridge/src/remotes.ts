import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { ClientMessage, RemoteInfo, ServerMessage, SessionDetail, SessionSummary } from '@claudedeck/shared'
import { PROTOCOL_VERSION } from '@claudedeck/shared'
import { MIN_REMOTE_VERSION, VERSION, compareVersions } from './version.js'
import { log } from './log.js'

const BACKOFF_MIN = 1500
const BACKOFF_MAX = 20000
const PING_MS = 20_000
/** The remote answers WS pings and pushes a sessions snapshot every 30 s; this much silence means the link is dead. */
const STALL_MS = 50_000
const REQUEST_MS = 6000
/** Shorter than the app's own 6 s screen timeout so the real reason (not "timeout") reaches the glasses. */
const SCREEN_MS = 5000

export type AckMsg = Extract<ServerMessage, { type: 'ack' }>

interface Pending {
  of: string
  at: number
  settle: (a: AckMsg) => void
}

interface ScreenWaiter {
  at: number
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
}

/**
 * A client connection from this bridge (the hub) to another bridge. Remote
 * session ids are namespaced `<name>::<id>` so the phone can address them
 * through the hub without knowing where they live.
 *
 * Every forwarded request is answered: acks are matched FIFO by `of` (remotes
 * never echo a request id), the remote's `error` replies settle the oldest
 * waiter, and a timeout produces a synthetic `ok:false` ack — so a remote
 * that is too old to understand a message can never leave the glasses hanging.
 */
export class RemoteBridge extends EventEmitter {
  machine: string
  /** The remote's own hostname (its hello `machine`), e.g. tb5k for a remote named studiom3. */
  host = ''
  version?: string
  protocol?: number
  /** Undefined until the remote's hello arrived. */
  tmux?: boolean
  state: 'connecting' | 'open' | 'closed' = 'closed'
  sessions: SessionSummary[] = []
  /** Last connection-level error (not the remote's protocol replies). */
  lastError = ''
  lastSeenAt = 0
  private ws?: WebSocket
  private timer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private stallTimer?: NodeJS.Timeout
  private backoff = BACKOFF_MIN
  private stopped = false
  private helloSeen = false
  private pending: Pending[] = []
  private screenWaiters: ScreenWaiter[] = []
  /** Session the hub's clients watch on this remote — replayed after a reconnect. */
  private subscribedId?: string

  constructor(public readonly name: string, public readonly url: string) {
    super()
    this.machine = name
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.stopLiveness()
    this.failAll(`remote ${this.name} stopped`)
    this.ws?.close()
  }

  owns(id: string): boolean {
    return id.startsWith(`${this.name}::`)
  }

  /** Older than the first bridge that understands terminal_new / ctrl_c / kill. */
  get outdated(): boolean {
    if (!this.helloSeen && !this.version) return false
    return compareVersions(this.version ?? '0.0.0', MIN_REMOTE_VERSION) < 0
  }

  get canTerminal(): boolean {
    return this.state === 'open' && this.tmux === true && !this.outdated
  }

  info(): RemoteInfo {
    return {
      name: this.name,
      machine: this.machine,
      state: this.state,
      version: this.version,
      tmux: this.tmux ?? false,
      outdated: this.outdated,
      canTerminal: this.canTerminal,
    }
  }

  /** Human hint that fits in a toast and a log line. No backticks: the G2 font lacks them. */
  updateHint(): string {
    return `run 'claudedeck update' on ${this.name} (cd ~/claudedeck && git pull --ff-only && sh scripts/bootstrap-bridge.sh)`
  }

  outdatedMessage(): string {
    return `${this.name} runs claudedeck ${this.version ?? '?'} (needs ${MIN_REMOTE_VERSION}+) - ${this.updateHint()}`
  }

  private prefix(id: string): string {
    return `${this.name}::${id}`
  }

  private strip(id: string): string {
    return id.slice(this.name.length + 2)
  }

  private connect(): void {
    if (this.stopped) return
    this.state = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 8000 })
    } catch (err) {
      this.lastError = (err as Error).message
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.on('open', () => {
      this.state = 'open'
      this.backoff = BACKOFF_MIN
      this.lastError = ''
      this.lastSeenAt = Date.now()
      this.startLiveness(ws)
      log(`remote ${this.name}: connected`)
      this.send({ type: 'hello', client: 'claudedeck-hub', protocol: PROTOCOL_VERSION })
      // Restore what the glasses were watching before the link dropped.
      if (this.subscribedId) this.send({ type: 'subscribe', sessionId: this.subscribedId })
      this.emit('sessions')
    })
    ws.on('message', data => {
      this.lastSeenAt = Date.now()
      let msg: ServerMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handle(msg)
    })
    ws.on('ping', () => (this.lastSeenAt = Date.now()))
    ws.on('pong', () => (this.lastSeenAt = Date.now()))
    ws.on('unexpected-response', (_req, res) => {
      // A 401 means the token in remotes[].url no longer matches — say so instead of "socket hang up".
      this.lastError = res.statusCode === 401 ? 'token rejected (re-run: claudedeck remote add <name> <url>)' : `http ${res.statusCode}`
    })
    ws.on('error', err => {
      if (!this.lastError) this.lastError = err.message
    })
    ws.on('close', () => {
      this.stopLiveness()
      const wasOpen = this.state === 'open'
      this.state = 'closed'
      this.sessions = []
      this.helloSeen = false
      this.failAll(`remote ${this.name} disconnected`)
      if (wasOpen) log(`remote ${this.name}: disconnected${this.lastError ? ` (${this.lastError})` : ''}`)
      this.emit('sessions')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, this.backoff)
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 1.7)
  }

  /**
   * Nothing protects the hub→remote leg otherwise: keepalive is never enabled
   * and a sleeping remote or a re-keyed Tailscale path leaves the socket
   * "open" for hours. Ping so a dead peer answers with an RST quickly, and
   * terminate on silence so the reconnect (with re-subscribe) happens before
   * the user's next tap instead of on it.
   */
  private startLiveness(ws: WebSocket): void {
    this.stopLiveness()
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, PING_MS)
    this.pingTimer.unref()
    this.stallTimer = setInterval(() => {
      if (Date.now() - this.lastSeenAt > STALL_MS) {
        this.lastError = 'stalled (no traffic from the remote)'
        ws.terminate()
      }
    }, 10_000)
    this.stallTimer.unref()
  }

  private stopLiveness(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.pingTimer = undefined
    this.stallTimer = undefined
  }

  private failAll(message: string): void {
    this.pending.splice(0).forEach(p => p.settle({ type: 'ack', of: p.of, ok: false, message }))
    this.screenWaiters.splice(0).forEach(w => w.reject(new Error(message)))
  }

  /** The remote's `error` reply belongs to whichever request went out first. Returns false when nothing was waiting. */
  private failOldest(message: string): boolean {
    const p = this.pending[0]
    const w = this.screenWaiters[0]
    if (p && (!w || p.at <= w.at)) {
      this.pending.shift()
      p.settle({ type: 'ack', of: p.of, ok: false, message: `${this.name}: ${message}` })
      return true
    }
    if (w) {
      this.screenWaiters.shift()
      w.reject(new Error(`${this.name}: ${message}`))
      return true
    }
    return false
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello': {
        // Keep the name the user gave this remote as the label (the remote's
        // own hostname is often less meaningful, e.g. "tb5k" for studiom3).
        this.machine = this.name
        this.host = msg.machine
        this.version = msg.version
        this.protocol = msg.protocol
        this.tmux = msg.tmux
        this.helloSeen = true
        log(
          `remote ${this.name}: ${msg.machine} claudedeck ${msg.version ?? '?'} protocol ${msg.protocol ?? '?'} tmux=${msg.tmux} (hub ${VERSION})` +
            (this.outdated ? ` - OUTDATED: terminals/ctrl-c/kill need ${MIN_REMOTE_VERSION}+; ${this.updateHint()}` : ''),
        )
        if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) log(`remote ${this.name}: protocol ${msg.protocol} differs from hub ${PROTOCOL_VERSION}`)
        // Capability info travels with the sessions broadcast.
        this.emit('sessions')
        break
      }
      case 'sessions':
        this.sessions = msg.sessions.map(s => ({ ...s, id: this.prefix(s.id), machine: this.machine }))
        this.emit('sessions')
        break
      case 'session': {
        const d: SessionDetail = { ...msg.session, id: this.prefix(msg.session.id), machine: this.machine }
        this.emit('detail', d)
        break
      }
      case 'screen': {
        const w = this.screenWaiters.shift()
        if (w) w.resolve(msg.lines)
        break
      }
      case 'ack': {
        // A new terminal's id travels in the ack; namespace it like the sessions.
        const a: AckMsg = msg.of === 'terminal_new' && msg.ok && msg.message ? { ...msg, message: this.prefix(msg.message) } : msg
        const i = this.pending.findIndex(p => p.of === msg.of)
        if (i >= 0) this.pending.splice(i, 1)[0].settle(a)
        else this.emit('ack', a)
        break
      }
      case 'error':
        this.emit('error', msg.message, this.failOldest(msg.message))
        break
      default:
        break
    }
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    // A stalled link is about to be terminated; writes into it only vanish.
    if (this.lastSeenAt && Date.now() - this.lastSeenAt > STALL_MS) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Forward a session-addressed client message, translating the id. */
  forward(msg: ClientMessage & { sessionId: string }): boolean {
    const m = { ...msg, sessionId: this.strip(msg.sessionId) } as ClientMessage
    // Record before sending: a write into a half-dead socket is replayed after the reconnect.
    if (m.type === 'subscribe') this.subscribedId = m.sessionId
    return this.send(m)
  }

  unsubscribe(): void {
    this.subscribedId = undefined
    this.send({ type: 'unsubscribe' })
  }

  /** Send and wait for the matching ack; never rejects — timeouts and disconnects become `ok:false` acks. */
  request(msg: ClientMessage, of: string, timeoutMs = REQUEST_MS): Promise<AckMsg> {
    return new Promise(resolve => {
      const fail = (message: string): AckMsg => ({ type: 'ack', of, ok: false, message })
      if (!this.send(msg)) return resolve(fail(`${this.name} is not connected${this.lastError ? ` (${this.lastError})` : ''}`))
      const entry: Pending = {
        of,
        at: Date.now(),
        settle: a => {
          clearTimeout(timer)
          resolve(a)
        },
      }
      const timer = setTimeout(() => {
        this.pending = this.pending.filter(p => p !== entry)
        const why = this.outdated ? this.outdatedMessage() : `claudedeck ${this.version ?? 'unknown'} - it may not understand '${of}'; ${this.updateHint()}`
        resolve(fail(`${this.name} did not answer ${of} in ${Math.round(timeoutMs / 1000)} s (${why})`))
      }, timeoutMs)
      this.pending.push(entry)
    })
  }

  /** `request` for a session-addressed message (id translated). */
  forwardRequest(msg: ClientMessage & { sessionId: string }, of: string, timeoutMs = REQUEST_MS): Promise<AckMsg> {
    return this.request({ ...msg, sessionId: this.strip(msg.sessionId) } as ClientMessage, of, timeoutMs)
  }

  screen(sessionId: string, lines: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: 'screen', sessionId: this.strip(sessionId), lines })) return reject(new Error(`${this.name} is not connected`))
      const w: ScreenWaiter = {
        at: Date.now(),
        resolve: l => {
          clearTimeout(timer)
          resolve(l)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      }
      const timer = setTimeout(() => {
        this.screenWaiters = this.screenWaiters.filter(x => x !== w)
        reject(new Error(`${this.name} did not answer screen in ${Math.round(SCREEN_MS / 1000)} s`))
      }, SCREEN_MS)
      this.screenWaiters.push(w)
    })
  }
}
