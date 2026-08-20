export interface BitmapFont {
  cellW: number
  cellH: number
  glyphs: Map<number, number[]>
}

export function parseBDF(text: string): BitmapFont
