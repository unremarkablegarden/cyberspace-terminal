// Checks source comments against docs/style/comments.md.
//
// Comments are extracted with a small scanner rather than a parser: it tracks
// string, template and regex literals well enough to tell a comment from a
// slash inside one, and no more. Findings only, never rewrites.
//
//   bun tools/comments.ts                 check the default scope
//   bun tools/comments.ts <paths...>      check specific files
//   bun tools/comments.ts --check         errors only, for the build gate
//   bun tools/comments.ts --strict        fail on warnings too
//   bun tools/comments.ts --json          machine-readable findings
//   bun tools/comments.ts --hook          read a PostToolUse payload on stdin
//
// Suppression, on the comment itself or the line above it:
//
//   // lint-comment: disable <rule>[,<rule>]
//   // lint-comment: disable-file <rule>[,<rule>]

import { readdir } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url).pathname

const SCOPE = [
  'app/src', 'apps/cyberspace/src', 'packages/kernel/src', 'packages/shell/src',
  'packages/coreutils/src', 'packages/compat/src', 'packages/tui/src',
  'packages/crt/src', 'tools',
]

type Severity = 'error' | 'warn' | 'off'

interface Rule {
  id: string
  severity: Severity
  remedy: string
  /** Paths this rule does not apply to, matched as a prefix. */
  except?: string[]
}

interface Finding {
  file: string
  line: number
  rule: string
  severity: Severity
  text: string
  remedy: string
}

/** A run of adjacent comment lines, treated as one block. */
interface Block {
  /** 1-based line of the first comment line. */
  line: number
  /** Comment text with markers stripped, one entry per source line. */
  lines: string[]
  /** True for a block at the top of the file or directly above a declaration. */
  header: boolean
  /** 1-based line of the first code line after the block, or 0 at end of file. */
  nextCode: number
  raw: string[]
}

const DEFAULTS = {
  bannedWords: [
    'load-bearing', 'heavy lifting', 'earns its keep', 'does work', 'the shape of',
    'key insight', 'crucially', 'delve', 'orthogonal', 'single source of truth',
    'the magic happens', 'synthesize', 'eats for breakfast', 'what the eye reads',
    'somebody talking', 'on the glass', 'the glass', 'the tube', 'the wire',
    'is the point', 'the whole idea', 'the whole point',
  ],
  certitude: ['obviously', 'clearly', 'simply', 'honest', 'crucially', 'root cause'],
  trade: [
    'rate', 'limit', 'queue', 'cache', 'byte', 'ms', 'retry', 'lock', 'buffer',
    'cell', 'row', 'column', 'grid', 'key', 'frame', 'pixel', 'font', 'glyph',
    'beam', 'attribute', 'stack', 'screen', 'index', 'path', 'file', 'token',
  ],
  acronyms: [
    'ANSI', 'ASCII', 'API', 'BDF', 'CJK', 'CORS', 'CRT', 'CSI', 'CSS', 'DOM', 'DOS',
    'EOF', 'FNV', 'GLSL', 'GPU', 'HTTP', 'IME', 'IRC', 'JSON', 'MIT', 'NFC', 'OPFS',
    'POSIX', 'PWA', 'REST', 'RGB', 'RTDB', 'SAB', 'SGR', 'SSE', 'SSH', 'TODO', 'TTY',
    'URL', 'UTF', 'VFS', 'VGA', 'WASI', 'ZWSP',
  ],
}

