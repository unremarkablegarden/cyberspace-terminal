// sudo and make: the xkcd 149 pair.
//
// sudo runs nothing. It prompts for a password, accepts any, then answers
// `make me a sandwich` with `Okay.` and every other command with the sudoers
// refusal. There is no privilege on this machine for it to grant.

import { readLine, type Proc, type Program } from '@cyberspace/kernel'

const LECTURE = `We trust you have received the usual lecture from the local System
Administrator. It boils down to these three things:

    #1) Respect the privacy of others.
    #2) Think before you type.
    #3) With great power comes great responsibility.

`

/** How long a password is remembered, in ms. Real sudo uses 15 minutes. */
const TIMESTAMP_TTL = 5 * 60 * 1000

// Module state, reset by a reload.
let lectured = false
let authedAt = 0

/** Resolves after `ms`, or at once when the process is killed. */
function pause(p: Proc, ms: number): Promise<void> {
  return new Promise(res => {
    const t = setTimeout(res, ms)
    p.signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
  })
}

/** A remark on some passwords. Null for an ordinary one. */
function winkAt(password: string, username: string): string | null {
  if (!password) return '(nothing at all. accepted.)'
  if (password === 'hunter2') return '(from here it just looks like *******.)'
  if (password.toLowerCase() === username.toLowerCase()) return '(your password is your username. we should talk.)'
  if (password === 'password' || password === '123456' || password === 'letmein') return '(top ten. accepted anyway.)'
  if (password.length >= 24) return '(admirably long. also unnecessary.)'
  return null
}

export const sudo: Program = async p => {
  const [verb, ...rest] = p.argv.slice(1)
  if (!verb) { p.err('usage: sudo command [args]\n'); return 1 }
  const user = p.env.USER ?? 'guest'

  if (Date.now() - authedAt > TIMESTAMP_TTL) {
    if (!p.tty) { p.err('sudo: no tty present and no askpass program specified\n'); return 1 }
    if (!lectured) {
      lectured = true
      p.out(LECTURE)
    }
    const password = await readLine(p, `[sudo] password for ${user}: `, '')
    if (password === null) { p.err('sudo: a password is required\n'); return 1 }
    await pause(p, 420)
    if (p.signal.aborted) return 130
    authedAt = Date.now()
    const wink = winkAt(password, user)
    if (wink) p.out(wink + '\n\n')
  }

  if ([verb, ...rest].join(' ') === 'make me a sandwich') {
    await pause(p, 300)
    p.out('Okay.\n')
    return 0
  }
  p.err(`${user} is not in the sudoers file.  This incident will be reported.\n`)
  return 1
}

export const make: Program = async p => {
  const target = p.argv.slice(1).join(' ')
  if (target === 'me a sandwich') { p.out('What? Make it yourself.\n'); return 2 }
  p.err(`make: *** No rule to make target '${target || 'all'}'.  Stop.\n`)
  return 2
}
