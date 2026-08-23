# Comments

Run `bun tools/comments.ts` to check the tree. The build runs
`--check` and fails on an error.

## The rules

**1. Why over what.** A comment earns its place by explaining why something is
done at all, why it is done this way rather than the obvious way, why it works
when it looks wrong, or what external constraint forces it. If the adjacent code
already says it, delete the comment.

**2. Fact first, reason second.** Lead with the mechanical claim in plain
declarative prose, then the reason for it.

**3. Use the standard name.** Where a mechanism has one, use it: token bucket,
rate limit, debounce, backpressure, invariant, alt screen, raster. Invented
imagery is not searchable — someone grepping for `render` will not find "the
glass".

**4. Make claims checkable.** Include units, thresholds and boundary behaviour:
bytes or characters, milliseconds, inclusive or exclusive. A comment that cannot
be checked against the code cannot be found wrong, so it goes stale silently.

Checkable: `Echo bypasses the rate limiter but queues behind pending output to
preserve ordering.`
Not checkable: `Echo does not belong to either.`

**5. Prefer a test to an assertion.** If a comment says "this guarantees X", a
test named for X is the stronger form.

**6. Prose defers to code.** Where a comment's numbers disagree with the code,
fix the comment. Never adjust the code to match the comment.

**7. Explain the decisions that have no comment.** Deliberate-looking behaviour
with no explanation — a cap, a reset, an early return, a fallback — gets one to
three plain lines. This is usually where the value is.

**8. Length.** Inline comments run one to three lines. A file or class header
may run to a short paragraph, and longer where it documents an external
constraint. Anything longer belongs in `docs/design/`, referenced by path.

**9. Register.** Every comment must survive a reader who is tired, unfamiliar
with the file, debugging at 2 a.m. eighteen months from now, and has no memory
of any metaphor.

**10. Not allowed.** Contrastive binaries ("not just X, but Y"), closing
aphorisms, ALL-CAPS emphasis, first person, notes addressed to a reader ("as
requested"), emoji, markdown, and filler certainty (`obviously`, `clearly`,
`simply`, `honest`).

Period vocabulary such as "the tube" and `NO CARRIER` belongs in machine copy —
the strings the terminal prints. These rules govern comments only.

## Before and after

```ts
// Before
// drain() reports only what the MACHINE said — never the echo of a keystroke,
// never a painted frame. That number is what the host bleeps on, and the split
// is the whole rule: a key you press makes a key sound, text the machine sends
// makes a bleep, and nothing makes both.

// After
// Echo and full-screen repaints bypass the limiter. Only rate-limited output is
// counted by drain(); the host uses that count to time the output bleep.
```

| Before | After |
| --- | --- |
| `Bytes owed. Fractional and signed, so a rate below one byte a frame — and a whole line that overspends — still come out at the right pace.` | `Unspent byte budget. Fractional and signed so sub-byte-per-frame rates and over-long lines still average out to cps.` |
| `A second's worth is as far behind as it is worth catching up from.` | `Burst cap: one second of credit, so a tab that stalls does not dump the whole backlog on resume.` |
| `A write this big is not somebody talking — it is a program painting.` | `Writes at least this large are treated as a screen repaint, not program output.` |

Naming the algorithm does most of the work. `baud.ts` is a token bucket, and
saying so makes `credit`, the cap and the reset self-explanatory.

## The checker

| Mode | Command |
| --- | --- |
| Whole tree | `bun tools/comments.ts` |
| Named files | `bun tools/comments.ts app/src/baud.ts` |
| Build gate | `bun tools/comments.ts --check` (errors only) |
| Fail on warnings | `bun tools/comments.ts --strict` |
| Machine output | `bun tools/comments.ts --json` |
| Editor hook | `bun tools/comments.ts --hook` (payload on stdin) |

Errors: `banned-word`, `emoji`, `caps-emphasis`, `chat-leakage`, `markdown`.

Warnings: `certitude-filler`, `contrastive-binary`, `em-dash-density`,
`aphoristic-ender`, `second-person`, `redundant-what`, `atmospheric`, `length`.
`stale-number` is implemented but off by default: in this codebase almost every
hit is a domain constant rather than a stale reference.

Override it where it is wrong. On the comment block, or the line above it:

```ts
// lint-comment: disable caps-emphasis
```

and for a whole file, anywhere in it:

```ts
/* lint-comment: disable-file atmospheric */
```

Severities and word lists can be overridden in `tools/comments.config.json`.

The checker matches vocabulary and shape, not meaning. It cannot tell a good
short comment from a useless one, and prose that says nothing will pass every
rule. It is a tripwire for the failure modes that are mechanically visible.
