# wasm programs

wasm32-wasi (Preview 1) binaries run as processes. The kernel's exec path
(`resolveExec`) recognises three file kinds: the `\0asm` magic (WASI run),
`#!interpreter` shebangs (dispatched to the named program with the script path
appended; `#!/bin/sh` lands in the shell's non-interactive mode), and the
`#!builtin` stubs `/bin` is seeded with.

## The Worker model

`packages/kernel/src/wasi.ts` (kernel side) and `wasi.worker.ts` (the process
host). WASI p1 is synchronous, so the program runs in a dedicated Worker and
blocks there; the main thread never waits.

- stdout/stderr stream back over postMessage and are paced like any output.
- stdin from a pipe or file is read in full up front and handed over as bytes.
- stdin from the terminal is a SharedArrayBuffer ring (`sabring.ts`): the
  kernel writes keystrokes in, the worker's reads block on it with
  Atomics.wait. Needs cross-origin isolation (COOP/COEP, on in vite config and
  app/vercel.json); without it the tty is handed over empty.
- `poll_oneoff` is the kernel's own (`poll.ts`): any mix of clock and fd
  subscriptions, sleeping on the ring with a deadline. A program can wait on
  the keyboard with a timeout (an editor's Escape timer) and a `sleep()` does
  not spin.
- ^C closes the ring as killed, terminates the Worker and exits 130.

Host library: `@bjorn3/browser_wasi_shim` for the fd table, memfs and the
remaining imports.

### Files are staged, not bridged

The worker cannot reach ZenFS synchronously, and a SharedArrayBuffer RPC
bridge is the expensive road. Instead the kernel reads what the program is
likely to want before the run and ships it as an in-memory tree, preopened
as `/`:

- the working directory and `$HOME`, as directories;
- every argument naming an existing file (with its bytes, up to 8 MB) or
  directory;
- the parent directory of an argument that names nothing yet, so the program
  can create it;
- `~/.<name>rc` for a program called `name`.

A file opened with write rights is posted back whole when its fd closes, if
its bytes differ from what the machine holds, and the kernel writes it to
ZenFS. The exit code waits for those writes, so `vim f; cat f` sees the file.
Not covered: opening a file that was not named on the command line, listing
directories the program was not given, renames and deletes. If those become
wanted, a synchronous bridge replaces the staged tree behind the same
PreopenDirectory interface and nothing on the program side changes.

`$PWD` is set to the working directory. wasi-libc starts at `/` and does not
read it; Go's wasip1 runtime does. C programs that care call `chdir(getenv("PWD"))`
(vim does, in os_wasi.c).

### The `cyberspace` import module

Two imports WASI has no call for. A program that does not import the module is
unaffected.

- `tty_size(ptr) -> i32`: writes columns and rows as two u16 at ptr; returns
  -1 when stdio is not a terminal. `LINES` and `COLUMNS` are also set in the
  environment as the fallback.
- `tty_raw(on: i32)`: puts the terminal in raw mode (on != 0) or cooked. Raw
  also turns output pacing off for the run, since a program taking the tty raw
  is drawing a screen, not printing text. Cooked is restored on exit either way.

In raw mode ^C still kills the process, as it does for every program on the
machine; it is delivered as a byte as well.

## The batch fallback

Without Worker support the program runs inline on the main thread: stdin is
pre-read, an interactive tty is handed over empty (a synchronous program
blocking on a keyboard that cannot wake it would hang the tab), no files.

## Cargo

Fetched from `app/public/wasm/` at boot and installed into `/bin` by
`seedCargo` (app/src/machine.ts). The service worker precaches them.

- `tools/cowsay` (Go, `GOOS=wasip1 GOARCH=wasm`, 2.6 MB). Demo.
- `tools/vim`: upstream Vim 9, normal features, unpatched. `os_wasi.c`
  supplies the POSIX surface wasi-libc lacks (termios mapped onto `tty_raw`
  through the ICANON bit, `ioctl(TIOCGWINSZ)` from `tty_size`, fork and
  friends failing with ENOSYS, a termcap stub so Vim uses its builtin xterm
  entry, POSIX timers that never fire, `stat` wrapped to report 644/755 since
  WASI has no permission bits) and is handed to configure through LIBS;
  `include/` adds the termios, pwd and grp headers wasi-libc does not ship.
  `build.sh` gives configure its cross-compile answers. 3.5 MB, 1.4 MB gz.
  Installed as `/bin/vim` with `/bin/vi` a symlink; the skel `~/.vimrc` turns
  swap, backup and viminfo off so a write is one file, once. No shell escapes
  (`:!`, filters), no `:e` of files not named on the command line, no resize
  while running.

Checks: `spikes/wasi-check.ts` (host, with the Go program in
`spikes/wasitest`) and `spikes/vim-check.ts` (vim through the worker).
