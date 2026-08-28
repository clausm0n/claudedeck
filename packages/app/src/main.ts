import { AudioInputSource, OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import jsQR from 'jsqr'
import { Display } from './glasses/display'
import { UI, type ScreenContext } from './glasses/ui'
import { SessionsScreen } from './glasses/screens/sessions'
import { SessionScreen } from './glasses/screens/session'
import { DictateScreen } from './glasses/screens/dictate'
import { RawScreen } from './glasses/screens/raw'
import { HiddenScreen } from './glasses/screens/hidden'
import { runAction } from './glasses/screens/actions'
import { Fleet } from './net/fleet'
import type { BridgeEntry } from './net/client'
import { mountPhoneUi } from './phone'
import { attachStorage, bridgesFromQuery, loadBridgesFromHost, loadBridgesSync, mergeBridges, saveBridges } from './storage'

// ───────────────────────── contextual menu (tap, then long press) ─────────────────────────
const MENU = {
  APPROVE: 1,
  APPROVE_ALL: 2,
  DENY: 3,
  INTERRUPT: 4,
  CONTINUE: 5,
  DICTATE: 6,
  RAW: 7,
  SESSIONS: 8,
  RECONNECT: 9,
  HIDE: 10,
} as const

const MENU_ITEMS = [
  { id: MENU.APPROVE, label: 'Approve (y)' },
  { id: MENU.APPROVE_ALL, label: 'Approve all similar' },
  { id: MENU.DENY, label: 'Deny / Esc' },
  { id: MENU.INTERRUPT, label: 'Interrupt' },
  { id: MENU.CONTINUE, label: 'Send "continue"' },
  { id: MENU.DICTATE, label: 'Dictate prompt' },
  { id: MENU.RAW, label: 'Raw terminal' },
  { id: MENU.SESSIONS, label: 'All sessions' },
  { id: MENU.RECONNECT, label: 'Reconnect bridges' },
  { id: MENU.HIDE, label: 'Hide display' },
]

// ───────────────────────── phone side first (works even without the Even host) ─────────────────────────
const fleet = new Fleet()
let bridges: BridgeEntry[] = mergeBridges(loadBridgesSync(), bridgesFromQuery())
let hostBridge: EvenAppBridge | null = null

function decodeFrame(ctx2d: CanvasRenderingContext2D, canvas: HTMLCanvasElement): string | null {
  const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data ?? null
}

/**
 * Live viewfinder: the WebView's own camera stream, scanned ~5×/s until a code
 * is read or the user cancels. Throws when the WebView refuses the camera.
 */
async function scanLive(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable in this WebView')
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  })
  const overlay = document.createElement('div')
  overlay.className = 'scan-overlay'
  overlay.innerHTML = `<video playsinline autoplay muted></video><div class="scan-hint">Point at the QR from <code>claudedeck pair</code></div><button type="button">Cancel</button>`
  document.body.appendChild(overlay)
  const video = overlay.querySelector('video')!
  video.srcObject = stream
  await video.play()
  const canvas = document.createElement('canvas')
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!
  return new Promise<string | null>(resolve => {
    let done = false
    let frames = 0
    const finish = (v: string | null) => {
      if (done) return
      done = true
      clearInterval(timer)
      clearTimeout(giveUp)
      stream.getTracks().forEach(t => t.stop())
      overlay.remove()
      phone.log(`live scan ${v ? 'read a code' : 'stopped'} after ${frames} frames`)
      resolve(v)
    }
    overlay.querySelector('button')!.onclick = () => finish(null)
    const timer = window.setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth) return
      frames++
      const scale = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height)
      const hit = decodeFrame(ctx2d, canvas)
      if (hit) finish(hit)
    }, 200)
    const giveUp = window.setTimeout(() => finish(null), 120_000)
  })
}

