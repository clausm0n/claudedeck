import fs from 'node:fs'
import { LOG_PATH, CONFIG_DIR } from './config.js'

let stream: fs.WriteStream | null = null

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    if (!stream) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      stream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
    }
    stream.write(line + '\n')
  } catch {
    /* logging must never throw */
  }
}
