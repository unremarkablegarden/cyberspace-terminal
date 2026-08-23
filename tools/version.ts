// The release, from the changelog, stamped into every package.json.
//
// CHANGELOG.md is the record: its last `## vX.Y` heading is what the machine
// is, and the same string reaches the motd, uname and the boot banner through
// app/src/changelog.ts. This keeps the manifests from drifting away from it.
//
//   bun tools/version.ts           stamp
//   bun tools/version.ts --check   fail if any manifest has drifted

import { readdir } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url).pathname

/** npm wants three components; the changelog is written with two. */
const semver = (v: string): string => {
  const parts = v.split('.')
  while (parts.length < 3) parts.push('0')
  return parts.join('.')
}

const manifests = async (): Promise<string[]> => {
  const out = ['package.json', 'app/package.json']
  for (const dir of ['packages', 'apps']) {
    for (const name of await readdir(ROOT + dir)) {
      const path = `${dir}/${name}/package.json`
      if (await Bun.file(ROOT + path).exists()) out.push(path)
    }
  }
  return out
}

const changelog = await Bun.file(ROOT + 'CHANGELOG.md').text()
const release = [...changelog.matchAll(/^## v(\S+)/gm)].at(-1)?.[1]
if (!release) {
  console.error('version: no `## vX.Y` heading in CHANGELOG.md')
  process.exit(1)
}

const want = semver(release)
const check = process.argv.includes('--check')
const drifted: string[] = []

for (const path of await manifests()) {
  const text = await Bun.file(ROOT + path).text()
  const has = text.match(/"version":\s*"([^"]*)"/)
  if (has?.[1] === want) continue
  drifted.push(`${path}: ${has?.[1] ?? 'none'} -> ${want}`)
  if (check) continue
  // Edited in place: rewriting the JSON would reformat manifests nobody asked
  // to touch.
  const next = has
    ? text.replace(/"version":\s*"[^"]*"/, `"version": "${want}"`)
    : text.replace(/("name":\s*"[^"]*",)/, `$1\n  "version": "${want}",`)
  await Bun.write(ROOT + path, next)
}

if (check && drifted.length) {
  console.error(`version: ${want} in CHANGELOG.md, but`)
  for (const line of drifted) console.error('  ' + line)
  console.error('run: bun tools/version.ts')
  process.exit(1)
}
if (!check) console.log(drifted.length ? `${want}: stamped ${drifted.length}` : `${want}: already current`)
