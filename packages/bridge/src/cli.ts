#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { CONFIG_PATH, MODELS_DIR, loadConfig, saveConfig } from './config.js'
import { SessionRegistry } from './sessions.js'
import { startServer } from './server.js'
import { installHooks, uninstallHooks, HOOK_EVENTS } from './hooks-install.js'
import { WHISPER_MODEL_URL, createStt } from './stt.js'
import { log } from './log.js'

const [, , cmd = 'start', ...rest] = process.argv

const HELP = `claudedeck — bridge between Claude Code sessions and the G2 glasses app

  claudedeck start                 run the bridge (WS + hook receiver)
  claudedeck install-hooks         add ClaudeDeck hooks (+ statusline if free) to ~/.claude/settings.json
  claudedeck uninstall-hooks       remove them again
  claudedeck info                  print connection details for the glasses app
  claudedeck token [--rotate]      print (or rotate) the shared secret
  claudedeck setup-stt [model]     download a whisper.cpp model (default: base.en)
  claudedeck install-service       create a launchd agent so the bridge runs at login (macOS)
  claudedeck status                list sessions the bridge currently sees
  claudedeck qr [--lan]            QR for the glasses app served by this bridge (Tailscale IP by default)
  claudedeck remote add <name> <ws-url> | rm <name> | ls
                                   relay another machine's bridge through this one (hub mode)

Config: ${CONFIG_PATH}
`

