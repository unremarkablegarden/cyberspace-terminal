# Lineage

History. This machine replaced the terminal that shipped inside the Cyberspace
site at `/terminal`, since retired. That one was a
Nuxt page over an engine of plain modules: commands wrote cells straight onto
the grid, home was a tree of Firestore documents, and a member's program was
imported into the page. The rewrite kept the tube, the fonts, the audio and the
widget set, and replaced everything under them with a kernel that speaks a pty
byte stream — because a kernel with no display can also sit behind ssh.

This records what changed, for reading the older code and the programs it left
in the gallery.

## Micro

| | before | after |
| --- | --- | --- |
| Shape | Nuxt page + engine modules | bun workspaces, own build and host, PWA |
| Contract | command writes cells | ANSI byte stream, parsed to cells per frame |
| Program | `run(ctx, args)`, one at a time | `(p: Proc) => code`: argv, env, fds, signal |
| Composition | none | pipes, redirects, `&&`, `$?` |
| Foreign code | blob-imported into the page, filtered | WASI in a worker, or a capability host |
| Home | Firestore + R2 documents | ZenFS on OPFS, local bytes |
| Account | required for most of it | required for the network programs only |
| Site | page's own Firebase session | Bearer client against the API |
| Registry | browser writes R2 + Firestore | API routes over the same store |
| Pictures | rasteriser writes cells onto the grid | faceplate rasterises, cells cross as code points |
| Shared | — | CRT, TUI widgets, chat layout, copy |

## Shape

Before: the page mounted the engine, held every preference, and
supplied `username`, the version and `reboot` as getters. It deployed with the
site.

After: `packages/*` (crt, kernel, shell, coreutils, tui, compat), `apps/cyberspace`
for anything that talks to the site, `app` for the host that wires them. Its own
Vite build, its own domain, installable offline.

## The contract

Before, a command held `TermCtx` and wrote cells; `Shell.type()/typeln()` paced
them onto the grid.

After, everything is a pty byte stream. Programs write ANSI, `@xterm/headless`
parses it, `app/src/vt.ts` copies the changed cells into the same planes, and
`packages/crt` rasterises as before. That costs a parse per frame and buys two
things: any producer of ANSI runs unmodified, and nothing below the host imports
a display.

That moves pacing too. Before, it belonged to one method and everything else
was instant; now the stream is paced by default, at 240 cps, and the bleep is a
side effect of a paced byte being released (`app/src/baud.ts`,
`app/src/main.ts`). The shell and the coreutils want that. Keystroke echo
(`Tty.echo`) and full-screen frames (`Tty.paint`) do not and are written whole.
A program that draws rather than prints turns the rate off for its run with
`Tty.setPaced(false)`, which is what the compat host does, leaving `ctx.type` as
the only clock a user program is under.

## Processes

Before: `Command { run(ctx, args) }`, listed once in a command table, run one
at a time by the shell's dispatch. A command that reached the site set
`requiresAuth` and dispatch enforced it.

After: `Program = (p: Proc) => number` (`packages/kernel/src/proc.ts`). A `Proc`
carries pid, argv, env, cwd, stdin/stdout/stderr, an `AbortSignal` and a tty when
it has one. Pipes are real (`packages/kernel/src/pipe.ts`), exit codes are real,
^C is a signal. There is no auth flag: `login` prompts and returns; the host
renames the running shell's `USER`, and `logout` puts it back to guest.

## Executing a file

Before: the source was turned into a blob URL and imported as an ES module
into the page. A guard read it first and refused source that reached
the Firebase credential in IndexedDB — a filter, not a boundary.

After: `kernel.resolveExec` tries builtins, then `$PATH`. A `\0asm` header runs as
WASI in its own worker (`packages/kernel/src/wasi.worker.ts`; stdin is a
SharedArrayBuffer ring, so a wasm program blocks on the keyboard for real and
stays killable). `#!` dispatches to an interpreter. JavaScript goes to
`packages/compat`, which hands it a host object and one explicit capability —
`ctx.api`, locked to `/v1/`. Isolation where there was a source filter.

