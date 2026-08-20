# Filesystem

ZenFS (`@zenfs/core` 2.x) under a thin kernel VFS layer. The kernel owns what
is not a file on disk: pipes, the tty, fds. ZenFS owns regular files.

## Mounts (browser host)

| Mount | Backend | Persistence |
| --- | --- | --- |
| `/` | InMemory | per boot |
| `/bin` | InMemory | reseeded from the program registry each boot |
| `/tmp` | InMemory | per boot |
| `/home` | WebAccess (OPFS) | survives reloads, per browser |

Mount config is passed in by the host (`app/src/main.ts`); the kernel never
imports `@zenfs/dom`. A server host would pass different backends.

## Sync semantics over OPFS (measured, ZenFS core 2.6.3 / dom 1.2.10)

WebAccess is an async backend behind ZenFS's async mixin, which keeps an
in-memory sync mirror:

- `readFileSync` on `/home`: works, served from the mirror.
- `writeFileSync` on `/home`: returns immediately; the flush to real OPFS is
  asynchronous. Verified durable within ~1.5s (visible via raw OPFS handles),
  but an immediate async read-back can race and see stale content.

Consequence for the WASI runner: sync reads are safe; after a program that
wrote files exits, wait for quiescence before anything that depends on
durability (e.g. page unload). If strict sync durability is ever needed,
replace the hot path with a dedicated OPFS sync-access-handle store.
