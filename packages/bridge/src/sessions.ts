import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionDetail, SessionStatus, SessionSummary, ToolRef } from '@claudedeck/shared'
import type { BridgeConfig } from './config.js'
import { capturePane, claudePidAmong, listPanes, paneRunsClaude, pidAlive, type TmuxPane } from './tmux.js'
import { findTranscriptForCwd, parseTranscript, summarizeToolInput, type TranscriptInfo } from './transcript.js'
import { log } from './log.js'

export interface HookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  prompt?: string
  tool_name?: string
  tool_input?: unknown
  notification_type?: string
  message?: string
  title?: string
  reason?: string
  source?: string
  error?: string
  error_type?: string
  stop_hook_active?: boolean
  agent_type?: string
  agent_id?: string
  new_cwd?: string
  [k: string]: unknown
}

export interface StatuslinePayload {
  session_id?: string
  session_name?: string
  transcript_path?: string
  cwd?: string
  workspace?: { current_dir?: string; project_dir?: string }
  model?: { id?: string; display_name?: string }
  context_window?: { used_percentage?: number | null }
  [k: string]: unknown
}

interface Session extends SessionDetail {
  transcriptPath?: string
  transcriptMtime?: number
  customName?: string
  /** Original project dir (statusline workspace.project_dir); cwd may drift with `cd`. */
  projectDir?: string
  endedAt?: number
  /** Last few pane rows, used for permission heuristics. */
  screenTail?: string[]
  /** The claude CLI process, when a hook/statusline told us its ancestry. */
  pid?: number
  /** Last time a hook or statusline post arrived for this session. */
  lastSeen?: number
  /** Last time an actual hook event (not statusline) arrived — hooks are authoritative. */
  lastHookAt?: number
  /** Consecutive scans in which the pane no longer runs claude. */
  paneMisses?: number
}

type Meta = { tmuxPane?: string; ancestors?: number[] }

const ENDED_TTL_MS = 3 * 60 * 1000
/** Sessions known only from statusline posts: gone this long without a post → assume exited. */
const SILENT_MS = 3 * 60 * 1000
/** Transcript touched more recently than this → a turn is probably in progress. */
const TRANSCRIPT_ACTIVE_MS = 25 * 1000

