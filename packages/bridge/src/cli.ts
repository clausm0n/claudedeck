#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import QRCode from 'qrcode'
import { CONFIG_DIR, CONFIG_PATH, MODELS_DIR, freshTokenWarning, loadConfig, saveConfig } from './config.js'
import { SessionRegistry } from './sessions.js'
import { startServer } from './server.js'
import { installHooks, uninstallHooks, HOOK_EVENTS } from './hooks-install.js'
import { WHISPER_MODEL_URL, createStt } from './stt.js'
import { installService, restartService, uninstallService } from './launchd.js'
import { formatReport, runDoctor } from './doctor.js'
import { healthUrlFor, repoRoot, updateLocal, updateRemote } from './update.js'
import { appUrl, bestUrl, lanIp, tailscaleInfo, tailscaleServe } from './netinfo.js'
import { VERSION } from './version.js'
import { log } from './log.js'

const [, , cmd = 'start', ...rest] = process.argv

const HELP = `claudedeck ${VERSION} — bridge between Claude Code sessions and the G2 glasses app

  claudedeck start                 run the bridge (WS + hook receiver)
  claudedeck doctor [--json]       check node, config, launchd, bridge, hooks, wrapper, tmux, remotes, tailscale
  claudedeck update                git pull + build + reinstall hooks/service (restarts the bridge)
  claudedeck restart               restart the launchd service (loads it when not loaded)
  claudedeck version               print the bridge version
  claudedeck install-hooks         add ClaudeDeck hooks (+ statusline if free) to ~/.claude/settings.json
  claudedeck uninstall-hooks       remove them again
  claudedeck info                  print connection details for the glasses app
  claudedeck url [--copy]          best bridge URL for the app (wss:// when Tailscale Serve fronts the bridge); --copy → clipboard
  claudedeck pair [--open]         QR code the installed app scans (phone page → Scan QR); --open shows a crisp one in the browser
  claudedeck token [--rotate]      print (or rotate) the shared secret
  claudedeck setup-stt [model]     download a whisper.cpp model (default: base.en)
  claudedeck install-service       create/refresh the launchd agent (stable node path) and (re)start it (macOS)
  claudedeck uninstall-service     stop and remove the launchd agent
  claudedeck status                list sessions the bridge currently sees
  claudedeck qr [--lan]            QR for the glasses app served by this bridge (Tailscale IP by default)
  claudedeck remote add <name> <ws-url> | rm <name> | ls
                                   relay another machine's bridge through this one (hub mode)
  claudedeck remote update <name> --ssh user@host [--path ~/claudedeck]
                                   git pull + build + reinstall on that machine over ssh

Config: ${CONFIG_PATH}
`

// launchd (and some cron/systemd setups) start us with a minimal PATH; tmux,
// whisper-cli and node from Homebrew/nvm would be invisible. Prepend the usual
// locations so child processes and hook scripts find them.
function widenPath(): void {
  const home = process.env.HOME ?? ''
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean)
  process.env.PATH = [...extra.filter(p => !cur.includes(p)), ...cur].join(':')
  // launchd gives a C locale; tmux sanitizes non-ASCII/non-printable output there.
  process.env.LANG ||= 'en_US.UTF-8'
  process.env.LC_ALL ||= 'en_US.UTF-8'
}

