// Static check applied to a program before it runs.
//
// A user program is imported as a real ES module into this page (see host.ts),
// so it runs with the reader's session behind it. The credential must not be
// reachable from there: the refresh token is in localStorage, and anyone
// holding it can act as the reader afterwards, on any device.
//
// This refuses the names that reach the credential and nothing else. fetch and
// the canvas and codec APIs the games use are all allowed, because a network
// call is only useful once the caller holds something worth sending, so
// blocking the read is what closes the channel. Blocking the capabilities
// instead would break every program on the machine.
//
// This is a filter, not a sandbox: `x['con' + 'structor']` defeats it. It stops
// copied snippets and direct token grabs, not a determined author.

import { parse } from 'acorn'
import * as walk from 'acorn-walk'
import findGlobals from 'acorn-globals'
import type { Node } from 'acorn'

/** One reason a program was refused, at the place that caused it. */
export interface GuardHit {
  /** The identifier, property or construct that did it. */
  name: string
  line: number
  col: number
  /** Shown to the author, so it states what to change. */
  why: string
}

/**
 * Globals a program may not name.
 *
 * Counted only when the identifier is free: `const self = players.find(...)`
 * declares a local and is allowed. That distinction is why this file parses
 * rather than matching text, since self, top and frames are ordinary variable
 * names in programs already running here.
 */
const BLOCKED_GLOBALS: Record<string, string> = {
  // The credential store and its neighbours. The refresh token is in
  // localStorage here; the original machine kept its own in IndexedDB and could
  // therefore allow localStorage.
  localStorage: 'the store the session token is kept in',
  sessionStorage: 'a store the session token could be copied into',
  indexedDB: 'the browser database a session token is kept in',
  caches: 'a store the page keeps responses in',
  cookieStore: 'the cookie jar',

  // Each of these is one property access from the stores above.
  window: 'the page itself — the session token is reachable from it',
  globalThis: 'the page itself — the session token is reachable from it',
  self: 'the page itself — the session token is reachable from it',
  top: 'the page itself — the session token is reachable from it',
  parent: 'the page itself — the session token is reachable from it',
  frames: 'the page itself — the session token is reachable from it',
  opener: 'the page itself — the session token is reachable from it',

  // document.defaultView is window, as is node.ownerDocument.defaultView from
  // any node, so the document cannot be allowed while closing that path. The
  // offscreen canvas is exposed on ctx instead.
  document: 'the page document — the session token is reachable from it',

  // A second realm would run code this check never saw.
  eval: 'runs code this check never read',
  Function: 'builds code this check never read',
  Worker: 'starts code this check never read',
  SharedWorker: 'starts code this check never read',
  importScripts: 'loads code this check never read'
}

/**
 * Properties a program may not access.
 *
 * Required for the list above to hold: Function is banned by name but returned
 * again by `''.constructor.constructor('return fetch')()`. A drawing program
 * has almost no legitimate use for .constructor.
 */
const BLOCKED_PROPS: Record<string, string> = {
  constructor: 'reaches the Function constructor, which runs code this check never read',
  // Written as a computed key, not `__proto__:`. In an object literal the plain
  // form sets the prototype rather than adding a property, which would leave
  // this table with one entry and let x.__proto__ through. Brackets make it an
  // ordinary key.
  ['__proto__']: 'reaches the Function constructor, which runs code this check never read'
}

/** Every name that may not appear as a computed key. See rule C below. */
const BLOCKED_AS_KEY = new Set([...Object.keys(BLOCKED_GLOBALS), ...Object.keys(BLOCKED_PROPS)])

/**
 * Look a name up in the tables above without inheriting from Object.prototype.
 *
 * A plain BLOCKED_PROPS[name] also matches toString, valueOf and hasOwnProperty,
 * so Math.random().toString(36) would read as a blocked property and refuse the
 * program. Verified against payback.js:1291, which does exactly that.
 */
