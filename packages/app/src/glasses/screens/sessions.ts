import { STATUS_GLYPH, STATUS_LABEL, formatAge, splitName } from '@claudedeck/shared'
import type { Frame } from '../display'
import { BODY_LINES, INNER_W, LINE_W } from '../display'
import { fit } from '../text'
import type { Screen, ScreenContext } from '../ui'
import { SessionScreen } from './session'
import { HiddenScreen } from './hidden'

/** Root screen: every Claude Code session across every bridge. */
export class SessionsScreen implements Screen {
  readonly name = 'sessions'
  private cursor = 0
  private top = 0
  private unsub: Array<() => void> = []

  constructor(private ctx: ScreenContext) {}

  onEnter(): void {
    this.unsub.push(this.ctx.fleet.on('sessions', () => this.ctx.ui.redraw()))
    this.unsub.push(this.ctx.fleet.on('bridges', () => this.ctx.ui.redraw()))
    this.ctx.fleet.subscribe(null)
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
  }

  currentKey(): string | null {
    return this.ctx.fleet.sessions[this.cursor]?.key ?? null
  }

  onScroll(dir: 'up' | 'down'): void {
    const n = this.ctx.fleet.sessions.length
    if (n === 0) return
    this.cursor = dir === 'up' ? Math.max(0, this.cursor - 1) : Math.min(n - 1, this.cursor + 1)
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + BODY_LINES) this.top = this.cursor - BODY_LINES + 1
  }

  onClick(): void {
    const s = this.ctx.fleet.sessions[this.cursor]
    if (!s) return
    this.ctx.ui.push(new SessionScreen(this.ctx, s.key))
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
    const attention = list.filter(s => s.status === 'needs_permission' || s.status === 'error').length
    const working = list.filter(s => s.status === 'working').length
    const bridges = [...fleet.clients.values()]
    const open = bridges.filter(b => b.state === 'open').length

    const header = fit(
      `ClaudeDeck  ${list.length} session${list.length === 1 ? '' : 's'}` +
        (attention ? `  ${attention} need OK` : '') +
        (working ? `  ${working} working` : '') +
        `  [${open}/${bridges.length} bridge${bridges.length === 1 ? '' : 's'}]`,
      LINE_W,
    )

    let body: string
    if (list.length === 0) {
      const lines: string[] = []
      if (bridges.length === 0) {
        lines.push('No bridges configured.')
        lines.push('Open this app on your phone and add a bridge URL')
        lines.push('(run claudedeck info on your machine).')
      } else {
        for (const b of bridges) {
          lines.push(fit(`${b.entry.name}: ${b.state}${b.state === 'closed' && b.lastError ? ` - ${b.lastError}` : ''}`, INNER_W))
        }
        if (open > 0) {
          lines.push('')
          lines.push('No Claude Code sessions found.')
          lines.push('Start claude inside a tmux pane, or run')
          lines.push('claudedeck install-hooks once and restart claude.')
        }
      }
      body = lines.slice(0, BODY_LINES).join('\n')
    } else {
      if (this.cursor >= list.length) this.cursor = list.length - 1
      const rows: string[] = []
      const end = Math.min(list.length, this.top + BODY_LINES)
      const now = Date.now()
      for (let i = this.top; i < end; i++) {
        const s = list[i]
        const cur = i === this.cursor ? '>' : ' '
        const glyph = STATUS_GLYPH[s.status]
        const label = STATUS_LABEL[s.status]
        const age = formatAge(s.statusSince, now)
        const { project, title } = splitName(s.name)
        // What matters most after the status: the tool awaiting approval or
        // running; otherwise the session title (to tell siblings apart).
        const detail =
          s.status === 'needs_permission' && s.tool
            ? `${s.tool.name}: ${s.tool.summary}`
            : s.status === 'working' && s.tool
              ? `${s.tool.name} ${s.tool.summary}`
              : title || (s.lastLine ?? '')
        const multi = fleet.multiMachine ? `@${s.machine} ` : ''
        rows.push(fit(`${cur} ${glyph} ${project} ${multi}${label} ${age}  ${detail}`, LINE_W))
      }
      body = rows.join('\n')
    }

    const more = list.length > BODY_LINES ? ` ${this.cursor + 1}/${list.length}` : ''
    const footer = fit(`swipe: select${more}  tap: open  hold: hide  tap+hold: menu  2x: exit`, LINE_W)
    return { header, body, footer }
  }
}
