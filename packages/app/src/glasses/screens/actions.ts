import type { SessionAction } from '@claudedeck/shared'
import type { Frame } from '../display'
import { BODY_LINES, LINE_W } from '../display'
import { fit } from '../text'
import type { Screen, ScreenContext } from '../ui'
import { DictateScreen } from './dictate'
import { RawScreen } from './raw'

interface Item {
  label: string
  run: () => void
}

/** Cursor list of things you can do to the focused session. */
export class ActionsScreen implements Screen {
  readonly name = 'actions'
  private cursor = 0
  private top = 0
  private unsub: Array<() => void> = []

  constructor(private ctx: ScreenContext, private key: string) {}

  currentKey(): string {
    return this.key
  }

  onEnter(): void {
    this.unsub.push(this.ctx.fleet.on('sessions', () => this.ctx.ui.redraw()))
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
  }

  private items(): Item[] {
    const s = this.ctx.fleet.get(this.key)
    const status = s?.status ?? 'unknown'
    const act = (label: string, action: SessionAction, thenBack = true) => ({
      label,
      run: () => {
        runAction(this.ctx, this.key, action, label)
        if (thenBack) this.ctx.ui.pop()
      },
    })
    const items: Item[] = []
    if (status === 'needs_permission') {
      items.push(act('Approve  (y)', 'approve'))
      items.push(act('Approve all similar  (2)', 'approve_all'))
      items.push(act('Deny  (Esc)', 'deny'))
    }
    if (status === 'working' || status === 'compacting') {
      items.push(act('Interrupt  (Esc)', 'interrupt'))
    }
    items.push({
      label: this.ctx.fleet.sttAvailable(this.key) ? 'Dictate a prompt' : 'Dictate a prompt  (STT not set up)',
      run: () => this.ctx.ui.push(new DictateScreen(this.ctx, this.key, { pushToTalk: false })),
    })
    if (status === 'idle' || status === 'error' || status === 'unknown') {
      items.push(act('Send "continue"', 'continue'))
    }
    items.push({ label: 'Raw terminal', run: () => this.ctx.ui.push(new RawScreen(this.ctx, this.key)) })
    items.push(act('Cycle permission mode  (Shift+Tab)', 'cycle_mode', false))
    items.push(act('Press Enter', 'enter', false))
    if (status !== 'needs_permission') items.push(act('Send Esc', 'interrupt', false))
    items.push({ label: 'Back', run: () => this.ctx.ui.pop() })
    return items
  }

  onScroll(dir: 'up' | 'down'): void {
    const n = this.items().length
    this.cursor = dir === 'up' ? Math.max(0, this.cursor - 1) : Math.min(n - 1, this.cursor + 1)
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + BODY_LINES) this.top = this.cursor - BODY_LINES + 1
  }

  onClick(): void {
    const items = this.items()
    if (this.cursor >= items.length) this.cursor = items.length - 1
    items[this.cursor]?.run()
  }

  onDoubleClick(): boolean {
    this.ctx.ui.pop()
    return true
  }

  render(): Frame {
    const s = this.ctx.fleet.get(this.key)
    const items = this.items()
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1)
    const header = fit(`${s?.name ?? ''}  actions${s?.pane ? '' : '  (no tmux pane - read only)'}`, LINE_W)
    const rows = items.slice(this.top, this.top + BODY_LINES).map((it, i) => fit(`${this.top + i === this.cursor ? '>' : ' '} ${it.label}`, LINE_W))
    const footer = fit('swipe: select   tap: run   double-tap: back', LINE_W)
    return { header, body: rows.join('\n'), footer }
  }
}

export function runAction(ctx: ScreenContext, key: string, action: SessionAction, label: string): void {
  const ok = ctx.fleet.action(key, action)
  ctx.ui.toast(ok ? `sent: ${label}` : 'not connected')
}
