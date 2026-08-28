import { splitName } from '@claudedeck/shared'
import type { Frame } from '../display'
import { LINE_W } from '../display'
import { fit } from '../text'
import type { Screen, ScreenContext } from '../ui'
import { SessionScreen } from './session'

/**
 * "Display off" without leaving the app: an all-blank frame lights no pixels
 * on the G2, so the glasses look idle while the bridge stays connected. Any
 * tap or swipe wakes the previous screen. If a session starts waiting for
 * approval while hidden, one header line appears; tapping opens that session.
 */
export class HiddenScreen implements Screen {
  readonly name = 'hidden'
  private alertKey: string | null = null
  private knownWaiting = new Set<string>()
  private unsub: Array<() => void> = []

  constructor(private ctx: ScreenContext) {}

  onEnter(): void {
    this.knownWaiting = new Set(this.ctx.fleet.sessions.filter(s => s.status === 'needs_permission').map(s => s.key))
    this.ctx.fleet.subscribe(null)
    this.unsub.push(
      this.ctx.fleet.on('sessions', list => {
        const waiting = list.filter(s => s.status === 'needs_permission')
        const fresh = waiting.find(s => !this.knownWaiting.has(s.key))
        if (fresh) this.alertKey = fresh.key
        else if (this.alertKey && !waiting.some(s => s.key === this.alertKey)) this.alertKey = null
        for (const s of waiting) this.knownWaiting.add(s.key)
        this.ctx.ui.redraw()
      }),
    )
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
  }

  private wake(): void {
    const target = this.alertKey
    this.ctx.ui.pop()
    if (target) this.ctx.ui.push(new SessionScreen(this.ctx, target))
  }

  onClick(): void {
    this.wake()
  }

  onScroll(): void {
    this.wake()
  }

  onLongPress(): void {
    this.wake()
  }

  // The release of the long-press that hid us must not wake us again.
  onLongPressRelease(): void {}

  onDoubleClick(): boolean {
    this.wake()
    return true
  }

  render(): Frame {
    if (!this.alertKey) return { header: ' ', body: ' ', footer: ' ' }
    const s = this.ctx.fleet.get(this.alertKey)
    const { project } = splitName(s?.name ?? '')
    const what = s?.tool ? `${s.tool.name}: ${s.tool.summary}` : 'needs your OK'
    return {
      header: fit(`? ${project}${this.ctx.fleet.multiMachine ? ` @${s?.machine ?? ''}` : ''} needs OK  ${what}  -  tap to open`, LINE_W),
      body: ' ',
      footer: ' ',
    }
  }
}
