declare module 'qrcode' {
  interface Opts {
    type?: 'terminal' | 'svg' | 'utf8'
    small?: boolean
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
  export function toString(text: string, opts?: Opts): Promise<string>
}
