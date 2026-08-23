// The network programs. Each closes over the ApiClient; none touches Firebase
// or the DOM. Accounts are created on the website; the machine only signs in.
//
// Output follows the POSIX conventions: login(1) prompts, "Login incorrect",
// finger(1) layout with the bio as Plan, and silence on success.

import { dec, fs, type Proc, type Program, readText } from '@cyberspace/kernel'
import { wrap } from '@cyberspace/tui'
import { ApiClient, ApiError } from './api.js'

export interface CsHooks {
  /** Called when auth state changes. Awaited before login continues. */
  onAuth(username: string | null): void | Promise<void>
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
  const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e)
  p.err(`${name}: ${msg}\n`)
  return 1
}

const when = (v: unknown): string => {
  const d = typeof v === 'number' || typeof v === 'string' ? new Date(v) : null
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

export function cyberspacePrograms(api: ApiClient, hooks?: CsHooks): Record<string, Program> {
  const login: Program = async p => {
    if (api.username) {
      p.err(`login: already logged in as ${api.username}\n`)
      return 1
    }
    const email = p.argv[1] ?? await readLine(p, 'login: ')
    if (!email) return 1
    const password = await readLine(p, 'Password: ', '*')
    if (password === null) return 1
    let username: string
    try {
      username = await api.login(email, password)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        p.err('Login incorrect\n')
        return 1
      }
      return fail(p, 'login', e)
    }
    await hooks?.onAuth(username)

    // As login(1): print the motd, then run a shell as the user. Exiting that
    // shell returns to the one that ran login.
    const motd = await readText('/etc/motd').catch(() => '')
    if (motd) p.out(String(motd))
    const sh = p.kernel.resolveProgram('sh')
    if (sh && p.tty) {
      const task = p.kernel.spawn(sh, {
        argv: ['sh'],
        env: { ...p.env, USER: username },
        cwd: p.env.HOME ?? p.cwd,
        stdin: p.stdin,
        stdout: p.stdout,
        stderr: p.stderr,
        tty: p.tty,
      })
      await task.wait
    }
    return 0
  }

  const logout: Program = p => {
    if (!api.username && !api.hasSavedSession) {
      p.err('logout: not logged in\n')
      return 1
    }
    api.logout()
    void hooks?.onAuth(null)
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

  const feed: Program = async p => {
    if (!api.authed) {
      p.err('feed: not logged in\n')
      return 1
    }
    const n = Math.min(50, Math.max(1, Number(p.argv[1]) || 10))
    try {
      const posts = await api.get<Record<string, unknown>[]>(`/v1/posts?limit=${n}`)
      for (const post of posts) {
        const author = String(post.authorUsername ?? '?')
        const title = typeof post.title === 'string' && post.title.trim()
          ? post.title.trim()
          : String(post.content ?? '').split('\n')[0].slice(0, 48)
        p.out(`\x1b[2m${when(post.createdAt)}\x1b[0m  \x1b[1m${author.padEnd(16)}\x1b[0m ${title}\n`)
      }
      return 0
    } catch (e) {
      return fail(p, 'feed', e)
    }
  }

  return { login, logout, whoami, finger, feed }
}
