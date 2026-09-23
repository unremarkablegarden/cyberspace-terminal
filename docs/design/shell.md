# Shell

## Current: TypeScript POSIX subset (`packages/shell`)

Implemented: pipelines `|`; lists `;` `&&` `||`; redirects `>` `>>` `<` `2>`
`2>>`; quoting `'` `"` `\`; `$VAR` `${VAR}` `$?`; leading `~`; pathname globs
`*` `?` `[...]`; `NAME=value` assignments (shell vars; `export` promotes);
comments `#`; aliases. Line editor: cursor movement, kill keys, persistent history
(`~/.sh_history`), tab completion for commands and paths.

Deliberately absent for now: word splitting of expansions, command
substitution, job control (`&`, `fg`), heredocs, functions, control flow.

Builtins (must run in the shell process): `cd` `pwd` `export` `unset` `exit`
`history` `alias` `unalias` `source` `.` `fg` `ps` `kill`. Everything else is a
program in `/bin`.

### Aliases and `~/.shrc`

Alias expansion follows bash and runs on tokens, before the AST is built, so a value can hold operators (`alias ll='ls -l | more'`). Only the first word of a simple command is looked up: at line start, after `|` `;` `&&` `||`, and after leading assignments. A quoted or escaped word (`\ls`, `'ls'`) is not looked up. An alias is not expanded again inside its own expansion, so `alias ls='ls -F'` terminates. A value ending in a blank makes the next word a candidate too.

Aliases belong to one shell and are not exported. An interactive shell sources `~/.shrc` before it claims the job table, so its lines run as plain pipelines; `exit` there ends the file, not the shell. `sh script` does not read it. `source` and `.` run a file in the current shell after their own pipeline has exited, so the file's lines are not jobs inside the builtin's job. A parked job's line is parsed without aliases: it holds expanded words already.

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
