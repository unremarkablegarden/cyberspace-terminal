// A program for this machine is a function. It receives the process and
// returns the exit code. Compare hello.js, which is written for the web
// terminal: that one exports an object with a run() and draws on a grid.
//
// Nothing is imported. Everything is on p.

// The one line browse shows. A program for the web terminal keeps it in its
// object literal; this kind has no object, so it exports it.
export const description = 'numbers lines, or counts to n'

export default async function count(p) {
  const to = Number(p.argv[1])

  // Any argument counts to it and stops.
  if (p.argv[1] !== undefined) {
    if (!Number.isInteger(to) || to < 1) {
      p.err('usage: count [n]\n')
      return 1
    }
    for (let i = 1; i <= to; i++) p.out(i + '\n')
    return 0
  }

  // No argument numbers what arrives on stdin, so it works in a pipeline:
  //   ls -1 | count
  let n = 0
  let rest = ''
  for (;;) {
    const chunk = await p.stdin.read()
    if (chunk === null) break
    rest += new TextDecoder().decode(chunk)
    const lines = rest.split('\n')
    // The last piece may be half a line; it waits for the rest of its chunk.
    rest = lines.pop() ?? ''
    for (const line of lines) p.out(`${String(++n).padStart(6)}  ${line}\n`)
  }
  if (rest) p.out(`${String(++n).padStart(6)}  ${rest}\n`)
  return 0
}
