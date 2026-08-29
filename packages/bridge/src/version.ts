/** Bridge version, advertised in hello / health and compared against relayed remotes. */
export const VERSION = '0.4.0'

/** Oldest remote bridge that understands `terminal_new` / `ctrl_c` / `kill` (added in 0.3.0). */
export const MIN_REMOTE_VERSION = '0.3.0'

/** Compare dotted versions: negative when a < b. Missing/garbage versions count as 0.0.0. */
export function compareVersions(a: string | undefined, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function parse(v: string | undefined): number[] {
  const m = (v ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}
