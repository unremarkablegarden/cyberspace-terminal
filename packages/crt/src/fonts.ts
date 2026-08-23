// The faces on offer, and which cuts each has. A family is a roman plus
// whatever was drawn to go with it: a real bold is used, an absent one falls
// back to the smear; an absent oblique draws roman (no synthetic italic).
//
// Each URL must be an inline `new URL(...)` literal — Vite emits assets by
// static analysis of the call site, and a helper breaks it silently.

import { parseBDF } from './bdf.js'

export interface FontFamily {
  name: string
  regular: string
  bold?: string
  italic?: string
}

/** First is the default. Terminus leads: its bold matches its roman's coverage. */
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
  // The Apple II text ROM: 95 codepoints, no box drawing — everything else is
  // borrowed from the coverage face. A period piece, priced like one.
  {
    name: 'apple-ii-7x8',
    regular: new URL('../fonts/apple-ii-full-7x8.bdf', import.meta.url).href,
  },
]

/**
 * The coverage face — Term.fallback. 6x13's roman: 4124 glyphs, the widest we
 * ship. Every other face borrows codepoints it lacks from this one.
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
 * Load a family into the term: roman synchronously, cuts behind it. The caller
 * re-points the CRT at the resized framebuffer (crt.setSource(term.w, term.h)).
 */
export async function loadFamily(term: TermFontSlots, family: FontFamily): Promise<void> {
  const roman = await fetchFont(family.regular)
  term.clearCuts()
  term.setFont(roman)
  if (family.bold) fetchFont(family.bold).then(f => { term.bold = f; term.dirty = true }).catch(() => {})
  if (family.italic) fetchFont(family.italic).then(f => { term.italic = f; term.dirty = true }).catch(() => {})
}

/** Load the coverage face into Term.fallback. Fire-and-forget. */
export async function loadFallback(term: TermFontSlots): Promise<void> {
  try {
    term.fallback = await fetchFont(FALLBACK_FONT)
    term.dirty = true
  } catch {}
}

/** What the list shows: the family, plus the cuts it actually has. */
export interface FontEntry {
  name: string
  label: string
}

/**
 * The FONT list.
 *
 * A family wears what it has — `6x13 B+O` — so the row says both what you are
 * picking and what picking it buys you. A face with neither is just its name,
 * which is the honest thing for it to be.
 */
export const FONT_ENTRIES: FontEntry[] = FAMILIES.map((f) => {
  const mark = [f.bold ? 'B' : '', f.italic ? 'O' : ''].filter(Boolean).join('+')
  return { name: f.name, label: mark ? `${f.name} ${mark}` : f.name }
})

const LABEL_OF = new Map(FONT_ENTRIES.map(e => [e.name, e.label]))
const NAME_OF = new Map(FONT_ENTRIES.map(e => [e.label, e.name]))

/** What the config box calls a loaded family. */
export const fontLabel = (name: string): string => LABEL_OF.get(name) ?? name

/** The family a row of the config box loads. */
export const fontFace = (label: string): string => NAME_OF.get(label) ?? label
