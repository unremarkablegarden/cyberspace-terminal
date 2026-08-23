# Changelog

## v0.1

- The machine boots
    - WebGL2 CRT fed by an ANSI/VT parser
    - Kernel: processes, pipes, tty, VFS
    - Filesystem: ZenFS on OPFS, home persists
    - Shell: pipelines, redirection, globs, `$?`, history, tab completion
    - Coreutils
- Display
    - Audio: sampled keys, machine noise, degauss, power, boot chime
    - Strike and implode tube effects
    - 6 font families, 6x13 coverage fallback
    - `F1` config: screen preset, phosphor, font, sound, baud
    - Soft keyboard and 44x20 grid on phones
    - `shutdown`, `reboot`, BEL
    - Output paced at the configured baud
- Programs
    - wasm32-wasi binaries run as processes, one worker each, blocking stdin
    - `#!` dispatch and non-interactive script mode
    - `cowsay` installed to `/bin` at boot
    - Compat host runs the original /terminal programs
    - Examples seeded at `/bin/examples`
- `edit` (`nano` keys), full-screen over ANSI
- Network
    - `login`, `logout`, `whoami`, `finger`, `feed`
    - Sessions resume at boot
- Chat
    - `circ`: rooms, presence, read markers, live message stream
    - `cmail`: 1:1 conversations, unread first
- Registry: `browse`, `install`, `publish`, `recall`
    - `ctx.api` capability for published programs, locked to `/v1/`
- Offline: installable PWA, boots with no network
- Machine copy in the old unix register, errno wording for every error
- COOP/COEP headers in production

## v0.2

- TUI
    - Widget toolkit: box, log, list, input, reveal, select, confirm, text, prompt, tune
    - Screen stack: popups over any full-screen program
    - Widgets draw on either the ANSI surface or the display grid
- Display
    - Boot loader: banner, memory count, hardware probe, service mounts (`^C` skips)
    - Screensaver
    - 5 keyboard sound sets in `F1`
    - `F1` panes for controls and key sounds
- `less` / `more`
- Chat
    - `circ` and `cmail` rebuilt on the toolkit
    - Backlog prints by the line, new messages type at 2400 baud
    - `cmail` draws a box per turn
    - Room switcher shows unread rooms
    - Unknown slash commands are refused locally, not sent as prose
    - `/help` opens the local help box
- `login` masks the password
- Output pacing fixed at 240 cps; keystroke echo and repaints are not paced
- Fixed reads returning another file's contents after a reload (ZenFS inodes)
- Fixed `cat ~/.sh_history` printing nothing (history appends, no truncate)
- Fixed pacing running 1000x slow (seconds counted as milliseconds)
- Fixed `^H` and `^J` never reaching programs
- Fixed popups not redrawing on a key
- `changelog` prints the change log
- Fixed `cmd | less` returning at once (keys were read from the pipe, not the terminal)
- Icon: the site's globe, in P1 phosphor
- Version follows the change log: motd, `uname -a`, boot banner, package manifests
- motd drops the status line
- Fixed `cat` on a directory printing its bytes
