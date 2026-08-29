import fs from 'node:fs'
import path from 'node:path'
import { projectSlug } from './transcript.js'

/**
 * Claude Code (>= 2.1.x) keeps one JSON per live process in
 * `~/.claude/sessions/<pid>.json`: pid → session id, cwd, tmux pane, name and
 * a coarse status. It is unlinked on clean exit, so it is the authoritative
 * "what is running right now" record — cheaper and more precise than ps
 * ancestry, cwd guesses or screen regexes, and it survives bridge restarts.
 *
 * Observed shape (2.1.251):
 *   {"pid":56711,"sessionId":"1d08…","cwd":"/…","startedAt":…,"procStart":"Sat Aug 29 00:16:21 2026",
 *    "version":"2.1.251","kind":"interactive","entrypoint":"cli","tmux":"cc-evenapp_G2_-1:@0.%0",
 *    "name":"evenapp-g2-68","nameSource":"derived","status":"busy","statusUpdatedAt":…}
 * `claude -p` helpers write kind "interactive" too but entrypoint "sdk-cli" —
 * and inherit the caller's tmux pane — so callers must filter on entrypoint.
 */
export interface ClaudeSessionFile {
  pid: number
  sessionId: string
  cwd: string
  kind: string
  /** `cli` for a real interactive session; `sdk-cli` for `claude -p` runs. */
  entrypoint?: string
  status?: 'busy' | 'idle' | 'shell' | 'waiting'
  /** Free text for `waiting` (e.g. the permission being asked). */
  waitingFor?: string
  statusUpdatedAt?: number
  updatedAt?: number
  startedAt?: number
  version?: string
  /** `session:@window.%pane` when running under tmux. */
  tmux?: string
  name?: string
  nameSource?: string
}

const STATUS_VALUES = new Set(['busy', 'idle', 'shell', 'waiting'])

export function sessionFilesDir(claudeConfigDir: string): string {
  return path.join(claudeConfigDir, 'sessions')
}

/** Every well-formed `<pid>.json` in the sessions dir. Never reads the sibling `.key` files. */
export function readSessionFiles(claudeConfigDir: string): ClaudeSessionFile[] {
  const dir = sessionFilesDir(claudeConfigDir)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: ClaudeSessionFile[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let raw: unknown
    try {
      // In-place rewrites can be caught half-written: skip, retry next scan.
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const f = validate(raw)
    if (f) out.push(f)
  }
  return out
}

function validate(raw: unknown): ClaudeSessionFile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 1) return null
  if (typeof o.sessionId !== 'string' || !o.sessionId) return null
  if (typeof o.cwd !== 'string') return null
  if (typeof o.kind !== 'string') return null
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const status = str(o.status)
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    cwd: o.cwd,
    kind: o.kind,
    entrypoint: str(o.entrypoint),
    status: status && STATUS_VALUES.has(status) ? (status as ClaudeSessionFile['status']) : undefined,
    waitingFor: str(o.waitingFor),
    statusUpdatedAt: num(o.statusUpdatedAt),
    updatedAt: num(o.updatedAt),
    startedAt: num(o.startedAt),
    version: str(o.version),
    tmux: str(o.tmux),
    name: str(o.name),
    nameSource: str(o.nameSource),
  }
}

/** A real interactive session (not the bridge's own `claude -p` helper, not a daemon/worker). */
export function isInteractiveCli(f: ClaudeSessionFile): boolean {
  return f.kind === 'interactive' && (f.entrypoint === undefined || f.entrypoint === 'cli')
}

/** `cc-foo-1:@0.%3` → `%3`. */
export function paneFromTmuxRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const m = ref.match(/(%\d+)\s*$/)
  return m ? m[1] : undefined
}

/** Transcript path Claude Code uses for a session, when the file exists. */
export function transcriptPathFor(claudeConfigDir: string, cwd: string, sessionId: string): string | undefined {
  const p = path.join(claudeConfigDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)
  return fs.existsSync(p) ? p : undefined
}
