import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR } from './config.js'

export const SERVICE_LABEL = 'com.claudedeck.bridge'

export function plistPath(label = SERVICE_LABEL): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** launchd domain for the current user's GUI session. */
export function launchdDomain(): string {
  return `gui/${os.userInfo().uid}`
}

/** `dist/cli.js` of this checkout — the file launchd should run. */
export function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')
}

/**
 * A node binary path that survives `brew upgrade node`. `process.execPath` is
 * the resolved Cellar path (/opt/homebrew/Cellar/node/25.5.0/bin/node), which
 * Homebrew deletes on upgrade; the symlinks in opt/ and bin/ stay. Prefer the
 * first stable candidate that resolves to the very binary we are running so
 * nvm/volta/fnm layouts (no symlink) keep using execPath.
 */
export function stableNodePath(): string {
  const exec = realpath(process.execPath)
  const candidates = ['/opt/homebrew/opt/node/bin/node', '/opt/homebrew/bin/node', '/usr/local/opt/node/bin/node', '/usr/local/bin/node', ...whichAll('node')]
  for (const c of candidates) {
    if (c && fs.existsSync(c) && realpath(c) === exec && !c.includes('/Cellar/')) return c
  }
  return process.execPath
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

function whichAll(bin: string): string[] {
  const r = spawnSync('which', ['-a', bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (r.error || r.status !== 0) return []
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

export interface PlistOptions {
  label?: string
  node?: string
  cli?: string
  /** Extra environment for the daemon (CLAUDEDECK_HOME for test instances). */
  env?: Record<string, string>
  /** Log directory (StandardErrorPath); defaults to ~/.claudedeck. */
  logDir?: string
}

export function renderPlist(opts: PlistOptions = {}): string {
  const label = opts.label ?? SERVICE_LABEL
  const node = opts.node ?? stableNodePath()
  const cli = opts.cli ?? cliPath()
  const logDir = opts.logDir ?? CONFIG_DIR
  const env: Record<string, string> = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    // log.ts skips stdout under launchd so launchd.out.log no longer duplicates bridge.log.
    CLAUDEDECK_LAUNCHD: '1',
    ...(opts.env ?? {}),
  }
  const envXml = Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict>${envXml}</dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'launchd.err.log'))}</string>
</dict></plist>
`
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface InstalledPlist {
  path: string
  program?: string
  cli?: string
  env: Record<string, string>
}

/** Read the bits of an installed plist that doctor/install-service care about (no plist library needed). */
export function readPlist(p = plistPath()): InstalledPlist | undefined {
  let text: string
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
  const args = [...(text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => unxml(m[1]))
  const env: Record<string, string> = {}
  const envBlock = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? ''
  for (const m of envBlock.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) env[unxml(m[1])] = unxml(m[2])
  return { path: p, program: args[0], cli: args[1], env }
}

function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export interface ServiceStatus {
  loaded: boolean
  state?: string
  pid?: number
  program?: string
  lastExitCode?: string
  runs?: number
  raw?: string
}

/** Parse `launchctl print gui/<uid>/<label>`. */
export function serviceStatus(label = SERVICE_LABEL): ServiceStatus {
  const r = launchctl(['print', `${launchdDomain()}/${label}`])
  if (r.status !== 0) return { loaded: false, raw: r.stderr.trim() || r.stdout.trim() }
  const out = r.stdout
  const grab = (key: string) => out.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1]?.trim()
  const pid = grab('pid')
  const runs = grab('runs')
  return {
    loaded: true,
    state: grab('state'),
    pid: pid ? Number(pid) : undefined,
    program: grab('program'),
    lastExitCode: grab('last exit code'),
    runs: runs ? Number(runs) : undefined,
  }
}

function launchctl(args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

export interface InstallOutcome {
  plistPath: string
  node: string
  cli: string
  /** True when launchd accepted the job and it is running. */
  running: boolean
  pid?: number
  messages: string[]
}

/**
 * Write the plist and (re)load it with the modern verbs: bootout (ignore
 * "not loaded"), bootstrap, kickstart -k. Idempotent — safe after every
 * `git pull` / build, and it is how the bridge gets restarted on new code.
 */
export function installService(opts: PlistOptions = {}): InstallOutcome {
  if (process.platform !== 'darwin') throw new Error('install-service currently supports macOS launchd only')
  const label = opts.label ?? SERVICE_LABEL
  const p = plistPath(label)
  const node = opts.node ?? stableNodePath()
  const cli = opts.cli ?? cliPath()
  const messages: string[] = []
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.mkdirSync(opts.logDir ?? CONFIG_DIR, { recursive: true })
  fs.writeFileSync(p, renderPlist({ ...opts, label, node, cli }))
  messages.push(`wrote ${p} (node: ${node})`)
  if (node.includes('/Cellar/')) messages.push('warning: node path is a versioned Homebrew Cellar path — it will break on the next `brew upgrade node`')

  const target = `${launchdDomain()}/${label}`
  // A job loaded from an older plist keeps its old ProgramArguments; unload first.
  const out = launchctl(['bootout', target])
  if (out.status !== 0 && !/not find|No such process|not loaded|Could not find service|Input\/output error/i.test(out.stderr + out.stdout)) {
    messages.push(`bootout: ${out.stderr.trim() || out.stdout.trim()}`)
  }
  // bootout returns before the job is gone; bootstrapping while it is still
  // being torn down fails with "5: Input/output error".
  if (!waitForUnloaded(label)) messages.push('warning: old job still loaded after 5 s')
  let boot = launchctl(['bootstrap', launchdDomain(), p])
  if (boot.status !== 0 && /Input\/output error|5:/.test(boot.stderr)) {
    sleep(1000)
    boot = launchctl(['bootstrap', launchdDomain(), p])
  }
  if (boot.status !== 0) {
    const err = boot.stderr.trim() || boot.stdout.trim()
    messages.push(`bootstrap failed: ${err}`)
    if (/Could not find domain|Domain does not support|No such process|125/i.test(err)) {
      messages.push(`no GUI login session for this user — log in once at the console (or via Screen Sharing), then re-run \`claudedeck install-service\``)
    }
    return { plistPath: p, node, cli, running: false, messages }
  }
  // bootstrap starts it (RunAtLoad); kickstart -k guarantees a fresh process on re-install.
  const kick = launchctl(['kickstart', '-k', target])
  if (kick.status !== 0) messages.push(`kickstart: ${kick.stderr.trim() || kick.stdout.trim()}`)
  const st = waitForRunning(label)
  messages.push(st.pid ? `running (pid ${st.pid})` : `not running yet (state: ${st.state ?? 'unknown'}${st.lastExitCode ? `, last exit ${st.lastExitCode}` : ''})`)
  return { plistPath: p, node, cli, running: !!st.pid, pid: st.pid, messages }
}