/** Fallback: one photo through the Even host camera, decoded at several scales/crops. */
async function scanPhoto(): Promise<string | null> {
  if (!hostBridge) throw new Error('Even host not ready yet')
  const shot = await Promise.race([
    hostBridge.captureImageFromCamera(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the Even host never returned a photo (2 min)')), 120_000)),
  ])
  if (!shot) return null
  const b64 = shot.base64 ?? ''
  phone.log(`host camera returned: type=${shot.mimeType || '?'} size=${shot.size ?? '?'} base64=${b64.length} chars path=${shot.path || '-'}`)
  if (!b64) throw new Error('camera returned no image data')
  const img = new Image()
  img.src = b64.startsWith('data:') ? b64 : `data:${shot.mimeType || 'image/jpeg'};base64,${b64}`
  try {
    await img.decode()
  } catch {
    throw new Error(`cannot decode the photo (${shot.mimeType || 'unknown type'})`)
  }
  phone.log(`photo ${img.naturalWidth}x${img.naturalHeight} — decoding`)
  const canvas = document.createElement('canvas')
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx2d) throw new Error('no canvas')
  const w = img.naturalWidth
  const h = img.naturalHeight
  const attempts: Array<{ crop: number; maxDim: number }> = [
    { crop: 1, maxDim: 800 },
    { crop: 1, maxDim: 1200 },
    { crop: 1, maxDim: 1700 },
    { crop: 0.6, maxDim: 1400 },
    { crop: 0.4, maxDim: 1400 },
  ]
  for (const { crop, maxDim } of attempts) {
    const sw = Math.round(w * crop)
    const sh = Math.round(h * crop)
    const scale = Math.min(1, maxDim / Math.max(sw, sh))
    canvas.width = Math.max(1, Math.round(sw * scale))
    canvas.height = Math.max(1, Math.round(sh * scale))
    ctx2d.drawImage(img, Math.round((w - sw) / 2), Math.round((h - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height)
    const hit = decodeFrame(ctx2d, canvas)
    if (hit) {
      phone.log(`QR found (crop ${crop}, ${canvas.width}x${canvas.height})`)
      return hit
    }
  }
  throw new Error('no QR code in the photo — fill the frame with the code, hold still, avoid glare')
}

/** Scan a pairing QR: live viewfinder when the WebView grants the camera, else one host photo. */
async function scanQr(): Promise<string | null> {
  try {
    return await scanLive()
  } catch (err) {
    phone.log(`live camera unavailable (${(err as Error).message}) — falling back to a photo`)
  }
  return scanPhoto()
}

const phone = mountPhoneUi(
  fleet,
  () => bridges,
  next => (bridges = next),
  { scanQr },
)
if (bridgesFromQuery().length) saveBridges(bridges)
fleet.configure(bridges)
phone.log(`configured ${bridges.length} bridge(s)`)

// Any uncaught failure in the startup path would otherwise leave the glasses
// frozen on the first frame with no clue on the phone page.
window.addEventListener('unhandledrejection', ev => phone.log(`unhandled: ${(ev.reason as Error)?.message ?? ev.reason}`))
window.addEventListener('error', ev => phone.log(`error: ${ev.message}`))

// ───────────────────────── glasses side ─────────────────────────
phone.setGlassesState('waiting for Even bridge')
const evenBridge: EvenAppBridge = await waitForEvenAppBridge()
hostBridge = evenBridge
attachStorage(evenBridge)
phone.setGlassesState('bridge ready, creating page')
phone.log('Even bridge ready')

// Host-side storage may hold bridges that window.localStorage lost.
const hostBridges = await loadBridgesFromHost().catch(() => null)
if (hostBridges && hostBridges.length) {
  bridges = mergeBridges(hostBridges, bridges)
  saveBridges(bridges)
  fleet.configure(bridges)
  phone.log(`restored ${hostBridges.length} bridge(s) from host storage`)
}

let micOn = false
async function mic(on: boolean): Promise<void> {
  if (micOn === on) return
  const ok = await evenBridge.audioControl(on, AudioInputSource.Glasses)
  if (!ok && on) {
    // The host only hands out the glasses mic after a *successful* startup page
    // create (SDK README: "Glasses MIC returns false → create the startup page first").
    throw new Error(
      created === 0
        ? 'host refused the glasses mic (g2-microphone permission?)'
        : `host refused the glasses mic: startup page result ${created} — relaunch the app`,
    )
  }
  micOn = on
}

const display = new Display(evenBridge, MENU_ITEMS)
display.onFrame = f => phone.mirror(f)

const ui = new UI(display, () => void evenBridge.shutDownPageContainer(1))
const ctx: ScreenContext = { fleet, ui, mic }

const root = new SessionsScreen(ctx)
const t0 = Date.now()
const created = await display.start({
  header: 'ClaudeDeck',
  body: 'Page created. Loading sessions...',
  footer: ' ',
})
// The simulator has been seen to report `1` (invalid) while still rendering
// the page; on hardware a non-zero result means the mic/IMU calls will fail.
console.log('[ClaudeDeck] createStartUpPageContainer result:', created)
phone.log(`createStartUpPageContainer → ${created === 0 ? 'ok' : `result ${created}`} in ${Date.now() - t0}ms`)
phone.setGlassesState(created === 0 ? 'page created' : `page result ${created}`)
ui.push(root)

// ───────────────────────── event routing ─────────────────────────
// CLICK_EVENT is 0 and protobuf drops zero-valued fields, so a bare tap
// arrives with eventType undefined. Resolve the default *inside* the envelope.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function onMenu(itemID: number): void {
  const key = ui.currentKey()
  const need = (fn: (k: string) => void) => {
    if (!key) {
      ui.toast('no session selected')
      return
    }
    fn(key)
  }
  switch (itemID) {
    case MENU.APPROVE:
      return need(k => runAction(ctx, k, 'approve', 'approve'))
    case MENU.APPROVE_ALL:
      return need(k => runAction(ctx, k, 'approve_all', 'approve all'))
    case MENU.DENY:
      return need(k => runAction(ctx, k, 'deny', 'deny'))
    case MENU.INTERRUPT:
      return need(k => runAction(ctx, k, 'interrupt', 'interrupt'))
    case MENU.CONTINUE:
      return need(k => runAction(ctx, k, 'continue', 'continue'))
    case MENU.DICTATE:
      return need(k => ui.push(new DictateScreen(ctx, k, { pushToTalk: false })))
    case MENU.RAW:
      return need(k => ui.push(new RawScreen(ctx, k)))
    case MENU.SESSIONS:
      ui.popTo('sessions')
      return
    case MENU.RECONNECT:
      fleet.kickAll()
      ui.toast('reconnecting...')
      return
    case MENU.HIDE:
      ui.hide(() => new HiddenScreen(ctx))
      return
  }
}

let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  void mic(false).catch(() => {})
  fleet.closeAll()
  unsubscribe()
}

