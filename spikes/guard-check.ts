// Guard lint checks. The boundary is the worker realm (see spawn.ts); this
// verifies the lint still turns the obvious credential grabs into a refusal.
// Run: bun spikes/guard-check.ts
import { inspect } from '../packages/compat/src/guard.ts'

let fail = 0
const wrap = (body: string): string => `export default { async run(ctx, args) {\n${body}\n} }`
const check = (label: string, body: string, want: 'refuse' | 'pass', name?: string): void => {
  const hits = inspect(wrap(body))
  const refused = hits.length > 0
  const ok = want === 'refuse' ? refused && (!name || hits.some(h => h.name === name)) : !refused
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label} -> ${refused ? 'REFUSED ' + JSON.stringify(hits.map(h => h.name)) : 'PASSED'}`)
}

// The reported exploit: Function via concatenated .constructor, then eval.
check('concat .constructor (exploit)', 'var e = [].sort["con"+"structor"]("return ev"+"al")();', 'refuse', 'constructor')
check('three-part concat', 'var e = [].sort["con"+"stru"+"ctor"]("return eval")();', 'refuse', 'constructor')
check('direct .constructor', 'var e = [].sort.constructor("return eval")();', 'refuse', 'constructor')
check('template key', 'var e = [].sort[`constructor`]("return eval")();', 'refuse', 'constructor')
check('free window', 'console.log(window.cs.api.idToken);', 'refuse', 'window')
check('free localStorage', 'return localStorage.getItem("csterm.auth");', 'refuse', 'localStorage')
check('free indexedDB', 'await indexedDB.databases();', 'refuse', 'indexedDB')

// Allowed: ordinary programs must not trip the lint.
check('local named self', 'const self = args[0]; ctx.write(self);', 'pass')
check('Math.random().toString(36)', 'ctx.write(Math.random().toString(36));', 'pass')
check('ctx.api use', 'const me = await ctx.api.get("/v1/users/me"); ctx.write(String(me));', 'pass')

console.log(fail ? `\n${fail} FAILED` : '\nall ok')
if (fail) process.exit(1)
