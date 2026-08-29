import type { ClientMessage, RemoteInfo, ServerMessage, SessionAction, SessionDetail, SessionSummary } from '@claudedeck/shared'
import { PROTOCOL_VERSION } from '@claudedeck/shared'
import { Emitter } from '../util/emitter'

export type ConnState = 'connecting' | 'open' | 'closed'

export interface BridgeEntry {
  id: string
  name: string
  /** Full WS URL including `?token=`. */
  url: string
}

export interface ClientEvents {
  state: ConnState
  sessions: SessionSummary[]
  detail: SessionDetail
  transcript: { sessionId?: string; text: string; raw?: string; seconds: number }
  ack: { of: string; ok: boolean; message?: string }
  error: string
}

const BACKOFF_MIN = 1000
const BACKOFF_MAX = 15000
const CONNECT_TIMEOUT_MS = 8000
const STALL_MS = 45_000 // pings go out every 25s; silence beyond this means the socket is dead

/** One WebSocket to one bridge daemon, with auto-reconnect. */
export class BridgeClient extends Emitter<ClientEvents> {
  state: ConnState = 'closed'
  machine = ''
  sttAvailable = false
  tmux = false
  sessions: SessionSummary[] = []
  /** Bridges this one relays (hub mode), with what each can do. */
  remotes: RemoteInfo[] = []
  /** True once the bridge said what it relays — hubs older than 0.4.0 never do. */
  remotesKnown = false
  lastError = ''

  private ws: WebSocket | null = null
  private backoff = BACKOFF_MIN
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private closedByUser = false
  private subscribed: string | null = null
  private screenWaiters: Array<{ ok: (lines: string[]) => void; fail: (err: Error) => void }> = []
  private terminalWaiters: Array<(a: { ok: boolean; message?: string }) => void> = []
  private lastMessageAt = 0
  private stallTimer: number | null = null

  constructor(public readonly entry: BridgeEntry) {
    super()
    this.machine = entry.name
  }

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  close(): void {
    this.closedByUser = true
    this.clearTimers()
    this.ws?.close()
    this.ws = null
    this.setState('closed')
  }

