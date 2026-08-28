import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface TmuxPane {
  id: string // %3
  session: string
  window: string
  windowIndex: number
  command: string // pane_current_command
  cwd: string
  pid: number
  title: string
}

let tmuxAvailable: boolean | null = null

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileP('tmux', args, { maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

export async function hasTmux(): Promise<boolean> {
  if (tmuxAvailable !== null) return tmuxAvailable
  try {
    await execFileP('tmux', ['-V'])
    tmuxAvailable = true
  } catch {
    tmuxAvailable = false
  }
  return tmuxAvailable
}

/** All panes across all tmux sessions. Empty when tmux is absent or no server runs. */
export async function listPanes(): Promise<TmuxPane[]> {
  if (!(await hasTmux())) return []
  let out: string
  try {
    out = await tmux([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_title}',
    ])
  } catch {
    return [] // no server running
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [id, session, windowIndex, window, command, cwd, pid, title] = line.split('\t')
      return { id, session, window, windowIndex: Number(windowIndex), command, cwd, pid: Number(pid), title: title ?? '' }
    })
}

interface Proc {
  pid: number
  ppid: number
  args: string
}

let procCache: { at: number; procs: Proc[] } | null = null

/** Snapshot of the process table (cached ~1.5s). */
async function processTable(): Promise<Proc[]> {
  if (procCache && Date.now() - procCache.at < 1500) return procCache.procs
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 })
  const procs: Proc[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  procCache = { at: Date.now(), procs }
  return procs
}

const CLAUDE_ARGS = /(^|\/|\s)claude(\s|$)|claude-code|\.claude\/local\/node_modules/

/** True when a `claude` CLI process is running underneath the pane's shell. */
export async function paneRunsClaude(pane: TmuxPane): Promise<boolean> {
  const procs = await processTable()
  const children = new Map<number, Proc[]>()
  for (const p of procs) {
    const arr = children.get(p.ppid) ?? []
    arr.push(p)
    children.set(p.ppid, arr)
  }
  const stack = [pane.pid]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const c of children.get(pid) ?? []) {
      if (CLAUDE_ARGS.test(c.args)) return true
      stack.push(c.pid)
    }
  }
  // Fallback: the foreground command name itself.
  return pane.command === 'claude'
}

/** Last `lines` rows of the pane, joined-wrapped, trailing blanks trimmed. */
export async function capturePane(paneId: string, lines = 40): Promise<string[]> {
  const out = await tmux(['capture-pane', '-p', '-J', '-t', paneId, '-S', `-${lines}`])
  const rows = out.replace(/\s+$/s, '').split('\n')
  return rows
}

/** Type literal text into the pane (no key-name interpretation). */
export async function sendText(paneId: string, text: string, enter = true): Promise<void> {
  if (text.length) await tmux(['send-keys', '-t', paneId, '-l', '--', text])
  if (enter) {
    // Small gap so the TUI registers the pasted text before Enter.
    await new Promise(r => setTimeout(r, 120))
    await tmux(['send-keys', '-t', paneId, 'Enter'])
  }
}

/** Send tmux key names (`Escape`, `Enter`, `BTab`, `C-c`, `y`, ...). */
export async function sendKeys(paneId: string, keys: string[]): Promise<void> {
  for (const k of keys) {
    await tmux(['send-keys', '-t', paneId, k])
    await new Promise(r => setTimeout(r, 80))
  }
}

export async function paneExists(paneId: string): Promise<boolean> {
  const panes = await listPanes()
  return panes.some(p => p.id === paneId)
}
