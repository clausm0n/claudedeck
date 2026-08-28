import type { Fleet } from '../net/fleet'
import { Display, type Frame } from './display'

export interface ScreenContext {
  fleet: Fleet
  ui: UI
  /** Start/stop the glasses microphone. */
  mic(on: boolean): Promise<void>
}

/** A screen renders a Frame and reacts to glasses gestures. */
export interface Screen {
  readonly name: string
  render(): Frame
  onScroll?(dir: 'up' | 'down'): void
  onClick?(): void
  /** Return true when handled; false lets the UI fall back to the exit dialog. */
  onDoubleClick?(): boolean
  onLongPress?(): void
  onLongPressRelease?(): void
  onEnter?(): void
  onLeave?(): void
  /** PCM chunks while the mic is on. */
  onAudio?(pcm: Uint8Array): void
  /** Currently focused session key, for contextual-menu actions. */
  currentKey?(): string | null
}

export class UI {
  private stack: Screen[] = []
  private redrawTimer: number | null = null
  private toastText = ''
  private toastTimer: number | null = null

  constructor(private display: Display, public readonly onExit: () => void) {}

  get current(): Screen | undefined {
    return this.stack[this.stack.length - 1]
  }

  push(screen: Screen): void {
    this.current?.onLeave?.()
    this.stack.push(screen)
    screen.onEnter?.()
    this.redraw(true)
  }

  replace(screen: Screen): void {
    const top = this.stack.pop()
    top?.onLeave?.()
    this.stack.push(screen)
    screen.onEnter?.()
    this.redraw(true)
  }

  pop(): void {
    if (this.stack.length <= 1) return
    const top = this.stack.pop()
    top?.onLeave?.()
    this.current?.onEnter?.()
    this.redraw(true)
  }

  /** Blank the glasses until the next tap (see HiddenScreen). */
  hide(make: () => Screen): void {
    if (this.current?.name === 'hidden') return
    this.push(make())
  }

  popTo(name: string): void {
    while (this.stack.length > 1 && this.current?.name !== name) {
      const top = this.stack.pop()
      top?.onLeave?.()
    }
    this.current?.onEnter?.()
    this.redraw(true)
  }

  /** Short footer message, e.g. an action ack. */
  toast(text: string, ms = 2500): void {
    this.toastText = text
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      this.toastText = ''
      this.toastTimer = null
      this.redraw()
    }, ms)
    this.redraw(true)
  }

  redraw(immediate = false): void {
    if (this.redrawTimer !== null) {
      if (!immediate) return
      clearTimeout(this.redrawTimer)
      this.redrawTimer = null
    }
    const run = () => {
      this.redrawTimer = null
      const s = this.current
      if (!s) return
      const f = s.render()
      if (this.toastText) f.footer = this.toastText
      this.display.set(f)
    }
    if (immediate) run()
    else this.redrawTimer = window.setTimeout(run, 80)
  }

  refresh(): void {
    this.display.refresh()
  }

  // ───── gesture entry points (called from main.ts) ─────

  scroll(dir: 'up' | 'down'): void {
    this.current?.onScroll?.(dir)
    this.redraw(true)
  }

  click(): void {
    this.current?.onClick?.()
    this.redraw(true)
  }

  doubleClick(): void {
    const handled = this.current?.onDoubleClick?.() ?? false
    if (!handled) this.onExit()
    else this.redraw(true)
  }

  longPress(): void {
    this.current?.onLongPress?.()
    this.redraw(true)
  }

  longPressRelease(): void {
    this.current?.onLongPressRelease?.()
    this.redraw(true)
  }

  audio(pcm: Uint8Array): void {
    this.current?.onAudio?.(pcm)
  }

  currentKey(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const k = this.stack[i].currentKey?.()
      if (k) return k
    }
    return null
  }
}
