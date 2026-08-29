/**
 * Spoken text → shell command line. Whisper hears "ping google dot com dash c
 * four" — a terminal needs `ping google.com -c 4`. Rule based: spoken symbols,
 * gluing (dots/slashes/dashes attach to their neighbours), spelled letters,
 * number words, common mis-hearings of command names. Only used for terminal
 * rows; Claude Code sessions get the raw transcript.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

type Glue = 'both' | 'left' | 'right' | 'none' | 'pathish'
interface Sym {
  text: string
  glue: Glue
}

/** Spoken phrases → symbol. Longest phrases first (matched greedily). */
const PHRASES: Array<[string, Sym]> = [
  ['double dash', { text: '--', glue: 'right' }],
  ['dash dash', { text: '--', glue: 'right' }],
  ['minus minus', { text: '--', glue: 'right' }],
  ['double ampersand', { text: '&&', glue: 'none' }],
  ['and and', { text: '&&', glue: 'none' }],
  ['ampersand ampersand', { text: '&&', glue: 'none' }],
  ['double pipe', { text: '||', glue: 'none' }],
  ['pipe pipe', { text: '||', glue: 'none' }],
  ['or or', { text: '||', glue: 'none' }],
  ['double greater than', { text: '>>', glue: 'none' }],
  ['append to', { text: '>>', glue: 'none' }],
  ['greater than', { text: '>', glue: 'none' }],
  ['right angle bracket', { text: '>', glue: 'none' }],
  ['less than', { text: '<', glue: 'none' }],
  ['left angle bracket', { text: '<', glue: 'none' }],
  ['forward slash', { text: '/', glue: 'pathish' }],
  ['back slash', { text: '\\', glue: 'both' }],
  ['backslash', { text: '\\', glue: 'both' }],
  ['slash', { text: '/', glue: 'pathish' }],
  ['dot dot', { text: '..', glue: 'pathish' }],
  ['dot', { text: '.', glue: 'pathish' }],
  ['period', { text: '.', glue: 'pathish' }],
  ['point', { text: '.', glue: 'pathish' }],
  ['dash', { text: '-', glue: 'right' }],
  ['hyphen', { text: '-', glue: 'both' }],
  ['minus', { text: '-', glue: 'right' }],
  ['underscore', { text: '_', glue: 'both' }],
  ['under score', { text: '_', glue: 'both' }],
  ['tilde', { text: '~', glue: 'right' }],
  ['tilda', { text: '~', glue: 'right' }],
  ['pipe', { text: '|', glue: 'none' }],
  ['pipe to', { text: '|', glue: 'none' }],
  ['ampersand', { text: '&', glue: 'none' }],
  ['and sign', { text: '&', glue: 'none' }],
  ['semicolon', { text: ';', glue: 'none' }],
  ['semi colon', { text: ';', glue: 'none' }],
  ['colon', { text: ':', glue: 'both' }],
  ['equals sign', { text: '=', glue: 'both' }],
  ['equal sign', { text: '=', glue: 'both' }],
  ['equals', { text: '=', glue: 'both' }],
  ['at sign', { text: '@', glue: 'both' }],
  ['at symbol', { text: '@', glue: 'both' }],
  ['star', { text: '*', glue: 'right' }],
  ['asterisk', { text: '*', glue: 'right' }],
  ['wildcard', { text: '*', glue: 'right' }],
  ['dollar sign', { text: '$', glue: 'right' }],
  ['dollar', { text: '$', glue: 'right' }],
  ['hash', { text: '#', glue: 'right' }],
  ['pound sign', { text: '#', glue: 'right' }],
  ['hashtag', { text: '#', glue: 'right' }],
  ['percent', { text: '%', glue: 'both' }],
  ['caret', { text: '^', glue: 'right' }],
  ['question mark', { text: '?', glue: 'left' }],
  ['exclamation mark', { text: '!', glue: 'right' }],
  ['exclamation point', { text: '!', glue: 'right' }],
  ['bang', { text: '!', glue: 'right' }],
  ['backtick', { text: '`', glue: 'right' }],
  ['back tick', { text: '`', glue: 'right' }],
  ['open paren', { text: '(', glue: 'right' }],
  ['open parenthesis', { text: '(', glue: 'right' }],
  ['left paren', { text: '(', glue: 'right' }],
  ['close paren', { text: ')', glue: 'left' }],
  ['close parenthesis', { text: ')', glue: 'left' }],
  ['right paren', { text: ')', glue: 'left' }],
  ['open bracket', { text: '[', glue: 'right' }],
  ['left bracket', { text: '[', glue: 'right' }],
  ['close bracket', { text: ']', glue: 'left' }],
  ['right bracket', { text: ']', glue: 'left' }],
  ['open brace', { text: '{', glue: 'right' }],
  ['open curly', { text: '{', glue: 'right' }],
  ['left brace', { text: '{', glue: 'right' }],
  ['close brace', { text: '}', glue: 'left' }],
  ['close curly', { text: '}', glue: 'left' }],
  ['right brace', { text: '}', glue: 'left' }],
  ['comma', { text: ',', glue: 'left' }],
]

