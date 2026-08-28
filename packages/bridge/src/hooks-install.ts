import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BridgeConfig } from './config.js'

/** Hook events the bridge understands. Each posts its JSON to /hook. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'CwdChanged',
  'SessionEnd',
] as const

const MARKER = 'claudedeck-hook'

interface HookEntry {
  matcher?: string
  hooks: Array<Record<string, unknown>>
}

export function binDir(): string {
  // dist/hooks-install.js → ../bin
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin')
}

export function hookScriptPath(): string {
  return path.join(binDir(), 'claudedeck-hook.sh')
}

export function statuslineScriptPath(): string {
  return path.join(binDir(), 'claudedeck-statusline.sh')
}

export interface InstallResult {
  settingsPath: string
  backupPath?: string
  installedEvents: string[]
  statusline: 'installed' | 'kept-existing' | 'skipped'
}

/**
 * Merge ClaudeDeck hooks into ~/.claude/settings.json (or CLAUDE_CONFIG_DIR).
 * Idempotent: existing claudedeck entries are replaced, everything else kept.
 */
export function installHooks(cfg: BridgeConfig, opts: { statusline: boolean }): InstallResult {
  const settingsPath = path.join(cfg.claudeConfigDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  let backupPath: string | undefined
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    backupPath = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(settingsPath, backupPath)
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  }

  const script = hookScriptPath()
  const hooks = ((settings.hooks as Record<string, HookEntry[]>) ?? {}) as Record<string, HookEntry[]>
  const installed: string[] = []
  for (const ev of HOOK_EVENTS) {
    const existing = (hooks[ev] ?? []).filter(entry => !entryIsOurs(entry))
    existing.push({
      hooks: [
        {
          type: 'command',
          command: `${shellQuote(script)} ${ev}`,
          async: true,
          timeout: 5,
        },
      ],
    })
    hooks[ev] = existing
    installed.push(ev)
  }
  settings.hooks = hooks

  let statusline: InstallResult['statusline'] = 'skipped'
  if (opts.statusline) {
    const current = settings.statusLine as { command?: string } | undefined
    if (!current || (current.command ?? '').includes('claudedeck-statusline')) {
      settings.statusLine = { type: 'command', command: shellQuote(statuslineScriptPath()), refreshInterval: 10 }
      statusline = 'installed'
    } else {
      statusline = 'kept-existing'
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return { settingsPath, backupPath, installedEvents: installed, statusline }
}

export function uninstallHooks(cfg: BridgeConfig): string {
  const settingsPath = path.join(cfg.claudeConfigDir, 'settings.json')
  if (!fs.existsSync(settingsPath)) return settingsPath
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  const hooks = (settings.hooks as Record<string, HookEntry[]>) ?? {}
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].filter(e => !entryIsOurs(e))
    if (hooks[ev].length === 0) delete hooks[ev]
  }
  settings.hooks = hooks
  const sl = settings.statusLine as { command?: string } | undefined
  if (sl?.command?.includes('claudedeck-statusline')) delete settings.statusLine
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return settingsPath
}

function entryIsOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(MARKER))
}

function shellQuote(p: string): string {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p
}
