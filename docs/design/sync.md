# Home sync

How a supporter's home directory follows them between devices, and why the server never gets to read it.

## Local first

The home on this machine is the truth. It lives on OPFS in this browser, works offline exactly as before, and the sync is a reconciliation that runs in the background and can be run by name with `sync`. Nothing waits on the network: a machine with no carrier keeps working, and the next run catches up.

Everything under the home syncs except what the machine owns or what cannot travel safely: `~/public_html` (its own transport), `~/bin/docs` and `~/bin/examples` (rewritten from the bundle each boot), `~/.sync` (the sync's own state), `~/.sh_history` (the running shell appends to it without waiting, so a pull could not replace it) and `*.tmp`.

A path is 1–8 segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`, at most 200 characters, case kept. There is no extension rule: dotfiles are the point, and a program in `~/bin` has no extension. A file the rule refuses is reported as `skipped` and left where it is. 5 MiB and 256 files per home, 1 MiB per file.

## Three states

Every run compares three things per path:

| | Holds | Where |
| --- | --- | --- |
| local | the sha256 of the file now | hashed on every run |
| base | what this device last agreed with the server | `~/.sync` |
| remote | what the server holds | the manifest, decrypted here |

Every file is hashed on every run rather than trusting a modification time: OPFS does not keep one across reloads, and at 5 MiB the hashing is not worth avoiding.

### The merge

`∅` absent, `T(h)` a tombstone carrying the hash of what was deleted, letters are hashes.

| local | base | remote | action |
| --- | --- | --- | --- |
| a | a | a | nothing |
| b | a | a | push b |
| a | a | b | pull b |
| b | a | b | agree, advance base |
| b | a | c | conflict: keep b, write c beside it, push b |
| a | ∅ | ∅ | push |
| ∅ | ∅ | a | pull |
| a | ∅ | a | advance base |
| a | ∅ | b | conflict |
| ∅ | a | a | deleted here, push a tombstone |
| a | a | T or ∅ | deleted there, delete here |
| ∅ | a | T or ∅ | advance base |
| ∅ | a | b | deleted here, edited there: pull, `restored` |
| b | a | T or ∅ | edited here, deleted there: push, `restored` |
| a | ∅ | T(a) | a byte-identical revival: delete here |
| a | ∅ | T(h≠a) | a new file under a dead name: push |
| ∅ | ∅ | T | nothing |

An edit beats a delete in both directions. A file changed on two devices is never overwritten: the local copy stays, the remote copy lands beside it as `<name>.1` (first free number), and the report says so. Conflict copies are ordinary files and sync like any other, so the other device sees both; the operator resolves with `mv` and `rm`.

The tombstone hash decides the two revival rows. A fresh device installs the skeleton home before anyone logs in, so a deleted `README.txt` would otherwise come back and push itself to every other device. Because the tombstone remembers what was deleted, the reinstalled copy is recognised and removed on the first run; from then on `~/.sync` lists the path and the skeleton installer skips it. A skel file that was edited before it was deleted has a different hash and is revived once on a fresh device; accepted.

### A run

Three phases in a fixed order:

1. Remote to local: pulls, conflict copies, local deletes.
2. Local to remote: upload each changed file, then one commit that replaces the whole manifest at the revision that was read. A commit that loses to another device's commit re-runs the whole pass, three attempts.
3. `~/.sync` written once.

Remote-to-local goes first so a conflict copy is on disk before the commit replaces the remote version. Every interrupted state lands on a row of the table that resolves with no traffic: pulled but base not advanced is `b a b`, committed but `.sync` unwritten is `b a b`, deleted locally but base not moved is `∅ a T`. A path that did not land (a directory in the way, a refused name, a file over the cap) is kept out of base so the next run tries it again rather than reading its absence as a deletion.

### `~/.sync`

```
rev 42
3b1f…  .profile
a90c…  bin/starfield
deleted 9e02…  README.txt
```

Plain text, so `cat ~/.sync` is readable. The `rev` line is for the reader; the commit names the revision it fetched.

## Encryption

Bytes and file names are encrypted on the device. What leaves it is ciphertext, ciphertext sizes and a revision counter. The server can count files and add up sizes; it cannot read a path or a byte of content.

- **Master key.** 32 random bytes, AES-256-GCM, one per account, generated on the device the first time a supporter logs in and no key exists yet.
- **Wrap.** The master key is stored on the server wrapped under a key derived from the login password: PBKDF2-SHA256, 600 000 iterations, a 16-byte salt. The wrap and the salt are the only key material the server ever holds. No second password: `login` has the typed password for the moment it takes to unwrap.
- **Files.** Each file is `iv || AES-GCM(key, plaintext)` with a fresh 12-byte IV, and is addressed by the sha256 of that ciphertext.
- **Manifest entries.** Each entry is an encrypted record of the path and the plaintext hash (and, for a tombstone, when it died) beside the few fields the server needs: which blob, its size, whether the entry is a tombstone.
- **On the device.** The unwrapped key is kept beside the refresh token, the same trust boundary the session already has. A boot resume and the background runs use it and never need the password. `logout` and `reset` clear it.
- **Password change.** At the next login the old wrap no longer opens. A device that still holds the key rewraps it under the new password and carries on. A device that does not asks `Previous password:` once; empty Enter skips and the home stays local. Nothing is re-encrypted; only the wrap changes.
- **Password reset with no device holding the key.** The home is unrecoverable from the server. Any still-logged-in device repairs the wrap at its next login. This is the price of the server not being able to read the home, and it is stated here rather than softened.
- **Locked.** A device with no key in hand (a resume whose cache was cleared), or a server with data but no wrap for it, runs no automatic sync; `sync` says `home locked; login again`. Login puts both right, and a key made at login is kept only once its wrap has landed on the server, so nothing is ever pushed under a key no other device could unwrap.
- **Unreadable.** If the key the wrap holds does not open the manifest, nothing anywhere can read those entries. `sync` says so and stops; `sync reset` asks once, replaces the server copy with nothing and pushes the local home whole. Local files are never touched by a reset, on any device: a manifest with no entries at all is read as a fresh start, never as every file deleted (a real deletion leaves a tombstone).

One caveat, stated plainly. The terminal logs in through the site's API, so the password crosses that server on every login. Stored data is unreadable there, but an operator who logged passwords could derive the key. Signing in against the identity provider directly and sending the API only the resulting token would close this; it is a separate change to the login path and has not been made.

## When it runs

After login and after a boot resume, once the home is set up. Every minute while the tab is visible, quietly. Before `logout`, `shutdown` and `reboot`, bounded so a dead network cannot hold up the exit. And by name: `sync` prints one line per file moved and a summary, or `Up to date.` `sync reset` is the only destructive form, and it asks.

## Known limits

- A pull that lands under a file open in `edit` is overwritten when the editor saves, and that save pushes as an ordinary edit. The same as any editor without external-change detection.
- Empty directories do not sync; a directory exists on the other device once a file in it does.
- File modes do not sync. OPFS does not keep them and nothing on the machine checks an exec bit.