const unsubscribe = evenBridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    ui.audio(pcm)
    return
  }
  const menuId = event.menuItemClickEvent?.itemID
  if (menuId !== undefined) {
    onMenu(menuId)
    return
  }

  const sysType = typeOf(event.sysEvent)
  const textType = typeOf(event.textEvent)
  const listType = typeOf(event.listEvent)

  // Double-tap is checked first: it's a non-zero id and must beat the CLICK fallback.
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT || listType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    ui.doubleClick()
    return
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) return ui.scroll('up')
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) return ui.scroll('down')
  if (sysType === OsEventTypeList.LONG_PRESS_EVENT) return ui.longPress()
  if (sysType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return ui.longPressRelease()
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) return ui.click()

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    fleet.kickAll()
    ui.refresh()
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) return
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

// Open a session directly when the fleet reports exactly one needing attention
// and we're still on the root list (keeps "glance → approve" to two taps).
fleet.on('sessions', list => {
  if (ui.current?.name !== 'sessions') return
  const needs = list.filter(s => s.status === 'needs_permission')
  if (needs.length === 1 && list.length === 1) ui.push(new SessionScreen(ctx, needs[0].key))
})

// Bridge replies to actions/sends arrive asynchronously — show failures.
fleet.on('ack', a => {
  if (!a.ok) ui.toast(`${a.of} failed: ${a.message ?? 'unknown error'}`, 4000)
})

window.addEventListener('beforeunload', cleanup)
