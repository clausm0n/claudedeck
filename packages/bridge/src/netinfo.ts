import os from 'node:os'
import { execFileSync } from 'node:child_process'

const TAILSCALE_BINS = ['tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

export function tailscaleInfo(): { ip?: string; dns?: string } {
  for (const b of TAILSCALE_BINS) {
    try {
      const ip = execFileSync(b, ['ip', '-4'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0]
      let dns: string | undefined
      try {
        const st = JSON.parse(execFileSync(b, ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
        dns = (st?.Self?.DNSName as string | undefined)?.replace(/\.$/, '')
      } catch {
        /* ignore */
      }
      return { ip, dns }
    } catch {
      /* try next */
    }
  }
  return {}
}

/** `wss://<host>` when `tailscale serve` fronts this bridge's port with HTTPS, else undefined. */
export function tailscaleServe(port: number): string | undefined {
  for (const b of TAILSCALE_BINS) {
    try {
      const st = JSON.parse(execFileSync(b, ['serve', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      }
      for (const [hostPort, site] of Object.entries(st.Web ?? {})) {
        for (const h of Object.values(site.Handlers ?? {})) {
          if (h.Proxy && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(h.Proxy) && new URL(h.Proxy).port === String(port)) {
            return `wss://${hostPort.replace(/:443$/, '')}`
          }
        }
      }
      return undefined
    } catch {
      /* try next */
    }
  }
  return undefined
}

export function lanIp(): string | undefined {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address
    }
  }
  return undefined
}

/** The URL the app should use: Tailscale Serve (wss) when active, else ws:// on the Tailscale IP, else LAN. */
export function bestUrl(cfg: { port: number; token: string }, flags: string[]): { url: string; serve: boolean } {
  const ts = tailscaleInfo()
  const lan = lanIp()
  const serve = tailscaleServe(cfg.port)
  let base: string | undefined
  if (flags.includes('--lan')) base = lan && `ws://${lan}:${cfg.port}`
  else if (flags.includes('--ts') || flags.includes('--ws')) base = ts.ip && `ws://${ts.ip}:${cfg.port}`
  else base = serve ?? (ts.ip ? `ws://${ts.ip}:${cfg.port}` : lan ? `ws://${lan}:${cfg.port}` : undefined)
  if (!base) throw new Error('no usable address found (no Tailscale Serve, Tailscale IP or LAN IP)')
  return { url: `${base}/ws?token=${cfg.token}`, serve: !!serve && base === serve }
}

export function appUrl(host: string, cfg: { port: number; token: string }): string {
  const bridge = `ws://${host}:${cfg.port}/ws?token=${cfg.token}`
  return `http://${host}:${cfg.port}/app/?bridge=${encodeURIComponent(bridge)}`
}