const QUOTES: Record<string, string> = {
  'double quote': '"',
  'double quotes': '"',
  quote: '"',
  quotes: '"',
  'single quote': "'",
  'single quotes': "'",
  apostrophe: "'",
}

const NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
}

/** Mis-heard command names — applied only in command position (start, after | && ; sudo). */
const COMMANDS: Record<string, string> = {
  get: 'git', gate: 'git', gets: 'git', git: 'git',
  pseudo: 'sudo', 'sue do': 'sudo', sudo: 'sudo',
  'see d': 'cd', seedy: 'cd', 'c d': 'cd', cd: 'cd',
  'l s': 'ls', ls: 'ls', list: 'ls',
  'make dir': 'mkdir', 'make directory': 'mkdir', mkdir: 'mkdir',
  grip: 'grep', grab: 'grep', grep: 'grep',
  'and pm': 'npm', 'in pm': 'npm', 'n p m': 'npm', npm: 'npm',
  'p m 2': 'pm2',
  'python three': 'python3', 'python 3': 'python3', 'pip three': 'pip3', 'pip 3': 'pip3',
  'get hub': 'gh', 'g h': 'gh',
  'engine x': 'nginx', 'sea make': 'cmake', 'see make': 'cmake',
  'cat': 'cat', 'tail': 'tail', 'less': 'less', 'more': 'more',
  'r m': 'rm', 'c p': 'cp', 'm v': 'mv', 'p s': 'ps', 'd f': 'df', 'd u': 'du',
  'touch': 'touch', 'echo': 'echo', 'eco': 'echo',
  'curl': 'curl', 'girl': 'curl', 'kernel': 'curl',
  'w get': 'wget', 'v i': 'vi', 'vim': 'vim', 'nano': 'nano',
  'docker': 'docker', 'doctor': 'docker',
  'kube control': 'kubectl', 'cube control': 'kubectl', 'kube c t l': 'kubectl',
  'brew': 'brew', 'bru': 'brew',
  'which': 'which', 'witch': 'which',
  'ssh': 'ssh', 's s h': 'ssh',
  'scp': 'scp', 's c p': 'scp',
  'tmux': 'tmux', 't mux': 'tmux', 'tea mux': 'tmux',
  'claude': 'claude', 'cloud': 'claude', 'clod': 'claude',
  'exit': 'exit', 'clear': 'clear',
}

const SEPARATORS = new Set(['|', '&&', '||', ';', 'sudo', 'xargs', 'time', 'nohup'])

