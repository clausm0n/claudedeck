import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export interface BridgeConfig {
  /** Interface to bind. `0.0.0.0` so the phone can reach it over Tailscale/LAN. */
  host: string
  port: number
  /** Shared secret the app must present (`?token=` on the WS URL). */
  token: string
  /** Friendly machine name shown on the glasses. */
  machine: string
  /** Extra directory under CLAUDE_CONFIG_DIR/projects to scan; defaults to ~/.claude. */
  claudeConfigDir: string
  stt: {
    /** `whisper-cpp` runs a local whisper-cli; `none` disables dictation. */
    backend: 'whisper-cpp' | 'none'
    /** Path to a ggml model file for whisper-cpp. */
    model: string
    /** Optional explicit binary path; otherwise `whisper-cli` / `whisper-cpp` on PATH. */
    binary?: string
    language: string
    /** Initial prompt: biases whisper toward this vocabulary/style. */
    prompt: string
    /** Whisper prompt used when dictating into a terminal row (shell vocabulary). */
    shellPrompt: string
    /**
     * How terminal dictation becomes a command: `rules` (spoken symbols, gluing,
     * common mis-hearings), `claude` (rules, then a pass through the local
     * `claude -p` CLI), or `off` (raw transcript).
     */
    shellTransform: 'rules' | 'claude' | 'off'
    /**
     * Model for the `claude` transform (`claude -p --model`). It runs as a
     * read-only agent in the terminal's directory (ls/find/Glob only) so
     * "change directory to Mandelglyph" becomes `cd Mandelglyph` even when
     * whisper heard "mandel glif". `sonnet` resolves in 1-2 turns (~2 s of
     * model time); `haiku` explores more and is slower in practice.
     */
    shellModel: string
  }
  /** How often (ms) to rescan tmux panes for Claude processes. */
  tmuxScanIntervalMs: number
  /** Expose every tmux pane (not only Claude Code) as a terminal row on the glasses. */
  terminals: boolean
  /**
   * Other bridges this one relays (hub mode). The phone connects only here;
   * remote sessions appear in the same list tagged with the remote's machine
   * name, and actions/dictation are forwarded. URL = the remote's ws URL
   * (may point at a local SSH tunnel port).
   */
  remotes: Array<{ name: string; url: string }>
}

/** Override with CLAUDEDECK_HOME to run a second instance (tests, staging). */
export const CONFIG_DIR = process.env.CLAUDEDECK_HOME || path.join(os.homedir(), '.claudedeck')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
export const CONFIG_BACKUP_PATH = `${CONFIG_PATH}.bak`
export const MODELS_DIR = path.join(CONFIG_DIR, 'models')
export const LOG_PATH = path.join(CONFIG_DIR, 'bridge.log')

/**
 * Set when loadConfig() had to mint a fresh token although this machine was
 * already set up (service or hooks present): the phone pairing and any hub
 * `remotes[].url` embedding the old token are now broken. `claudedeck start`
 * logs it and the CLI prints it, since a silent new token only shows up as a
 * reconnect loop.
 */
export let freshTokenWarning: string | undefined

function defaults(): BridgeConfig {
  return {
    host: '0.0.0.0',
    port: 7788,
    token: crypto.randomBytes(18).toString('base64url'),
    machine: os.hostname().replace(/\.local$/, ''),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    stt: {
      backend: 'whisper-cpp',
      model: path.join(MODELS_DIR, 'ggml-base.en.bin'),
      language: 'en',
      prompt:
        'Instructions for Claude Code, a coding agent: refactor, run the tests, git commit, npm, TypeScript, tmux pane id, ' +
        'API, JSON, README, config file, bridge, WebSocket, hook, statusline, glasses, Even Hub, Tailscale.',
      shellPrompt:
        'Shell commands spoken aloud: ls dash la, cd tilde slash projects, git status, git commit dash m, npm run build, ' +
        'ping google dot com, grep dash r pattern, cat file dot txt, pipe, star, dollar HOME, sudo, docker, kubectl, tmux.',
      shellTransform: 'rules',
      shellModel: 'sonnet',
    },
    tmuxScanIntervalMs: 4000,
    terminals: true,
    remotes: [],
  }
}

export function loadConfig(): BridgeConfig {
  const base = defaults()
  if (!fs.existsSync(CONFIG_PATH)) {
    // A lost config.json on an installed machine is recoverable from the backup.
    if (fs.existsSync(CONFIG_BACKUP_PATH)) {
      try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf8')) as Partial<BridgeConfig>
        const merged = merge(base, raw)
        saveConfig(merged)
        console.error(`claudedeck: ${CONFIG_PATH} was missing — restored from ${CONFIG_BACKUP_PATH}`)
        return merged
      } catch {
        /* fall through to a fresh config */
      }
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 })
    if (previouslyInstalled(base.claudeConfigDir)) {
      freshTokenWarning =
        `${CONFIG_PATH} was missing and a NEW token was generated — the phone pairing and every hub ` +
        `\`claudedeck remote add\` URL for this machine are now stale. Re-pair (claudedeck pair) and re-add this remote on the hub.`
      console.error(`claudedeck: ${freshTokenWarning}`)
    }
    return base
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<BridgeConfig>
  const merged = merge(base, raw)
  // Persist any newly-added defaults so the file stays self-documenting.
  if (JSON.stringify(merged) !== JSON.stringify(raw)) saveConfig(merged)
  return merged
}

function merge(base: BridgeConfig, raw: Partial<BridgeConfig>): BridgeConfig {
  return { ...base, ...raw, stt: { ...base.stt, ...(raw.stt ?? {}) } }
}

/** Hooks or a launchd plist exist → this machine was set up before, so a fresh token is a loss, not a first run. */
function previouslyInstalled(claudeDir: string): boolean {
  try {
    if (fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claudedeck.bridge.plist'))) return true
    return fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8').includes('claudedeck-hook')
  } catch {
    return false
  }
}

export function saveConfig(cfg: BridgeConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  // Keep the previous file: it holds the token and remote URLs that pairing depends on.
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH)
  } catch {
    /* best effort */
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(CONFIG_BACKUP_PATH, 0o600)
  } catch {
    /* best effort */
  }
}
