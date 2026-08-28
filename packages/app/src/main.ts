import { AudioInputSource, OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Display } from './glasses/display'
import { UI, type ScreenContext } from './glasses/ui'
import { SessionsScreen } from './glasses/screens/sessions'
import { SessionScreen } from './glasses/screens/session'
import { DictateScreen } from './glasses/screens/dictate'
import { RawScreen } from './glasses/screens/raw'
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
]

// ───────────────────────── phone side first (works even without the Even host) ─────────────────────────
const fleet = new Fleet()
let bridges: BridgeEntry[] = mergeBridges(loadBridgesSync(), bridgesFromQuery())
const phone = mountPhoneUi(
  fleet,
  () => bridges,
  next => (bridges = next),
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
  if (!ok && on) throw new Error('audioControl refused (check g2-microphone permission)')
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

window.addEventListener('beforeunload', cleanup)
