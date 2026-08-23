// The available key-sound packs.
//
// Every pack has the same layout on disk: key1..keyN.wav for the anonymous
// variants and one file per named group. The group names are the filenames, so
// no per-pack mapping table is needed.

/** Named keys a pack can provide, beyond the anonymous `default` variants. */
const SPECIALS = ['space', 'enter', 'del']

/**
 * The arrow keys, listed separately from SPECIALS because only some packs
 * provide them. sample() falls back to `default` for a pack without them.
 */
const ARROWS = ['arrup', 'arrdown', 'arrleft', 'arrright']

/**
 * One pack's mapping of group to sample URLs.
 *
 * `default` has several variants so a long type-out does not settle into an
 * audible loop; audio.ts adds playback-rate jitter as well.
 */
function pack(base: string, variants: number, groups: string[]): Record<string, string[]> {
  const urls: Record<string, string[]> = {
    default: Array.from({ length: variants }, (_, i) => `${base}/key${i + 1}.wav`),
  }
  for (const group of groups) urls[group] = [`${base}/${group}.wav`]
  return urls
}

/** One key-sound pack. The key is the label the CONFIG box shows. */
export interface KeyPack {
  urls: Record<string, string[]>
}

/**
 * The five packs, in the order CONFIG cycles them. Each directory carries its
 * own ATTRIBUTION.txt. The four beyond `mx red` were reduced from Thock
 * soundpacks to the eight groups used here, and all four are MIT licensed.
 */
export const KEY_PACKS: Record<string, KeyPack> = {
  'mx red': { urls: pack('/sounds/keys/cherry-mx-red-abs', 5, [...SPECIALS, ...ARROWS]) },
  'model m': { urls: pack('/sounds/keys/ibm-buckling-spring', 5, SPECIALS) },
  alps: { urls: pack('/sounds/keys/alps-skcm-blue', 5, SPECIALS) },
  oreo: { urls: pack('/sounds/keys/everglide-oreo', 5, [...SPECIALS, ...ARROWS]) },
  topre: { urls: pack('/sounds/keys/topre-purple-hybrid-pbt', 5, [...SPECIALS, ...ARROWS]) },
}

/** The pack used when a member has not chosen one. */
export const DEFAULT_KEY_PACK = 'mx red'

export const KEY_PACK_NAMES = Object.keys(KEY_PACKS)
