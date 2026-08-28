import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BridgeConfig } from './config.js'

const execFileP = promisify(execFile)

export interface SttBackend {
  readonly name: string
  available(): Promise<boolean>
  /** PCM s16le mono 16 kHz → text. */
  transcribe(pcm: Buffer, sampleRate: number): Promise<string>
}

/** Wrap raw PCM in a 44-byte RIFF header so whisper-cli can read it. */
export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('which', [bin])
    const p = stdout.trim()
    return p || null
  } catch {
    return null
  }
}

class WhisperCpp implements SttBackend {
  readonly name = 'whisper-cpp'
  private binary: string | null | undefined
  constructor(private cfg: BridgeConfig['stt']) {}

  private async resolveBinary(): Promise<string | null> {
    // Cache only a successful lookup so installing whisper later is picked up
    // without restarting the bridge.
    if (this.binary) return this.binary
    if (this.cfg.binary && fs.existsSync(this.cfg.binary)) return (this.binary = this.cfg.binary)
    const found = (await which('whisper-cli')) ?? (await which('whisper-cpp'))
    for (const p of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) {
      if (!found && fs.existsSync(p)) return (this.binary = p)
    }
    this.binary = found ?? null
    return this.binary
  }

  async available(): Promise<boolean> {
    return !!(await this.resolveBinary()) && fs.existsSync(this.cfg.model)
  }

  async transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    const bin = await this.resolveBinary()
    if (!bin) throw new Error('whisper-cli not found (brew install whisper-cpp)')
    if (!fs.existsSync(this.cfg.model)) throw new Error(`whisper model missing: ${this.cfg.model} (run: claudedeck setup-stt)`)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedeck-'))
    const wav = path.join(tmp, 'in.wav')
    fs.writeFileSync(wav, pcmToWav(pcm, sampleRate))
    try {
      const args = ['-m', this.cfg.model, '-f', wav, '-l', this.cfg.language || 'en', '--no-timestamps', '--no-prints', '-t', String(Math.max(2, Math.min(8, os.cpus().length)))]
      if (this.cfg.prompt) args.push('--prompt', this.cfg.prompt)
      const { stdout } = await execFileP(bin, args, { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 })
      return stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('['))
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\[BLANK_AUDIO\]/g, '')
        .trim()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

class NoStt implements SttBackend {
  readonly name = 'none'
  async available() {
    return false
  }
  async transcribe(): Promise<string> {
    throw new Error('STT disabled in ~/.claudedeck/config.json')
  }
}

export function createStt(cfg: BridgeConfig): SttBackend {
  return cfg.stt.backend === 'whisper-cpp' ? new WhisperCpp(cfg.stt) : new NoStt()
}

export const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
