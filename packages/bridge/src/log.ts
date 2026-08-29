import fs from 'node:fs'
import { LOG_PATH, CONFIG_DIR } from './config.js'

/** Rotate bridge.log past this size; keep bridge.log.1 and bridge.log.2. */
const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 2
/** Re-check the file size every this many lines (a stat per line would be wasteful). */
const CHECK_EVERY = 500

let stream: fs.WriteStream | null = null
let written = 0
// Under launchd stdout is captured to launchd.out.log, which duplicated every
// line of bridge.log; the plist sets CLAUDEDECK_LAUNCHD=1 so we skip it there.
const toStdout = !process.env.CLAUDEDECK_LAUNCHD

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  if (toStdout) console.log(line)
  try {
    if (!stream) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      rotateIfLarge()
      stream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
      written = 0
    }
    stream.write(line + '\n')
    if (++written >= CHECK_EVERY) {
      written = 0
      if (rotateIfLarge()) {
        stream.end()
        stream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
      }
    }
  } catch {
    /* logging must never throw */
  }
}

/** bridge.log → bridge.log.1 → bridge.log.2 when the current file is too big. */
export function rotateIfLarge(): boolean {
  let size = 0
  try {
    size = fs.statSync(LOG_PATH).size
  } catch {
    return false
  }
  if (size < MAX_BYTES) return false
  try {
    for (let i = KEEP; i >= 1; i--) {
      const older = `${LOG_PATH}.${i}`
      const newer = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`
      if (fs.existsSync(older)) fs.unlinkSync(older)
      if (fs.existsSync(newer)) fs.renameSync(newer, older)
    }
    return true
  } catch {
    return false
  }
}
