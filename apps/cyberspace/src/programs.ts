// The network programs. Each closes over the ApiClient; none touches Firebase
// or the DOM. Accounts are created on the website; the machine only signs in.
//
// Output follows the POSIX conventions: login(1) prompts, "Login incorrect",
// finger(1) layout with the bio as Plan. A successful login dials in (modem.ts).

import { dec, fs, paths, type Proc, type Program } from '@cyberspace/kernel'
import { FormPopup, NORMAL, wrap } from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'
import { SILENT, type ChatSound } from './chat.js'
import { box } from './modal.js'
import { dial, hangup } from './modem.js'
import { PAGES_QUOTA, PAGES_TYPES, isPagesButton, normalisePagesPath } from './pages.js'
import type { HomeKey } from './homekey.js'
import { rewrapHome, unlockHome } from './homesync.js'

export interface CsHooks {
  /**
   * Called when auth state changes. Awaited before login continues; a string
   * comes back as a line printed by login(1).
   */
  onAuth?(username: string | null): void | string | Promise<void | string>
  /**
   * Open the host's file chooser, null when dismissed. Needs a user gesture:
   * the caller must reach it before any other await after the keypress.
   */
  pickFile?(accept: string): Promise<File | null>
  /** Awaited by logout(1) before the token goes: the host's last home sync. */
  onLeave?(): Promise<void>
  /** The home's master key; login(1) unlocks it, logout(1) clears it. */
  homeKey?: HomeKey
}

const ACCEPT = Object.keys(PAGES_TYPES).map(e => `.${e}`).join(',')

/** What import(1) offers: the two things that can be a program in ~/bin. */
const PROGRAM_ACCEPT = '.js,.wasm'

/** The registry's own rule, so a name that imports can also be published. */
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/**
 * Bytes import(1) accepts, mirroring the registry's tier caps. The server is the
 * authority and checks again at publish; refusing here saves writing a file that
 * can never leave the machine.
 */
const PROGRAM_MAX = { default: 128 * 1024, supporter: 1024 * 1024 }

/** `~` and relative forms resolved against the process. */
function resolvePath(p: Proc, arg: string): string {
  const home = p.env.HOME ?? '/'
  const expanded = arg === '~' ? home : arg.startsWith('~/') ? home + arg.slice(1) : arg
  return paths.resolve(p.cwd, expanded)
}

/** Site-relative path under ~/public_html, or null when outside it. */
function siteRelative(p: Proc, abs: string): string | null {
  const root = `${p.env.HOME ?? '/'}/public_html`
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null
}

/** Read one line in raw mode. An empty mask hides input entirely. Null on ^C. */
async function readLine(p: Proc, prompt: string, mask?: string): Promise<string | null> {
  const tty = p.tty
  if (!tty) return null
  p.out(prompt)
  tty.setRaw()
  let line = ''
  try {
    for (;;) {
      const chunk = await p.stdin.read()
      if (chunk === null) return line
      for (const ch of dec.decode(chunk)) {
        if (ch === '\x03') {
          tty.echo('\n')
          return null
        }
        if (ch === '\r' || ch === '\n') {
          tty.echo('\n')
          return line
        }
        if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1)
            if (mask !== '') tty.echo('\b \b')
          }
          continue
        }
        if (ch >= ' ') {
          line += ch
          // Keystroke echo rather than program output: not rate-limited, no bleep.
          tty.echo(mask ?? ch)
        }
      }
    }
  } finally {
    tty.setCooked()
  }
}

function fail(p: Proc, name: string, e: unknown): number {
  // A filesystem error may carry its own reason (see pagesfs.ts refuse()).
  const { reason, message } = e as { reason?: string; message?: string }
  p.err(`${name}: ${reason ?? message ?? String(e)}\n`)
  return 1
}

