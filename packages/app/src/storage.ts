import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { BridgeEntry } from './net/client'

const KEY = 'claudedeck.bridges.v1'

let evenBridge: EvenAppBridge | null = null

export function attachStorage(bridge: EvenAppBridge): void {
  evenBridge = bridge
}

export function loadBridgesSync(): BridgeEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? normalize(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

/** Host-side storage survives WebView reloads that wipe window.localStorage. */
export async function loadBridgesFromHost(): Promise<BridgeEntry[] | null> {
  if (!evenBridge) return null
  try {
    const raw = await withTimeout(evenBridge.getLocalStorage(KEY), 3000)
    if (!raw) return null
    return normalize(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveBridges(entries: BridgeEntry[]): void {
  const json = JSON.stringify(entries)
  try {
    window.localStorage.setItem(KEY, json)
  } catch {
    /* ignore */
  }
  if (evenBridge) void withTimeout(evenBridge.setLocalStorage(KEY, json), 3000).catch(() => {})
}

/** `?bridge=<encoded ws url>` (repeatable) seeds bridges — handy with `evenhub qr`. */
export function bridgesFromQuery(): BridgeEntry[] {
  const params = new URLSearchParams(window.location.search)
  const out: BridgeEntry[] = []
  for (const raw of params.getAll('bridge')) {
    const url = raw.trim()
    if (!/^wss?:\/\//.test(url)) continue
    out.push({ id: idFor(url), name: nameFor(url), url })
  }
  return out
}

/**
 * Decode what a scanned QR (or pasted text) says about a bridge:
 * `claudedeck://add?name=…&url=…` from `claudedeck pair`, a bare ws(s):// URL,
 * or the dev-sideload app URL carrying `?bridge=…` from `claudedeck qr`.
 */
export function parsePairing(text: string): BridgeEntry | null {
  const t = text.trim()
  const m = t.match(/^claudedeck:\/\/add\?(.*)$/i)
  if (m) {
    const q = new URLSearchParams(m[1])
    const url = (q.get('url') ?? '').trim()
    if (!/^wss?:\/\//.test(url)) return null
    return makeEntry(q.get('name') ?? '', url)
  }
  if (/^wss?:\/\//i.test(t)) return makeEntry('', t)
  if (/^https?:\/\//i.test(t)) {
    try {
      const b = new URL(t).searchParams.get('bridge')
      if (b && /^wss?:\/\//.test(b)) return makeEntry('', b)
    } catch {
      /* not a URL */
    }
  }
  return null
}

/**
 * Later entries win. Two URLs carrying the same token are the same bridge
 * reached via different addresses (LAN vs Tailscale) — keep only the newest
 * so a re-scanned QR replaces a stale address instead of adding a dead twin.
 */
export function mergeBridges(a: BridgeEntry[], b: BridgeEntry[]): BridgeEntry[] {
  const byKey = new Map<string, BridgeEntry>()
  for (const e of [...a, ...b]) byKey.set(tokenOf(e.url) ?? e.url, e)
  return [...byKey.values()]
}

function tokenOf(url: string): string | null {
  const m = url.match(/[?&]token=([^&]+)/)
  return m ? m[1] : null
}

export function makeEntry(name: string, url: string): BridgeEntry {
  return { id: idFor(url), name: name.trim() || nameFor(url), url: url.trim() }
}

function normalize(v: unknown): BridgeEntry[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(e => e && typeof e.url === 'string')
    .map(e => ({ id: e.id || idFor(e.url), name: e.name || nameFor(e.url), url: e.url }))
}

function idFor(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0
  return 'b' + (h >>> 0).toString(36)
}

function nameFor(url: string): string {
  try {
    const host = new URL(url).hostname
    // Keep a full IP so the glasses show which address is being tried.
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : host.split('.')[0]
  } catch {
    return 'bridge'
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}
