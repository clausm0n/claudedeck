import { spawn, execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BridgeConfig } from './config.js'
import { log } from './log.js'

const execFileP = promisify(execFile)

/** Loading a 5 GB GGUF from disk takes a few seconds; a cold page cache more. */
const START_TIMEOUT_MS = 90_000

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * A local open-weight model behind llama.cpp's `llama-server` (OpenAI-compatible
 * HTTP on loopback). The bridge owns the process: it starts it on first use,
 * keeps it warm, and stops it after `idleStopMinutes` so a laptop gets its
 * memory back. Nothing leaves the machine.
 */
export class LocalLlm {
  readonly name = 'llama-cpp'
  private child?: ChildProcess
  private starting?: Promise<void>
  private idleTimer?: NodeJS.Timeout
  private binary: string | null | undefined
  lastError = ''

  constructor(private cfg: BridgeConfig['llm']) {}

  get modelName(): string {
    return path.basename(this.cfg.model).replace(/\.gguf$/i, '')
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.cfg.port}`
  }

  private async resolveBinary(): Promise<string | null> {
    if (this.binary) return this.binary
    if (this.cfg.binary && fs.existsSync(this.cfg.binary)) return (this.binary = this.cfg.binary)
    for (const p of ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server']) {
      if (fs.existsSync(p)) return (this.binary = p)
    }
    try {
      const { stdout } = await execFileP('which', ['llama-server'])
      const p = stdout.trim()
      if (p) return (this.binary = p)
    } catch {
      /* not on PATH */
    }
    this.binary = null
    return null
  }

  /** Binary + model present; does not start anything. */
  async available(): Promise<boolean> {
    if (this.cfg.backend !== 'llama-cpp') return false
    return !!(await this.resolveBinary()) && fs.existsSync(this.cfg.model)
  }

  /** Why `available()` is false, for /health and doctor. */
  async problem(): Promise<string | undefined> {
    if (this.cfg.backend !== 'llama-cpp') return 'llm backend disabled'
    if (!(await this.resolveBinary())) return 'llama-server not found (brew install llama.cpp)'
    if (!fs.existsSync(this.cfg.model)) return `model missing: ${this.cfg.model} (run: claudedeck setup-llm)`
    return undefined
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/health`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return false
      const j = (await res.json().catch(() => ({}))) as { status?: string }
      return !j.status || j.status === 'ok'
    } catch {
      return false
    }
  }

  /** Make sure a server answers on the port — ours, or one the user runs by hand. */
  async ensureServer(): Promise<void> {
    if (await this.healthy()) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async start(): Promise<void> {
    const bin = await this.resolveBinary()
    if (!bin) throw new Error('llama-server not found (brew install llama.cpp)')
    if (!fs.existsSync(this.cfg.model)) throw new Error(`model missing: ${this.cfg.model} (run: claudedeck setup-llm)`)
    if (this.child && this.child.exitCode === null) this.child.kill()
    const args = [
      '-m', this.cfg.model,
      '--host', '127.0.0.1',
      '--port', String(this.cfg.port),
      '-ngl', '99',
      '-c', String(this.cfg.contextSize),
      '-np', '1',
      '--temp', '0',
      '--no-webui',
      '--log-disable',
    ]
    log(`llm: starting llama-server (${this.modelName}) on :${this.cfg.port}`)
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    let stderr = ''
    child.stderr?.on('data', d => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      const why = signal ? `signal ${signal}` : `exit ${code}`
      if (code !== 0 && signal !== 'SIGTERM') {
        this.lastError = `llama-server ${why}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`
        log(`llm: ${this.lastError}`)
      } else log(`llm: llama-server stopped (${why})`)
    })
    const end = Date.now() + START_TIMEOUT_MS
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error(this.lastError || `llama-server exited (${child.exitCode})`)
      if (await this.healthy()) {
        log(`llm: ready (${Math.round((START_TIMEOUT_MS - (end - Date.now())) / 1000)} s)`)
        this.touch()
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
    child.kill()
    throw new Error('llama-server did not become healthy in time')
  }

  /** Reset the idle-stop timer. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const min = this.cfg.idleStopMinutes
    if (!min || min <= 0) return
    this.idleTimer = setTimeout(() => this.stop('idle'), min * 60_000)
    this.idleTimer.unref()
  }

  stop(reason = 'shutdown'): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.child && this.child.exitCode === null) {
      log(`llm: stopping llama-server (${reason})`)
      this.child.kill()
    }
    this.child = undefined
  }

  /**
   * One chat completion constrained to `schema` (llama.cpp compiles it to a
   * grammar, so the reply always parses). Returns the parsed object.
   */
  async chatJson<T>(messages: ChatMessage[], schema: Record<string, unknown>, opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<T> {
    await this.ensureServer()
    this.touch()
    const body = {
      model: this.modelName,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 200,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    }
    const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    })
    if (!res.ok) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = j.choices?.[0]?.message?.content ?? ''
    try {
      return JSON.parse(content) as T
    } catch {
      throw new Error(`model reply is not JSON: ${content.slice(0, 120)}`)
    }
  }
}

export function createLlm(cfg: BridgeConfig): LocalLlm {
  return new LocalLlm(cfg.llm)
}

/** Known GGUFs for `claudedeck setup-llm`. Sizes are approximate. */
export const LLM_MODELS: Record<string, { url: string; file: string; size: string; note: string }> = {
  'qwen2.5-7b': {
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    size: '4.7 GB',
    note: 'default — good at following the tool protocol; ~1 s per command on an M-series Mac',
  },
  'qwen2.5-3b': {
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    size: '2.1 GB',
    note: 'smaller and faster; fine for simple commands',
  },
  'qwen3-8b': {
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    size: '5.0 GB',
    note: 'newer; thinking disabled by the grammar',
  },
}

export function defaultModelPath(modelsDir = path.join(os.homedir(), '.claudedeck', 'models')): string {
  return path.join(modelsDir, LLM_MODELS['qwen2.5-7b'].file)
}
