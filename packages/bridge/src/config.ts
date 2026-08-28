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
  }
  /** How often (ms) to rescan tmux panes for Claude processes. */
  tmuxScanIntervalMs: number
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
export const MODELS_DIR = path.join(CONFIG_DIR, 'models')
export const LOG_PATH = path.join(CONFIG_DIR, 'bridge.log')

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
    },
    tmuxScanIntervalMs: 4000,
    remotes: [],
  }
}

export function loadConfig(): BridgeConfig {
  const base = defaults()
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 })
    return base
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<BridgeConfig>
  const merged: BridgeConfig = {
    ...base,
    ...raw,
    stt: { ...base.stt, ...(raw.stt ?? {}) },
  }
  // Persist any newly-added defaults so the file stays self-documenting.
  if (JSON.stringify(merged) !== JSON.stringify(raw)) saveConfig(merged)
  return merged
}

export function saveConfig(cfg: BridgeConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}