function waitForRunning(label: string, ms = 3000): ServiceStatus {
  const end = Date.now() + ms
  let st = serviceStatus(label)
  while (!st.pid && Date.now() < end) {
    sleep(200)
    st = serviceStatus(label)
  }
  return st
}

function waitForUnloaded(label: string, ms = 5000): boolean {
  const end = Date.now() + ms
  while (serviceStatus(label).loaded) {
    if (Date.now() > end) return false
    sleep(150)
  }
  return true
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function uninstallService(label = SERVICE_LABEL): string[] {
  const messages: string[] = []
  const target = `${launchdDomain()}/${label}`
  const out = launchctl(['bootout', target])
  messages.push(out.status === 0 ? `stopped ${label}` : `bootout: ${out.stderr.trim() || 'not loaded'}`)
  waitForUnloaded(label)
  const p = plistPath(label)
  if (fs.existsSync(p)) {
    fs.unlinkSync(p)
    messages.push(`removed ${p}`)
  }
  return messages
}

/** Restart the running job; when it is not loaded, load it from the plist. */
export function restartService(label = SERVICE_LABEL): { ok: boolean; message: string } {
  if (process.platform !== 'darwin') return { ok: false, message: 'restart is launchd-only; restart the bridge process by hand' }
  const target = `${launchdDomain()}/${label}`
  const kick = launchctl(['kickstart', '-k', target])
  if (kick.status === 0) {
    const st = waitForRunning(label)
    return { ok: !!st.pid, message: st.pid ? `restarted (pid ${st.pid})` : 'kickstart accepted but no pid yet — check `claudedeck doctor`' }
  }
  const p = plistPath(label)
  if (!fs.existsSync(p)) return { ok: false, message: 'service not installed — run `claudedeck install-service`' }
  const boot = launchctl(['bootstrap', launchdDomain(), p])
  if (boot.status !== 0) return { ok: false, message: `bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}` }
  const st = waitForRunning(label)
  return { ok: !!st.pid, message: st.pid ? `loaded and started (pid ${st.pid})` : 'loaded but not running — check `claudedeck doctor`' }
}
