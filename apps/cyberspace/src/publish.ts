// Publish, recall and restore for a member's own programs.
//
// One command for the whole release lifecycle rather than three, because the
// verbs are never available at the same time: a draft can only be published, a
// published program can only be recalled, a recalled one can only be restored
// or replaced. The program's state selects the verb.
//
// The registry assigns versions (v1, v2, v3) and program source has no version
// field. An author-declared version would duplicate the fact and could disagree
// with the registry's. Every publish is the next integer, so republishing the
// same version cannot arise.

import { dec, paths, type Proc, type Program } from '@cyberspace/kernel'
import {
  Surface, ScreenStack, SelectPopup, ConfirmPopup, PromptPopup, YES_NO, parseKeys,
  type Screen,
} from '@cyberspace/tui'
import type { Runtime } from '@cyberspace/compat/classify'
import type { ApiClient } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { DESCRIPTION_MAX, ProgramStore, type StoredProgram } from './programs-store.js'

type Verb = 'publish' | 'recall' | 'restore' | 'delete'

/** The KIND column, as browse prints it. */
const KIND: Record<Runtime, string> = { web: 'web', term: 'term', wasm: 'wasm' }

/** Seeded into /bin/examples: read-only, and never in a member's ~/bin. */
const EXAMPLES = ['hello', 'roll', 'clock', 'river', 'news', 'count']

const B = (s: string): string => `\x1b[1m${s}\x1b[0m`
const D = (s: string): string => `\x1b[2m${s}\x1b[0m`

/** Actions available for this program in its current state, most likely first. */
function verbs(p: StoredProgram): Verb[] {
  if (p.takenDown) return []
  // Never published: publish is the only action, and there is no record to
  // delete — the registry has never heard of the file.
  if (p.release < 1) return ['publish']

  const out: Verb[] = p.published
    // Live. Replace is offered only when the source has changed; otherwise the
    // publish would create a version identical to the last.
    ? (p.changed ? ['publish', 'recall'] : ['recall'])
    // Recalled. Unchanged source can be restored as the same version; edited
    // source can only be published as a new one.
    : (p.changed ? ['publish'] : ['restore', 'publish'])

  // Last, because it is the only irreversible action on the list.
  out.push('delete')
  return out
}

/** One selector row, e.g. `bin/starfield   v3  grid  live`, which doubles as a status listing. */
function row(p: StoredProgram, width: number): string {
  const version = p.release > 0 ? `v${p.release}` : '—'
  const state = p.takenDown
    ? 'taken down'
    : p.published
      ? (p.changed ? 'live, edited' : 'live')
      : p.release > 0
        ? 'recalled'
        : 'draft'
  // Keyed by path, because two programs may share a basename in different
  // directories and the picker must distinguish them. The gallery shows the
  // basename instead, being a public listing.
  return `${p.path.padEnd(width)}  ${version.padStart(4)}  ${KIND[p.runtime].padEnd(4)}  ${state}`
}

/**
 * The consequences of each verb, shown before it runs.
 *
 * Publishing is the only irreversible action here: there is no unpublish, only
 * a recall that hides the program and a new version that replaces it. The box
 * states that rather than asking for confirmation over a name.
 */