const PERMISSION_RX = /(Do you want to (proceed|make this edit|run|allow|create|delete|continue)|Allow .* to |Yes, and don't ask again|❯ 1\. Yes|\(esc\)\s*$|Waiting for your (approval|answer)|Would you like to)/im
// Only the spinner line is a reliable "turn in progress" marker; tool
// output glyphs like ⏺ stay on screen long after the turn ends.
const WORKING_RX = /esc to interrupt/i

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, Session>()
  private scanTimer?: NodeJS.Timeout
  private changed = new Set<string>()
  private flushTimer?: NodeJS.Timeout
  tmuxAvailable = false

  constructor(private cfg: BridgeConfig) {
    super()
  }

  start(): void {
    void this.scanTmux()
    this.scanTimer = setInterval(() => void this.scanTmux(), this.cfg.tmuxScanIntervalMs)
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer)
  }

  // ───────────────────────── queries ─────────────────────────

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(s => this.toSummary(s))
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** Raw internal state for /debug (loopback only). */
  dump(): Record<string, unknown>[] {
    return [...this.sessions.values()].map(s => ({
      id: s.id, name: s.name, status: s.status, source: s.source, pane: s.pane, pid: s.pid,
      lastSeenAgo: s.lastSeen ? Math.round((Date.now() - s.lastSeen) / 1000) : null,
      lastHookAgo: s.lastHookAt ? Math.round((Date.now() - s.lastHookAt) / 1000) : null,
      paneMisses: s.paneMisses, endedAt: s.endedAt, transcript: s.transcriptPath?.split('/').pop(),
    }))
  }

  detail(id: string): SessionDetail | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    this.refreshTranscript(s)
    return this.toDetail(s)
  }

  private toSummary(s: Session): SessionSummary {
    return {
      id: s.id,
      machine: this.cfg.machine,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      statusSince: s.statusSince,
      lastActivity: s.lastActivity,
      source: s.source,
      pane: s.pane,
      model: s.model,
      contextPct: s.contextPct,
      tool: s.tool,
      notice: s.notice,
      lastLine: s.lastLine,
      agents: s.agents,
    }
  }

  private toDetail(s: Session): SessionDetail {
    return { ...this.toSummary(s), lastAssistant: s.lastAssistant, lastUser: s.lastUser, lastAssistantAt: s.lastAssistantAt }
  }

  // ───────────────────────── mutation helpers ─────────────────────────

  private touch(s: Session, status?: SessionStatus): void {
    const now = Date.now()
    s.lastActivity = now
    if (status && status !== s.status) {
      s.status = status
      s.statusSince = now
    }
    this.markChanged(s.id)
  }

  private markChanged(id: string): void {
    this.changed.add(id)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const ids = [...this.changed]
      this.changed.clear()
      this.emit('change', ids)
    }, 120)
  }

  private upsert(id: string, seed: Partial<Session>): Session {
    let s = this.sessions.get(id)
    if (!s) {
      const cwd = seed.cwd ?? ''
      s = {
        id,
        machine: this.cfg.machine,
        name: seed.name ?? (cwd ? path.basename(cwd) : id.slice(0, 8)),
        cwd,
        status: 'unknown',
        statusSince: Date.now(),
        lastActivity: Date.now(),
        source: seed.source ?? 'hook',
        lastAssistant: '',
        lastUser: '',
        ...seed,
      }
      this.sessions.set(id, s)
    } else {
      Object.assign(s, seed)
    }
    return s
  }

  private setName(s: Session): void {
    const dir = s.projectDir || s.cwd
    const base = dir ? path.basename(dir) : s.id.slice(0, 8)
    // Project first so it survives truncation on a glasses row; title after.
    s.name = s.customName ? `${base} · ${s.customName}` : base
  }

  private refreshTranscript(s: Session, force = false): void {
    if (!s.transcriptPath) return
    let mtime: number
    try {
      mtime = fs.statSync(s.transcriptPath).mtimeMs
    } catch {
      return
    }
    if (!force && s.transcriptMtime === mtime) return
    s.transcriptMtime = mtime
    const info = parseTranscript(s.transcriptPath)
    if (!info) return
    this.applyTranscript(s, info)
  }

  private applyTranscript(s: Session, info: TranscriptInfo): void {
    if (info.lastAssistant) {
      s.lastAssistant = info.lastAssistant
      s.lastAssistantAt = info.lastAssistantAt
      s.lastLine = firstLine(info.lastAssistant)
    }
    if (info.lastUser) s.lastUser = info.lastUser
    if (info.model && !s.model) s.model = shortModel(info.model)
    if (info.title && !s.customName) {
      s.customName = info.title
      this.setName(s)
    }
    if (!s.cwd && info.cwd) {
      s.cwd = info.cwd
      this.setName(s)
    }
    // For tmux-discovered sessions the transcript is the only tool signal.
    if (s.source === 'tmux' && s.status !== 'needs_permission') {
      s.tool = info.pendingTool
    }
    // Sessions without hook events (started before the hooks were installed)
    // and without a pane: the transcript is the only status signal, so
    // re-derive on every refresh instead of once.
    if (s.source === 'hook' && !s.pane && !s.lastHookAt && s.status !== 'ended') {
      const active = (s.transcriptMtime ?? 0) > Date.now() - TRANSCRIPT_ACTIVE_MS
      if (info.pendingTool && active) {
        s.tool = info.pendingTool
        this.touch(s, 'working')
      } else if (active && s.status === 'working') {
        this.touch(s)
      } else {
        s.tool = undefined
        this.touch(s, 'idle')
      }
    }
    this.markChanged(s.id)
  }

  private notePid(s: Session, meta: Meta): void {
    s.lastSeen = Date.now()
    if (s.pid || !meta.ancestors?.length) return
    void claudePidAmong(meta.ancestors).then(pid => {
      if (pid) s.pid = pid
    })
  }

  // ───────────────────────── hooks ─────────────────────────

  applyHook(p: HookPayload, meta: Meta): void {
    const id = p.session_id
    if (!id) return
    const ev = p.hook_event_name ?? ''
    const s = this.upsert(id, {
      cwd: p.cwd,
      transcriptPath: p.transcript_path,
      source: 'hook',
    })
    s.lastHookAt = Date.now()
    this.notePid(s, meta)
    if (p.cwd && !s.cwd) s.cwd = p.cwd
    if (!s.name || s.name === id.slice(0, 8)) this.setName(s)
    if (meta.tmuxPane) s.pane = meta.tmuxPane
    // A synthetic tmux session for the same pane is now redundant.
    if (s.pane) this.dropTmuxDuplicate(s.pane, id)

    switch (ev) {
      case 'SessionStart':
        s.endedAt = undefined
        s.tool = undefined
        this.touch(s, p.source === 'resume' || p.source === 'startup' ? 'idle' : s.status === 'unknown' ? 'idle' : s.status)
        this.refreshTranscript(s, true)
        break
      case 'UserPromptSubmit':
        if (typeof p.prompt === 'string' && p.prompt.trim()) s.lastUser = p.prompt.trim()
        s.tool = undefined
        s.notice = undefined
        this.touch(s, 'working')
        break
      case 'PreToolUse':
        s.tool = toolRef(p)
        this.touch(s, 'working')
        break
      case 'PermissionRequest':
        s.tool = toolRef(p)
        this.touch(s, 'needs_permission')
        break
      case 'PermissionDenied':
        this.touch(s, 'working')
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (s.tool && s.tool.name === p.tool_name) s.tool = undefined
        this.touch(s, 'working')
        this.refreshTranscript(s)
        break
      case 'Notification': {
        const kind = (p.notification_type ?? '').toLowerCase()
        const msg = typeof p.message === 'string' ? p.message : ''
        if (kind === 'permission_prompt') {
          if (!s.tool && msg) s.tool = { name: 'permission', summary: msg }
          this.touch(s, 'needs_permission')
        } else if (kind === 'idle_prompt') {
          this.touch(s, s.status === 'needs_permission' ? s.status : 'idle')
        } else if (kind === 'agent_needs_input' || kind.startsWith('elicitation')) {
          s.notice = msg || 'needs your input'
          this.touch(s, 'needs_permission')
        } else {
          if (msg) s.notice = msg
          this.touch(s)
        }
        break
      }
      case 'SubagentStart':
        s.agents = (s.agents ?? 0) + 1
        this.touch(s, 'working')
        break
      case 'SubagentStop':
        s.agents = Math.max(0, (s.agents ?? 1) - 1)
        this.touch(s)
        break
      case 'PreCompact':
        this.touch(s, 'compacting')
        break
      case 'PostCompact':
        this.touch(s, 'working')
        break
      case 'Stop':
        s.tool = undefined
        s.agents = 0
        this.touch(s, 'idle')
        this.refreshTranscript(s, true)
        break
      case 'StopFailure':
        s.tool = undefined
        s.notice = p.error_type ? `API error: ${p.error_type}` : 'API error'
        this.touch(s, 'error')
        break
      case 'CwdChanged':
        if (typeof p.new_cwd === 'string') {
          s.cwd = p.new_cwd
          this.setName(s)
        }
        this.touch(s)
        break
      case 'SessionEnd':
        s.tool = undefined
        s.endedAt = Date.now()
        this.touch(s, 'ended')
        break
      default:
        this.touch(s)
    }
  }

  applyStatusline(p: StatuslinePayload, meta: Meta = {}): void {
    const id = p.session_id
    if (!id) return
    const isNew = !this.sessions.has(id)
    const s = this.upsert(id, { cwd: p.cwd, transcriptPath: p.transcript_path, source: 'hook' })
    this.notePid(s, meta)
    if (s.status === 'ended') {
      // It is posting again → it is alive after all (e.g. resumed).
      s.endedAt = undefined
      this.touch(s, 'unknown')
    }
    if (p.workspace?.project_dir && p.workspace.project_dir !== s.projectDir) {
      s.projectDir = p.workspace.project_dir
      this.setName(s)
    } else if (isNew) this.setName(s)
    if (meta.tmuxPane) {
      s.pane = meta.tmuxPane
      this.dropTmuxDuplicate(s.pane, id)
    }
    if (!s.transcriptPath && p.transcript_path) s.transcriptPath = p.transcript_path
    if (p.model?.display_name) s.model = shortModel(p.model.display_name)
    else if (p.model?.id) s.model = shortModel(p.model.id)
    const pct = p.context_window?.used_percentage
    if (typeof pct === 'number') s.contextPct = Math.round(pct)
    if (p.session_name && p.session_name !== s.customName) {
      s.customName = p.session_name
      this.setName(s)
    }
    this.refreshTranscript(s, isNew || s.status === 'unknown')
    this.markChanged(id)
  }

  // ───────────────────────── tmux discovery ─────────────────────────

  private dropTmuxDuplicate(pane: string, keepId: string): void {
    for (const [id, s] of this.sessions) {
      if (id !== keepId && s.source === 'tmux' && s.pane === pane) {
        this.sessions.delete(id)
        this.markChanged(id)
      }
    }
  }

  private async scanTmux(): Promise<void> {
    try {
      await this.scanTmuxInner()
    } catch (err) {
      const now = Date.now()
      if (now - this.lastScanErrorAt > 60_000) {
        this.lastScanErrorAt = now
        log(`tmux scan failed: ${(err as Error).message}`)
      }
    }
  }

  private lastScanErrorAt = 0

  private async scanTmuxInner(): Promise<void> {
    let panes: TmuxPane[] = []
    try {
      panes = await listPanes()
      this.tmuxAvailable = true
    } catch {
      this.tmuxAvailable = false
    }
    const claudePanes: TmuxPane[] = []
    for (const p of panes) {
      try {
        if (await paneRunsClaude(p)) claudePanes.push(p)
      } catch {
        /* ignore */
      }
    }
    const paneIds = new Set(claudePanes.map(p => p.id))
    const now = Date.now()

    // Attach panes to hook sessions that lack one (match by cwd when unique).
    for (const s of this.sessions.values()) {
      if (s.pane && !paneIds.has(s.pane)) {
        // The pane no longer runs claude (or is gone). Two consecutive misses
        // (the process table is cached) mean the session really exited.
        s.paneMisses = (s.paneMisses ?? 0) + 1
        if (s.paneMisses >= 3) {
          // With a known pid the process is authoritative: a pane miss only
          // means the pane went away (or a transient scan hiccup), not exit.
          const alive = s.pid !== undefined && pidAlive(s.pid)
          log(`session ${s.name} (${s.id.slice(0, 8)}): pane ${s.pane} no longer runs claude (claude panes: ${[...paneIds].join(',') || 'none'})${alive ? ', pid alive → pane dropped' : ' → ended'}`)
          s.pane = undefined
          if (!alive && s.source === 'hook' && s.status !== 'ended') {
            s.endedAt = now
            s.tool = undefined
            this.touch(s, 'ended')
          }
          this.markChanged(s.id)
        }
      } else if (s.pane) {
        s.paneMisses = 0
      }
      if (!s.pane && s.source === 'hook' && s.status !== 'ended') {
        const matches = claudePanes.filter(p => p.cwd === s.cwd && !this.paneClaimed(p.id))
        if (matches.length === 1) {
          s.pane = matches[0].id
          this.dropTmuxDuplicate(s.pane, s.id)
          this.markChanged(s.id)
        }
      }
    }

    // Create synthetic sessions for panes nobody claims. Their transcript is a
    // guess (newest file for that cwd not owned by a hook session), re-checked
    // every scan so a later hook/statusline registration can reclaim it.
    const hookTranscripts = new Set<string>()
    for (const s of this.sessions.values()) if (s.source === 'hook' && s.transcriptPath) hookTranscripts.add(s.transcriptPath)
    for (const p of claudePanes) {
      if (this.paneClaimed(p.id)) continue
      const id = `tmux:${p.id}`
      const known = new Set([...this.sessions.keys()])
      const transcript = findTranscriptForCwd(this.cfg.claudeConfigDir, p.cwd, known) ?? undefined
      const existing = this.sessions.get(id)
      const seed: Partial<Session> = { cwd: p.cwd, pane: p.id, source: 'tmux' }
      if (!existing || !existing.transcriptPath || hookTranscripts.has(existing.transcriptPath)) {
        seed.transcriptPath = transcript && !hookTranscripts.has(transcript) ? transcript : undefined
        seed.transcriptMtime = undefined
        if (!seed.transcriptPath) {
          seed.lastAssistant = ''
          seed.lastLine = undefined
          seed.tool = undefined
        }
      }
      const s = this.upsert(id, seed)
      if (!existing) {
        this.setName(s)
        this.touch(s, 'idle')
      }
      this.refreshTranscript(s, !existing)
    }

    // Liveness + screen heuristics + housekeeping.
    for (const [id, s] of this.sessions) {
      if (s.status !== 'ended' && s.source === 'hook') {
        const processGone = s.pid !== undefined && !pidAlive(s.pid)
        const silent = s.pid === undefined && !s.pane && !!s.lastSeen && now - s.lastSeen > SILENT_MS
        if (processGone || silent) {
          log(`session ${s.name} (${s.id.slice(0, 8)}): ${processGone ? `pid ${s.pid} gone` : `silent for ${Math.round((now - (s.lastSeen ?? now)) / 1000)}s`} → ended`)
          s.endedAt = now
          s.tool = undefined
          s.pane = undefined
          this.touch(s, 'ended')
        }
      }
      if (s.status === 'ended' && s.endedAt && now - s.endedAt > (s.pid || s.paneMisses ? 20_000 : ENDED_TTL_MS)) {
        this.sessions.delete(id)
        this.markChanged(id)
        continue
      }
      if (s.source === 'tmux' && !s.pane) {
        this.sessions.delete(id)
        this.markChanged(id)
        continue
      }
      if (s.pane) await this.applyScreenHeuristics(s)
      if (s.source === 'tmux') this.refreshTranscript(s)
    }
    if (this.changed.size === 0 && now % 60000 < this.cfg.tmuxScanIntervalMs) {
      // periodic heartbeat so ages refresh on the glasses
      this.emit('change', [])
    }
  }

  private paneClaimed(paneId: string): boolean {
    for (const s of this.sessions.values()) if (s.pane === paneId && s.status !== 'ended') return true
    return false
  }

  private async applyScreenHeuristics(s: Session): Promise<void> {
    if (!s.pane) return
    let rows: string[]
    try {
      rows = await capturePane(s.pane, 25)
    } catch {
      return
    }
    s.screenTail = rows
    const tail = rows.slice(-14).join('\n')
    const permission = PERMISSION_RX.test(tail)
    const working = WORKING_RX.test(tail)
    if (permission && s.status !== 'needs_permission') {
      if (!s.tool) s.tool = { name: 'permission', summary: guessPermissionSummary(rows) }
      this.touch(s, 'needs_permission')
    } else if (!permission && s.status === 'needs_permission' && s.source === 'tmux') {
      this.touch(s, working ? 'working' : 'idle')
    } else if (s.source === 'tmux' && s.status !== 'needs_permission') {
      const next: SessionStatus = working ? 'working' : 'idle'
      if (next !== s.status) this.touch(s, next)
    } else if (s.source === 'hook' && s.status === 'needs_permission' && !permission && Date.now() - s.statusSince > 8000) {
      // Hook said "needs permission" but the screen no longer shows a dialog
      // (user answered in the terminal). Fall back to working/idle.
      this.touch(s, working ? 'working' : 'idle')
    } else if (s.source === 'hook' && s.status === 'unknown') {
      // Known only from the statusline so far — the screen is our best signal.
      this.touch(s, working ? 'working' : 'idle')
    }
  }
}

