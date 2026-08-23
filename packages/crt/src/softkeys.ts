// Turning a soft keyboard into keystrokes.
//
// A phone keyboard does not produce reliable KeyboardEvents. This is the
// translation layer: pure functions over an `inputType` string, because every
// rule here is a claim about what two browser engines do. The host owns the
// hidden field and feeds the results into the same path a physical key takes.
//
// The problem
//
// A `<canvas>` cannot raise a soft keyboard — only a focused editable element
// can — and once one is focused, `keydown` stops being a reliable account of
// what was typed:
//
//   - iOS Safari fires both `keydown`, with the real `key`, and `beforeinput`
//     (`insertText`) for one tap, so handling both types every character twice.
//   - Android GBoard fires `keydown` with `key: 'Unidentified'` and
//     `keyCode: 229` for letters; the character appears only on `beforeinput`,
//     so handling `keydown` alone types nothing.
//
// Neither event alone is sufficient and both together duplicate input.
//
// The rule
//
// Each key is owned by one event, with `preventDefault` enforcing the split
// rather than a flag that must be kept in sync:
//
//   - `keydown` owns every non-text key: the arrows, Escape, Tab, Home/End,
//     Enter, Backspace, and anything with a modifier. All are preventDefaulted,
//     which suppresses the matching `beforeinput`, so the two paths are mutually
//     exclusive and never both fire for one press.
//   - `beforeinput` owns text, since on Android that is the only place a
//     character exists. Printable keydowns are left un-prevented so their
//     `beforeinput` still arrives.
//
// `softKeydownWanted` is the first half of that rule; `softInputKeys` is the
// second.

/**
 * Keys still taken from `keydown` while a soft keyboard is up.
 *
 * True for keys that produce no `beforeinput`, so handling them here cannot
 * duplicate, plus Enter and Backspace, which do produce one and are claimed
 * here deliberately (see below). False for printable characters, whose
 * `keydown` is unusable on Android and duplicated on iOS.
 *
 * `'Unidentified'` is GBoard's placeholder and must be excluded explicitly: its
 * key.length is 12, so a test of the form "not a single character" would admit
 * it as a named key and pass the shell a keystroke that does not exist.
 */
export function softKeydownWanted(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): boolean {
  if (e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return false
  // A modifier combination is never text. This is how the helper bar's Ctrl row
  // and a Bluetooth keyboard's Ctrl-C both arrive.
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  return NAMED_KEYS.has(e.key)
}

/**
 * The non-text keys, listed explicitly rather than inferred from key.length > 1.
 *
 * The inferred test is wrong in both directions: it admits 'Unidentified' and
 * every dead-key and IME placeholder an engine defines. The terminal handles a
 * short, known set, and anything outside it is text or nothing.
 *
 * Enter and Backspace are listed although both produce a `beforeinput`. They are
 * claimed by `keydown` because that is the one event both engines agree on for
 * them, and claiming them here preventDefaults the `beforeinput`. The reverse
 * would depend on the hidden field containing something to delete. See SENTINEL.
 */
const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/**
 * The value the hidden field is kept at, so a delete is always possible.
 *
 * The `deleteContentBackward` fallback below fires only when there is something
 * behind the caret: an empty field with a collapsed caret at offset zero has
 * nothing to remove, and an engine may fire no event at all. One character the
 * page never reads keeps the fallback reachable.
 *
 * A space rather than a zero-width space, which is a formatting character that
 * predictive keyboards may treat as part of the word being composed. The field
 * is opacity: 0 and its value is never read, so the character matters only to
 * the IME.
 */
export const SENTINEL = ' '

/** What a `beforeinput` on the hidden field means. */
export type SoftInput =
  /** Pass these to the shell in order, as if typed. */
  | { kind: 'keys'; keys: string[] }
  /** Nothing to do, including input deliberately handled elsewhere. */
  | { kind: 'ignore' }

/**
 * Translate a `beforeinput` on the hidden field into keystrokes.
 *
 * The caller preventDefaults unconditionally, whatever is returned: the field's
 * value is held at SENTINEL, and allowing an edit to land would make the next
 * `deleteContentBackward` delete real content rather than signalling Backspace.
 *
 * Composition is handled as plain text via `insertCompositionText` rather than
 * with compositionstart/end bookkeeping. This is a best effort: a committed CJK
 * phrase arrives as characters and works, but in-progress candidate state cannot
 * be shown, since the grid has one byte of beam per pixel and no overlay to draw
 * candidates in. The fonts have minimal CJK coverage in any case; see
 * Term.fallback.
 */
export function softInputKeys(inputType: string, data: string | null): SoftInput {
  switch (inputType) {
    case 'insertText':
    case 'insertCompositionText':
    case 'insertReplacementText':
      // Split with the spread rather than data.split(''), which splits by UTF-16
      // unit. The spread iterates by code point, so a character outside the BMP
      // arrives as one key rather than as two halves of a surrogate pair.
      return data ? { kind: 'keys', keys: [...data] } : { kind: 'ignore' }

    // Reached only when `keydown` did not claim it, as with an IME that sends no
    // Backspace keydown. See SENTINEL for why there is something to delete.
    case 'deleteContentBackward':
      return { kind: 'keys', keys: ['Backspace'] }
    case 'deleteContentForward':
      return { kind: 'keys', keys: ['Delete'] }

    // A newline arriving as an edit rather than a keypress. The same fallback
    // role as the delete above.
    case 'insertLineBreak':
    case 'insertParagraph':
      return { kind: 'keys', keys: ['Enter'] }

    // Deliberately not handled here. The `paste` event fires first and is the
    // terminal's only clipboard path: it is where the full text is available and
    // what reaches Shell.onPaste, which /art's block paste depends on. Handling
    // it here as well would paste twice.
    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation':
      return { kind: 'ignore' }

    default:
      return { kind: 'ignore' }
  }
}
