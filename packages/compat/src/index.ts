export { runGridProgram, jsFileHandler } from './host.js'
export type { CompatDeps } from './host.js'
// The guard is deliberately not re-exported: it carries a JS parser, and a
// static export would add ~130 KB to every bundle importing this package.
// Import '@cyberspace/compat/guard' directly where needed. See host.ts.