const RULES: Rule[] = [
  { id: 'banned-word', severity: 'error', remedy: 'name the real thing instead',
    except: ['packages/crt/'] },
  { id: 'emoji', severity: 'error', remedy: 'remove it' },
  { id: 'caps-emphasis', severity: 'error', remedy: 'lower case; let the sentence carry it' },
  { id: 'chat-leakage', severity: 'error', remedy: 'a comment is not a message to a reader' },
  { id: 'markdown', severity: 'error', remedy: 'comments are plain text' },
  { id: 'certitude-filler', severity: 'warn', remedy: 'drop the qualifier' },
  { id: 'contrastive-binary', severity: 'warn', remedy: 'state what it is; drop what it is not' },
  { id: 'em-dash-density', severity: 'warn', remedy: 'split into sentences' },
  { id: 'aphoristic-ender', severity: 'warn', remedy: 'delete the closing flourish' },
  { id: 'second-person', severity: 'warn', remedy: 'write impersonally' },
  { id: 'redundant-what', severity: 'warn', remedy: 'the code already says this' },
  { id: 'atmospheric', severity: 'warn', remedy: 'no identifiers, digits or terms: make a checkable claim' },
  // Off by default: most hits are domain constants rather than stale references.
  // Enable through tools/comments.config.json when auditing numbers.
  { id: 'stale-number', severity: 'off', remedy: 'no matching literal in the file; check it is still true' },
  { id: 'length', severity: 'warn', remedy: 'move to the header or docs/design' },
]

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u
const CHAT = /\bas requested\b|\bper (the|your) (new )?(requirements?|request)\b|\bI(?:'ve| have)\b|\bFixed!|^\s*(now|let's|we now|we then)\b/i
const CONTRASTIVE = /\bnot (just|merely|only)\b[^.]{0,60}\bbut\b|\bisn't\b[^.]{0,60}—[^.]{0,60}\bit's\b|\bis not\b[^.]{0,50}—[^.]{0,50}\bit is\b/i
const SECOND_PERSON = /\b(you|your|yours|we|our|ours|us|let's)\b/i
const MARKDOWN = /\*\*\S(?:[^*]*\S)?\*\*|^#{1,6}\s/

/**
 * Strips comments out of a source file, returning them as blocks.
 *
 * Tracks strings, templates and regex literals so a slash inside one is not read
 * as a comment. The regex test is the usual heuristic: a slash starts a literal
 * when the previous significant character cannot end an expression.
 */
function extract(src: string): Block[] {
  const lines = src.split('\n')
  const isComment: (string | null)[] = new Array(lines.length).fill(null)
  const raws: (string | null)[] = new Array(lines.length).fill(null)

  let i = 0, line = 0, prev = ''
  const n = src.length
  const mark = (l: number, text: string, raw: string): void => {
    if (isComment[l] === null) { isComment[l] = text; raws[l] = raw }
  }

  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (c === '"' || c === "'") {
      const q = c; i++
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++ }
      i++; prev = q; continue
    }
    if (c === '`') {
      i++
      while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++ }
      i++; prev = '`'; continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? n : end
      const raw = src.slice(i, stop)
      mark(line, raw.replace(/^\/\/+\s?/, '').trim(), raw)
      i = stop; continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      const chunk = src.slice(i, stop)
      let l = line
      for (const part of chunk.split('\n')) {
        mark(l, part.replace(/^\s*\/?\*+\/?\s?/, '').replace(/\*\/$/, '').trim(), part)
        l++
      }
      line += chunk.split('\n').length - 1
      i = stop; continue
    }
    if (c === '/' && /[([{=,;:!&|?+\-*%~^<>]/.test(prev)) {
      i++
      while (i < n && src[i] !== '/' && src[i] !== '\n') { if (src[i] === '\\') i++; i++ }
      i++; prev = '/'; continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }

  const blocks: Block[] = []
  let cur: Block | null = null
  for (let l = 0; l < lines.length; l++) {
    if (isComment[l] !== null) {
      if (!cur) cur = { line: l + 1, lines: [], header: false, nextCode: 0, raw: [] }
      cur.lines.push(isComment[l] as string)
      cur.raw.push(raws[l] as string)
    } else if (cur) {
      cur.nextCode = lines[l].trim() ? l + 1 : 0
      cur.header = cur.line === 1 || /^\s*(export|function|class|const|let|interface|type|async|\/\*\*|[A-Za-z_$][\w$]*\s*[({:])/.test(lines[l] ?? '')
      blocks.push(cur); cur = null
    }
  }
  if (cur) { cur.nextCode = 0; blocks.push(cur) }
  return blocks
}

/** Every identifier that appears outside a comment anywhere in the scope. */
function collectIdentifiers(files: Map<string, string>): Set<string> {
  const ids = new Set<string>()
  for (const [, src] of files) {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    for (const m of stripped.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) ids.add(m[0])
  }
  return ids
}

/**
 * Words written in lower case somewhere in the comments.
 *
 * Distinguishes a shouted ordinary word from an acronym: MACHINE is flagged
 * because `machine` is written normally elsewhere, where CP437 and CSP are not.
 * lint-comment: disable caps-emphasis
 */
function collectProse(files: Map<string, string>): Set<string> {
  const seen = new Set<string>()
  for (const [, src] of files) {
    for (const b of extract(src)) {
      for (const w of b.lines.join(' ').match(/\b[a-z]{4,}\b/g) ?? []) seen.add(w)
    }
  }
  return seen
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []
}

function check(
  file: string, src: string, ids: Set<string>, prose: Set<string>, cfg: typeof DEFAULTS,
): Finding[] {
  const out: Finding[] = []
  const lines = src.split('\n')
  const fileIds = new Set(
    (src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
      .match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).map(w => w.toLowerCase()),
  )
  const fileNums = new Set(
    (src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
      .match(/\b\d+(?:\.\d+)?\b/g) ?? []),
  )
  const disabledFile = new Set<string>()
  for (const m of src.matchAll(/lint-comment:\s*disable-file\s+([\w,-]+)/g)) {
    for (const r of m[1].split(',')) disabledFile.add(r.trim())
  }

  const seen = new Set<string>()
  let blockDisabled = new Set<string>()
  const add = (line: number, id: string, text: string): void => {
    const rule = RULES.find(r => r.id === id)
    if (!rule || rule.severity === 'off') return
    if (rule.except?.some(p => file.startsWith(p))) return
    if (disabledFile.has(id) || blockDisabled.has(id)) return
    const above = lines[line - 2] ?? ''
    const m = above.match(/lint-comment:\s*disable\s+([\w,-]+)/)
    if (m && m[1].split(',').map(x => x.trim()).includes(id)) return
    const key = `${line}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ file, line, rule: id, severity: rule.severity, text: text.slice(0, 110), remedy: rule.remedy })
  }

  for (const b of extract(src)) {
    const joined = b.lines.join(' ').trim()
    if (!joined) continue
    blockDisabled = new Set<string>()
    for (const m of joined.matchAll(/lint-comment:\s*disable\s+([\w,-]+)/g)) {
      for (const r of m[1].split(',')) blockDisabled.add(r.trim())
    }

    b.lines.forEach((text, k) => {
      const ln = b.line + k
      if (!text) return
      for (const w of cfg.bannedWords) {
        if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) add(ln, 'banned-word', text)
      }
      if (EMOJI.test(text)) add(ln, 'emoji', text)
      if (CHAT.test(text)) add(ln, 'chat-leakage', text)
      if (MARKDOWN.test(text)) add(ln, 'markdown', text)
      if (SECOND_PERSON.test(text)) add(ln, 'second-person', text)
      for (const w of cfg.certitude) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(text)) add(ln, 'certitude-filler', text)
      }
      for (const m of text.matchAll(/\b[A-Z]{4,}\b/g)) {
        const w = m[0]
        if (cfg.acronyms.includes(w) || ids.has(w)) continue
        if (!prose.has(w.toLowerCase())) continue
        // A dotted or underscored neighbour makes it a name, not emphasis.
        const before = text[(m.index ?? 0) - 1] ?? ' '
        const after = text[(m.index ?? 0) + w.length] ?? ' '
        if (before === '.' || before === '_' || after === '.' || after === '_') continue
        add(ln, 'caps-emphasis', `${w} in: ${text}`)
      }
    })

    if (CONTRASTIVE.test(joined)) add(b.line, 'contrastive-binary', joined)
    if ((joined.match(/—/g) ?? []).length >= 2) add(b.line, 'em-dash-density', joined)

    const sentences = joined.split(/(?<=[.!?])\s+/).filter(Boolean)
    if (sentences.length > 2) {
      const last = sentences[sentences.length - 1]
      const lw = words(last)
      const reference = /^(see|use|used|call|called|returns?|defaults?|omit|pass|prefer|kept|absent|must|this|it|the|a|an|both|either|neither)\b/i
      if (lw.length > 2 && lw.length < 7 && !/\d/.test(last)
          && !reference.test(last) && !lw.some(w => fileIds.has(w))) {
        add(b.line + b.lines.length - 1, 'aphoristic-ender', last)
      }
    }

    const jw = words(joined)
    if (jw.length > 15 && !/\d/.test(joined)
        && !jw.some(w => fileIds.has(w))
        && !jw.some(w => cfg.trade.includes(w))) {
      add(b.line, 'atmospheric', joined)
    }

    const jsdoc = (b.raw[0] ?? '').trim().startsWith('/**')
    if (!b.header && !jsdoc && b.lines.length > 5) add(b.line, 'length', joined)

    if (!b.header && b.nextCode) {
      const code = lines.slice(b.nextCode - 1, b.nextCode + 1).join(' ')
      const cw = new Set(words(code))
      const shared = jw.filter(w => cw.has(w)).length
      if (jw.length >= 4 && shared / jw.length > 0.6) add(b.line, 'redundant-what', joined)
    }

    const nums = joined.match(/\b\d+(?:\.\d+)?\b/g) ?? []
    if (nums.length && b.nextCode) {
      const orphan = nums.filter(v => !fileNums.has(v) && Number(v) > 2)
      if (orphan.length && orphan.length === nums.length) {
        add(b.line, 'stale-number', `${orphan.join(', ')} in: ${joined}`)
      }
    }
  }
  return out
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries
  try { entries = await readdir(ROOT + dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) await walk(rel, acc)
    else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(rel)
  }
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith('--')))
let targets = argv.filter(a => !a.startsWith('--'))

if (flags.has('--hook')) {
  const raw = await Bun.stdin.text()
  let path = ''
  try { path = JSON.parse(raw)?.tool_input?.file_path ?? '' } catch { path = '' }
  if (!path) process.exit(0)
  targets = [path.startsWith(ROOT) ? path.slice(ROOT.length) : path]
  if (!/\.(ts|js)$/.test(targets[0])) process.exit(0)
}

if (!targets.length) {
  const acc: string[] = []
  for (const dir of SCOPE) await walk(dir, acc)
  targets = acc
}

let cfg = DEFAULTS
const cfgFile = Bun.file(ROOT + 'tools/comments.config.json')
if (await cfgFile.exists()) cfg = { ...DEFAULTS, ...(await cfgFile.json()) }

const sources = new Map<string, string>()
for (const t of targets) {
  const rel = t.startsWith(ROOT) ? t.slice(ROOT.length) : t
  const f = Bun.file(ROOT + rel)
  if (await f.exists()) sources.set(rel, await f.text())
}

const ids = collectIdentifiers(sources)
const prose = collectProse(sources)
const findings: Finding[] = []
for (const [rel, src] of sources) findings.push(...check(rel, src, ids, prose, cfg))

const errors = findings.filter(f => f.severity === 'error')
const warns = findings.filter(f => f.severity === 'warn')

if (flags.has('--json')) {
  console.log(JSON.stringify({ errors: errors.length, warnings: warns.length, findings }, null, 2))
} else {
  const show = flags.has('--check') ? errors : findings
  for (const f of show) {
    console.error(`${f.file}:${f.line}: ${f.severity} ${f.rule}: ${f.text}`)
    console.error(`  -> ${f.remedy}`)
  }
  console.error(
    `comments: ${sources.size} files, ${errors.length} errors, ${warns.length} warnings`,
  )
}

// Hook mode exits 2, which is the code that returns stderr to the caller that
// made the edit. Any other non-zero is reported without it.
if (errors.length) process.exit(flags.has('--hook') ? 2 : 1)
if (flags.has('--strict') && warns.length) process.exit(1)