function reason(table: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/** A string literal's value, or null if the node is not one. */
function literalString(node: any): string | null {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  // x[`constructor`] parses as a template with one chunk and no substitutions.
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0]?.value?.cooked ?? null
  }
  return null
}

function at(node: any, name: string, why: string): GuardHit {
  return { name, line: node?.loc?.start?.line ?? 0, col: node?.loc?.start?.column ?? 0, why }
}

/**
 * Check a program and report what it violates.
 *
 * An empty array means nothing was found. It does not mean the program is safe,
 * and no caller should report it as such.
 *
 * Throws the parser's SyntaxError when the source will not parse. Callers must
 * not route around this: source the guard cannot read but the engine can would
 * be a bypass, so a program that does not parse does not run. Acorn's error
 * matches the author's actual syntax error closely enough for exec.ts to print
 * it directly.
 */
export function inspect(source: string): GuardHit[] {
  // Parsed as the browser will import it: a module, current syntax. Not using
  // acorn-globals' defaults, which permit return and import where a real module
  // would reject them.
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    allowAwaitOutsideFunction: true
  })

  const hits: GuardHit[] = []

  // Rule A: free identifiers. The AST is passed rather than the source so this
  // is a single parse; acorn-globals accepts either.
  for (const found of findGlobals(ast)) {
    const why = reason(BLOCKED_GLOBALS, found.name)
    if (!why) continue
    for (const node of found.nodes) hits.push(at(node, found.name, why))
  }

  walk.full(ast as Node, (node: any) => {
    // Rule B: the property, written directly.
    if (node.type === 'MemberExpression' && !node.computed && node.property?.type === 'Identifier') {
      const why = reason(BLOCKED_PROPS, node.property.name)
      if (why) hits.push(at(node.property, node.property.name, why))
    }

    // Rule C: the same property written as a key. Restricted to the computed-key
    // position, so a bare string is not a match: `bootPhase = 'fetch'` is a state
    // value rather than an access.
    if (node.type === 'MemberExpression' && node.computed) {
      const key = literalString(node.property)
      if (key && BLOCKED_AS_KEY.has(key)) {
        const why = reason(BLOCKED_PROPS, key) ?? reason(BLOCKED_GLOBALS, key) ?? 'not reachable from a program'
        hits.push(at(node.property, key, why))
      }
    }

    // Rule D: no loading further code. A blob module can import another blob it
    // has just built, and the CSP allows blob: in script-src, so without this the
    // rules above can be bypassed.
    if (node.type === 'ImportExpression') {
      hits.push(at(node, 'import()', 'loads code this check never read'))
    }
    if (node.type === 'ImportDeclaration') {
      hits.push(at(node, 'import', 'a program is one file — there is nothing to import from'))
    }
    if (node.type === 'MetaProperty' && node.meta?.name === 'import') {
      hits.push(at(node, 'import.meta', 'describes the module this check never read'))
    }
    if (node.type === 'WithStatement') {
      hits.push(at(node, 'with', 'hides which name is being read'))
    }
  })

  // Sorted into source order and deduplicated, since one name can match two
  // rules at the same position.
  const seen = new Set<string>()
  return hits
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter((h) => {
      const key = `${h.line}:${h.col}:${h.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/**
 * Format the refusal as lines to print.
 *
 * Lists three violations and then a count, which is enough to point the author
 * at the pattern to change.
 *
 * Takes `dim` as a parameter rather than an attribute constant, so this file
 * does not import the beam levels.
 */
export function refusalLines(name: string, hits: GuardHit[]): Array<{ text: string, dim: boolean }> {
  const lines = [{ text: `${name}: refused — reaches outside the terminal`, dim: false }]
  for (const h of hits.slice(0, 3)) {
    lines.push({ text: `  ${h.line}:${h.col}  ${h.name} — ${h.why}`, dim: false })
  }
  if (hits.length > 3) {
    lines.push({ text: `  ...and ${hits.length - 3} more`, dim: true })
  }
  return lines
}