async function main(): Promise<void> {
  widenPath()
  const cfg = loadConfig()
  switch (cmd) {
    case 'start': {
      // Crashes must land in bridge.log (launchd.err.log is easy to miss) and
      // must still exit so launchd's KeepAlive restarts us with a clean registry.
      const fatal = (kind: string) => (err: unknown) => {
        log(`fatal ${kind}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        setTimeout(() => process.exit(1), 200).unref()
      }
      process.on('uncaughtException', fatal('uncaught exception'))
      process.on('unhandledRejection', fatal('unhandled rejection'))
      if (freshTokenWarning) log(`WARNING: ${freshTokenWarning}`)
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
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION)
      return
    case 'doctor': {
      const report = await runDoctor(cfg)
      if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2))
      else console.log(formatReport(report))
      if (freshTokenWarning) console.error(`\nWARNING: ${freshTokenWarning}`)
      process.exitCode = report.ok ? 0 : 1
      return
    }
    case 'update': {
      await updateLocal({ port: cfg.port, skipPull: rest.includes('--no-pull') })
      return
    }
    case 'restart': {
      const r = restartService()
      console.log(r.message)
      if (!r.ok) process.exitCode = 1
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
        console.error('(token rotated — re-pair the phone with `claudedeck pair`, and re-add this remote on any hub: claudedeck remote add <name> <new url>)')
      }
      console.log(cfg.token)
      return
    }
    case 'info': {
      const ts = tailscaleInfo()
      const lan = lanIp()
      console.log(`machine : ${cfg.machine}`)
      console.log(`version : ${VERSION}`)
      console.log(`port    : ${cfg.port}`)
      console.log(`token   : ${cfg.token}`)
      console.log('')
      const serve = tailscaleServe(cfg.port)
      console.log('Bridge URLs to enter in the ClaudeDeck app (phone page):')
      if (serve) console.log(`  ${serve}/ws?token=${cfg.token}        (Tailscale Serve, TLS — use this for the installed app)`)
      if (ts.ip) console.log(`  ws://${ts.ip}:${cfg.port}/ws?token=${cfg.token}        (Tailscale IP)`)
      if (ts.dns) console.log(`  ws://${ts.dns}:${cfg.port}/ws?token=${cfg.token}        (MagicDNS)`)
      if (lan) console.log(`  ws://${lan}:${cfg.port}/ws?token=${cfg.token}        (LAN)`)
      if (ts.dns && !serve) {
        console.log('')
        console.log('For TLS (needed once the app is packaged, not for dev sideload):')
        console.log(`  tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}`)
        console.log(`  → wss://${ts.dns}/ws?token=${cfg.token}`)
      }
      console.log('')
      console.log('Quickest way onto the phone: `claudedeck url --copy`, then paste into Add bridge (Universal Clipboard).')
      console.log('')
      const host = ts.ip ?? lan
      if (host) console.log(`Glasses app (served by this bridge, no dev server needed):\n  ${appUrl(host, cfg)}\n  → claudedeck qr`)
      console.log('')
      console.log(`Hooks installed: ${hooksInstalled(cfg.claudeConfigDir) ? 'yes' : 'no (run: claudedeck install-hooks)'}`)
      console.log(`Hook events: ${HOOK_EVENTS.length}`)
      console.log(`Remotes: ${cfg.remotes.length ? cfg.remotes.map(r => `${r.name} (${r.url.replace(/token=.*/, 'token=…')})`).join(', ') : 'none'}`)
      console.log('')
      console.log('Health check: claudedeck doctor')
      return
    }
    case 'url': {
      const { url, serve } = bestUrl(cfg, rest)
      console.log(url)
      if (rest.includes('--copy')) {
        const ok = copyToClipboard(url)
        console.error(ok ? '(copied to clipboard — paste it into the phone page, Universal Clipboard reaches the iPhone)' : '(no clipboard tool found: pbcopy / wl-copy / xclip)')
      } else if (!serve) {
        console.error('(plain ws:// — run `tailscale serve --bg --https=443 http://127.0.0.1:' + cfg.port + '` for a wss:// URL the installed app can use)')
      }
      return
    }
    case 'pair': {
      const { url, serve } = bestUrl(cfg, rest)
      // The installed app decodes this with its camera (phone page → Scan QR).
      const payload = `claudedeck://add?name=${encodeURIComponent(cfg.machine)}&url=${encodeURIComponent(url)}`
      const svgPath = path.join(CONFIG_DIR, 'pair.svg')
      const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 3 })
      fs.writeFileSync(svgPath, svg, { mode: 0o600 })
      if (rest.includes('--open')) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        const r = spawnSync(opener, [svgPath], { stdio: 'ignore' })
        console.log(r.error ? `could not open ${svgPath}: ${r.error.message}` : `Opened ${svgPath} — scan it from the browser window (phone page → Scan QR).`)
      } else {
        console.log(`\nPairing QR for ${cfg.machine} — open ClaudeDeck on the phone, tap "Scan QR", point the camera here.\n`)
        console.log(await QRCode.toString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }))
        console.log(`Camera struggling with the terminal rendering? \`claudedeck pair --open\` shows a crisp one (${svgPath}).`)
      }
      console.log(`${url.replace(/token=.*/, 'token=…')}${serve ? '' : '   (plain ws:// — see `claudedeck url` for TLS)'}`)
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
        if (cfg.remotes.length) console.log('\n(versions and reachability: claudedeck doctor)')
        return
      }
      if (sub === 'add') {
        if (!name || !url || !/^wss?:\/\//.test(url)) throw new Error('usage: claudedeck remote add <name> <ws://host:7788/ws?token=...>')
        if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('name must be alphanumeric/-/_')
        cfg.remotes = [...cfg.remotes.filter(r => r.name !== name), { name, url }]
        saveConfig(cfg)
        console.log(`added remote ${name}. Restart the bridge to connect: claudedeck restart`)
        return
      }
      if (sub === 'rm') {
        cfg.remotes = cfg.remotes.filter(r => r.name !== name)
        saveConfig(cfg)
        console.log(`removed remote ${name}. Restart the bridge to apply: claudedeck restart`)
        return
      }
      if (sub === 'update') {
        const ssh = flagValue(rest, '--ssh')
        if (!name || !ssh) throw new Error('usage: claudedeck remote update <name> --ssh user@host [--path ~/claudedeck]')
        const entry = cfg.remotes.find(r => r.name === name)
        if (!entry) console.error(`(no remote named ${name} in ${CONFIG_PATH} — updating ${ssh} anyway)`)
        await updateRemote({ name, ssh, path: flagValue(rest, '--path'), healthUrl: entry ? healthUrlFor(entry.url) : undefined })
        return
      }
      throw new Error('usage: claudedeck remote add|rm|ls|update')
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
      const r = installService()
      for (const m of r.messages) console.log(m)
      if (!r.running) {
        console.log(`\nNot running. Check: launchctl print gui/$(id -u)/com.claudedeck.bridge; tail ${path.join(CONFIG_DIR, 'launchd.err.log')}`)
        process.exitCode = 1
      } else {
        console.log(`bridge ${VERSION} from ${repoRoot()} — verify with: claudedeck doctor`)
      }
      return
    }
    case 'uninstall-service': {
      for (const m of uninstallService()) console.log(m)
      return
    }
    case 'status': {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/sessions`).catch(() => null)
      if (!res || !res.ok) {
        console.log('bridge not running (start it with: claudedeck restart, or claudedeck start in the foreground; diagnose with: claudedeck doctor)')
        return
      }
      const sessions = (await res.json()) as Array<Record<string, unknown>>
      if (!sessions.length) console.log('no sessions')
      for (const s of sessions) {
        console.log(`${String(s.status).padEnd(16)} ${String(s.name).padEnd(28)} pane=${s.pane ?? '-'} ${s.tool ? `[${(s.tool as { name: string }).name}] ` : ''}${s.lastLine ?? ''}`)
      }
      return
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      if (cmd !== 'help') console.error(`unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exitCode = cmd === 'help' ? 0 : 1
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i >= 0) return args[i + 1]
  const eq = args.find(a => a.startsWith(`${flag}=`))
  return eq?.slice(flag.length + 1)
}

function hooksInstalled(claudeDir: string): boolean {
  try {
    const s = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')
    return s.includes('claudedeck-hook')
  } catch {
    return false
  }
}

function copyToClipboard(text: string): boolean {
  for (const [bin, args] of [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']]] as Array<[string, string[]]>) {
    const r = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    if (!r.error && r.status === 0) return true
  }
  return false
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
