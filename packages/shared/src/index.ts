/**
 * ClaudeDeck wire protocol — shared between the bridge daemon (Node) and the
 * Even Hub plugin (phone WebView). Keep this file dependency-free.
 */

export const PROTOCOL_VERSION = 1

/** Lifecycle state of one Claude Code session, as best the bridge can tell. */
export type SessionStatus =
  | 'working' // a turn is in progress (prompt submitted / tools running)
  | 'needs_permission' // a permission dialog is waiting for a human
  | 'idle' // Claude finished; waiting for the next prompt
  | 'compacting' // context compaction in progress
  | 'error' // last turn ended with an API error
  | 'ended' // SessionEnd fired
  | 'unknown' // discovered via tmux only, no hook data yet

export type SessionSource = 'hook' | 'tmux'

/** A Claude Code session, or a plain tmux pane exposed as a terminal. */
export type SessionKind = 'claude' | 'shell'

export interface ToolRef {
  name: string
  /** Short human summary, e.g. `npm test` or `src/main.ts`. */
  summary: string
}

export interface SessionSummary {
  /** Claude session_id (uuid) or a synthetic `tmux:%N` id. */
  id: string
  /** Bridge machine name — filled by the app when merging multiple bridges. */
  machine: string
  /** Display name: basename of cwd (+ custom name when known). */
  name: string
  cwd: string
  status: SessionStatus
  /** Epoch ms of the last status transition. */
  statusSince: number
  /** Epoch ms of the last hook/transcript activity. */
  lastActivity: number
  source: SessionSource
  /** `shell` = a tmux pane not running Claude Code (default `claude`). */
  kind?: SessionKind
  /** Foreground command in the pane (terminal rows), e.g. `zsh`, `vim`, `npm`. */
  command?: string
  /** tmux pane id (`%3`) when the session is reachable for input. */
  pane?: string
  /** Model display name when known (from statusline / transcript). */
  model?: string
  /** Context window used percentage when known (from statusline). */
  contextPct?: number
  /** Tool currently executing (working) or awaiting approval (needs_permission). */
  tool?: ToolRef
  /** Most recent Notification message, if any. */
  notice?: string
  /** First ~120 chars of the last assistant text — enough for a list row. */
  lastLine?: string
  /** Number of subagents currently running. */
  agents?: number
}

export interface SessionDetail extends SessionSummary {
  /** Full text of the last assistant message (may be long; app paginates). */
  lastAssistant: string
  /** Last user prompt text. */
  lastUser: string
  /** Epoch ms of the last assistant message. */
  lastAssistantAt?: number
}

/** Actions the glasses can trigger on a session. */
export type SessionAction =
  | 'approve' // y
  | 'approve_all' // 2 (yes, don't ask again for similar)
  | 'deny' // Escape
  | 'interrupt' // Escape
  | 'continue' // types "continue" + Enter
  | 'cycle_mode' // Shift+Tab
  | 'enter'
  | 'ctrl_c' // C-c
  | 'kill' // kill the tmux pane (terminal rows)
  | 'keys' // raw tmux key names in `keys`

export type ClientMessage =
  | { type: 'hello'; client: string; protocol: number }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'action'; sessionId: string; action: SessionAction; keys?: string }
  | { type: 'send'; sessionId: string; text: string; enter?: boolean }
  | { type: 'screen'; sessionId: string; lines?: number }
  /** Open a detached tmux session; the ack's `message` carries the new session id. `machine` targets a relayed bridge. */
  | { type: 'terminal_new'; machine?: string; cwd?: string }
  | { type: 'audio_start'; sessionId?: string; sampleRate?: number }
  | { type: 'audio_stop'; sessionId?: string }
  | { type: 'audio_cancel' }
  | { type: 'ping' }

export type ServerMessage =
  | {
      type: 'hello'
      machine: string
      version: string
      protocol: number
      stt: { available: boolean; backend: string }
      tmux: boolean
    }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session'; session: SessionDetail }
  | { type: 'screen'; sessionId: string; lines: string[] }
  | { type: 'ack'; of: string; ok: boolean; message?: string }
  /** `raw` = what was heard, when `text` was transformed into a shell command. */
  | { type: 'transcript'; sessionId?: string; text: string; raw?: string; seconds: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'WORKING',
  needs_permission: 'NEEDS OK',
  idle: 'IDLE',
  compacting: 'COMPACT',
  error: 'ERROR',
  ended: 'ENDED',
  unknown: 'UNKNOWN',
}

/** Single-character status glyph. ASCII only — the G2 font drops unknown glyphs. */
export const STATUS_GLYPH: Record<SessionStatus, string> = {
  working: '>',
  needs_permission: '?',
  idle: '-',
  compacting: '~',
  error: '!',
  ended: 'x',
  unknown: ' ',
}

/** Sort: needs attention first, then working, then idle, then the rest; newest activity first. */
export const STATUS_RANK: Record<SessionStatus, number> = {
  needs_permission: 0,
  error: 1,
  working: 2,
  compacting: 2,
  idle: 3,
  unknown: 4,
  ended: 5,
}

export function sortSessions<T extends SessionSummary>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    // Claude sessions first, plain terminals after them.
    const k = (a.kind === 'shell' ? 1 : 0) - (b.kind === 'shell' ? 1 : 0)
    if (k !== 0) return k
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (r !== 0) return r
    return b.lastActivity - a.lastActivity
  })
}

/** Bridge names sessions `project · title`; split them back for compact rows. */
export function splitName(name: string): { project: string; title: string } {
  const i = name.indexOf(' · ')
  if (i < 0) return { project: name, title: '' }
  return { project: name.slice(0, i), title: name.slice(i + 3) }
}

export function formatAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