function consequences(p: StoredProgram, verb: Verb, author: string): string[] {
  // Where a program is listed follows from its kind, and the web terminal runs
  // grid programs only. Nothing else on screen states that.
  const reach = p.runtime === 'web'
    ? []
    : ['', `Kind: ${KIND[p.runtime]}. It is listed on this machine`, 'only, not on the web terminal.']

  if (verb === 'publish') {
    const next = p.release + 1
    return p.release < 1
      ? [
          `Publish ${p.name} as v${next}.`,
          '',
          `Anyone can find it in browse, under @${author},`,
          p.runtime === 'wasm' ? 'and install a copy of it.' : 'read its source and install a copy of it.',
          ...reach,
          '',
          'There is no unpublish. You can recall it, which',
          'hides it — but a copy somebody installed is theirs.',
        ]
      : [
          `Publish ${p.name} as v${next}.`,
          '',
          `This REPLACES v${p.release}. Nobody can install the`,
          'old version afterwards, including you.',
          ...reach,
          '',
          'Copies already installed are unaffected.',
        ]
  }

  if (verb === 'delete') {
    return [
      `Delete ${p.name} from the registry.`,
      '',
      `The record goes, ${p.release > 1 ? `v1 to v${p.release}` : 'its one release'} with it.`,
      'Nobody can install it or read it again, including you.',
      '',
      'This is what frees the slot it holds against your',
      'program limit. Your file in ~/bin stays where it is,',
      'and copies other members installed are theirs.',
      '',
      'It cannot be undone.',
    ]
  }
  if (verb === 'recall') {
    return [
      `Recall ${p.name} v${p.release}.`,
      '',
      'It leaves browse and nobody new can install it.',
      'Anyone who already did keeps their copy.',
      '',
      'You can restore it or publish again later.',
    ]
  }
  return [
    `Restore ${p.name} v${p.release}.`,
    '',
    'It goes back into browse at the version it was',
    'recalled at, and can be installed again.',
  ]
}

/**
 * Open one box on a clean alt screen and take it down again.
 *
 * A Surface starts blank and the pty has no readback, so a box cannot be drawn
 * over the existing scrollback. It takes the alt screen while open, and the
 * outcome is printed to the scrollback after it closes.
 */
