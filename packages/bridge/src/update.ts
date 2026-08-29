import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cliPath } from './launchd.js'

/** Root of the checkout this dist was built from (dist/update.js → ../../..). */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** Version string of the dist currently on disk (may be newer than the running process after a build). */
export function distVersion(root = repoRoot()): string | undefined {
  try {
    const src = fs.readFileSync(path.join(root, 'packages', 'bridge', 'dist', 'version.js'), 'utf8')
    return src.match(/VERSION = '([^']+)'/)?.[1]
  } catch {
    return undefined
  }
}

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`$ ${[cmd, ...args].join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} exited with ${r.status}`)
}

/**
 * Pull, build and re-install hooks + service from this checkout. The hook and
 * service steps run the freshly built cli.js as a child so the new code (not
 * this process) writes settings.json and the plist; install-service restarts
 * the daemon.
 */
export async function updateLocal(opts: { port: number; skipPull?: boolean }): Promise<void> {
  const root = repoRoot()
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error(`not a claudedeck checkout: ${root}`)
  const before = distVersion(root)
  if (!opts.skipPull) {
    if (!fs.existsSync(path.join(root, '.git'))) console.log('(no .git directory — skipping git pull)')
    else run('git', ['pull', '--ff-only'], root)
  }
  run('npm', ['install', '--no-audit', '--no-fund'], root)
  run('npm', ['run', 'build'], root)
  const cli = cliPath()
  run(process.execPath, [cli, 'install-hooks'], root)
  if (process.platform === 'darwin') {
    run(process.execPath, [cli, 'install-service'], root)
    const after = distVersion(root)
    const ok = await waitForVersion(`http://127.0.0.1:${opts.port}/health`, after, 20_000)
    console.log(ok ? `bridge ${after} is up (was ${before ?? '?'})` : `bridge did not report version ${after} within 20 s — run \`claudedeck doctor\``)
  } else {
    console.log('built. Restart the bridge process by hand (nohup/systemd) so the new code runs.')
  }
}

/**
 * Run the same update on another machine over ssh. The non-interactive shell
 * there has /opt/homebrew/bin on PATH on macOS; we still `cd` into the checkout
 * and call node explicitly so nvm-style PATHs are not needed.
 */
export async function updateRemote(opts: { name: string; ssh: string; path?: string; healthUrl?: string }): Promise<void> {
  const dir = opts.path ?? '~/claudedeck'
  const script = [
    `cd ${dir}`,
    'git pull --ff-only',
    'npm install --no-audit --no-fund',
    'npm run build',
    'node packages/bridge/dist/cli.js install-hooks',
    'if [ "$(uname -s)" = Darwin ]; then node packages/bridge/dist/cli.js install-service; else echo "restart the bridge by hand (non-macOS)"; fi',
    'node packages/bridge/dist/cli.js version',
  ].join(' && ')
  console.log(`$ ssh ${opts.ssh} '${script}'`)
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', opts.ssh, script], { stdio: 'inherit' })
  if (r.error) throw new Error(`ssh: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`remote update on ${opts.name} failed (ssh exit ${r.status})`)
  if (opts.healthUrl) {
    const v = await waitForVersion(opts.healthUrl, undefined, 20_000)
    console.log(v ? `${opts.name} bridge is back: ${v}` : `${opts.name} did not answer /health within 20 s — check \`claudedeck remote ls\` and the remote's \`claudedeck doctor\``)
  }
}

/** Poll /health until it answers (and, when given, reports `version`). Returns the version seen, or undefined. */
async function waitForVersion(healthUrl: string, version: string | undefined, ms: number): Promise<string | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const j = (await res.json()) as { version?: string }
        if (!version || j.version === version) return j.version
      }
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return undefined
}

/** `http://host:port/health` for a remote's ws URL (`ws://host:7788/ws?token=…` or `wss://host/ws?token=…`). */
export function healthUrlFor(wsUrl: string): string | undefined {
  try {
    const u = new URL(wsUrl)
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${proto}//${u.host}/health`
  } catch {
    return undefined
  }
}
