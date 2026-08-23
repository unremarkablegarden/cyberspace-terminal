# Filesystem

ZenFS (`@zenfs/core` 2.x) under a thin kernel VFS layer. The kernel owns what
is not a file on disk: pipes, the tty, fds. ZenFS owns regular files.

## Mounts (browser host)

| Mount | Backend | Persistence |
| --- | --- | --- |
| `/` | InMemory | per boot |
| `/bin` | InMemory | reseeded from the program registry each boot |
| `/tmp` | InMemory | per boot |
| `/home` | WebAccess (OPFS), wrapped | survives reloads, per browser |

Mount config is passed in by the host (`app/src/main.ts`); the kernel never
imports `@zenfs/dom`. A server host would pass different backends.

## Inode numbers on the OPFS mount

`WebAccess` is not mounted directly. `app/src/opfs.ts` wraps it in a backend
that assigns inode numbers after `create`.

`WebAccessFS._loadMetadata` builds its index from the OPFS handles with
`new Inode({ mode, size, mtimeMs })` and never sets `ino`, so every entry on the
mount is inode 0. Core keys its vnode cache by inode number (zen-fs/core #287,
which made open handles share metadata through a cache keyed by fs uuid + ino).
With every ino equal, two overlapping opens resolve to one vnode: the second
`VCache.ref` finds the first file's vnode still live and dirty, so it does not
refresh the inode, and the reader gets the first file's path and length.

Sequential reads are unaffected — the vnode is synced and evicted on close. It
takes concurrency, and the shell supplies it: `packages/shell/src/index.ts`
writes `~/.sh_history` without awaiting before running each command, so any
command that reads a file in `$HOME` opens inside that window. The observed
result was `cat README.txt` printing nothing, and reads returning another
file's bytes zero-padded to the wrong length.

Entries created during a session get an ino from `IndexFS.create`, so this only
affects entries loaded at mount — i.e. after a reload.

Unfixed upstream as of `@zenfs/dom` 1.2.11. Drop `app/src/opfs.ts` and mount
`WebAccess` directly once `_loadMetadata` assigns inodes.

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
