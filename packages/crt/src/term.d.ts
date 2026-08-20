export const NORMAL: number
export const BRIGHT: number
export const BOLD: number
export const DIM: number
export const ALT: number
export const ITALIC: number
export const MUTED: number
export const FAINT: number
export const BG: number
export const ATTR_MASK: number
export const SCROLLBACK_MAX: number

export class CellGrid {
  cols: number
  rows: number
  dirty: boolean
  chars: Uint16Array
  attrs: Uint8Array
  inverse: Uint8Array
  cx: number
  cy: number
  cursorVisible: boolean
  showCursor: boolean
  clear(): void
  put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
  putGlyph(x: number, y: number, bits: number[], attr?: number, inv?: number): void
  text(x: number, y: number, str: string, attr?: number, inv?: number): number
  write(str: string, attr?: number): void
  writeln(str?: string, attr?: number): void
  scrollView(delta: number): boolean
}

export class Term extends CellGrid {
  w: number
  h: number
  fb: Uint8Array
  bold: unknown
  italic: unknown
  alt: unknown
  fallback: unknown
  setFont(font: unknown): void
  clearCuts(): void
  raster(): void
}
