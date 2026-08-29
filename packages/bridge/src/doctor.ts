import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import WebSocket from 'ws'
import type { BridgeConfig } from './config.js'
import { CONFIG_DIR, CONFIG_PATH, LOG_PATH } from './config.js'
import { HOOK_EVENTS, hookCommand, ourHookCommands, statuslineCommand } from './hooks-install.js'
import { cliPath, plistPath, readPlist, serviceStatus } from './launchd.js'
import { tailscaleInfo, tailscaleServe } from './netinfo.js'
import { createStt } from './stt.js'
import { repoRoot } from './update.js'
import { MIN_REMOTE_VERSION, VERSION, compareVersions } from './version.js'
import { PROTOCOL_VERSION } from '@claudedeck/shared'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  /** What to run/do to fix it. */
  hint?: string
}

export interface DoctorReport {
  machine: string
  version: string
  checkout: string
  checks: Check[]
  ok: boolean
}

const MB = 1024 * 1024

/** Every check the bridge's health depends on, each with a fix hint. Never throws. */
export async function runDoctor(cfg: BridgeConfig): Promise<DoctorReport> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const root = repoRoot()

  // ── runtime ──
  const major = Number(process.versions.node.split('.')[0])
  add({
    name: 'node',
    status: major >= 22 ? 'pass' : 'fail',
    detail: `${process.versions.node} at ${process.execPath}`,
    hint: major >= 22 ? undefined : 'install Node >= 22 (brew install node)',
  })

  add(checkCheckout(root))
  add(checkConfig(cfg))

  // ── daemon ──
  const health = await fetchHealth(cfg.port)
  if (process.platform === 'darwin') checks.push(...checkLaunchd(health.ok))
  add(await checkBridge(cfg, health))

  // ── hooks, statusline, wrapper ──
  checks.push(...checkHooks(cfg))
  checks.push(...checkWrapper(root))
  add(await checkTmux(cfg, health))
  add(await checkStt(cfg))

  // ── network ──
  checks.push(...checkTailscale(cfg))
  checks.push(...(await checkRemotes(cfg, health)))

  add(checkLogs())

  return { machine: cfg.machine, version: VERSION, checkout: root, checks, ok: !checks.some(c => c.status === 'fail') }
}

export function formatReport(r: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' }
  const lines = [`claudedeck doctor — ${r.machine}, claudedeck ${r.version}, ${r.checkout}`]
  for (const c of r.checks) {
    lines.push(`  ${mark[c.status]}  ${c.name.padEnd(12)} ${c.detail}`)
    if (c.hint && c.status !== 'pass') lines.push(`        → ${c.hint}`)
  }
  const n = (s: CheckStatus) => r.checks.filter(c => c.status === s).length
  lines.push('')
  lines.push(`${n('pass')} ok, ${n('warn')} warning${n('warn') === 1 ? '' : 's'}, ${n('fail')} failure${n('fail') === 1 ? '' : 's'}`)
  return lines.join('\n')
}

// ───────────────────────── individual checks ─────────────────────────