const when = (v: unknown): string => {
  const d = typeof v === 'number' || typeof v === 'string' ? new Date(v) : null
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

export function cyberspacePrograms(api: ApiClient, hooks?: CsHooks, snd: ChatSound = SILENT): Record<string, Program> {
  const login: Program = async p => {
    if (api.username) {
      p.err(`login: already logged in as ${api.username}\n`)
      return 1
    }
    let username: string | null
    // Set when the password no longer opens the home's key: the previous one is asked for below.
    let previous = false
    let typed = ''
    const unlock = async (password: string) => {
      if (!api.supporter || !hooks?.homeKey) return
      typed = password
      // A home that cannot be unlocked now is not a failed login; sync(1) says so.
      previous = await unlockHome(api, hooks.homeKey, password).then(r => r === 'previous', () => false)
    }
    if (p.tty) {
      username = await box<string | null>(p, null, (s, stack, done) => {
        const tty = p.tty!
        const repaint = () => { stack.top?.draw?.(s); tty.paint(s.render()) }
        // The modem log types under the box, one character per tick. Paints
        // rather than program output, so it neither queues nor bleeps; the
        // blip is played here instead.
        let row = 0
        let r: { x: number; y: number; h: number } | undefined
        const line = async (text: string) => {
          // Anchored on the first line: the box moves as its status comes and goes.
          r ??= form.rect(s)
          const y = r.y + r.h + 1 + row++
          if (y >= s.rows) return
          for (let i = 0; i < text.length; i++) {
            s.text(r.x + i, y, text[i], NORMAL)
            snd.blip()
            tty.paint(s.render())
            await new Promise(res => setTimeout(res, 1000 / 240))
          }
        }
        const form: FormPopup = new FormPopup({
          title: 'LOGIN',
          fields: [{ label: 'Login:', value: p.argv[1] }, { label: 'Password:', mask: '*' }],
          shadow: true,
          pending: 'Authenticating...',
          // The upper half, so the log fits beneath.
          bounds: { x: 0, y: 0, w: tty.cols, h: Math.floor(tty.rows / 2) },
          onSubmit: ([email, password]) => api.login(email.trim(), password).then(
            () => { form.notice('Access granted'); return unlock(password).then(() => dial(line, snd)).then(() => null) },
            e => ({
              message: e instanceof ApiError && e.status === 401
                ? 'Login incorrect'
                : (e as { reason?: string; message?: string }).reason ?? (e as Error).message ?? String(e),
              clear: [1],
            })),
          onDone: v => done(v && v[0].trim()),
          onRepaint: repaint,
          onFeedback: kind => {
            if (kind === 'move' || kind === 'submit') snd.tick()
            else if (kind === 'edge' || kind === 'fail') snd.beep(220)
            else if (kind === 'cancel') snd.blip(420)
          },
        })
        return form
      })
      // The box reports its own failures; the shell only sees the exit code.
      if (username === null) return 1
      username = api.username ?? username
    } else {
      // No terminal (a script): the line-mode prompts.
      const email = p.argv[1] ?? await readLine(p, 'login: ')
      if (!email) return 1
      const password = await readLine(p, 'Password: ', '*')
      if (password === null) return 1
      try {
        username = await api.login(email, password)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          p.err('Login incorrect\n')
          return 1
        }
        return fail(p, 'login', e)
      }
      await unlock(password)
    }
    if (previous && hooks?.homeKey) {
      // The password changed since this key was wrapped. Empty skips; the
      // home stays local until a device that holds the key logs in.
      const old = await readLine(p, 'Previous password: ', '*')
      if (old) {
        const ok = await rewrapHome(api, hooks.homeKey, old, typed).catch(() => false)
        if (!ok) p.err('Previous password incorrect\n')
      }
    }
    // The host renames the running shell's user (main.ts onAuthChange), so the
    // prompt follows without a nested shell.
    const note = await hooks?.onAuth?.(username)
    if (note) p.out(note + '\n')
    return 0
  }

  const logout: Program = async p => {
    if (!api.username && !api.hasSavedSession) {
      p.err('logout: not logged in\n')
      return 1
    }
    // The last sync needs the token; the key goes with the session.
    await hooks?.onLeave?.().catch(() => {})
    hooks?.homeKey?.clear()
    api.logout()
    void hooks?.onAuth?.(null)
    if (p.tty) await hangup(p, snd)
    return 0
  }

  const whoami: Program = p => {
    p.out((api.username ?? p.env.USER ?? 'guest') + '\n')
    return 0
  }

  const finger: Program = async p => {
    const target = p.argv[1]
    if (!target && !api.username) {
      p.err('usage: finger [user]\n')
      return 1
    }
    try {
      const u = await api.get<Record<string, unknown>>(
        target ? `/v1/users/${encodeURIComponent(target)}` : '/v1/users/me')
      const name = String(u.username ?? target ?? '?')
      const joined = when(u.createdAt)
      p.out(`Login: ${name.padEnd(24)}${joined ? `Joined: ${joined}` : ''}\n`)
      if (u.guildName) p.out(`Guild: ${u.guildName}\n`)
      if (u.isSupporter) p.out('Supporter.\n')
      const bio = typeof u.bio === 'string' ? u.bio.trim() : ''
      if (bio) {
        p.out('Plan:\n')
        for (const line of wrap(bio, 64)) p.out(line + '\n')
      } else {
        p.out('No Plan.\n')
      }
      return 0
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        p.err(`finger: ${target}: no such user\n`)
        return 1
      }
      if (e instanceof ApiError && e.status === 401) {
        p.err('finger: not logged in\n')
        return 1
      }
      return fail(p, 'finger', e)
    }
  }

  const gate = (p: Proc, name: string): boolean => {
    if (!api.authed) { p.err(`${name}: not logged in\n`); return false }
    if (!api.supporter) { p.err(`${name}: public_html is for supporters\n`); return false }
    return true
  }

  // upload <path> — a file off this computer into ~/public_html. The chooser
  // is the first await: transient activation from the Enter key is what lets
  // it open, and it is gone after any other await.
  const upload: Program = async p => {
    if (!gate(p, 'upload')) return 1
    const arg = p.argv[1]
    if (!arg) { p.err('usage: upload ~/public_html/file\n'); return 1 }
    if (!hooks?.pickFile) { p.err('upload: no file chooser\n'); return 1 }
    const file = await hooks.pickFile(ACCEPT)
    if (!file) return 0

    let dest = resolvePath(p, arg)
    const st = await fs.promises.stat(dest).catch(() => null)
    if (st?.isDirectory()) dest = paths.join(dest, file.name.toLowerCase())
    const rel = siteRelative(p, dest)
    if (rel === null) { p.err('upload: only ~/public_html takes uploads\n'); return 1 }
    if (!normalisePagesPath(rel)) { p.err(`upload: ${rel}: bad path\n`); return 1 }
    if (file.size > PAGES_QUOTA.maxBytesPerFile) {
      p.err(`upload: too big — ${Math.ceil(file.size / 1024)}KB of ${PAGES_QUOTA.maxBytesPerFile / 1024}KB\n`)
      return 1
    }
    try {
      await fs.promises.mkdir(paths.dirname(dest), { recursive: true })
      await fs.promises.writeFile(dest, new Uint8Array(await file.arrayBuffer()))
    } catch (e) {
      return fail(p, 'upload', e)
    }
    return 0
  }

  // import [name] — a program off this computer into ~/bin. The chooser is the
  // first await, as in upload(1): transient activation is gone after any other.
  const importProgram: Program = async p => {
    if (!hooks?.pickFile) { p.err('import: no file chooser\n'); return 1 }
    const file = await hooks.pickFile(PROGRAM_ACCEPT)
    if (!file) return 0

    const name = (p.argv[1] ?? file.name).replace(/^.*\//, '').replace(/\.(js|wasm)$/, '')
    if (!PROGRAM_NAME.test(name)) {
      p.err('import: bad name (letters, digits, . _ -, max 32)\n')
      return 1
    }
    const max = api.supporter ? PROGRAM_MAX.supporter : PROGRAM_MAX.default
    if (file.size > max) {
      p.err(`import: too big — ${Math.ceil(file.size / 1024)}KB of ${max / 1024}KB\n`)
      return 1
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const { classify, isWasm } = await import('@cyberspace/compat/classify')
    if (!isWasm(bytes) && !classify(dec.decode(bytes))) {
      p.err(`import: ${file.name}: not a program (missing export default)\n`)
      return 1
    }

    const home = p.env.HOME ?? '/'
    const dest = paths.join(home, 'bin', name)
    if (await fs.promises.stat(dest).catch(() => null)) {
      p.err(`import: ${name} exists — rm ~/bin/${name} first\n`)
      return 1
    }
    try {
      await fs.promises.mkdir(paths.join(home, 'bin')).catch(() => {})
      await fs.promises.writeFile(dest, bytes, { mode: 0o755 })
    } catch (e) {
      return fail(p, 'import', e)
    }
    p.out(`Imported ${name} — run it with ${name}.\n`)
    return 0
  }

  // pages — the homepage: URL and usage; title and button for the directory.
  const pages: Program = async p => {
    if (!gate(p, 'pages')) return 1
    const [, verb, ...rest] = p.argv
    try {
      if (!verb) {
        const site = await api.pages.site()
        const mb = PAGES_QUOTA.maxBytesTotal / (1024 * 1024)
        p.out(`${site.url}\n`)
        p.out(`${Math.ceil(site.usage.bytes / 1024)}KB / ${mb}MB · ${site.usage.files} / ${PAGES_QUOTA.maxFiles} files\n`)
        if (site.title) p.out(`title   ${site.title}\n`)
        if (site.button) p.out(`button  ${site.button}\n`)
        if (site.takenDown) p.out('taken down by a moderator\n')
        return 0
      }
      if (verb === 'title') {
        const text = rest.join(' ').trim()
        if (!text) { p.err('usage: pages title <text> | -\n'); return 1 }
        await api.pages.patchSite({ title: text === '-' ? null : text })
        return 0
      }
      if (verb === 'button') {
        const arg = rest[0]
        if (!arg) { p.err('usage: pages button <file> | -\n'); return 1 }
        if (arg === '-') { await api.pages.patchSite({ button: null }); return 0 }
        const rel = siteRelative(p, resolvePath(p, arg))
        if (rel === null) { p.err(`pages: ${arg}: not in ~/public_html\n`); return 1 }
        if (!normalisePagesPath(rel) || !isPagesButton(rel)) { p.err(`pages: ${arg}: a button is a gif or png\n`); return 1 }
        await api.pages.patchSite({ button: rel })
        return 0
      }
      p.err('usage: pages [title <text> | button <file>]\n')
      return 1
    } catch (e) {
      // The server's hint names mkdir, the website terminal's verb; here a save is the verb.
      if ((e as { status?: number }).status === 404) { p.err('pages: no site — edit ~/public_html/index.html\n'); return 1 }
      return fail(p, 'pages', e)
    }
  }

  return { login, logout, whoami, finger, upload, pages, import: importProgram }
}
