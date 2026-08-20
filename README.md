# Cyberspace Terminal

A virtual computer in the browser. WebGL2 CRT display, unix-style shell,
persistent local filesystem, wasm programs. Part of
[Cyberspace](https://cyberspace.online). Runs at
[terminal.cyberspace.online](https://terminal.cyberspace.online).

No account required. Guest machines are fully local; `login` connects to the
Cyberspace API.

- Shell: pipelines, redirection, globs, `$?`, history, tab completion
- Filesystem: ZenFS on OPFS; the home directory persists in the browser
- Programs: wasm32-wasi binaries and `#!` scripts run as processes
- Editor: `edit` (nano key bindings), full-screen over ANSI
- Display: beam-intensity CRT simulation, phosphor and screen presets,
  BDF bitmap fonts, machine audio
- Network: `login`, `logout`, `whoami`, `finger`, `feed`

## Layout

| Path | Contents |
| --- | --- |
| `packages/crt` | CRT renderer, fonts, audio, effects, config UI |
| `packages/kernel` | VFS, processes, pipes, tty, WASI host |
| `packages/shell` | Shell and line editor |
| `packages/coreutils` | File, text and system tools; `edit` |
| `packages/tui` | Full-screen program toolkit |
| `apps/cyberspace` | Network programs and API client |
| `app` | Site entry: boots the machine, drives the display |
| `tools` | Sources for bundled wasm programs |
| `spikes` | Feasibility probes |
| `docs/design` | Engineering notes |

## Development

```sh
bun install
cd app
bunx vite
```

Requires WebGL2.

## License

MIT.
