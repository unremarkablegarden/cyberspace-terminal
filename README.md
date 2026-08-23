# Cyberspace Terminal

A virtual computer in the browser. WebGL2 CRT display, unix-style shell,
persistent local filesystem, wasm programs. Part of
[Cyberspace](https://cyberspace.online). Runs at
[terminal.cyberspace.online](https://terminal.cyberspace.online).

No account required. Guest machines are fully local; `login` connects to the
Cyberspace API.

- Shell: pipelines, redirection, globs, `$?`, history, tab completion
- Filesystem: ZenFS on OPFS; the home directory persists in the browser
- Programs: JS modules, wasm32-wasi binaries and `#!` scripts run as
  processes. Each wasm program gets its own worker and reads the keyboard
  while it runs
- Editor: `edit` (nano key bindings), full-screen over ANSI
- Display: beam-intensity CRT simulation, phosphor and screen presets,
  BDF bitmap fonts, machine audio
- Network: `login`, `logout`, `whoami`, `finger`, `feed`
- Chat: `circ` (rooms), `cmail` (1:1) — sends through the API, live
  reads streamed from the realtime database
- Images: `view` halftones a photograph onto the cell grid; chat draws
  attachments inline
- Registry: `browse`, `install`, `publish`, `recall` — write a program here,
  publish it from the machine, run what others published
- Offline: installable PWA; the machine boots with no network

## Layout

| Path | Contents |
| --- | --- |
| `packages/crt` | CRT renderer, fonts, audio, effects, config UI |
| `packages/kernel` | VFS, processes, pipes, tty, WASI host |
| `packages/shell` | Shell and line editor |
| `packages/coreutils` | File, text and system tools; `edit` |
| `packages/tui` | Full-screen program toolkit, image rasterisers |
| `packages/compat` | Host for JS programs, this machine's and the original terminal's |
| `apps/cyberspace` | Network programs and API client |
| `app` | Site entry: boots the machine, drives the display |
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
