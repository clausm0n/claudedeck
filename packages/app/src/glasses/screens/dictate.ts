import type { Frame } from '../display'
import { BODY_LINES, LINE_W } from '../display'
import { fit, paginate } from '../text'
import type { Screen, ScreenContext } from '../ui'

type Phase = 'starting' | 'listening' | 'transcribing' | 'review' | 'failed'

/**
 * Glasses mic → bridge → whisper → review → tmux. In push-to-talk mode the
 * long-press release stops recording; otherwise tap stops.
 */
export class DictateScreen implements Screen {
  readonly name = 'dictate'
  private phase: Phase = 'starting'
  private startedAt = Date.now()
  private bytes = 0
  private text = ''
  /** What whisper heard, when the bridge turned it into a shell command. */
  private raw = ''
  private error = ''
  private cursor = 0
  private tick: number | null = null
  private unsub: Array<() => void> = []
  private stopped = false

  constructor(private ctx: ScreenContext, private key: string, private opts: { pushToTalk: boolean }) {}

  currentKey(): string {
    return this.key
  }

  onEnter(): void {
    this.unsub.push(
      this.ctx.fleet.on('transcript', t => {
        if (this.phase !== 'transcribing') return
        this.text = t.text.trim()
        this.raw = (t.raw ?? '').trim()
        this.phase = this.text ? 'review' : 'failed'
        this.error = this.text ? '' : `nothing heard (${t.seconds.toFixed(1)}s)`
        this.cursor = 0
        this.ctx.ui.redraw(true)
      }),
      this.ctx.fleet.on('log', () => this.ctx.ui.redraw()),
    )
    void this.begin()
  }

  private async begin(): Promise<void> {
    if (!this.ctx.fleet.audioStart(this.key)) {
      this.phase = 'failed'
      this.error = 'bridge not connected'
      this.ctx.ui.redraw(true)
      return
    }
    try {
      await this.ctx.mic(true)
      this.phase = 'listening'
      this.startedAt = Date.now()
      this.tick = window.setInterval(() => this.ctx.ui.redraw(), 1000)
    } catch (err) {
      this.phase = 'failed'
      this.error = `mic failed: ${(err as Error).message ?? err}`
      this.ctx.fleet.audioCancel(this.key)
    }
    this.ctx.ui.redraw(true)
  }

  onLeave(): void {
    this.unsub.splice(0).forEach(fn => fn())
    if (this.tick !== null) clearInterval(this.tick)
    if (this.phase === 'listening' || this.phase === 'starting') {
      void this.ctx.mic(false)
      this.ctx.fleet.audioCancel(this.key)
    }
  }

  onAudio(pcm: Uint8Array): void {
    if (this.phase !== 'listening') return
    this.bytes += pcm.byteLength
    this.ctx.fleet.audioChunk(this.key, pcm)
  }

  private async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.tick !== null) clearInterval(this.tick)
    this.phase = 'transcribing'
    this.ctx.ui.redraw(true)
    try {
      await this.ctx.mic(false)
    } catch {
      /* ignore */
    }
    if (!this.ctx.fleet.audioStop(this.key)) {
      this.phase = 'failed'
      this.error = 'bridge not connected'
    }
    this.ctx.ui.redraw(true)
  }

  onLongPressRelease(): void {
    if (this.opts.pushToTalk && this.phase === 'listening') void this.stop()
  }

  onClick(): void {
    if (this.phase === 'listening') {
      void this.stop()
      return
    }
    if (this.phase === 'review') {
      const items = this.reviewItems()
      items[this.cursor]?.run()
      return
    }
    if (this.phase === 'failed') this.ctx.ui.pop()
  }

  onScroll(dir: 'up' | 'down'): void {
    if (this.phase !== 'review') return
    const n = this.reviewItems().length
    this.cursor = dir === 'up' ? Math.max(0, this.cursor - 1) : Math.min(n - 1, this.cursor + 1)
  }

  onDoubleClick(): boolean {
    this.ctx.ui.pop()
    return true
  }

  private isShell(): boolean {
    return this.ctx.fleet.get(this.key)?.kind === 'shell'
  }

  private reviewItems(): Array<{ label: string; run: () => void }> {
    const readOnly = !this.ctx.fleet.get(this.key)?.pane
    const shell = this.isShell()
    const typeOnly = shell
      ? [
          {
            label: 'Type only (no Enter)',
            run: () => {
              const ok = this.ctx.fleet.sendText(this.key, this.text, false)
              this.ctx.ui.toast(ok ? 'typed' : 'not connected')
              this.ctx.ui.pop()
            },
          },
        ]
      : []
    return [
      {
        label: readOnly ? 'Send (unavailable: not in tmux)' : shell ? 'Run in terminal' : 'Send to Claude',
        run: () => {
          if (readOnly) {
            this.ctx.ui.toast('read-only: relaunch claude in a new shell (tmux wrapper)', 4000)
            return
          }
          const ok = this.ctx.fleet.sendText(this.key, this.text, true)
          this.ctx.ui.toast(ok ? 'sent' : 'not connected')
          this.ctx.ui.pop()
        },
      },
      ...typeOnly,
      ...(this.raw && this.raw !== this.text
        ? [
            {
              label: 'Use what was heard instead',
              run: () => {
                this.text = this.raw
                this.raw = ''
                this.cursor = 0
              },
            },
          ]
        : []),
      { label: 'Retry', run: () => this.ctx.ui.replace(new DictateScreen(this.ctx, this.key, this.opts)) },
      { label: 'Cancel', run: () => this.ctx.ui.pop() },
    ]
  }

  render(): Frame {
    const s = this.ctx.fleet.get(this.key)
    const name = s?.name ?? ''
    switch (this.phase) {
      case 'starting':
        return { header: fit(`${name}  dictate`, LINE_W), body: 'Starting microphone...', footer: 'double-tap: cancel' }
      case 'listening': {
        const secs = Math.round((Date.now() - this.startedAt) / 1000)
        const kb = Math.round(this.bytes / 1024)
        return {
          header: fit(`${name}  listening ${secs}s`, LINE_W),
          body: `${this.isShell() ? 'Say a shell command.' : 'Speak your prompt.'}\n\n${'#'.repeat(Math.min(40, secs))}\n${kb} KB captured`,
          footer: this.opts.pushToTalk ? 'release: transcribe   double-tap: cancel' : 'tap: stop & transcribe   double-tap: cancel',
        }
      }
      case 'transcribing':
        return { header: fit(`${name}  transcribing`, LINE_W), body: 'Transcribing on the bridge...', footer: 'double-tap: cancel' }
      case 'review': {
        const items = this.reviewItems()
        const heard = this.raw && this.raw !== this.text ? [fit(`heard: ${this.raw}`, LINE_W)] : []
        const textPages = paginate(this.text, LINE_W, Math.max(1, BODY_LINES - items.length - heard.length))
        const rows = items.map((it, i) => `${i === this.cursor ? '>' : ' '} ${it.label}`)
        return {
          header: fit(`${name}  ${this.isShell() ? 'review command' : 'review transcript'}`, LINE_W),
          body: `${[...heard, textPages[0]].join('\n')}\n${rows.join('\n')}`,
          footer: 'swipe: select   tap: run   double-tap: cancel',
        }
      }
      case 'failed':
        return { header: fit(`${name}  dictation failed`, LINE_W), body: this.error || 'unknown error', footer: 'tap or double-tap: back' }
    }
  }
}
