// The available fonts and the cuts each provides. A family is a roman plus
// whatever else was drawn for it: a real bold is used where present and falls
// back to the smear otherwise, and a missing oblique draws roman rather than a
// synthetic italic.
//
// Each URL must be an inline `new URL(...)` literal. Vite emits assets by static
// analysis of the call site, so wrapping this in a helper fails silently.

import { parseBDF } from './bdf.js'

export interface FontFamily {
  name: string
  regular: string
  bold?: string
  italic?: string
}

/** The first entry is the default. Terminus leads because its bold matches its roman's coverage. */
export const FAMILIES: FontFamily[] = [
  {
    name: 'terminus-8x16',
    regular: new URL('../fonts/ter-u16n.bdf', import.meta.url).href,
    bold: new URL('../fonts/ter-u16b.bdf', import.meta.url).href,
  },
  {
    name: 'terminus-10x20',
    regular: new URL('../fonts/ter-u20n.bdf', import.meta.url).href,
    bold: new URL('../fonts/ter-u20b.bdf', import.meta.url).href,
  },
  // The only family with a real oblique as well as a real bold.
  {
    name: '6x13',
    regular: new URL('../fonts/6x13.bdf', import.meta.url).href,
    bold: new URL('../fonts/6x13B.bdf', import.meta.url).href,
    italic: new URL('../fonts/6x13O.bdf', import.meta.url).href,
  },
  {
    name: 'spleen-8x16',
    regular: new URL('../fonts/spleen-8x16.bdf', import.meta.url).href,
  },
  {
    name: 'spleen-12x24',
    regular: new URL('../fonts/spleen-12x24.bdf', import.meta.url).href,
  },
  // The Apple II text ROM: 95 code points and no box drawing, so everything else
  // is borrowed from the coverage face.
  {
    name: 'apple-ii-7x8',
    regular: new URL('../fonts/apple-ii-full-7x8.bdf', import.meta.url).href,
  },
]

/**
 * The coverage face, used as Term.fallback: 6x13 roman, 4124 glyphs, the widest
 * shipped here. Every other face borrows code points it lacks from this one.
 */
export const FALLBACK_FONT = new URL('../fonts/6x13.bdf', import.meta.url).href

export const FONT_NAMES = FAMILIES.map(f => f.name)

export function familyOf(name: string): FontFamily {
  return FAMILIES.find(f => f.name === name) ?? FAMILIES[0]
}

async function fetchFont(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`font ${url}: ${res.status}`)
  return parseBDF(await res.text())
}

interface TermFontSlots {
  bold: unknown
  italic: unknown
  fallback: unknown
  dirty: boolean
  setFont(font: unknown): void
  clearCuts(): void
  w: number
  h: number
}

/**
 * Load a family into the term: the roman synchronously, the other cuts in the
 * background. The caller must then point the CRT at the resized framebuffer with
 * crt.setSource(term.w, term.h).
 */
export async function loadFamily(term: TermFontSlots, family: FontFamily): Promise<void> {
  const roman = await fetchFont(family.regular)
  term.clearCuts()
  term.setFont(roman)
  if (family.bold) fetchFont(family.bold).then(f => { term.bold = f; term.dirty = true }).catch(() => {})
  if (family.italic) fetchFont(family.italic).then(f => { term.italic = f; term.dirty = true }).catch(() => {})
}

/** Load the coverage face into Term.fallback. Not awaited. */
export async function loadFallback(term: TermFontSlots): Promise<void> {
  try {
    term.fallback = await fetchFont(FALLBACK_FONT)
    term.dirty = true
  } catch {}
}

/** The label for a family: its name plus the cuts it provides. */
export interface FontEntry {
  name: string
  label: string
}

/**
 * The FONT list.
 *
 * Each row is labelled with the cuts the family provides, as in `6x13 B+O`, so
 * the row states both the name and what selecting it gains. A family with
 * neither shows its name alone.
 */
export const FONT_ENTRIES: FontEntry[] = FAMILIES.map((f) => {
  const mark = [f.bold ? 'B' : '', f.italic ? 'O' : ''].filter(Boolean).join('+')
  return { name: f.name, label: mark ? `${f.name} ${mark}` : f.name }
})

const LABEL_OF = new Map(FONT_ENTRIES.map(e => [e.name, e.label]))
const NAME_OF = new Map(FONT_ENTRIES.map(e => [e.label, e.name]))

/** The label the config box shows for a loaded family. */
export const fontLabel = (name: string): string => LABEL_OF.get(name) ?? name

/** The family a config box row loads. */
export const fontFace = (label: string): string => NAME_OF.get(label) ?? label