function checkCheckout(root: string): Check {
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return r.status === 0 ? r.stdout.trim() : undefined
  }
  const head = git(['rev-parse', '--short', 'HEAD'])
  if (!head) return { name: 'checkout', status: 'pass', detail: `${root} (not a git checkout)` }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length
  const behind = git(['rev-list', '--count', 'HEAD..@{u}'])
  const detail = `${root} @ ${head}${branch ? ` (${branch})` : ''}${dirty ? `, ${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : ''}${behind && behind !== '0' ? `, ${behind} commit(s) behind upstream` : ''}`
  if (behind && behind !== '0') return { name: 'checkout', status: 'warn', detail, hint: 'claudedeck update  (git pull + build + reinstall hooks/service)' }
  return { name: 'checkout', status: 'pass', detail }
}

function checkConfig(cfg: BridgeConfig): Check {
  if (!fs.existsSync(CONFIG_PATH)) return { name: 'config', status: 'fail', detail: `${CONFIG_PATH} missing`, hint: 'run any claudedeck command to create it, then re-pair the phone (claudedeck pair)' }
  let mode = ''
  try {
    const m = fs.statSync(CONFIG_PATH).mode & 0o777
    if (m & 0o044) mode = `, mode ${m.toString(8)} is group/world readable`
  } catch {
    /* ignore */
  }
  const detail = `${CONFIG_PATH} (port ${cfg.port}, machine ${cfg.machine}, token ${cfg.token ? 'set' : 'MISSING'}${mode})`
  if (!cfg.token) return { name: 'config', status: 'fail', detail, hint: 'claudedeck token --rotate' }
  if (mode) return { name: 'config', status: 'warn', detail, hint: `chmod 600 ${CONFIG_PATH}` }
  return { name: 'config', status: 'pass', detail }
}

function checkLaunchd(bridgeUp: boolean): Check[] {
  const out: Check[] = []
  const p = plistPath()
  const plist = readPlist(p)
  if (!plist) {
    out.push({
      name: 'launchd',
      status: bridgeUp ? 'warn' : 'fail',
      detail: `${p} not installed${bridgeUp ? ' (bridge is running some other way)' : ''}`,
      hint: 'claudedeck install-service',
    })
    return out
  }
  const problems: string[] = []
  let status: CheckStatus = 'pass'
  let hint: string | undefined
  if (!plist.program || !fs.existsSync(plist.program)) {
    status = 'fail'
    problems.push(`program ${plist.program ?? '(none)'} does not exist (removed by brew upgrade?)`)
    hint = 'claudedeck install-service  (rewrites the plist with a stable node path and restarts)'
  } else if (plist.program.includes('/Cellar/')) {
    status = 'warn'
    problems.push(`program is a versioned Homebrew path (${plist.program}) — breaks on the next brew upgrade node`)
    hint = 'claudedeck install-service'
  }
  if (plist.cli && plist.cli !== cliPath()) {
    status = status === 'fail' ? 'fail' : 'warn'
    problems.push(`runs ${plist.cli}, not this checkout`)
    hint ??= 'claudedeck install-service  (from the checkout you want launchd to run)'
  }
  if (!plist.env.CLAUDEDECK_LAUNCHD) {
    status = status === 'fail' ? 'fail' : 'warn'
    problems.push('plist predates 0.4.0 (no ThrottleInterval/ProcessType, duplicated logs)')
    hint ??= 'claudedeck install-service'
  }
  out.push({ name: 'plist', status, detail: problems.length ? problems.join('; ') : `${p} → ${plist.program}`, hint })

  const st = serviceStatus()
  if (!st.loaded) {
    out.push({ name: 'launchd', status: 'fail', detail: 'service not loaded in launchd', hint: 'claudedeck restart  (bootstraps the plist when it is not loaded)' })
  } else if (!st.pid) {
    out.push({
      name: 'launchd',
      status: 'fail',
      detail: `loaded but not running (state ${st.state ?? '?'}, last exit ${st.lastExitCode ?? '?'}, ${st.runs ?? '?'} runs)`,
      hint: `tail ${path.join(CONFIG_DIR, 'launchd.err.log')}; then claudedeck restart`,
    })
  } else {
    out.push({ name: 'launchd', status: 'pass', detail: `running, pid ${st.pid}, ${st.runs ?? '?'} run${st.runs === 1 ? '' : 's'} since login` })
  }
  return out
}

interface Health {
  ok: boolean
  reachable: boolean
  /** Something answered on the port but it is not a claudedeck bridge. */
  foreign?: boolean
  version?: string
  machine?: string
  sessions?: number
  remotes?: Array<{ name: string; state: string; version?: string; outdated?: boolean; error?: string; sessions?: number }>
  tmux?: boolean
  tmuxError?: string
  sessionsList?: Array<{ pane?: string; kind?: string; source?: string; status?: string }>
}

async function fetchHealth(port: number): Promise<Health> {
  const base = `http://127.0.0.1:${port}`
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    const text = await res.text()
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text)
    } catch {
      return { ok: false, reachable: true, foreign: true }
    }
    if (!j || typeof j.version !== 'string') return { ok: false, reachable: true, foreign: true }
    const h: Health = {
      ok: true,
      reachable: true,
      version: j.version as string,
      machine: j.machine as string,
      sessions: j.sessions as number,
      remotes: (j.remotes as Health['remotes']) ?? [],
    }
    try {
      const dbg = (await (await fetch(`${base}/debug`, { signal: AbortSignal.timeout(4000) })).json()) as { tmux?: boolean; tmuxError?: string; sessions?: Health['sessionsList'] }
      h.tmux = dbg.tmux
      h.tmuxError = dbg.tmuxError
      h.sessionsList = dbg.sessions
    } catch {
      /* /debug is loopback-only; fine without it */
    }
    return h
  } catch {
    const open = await portOpen(port)
    return { ok: false, reachable: open, foreign: open }
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(1500, () => done(false))
  })
}