/** Prefer the terminal-command reading of the spoken text. */
export function spokenToCommand(input: string): string {
  let text = input.trim()
  if (!text) return ''
  // Whisper spells acronyms as "L.S." / "N.P.M." — fold to "LS".
  text = text.replace(/\b((?:[A-Za-z]\.){2,})/g, m => m.replace(/\./g, ''))
  // Sentence punctuation is noise; keep punctuation that is part of a token (google.com, -la).
  text = text.replace(/[,!?;:]+(\s|$)/g, '$1').replace(/\.+$/, '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const lower = words.map(w => w.toLowerCase())

  type Tok = { text: string; glue: Glue; kind: 'word' | 'sym'; capital?: boolean }
  const toks: Tok[] = []
  let quoteOpen: Record<string, boolean> = {}
  let capitalNext: 'first' | 'all' | null = null
  let lowerNext = false
  let envNext = false
  for (let i = 0; i < words.length; i++) {
    // multi-word phrases (symbols, quotes, command fixes)
    let matched = false
    for (const [phrase, sym] of PHRASES) {
      const n = phrase.split(' ').length
      if (lower.slice(i, i + n).join(' ') === phrase) {
        toks.push({ text: sym.text, glue: sym.glue, kind: 'sym' })
        i += n - 1
        matched = true
        break
      }
    }
    if (matched) continue
    for (const q of Object.keys(QUOTES).sort((a, b) => b.length - a.length)) {
      const n = q.split(' ').length
      if (lower.slice(i, i + n).join(' ') === q) {
        const ch = QUOTES[q]
        const open = !quoteOpen[ch]
        quoteOpen[ch] = open
        toks.push({ text: ch, glue: open ? 'right' : 'left', kind: 'sym' })
        i += n - 1
        matched = true
        break
      }
    }
    if (matched) continue
    const w = lower[i]
    if (w === 'space') {
      toks.push({ text: '', glue: 'none', kind: 'sym' })
      continue
    }
    if (w === 'capital') {
      capitalNext = 'first'
      continue
    }
    if (w === 'uppercase' || w === 'upper' || w === 'caps' || w === 'all caps') {
      capitalNext = 'all'
      continue
    }
    if (w === 'lowercase' || w === 'lower') {
      lowerNext = true
      continue
    }
    let out = w
    if (NUMBERS[w] !== undefined) out = NUMBERS[w]
    if (capitalNext) {
      out = capitalNext === 'all' ? words[i].toUpperCase() : words[i].charAt(0).toUpperCase() + words[i].slice(1).toLowerCase()
      capitalNext = null
    } else if (lowerNext) {
      lowerNext = false
    } else if (envNext) {
      out = words[i].toUpperCase()
    } else if (/^[A-Z]{2,}$/.test(words[i]) && words[i].length <= 4) {
      out = words[i].toLowerCase() // "LS", "NPM"
    }
    envNext = false
    toks.push({ text: out, glue: 'none', kind: 'word' })
    if (toks[toks.length - 2]?.text === '$') envNext = false
  }
  // `$HOME`: uppercase the word after a dollar sign.
  for (let i = 1; i < toks.length; i++) if (toks[i - 1].text === '$' && toks[i].kind === 'word') toks[i].text = toks[i].text.toUpperCase()

  // Merge spelled letters: "l s" → "ls", "r f" → "rf" (after a dash → "-rf").
  const merged: Tok[] = []
  for (const t of toks) {
    const prev = merged[merged.length - 1]
    if (t.kind === 'word' && prev?.kind === 'word' && /^[a-z]$/i.test(t.text) && /^[a-z]{1,3}$/i.test(prev.text) && prev.text.length < 4 && prev.text === prev.text.toLowerCase() && isSpelled(prev, t)) {
      prev.text += t.text
      continue
    }
    merged.push(t)
  }

  // Command-name fixes in command position (multi-word first).
  const fixed: Tok[] = []
  for (let i = 0; i < merged.length; i++) {
    const t = merged[i]
    const cmdPos = i === 0 || SEPARATORS.has(merged[i - 1].text)
    if (t.kind === 'word' && cmdPos) {
      let done = false
      for (const [phrase, cmd] of Object.entries(COMMANDS).sort((a, b) => b[0].length - a[0].length)) {
        const parts = phrase.split(' ')
        if (parts.length > 1 && merged.slice(i, i + parts.length).every((x, k) => x.kind === 'word' && x.text === parts[k])) {
          fixed.push({ text: cmd, glue: 'none', kind: 'word' })
          i += parts.length - 1
          done = true
          break
        }
      }
      if (done) continue
      if (COMMANDS[t.text]) {
        fixed.push({ ...t, text: COMMANDS[t.text] })
        continue
      }
    }
    fixed.push(t)
  }
  // "python 3" / "pip 3" anywhere → python3 / pip3
  for (let i = 0; i + 1 < fixed.length; i++) {
    if ((fixed[i].text === 'python' || fixed[i].text === 'pip') && fixed[i + 1].text === '3') {
      fixed[i].text += '3'
      fixed.splice(i + 1, 1)
    }
  }

  // Assemble with glue rules.
  let out = ''
  for (let i = 0; i < fixed.length; i++) {
    const t = fixed[i]
    const prev = fixed[i - 1]
    if (i === 0) {
      out = t.text
      continue
    }
    let space = true
    const before = fixed[i - 2]
    // A word right after "-"/"--" is a flag ("-la", "--save").
    const prevIsFlag = prev.kind === 'word' && (/^-/.test(prev.text) || (before?.glue === 'right' && (before.text === '-' || before.text === '--')))
    if (t.glue === 'left' || t.glue === 'both') space = false
    if (prev.glue === 'right' || prev.glue === 'both') space = false
    if ((t.text === '-' || t.text === '--') && prevIsFlag) space = false // multi-part flag: --save-dev
    if (t.glue === 'pathish') {
      // "." and "/" attach to the word before them, except right after the
      // command itself or after a flag: "ls /tmp", "cd foo/bar", "cat ./x.txt".
      const prevIsCmd = i === 1 || (i >= 2 && SEPARATORS.has(fixed[i - 2].text))
      const prevIsWord = prev.kind === 'word'
      const prevGlues = prev.glue === 'right' || prev.glue === 'both' || prev.glue === 'pathish'
      space = !(prevGlues || (prevIsWord && !prevIsCmd && !prevIsFlag))
      // A lone trailing "." is the cwd argument ("git add .", "grep -r todo .").
      if (t.text === '.' && i === fixed.length - 1 && !prevGlues) space = true
    }
    if (prev.glue === 'pathish') space = false
    if (prev.text === '' || t.text === '') space = true
    out += (space ? ' ' : '') + t.text
  }
  return out.replace(/\s+/g, ' ').trim()
}

function isSpelled(prev: { text: string }, cur: { text: string }): boolean {
  // Only merge when the previous token is itself a single letter or an already-merged
  // run of letters (so "cd r" stays "cd r" but "r m" → "rm", "l s dash l a" → "ls -la").
  return prev.text.length === 1 || /^[a-z]{2,3}$/.test(prev.text) && cur.text.length === 1 && prev.text.length < 3
}

/**
 * Optional second pass through the local Claude Code CLI (uses the user's own
 * subscription, no API key). CLAUDEDECK_SILENT keeps its hooks from registering
 * a session with the bridge.
 */
export interface ResolveOptions {
  /** Directory of the terminal pane; the agent explores it read-only. */
  cwd?: string
  model?: string
  timeoutMs?: number
}

const RESOLVE_SYSTEM =
  'You turn ONE dictated request into ONE runnable shell command line for the current directory (zsh/bash). ' +
  'The command starts with a program name (ls, cd, cat, grep, git, ...) — a bare path is never a valid answer. ' +
  'Spoken names are phonetic approximations of real file and directory names: match them against the listing, ' +
  'or check deeper with the read-only tools (ls, find, Glob) when needed. Prefer relative paths; quote names with spaces. ' +
  'Never modify anything. Never ask questions and never explain: if the request is unclear or nothing matches, ' +
  'return the rule-based draft unchanged. Do not explore for requests that name no file or directory.'

const RESOLVE_SCHEMA = JSON.stringify({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] })

