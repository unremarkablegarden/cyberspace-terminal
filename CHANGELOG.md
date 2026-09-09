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
- Source split into modules; home seeded from `skel/home`
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
- New build picked up on next visit, no force refresh; `reboot` takes a waiting build

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
- `ctx.setBlipHz`; type bleeps on non-space only

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
    - Select text with Shift+arrows (Ctrl+Shift for words) on the command line, in `circ`/`cmail` compose, and in `edit`
    - Copy, cut, paste the selection: Cmd+C/X/V on macOS, Ctrl+Shift+C/X and Ctrl/Cmd+V elsewhere
    - User programs get the same in any field built on `ctx.tui.InputLine`
- Shell
    - Tab completion is case-insensitive
    - `edit` with no file opens an empty buffer; `^O` asks for the name
    - `edit` inserts a tab on Tab, and is framed like `circ` and `cmail`
    - `vim` (and `vi`): Vim 9 on wasm; `:w` writes to the machine, `~/.vimrc` honoured
    - wasm programs get file access, keyboard wait with timeout, and non-spinning sleep
    - `reset` (guest only, unlisted) wipes the machine on this browser after a y/N prompt
    - `login` lands in `/home/<user>` with its own dotfiles and `~/bin`; `logout` returns to guest
    - Fixed `^C` in a line-mode program sending the prompt to the top of the screen
- Boot
    - The motd arrives a line at a time; program output still arrives by the character
    - Keys typed during the boot are discarded
    - Fixed a silent hang at boot with no OPFS
    - A warm boot no longer plays the power-on flash
- Login
    - `login` opens a LOGIN box
    - Dials in once the password is accepted (RINGING, CONNECT, node banner); `logout` hangs up (NO CARRIER)
    - `~/public_html` appears only while a supporter is logged in
- Display: the cursor stops blinking while keys are pressed
- Screensaver
    - `screensaver`: eight savers, Space/Enter/Escape to preview, pick, quit
    - The idle saver comes up after the `F1` timeout
- iPad
    - Runs the 80x25 layout
    - § and Cmd+. act as Escape, Ctrl+Opt+1..9 as F1..F9
    - Fixed `cat`, `less` and every write to `~` failing on Safari and iPad
    - Fixed paste and Option-layer characters from an external keyboard

## v0.5

- Sync 
    - Home directory syncs to Cloudflare R2
    - End-to-end encrypted
    - Automatic after login, every minute, and on `logout`, `shutdown`, `reboot`
    - `sync`: run now, list what moved
    - `sync reset`: discard the server copy
    - Conflicts keep both files, the remote one as `name.1`
    - Edits win over deletes
    - `~/.sync`: last agreed state, plain text
    - Key wrapped under the login password; `Previous password:` prompt after a password change
    - _Limited to Cyberspace supporters_
        - Total 5 Mb
        - Max 256 files
        - Max 1 Mb file size
- `download <file>` saves a file from the machine to this computer
- Fixed `export` (bare `export` lists the environment; `export NAME` before the assignment now reaches programs)
- Deleted skel files stay deleted
- Fixed a visit after a deploy booting the previous build until a hard refresh
- New standby screen
- New BIOS screen
- A globe beside the nameplate on the motd
- Fixed pictures rendering about a third too narrow (the face stretches the raster; chat, `view` and braille drawings all corrected)

## v0.5.1

- `globe`: Wireframe Earth with member pins
- Feed
    - `feed`: full-screen feed reader
    - Records listed in boxes; arrow keys select, Enter opens a post with its replies
    - `R`: reply
    - `W`: compose a post (title, topics, blog/NSFW/vent flags); `^S` saves it as a note
    - `L`: copy a link from the post
    - `B`: author profile
    - `U`: author's posts; `feed @user` opens them directly
    - `F`: find a member
    - State management
    - Profile pictures in the user card and bio
- Config: PHOSPHOR `custom`, own hue/saturation/lightness
- `edit`: opening screen revealed a line at a time
- Added missing user program API image functions
- Login box update
- `circ`, `cmail`: bold usernames in the log and mailbox
- `cmail`: conversations with deleted accounts are hidden

## v0.5.2

- `globe`
    - User card actions
        - `C` opens C-Mail with the user
        - `F` follow or unfollow
        - `P` poke
- `globe`: zoom eases between steps
- `cmail @user`, `globe @user` opens that user
- User programs
    - `ctx.run(name, argv)` hands the terminal to `cmail`, `circ`, `feed`, `globe`, `finger` or `browse`

## v0.6

- Jobs
    - `^Z` backgrounds program and returns to the prompt
    - `fg` brings it back
    - `CMD-K` / `CTRL-K` switches between running programs
    - `ps`, `kill`
    - `exit` with stopped jobs asks twice
- Fixed subscribers being refused `sync`, `~/public_html`
- Fixed the login error for an unverified e-mail address
- Fixed C-Mail from Globe