import { STATUS_GLYPH, STATUS_LABEL, formatAge, splitName } from '@claudedeck/shared'
import type { FleetSession, TerminalTarget } from '../../net/fleet'
import type { Frame } from '../display'
import { BODY_LINES, INNER_W, LINE_W } from '../display'
import { fit } from '../text'
import type { Screen, ScreenContext } from '../ui'
import { SessionScreen } from './session'
import { HiddenScreen } from './hidden'

type Row = { kind: 'session'; s: FleetSession } | { kind: 'new'; t: TerminalTarget } | { kind: 'note'; text: string; detail: string }

/** Root screen: every Claude Code session and terminal across every bridge, plus "new terminal" rows. */
export class SessionsScreen implements Screen {
  readonly name = 'sessions'
  private cursor = 0
  private top = 0
  private unsub: Array<() => void> = []
  private opening = false

  constructor(private ctx: ScreenContext) {}

  private rows(): Row[] {
    const rows: Row[] = this.ctx.fleet.sessions.map(s => ({ kind: 'session', s }))
    // A relayed bridge that is too old gets a note instead of a "+ new terminal" row it cannot honour.
    for (const { remote } of this.ctx.fleet.outdatedRemotes()) {
      rows.push({
        kind: 'note',
        text: `${remote.name} outdated (claudedeck ${remote.version ?? '?'})`,
        detail: `${remote.name} runs claudedeck ${remote.version ?? '?'}: terminals, ctrl-c and kill need a newer bridge - run claudedeck update on ${remote.name}`,
      })
    }
    for (const t of this.ctx.fleet.terminalTargets()) rows.push({ kind: 'new', t })
    return rows
  }

  onEnter(): void {
    this.unsub.push(this.ctx.fleet.on('sessions', () => this.ctx.ui.redraw()))
    this.unsub.push(this.ctx.fleet.on('bridges', () => this.ctx.ui.redraw()))
    this.ctx.fleet.subscribe(null)
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
  }

  currentKey(): string | null {
    const r = this.rows()[this.cursor]
    return r?.kind === 'session' ? r.s.key : null
  }

  onScroll(dir: 'up' | 'down'): void {
    const n = this.rows().length
    if (n === 0) return
    this.cursor = dir === 'up' ? Math.max(0, this.cursor - 1) : Math.min(n - 1, this.cursor + 1)
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + BODY_LINES) this.top = this.cursor - BODY_LINES + 1
  }

  onClick(): void {
    const r = this.rows()[this.cursor]
    if (!r) return
    if (r.kind === 'session') {
      this.ctx.ui.push(new SessionScreen(this.ctx, r.s.key))
      return
    }
    if (r.kind === 'note') {
      this.ctx.ui.toast(r.detail, 6000)
      return
    }
    if (this.opening) return
    this.opening = true
    this.ctx.ui.toast(`opening a terminal on ${r.t.machine}...`, 8000)
    this.ctx.fleet
      .newTerminal(r.t)
      .then(key => {
        this.ctx.ui.toast('terminal ready', 1500)
        if (this.ctx.ui.current === this) this.ctx.ui.push(new SessionScreen(this.ctx, key))
      })
      .catch(err => this.ctx.ui.toast(`new terminal failed: ${(err as Error).message}`, 4000))
      .finally(() => (this.opening = false))
  }

  onDoubleClick(): boolean {
    return false // root → system exit dialog
  }

  /** Hold on the root screen = hide the display (wake with any tap). */
  onLongPress(): void {
    this.ctx.ui.hide(() => new HiddenScreen(this.ctx))
  }

  render(): Frame {
    const fleet = this.ctx.fleet
    const list = fleet.sessions
    const rows = this.rows()
    const claude = list.filter(s => s.kind !== 'shell')
    const shells = list.length - claude.length
    const attention = list.filter(s => s.status === 'needs_permission' || s.status === 'error').length
    const working = claude.filter(s => s.status === 'working').length
    const bridges = [...fleet.clients.values()]
    const open = bridges.filter(b => b.state === 'open').length

    const header = fit(
      `ClaudeDeck  ${claude.length} claude` +
        (shells ? `  ${shells} term` : '') +
        (attention ? `  ${attention} need OK` : '') +
        (working ? `  ${working} working` : '') +
        `  [${open}/${bridges.length} bridge${bridges.length === 1 ? '' : 's'}]`,
      LINE_W,
    )

    let body: string
    if (rows.length === 0) {
      const lines: string[] = []
      if (bridges.length === 0) {
        lines.push('No bridges configured.')
        lines.push('Open this app on your phone and add a bridge URL')
        lines.push('(run claudedeck url --copy on your machine).')
      } else {
        for (const b of bridges) {
          lines.push(fit(`${b.entry.name}: ${b.state}${b.state === 'closed' && b.lastError ? ` - ${b.lastError}` : ''}`, INNER_W))
        }
        if (open > 0) {
          lines.push('')
          lines.push('No sessions and no tmux on the bridge.')
          lines.push('Install tmux, then start claude or tap "new terminal".')
        }
      }
      body = lines.slice(0, BODY_LINES).join('\n')
    } else {
      if (this.cursor >= rows.length) this.cursor = rows.length - 1
      const out: string[] = []
      const end = Math.min(rows.length, this.top + BODY_LINES)
      const now = Date.now()
      for (let i = this.top; i < end; i++) {
        const r = rows[i]
        const cur = i === this.cursor ? '>' : ' '
        if (r.kind === 'new') {
          out.push(fit(`${cur} + new terminal${fleet.multiMachine || fleet.terminalTargets().length > 1 ? ` @${r.t.machine}` : ''}`, LINE_W))
          continue
        }
        if (r.kind === 'note') {
          out.push(fit(`${cur} ! ${r.text}`, LINE_W))
          continue
        }
        const s = r.s
        const age = formatAge(s.statusSince, now)
        const multi = fleet.multiMachine ? `@${s.machine} ` : ''
        if (s.kind === 'shell') {
          const label = s.status === 'working' ? 'BUSY' : 'IDLE'
          const cmd = s.status === 'working' && s.command ? `${s.command}: ` : ''
          out.push(fit(`${cur} $ ${s.name} ${multi}${label} ${age}  ${cmd}${s.lastLine ?? ''}`, LINE_W))
          continue
        }
        const glyph = STATUS_GLYPH[s.status]
        const label = STATUS_LABEL[s.status]
        const { project, title } = splitName(s.name)
        // What matters most after the status: the tool awaiting approval or
        // running; otherwise the session title (to tell siblings apart).
        const detail =
          s.status === 'needs_permission' && s.tool
            ? `${s.tool.name}: ${s.tool.summary}`
            : s.status === 'working' && s.tool
              ? `${s.tool.name} ${s.tool.summary}`
              : title || (s.lastLine ?? '')
        const ro = s.pane ? '' : ' [ro]'
        out.push(fit(`${cur} ${glyph} ${project} ${multi}${label} ${age}${ro}  ${detail}`, LINE_W))
      }
      body = out.join('\n')
    }

    const more = rows.length > BODY_LINES ? ` ${this.cursor + 1}/${rows.length}` : ''
    const kind = rows[this.cursor]?.kind
    const tap = kind === 'new' ? 'open new terminal' : kind === 'note' ? 'details' : 'open'
    const footer = fit(`swipe: select${more}  tap: ${tap}  hold: hide  tap+hold: menu  2x: exit`, LINE_W)
    return { header, body, footer }
  }
}
