// Tokenizer and AST for the POSIX subset:
//   pipelines |, lists ; && ||, redirects > >> < 2> 2>>, quoting ' " \,
//   assignments NAME=value, comments #, aliases.
// Expansion ($VAR, ~, globs) happens later, on Word segments, so quoting
// survives to that stage.

export type Quote = 'none' | 'single' | 'double'

export interface Segment {
  text: string
  quote: Quote
}

export interface Word {
  segments: Segment[]
}

export interface Redir {
  fd: 0 | 1 | 2
  op: '>' | '>>' | '<'
  target: Word
}

export interface Cmd {
  assigns: { name: string; value: Word }[]
  words: Word[]
  redirs: Redir[]
}

export interface Pipeline {
  cmds: Cmd[]
}

/** op is the connective preceding the pipeline; the first is always ';'. */
export interface List {
  items: { op: ';' | '&&' | '||'; pipeline: Pipeline }[]
}

export class ParseError extends Error {}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: '|' | ';' | '&&' | '||' | '>' | '>>' | '<' | '2>' | '2>>' }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length

  const peek = () => src[i]
  const isOpStart = (c: string) => '|;&<>'.includes(c)

  while (i < n) {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++
    if (i >= n) break
    let c = src[i]

    if (c === '#') break

    // 2> / 2>> only where a redirect can start.
    if (c === '2' && src[i + 1] === '>') {
      i += 2
      if (src[i] === '>') { i++; tokens.push({ kind: 'op', op: '2>>' }) }
      else tokens.push({ kind: 'op', op: '2>' })
      continue
    }

    if (isOpStart(c)) {
      if (c === '&' && src[i + 1] === '&') { i += 2; tokens.push({ kind: 'op', op: '&&' }); continue }
      if (c === '|' && src[i + 1] === '|') { i += 2; tokens.push({ kind: 'op', op: '||' }); continue }
      if (c === '>' && src[i + 1] === '>') { i += 2; tokens.push({ kind: 'op', op: '>>' }); continue }
      if (c === '&') throw new ParseError('syntax error: & not supported')
      i++
      tokens.push({ kind: 'op', op: c as '|' | ';' | '>' | '<' })
      continue
    }

    // A word: consume until unquoted whitespace or operator.
    const segments: Segment[] = []
    let cur = ''
    const flush = (quote: Quote) => {
      if (cur || quote !== 'none') segments.push({ text: cur, quote })
      cur = ''
    }
    while (i < n) {
      c = src[i]
      if (c === "'") {
        flush('none')
        i++
        const end = src.indexOf("'", i)
        if (end < 0) throw new ParseError('syntax error: unterminated quoted string')
        cur = src.slice(i, end)
        i = end + 1
        flush('single')
        continue
      }
      if (c === '"') {
        flush('none')
        i++
        for (; i < n && src[i] !== '"'; i++) {
          if (src[i] === '\\' && '"\\$'.includes(src[i + 1] ?? '')) { cur += src[++i]; continue }
          cur += src[i]
        }
        if (i >= n) throw new ParseError('syntax error: unterminated quoted string')
        i++
        flush('double')
        continue
      }
      if (c === '\\') {
        if (i + 1 >= n) throw new ParseError('syntax error: trailing backslash')
        // Escaped char is literal: park it in a single-quoted segment.
        flush('none')
        cur = src[i + 1]
        flush('single')
        i += 2
        continue
      }
      if (c === ' ' || c === '\t' || c === '#' || isOpStart(c)) break
      cur += c
      i++
    }
    flush('none')
    tokens.push({ kind: 'word', word: { segments } })
  }
  return tokens
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Literal prefix of a word up to the first non-plain segment. */
function plainPrefix(w: Word): string {
  return w.segments[0]?.quote === 'none' ? w.segments[0].text : ''
}

const isSeparator = (op: string): boolean => op === '|' || op === ';' || op === '&&' || op === '||'

