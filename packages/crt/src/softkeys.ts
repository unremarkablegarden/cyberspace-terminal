// Turning a soft keyboard into keystrokes.
//
// A phone keyboard does not produce reliable KeyboardEvents. This is the
// translation layer: pure functions over an `inputType` string, because every
// rule here is a claim about what two browser engines do. The host owns the
// hidden field and feeds the results into the same path a physical key takes.
//
// ## The problem
//
// A `<canvas>` cannot raise a soft keyboard — only a focused editable element
// can — and once one is focused, `keydown` stops being a reliable account of
// what was typed:
//
//   - **iOS Safari** fires BOTH `keydown` (with the real `key`) and
//     `beforeinput` (`insertText`) for one tap. Handling both types everything
//     twice.
//   - **Android GBoard** fires `keydown` with `key: 'Unidentified'` and
//     `keyCode: 229` for letters — the character only ever appears on
//     `beforeinput`. Handling only `keydown` types nothing at all.
//
// So neither event alone is enough and both together are too much.
//
// ## The rule
//
// Split by which event is AUTHORITATIVE for a given key, and let
// `preventDefault` enforce the split rather than a flag that has to be kept in
// sync:
//
//   - **`keydown` owns every key that is not text** — the arrows, Escape, Tab,
//     Home/End, Enter, Backspace, and anything wearing a modifier. All of them
//     are `preventDefault`ed, which SUPPRESSES the matching `beforeinput`
//     entirely. That is what makes the two paths mutually exclusive by
//     construction: there is no window in which both fire for one press.
//   - **`beforeinput` owns text**, because on Android that is the only place a
//     character exists. Printable `keydown`s are deliberately let through
//     un-prevented so their `beforeinput` still arrives.
//
// `softKeydownWanted` is the first half of that rule; `softInputKeys` is the
// second.

/**
 * Keys the page still takes from `keydown` while a soft keyboard is up.
 *
 * True for everything that produces no `beforeinput` — so handling it here
 * cannot double up — plus Enter and Backspace, which DO produce one and are
 * claimed here on purpose (see below). False for printable characters, whose
 * `keydown` is worthless on Android and duplicated on iOS.
 *
 * `'Unidentified'` is GBoard's placeholder and is the single most important
 * thing in this function to get right: its `key.length` is 12, so any test
 * shaped like "not a single character" would let it through as a named key and
 * the shell would be handed a keystroke that does not exist.
 */
export function softKeydownWanted(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): boolean {
  if (e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return false
  // A chord is never text, whatever it is chorded with — this is how the helper
  // bar's CTRL row and a Bluetooth keyboard's Ctrl-C both arrive.
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  return NAMED_KEYS.has(e.key)
}

/**
 * The non-text keys, spelled out rather than inferred from `key.length > 1`.
 *
 * A list, because the inferred version is wrong in both directions: it admits
 * `'Unidentified'`, and it admits every dead-key and IME placeholder any engine
 * has ever invented. What the terminal actually answers is a short list, and
 * anything outside it is either text or nothing.
 *
 * `Enter` and `Backspace` are in here even though both produce a `beforeinput`.
 * They are claimed by `keydown` because that is the ONE event both engines agree
 * on for them, and taking them here `preventDefault`s the `beforeinput` away —
 * where the reverse (letting `beforeinput` own them) depends on the hidden field
 * having something in it to delete. See SENTINEL.
 */
const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/**
 * What the hidden field is kept holding, so that deleting is always possible.
 *
 * The `deleteContentBackward` fallback below only fires if there is something
 * behind the caret to delete — an empty field with a collapsed caret at offset
 * zero has nothing to remove, and engines are entitled to fire no event at all.
 * One character the page never reads makes the fallback reachable.
 *
 * A space rather than a zero-width space: ZWSP is a formatting character, and
 * predictive keyboards have been known to treat one as part of the word being
 * composed. The field is `opacity: 0` and its value is never read, so what the
 * character IS only matters to the IME looking at it.
 */
export const SENTINEL = ' '

/** What a `beforeinput` on the hidden field means. */
export type SoftInput =
  /** Feed these to the shell in order, as if typed. */
  | { kind: 'keys'; keys: string[] }
  /** Nothing to do — including things deliberately handled elsewhere. */
  | { kind: 'ignore' }

/**
 * A `beforeinput` on the hidden field, as keystrokes.
 *
 * The caller `preventDefault`s unconditionally, whatever comes back: the field's
 * value is a fiction held at SENTINEL, and letting any edit land would make the
 * next `deleteContentBackward` delete real content instead of signalling a
 * Backspace.
 *
 * Composition is handled as plain text (`insertCompositionText`) rather than
 * with `compositionstart`/`end` bookkeeping. That is a best effort and is honest
 * about it: a committed CJK phrase arrives as characters and works, while the
 * in-progress candidate state a real IME wants to show cannot be, because the
 * grid it would be shown on is one byte of beam per pixel with no overlay to
 * draw candidates in. The faces barely cover CJK anyway — see `Term.fallback`.
 */
export function softInputKeys(inputType: string, data: string | null): SoftInput {
  switch (inputType) {
    case 'insertText':
    case 'insertCompositionText':
    case 'insertReplacementText':
      // Split with the spread, not `data.split('')`: a spread iterates by code
      // POINT, so an emoji or anything else outside the BMP arrives as one key
      // rather than as two halves of a surrogate pair. The grid will draw it as
      // `?` either way, but half a surrogate is a different and worse `?`.
      return data ? { kind: 'keys', keys: [...data] } : { kind: 'ignore' }

    // Reached only when `keydown` did not claim it — an IME that sends no
    // Backspace keydown. See SENTINEL for why there is anything to delete.
    case 'deleteContentBackward':
      return { kind: 'keys', keys: ['Backspace'] }
    case 'deleteContentForward':
      return { kind: 'keys', keys: ['Delete'] }

    // A newline that arrived as an edit rather than as a keypress. Same
    // fallback role as the delete above.
    case 'insertLineBreak':
    case 'insertParagraph':
      return { kind: 'keys', keys: ['Enter'] }

    // Deliberately not ours. The `paste` event fires first and is the terminal's
    // one clipboard path — it is the only place the full text is available, and
    // it is what reaches `Shell.onPaste` and the block-paste route `/art`
    // depends on. Handling it here as well would paste twice.
    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation':
      return { kind: 'ignore' }

    default:
      return { kind: 'ignore' }
  }
}