async function box<T>(
  p: Proc,
  fallback: T,
  push: (s: Surface, stack: ScreenStack, done: (v: T) => void) => Screen,
): Promise<T> {
  const tty = p.tty!
  const s = new Surface(tty.cols, tty.rows)
  const stack = new ScreenStack(s as never)

  let value = fallback
  let settled = false
  // SelectPopup resolves on a timer, after flashing the selected row, by which
  // point this loop has parked in a read. Without the interrupt it would hold
  // the box open and swallow the next key.
  const done = (v: T): void => { value = v; settled = true; p.stdin.interrupt?.() }

  tty.setRaw()
  tty.silence(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
  p.out('\x1b[?1049h')
  s.invalidate()
  try {
    stack.push(push(s, stack, done))
    tty.paint(s.render())
    while (!settled) {
      const chunk = await p.stdin.read()
      if (chunk === null) break
      for (const k of parseKeys(dec.decode(chunk))) {
        stack.key(k)
        tty.paint(s.render())
        if (settled) break
      }
    }
  } finally {
    p.out('\x1b[?1049l\x1b[?25h')
    tty.setCooked()
  }
  return value
}

/** Pick one of the member's own programs. Resolves null if they cancel. */
function chooseProgram(
  p: Proc, snd: ChatSound, programs: StoredProgram[],
): Promise<StoredProgram | null> {
  const width = programs.reduce((n, x) => Math.max(n, x.path.length), 0)
  return box<StoredProgram | null>(p, null, (s, stack, done) => new SelectPopup({
    title: 'PUBLISH',
    items: programs.map(x => row(x, width)),
    hint: '↵ Choose   ESC Cancel',
    shadow: true,
    onRepaint: () => { stack.top?.draw?.(s); p.tty!.paint(s.render()) },
    onFeedback: kind => {
      if (kind === 'move') snd.blip(520, 0.03, 0)
      else if (kind === 'edge' || kind === 'inert') snd.beep(220, 0.04)
      else if (kind === 'choose') snd.blip(660, 0.06, 0)
      else if (kind === 'cancel') snd.blip(420, 0.09, 0)
    },
    onDone: (_item, index) => done(index >= 0 ? programs[index] ?? null : null),
  }))
}

/** Pick a verb when more than one is available. */
function chooseVerb(
  p: Proc, snd: ChatSound, target: StoredProgram, options: Verb[],
): Promise<Verb | null> {
  const label: Record<Verb, string> = {
    publish: `Publish v${target.release + 1}`,
    recall: 'Recall it',
    restore: `Restore v${target.release}`,
    delete: 'Delete the record',
  }
  return box<Verb | null>(p, null, (s, stack, done) => new SelectPopup({
    title: target.name.toUpperCase(),
    items: options.map(v => label[v]),
    hint: '↵ Choose   ESC Cancel',
    shadow: true,
    onRepaint: () => { stack.top?.draw?.(s); p.tty!.paint(s.render()) },
    onFeedback: kind => {
      if (kind === 'move') snd.blip(520, 0.03, 0)
      else if (kind === 'edge' || kind === 'inert') snd.beep(220, 0.04)
      else if (kind === 'choose') snd.blip(660, 0.06, 0)
      else if (kind === 'cancel') snd.blip(420, 0.09, 0)
    },
    onDone: (_item, index) => done(index >= 0 ? options[index] ?? null : null),
  }))
}

/**
 * Ask for the one line browse shows.
 *
 * Only a wasm program reaches this: every other kind states its description in
 * its own source, which is where publish reads it, and a binary has nowhere to
 * put one.
 */
function askDescription(p: Proc, snd: ChatSound, name: string): Promise<string | null> {
  return box<string | null>(p, null, (_s, _stack, done) => new PromptPopup({
    title: name.toUpperCase(),
    hint: '↵ Publish   ESC Cancel',
    width: 52,
    rows: 0,
    maxLength: DESCRIPTION_MAX,
    shadow: true,
    onFeedback: kind => {
      if (kind === 'edge' || kind === 'inert') snd.beep(220, 0.04)
      else if (kind === 'choose') snd.blip(660, 0.06, 0)
      else if (kind === 'cancel') snd.blip(420, 0.09, 0)
    },
    onDone: value => done(value?.trim() || null),
  }))
}

function ask(p: Proc, snd: ChatSound, title: string, lines: string[]): Promise<boolean> {
  return box<boolean>(p, false, (_s, _stack, done) => new ConfirmPopup({
    title,
    lines,
    hint: YES_NO,
    shadow: true,
    onFeedback: kind => {
      if (kind === 'inert') snd.beep(220, 0.04)
      else snd.blip(420, 0.09, 0)
    },
    onDone: yes => done(yes),
  }))
}

async function act(
  p: Proc, snd: ChatSound, store: ProgramStore, target: StoredProgram, verb: Verb, note: string,
): Promise<void> {
  if (verb === 'recall') {
    await store.recall(target.id)
    p.out(`${target.name} recalled — v${target.release} is no longer listed\n`)
    return
  }
  if (verb === 'restore') {
    await store.restore(target)
    p.out(`${target.name} v${target.release} is listed again\n`)
    return
  }
  if (verb === 'delete') {
    await store.purge(target.id)
    p.out(`${target.name} deleted — ~/${target.path} is still yours\n`)
    return
  }

  p.out(D('publishing…') + '\n')
  const outcome = await store.publish(target, note || undefined)
  if (outcome === 'unchanged') {
    // Not an error: an accidental second publish is a no-op and reports as one.
    p.out(D(`${target.name} v${target.release} is current — nothing changed`) + '\n')
    return
  }
  if (outcome === 'restored') {
    p.out(`${target.name} v${target.release} is listed again\n`)
    return
  }
  snd.blip(660, 0.06, 0)
  p.out(B(`${target.name} v${target.release + 1} published`) + '\n')
  p.out(D('find it with `browse`') + '\n')
}

export function publishProgram(api: ApiClient, snd: ChatSound = SILENT): Program {
  return async p => {
    if (!api.authed) {
      p.err('publish: not logged in\n')
      return 1
    }
    if (!p.tty) {
      p.err('publish: no terminal\n')
      return 1
    }

    const store = new ProgramStore(api, p)

    // Everything returned is publishable. Recalled programs stay in the list,
    // since publish is how they are restored. The examples are excluded: that
    // directory is read-only and rebuilt from source on every boot.
    let programs: StoredProgram[]
    try {
      programs = await store.list()
    } catch (e) {
      p.err(`publish: ${(e as Error)?.message ?? e}\n`)
      return 1
    }

    if (!programs.length) {
      p.out(D('nothing to publish — write one with `edit ~/bin/mine`') + '\n')
      return 0
    }

    // Everything after the name is the release note, so it needs no quoting:
    // `publish starfield fixed the wrap bug`.
    const raw = p.argv[1]
    const target = raw?.replace(/^.*\//, '')
    const note = p.argv.slice(target ? 2 : 1).join(' ').trim().slice(0, 200)

    let program: StoredProgram | null
    if (target) {
      // Matched by path when the reader gave one, by basename otherwise.
      const where = raw?.includes('/') ? paths.resolve(p.cwd, raw) : null
      const home = p.env.HOME ?? '/home/guest'
      program = (where ? programs.find(x => paths.join(home, x.path) === where) : null)
        ?? programs.find(x => x.name === target)
        ?? null
      if (!program) {
        snd.beep(220, 0.12)
        // Reported as read-only rather than "no such program", which would be
        // wrong about a file visible in `ls /bin/examples`.
        if (EXAMPLES.includes(target)) {
          p.out(`publish: ${target} is one of the examples\n`)
          p.out(D(`open it with \`edit /bin/examples/${target}\``) + '\n')
          p.out(D(`save it to ~/bin/${target} and it is yours to publish`) + '\n')
          return 1
        }
        p.out(`publish: ${target}: no such program in ~/bin\n`)
        return 1
      }
    } else {
      program = await chooseProgram(p, snd, programs)
      if (!program) {
        p.out(D('nothing published') + '\n')
        return 0
      }
    }

    const options = verbs(program)
    if (!options.length) {
      snd.beep(220, 0.12)
      p.out(`${program.name} was taken down by a moderator\n`)
      p.out(D('it cannot be published, restored or removed until reinstated') + '\n')
      return 1
    }

    let verb = options[0]!
    if (options.length > 1) {
      const picked = await chooseVerb(p, snd, program, options)
      if (!picked) {
        p.out(D('nothing published') + '\n')
        return 0
      }
      verb = picked
    }

    // A binary has nowhere to carry a description, so it is asked for instead
    // of refused. Everything else states it in its own source.
    if (verb === 'publish' && program.runtime === 'wasm' && !program.description.trim()) {
      const line = await askDescription(p, snd, program.name)
      if (!line) {
        p.out(D('nothing published') + '\n')
        return 0
      }
      program = { ...program, description: line }
    }

    // Refused before the consequences box rather than after, so a member cannot
    // read the warning and confirm only to be told the action was unavailable.
    // Only publish requires a note; recall and restore act on a program that
    // already has one.
    if (verb === 'publish' && !program.description.trim()) {
      snd.beep(220, 0.12)
      p.out(`${program.name} has no description\n`)
      p.out(D('every program in browse is found by its one line — write one') + '\n')
      p.out(D(`  edit ~/${program.path}`) + '\n')
      // Where the line goes depends on the kind: a grid program has an object
      // literal to put it in and a program for this machine exports a function.
      p.out(D(program.runtime === 'term'
        ? "  export const description = 'what it does'"
        : "  description: 'what it does',") + '\n')
      return 1
    }

    const title = verb.toUpperCase()
    if (!await ask(p, snd, title, consequences(program, verb, api.username ?? ''))) {
      p.out(D('nothing published') + '\n')
      return 0
    }

    try {
      await act(p, snd, store, program, verb, note)
    } catch (err) {
      snd.beep(220, 0.12)
      p.out(`publish: ${(err as Error).message}\n`)
      return 1
    }
    return 0
  }
}
