// The /emo kaomoji picker shared by circ and cmail.
//
// The list is the website's, cut to the entries that draw without change: every
// character one cell under plain() and present in the 6x13 coverage face, which
// every face borrows from. The rest would arrive here as pool symbols or `?`.

import { SelectPopup, type InputLine, type KeyInput, type Rect } from '@cyberspace/tui'
import { ARROWS, type ChatSound } from './chat.js'

export const EMOTICONS: { name: string; emoticon: string }[] = [
  { name: 'smile', emoticon: '^_^' },
  { name: 'cheerful', emoticon: '(´∀`)ﾉ♪' },
  { name: 'hooray', emoticon: '(≧∇≦)/' },
  { name: 'pleased', emoticon: '(⌒‿⌒)' },
  { name: 'flower', emoticon: '(✿◠‿◠)' },
  { name: 'sparkle', emoticon: '(✧ω✧)' },
  { name: 'starry', emoticon: '(⌒▽⌒)☆' },
  { name: 'joyful', emoticon: '(≧▽≦)' },
  { name: 'dazzle', emoticon: '(✧∀✧)' },
  { name: 'gleeful', emoticon: '(≧∀≦)' },
  { name: 'elated', emoticon: '(≧ω≦)' },
  { name: 'uwu', emoticon: '(◕‿◕✿)' },
  { name: 'shy', emoticon: '(„• ֊ •„)' },
  { name: 'chuffed', emoticon: '(◍′◡‵◍)' },
  { name: 'love', emoticon: '(♥‿♥)' },
  { name: 'smitten', emoticon: '(ღ˘⌣˘ღ)' },
  { name: 'lovestruck', emoticon: '(♥ω♥*)' },
  { name: 'tears', emoticon: '(╥_╥)' },
  { name: 'crying', emoticon: '(T_T)' },
  { name: 'dead', emoticon: '(×_×;)' },
  { name: 'grumpy', emoticon: '(¬`‸´¬)' },
  { name: 'surprised', emoticon: '(⊙_◎)' },
  { name: 'wow', emoticon: '(⊙ω⊙)' },
  { name: 'confused', emoticon: '(⊙_☉)' },
  { name: 'huh', emoticon: '(⊙_ʖ⊙)' },
  { name: 'nervous', emoticon: '(°_°;)' },
  { name: 'tired', emoticon: '(=_=)' },
  { name: 'drowsy', emoticon: '(˘▾˘)' },
  { name: 'cool', emoticon: '(⌐■_■)' },
  { name: 'wink', emoticon: '(^_~)' },
  { name: 'sneaky', emoticon: 'ԅ(‾⌣‾ԅ)' },
  { name: 'devil', emoticon: '(｡◕‿‿◕｡)' },
  { name: 'wave', emoticon: '(^_^)/~' },
  { name: 'gun', emoticon: '(⌐■_■)–|==>' },
  { name: 'dog', emoticon: '∪･ω･∪' },
  { name: 'bird', emoticon: '(•ө•)' },
  { name: 'owl', emoticon: '(ↀДↀ)' },
  { name: 'mouse', emoticon: '(=ↀωↀ=)' },
  { name: 'monkey', emoticon: '@(･o･)@' },
  { name: 'robot', emoticon: '[◉_◉]' },
  { name: 'alien', emoticon: '(◣_◢)' },
  { name: 'cat', emoticon: '(=^･ω･^=)' },
  { name: 'fatcat', emoticon: '(=①ω①=)' },
  { name: 'sleepycat', emoticon: '(=^-ω-^=)' },
  { name: 'happycat', emoticon: '(=^･ｪ･^=)' },
  { name: 'catpaw', emoticon: '=^._.^= ∫' },
]

const TRIGGER = '/emo'

/**
 * Where a `/emo` just typed before the caret starts, or -1.
 * Only at the start of the line or after a space, so a path or URL ending in /emo does not open the picker.
 */
export function emoAt(input: InputLine): number {
  const before = input.value.slice(0, input.caret)
  if (!before.endsWith(TRIGGER)) return -1
  const start = before.length - TRIGGER.length
  return start === 0 || /\s/.test(before[start - 1]!) ? start : -1
}

/** Whether the key types a character into the line. */
export const typed = (k: KeyInput): boolean =>
  k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey

/** Replace the `/emo` at `start` with the emoticon, caret after it. */
export function emoInsert(input: InputLine, start: number, emoticon: string): void {
  const value = input.value
  input.set(value.slice(0, start) + emoticon + value.slice(start + TRIGGER.length), start + emoticon.length)
}

export interface EmoPickerOptions {
  bounds: Rect
  snd: ChatSound
  onRepaint: () => void
  /** The chosen emoticon, or null on Escape. The caller pops the screen. */
  onDone: (emoticon: string | null) => void
}

export function emoPicker(opts: EmoPickerOptions): SelectPopup {
  return new SelectPopup({
    title: 'EMO',
    hint: `${ARROWS} ↵`,
    items: EMOTICONS.map(e => e.emoticon),
    bounds: opts.bounds,
    shadow: true,
    onRepaint: opts.onRepaint,
    onFeedback: (kind) => {
      if (kind === 'edge') opts.snd.beep(220, 0.04)
      else if (kind === 'move') opts.snd.tick()
      else if (kind === 'cancel') opts.snd.blip(420, 0.09, 0)
    },
    onDone: (_item, index) => opts.onDone(EMOTICONS[index]?.emoticon ?? null),
  })
}
