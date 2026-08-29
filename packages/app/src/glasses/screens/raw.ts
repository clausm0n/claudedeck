import type { Frame } from '../display'
import { BODY_LINES, LINE_W } from '../display'
import { fit } from '../text'
import type { Screen, ScreenContext } from '../ui'

/** The last rows of the tmux pane, as captured by the bridge. */
export class RawScreen implements Screen {
  readonly name = 'raw'
  private lines: string[] = []
  private offset = 0 // rows from the bottom
  private status = 'loading...'

  constructor(private ctx: ScreenContext, private key: string) {}

  currentKey(): string {
    return this.key
  }

  onEnter(): void {
    void this.load()
  }

  private async load(): Promise<void> {
    const s = this.ctx.fleet.get(this.key)
    if (s && !s.pane) {
      // Nothing to capture: skip the round trip (and a 6 s wait on old hubs).
      this.lines = []
      this.status = 'no tmux pane (read-only)'
      this.ctx.ui.redraw(true)
      return
    }
    try {
      const lines = await this.ctx.fleet.screen(this.key, 80)
      // Drop trailing empty rows so the prompt sits at the bottom.
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      this.lines = lines
      this.status = ''
    } catch (err) {
      this.status = (err as Error).message
    }
    this.ctx.ui.redraw(true)
  }

  onScroll(dir: 'up' | 'down'): void {
    const max = Math.max(0, this.lines.length - BODY_LINES)
    if (dir === 'up') this.offset = Math.min(max, this.offset + BODY_LINES - 1)
    else this.offset = Math.max(0, this.offset - (BODY_LINES - 1))
  }

  onClick(): void {
    this.offset = 0
    this.status = 'refreshing...'
    void this.load()
  }

  onDoubleClick(): boolean {
    this.ctx.ui.pop()
    return true
  }

  render(): Frame {
    const s = this.ctx.fleet.get(this.key)
    const header = fit(`${s?.name ?? ''}  terminal${this.status ? `  ${this.status}` : ''}`, LINE_W)
    const end = this.lines.length - this.offset
    const start = Math.max(0, end - BODY_LINES)
    const rows = this.lines.slice(start, end).map(l => fit(l.replace(/\s+$/, ''), LINE_W))
    const footer = fit(`rows ${start + 1}-${end}/${this.lines.length}   swipe: scroll   tap: refresh   double-tap: back`, LINE_W)
    return { header, body: rows.join('\n'), footer }
  }
}
