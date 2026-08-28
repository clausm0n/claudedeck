import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

/**
 * Fixed three-row layout used by every screen:
 *   header (1 line) / body (8 lines, event capture) / footer (1 line)
 * Because the layout never changes, screen switches are flicker-free
 * textContainerUpgrade calls. The contextual menu is declared once.
 */
export const W = 576
export const H = 288
export const PAD = 2
export const HEADER_H = 31 // 27px line + 2*PAD
export const FOOTER_H = 31
export const BODY_Y = HEADER_H
export const BODY_H = H - HEADER_H - FOOTER_H // 226 → 8 lines of 27px
export const INNER_W = W - 2 * PAD
/**
 * Budget for a single row that must never wrap. pretext is pixel-accurate for
 * the firmware font, but the simulator's font differs slightly and an
 * over-wide single line scroll-animates in LVGL — keep a safety margin.
 */
export const LINE_W = INNER_W - 40
export const BODY_LINES = Math.floor((BODY_H - 2 * PAD) / 27) // 8

const IDS = { header: 1, body: 2, footer: 3 } as const
const NAMES = { header: 'hdr', body: 'body', footer: 'ftr' } as const

export interface Frame {
  header: string
  body: string
  footer: string
}

export interface MenuSpec {
  id: number
  label: string
}

const CALL_TIMEOUT_MS = 8000
const START_TIMEOUT_MS = 30000

export class Display {
  private last: Frame = { header: '', body: '', footer: '' }
  private pending: Partial<Frame> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private started = false
  onFrame: ((f: Frame) => void) | null = null

  constructor(private bridge: EvenAppBridge, private menu: MenuSpec[]) {}

  private containers(f: Frame): TextContainerProperty[] {
    return [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: W, height: HEADER_H,
        borderWidth: 0, borderColor: 0, paddingLength: PAD,
        containerID: IDS.header, containerName: NAMES.header,
        content: f.header || ' ', textColor: 3, isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: 0, yPosition: BODY_Y, width: W, height: BODY_H,
        borderWidth: 0, borderColor: 0, paddingLength: PAD,
        containerID: IDS.body, containerName: NAMES.body,
        content: f.body || ' ', textColor: 4, isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0, yPosition: BODY_Y + BODY_H, width: W, height: FOOTER_H,
        borderWidth: 0, borderColor: 0, paddingLength: PAD,
        containerID: IDS.footer, containerName: NAMES.footer,
        content: f.footer || ' ', textColor: 2, isEventCapture: 0,
      }),
    ]
  }

  private menuObject(): MenuContainerProperty {
    return new MenuContainerProperty({
      menuItems: this.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
    })
  }

  /**
   * One-shot page creation. Over BLE this can take many seconds; a slow or
   * oddly-shaped host reply must not kill the app, so we wait generously and
   * always mark the display as started (the page is usually on the glasses
   * even when the result code is unexpected).
   */
  async start(initial: Frame): Promise<number> {
    this.last = { ...initial }
    try {
      const result = await timeout(
        this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({
            containerTotalNum: 3,
            textObject: this.containers(initial),
            menuObject: this.menuObject(),
          }),
        ),
        START_TIMEOUT_MS,
      )
      return typeof result === 'number' ? result : -1
    } catch (err) {
      console.warn('[ClaudeDeck] createStartUpPageContainer threw', err)
      return -2
    } finally {
      this.started = true
      this.onFrame?.(this.last)
    }
  }

  /** Full redraw (flickers) — used only when the host may have lost our page. */
  rebuild(): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await timeout(
        this.bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 3,
            textObject: this.containers(this.last),
            menuObject: this.menuObject(),
          }),
        ),
      )
      return ok
    })
  }

  /** Update whichever rows changed. Coalesces bursts into one send per row. */
  set(frame: Frame): void {
    const f = { header: clamp(frame.header), body: clamp(frame.body), footer: clamp(frame.footer) }
    let dirty = false
    for (const k of ['header', 'body', 'footer'] as const) {
      if (f[k] !== this.last[k]) {
        this.pending[k] = f[k]
        this.last[k] = f[k]
        dirty = true
      }
    }
    this.onFrame?.(this.last)
    if (!dirty || !this.started) return
    void this.enqueue(async () => {
      const batch = this.pending
      this.pending = {}
      for (const k of ['header', 'body', 'footer'] as const) {
        const content = batch[k]
        if (content === undefined) continue
        await timeout(
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: IDS[k],
              containerName: NAMES[k],
              content: content || ' ',
              contentOffset: 0,
              contentLength: 0,
            }),
          ),
        ).catch(err => console.warn('upgrade failed', k, err))
      }
    })
  }

  /** Re-send every row (after foreground enter). */
  refresh(): void {
    this.pending = { ...this.last }
    void this.enqueue(async () => {
      const batch = this.pending
      this.pending = {}
      for (const k of ['header', 'body', 'footer'] as const) {
        await timeout(
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: IDS[k], containerName: NAMES[k], content: batch[k] || ' ', contentOffset: 0, contentLength: 0 }),
          ),
        ).catch(() => {})
      }
    })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }
}

function clamp(s: string): string {
  return s.length > 1900 ? s.slice(0, 1900) : s
}

function timeout<T>(p: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('bridge call timeout')), ms))])
}
