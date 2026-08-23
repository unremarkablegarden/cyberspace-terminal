# Shell

## Current: TypeScript POSIX subset (`packages/shell`)

Implemented: pipelines `|`; lists `;` `&&` `||`; redirects `>` `>>` `<` `2>`
`2>>`; quoting `'` `"` `\`; `$VAR` `${VAR}` `$?`; leading `~`; pathname globs
`*` `?` `[...]`; `NAME=value` assignments (shell vars; `export` promotes);
comments `#`. Line editor: cursor movement, kill keys, persistent history
(`~/.sh_history`), tab completion for commands and paths.

Deliberately absent for now: word splitting of expansions, command
substitution, job control (`&`, `fg`), heredocs, functions, control flow.

Builtins (must run in the shell process): `cd` `pwd` `export` `unset` `exit`
`history`. Everything else is a program in `/bin`.

### History file

`~/.sh_history` is appended to, one line per accepted command, never rewritten
in place. A rewrite opens `O_TRUNC`, and the write is not awaited before the
command runs, so a command that reads the file lands in a window where it is
zero length — `cat .sh_history` hit that on every invocation and printed
nothing. Writes are chained to keep their order. The file is compacted only
once it passes `HISTFILEMAX` lines, and that compaction writes a temp file and
renames it over the original rather than truncating.

## Evaluated: mvdan/sh compiled to wasm (`spikes/mvdansh`)

The full bash-compatible parser + interpreter (mvdan.cc/sh/v3) compiles to
`GOOS=js GOARCH=wasm` without issue and runs in a JS host.

Measured (go 1.26.4, `-trimpath -ldflags='-s -w'`):

| | size |
| --- | --- |
| sh.wasm | 5.5 MB |
| gzipped | 1.5 MB |

Verdict: viable as a later upgrade, not the v0 shell. Costs beyond size that
remain unbuilt: bridging `interp`'s exec/open/readdir/stat handlers to the
VFS over `syscall/js`, and streaming stdio across the Go/JS boundary. The
npm `mvdan-sh` package is archived (GopherJS); `sh-syntax` ships the parser
only. A future integration builds the wasm bundle from `spikes/mvdansh`.
