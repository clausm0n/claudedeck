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
let tmuxBin = 'tmux'
const TMUX_CANDIDATES = ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
const SEP = '<|>'
/** tmux children get a UTF-8 locale so capture-pane keeps glyphs (❯, ⏺) instead of `_`. */
const TMUX_ENV = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8', LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' }

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileP(tmuxBin, args, { maxBuffer: 4 * 1024 * 1024, env: TMUX_ENV })
  return stdout
}

/** Find a working tmux binary even when PATH is minimal (launchd). Re-probes while absent. */
export async function hasTmux(): Promise<boolean> {
  if (tmuxAvailable) return true
  for (const bin of TMUX_CANDIDATES) {
    try {
      await execFileP(bin, ['-V'])
      tmuxBin = bin
      tmuxAvailable = true
      return true
    } catch {
      /* try next */
    }
  }
  tmuxAvailable = false
  return false
}

/** Last error from tmux/ps, for /debug. */
export let lastTmuxError = ''

/** All panes across all tmux sessions. Empty when tmux is absent or no server runs. */
export async function listPanes(): Promise<TmuxPane[]> {
  if (!(await hasTmux())) {
    lastTmuxError = 'tmux binary not found'
    return []
  }
  let out: string
  try {
    out = await tmux([
      'list-panes',
      '-a',
      '-F',
      // A printable separator: in a C/POSIX locale (launchd) tmux replaces
      // non-printable chars such as tabs in format output with `_`.
      ['#{pane_id}', '#{session_name}', '#{window_index}', '#{window_name}', '#{pane_current_command}', '#{pane_current_path}', '#{pane_pid}', '#{pane_title}'].join(SEP),
    ])
    lastTmuxError = ''
  } catch (err) {
    lastTmuxError = `list-panes: ${(err as Error).message}`
    return [] // no server running
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [id, session, windowIndex, window, command, cwd, pid, title] = line.split(SEP)
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
  let stdout: string
  try {
    ;({ stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 }))
  } catch (err) {
    lastTmuxError = `ps: ${(err as Error).message}`
    throw err
  }
  const procs: Proc[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  procCache = { at: Date.now(), procs }
  return procs
}

const CLAUDE_ARGS = /(^|\/|\s)claude(\s|$)|claude-code|\.claude\/local\/node_modules/

/**
 * True when the pane's process is the `claude` CLI or has it underneath.
 * `tmux new-session "claude"` makes the pane process claude itself (sh execs
 * it), while typing `claude` into a shell makes it a child — handle both.
 */
export async function paneRunsClaude(pane: TmuxPane): Promise<boolean> {
  const procs = await processTable()
  const self = procs.find(p => p.pid === pane.pid)
  if (self && CLAUDE_ARGS.test(self.args)) return true
  // The versioned binary reports its name as e.g. "2.1.251".
  if (/^\d+\.\d+\.\d+$/.test(pane.command)) return true
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

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'login', 'tmux'])

/** True when the pane's foreground process is an interactive shell waiting at a prompt. */
export function isShellCommand(cmd: string): boolean {
  return SHELL_COMMANDS.has(cmd.replace(/^-/, ''))
}

export async function listSessionNames(): Promise<string[]> {
  try {
    return (await tmux(['list-sessions', '-F', '#{session_name}'])).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** Create a detached session and return its first pane id. Sized generously; tmux resizes when a terminal attaches. */
export async function newSession(name: string, cwd?: string): Promise<string> {
  const args = ['new-session', '-d', '-s', name, '-x', '120', '-y', '36', '-P', '-F', '#{pane_id}']
  if (cwd) args.push('-c', cwd)
  return (await tmux(args)).trim()
}

export async function killPane(paneId: string): Promise<void> {
  await tmux(['kill-pane', '-t', paneId])
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

/** Among candidate pids (a hook's ancestor chain), the one that is the `claude` CLI. */
export async function claudePidAmong(pids: number[]): Promise<number | undefined> {
  if (!pids.length) return undefined
  const procs = await processTable()
  const byPid = new Map(procs.map(p => [p.pid, p]))
  for (const pid of pids) {
    const p = byPid.get(pid)
    if (p && CLAUDE_ARGS.test(p.args)) return pid
  }
  return undefined
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function paneExists(paneId: string): Promise<boolean> {
  const panes = await listPanes()
  return panes.some(p => p.id === paneId)
}
