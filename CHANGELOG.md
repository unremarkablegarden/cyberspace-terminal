# Changelog

## v0.1

- The machine boots
    - WebGL2 CRT, ANSI/VT parser
    - Kernel: processes, pipes, tty, VFS
    - Filesystem: ZenFS on OPFS, persistent home
    - Shell: pipelines, redirection, globs, `$?`, history, tab completion
    - Coreutils
- Display
    - Audio: keys, machine noise, degauss, power, boot chime
    - Strike and implode tube effects
    - 6 font families, 6x13 fallback
    - `F1` config: screen preset, phosphor, font, sound, baud
    - Soft keyboard, 44x20 grid on phones
    - `shutdown`, `reboot`, BEL
    - Baud-paced output
- Programs
    - wasm32-wasi processes, one worker each
    - `#!` dispatch, non-interactive scripts
    - `cowsay` at boot
    - Compat host for original /terminal programs
    - `/bin/examples`
- `edit` (`nano` keys), full-screen
- Network
    - `login`, `logout`, `whoami`, `finger`, `feed`
    - Session resume at boot
- Chat
    - `circ`: rooms, presence, read markers, live stream
    - `cmail`: 1:1, unread first
- Registry: `browse`, `install`, `publish`, `recall`
    - `ctx.api` capability, locked to `/v1/`
- Offline PWA
- Old-unix machine copy, errno wording
- COOP/COEP in production

## v0.2

- TUI
    - Widget toolkit: box, log, list, input, reveal, select, confirm, text, prompt, tune
    - Popup screen stack
- Display
    - Boot loader: banner, memory count, hardware probe, service mounts
    - Screensaver
    - 5 `F1` keyboard sound sets
- `less` / `more`
- Chat
    - `circ` and `cmail` rebuilt on the toolkit
    - Line-by-line backlog, 2400-baud typed messages
    - `cmail` per-turn boxes
    - Unread rooms in the switcher
    - Local slash gating, `/help` box
- `login` password mask
- Fixed stale reads after reload
- Fixed empty `~/.sh_history`
- Fixed pacing 1000x slow
- Fixed `^H`, `^J`, `PAGEUP`, `PAGEDOWN` not reaching programs
- Fixed popups not redrawing on key
- Fixed `cmd | less` exiting instantly
- Fixed `cat` on a directory
- `changelog` command
- Icon: site globe, P1 phosphor
- Version follows the changelog
- Session resume: screen, directory, room/thread, half-typed line
- Ten-minute session expiry, no cross-account bleed
- Scrollback: line and screen paging, snap to bottom
- `help` keys list
- `$PWD`
- Source split into modules
- Home seeded from `skel/home`
- Pictures
    - Photographs in `circ`/`cmail`, halftoned
    - `/art` blocks
    - `view file|url`
    - Fixed missing photographs in busy rooms
    - Fixed stray address under uncaptioned attachments
- Registry
    - `browse`: sortable, filter, About, source, install, remove, unpublish
    - Dry-run (`T`), owned-copy marker
    - `publish` states its consequence up front
    - Program source scan before run
- New build picked up on next visit, no force refresh
- `reboot` takes a waiting build

## v0.2.1

- `~/bin` function exports run as processes (argv, stdin, stdout)
- Web-terminal programs unaffected
- `count` example
- Registry
    - Target terminal shown (web/term/wasm)
    - Versioned install/browse (`@2`)
    - Registry slot deletion
    - wasm publish/install
    - Machine-only programs hidden from the web terminal
    - Fixed `publish` after reload
- Pages
    - `~/public_html` for supporters, `edit`/`cp`/`rm`/`cat` write through
    - `upload` to public_html
    - `pages`, `pages title`, `pages button`
    - `mv` refused
- Fixed chat log shift on image load
- Cold boot waits for a keypress
- Fixed per-character bleep/slowdown in user programs
- Fixed lingering draw after program exit
- `ctx.setBlipHz`
- Type bleeps on non-space only

## v0.3

- Boot
    - CYBER/OS nameplate: address, what to type, manual location
    - Logged-out prompt to `login`
    - `reboot` syncs first
    - No mouse pointer on the tube
- Programs
    - `~/bin/docs` manual: README, API, TUI, NETWORK
    - Examples moved beside the manual
    - `~/bin` on `PATH`
    - `import` for local `.js`/`.wasm`
    - `help` lists programs first
    - `edit` confirms before write
- LOADING state in `circ`/`cmail`
- Fixed empty `cmail` threads listed
- ⌘←/⌘→ line navigation
- `login` no longer reprints motd or nests a shell
- Fixed stale username after `logout`

## v0.4

- Editing
    - Shift+arrows select, Ctrl+Shift by word: shell, `circ`/`cmail` compose, `edit`
    - Copy, cut, paste: Cmd+C/X/V (macOS), Ctrl+Shift+C/X and Ctrl/Cmd+V (others)
    - Available to user programs using `ctx.tui.InputLine`
- Shell
    - Case-insensitive tab completion
    - `edit`: `^O` to save, Tab inserts a tab, framed like `circ`/`cmail`
    - `vim`, `vi`: Vim 9 on wasm, `~/.vimrc`
    - wasm programs: file access, keyboard wait with timeout, sleep
    - `reset`: wipe the machine (guest only)
    - `login` home at `/home/<user>`, own dotfiles and `~/bin`
    - `logout` to guest
    - Fixed `^C` in line-mode programs moving the prompt to the top