/** A word with no quoting or escapes: the only kind an alias name matches. */
function plainWord(tok: Token): string | null {
  if (tok.kind !== 'word' || tok.word.segments.length !== 1) return null
  const seg = tok.word.segments[0]
  return seg.quote === 'none' ? seg.text : null
}

/**
 * Alias expansion, as bash does it: on tokens, before the AST, so a value may
 * hold operators (`alias ll='ls -l | more'`). Only the first word of a simple
 * command is looked up, plus the word after a value ending in a blank.
 * `seen` holds the aliases being expanded, so `alias ls='ls -F'` stops after
 * one step.
 */
function expandAliases(
  tokens: Token[], aliases: ReadonlyMap<string, string>, seen: ReadonlySet<string> = new Set(),
): Token[] {
  const out: Token[] = []
  let command = true
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]
    if (tok.kind === 'op') {
      out.push(tok)
      if (isSeparator(tok.op)) command = true
      // A redirect target is never a command word; the position is unchanged.
      else if (tokens[t + 1]?.kind === 'word') out.push(tokens[++t])
      continue
    }
    const name: string | null = command ? plainWord(tok) : null
    const value: string | undefined = name === null || seen.has(name) ? undefined : aliases.get(name)
    if (name === null || value === undefined) {
      out.push(tok)
      // Assignments before the command word keep the position open.
      command = command && ASSIGN.test(plainPrefix(tok.word))
      continue
    }
    const expanded = expandAliases(tokenize(value), aliases, new Set(seen).add(name))
    out.push(...expanded)
    const last = expanded.at(-1)
    command = /[ \t]$/.test(value) || (last?.kind === 'op' && isSeparator(last.op))
  }
  return out
}

export function parse(src: string, aliases?: ReadonlyMap<string, string>): List {
  let tokens = tokenize(src)
  if (aliases?.size) tokens = expandAliases(tokens, aliases)
  const items: List['items'] = []
  let op: ';' | '&&' | '||' = ';'
  let t = 0

  while (t < tokens.length) {
    const cmds: Cmd[] = []
    for (;;) {
      const cmd: Cmd = { assigns: [], words: [], redirs: [] }
      // Assignment prefix, only before the first word.
      while (t < tokens.length) {
        const tok = tokens[t]
        if (tok.kind !== 'word' || cmd.words.length) break
        const m = ASSIGN.exec(plainPrefix(tok.word))
        if (!m) break
        const name = m[0].slice(0, -1)
        const rest = tok.word.segments.slice()
        rest[0] = { text: rest[0].text.slice(m[0].length), quote: 'none' }
        cmd.assigns.push({ name, value: { segments: rest } })
        t++
      }
      while (t < tokens.length) {
        const tok = tokens[t]
        if (tok.kind === 'word') { cmd.words.push(tok.word); t++; continue }
        if (tok.op === '>' || tok.op === '>>' || tok.op === '<' || tok.op === '2>' || tok.op === '2>>') {
          t++
          const target = tokens[t]
          if (!target || target.kind !== 'word') throw new ParseError('syntax error: redirect requires a word')
          t++
          const fd = tok.op.startsWith('2') ? 2 : tok.op === '<' ? 0 : 1
          const op2 = tok.op.replace('2', '') as '>' | '>>' | '<'
          cmd.redirs.push({ fd: fd as 0 | 1 | 2, op: op2, target: target.word })
          continue
        }
        break
      }
      if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) {
        throw new ParseError('syntax error: missing command')
      }
      cmds.push(cmd)
      const tok = tokens[t]
      if (tok?.kind === 'op' && tok.op === '|') { t++; continue }
      break
    }
    items.push({ op, pipeline: { cmds } })
    const tok = tokens[t]
    if (!tok) break
    if (tok.kind === 'op' && (tok.op === ';' || tok.op === '&&' || tok.op === '||')) {
      op = tok.op
      t++
      if (t >= tokens.length && op !== ';') throw new ParseError('syntax error: unexpected end of input')
      continue
    }
    throw new ParseError('syntax error: unexpected token')
  }
  return { items }
}