function toolRef(p: HookPayload): ToolRef | undefined {
  if (!p.tool_name) return undefined
  return { name: p.tool_name, summary: summarizeToolInput(p.tool_name, p.tool_input) }
}

function firstLine(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, '[code]')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? ''
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

function shortModel(id: string): string {
  const m = id.match(/(fable|opus|sonnet|haiku|mythos)[- ]?(\d+(?:[.-]\d+)?)?/i)
  if (!m) return id.replace(/\s*\(.*?\)\s*/g, '').trim()
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  const ver = m[2]?.replace(/-/g, '.')
  const big = /1m/i.test(id) ? ' 1M' : ''
  return `${name}${ver ? ` ${ver}` : ''}${big}`
}

function guessPermissionSummary(rows: string[]): string {
  // Look upward from the dialog for the boxed tool line, e.g. "Bash command" / "Edit file".
  const text = rows.slice(-20).join('\n')
  const m = text.match(/(Bash command|Edit file|Write file|Create file|Read file|Fetch content|Web search|Agent)[^\n]*\n?\s*([^\n]{0,100})/)
  if (m) return (m[1] + ': ' + m[2]).trim().slice(0, 100)
  const q = text.match(/Do you want to [^\n?]*\??/)
  return q ? q[0].slice(0, 100) : 'approval requested'
}