  /** Force a fresh socket (e.g. after the phone returns to the foreground). */
  kick(): void {
    if (this.state === 'open') {
      this.send({ type: 'ping' })
      return
    }
    this.backoff = BACKOFF_MIN
    this.clearTimers()
    this.open()
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.entry.url)
    } catch (err) {
      this.lastError = (err as Error).message
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // Mobile TCP stacks can sit in CONNECTING for a minute on an unroutable
    // address; fail fast so the glasses show a real "closed" state instead.
    const connectTimer = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        this.lastError = 'connect timeout (unreachable?)'
        ws.close()
      }
    }, CONNECT_TIMEOUT_MS)
    ws.onopen = () => {
      clearTimeout(connectTimer)
      this.backoff = BACKOFF_MIN
      this.setState('open')
      this.send({ type: 'hello', client: 'claudedeck-app', protocol: PROTOCOL_VERSION })
      if (this.subscribed) this.send({ type: 'subscribe', sessionId: this.subscribed })
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000)
      this.lastMessageAt = Date.now()
      this.stallTimer = window.setInterval(() => {
        if (Date.now() - this.lastMessageAt > STALL_MS) {
          this.lastError = 'no reply from bridge (stalled socket)'
          ws.close()
        }
      }, 10_000)
    }
    ws.onmessage = ev => {
      this.lastMessageAt = Date.now()
      if (typeof ev.data !== 'string') return
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      this.handle(msg)
    }
    ws.onerror = () => {
      this.lastError = 'socket error'
    }
    ws.onclose = () => {
      clearTimeout(connectTimer)
      if (this.ws === ws) this.ws = null
      this.clearTimers()
      this.failWaiters('disconnected')
      this.setState('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, this.backoff)
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 1.8)
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
  }

  private setState(s: ConnState): void {
    if (this.state === s) return
    this.state = s
    if (s !== 'open') {
      this.sessions = []
      this.remotes = []
      this.emit('sessions', this.sessions)
    }
    this.emit('state', s)
  }

  /** Settle every in-flight screen/terminal request with a reason instead of letting it time out. */
  private failWaiters(message: string): void {
    this.screenWaiters.splice(0).forEach(w => w.fail(new Error(message)))
    this.terminalWaiters.splice(0).forEach(fn => fn({ ok: false, message }))
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
        this.machine = msg.machine || this.entry.name
        this.sttAvailable = msg.stt.available
        this.tmux = msg.tmux
        this.noteRemotes(msg.remotes)
        break
      case 'sessions':
        // Relayed sessions already carry their origin machine; keep it.
        this.sessions = msg.sessions.map(s => ({ ...s, machine: s.machine || this.machine }))
        this.noteRemotes(msg.remotes)
        this.emit('sessions', this.sessions)
        break
      case 'session':
        this.emit('detail', { ...msg.session, machine: msg.session.machine || this.machine })
        break
      case 'screen':
        this.screenWaiters.splice(0).forEach(w => w.ok(msg.lines))
        break
      case 'transcript':
        this.emit('transcript', { sessionId: msg.sessionId, text: msg.text, raw: msg.raw, seconds: msg.seconds })
        break
      case 'ack':
        if (msg.of === 'terminal_new') this.terminalWaiters.splice(0).forEach(fn => fn({ ok: msg.ok, message: msg.message }))
        this.emit('ack', { of: msg.of, ok: msg.ok, message: msg.message })
        break
      case 'error':
        this.lastError = msg.message
        // The bridge answers a failed screen (or, on old hubs, a failed forward)
        // with an error rather than an ack: hand the reason to whoever is
        // waiting instead of showing "timeout" 6 s later.
        this.failWaiters(msg.message)
        this.emit('error', msg.message)
        break
      case 'pong':
        break
    }
  }

  private noteRemotes(remotes?: RemoteInfo[]): void {
    if (!remotes) return
    this.remotes = remotes
    this.remotesKnown = true
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  sendBinary(buf: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf)
  }

  subscribe(sessionId: string | null): void {
    this.subscribed = sessionId
    if (sessionId) this.send({ type: 'subscribe', sessionId })
    else this.send({ type: 'unsubscribe' })
  }

  action(sessionId: string, action: SessionAction, keys?: string): boolean {
    return this.send({ type: 'action', sessionId, action, keys })
  }

  sendText(sessionId: string, text: string, enter = true): boolean {
    return this.send({ type: 'send', sessionId, text, enter })
  }

  screen(sessionId: string, lines = 60): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: 'screen', sessionId, lines })) return reject(new Error('not connected'))
      const timer = window.setTimeout(() => {
        this.screenWaiters = this.screenWaiters.filter(w => w !== waiter)
        reject(new Error('screen timeout'))
      }, 6000)
      const waiter = {
        ok: (lines: string[]) => {
          clearTimeout(timer)
          resolve(lines)
        },
        fail: (err: Error) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      this.screenWaiters.push(waiter)
    })
  }

  /** Open a detached tmux session on this bridge (or a relayed `machine`); resolves to the new session id. */
  newTerminal(machine?: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: 'terminal_new', machine, cwd })) return reject(new Error('not connected'))
      const timer = window.setTimeout(() => {
        this.terminalWaiters = this.terminalWaiters.filter(fn => fn !== done)
        reject(new Error('bridge did not answer'))
      }, 10_000)
      const done = (a: { ok: boolean; message?: string }) => {
        clearTimeout(timer)
        if (a.ok && a.message) resolve(a.message)
        else reject(new Error(a.message ?? 'failed'))
      }
      this.terminalWaiters.push(done)
    })
  }

  audioStart(sessionId?: string): boolean {
    return this.send({ type: 'audio_start', sessionId, sampleRate: 16000 })
  }
  audioStop(sessionId?: string): boolean {
    return this.send({ type: 'audio_stop', sessionId })
  }
  audioCancel(): boolean {
    return this.send({ type: 'audio_cancel' })
  }
}
