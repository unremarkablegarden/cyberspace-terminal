// acorn-globals ships no types of its own.
//
// Only the default export is used, and only by guard.ts. The
// second argument (parse options) is deliberately left off: the guard hands it
// an already-parsed AST so there is nothing left to configure, and declaring it
// would invite someone to pass options that are then silently ignored.
//
// `import(...)` types rather than a top-level import, so this file stays
// ambient — a `.d.ts` with real imports becomes a module, and `declare module`
// inside one is an augmentation of something that must already exist.

declare module 'acorn-globals' {
  /** One free identifier, and every place it is read. */
  interface GlobalRef {
    name: string
    nodes: import('acorn').Node[]
  }

  export default function findGlobals(source: string | import('acorn').Node): GlobalRef[]
}