async function checkBridge(cfg: BridgeConfig, h: Health): Promise<Check> {
  if (!h.ok) {
    if (h.foreign) return { name: 'bridge', status: 'fail', detail: `port ${cfg.port} is in use by something that is not a claudedeck bridge (or a bridge from another home dir)`, hint: `lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN; change "port" in ${CONFIG_PATH} or stop the other process` }
    return { name: 'bridge', status: 'fail', detail: `nothing listening on 127.0.0.1:${cfg.port}`, hint: process.platform === 'darwin' ? 'claudedeck restart  (or claudedeck install-service)' : 'claudedeck start' }
  }
  const detail = `${h.machine} ${h.version} on :${cfg.port}, ${h.sessions ?? 0} session${h.sessions === 1 ? '' : 's'}`
  if (h.version !== VERSION) return { name: 'bridge', status: 'warn', detail: `${detail} — this dist is ${VERSION}`, hint: 'claudedeck restart  (the running daemon is older than the built code)' }
  return { name: 'bridge', status: 'pass', detail }
}

function checkHooks(cfg: BridgeConfig): Check[] {
  const settingsPath = path.join(cfg.claudeConfigDir, 'settings.json')
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return [{ name: 'hooks', status: 'fail', detail: `${settingsPath} missing or unreadable`, hint: 'claudedeck install-hooks' }]
  }
  const missing: string[] = []
  const wrong: string[] = []
  for (const ev of HOOK_EVENTS) {
    const ours = ourHookCommands(settings, ev)
    if (!ours.length) missing.push(ev)
    else if (!ours.includes(hookCommand(ev))) wrong.push(ev)
  }
  const out: Check[] = []
  if (missing.length === HOOK_EVENTS.length) out.push({ name: 'hooks', status: 'fail', detail: `no ClaudeDeck hooks in ${settingsPath}`, hint: 'claudedeck install-hooks' })
  else if (missing.length || wrong.length) {
    out.push({
      name: 'hooks',
      status: 'warn',
      detail: `${missing.length ? `missing: ${missing.join(', ')}` : ''}${missing.length && wrong.length ? '; ' : ''}${wrong.length ? `pointing at another checkout or not async: ${wrong.join(', ')}` : ''}`,
      hint: 'claudedeck install-hooks  (then restart running Claude Code sessions)',
    })
  } else out.push({ name: 'hooks', status: 'pass', detail: `${HOOK_EVENTS.length} events → ${hookCommand('<event>').replace(' <event>', '')}` })

  const sl = settings.statusLine as { command?: string } | undefined
  if (!sl?.command) out.push({ name: 'statusline', status: 'warn', detail: 'no statusLine configured (model/context% and pre-hook sessions come from it)', hint: 'claudedeck install-hooks' })
  else if (sl.command === statuslineCommand()) out.push({ name: 'statusline', status: 'pass', detail: sl.command })
  else if (sl.command.includes('claudedeck-statusline')) out.push({ name: 'statusline', status: 'warn', detail: `points at another checkout: ${sl.command}`, hint: 'claudedeck install-hooks' })
  else out.push({ name: 'statusline', status: 'warn', detail: `custom statusline kept: ${sl.command.slice(0, 60)}`, hint: 'optional: remove it and run claudedeck install-hooks for model/context on the glasses' })
  return out
}

function checkWrapper(root: string): Check[] {
  const expected = path.join(root, 'scripts', 'claude-tmux.sh')
  const rcs = ['.zshrc', '.bashrc', '.bash_profile'].map(f => path.join(os.homedir(), f)).filter(f => fs.existsSync(f))
  const out: Check[] = []
  let found: string | undefined
  let other: string | undefined
  let alias: string | undefined
  for (const rc of rcs) {
    let text = ''
    try {
      text = fs.readFileSync(rc, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/source\s+"?([^"\s]*claude-tmux\.sh)"?/g)) {
      const p = m[1].replace(/^~/, os.homedir()).replace(/^\$\{?HOME\}?/, os.homedir())
      if (p === expected) found = rc
      else other = `${rc} → ${p}`
    }
    if (/^\s*alias\s+claude=/m.test(text)) alias = rc
  }
  if (found) out.push({ name: 'wrapper', status: 'pass', detail: `${path.basename(found)} sources ${expected}` })
  else if (other) out.push({ name: 'wrapper', status: 'warn', detail: `sourced from another checkout: ${other}`, hint: `point the source line at ${expected}` })
  else out.push({ name: 'wrapper', status: 'warn', detail: 'claude-tmux.sh not sourced from any rc file — claude runs outside tmux ([ro] on the glasses)', hint: `printf '\\nsource "%s"\\n' '${expected}' >> ~/.zshrc  (sh scripts/bootstrap-bridge.sh does this)` })
  if (alias) out.push({ name: 'alias', status: 'warn', detail: `${path.basename(alias)} defines \`alias claude=\` — an alias defined before the wrapper shadows it`, hint: 'remove the alias (claude migrate-installer leaves one) or move the source line after it' })
  return out
}

