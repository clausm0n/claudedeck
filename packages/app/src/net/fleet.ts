import type { RemoteInfo, SessionAction, SessionDetail, SessionSummary } from '@claudedeck/shared'
import { sortSessions } from '@claudedeck/shared'
import { Emitter } from '../util/emitter'
import { BridgeClient, type BridgeEntry, type ConnState } from './client'

/** A session plus the bridge it lives on. `key` is unique across the fleet. */
export interface FleetSession extends SessionSummary {
  key: string
  bridgeId: string
}

export interface FleetDetail extends SessionDetail {
  key: string
  bridgeId: string
}

/** Somewhere a new terminal can be opened: a bridge, or a machine it relays. */
export interface TerminalTarget {
  bridgeId: string
  machine: string
}

export interface FleetEvents {
  sessions: FleetSession[]
  bridges: BridgeClient[]
  detail: FleetDetail
  transcript: { key?: string; text: string; raw?: string; seconds: number }
  ack: { bridgeId: string; of: string; ok: boolean; message?: string }
  /** A bridge answered the current subscription with an error (session gone, remote unreachable). */
  detailError: { key: string; message: string }
  log: string
}

/** Manages every configured bridge and merges their sessions into one list. */
export class Fleet extends Emitter<FleetEvents> {
  clients = new Map<string, BridgeClient>()
  sessions: FleetSession[] = []
  private subscribedKey: string | null = null
  private emitTimer: number | null = null

  configure(entries: BridgeEntry[]): void {
    const wanted = new Map(entries.map(e => [e.id, e]))
    for (const [id, c] of this.clients) {
      const e = wanted.get(id)
      if (!e || e.url !== c.entry.url) {
        c.close()
        this.clients.delete(id)
      }
    }
    for (const e of entries) {
      if (this.clients.has(e.id)) continue
      const c = new BridgeClient(e)
      c.on('state', (s: ConnState) => {
        this.emit('log', `${e.name}: ${s}${s === 'closed' && c.lastError ? ` (${c.lastError})` : ''}`)
        this.emit('bridges', [...this.clients.values()])
        this.scheduleSessions()
      })
      c.on('sessions', () => this.scheduleSessions())
      c.on('detail', d => {
        const key = `${e.id}/${d.id}`
        if (key === this.subscribedKey) this.emit('detail', { ...d, key, bridgeId: e.id })
      })
      c.on('transcript', t => this.emit('transcript', { key: t.sessionId ? `${e.id}/${t.sessionId}` : undefined, text: t.text, raw: t.raw, seconds: t.seconds }))
      c.on('ack', a => this.emit('ack', { bridgeId: e.id, ...a }))
      c.on('error', m => {
        this.emit('log', `${e.name}: ${m}`)
        if (this.subscribedKey?.startsWith(`${e.id}/`)) this.emit('detailError', { key: this.subscribedKey, message: m })
      })
      this.clients.set(e.id, c)
      c.connect()
    }
    this.emit('bridges', [...this.clients.values()])
    this.scheduleSessions()
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close()
  }

  /** Nudge every socket — used on foreground enter. */
  kickAll(): void {
    for (const c of this.clients.values()) c.kick()
  }

  private scheduleSessions(): void {
    if (this.emitTimer !== null) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null
      const merged: FleetSession[] = []
      for (const [id, c] of this.clients) {
        for (const s of c.sessions) merged.push({ ...s, key: `${id}/${s.id}`, bridgeId: id })
      }
      this.sessions = sortSessions(merged)
      this.emit('sessions', this.sessions)
    }, 100)
  }

  get(key: string): FleetSession | undefined {
    return this.sessions.find(s => s.key === key)
  }

  clientFor(key: string): BridgeClient | undefined {
    const bridgeId = key.split('/')[0]
    return this.clients.get(bridgeId)
  }

  private sessionId(key: string): string {
    return key.slice(key.indexOf('/') + 1)
  }

  subscribe(key: string | null): void {
    if (this.subscribedKey && this.subscribedKey !== key) {
      this.clientFor(this.subscribedKey)?.subscribe(null)
    }
    this.subscribedKey = key
    if (key) this.clientFor(key)?.subscribe(this.sessionId(key))
  }

  action(key: string, action: SessionAction, keys?: string): boolean {
    return this.clientFor(key)?.action(this.sessionId(key), action, keys) ?? false
  }

  sendText(key: string, text: string, enter = true): boolean {
    return this.clientFor(key)?.sendText(this.sessionId(key), text, enter) ?? false
  }

  screen(key: string, lines = 60): Promise<string[]> {
    const c = this.clientFor(key)
    if (!c) return Promise.reject(new Error('no bridge'))
    return c.screen(this.sessionId(key), lines)
  }

  audioStart(key: string): boolean {
    return this.clientFor(key)?.audioStart(this.sessionId(key)) ?? false
  }
  audioStop(key: string): boolean {
    return this.clientFor(key)?.audioStop(this.sessionId(key)) ?? false
  }
  audioCancel(key: string): void {
    this.clientFor(key)?.audioCancel()
  }
  audioChunk(key: string, pcm: Uint8Array): void {
    this.clientFor(key)?.sendBinary(pcm)
  }
  sttAvailable(key: string): boolean {
    return this.clientFor(key)?.sttAvailable ?? false
  }

  /** Every open bridge with tmux, plus every relayed machine that can actually open a terminal. */
  terminalTargets(): TerminalTarget[] {
    const out: TerminalTarget[] = []
    const seen = new Set<string>()
    const add = (bridgeId: string, machine: string) => {
      const k = `${bridgeId}/${machine}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ bridgeId, machine })
    }
    for (const [id, c] of this.clients) {
      if (c.state !== 'open') continue
      if (c.remotesKnown) {
        if (c.tmux) add(id, c.machine)
        for (const r of c.remotes) if (r.canTerminal) add(id, r.machine)
      } else if (c.tmux) {
        // Hub older than 0.4.0: it never says what it relays, so infer machines
        // from the session rows (an idle remote then has no row, and an old
        // remote gets one it cannot honour).
        for (const m of [c.machine, ...c.sessions.map(s => s.machine)]) add(id, m)
      }
    }
    return out
  }

  /** Relayed bridges too old for terminals / ctrl-c / kill, so the list can say why those are missing. */
  outdatedRemotes(): Array<{ bridgeId: string; remote: RemoteInfo }> {
    const out: Array<{ bridgeId: string; remote: RemoteInfo }> = []
    for (const [id, c] of this.clients) {
      if (c.state !== 'open') continue
      for (const r of c.remotes) if (r.state === 'open' && r.outdated) out.push({ bridgeId: id, remote: r })
    }
    return out
  }

  /** Create a terminal on a target; resolves to the new fleet key. */
  async newTerminal(t: TerminalTarget, cwd?: string): Promise<string> {
    const c = this.clients.get(t.bridgeId)
    if (!c) throw new Error('no bridge')
    const id = await c.newTerminal(t.machine === c.machine ? undefined : t.machine, cwd)
    return `${t.bridgeId}/${id}`
  }

  /** True when sessions come from more than one machine (local or relayed). */
  get multiMachine(): boolean {
    const set = new Set(this.sessions.map(s => s.machine))
    return set.size > 1
  }

  get anyOpen(): boolean {
    for (const c of this.clients.values()) if (c.state === 'open') return true
    return false
  }
}