## Pictures

A photograph is drawn the same way as before, and for the same reason. A cell can
carry its own bitmap instead of a glyph, so an image lands on the beam
framebuffer at the framebuffer's resolution — sixteen times what a braille grid
holds — and the bloom, the scanlines and the curvature ripple over it because it
went through the rasteriser that draws the text. `packages/tui/src/raster` is
that rasteriser, ported whole: an 8x8 Bayer screen with value noise, the same one
the site runs as a shader, so a photograph here and the same
photograph on the web are screened identically.

What differs is who holds the bitmap. Before, a command had the grid in front
of it and called `putGlyph`. Now the program is behind a pty, and a pty carries
characters. So the faceplate decodes, rasterises, and files each bitmap under a
private-use code point; the program writes those code points like any other
text, and `app/src/vt.ts` resolves them back onto the tube's own bitmap plane.
A picture wraps nowhere, scrolls with the log and clips at the pane, because as
far as everything between the two ends is concerned it is a row of text.

Decoding an image is the one thing the kernel cannot do — it is a DOM away, and
the kernel has to stay somewhere a Bun process can run it. So pictures are a
capability the host passes in, and a faceplate that cannot draw one passes
nothing: the attachment is named rather than drawn, which is what this machine
did before there was a rasteriser.

## Filesystem

Before: an in-memory tree whose home was Firestore plus R2. A file was a cloud
document, an empty directory a localStorage key, and there was nothing to read without an account.

After: ZenFS — OPFS for home, Fetch for the `/repo` and `/bin` seeds, InMemory for
`/tmp` — under the kernel's own fd and pipe layer. A file is bytes in this
browser. `docs/design/vfs.md` has the details.

## Shell

Before: one line, one verb, arguments split off it.

After: `packages/shell` parses a POSIX subset — pipelines, `;` `&&` `||`,
`> >> < 2>`, quoting, `NAME=value`, `$VAR`, `~`, globs, `$?` — with a readline of
its own, a history file, tab completion, and a non-interactive mode so `#!/bin/sh`
scripts run. `docs/design/shell.md` records why the wasm interpreter was deferred.

## Network

Before: the page was already signed in, so a command used the site's Firebase
session directly.

After: `apps/cyberspace/src/api.ts` is a Bearer client against
`api.cyberspace.online` — refresh token in localStorage, refresh-and-retry on
401. Live chat reads stream from the realtime database over SSE. Neither the
kernel nor a user program is handed a credential.

## Registry

Before: the browser took a presigned PUT to R2 and wrote the Firestore document
itself, with rules deciding what could be recorded.

After: `browse`, `install`, `publish` and `recall` go through `/v1/programs` on
the API, which writes the same bucket and the same collection the old terminal
wrote, so everything published there is still in the gallery.

## What carried over

`packages/crt` is the site engine's tube: beam rasteriser, BDF fonts, audio, boot
sequence, F1 config, screensavers. `packages/tui` is its widget set — box, log,
list, input, select, confirm, reveal, tune, buffer — redrawn onto `Surface`,
which diffs cells into ANSI.
`apps/cyberspace/src/chat.ts` is the site's chat layout, and `packages/tui/src/raster`
its image rasteriser. The copy is the same copy. `packages/compat` runs the JS
programs the old terminal published, as they were written.

## What is not here

tron, the three.js grid and `gl3d`, TripSynth,
`fullscreen`. Pictures are drawn but cannot be sent: `/img` needs an upload route the API does not have, so a GIF
is still named rather than played.

## Why

The kernel and userland are TypeScript and wasm with no DOM and no Bun APIs, so
the same machine can run behind ssh with a different faceplate in front of it.
The byte stream is what makes that possible; the process model, the real
filesystem and the capability-scoped programs are what the byte stream costs.
