// The keyboards the machine can wear.
//
// Every pack is laid out the same way on disk — `key1..keyN.wav` for the
// anonymous variants and one file per named group — so there is no per-pack
// table mapping a group to a file. The names ARE the filenames.

/** The special keys a pack can name, beyond the anonymous `default` variants. */
const SPECIALS = ['space', 'enter', 'del']

/**
 * The arrows, listed apart from SPECIALS because only some packs have them.
 *
 * A pack without them is not broken: `sample()` falls back to `default`, which
 * is what an arrow key on a real board sounds like anyway. It is only worth a
 * distinct sample because the boards that have one usually put a different
 * keycap profile up there.
 */
const ARROWS = ['arrup', 'arrdown', 'arrleft', 'arrright']

/**
 * One pack's group -> URLs table.
 *
 * `default` has several variants so a long type-out never settles into an
 * audible loop; audio.ts adds playback-rate jitter on top.
 */
function pack(base: string, variants: number, groups: string[]): Record<string, string[]> {
  const urls: Record<string, string[]> = {
    default: Array.from({ length: variants }, (_, i) => `${base}/key${i + 1}.wav`),
  }
  for (const group of groups) urls[group] = [`${base}/${group}.wav`]
  return urls
}

/** A keyboard the machine can wear. The key is what the CONFIG box shows. */
export interface KeyPack {
  urls: Record<string, string[]>
}

/**
 * The five, in the order CONFIG cycles them. Each directory carries its own
 * ATTRIBUTION.txt; the four beyond `mx red` were cut from Thock soundpacks down
 * to the eight groups this machine plays, and all four are MIT.
 */
export const KEY_PACKS: Record<string, KeyPack> = {
  'mx red': { urls: pack('/sounds/keys/cherry-mx-red-abs', 5, [...SPECIALS, ...ARROWS]) },
  'model m': { urls: pack('/sounds/keys/ibm-buckling-spring', 5, SPECIALS) },
  alps: { urls: pack('/sounds/keys/alps-skcm-blue', 5, SPECIALS) },
  oreo: { urls: pack('/sounds/keys/everglide-oreo', 5, [...SPECIALS, ...ARROWS]) },
  topre: { urls: pack('/sounds/keys/topre-purple-hybrid-pbt', 5, [...SPECIALS, ...ARROWS]) },
}

/** The board a member who has never chosen one gets. */
export const DEFAULT_KEY_PACK = 'mx red'

export const KEY_PACK_NAMES = Object.keys(KEY_PACKS)
