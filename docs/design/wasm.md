# wasm programs

wasm32-wasi (Preview 1) binaries run as processes. The kernel's exec path
(`resolveExec`) recognises three file kinds: the `\0asm` magic (WASI run),
`#!interpreter` shebangs (dispatched to the named program with the script path
appended — `#!/bin/sh` lands in the shell's non-interactive mode), and the
`#!builtin` stubs `/bin` is seeded with.

## The batch model (current)

WASI p1 is synchronous and the host runs on the main thread, so:

- stdin from a pipe or file is collected in full before the program starts;
  stdout/stderr stream out as written (baud-paced like everything else).
- stdin from the interactive tty is handed over EMPTY. A synchronous program
  blocking on a keyboard that cannot wake it would hang the tab. `cowsay`
  alone gets "moo?"; `echo x | cowsay` gets x.
- No filesystem access, no clock-driven interactivity, no raw mode.

Host: `@bjorn3/browser_wasi_shim` (stdio via OpenFile/ConsoleStdout; it also
implements poll_oneoff/sched_yield, which Go's wasip1 runtime needs).

## The Worker model (next)

Blocking stdin and VFS access need a Worker + SharedArrayBuffer + Atomics
(COOP/COEP is already served). That is what unlocks interactive programs
(busybox vi class) and real file-consuming tools. The batch runner stays for
the common pipeline case.

## Demo cargo

`tools/cowsay` (Go, `GOOS=wasip1 GOARCH=wasm`, ~2.6MB — Go's runtime tax;
TinyGo or Rust would be a tenth of that). Built by `tools/cowsay/build.sh`
into `app/public/wasm/`, fetched in the background at boot and installed as
`/bin/cowsay`.
