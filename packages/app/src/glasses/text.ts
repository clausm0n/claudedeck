import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

/** Fixed LVGL line height on the G2 firmware. */
export const LINE_H = 27

/** Truncate to a pixel budget with a trailing `...`. */
export function fit(text: string, maxPx: number): string {
  const clean = sanitize(text)
  return getTextWidth(clean) <= maxPx ? clean : pxTruncate(clean, maxPx)
}

/**
 * Greedy pixel-accurate word wrap. Every returned line fits `maxPx`, so the
 * firmware will not re-wrap it — which keeps our pagination honest.
 */
export function wrap(text: string, maxPx: number): string[] {
  const lines: string[] = []
  for (const para of sanitize(text).split('\n')) {
    if (!para.trim()) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (getTextWidth(candidate) <= maxPx) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      // Word alone is too wide → hard-split by characters.
      if (getTextWidth(word) > maxPx) {
        let chunk = ''
        for (const ch of word) {
          if (getTextWidth(chunk + ch) > maxPx) {
            lines.push(chunk)
            chunk = ch
          } else chunk += ch
        }
        line = chunk
      } else {
        line = word
      }
    }
    if (line) lines.push(line)
  }
  // Collapse runs of blank lines — vertical space is precious on 8 rows.
  return lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== ''))
}

/** Split wrapped lines into pages of `linesPerPage`, returned as strings. */
export function paginate(text: string, maxPx: number, linesPerPage: number): string[] {
  const lines = wrap(text, maxPx)
  if (lines.length === 0) return ['']
  const pages: string[] = []
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage).join('\n'))
  }
  return pages
}

/**
 * Make text safe for the single firmware font: strip ANSI, box-drawing and
 * emoji-ish glyphs that would otherwise be dropped silently, and squash
 * markdown noise that wastes columns.
 */
export function sanitize(text: string): string {
  return (
    text
      // ANSI escapes
      .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
      // fenced code markers
      .replace(/```[a-z]*\n?/g, '')
      // markdown emphasis / headers / bullets
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '- ')
      // emoji & symbols outside the BMP or in the Misc Symbols blocks
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/[☀-➿]/g, '')
      // box drawing → ASCII
      .replace(/[─-╿]/g, '-')
      .replace(/[▀-▟]/g, '#')
      .replace(/[│┃]/g, '|')
      .replace(/[⏺●◐○]/g, '*')
      .replace(/[❯›»]/g, '>')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/…/g, '...')
      .replace(/`/g, "'")
      .replace(/\t/g, '  ')
      .replace(/\r/g, '')
  )
}
