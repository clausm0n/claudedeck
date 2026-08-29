import { STATUS_LABEL, formatAge } from '@claudedeck/shared'
import type { FleetDetail, FleetSession } from '../../net/fleet'
import type { Frame } from '../display'
import { BODY_LINES, LINE_W } from '../display'
import { fit, paginate } from '../text'
import type { Screen, ScreenContext } from '../ui'
import { ActionsScreen } from './actions'
import { DictateScreen } from './dictate'

/**
 * One session: status header, last assistant message paginated in the body.
 * Terminal rows show the live pane instead (raw rows, newest page by default).
 */
export class SessionScreen implements Screen {
  readonly name = 'session'
  private detail: FleetDetail | null = null
  private pages: string[] = ['']
  private page = 0
  private pagesFor = ''
  /** Why no detail arrived (bridge error for this subscription). */
  private error: string | null = null
  private unsub: Array<() => void> = []

  constructor(private ctx: ScreenContext, private key: string) {}

  currentKey(): string {
    return this.key
  }

  onEnter(): void {
    this.ctx.fleet.subscribe(this.key)
    this.unsub.push(
      this.ctx.fleet.on('detail', d => {
        if (d.key !== this.key) return
        const wasLatest = this.page === this.pages.length - 1
        this.detail = d
        this.rebuildPages()
        // Follow the newest text unless the user scrolled back.
        if (wasLatest) this.page = this.pages.length - 1
        this.ctx.ui.redraw()
      }),
      this.ctx.fleet.on('sessions', () => this.ctx.ui.redraw()),
      this.ctx.fleet.on('detailError', e => {
        if (e.key !== this.key || this.detail) return
        this.error = e.message
        this.ctx.ui.redraw()
      }),
    )
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
  }

  private summary(): FleetSession | undefined {
    return this.ctx.fleet.get(this.key)
  }

  private isShell(): boolean {
    return (this.summary()?.kind ?? this.detail?.kind) === 'shell'
  }

  private rebuildPages(): void {
    const d = this.detail
    const s = this.summary()
    const status = s?.status ?? d?.status
    if (this.isShell()) {
      const text = d?.lastAssistant ?? (d ? '' : 'loading...')
      if (text === this.pagesFor) return
      this.pagesFor = text
      const rows = text.split('\n').map(r => fit(r.replace(/\s+$/, ''), LINE_W))
      const pages: string[] = []
      for (let i = 0; i < rows.length; i += BODY_LINES) pages.push(rows.slice(i, i + BODY_LINES).join('\n'))
      this.pages = pages.length ? pages : ['(empty terminal)']
      if (this.page >= this.pages.length) this.page = this.pages.length - 1
      return
    }
    const parts: string[] = []
    if (status === 'needs_permission') {
      const t = s?.tool ?? d?.tool
      parts.push(`NEEDS YOUR OK${t ? ` -> ${t.name}: ${t.summary}` : ''}`)
      if (s?.notice) parts.push(s.notice)
      parts.push('tap: Approve / Deny')
      parts.push('')
    } else if (status === 'working' && (s?.tool ?? d?.tool)) {
      const t = (s?.tool ?? d?.tool)!
      parts.push(`Running ${t.name}${t.summary ? `: ${t.summary}` : ''}${s?.agents ? `  (+${s.agents} agents)` : ''}`)
      parts.push('')
    } else if (status === 'error' && s?.notice) {
      parts.push(s.notice)
      parts.push('')
    }
    const text = d?.lastAssistant?.trim() || (d ? '(no assistant text yet)' : this.pendingText(s))
    parts.push(text)
    const joined = parts.join('\n')
    if (joined === this.pagesFor) return
    this.pagesFor = joined
    this.pages = paginate(joined, LINE_W, BODY_LINES)
    if (this.page >= this.pages.length) this.page = this.pages.length - 1
  }

  /** Body while no detail has arrived: loading, an error from the bridge, or a vanished session. */
  private pendingText(s: FleetSession | undefined): string {
    if (this.error) return `${this.error}\n(double-tap: back)`
    if (!s && !this.ctx.fleet.anyOpen) return 'bridge offline\n(double-tap: back)'
    if (!s) return 'session not found (ended, or its bridge is offline)\n(double-tap: back)'
    return 'loading...'
  }

  onScroll(dir: 'up' | 'down'): void {
    if (dir === 'up') this.page = Math.max(0, this.page - 1)
    else this.page = Math.min(this.pages.length - 1, this.page + 1)
  }

  onClick(): void {
    this.ctx.ui.push(new ActionsScreen(this.ctx, this.key))
  }

  onDoubleClick(): boolean {
    this.ctx.ui.pop()
    return true
  }

  /** Hold to talk: press starts dictation, release stops and transcribes. */
  onLongPress(): void {
    if (!this.ctx.fleet.sttAvailable(this.key)) {
      this.ctx.ui.toast('dictation unavailable: bridge has no STT')
      return
    }
    this.ctx.ui.push(new DictateScreen(this.ctx, this.key, { pushToTalk: true }))
  }

  render(): Frame {
    const s = this.summary()
    const d = this.detail
    this.rebuildPages()
    const status = s?.status ?? d?.status ?? 'unknown'
    const now = Date.now()
    const shell = this.isShell()
    const head = [
      s?.name ?? d?.name ?? this.key,
      this.ctx.fleet.multiMachine ? `@${s?.machine ?? ''}` : '',
      shell ? (status === 'working' ? 'BUSY' : 'IDLE') : STATUS_LABEL[status],
      formatAge(s?.statusSince ?? now, now),
      shell ? (s?.command ?? '') : (s?.model ?? ''),
      !shell && typeof s?.contextPct === 'number' ? `ctx ${s.contextPct}%` : '',
    ]
      .filter(Boolean)
      .join('  ')
    const header = fit(head, LINE_W)
    const body = this.pages[this.page] ?? ''
    const pager = this.pages.length > 1 ? `pg ${this.page + 1}/${this.pages.length}  swipe: page   ` : ''
    const footer = fit(`${pager}tap: actions   hold: talk   double-tap: back`, LINE_W)
    return { header, body, footer }
  }
}
