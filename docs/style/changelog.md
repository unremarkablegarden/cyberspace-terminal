# Changelog, version, README

## CHANGELOG.md

- `## vX.Y` headings, oldest first.
- One line per change an operator can see. Internal changes are left out.
- Grouped under an area (TUI, Display, Chat, Programs…) only when an area has several lines.
- No prose, no Added/Changed/Fixed headings.
- Noun phrases, not sentences. Programs do not ask, land, hand or reach; keys read `^O` to save or `R` Reply.
- Leave out what an operator would assume (an empty buffer, a default).
- No semicolons. Split into two lines or use a comma.
- Fixes read `Fixed X`, with the cause in a parenthesis at most.
- Unreleased work goes under the current heading. A new heading is a release decision, not part of a change.
- The line is added when the change lands.

## Version

The last `## vX.Y` heading is the release. `app/src/changelog.ts` bundles the file and exports `VERSION`, which reaches the motd, `uname -a`, the boot banner and the compat context. `bun tools/version.ts` stamps it into every package.json; the app build runs `--check` and fails on drift.
