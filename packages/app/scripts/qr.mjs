#!/usr/bin/env node
// Prints a QR for the dev server with the local bridge pre-configured:
//   npm run app:qr                → LAN IP for the Vite server, Tailscale IP for the bridge
//   npm run app:qr -- --ts        → Tailscale IP for both (phone on the tailnet, any network)
//   npm run app:qr -- --lan       → LAN IP for both (phone on the same Wi-Fi, no Tailscale on the phone)
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const useTs = args.includes('--ts')
const useLan = args.includes('--lan')
const port = 5173

function tailscaleIp() {
  for (const b of ['tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      return execFileSync(b, ['ip', '-4'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0]
    } catch {}
  }
  return null
}
function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address
  }
  return null
}

const cfgPath = path.join(os.homedir(), '.claudedeck', 'config.json')
let cfg = null
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
} catch {
  console.error(`no bridge config at ${cfgPath} — start the bridge once (npm run bridge) first`)
}

const ts = tailscaleIp()
const lan = lanIp()
const devHost = useTs ? ts : lan ?? ts
if (!devHost) {
  console.error('could not determine an IP address')
  process.exit(1)
}
let url = `http://${devHost}:${port}/`
if (cfg) {
  const bridgeHost = useLan ? lan ?? ts : useTs ? ts : ts ?? lan
  const bridgeUrl = `ws://${bridgeHost}:${cfg.port}/ws?token=${cfg.token}`
  url += `?bridge=${encodeURIComponent(bridgeUrl)}`
}
console.log(`\nDev URL: ${url}`)
console.log(`Bridge via ${useLan ? 'LAN' : 'Tailscale'} IP — the phone must be able to reach it (${useLan ? 'same Wi-Fi' : 'Tailscale app running on the phone'}).\n`)
const r = spawnSync('evenhub', ['qr', '--url', url], { stdio: 'inherit' })
if (r.error) {
  console.error('evenhub CLI not found — install with: npm i -g @evenrealities/evenhub-cli')
}
