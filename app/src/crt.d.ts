// @cyberspace/crt is plain JS; typings cover what the app uses.

declare module '@cyberspace/crt' {
  export function mount(canvas: HTMLCanvasElement, program: unknown): Promise<unknown>
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
  export const PHOSPHORS: Record<string, [number, number, number]>
}
