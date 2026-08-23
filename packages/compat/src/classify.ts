// What kind of program a file holds, read without running it.
//
// Publishing has to name the runtime (the registry lists by it) and must not
// execute the file to find out. Running does not need this: the module is
// imported by then, so host.ts branches on the actual default export.
//
// Parsed rather than matched. The two shapes differ by one token,
// `export default {` against `export default (`, and a formatted object literal
// with a comment above it defeats every regex written for that.

import { parse } from 'acorn'
import type { Node } from 'acorn'

/** `\0asm`, the four bytes every wasm module starts with. */
export function isWasm(data: Uint8Array): boolean {
  return data.length >= 4
    && data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d
}

/**
 * Which terminal a program is written for.
 *
 * `web`  an original /terminal program: `export default { run(ctx, args) }`
 * `term` a program for this machine: `export default async (p) => number`
 * `wasm` a wasm32-wasi binary
 */
export type Runtime = 'web' | 'term' | 'wasm'

const FUNCTIONS = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
])

/** Where a name declared at the top level was bound, or null. */
function boundTo(body: Node[], name: string): Node | null {
  for (const node of body as any[]) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id?.type === 'Identifier' && d.id.name === name && d.init) return d.init
      }
    }
  }
  return null
}

/**
 * Classify JS source by its default export. Null means it is not a program.
 *
 * A default export that is neither an object nor a function reads as `web`,
 * which is what every program written before this machine existed is. Source
 * that does not parse is classified on the text, since a file being edited is
 * broken most of the time and should not vanish from `publish` while it is.
 */
export function classify(source: string): Runtime | null {
  let program: any
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return /export\s+default/.test(source) ? 'web' : null
  }

  const decl = (program.body as any[]).find(n => n.type === 'ExportDefaultDeclaration')
  if (!decl) return null

  let node = decl.declaration
  // One hop only. `export default main` where main is another alias is rare
  // enough to read as the web terminal's kind and be corrected by the author.
  if (node?.type === 'Identifier') node = boundTo(program.body, node.name)

  if (!node) return 'web'
  if (FUNCTIONS.has(node.type)) return 'term'
  return 'web'
}
