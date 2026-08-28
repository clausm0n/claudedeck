import type { BridgeClient } from './net/client'
import type { Fleet, FleetSession } from './net/fleet'
import type { Frame } from './glasses/display'
import { makeEntry, saveBridges } from './storage'
import type { BridgeEntry } from './net/client'

/** Phone-side companion page: bridge configuration, status, glasses mirror. */
export function mountPhoneUi(fleet: Fleet, getBridges: () => BridgeEntry[], setBridges: (b: BridgeEntry[]) => void) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <div class="wrap">
      <header>
        <h1>ClaudeDeck</h1>
        <span class="muted" id="glassesState">glasses: waiting for bridge</span>
      </header>

      <section class="card">
        <h2>Bridges</h2>
        <div id="bridges"></div>
        <form id="addForm" autocomplete="off">
          <input id="bName" placeholder="Name (e.g. modusbook)" />
          <input id="bUrl" placeholder="ws://100.x.y.z:7788/ws?token=..." inputmode="url" />
          <button class="primary" type="submit">Add bridge</button>
        </form>
        <p class="muted">Run <code>claudedeck info</code> on each machine to get its URL. Tip: append <code>?bridge=&lt;url-encoded ws url&gt;</code> to this page's URL to add one automatically.</p>
      </section>

      <section class="card">
        <h2>Glasses mirror</h2>
        <pre class="glass" id="mirror"></pre>
      </section>

      <section class="card">
        <h2>Sessions</h2>
        <table id="sessions"><tbody></tbody></table>
      </section>

      <section class="card">
        <h2>Log</h2>
        <div class="log" id="log"></div>
      </section>
    </div>
  `

  const bridgesEl = app.querySelector<HTMLDivElement>('#bridges')!
  const logEl = app.querySelector<HTMLDivElement>('#log')!
  const mirrorEl = app.querySelector<HTMLPreElement>('#mirror')!
  const sessionsEl = app.querySelector<HTMLTableSectionElement>('#sessions tbody')!
  const glassesEl = app.querySelector<HTMLSpanElement>('#glassesState')!

  const renderBridges = () => {
    const entries = getBridges()
    if (!entries.length) {
      bridgesEl.innerHTML = '<div class="muted">No bridges yet.</div>'
      return
    }
    bridgesEl.innerHTML = entries
      .map(e => {
        const c = fleet.clients.get(e.id)
        const state = c?.state ?? 'closed'
        const extra = c?.state === 'open' ? ` · ${c.sessions.length} sessions${c.sttAvailable ? ' · STT' : ''}${c.tmux ? ' · tmux' : ''}` : c?.lastError ? ` · ${c.lastError}` : ''
        return `<div class="row" data-id="${e.id}">
          <div class="grow"><div class="name">${esc(c?.state === 'open' && c.machine ? c.machine : e.name)}</div><div class="url">${esc(maskToken(e.url))}</div></div>
          <span class="chip ${state}">${state}${esc(extra)}</span>
          <button class="danger" data-remove="${e.id}">Remove</button>
        </div>`
      })
      .join('')
  }

  bridgesEl.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove]')
    if (!btn) return
    const id = btn.dataset.remove!
    const next = getBridges().filter(e => e.id !== id)
    setBridges(next)
    saveBridges(next)
    fleet.configure(next)
    renderBridges()
  })

  app.querySelector<HTMLFormElement>('#addForm')!.addEventListener('submit', ev => {
    ev.preventDefault()
    const name = app.querySelector<HTMLInputElement>('#bName')!
    const url = app.querySelector<HTMLInputElement>('#bUrl')!
    if (!/^wss?:\/\//.test(url.value.trim())) {
      log('bridge URL must start with ws:// or wss://')
      return
    }
    const entry = makeEntry(name.value, url.value)
    const next = [...getBridges().filter(e => e.url !== entry.url), entry]
    setBridges(next)
    saveBridges(next)
    fleet.configure(next)
    name.value = ''
    url.value = ''
    renderBridges()
  })

  const lines: string[] = []
  const log = (msg: string) => {
    lines.push(`${new Date().toLocaleTimeString()} ${msg}`)
    if (lines.length > 80) lines.shift()
    logEl.textContent = lines.join('\n')
    logEl.scrollTop = logEl.scrollHeight
  }

  fleet.on('log', log)
  fleet.on('bridges', (_: BridgeClient[]) => renderBridges())
  fleet.on('sessions', (list: FleetSession[]) => {
    renderBridges()
    sessionsEl.innerHTML = list
      .map(
        s => `<tr>
          <td class="st ${s.status}">${esc(s.status)}</td>
          <td><b>${esc(s.name)}</b> <span class="muted">@${esc(s.machine)}${s.pane ? ` · ${esc(s.pane)}` : ' · no pane'}</span><br>
              <span class="muted">${esc(s.tool ? `${s.tool.name}: ${s.tool.summary}` : s.lastLine ?? '')}</span></td>
        </tr>`,
      )
      .join('')
  })

  renderBridges()

  return {
    log,
    setGlassesState: (text: string) => (glassesEl.textContent = `glasses: ${text}`),
    mirror: (f: Frame) => {
      mirrorEl.innerHTML = `<span class="hdr">${esc(f.header)}</span>\n${esc(f.body)}\n<span class="ftr">${esc(f.footer)}</span>`
    },
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function maskToken(url: string): string {
  return url.replace(/(token=)[^&]+/, '$1••••')
}