async function checkTmux(cfg: BridgeConfig, h: Health): Promise<Check> {
  const bin = ['tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(b => spawnSync(b, ['-V'], { stdio: 'ignore' }).status === 0)
  if (!bin) return { name: 'tmux', status: 'fail', detail: 'tmux not found — every session is read-only and terminals cannot be created', hint: 'brew install tmux' }
  const ver = spawnSync(bin, ['-V'], { encoding: 'utf8' }).stdout.trim()
  const ls = spawnSync(bin, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const server = ls.status === 0
  const n = server ? ls.stdout.split('\n').filter(Boolean).length : 0
  const paneless = (h.sessionsList ?? []).filter(s => s.kind !== 'shell' && s.source === 'hook' && !s.pane && s.status !== 'ended').length
  if (h.ok && h.tmux === false) return { name: 'tmux', status: 'fail', detail: `${ver} found by the shell but the bridge cannot use it (${h.tmuxError || 'unknown error'})`, hint: 'claudedeck restart' }
  if (!server && paneless) return { name: 'tmux', status: 'warn', detail: `${ver}, no tmux server; ${paneless} claude session${paneless === 1 ? '' : 's'} run outside tmux (read-only)`, hint: 'quit claude and start it again from a new shell (the wrapper puts it under tmux); already-open shells need `exec zsh` first' }
  if (server && paneless) return { name: 'tmux', status: 'warn', detail: `${ver}, ${n} session${n === 1 ? '' : 's'}; ${paneless} claude session${paneless === 1 ? '' : 's'} run outside tmux (read-only)`, hint: 'relaunch those from a new shell (or `deck` first)' }
  return { name: 'tmux', status: 'pass', detail: `${ver}, ${server ? `${n} session${n === 1 ? '' : 's'}` : 'no server running (starts with the first claude / terminal)'}` }
}

async function checkStt(cfg: BridgeConfig): Promise<Check> {
  if (cfg.stt.backend === 'none') return { name: 'stt', status: 'pass', detail: 'disabled (backend none)' }
  try {
    const stt = createStt(cfg)
    const ok = await stt.available()
    return ok
      ? { name: 'stt', status: 'pass', detail: `${stt.name}, model ${path.basename(cfg.stt.model)}` }
      : { name: 'stt', status: 'warn', detail: `${stt.name} not usable (binary or model ${cfg.stt.model} missing) — dictation disabled`, hint: 'brew install whisper-cpp && claudedeck setup-stt large-v3-turbo' }
  } catch (err) {
    return { name: 'stt', status: 'warn', detail: `stt check failed: ${(err as Error).message}` }
  }
}

function checkTailscale(cfg: BridgeConfig): Check[] {
  const ts = tailscaleInfo()
  const out: Check[] = []
  if (!ts.ip) {
    out.push({ name: 'tailscale', status: 'warn', detail: 'no Tailscale IP — the phone can only reach this bridge on the LAN', hint: 'install/sign in to Tailscale (brew install tailscale or the App Store app)' })
    return out
  }
  out.push({ name: 'tailscale', status: 'pass', detail: `${ts.ip}${ts.dns ? ` (${ts.dns})` : ''}` })
  const serve = tailscaleServe(cfg.port)
  if (serve) out.push({ name: 'serve', status: 'pass', detail: `${serve} → 127.0.0.1:${cfg.port} (installed app uses wss)` })
  else out.push({ name: 'serve', status: 'warn', detail: `tailscale serve is not fronting port ${cfg.port} — the installed (store/beta) app needs wss://`, hint: `tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}` })
  return out
}

interface RemoteProbe {
  ok: boolean
  version?: string
  protocol?: number
  machine?: string
  tmux?: boolean
  error?: string
  httpStatus?: number
}

function probeRemote(url: string, ms = 5000): Promise<RemoteProbe> {
  return new Promise(resolve => {
    let ws: WebSocket
    let done = false
    const finish = (r: RemoteProbe) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws?.terminate()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `no hello within ${ms / 1000} s` }), ms)
    try {
      ws = new WebSocket(url, { handshakeTimeout: ms })
    } catch (err) {
      finish({ ok: false, error: (err as Error).message })
      return
    }
    ws.on('unexpected-response', (_req, res) => finish({ ok: false, httpStatus: res.statusCode, error: res.statusCode === 401 ? 'token rejected (401)' : `HTTP ${res.statusCode}` }))
    ws.on('error', err => finish({ ok: false, error: err.message }))
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', client: 'claudedeck-doctor', protocol: PROTOCOL_VERSION })))
    ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString()) as { type?: string; version?: string; protocol?: number; machine?: string; tmux?: boolean }
        if (m.type === 'hello') finish({ ok: true, version: m.version, protocol: m.protocol, machine: m.machine, tmux: m.tmux })
      } catch {
        /* ignore non-json */
      }
    })
  })
}

