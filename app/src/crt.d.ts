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