async function main(): Promise<void> {
  const cfg = loadConfig()
  switch (cmd) {
    case 'start': {
      const registry = new SessionRegistry(cfg)
      registry.start()
      const server = startServer(cfg, registry)
      const stt = createStt(cfg)
      log(`stt backend=${stt.name} available=${await stt.available()}`)
      log(`hook endpoint: http://127.0.0.1:${cfg.port}/hook`)
      const shutdown = () => {
        log('shutting down')
        registry.stop()
        server.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return
    }
    case 'install-hooks': {
      const r = installHooks(cfg, { statusline: !rest.includes('--no-statusline') })
      console.log(`Hooks written to ${r.settingsPath}`)
      if (r.backupPath) console.log(`Backup: ${r.backupPath}`)
      console.log(`Events: ${r.installedEvents.join(', ')}`)
      console.log(`Statusline: ${r.statusline}`)
      console.log('\nRestart running Claude Code sessions to pick up the hooks (existing tmux sessions are still discovered by scanning).')
      return
    }
    case 'uninstall-hooks': {
      const p = uninstallHooks(cfg)
      console.log(`ClaudeDeck hooks removed from ${p}`)
      return
    }
    case 'token': {
      if (rest.includes('--rotate')) {
        cfg.token = (await import('node:crypto')).randomBytes(18).toString('base64url')
        saveConfig(cfg)
      }
      console.log(cfg.token)
      return
    }
    case 'info': {
      const ts = tailscaleInfo()
      const lan = lanIp()
      console.log(`machine : ${cfg.machine}`)
      console.log(`port    : ${cfg.port}`)
      console.log(`token   : ${cfg.token}`)
      console.log('')
      console.log('Bridge URLs to enter in the ClaudeDeck app (phone page):')
      if (ts.ip) console.log(`  ws://${ts.ip}:${cfg.port}/ws?token=${cfg.token}        (Tailscale IP)`)
      if (ts.dns) console.log(`  ws://${ts.dns}:${cfg.port}/ws?token=${cfg.token}        (MagicDNS)`)
      if (lan) console.log(`  ws://${lan}:${cfg.port}/ws?token=${cfg.token}        (LAN)`)
      if (ts.dns) {
        console.log('')
        console.log('For TLS (needed once the app is packaged, not for dev sideload):')
        console.log(`  tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}`)
        console.log(`  → wss://${ts.dns}/ws?token=${cfg.token}`)
      }
      console.log('')
      const host = ts.ip ?? lan
      if (host) console.log(`Glasses app (served by this bridge, no dev server needed):\n  ${appUrl(host, cfg)}\n  → claudedeck qr`)
      console.log('')
      console.log(`Hooks installed: ${hooksInstalled(cfg.claudeConfigDir) ? 'yes' : 'no (run: claudedeck install-hooks)'}`)
      console.log(`Hook events: ${HOOK_EVENTS.length}`)
      console.log(`Remotes: ${cfg.remotes.length ? cfg.remotes.map(r => `${r.name} (${r.url.replace(/token=.*/, 'token=…')})`).join(', ') : 'none'}`)
      return
    }
    case 'qr': {
      const ts = tailscaleInfo()
      const lan = lanIp()
      const host = rest.includes('--lan') ? lan ?? ts.ip : ts.ip ?? lan
      if (!host) throw new Error('no usable IP address found')
      const url = appUrl(host, cfg)
      console.log(`\n${url}`)
      console.log(rest.includes('--lan') ? '(LAN address — phone must be on the same Wi-Fi)\n' : '(Tailscale address — phone needs the Tailscale app signed in to your tailnet)\n')
      const r = spawnSync('evenhub', ['qr', '--url', url], { stdio: 'inherit' })
      if (r.error) console.log('evenhub CLI not found (npm i -g @evenrealities/evenhub-cli) — paste the URL into any QR generator')
      return
    }
    case 'remote': {
      const [sub, name, url] = rest
      if (sub === 'ls' || !sub) {
        if (!cfg.remotes.length) console.log('no remotes')
        for (const r of cfg.remotes) console.log(`${r.name.padEnd(16)} ${r.url.replace(/token=.*/, 'token=…')}`)
        return
      }
      if (sub === 'add') {
        if (!name || !url || !/^wss?:\/\//.test(url)) throw new Error('usage: claudedeck remote add <name> <ws://host:7788/ws?token=...>')
        if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('name must be alphanumeric/-/_')
        cfg.remotes = [...cfg.remotes.filter(r => r.name !== name), { name, url }]
        saveConfig(cfg)
        console.log(`added remote ${name}. Restart the bridge to connect (launchctl kickstart -k gui/$(id -u)/com.claudedeck.bridge, or re-run claudedeck start).`)
        return
      }
      if (sub === 'rm') {
        cfg.remotes = cfg.remotes.filter(r => r.name !== name)
        saveConfig(cfg)
        console.log(`removed remote ${name}`)
        return
      }
      throw new Error('usage: claudedeck remote add|rm|ls')
    }
    case 'setup-stt': {
      const model = rest[0] ?? 'base.en'
      const file = `ggml-${model}.bin`
      const dest = path.join(MODELS_DIR, file)
      fs.mkdirSync(MODELS_DIR, { recursive: true })
      if (fs.existsSync(dest)) {
        console.log(`already present: ${dest}`)
      } else {
        const url = WHISPER_MODEL_URL + file
        console.log(`downloading ${url}`)
        const res = await fetch(url)
        if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
        const total = Number(res.headers.get('content-length') ?? 0)
        const tmp = dest + '.part'
        const out = fs.createWriteStream(tmp)
        let got = 0
        let lastPct = -1
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          out.write(chunk)
          got += chunk.length
          const pct = total ? Math.floor((got / total) * 100) : -1
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct
            process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB${total ? ` / ${(total / 1e6).toFixed(0)} MB (${pct}%)` : ''}   `)
          }
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
        fs.renameSync(tmp, dest)
        console.log(`\nsaved ${dest} (${(got / 1e6).toFixed(0)} MB)`)
      }
      cfg.stt.backend = 'whisper-cpp'
      cfg.stt.model = dest
      saveConfig(cfg)
      const stt = createStt(cfg)
      console.log(`whisper available: ${await stt.available()} (binary: whisper-cli — brew install whisper-cpp)`)
      return
    }
    case 'install-service': {
      if (process.platform !== 'darwin') throw new Error('install-service currently supports macOS launchd only')
      const label = 'com.claudedeck.bridge'
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
      const node = process.execPath
      const cli = new URL(import.meta.url).pathname
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.claudedeck', 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.claudedeck', 'launchd.err.log')}</string>
</dict></plist>
`
      fs.mkdirSync(path.dirname(plistPath), { recursive: true })
      fs.writeFileSync(plistPath, plist)
      console.log(`wrote ${plistPath}`)
      console.log(`load with:   launchctl load -w ${plistPath}`)
      console.log(`unload with: launchctl unload ${plistPath}`)
      return
    }
    case 'status': {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/sessions`).catch(() => null)
      if (!res || !res.ok) {
        console.log('bridge not running (start it with: claudedeck start)')
        return
      }
      const sessions = (await res.json()) as Array<Record<string, unknown>>
      if (!sessions.length) console.log('no sessions')
      for (const s of sessions) {
        console.log(`${String(s.status).padEnd(16)} ${String(s.name).padEnd(28)} pane=${s.pane ?? '-'} ${s.tool ? `[${(s.tool as { name: string }).name}] ` : ''}${s.lastLine ?? ''}`)
      }
      return
    }
    default:
      console.log(HELP)
  }
}

function appUrl(host: string, cfg: { port: number; token: string }): string {
  const bridge = `ws://${host}:${cfg.port}/ws?token=${cfg.token}`
  return `http://${host}:${cfg.port}/app/?bridge=${encodeURIComponent(bridge)}`
}

function hooksInstalled(claudeDir: string): boolean {
  try {
    const s = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')
    return s.includes('claudedeck-hook')
  } catch {
    return false
  }
}

function tailscaleInfo(): { ip?: string; dns?: string } {
  const bins = ['tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const b of bins) {
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

function lanIp(): string | undefined {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address
    }
  }
  return undefined
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