/** Up to `max` entries of `dir`, directories marked with a trailing slash, dotfiles last. */
export function listingOf(dir: string, max = 80): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => {
    const da = a.startsWith('.') ? 1 : 0
    const db = b.startsWith('.') ? 1 : 0
    return da - db || a.localeCompare(b)
  })
  return names.length > max ? [...names.slice(0, max), `… (${names.length - max} more)`] : names
}

/**
 * Speech → command with a small read-only agent: `claude -p` (sonnet by default)
 * running in the pane's directory, tools limited to ls/find/Glob, the
 * directory listing pre-injected so most requests resolve in one turn
 * ("change directory to mandel glif" → `cd Mandelglyph`). Rejects on any
 * failure so the caller can fall back to the rule-based draft.
 */
export function resolveCommand(spoken: string, draft: string, opts: ResolveOptions = {}): Promise<string> {
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir()
  const listing = listingOf(cwd)
  const prompt =
    `Current directory: ${cwd}\n` +
    `Entries: ${listing.join(' ') || '(empty)'}\n` +
    `Spoken: "${spoken}"\n` +
    `Rule-based draft: "${draft}"`
  const args = [
    '-p', prompt,
    '--model', opts.model || 'sonnet',
    '--system-prompt', RESOLVE_SYSTEM,
    '--tools', 'Bash', 'Glob',
    '--allowedTools', 'Bash(ls:*)', 'Bash(find:*)', 'Glob',
    '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Bash(rm:*)', 'Bash(mv:*)',
    '--max-turns', '4',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', RESOLVE_SCHEMA,
  ]
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      // stdin must be closed: otherwise the CLI waits 3 s for piped input.
      { cwd, timeout: opts.timeoutMs ?? 30_000, env: { ...process.env, CLAUDEDECK_SILENT: '1' }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        const command = parseResolveOutput(stdout)
        if (!command) return reject(new Error('no command in reply'))
        resolve(sanitizeCommand(command, draft))
      },
    )
    child.stdin?.end()
  })
}

