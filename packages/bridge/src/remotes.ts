import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { ClientMessage, ServerMessage, SessionDetail, SessionSummary } from '@claudedeck/shared'
import { PROTOCOL_VERSION } from '@claudedeck/shared'
import { log } from './log.js'

const BACKOFF_MIN = 1500
const BACKOFF_MAX = 20000

/**
 * A client connection from this bridge (the hub) to another bridge. Remote
 * session ids are namespaced `<name>::<id>` so the phone can address them
 * through the hub without knowing where they live.
 */
export class RemoteBridge extends EventEmitter {
  machine: string
  state: 'connecting' | 'open' | 'closed' = 'closed'
  sessions: SessionSummary[] = []
  lastError = ''
  private ws?: WebSocket
  private timer?: NodeJS.Timeout
  private backoff = BACKOFF_MIN
  private stopped = false
  private screenWaiters: Array<(lines: string[]) => void> = []

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
    this.ws?.close()
  }

  owns(id: string): boolean {
    return id.startsWith(`${this.name}::`)
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
      log(`remote ${this.name}: connected`)
      this.send({ type: 'hello', client: 'claudedeck-hub', protocol: PROTOCOL_VERSION })
    })
    ws.on('message', data => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handle(msg)
    })
    ws.on('error', err => {
      this.lastError = err.message
    })
    ws.on('close', () => {
      const wasOpen = this.state === 'open'
      this.state = 'closed'
      this.sessions = []
      if (wasOpen) log(`remote ${this.name}: disconnected`)
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

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
        // Keep the name the user gave this remote as the label (the remote's
        // own hostname is often less meaningful, e.g. "tb5k" for studiom3).
        this.machine = this.name
        break
      case 'sessions':
        this.sessions = msg.sessions.map(s => ({ ...s, id: this.prefix(s.id), machine: this.machine }))
        this.emit('sessions')
        break
      case 'session': {
        const d: SessionDetail = { ...msg.session, id: this.prefix(msg.session.id), machine: this.machine }
        this.emit('detail', d)
        break
      }
      case 'screen':
        this.screenWaiters.splice(0).forEach(fn => fn(msg.lines))
        break
      case 'ack':
        // A new terminal's id travels in the ack; namespace it like the sessions.
        if (msg.of === 'terminal_new' && msg.ok && msg.message) this.emit('ack', { ...msg, message: this.prefix(msg.message) })
        else this.emit('ack', msg)
        break
      case 'error':
        this.lastError = msg.message
        this.emit('error', msg.message)
        break
      default:
        break
    }
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Forward a session-addressed client message, translating the id. */
  forward(msg: ClientMessage & { sessionId: string }): boolean {
    return this.send({ ...msg, sessionId: this.strip(msg.sessionId) } as ClientMessage)
  }

  screen(sessionId: string, lines: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: 'screen', sessionId: this.strip(sessionId), lines })) return reject(new Error(`remote ${this.name} not connected`))
      const timer = setTimeout(() => {
        this.screenWaiters = this.screenWaiters.filter(fn => fn !== done)
        reject(new Error('remote screen timeout'))
      }, 8000)
      const done = (l: string[]) => {
        clearTimeout(timer)
        resolve(l)
      }
      this.screenWaiters.push(done)
    })
  }
}
