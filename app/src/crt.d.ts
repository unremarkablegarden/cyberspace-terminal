// @cyberspace/crt's JS half; typings cover what the app uses.

declare module '@cyberspace/crt' {
  export interface CrtScreen {
    term: any
    crt: any
    canvas: HTMLCanvasElement
  }
  export function mount(canvas: HTMLCanvasElement, program: unknown): Promise<CrtScreen>
}

declare module '@cyberspace/crt/term' {
  export class CellGrid {
    constructor(font: { cellW: number; cellH: number }, cols?: number, rows?: number)
    cols: number
    rows: number
    dirty: boolean
    chars: Uint16Array
    attrs: Uint8Array
    inverse: Uint8Array
    gfx: (ArrayLike<number> | undefined)[]
    font: { cellW: number; cellH: number }
    advance: number
    cx: number
    cy: number
    cursorVisible: boolean
    showCursor: boolean
    clear(): void
    put(x: number, y: number, ch: string | number, attr?: number, inv?: number): void
    putGlyph(x: number, y: number, bits: ArrayLike<number>, attr?: number, inv?: number): void
    text(x: number, y: number, str: string, attr?: number, inv?: number): number
    write(str: string, attr?: number): void
    writeln(str?: string, attr?: number): void
    newline(): void
    scrollView(delta: number): boolean
  }
  export const NORMAL: number
  export const BRIGHT: number
  export const BOLD: number
  export const DIM: number
  export const ALT: number
  export const ITALIC: number
  export const MUTED: number
  export const FAINT: number
  export const BG: number
}

declare module '@cyberspace/crt/config' {
  export const RENDER: { cursor: boolean; blinkMs: number; superSample: number; pixelBudget: number }
  export const GRID: { cols: number; rows: number; padX: number; padY: number }
  export const PRESETS: Record<string, Record<string, number>>
  export const PHOSPHORS: Record<string, [number, number, number]>
  export const PHOSPHOR: string
}
