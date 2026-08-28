import fs from 'node:fs'
import path from 'node:path'
import type { ToolRef } from '@claudedeck/shared'

/**
 * Best-effort reader for Claude Code's JSONL transcripts. The format is
 * internal and may change; everything here is tolerant of unknown records.
 */

export interface TranscriptInfo {
  lastAssistant: string
  lastAssistantAt?: number
  lastUser: string
  lastUserAt?: number
  pendingTool?: ToolRef
  model?: string
  sessionId?: string
  cwd?: string
  /** Custom session name / AI title when the transcript records one. */
  title?: string
}

interface Block {
  type: string
  text?: string
  name?: string
  input?: unknown
  id?: string
  tool_use_id?: string
}

const TAIL_BYTES = 768 * 1024

function readTail(file: string): string {
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - TAIL_BYTES)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

export function summarizeToolInput(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const short = (v: string, n = 90) => (v.length > n ? v.slice(0, n - 1) + '…' : v)
  switch (name) {
    case 'Bash':
      return short(s(obj.description) || s(obj.command).replace(/\s+/g, ' '))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return short(path.basename(s(obj.file_path) || s(obj.notebook_path) || ''))
    case 'Glob':
    case 'Grep':
      return short(s(obj.pattern))
    case 'Agent':
    case 'Task':
      return short(s(obj.description) || s(obj.prompt))
    case 'WebFetch':
    case 'WebSearch':
      return short(s(obj.url) || s(obj.query))
    case 'AskUserQuestion':
      return 'question for you'
    default: {
      const firstStr = Object.values(obj).find(v => typeof v === 'string') as string | undefined
      return short(firstStr ?? '')
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

export function parseTranscript(file: string): TranscriptInfo | null {
  if (!fs.existsSync(file)) return null
  const info: TranscriptInfo = { lastAssistant: '', lastUser: '' }
  const openTools = new Map<string, ToolRef>()
  let lastToolOrder: string[] = []
  for (const line of readTail(file).split('\n')) {
    if (!line.trim()) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.isSidechain === true) continue
    const t = rec.type
    if (t === 'custom-title' || t === 'session-name') {
      const n = (rec.customTitle ?? rec.name ?? rec.title) as string | undefined
      if (n) info.title = n
      continue
    }
    if (typeof rec.sessionId === 'string') info.sessionId = rec.sessionId
    if (typeof rec.cwd === 'string') info.cwd = rec.cwd
    const msg = rec.message as { role?: string; content?: unknown; model?: string } | undefined
    if (!msg) continue
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : undefined
    if (t === 'assistant' || msg.role === 'assistant') {
      if (msg.model) info.model = msg.model
      const text = textOf(msg.content)
      if (text) {
        info.lastAssistant = text
        info.lastAssistantAt = ts
      }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content as Block[]) {
          if (b?.type === 'tool_use' && b.id) {
            openTools.set(b.id, { name: b.name ?? 'tool', summary: summarizeToolInput(b.name ?? '', b.input) })
            lastToolOrder.push(b.id)
          }
        }
      }
    } else if (t === 'user' || msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        let hadResult = false
        for (const b of msg.content as Block[]) {
          if (b?.type === 'tool_result' && b.tool_use_id) {
            openTools.delete(b.tool_use_id)
            hadResult = true
          }
        }
        if (hadResult) continue
      }
      const text = textOf(msg.content)
      // Skip system-ish injected prompts.
      if (text && !text.startsWith('<') ) {
        info.lastUser = text
        info.lastUserAt = ts
      }
    }
  }
  lastToolOrder = lastToolOrder.filter(id => openTools.has(id))
  const lastOpen = lastToolOrder[lastToolOrder.length - 1]
  if (lastOpen) info.pendingTool = openTools.get(lastOpen)
  return info
}

/** Claude's project slug: every non-alphanumeric char becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Newest transcript for a cwd, optionally excluding known session ids. */
export function findTranscriptForCwd(claudeDir: string, cwd: string, exclude: Set<string>): string | null {
  const dir = path.join(claudeDir, 'projects', projectSlug(cwd))
  if (!fs.existsSync(dir)) return null
  const candidates = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && !exclude.has(f.replace(/\.jsonl$/, '')))
    .map(f => {
      const p = path.join(dir, f)
      return { p, mtime: fs.statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const newest = candidates[0]
  if (!newest) return null
  // Only trust transcripts touched in the last 12h for tmux-only discovery.
  if (Date.now() - newest.mtime > 12 * 3600 * 1000) return null
  return newest.p
}
