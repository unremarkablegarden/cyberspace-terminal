# Cyberspace Terminal

A virtual computer behind a CRT. Boots in the browser, runs a unix-shaped
shell over a local filesystem, and speaks plain ANSI over a pty — the tube is
one faceplate for it, a real terminal is another.

Part of [Cyberspace](https://cyberspace.online). Works without an account;
signing in connects the machine to the network.

## Status

Early, but the machine boots: a shell with pipelines, redirects, globs,
history and tab completion over a persistent local filesystem (OPFS). No
account needed; nothing leaves the browser.

## Layout

| Path | What |
| --- | --- |
| `packages/crt` | The tube: WebGL2 CRT, beam-intensity rasteriser, BDF fonts |
| `packages/kernel` | VFS (ZenFS), processes, pipes, tty |
| `packages/shell` | POSIX-subset shell and line editor |
| `packages/coreutils` | ls, cat, grep and friends |
| `app` | The site: boots the machine, mounts the CRT |
| `spikes` | Throwaway feasibility probes |
| `docs/design` | Engineering notes |

Planned: `packages/tui`, a wasm (WASI) program runner, `apps/`.

## Development

```sh
bun install
cd app
bunx vite
```

Requires a browser with WebGL2.