/** The CLI prints a warning line and then one JSON result object; take the structured field. */
function parseResolveOutput(stdout: string): string | undefined {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const d = JSON.parse(t) as { structured_output?: { command?: unknown }; result?: string; is_error?: boolean }
      if (d.is_error) return undefined
      const c = d.structured_output?.command
      if (typeof c === 'string') return c
      if (typeof d.result === 'string') {
        try {
          const inner = JSON.parse(d.result) as { command?: unknown }
          if (typeof inner.command === 'string') return inner.command
        } catch {
          return d.result
        }
      }
    } catch {
      /* not the result line */
    }
  }
  return undefined
}

/** One line, no fences/prompt, never a question; a bare path gets the draft's verb back. */
function sanitizeCommand(raw: string, draft: string): string {
  const line = raw.replace(/```[a-z]*/g, '').trim().split('\n').map(l => l.trim()).find(l => l) ?? ''
  const cmd = line.replace(/^\$\s+/, '').replace(/\.$/, '')
  if (!cmd || cmd.endsWith('?') || cmd.length > 300) return draft
  const first = cmd.split(/\s+/)[0]
  const verb = draft.split(/\s+/)[0]
  // "Mandelglyph/src/main.py" for "list …" → "ls Mandelglyph/src/main.py"
  if (/[\/.]/.test(first) && !first.startsWith('./') && !first.startsWith('/') && verb && /^[a-z][a-z0-9_-]*$/.test(verb) && verb !== first) return `${verb} ${cmd}`
  return cmd
}

/** Blind refine (no filesystem access); kept for callers without a pane directory. */
export function refineWithClaude(spoken: string, draft: string, model = 'haiku', timeoutMs = 25_000): Promise<string> {
  const prompt =
    'You turn dictated speech into ONE shell command line for a Unix terminal. ' +
    'Reply with only the command, no explanation, no code fences, no trailing period. ' +
    `Spoken text: "${spoken}"\nRule-based draft: "${draft}"`
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--model', model, '--output-format', 'text'],
      { timeout: timeoutMs, env: { ...process.env, CLAUDEDECK_SILENT: '1' }, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        const line = stdout.replace(/```[a-z]*/g, '').trim().split('\n').map(l => l.trim()).find(l => l) ?? ''
        if (!line) return reject(new Error('empty reply'))
        resolve(line.replace(/^\$\s+/, ''))
      },
    )
  })
}