- Boot
    - motd paced by line
    - Keys discarded during boot
    - Fixed hang at boot without OPFS
    - No power-on flash on warm boot
- Login
    - LOGIN box
    - Dial-in on login (RINGING, CONNECT), NO CARRIER on `logout`
    - `~/public_html` only while a supporter is logged in
- Cursor blink held while typing
- Screensaver
    - `screensaver`: eight savers
    - Idle timeout in `F1`
- iPad
    - 80x25 layout
    - § and Cmd+. as Escape, Ctrl+Opt+1..9 as F1..F9
    - Fixed writes to `~` on Safari and iPad
    - Fixed paste and Option characters from external keyboards

## v0.5

- Sync
    - Home directory synced to Cloudflare R2, end-to-end encrypted
    - On login, every minute, on `logout`, `shutdown`, `reboot`
    - `sync`, `sync reset`
    - Conflicts kept as `name.1`
    - Edits win over deletes
    - `~/.sync` state file
    - Key wrapped under the login password
    - Supporters only: 5 MB total, 256 files, 1 MB per file
- `download <file>`
- Fixed `export` (bare `export`, `export NAME` before assignment)
- Deleted skel files stay deleted
- Fixed stale build after deploy
- Standby screen
- BIOS screen
- Globe on the motd
- Fixed pictures a third too narrow

## v0.5.1

- `globe`: wireframe Earth, user pins
- Feed
    - `feed`: full-screen reader
    - Arrows select, Enter opens post and replies
    - `R` Reply
    - `W` Compose (title, topics, blog/NSFW/vent)
    - `^S` save as note
    - `L` Copy link
    - `B` Author profile
    - `U` Author's posts
    - `feed @user`
    - `F` Find user
    - Session resume
    - Profile pictures
- Config: PHOSPHOR `custom` (hue, saturation, lightness)
- `edit`: opening screen paced by line
- User program API: image functions
- LOGIN box update
- `circ`, `cmail`: bold usernames
- `cmail`: deleted accounts hidden

## v0.5.2

- `globe`
    - Zoom easing
    - User card: `C` C-Mail, `F` Follow/Unfollow, `P` Poke
- `cmail @user`, `globe @user`
- User programs: `ctx.run(name, argv)` for `cmail`, `circ`, `feed`, `globe`, `finger`, `browse`

## v0.6

- Jobs
    - `^Z` to background
    - `fg`
    - `CMD-K` / `CTRL-K` switch programs
    - `ps`, `kill`
    - `exit` confirms with stopped jobs
- `~/public_html`: .woff, .woff2, .r, .py, .csv
- Fixed `sync`, `~/public_html` refused for subscribers
- Fixed login error for unverified e-mail
- Fixed C-Mail from `globe`

## v0.6.1

- `circ`
    - `^U` select user in online pane
    - `↵` Card, `C` C-Mail
- `feed`
    - `^S` post reply or entry, `^N` save note, both with confirm
    - Drafts kept across reload
    - Fixed `^D` quit and post keys

## v0.6.2

- `feed`: `^O` save note (was `^N`, browser clash)
- Shell: `Ctrl+Backspace`, `Alt+Backspace` delete word (`^W` closes the tab on Windows and Linux)
- Docs, `browse`, `publish`: three program kinds (JS, pty, wasm)
- Website terminal references removed

## v0.7

- Notifications
    - Top-row banner for 6 s on a new notification or C-Mail
    - `CMD-I` / `CTRL-I` to open, or `inbox` when clear
    - F1 `NOTIFICATIONS` on/off
- `inbox`
    - `←→` or `1`-`8` tab, `P` Preview, `U` Unread, `A` Mark all read
    - Honours notification settings, mutes, blocks
- `CMD-K` unread counts
- `You have C-Mail` in motd and on login
- `feed -p <post> [reply]`
- `feed @user`, `circ <room>` passed to a running instance
- Fixed paste on Windows and Linux

## v0.8

- Ported from the old /terminal
    - `wardial`
    - `sudo`
    - `tree`
    - `config` (the `F1` box)
    - `doom` (with sound!)
    - `fortune` (in the shell)
- `circ` and `cmail`
    - `/art` composer
- Truncate long tags in `feed`
- Updated docs
- User programs (legacy JS)
    - Most legacy user programs work again
    - Fixed `not a program` for long programs
    - Full `ctx.tui` widget kit
    - `localStorage` per program, in `~/.local/share/<name>.json`
    - `ctx.snd.degauss`, `postBeep`
- Mobile
    - Fixed layout
    - Extra keys: `ESC`, `TAB`, arrows, `^` control keys, `F1`, `COPY`, `PASTE`, process switcher
- `CMD-K` Process switcher
    - `login` when logged out, login-only programs dimmed
- `chmod`
    - Octal, symbolic, `-R`
    - Modes in `~` kept across reloads
- `launch`
    - Installed programs and `~/bin`, in a `CMD-K` style list
- `help`: select, copy, cut and paste keys for the host OS, printed a line at a time
- `$OSTYPE`