async function checkRemotes(cfg: BridgeConfig, h: Health): Promise<Check[]> {
  if (!cfg.remotes.length) return []
  const hubView = new Map((h.remotes ?? []).map(r => [r.name, r]))
  return Promise.all(
    cfg.remotes.map(async r => {
      const name = `remote ${r.name}`
      const p = await probeRemote(r.url)
      const hub = hubView.get(r.name)
      const hubNote = h.ok ? (hub ? ` (hub: ${hub.state}${hub.error ? `, ${hub.error}` : ''})` : ' (hub does not list it — restart the hub: claudedeck restart)') : ''
      const host = safeHost(r.url)
      if (!p.ok) {
        if (p.httpStatus === 401) return { name, status: 'fail' as const, detail: `${host}: token rejected${hubNote}`, hint: `claudedeck remote add ${r.name} <its current ws url>   (get it with \`claudedeck url\` on ${r.name})` }
        return { name, status: 'fail' as const, detail: `${host}: ${p.error}${hubNote}`, hint: `on ${r.name}: claudedeck doctor; check Tailscale connectivity (tailscale ping ${host.split(':')[0]})` }
      }
      const outdated = compareVersions(p.version, MIN_REMOTE_VERSION) < 0
      const older = compareVersions(p.version, VERSION) < 0
      const detail = `${host}: ${p.machine} claudedeck ${p.version ?? '?'}${p.tmux === false ? ', no tmux' : ''}${p.protocol !== undefined && p.protocol !== PROTOCOL_VERSION ? `, protocol ${p.protocol} != ${PROTOCOL_VERSION}` : ''}${hubNote}`
      const sshHint = `claudedeck remote update ${r.name} --ssh USER@${host.split(':')[0]}`
      if (outdated) return { name, status: 'fail' as const, detail: `${detail} — OUTDATED (< ${MIN_REMOTE_VERSION}: no terminals / Ctrl-C / kill)`, hint: `${sshHint}   (or on ${r.name}: claudedeck update)` }
      if (older) return { name, status: 'warn' as const, detail: `${detail} — older than this hub (${VERSION})`, hint: sshHint }
      if (h.ok && hub && hub.state !== 'open') return { name, status: 'warn' as const, detail, hint: 'the hub is not connected although the remote answers — claudedeck restart' }
      return { name, status: 'pass' as const, detail }
    }),
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/token=.*/, 'token=…')
  }
}

function checkLogs(): Check {
  const files = [LOG_PATH, `${LOG_PATH}.1`, path.join(CONFIG_DIR, 'launchd.out.log'), path.join(CONFIG_DIR, 'launchd.err.log')]
  const parts: string[] = []
  let big = false
  let total = 0
  for (const f of files) {
    try {
      const size = fs.statSync(f).size
      total += size
      if (size > 20 * MB) big = true
      parts.push(`${path.basename(f)} ${(size / MB).toFixed(1)} MB`)
    } catch {
      /* absent */
    }
  }
  if (big) return { name: 'logs', status: 'warn', detail: parts.join(', '), hint: `truncate the large ones: : > ${path.join(CONFIG_DIR, 'launchd.out.log')}  (bridge.log rotates itself at 5 MB)` }
  return { name: 'logs', status: 'pass', detail: parts.length ? `${parts.join(', ')} (${(total / MB).toFixed(1)} MB total)` : 'no logs yet' }
}
