# Cyberspace Terminal

A virtual computer in the browser. WebGL2 CRT display, unix-style shell,
persistent local filesystem, wasm programs. Part of
[Cyberspace](https://cyberspace.online). Runs at
[terminal.cyberspace.online](https://terminal.cyberspace.online).

No account required. Guest machines are fully local. `login` connects to the
Cyberspace API.

- Shell: pipelines, redirection, globs, `$?`, history, tab completion,
  job control (`^Z`, `fg`, `ps`, `kill`; `CMD-K`/`CTRL-K` switches programs)
- Filesystem: ZenFS on OPFS; the home directory persists in the browser, and
  follows a supporter between devices, stored encrypted in R2 storage (`sync`)
- Programs: JS modules, wasm32-wasi binaries and `#!` scripts run as
  processes. Each wasm program gets its own worker, reads the keyboard while
  it runs and works on the files named on its command line; `import` brings
  one built elsewhere into `~/bin`
- Editors: `vim` (Vim 9, compiled to wasm) and `edit` (nano key bindings),
  full-screen over ANSI
- Display: beam-intensity CRT simulation, phosphor and screen presets,
  BDF bitmap fonts, machine audio
- Network: `login`, `logout`, `whoami`, `finger`, `feed`
- Chat: `circ`, `cmail` — sends through the API, live
  reads streamed from the Firebase RTDB
- Notifications: `inbox`; global notifications bar
- Images: `view` halftones a photograph onto the cell grid; chat and feed draw
  attachments inline
- Registry: `browse`, `install`, `publish`, `recall` — write a program here,
  publish it from the machine, run what others published
- Pages: `~/public_html` is a homepage at [pages.cyberspace.online](https://pages.cyberspace.online) — `edit`
  it, `upload` to it, `pages` for the URL (supporters)
- Offline: installable PWA; the machine boots with no network
- Android: fullscreen app, can be set as the home screen for a cyberdeck. APK from [Releases](https://github.com/unremarkablegarden/cyberspace-terminal/releases/latest)

## Android

The APK is not on Google Play. It is signed with the project's own key and installed by hand (sideloaded).

1. Download `cyberspace-terminal.apk` from [Releases](https://github.com/unremarkablegarden/cyberspace-terminal/releases/latest) on the device.
2. Open it. Android asks to allow installs from this source (the browser or file manager); allow it once.
3. Install, then open Terminal.

Requires Android 7 or later with Chrome installed; the app runs in Chrome without its address bar. Updates to the site reach the app without a new APK.

To boot a deck straight into the terminal: Settings > Apps > Default apps > Home app > Terminal.

## Layout

| Path | Contents |
| --- | --- |
| `packages/crt` | CRT renderer, fonts, audio, effects, config UI |
| `packages/kernel` | VFS, processes, pipes, tty, WASI host |
| `packages/shell` | Shell and line editor |
| `packages/coreutils` | File, text and system tools; `edit` |
| `packages/tui` | Full-screen program toolkit, image rasterisers |
| `packages/compat` | Host for JS user programs |
| `apps/cyberspace` | Network programs and API client |
| `app` | Site entry: boots the machine, drives the display |
| `android` | Android app (Trusted Web Activity); build and release in its README |
| `tools` | Repo tooling, sources for bundled wasm programs |
| `spikes` | Feasibility probes |
| `docs` | Engineering notes, style guides |

## Development

```sh
bun install
cd app
bunx vite
```

Requires WebGL2.

## License

MIT.
