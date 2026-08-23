# The program registry

Where a published program lives, what the record says, and why two machines
share one library.

## Two stores, one record

| | Holds | Why there |
| --- | --- | --- |
| Firestore `terminal_programs` | the index | R2 cannot answer "published programs by author, newest first" |
| R2 (public bucket) | the bytes | a Firestore document is capped at 1 MiB including overhead; the staff tier is 10 MB |

```
programs/{ownerId}/{programId}/v<n>.js     one per publish, immutable
programs/{ownerId}/{programId}/v<n>.wasm   the same, for a binary
programs/{ownerId}/{programId}/draft-<rand>.js
```

The draft key carries a random segment because the bucket is public, so the key
is what keeps an unpublished program unread.

Writes go through `cyberspace-api`, `src/routes/v1/programs.ts`, which holds the
R2 credentials and sets identity, version and moderation flags server-side. This
machine never writes either store directly; see `apps/cyberspace/src/programs-store.ts`
for every call it makes.

## Two machines, one library

The website's `/terminal` and this machine publish to the same collection. That
is deliberate: one moderation path, one tier quota, one gallery, and every
program written for the old machine is installable here through the compat host
(`packages/compat/src/host.ts`).

They do not run the same program format, so the record says which:

| `runtime` | Shape | Runs on |
| --- | --- | --- |
| `web` | `export default { name, description, run(ctx, args) }` | both machines |
| `term` | `export default async (p) => number` | this machine |
| `wasm` | a wasm32-wasi binary, stdio only | this machine |

The value names the terminal a program is written for, not the mechanism it
uses: a `web` program draws on a cell grid through the compat host here, which
is how one program serves both.

**Absent means `web`.** Every document written before the field existed came
from the website, which publishes nothing else — the same reading `dir` and
`exec` already take on this collection, and it is why no backfill was needed.

Only the API writes the field. The website reads it and filters its own two
listings (`useTerminalPrograms.browse` and `.list`), so absent-means-web holds
by construction rather than by discipline.

Each surface asks for what it can host: this machine sends
`?runtime=web,term,wasm`, the website keeps `web`. A filtered page can come
back short or empty and still carry a cursor, so a client follows the cursor
until it is null rather than stopping at the first short page.

## What decides a program's kind

Two different answers, for two different questions.

**Publishing** must not run the file, so `packages/compat/src/classify.ts`
parses it and reads the default export: an object is `web`, a function is
`term`, a `\0asm` header is `wasm`. Acorn rather than a regex, because the two JS
shapes differ by one token and a formatted object literal defeats the regex.

It also answers whether the file is a program at all, and that answer is what
`publish` lists `~/bin` by. **Not the execute bit**: OPFS stores no permissions,
so `@zenfs/dom` rebuilds the whole index at `0o644` on every reload
(`access.js:58`) and a mode set here survives one session at most. `install`
still writes `0o755`, which is right in the session and right on any backend
that keeps it, but nothing may depend on reading it back.

**Running** does not need the field at all. `jsFileHandler` imports the module
and branches on what the default export turns out to be, so a mis-tagged program
still runs correctly here. The tag governs listing.

A description is read the same way, without running the file: a `web` program
carries `description:` in its object literal, a `term` program exports
`description` beside its function, and a `wasm` program has nowhere to put one,
so `publish` asks for it.

The kind is fixed at the first release. Republishing a name under a different
kind is refused by the API: everyone who installed it installed the old one.

## The guard

Both JS kinds are imported as real ES modules into the page, with the reader's
session behind them, so `packages/compat/src/guard.ts` applies to both — at
install and again at run. A `wasm` program is not inspected and needs no
inspection: the WASI runner gives it stdio and nothing else, and there is no JS
in it to parse.

## Versions

The registry assigns them, one integer per publish, and program source carries
no version field. Release objects are immutable, so `install author/name@2`
fetches exactly what went out under that number; `GET /:id/source?release=n`
reads the key off the `releases/{n}` subdocument.

Republishing unchanged source is a no-op, or restores a recalled program at its
own version — the API compares hashes over bytes.

## Recall, takedown, delete

- **Recall** hides a program. The author's, reversible, and the record and its
  history stay. Copies already installed are unaffected.
- **Takedown** is a moderator's. The record freezes: not publishable, not
  restorable, not deletable, until reinstated.
- **Delete** (`DELETE /:id?purge=1`) removes the record, releases and all. It is
  what frees the slot the program holds against the member's tier limit, which
  matters because a program written for this machine still counts against a
  quota the website will not show them. The R2 objects are left behind, as the
  website's own `rm` leaves them.
