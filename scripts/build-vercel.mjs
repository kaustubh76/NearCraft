// Stage exactly the files the market page needs, and nothing else, for a static
// host.
//
// WHY A STAGING DIRECTORY AND NOT AN IGNORE FILE.
//
// `.local/` holds the deploying account's private key and the three CONTRACT
// account keys. An ignore file is a deny list: it is correct only as long as
// nobody adds a path to the repository that it does not mention, and a mistake
// there is not a build failure, it is a published key. So this script does the
// opposite — it copies an ALLOWLIST into an empty directory and the host
// uploads that. Anything not named here is not merely ignored; it is not on
// disk at upload time, so there is no rule for anyone to get wrong later.
//
// The allowlist is not written twice. It is imported from scripts/serve-web.mjs,
// which is the same table `npm run web` serves and which tests/near/web.mjs
// already asserts cannot be talked out of the repository root. One table, so the
// hosted tree cannot drift from the audited one.
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVABLE } from './serve-web.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, '.tmp', 'vercel')

/// Paths that must never appear in the staged tree. Not the mechanism that
/// keeps them out — the allowlist above is — but a second, independent reading
/// of the result, because the whole point of this file is that one mistake here
/// publishes a key. A belt is not an argument against a brace.
const FORBIDDEN = [/(^|\/)\.local(\/|$)/, /(^|\/)\.env/, /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/, /\.pem$/, /\.key$/, /(^|\/)package(-lock)?\.json$/,
  /(^|\/)\.near-credentials(\/|$)/, /(^|\/)neardev(\/|$)/]

/// `vercel link` writes .vercel/project.json into the deploy directory, and the
/// stage is wiped on every run. Keep it across runs so the project identity is
/// not re-created (and a second project not silently made) on each deploy.
const KEEP = ['.vercel']

async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, base))
    else out.push(relative(base, full))
  }
  return out
}

const kept = []
for (const name of KEEP) {
  const path = join(OUT, name)
  if (await stat(path).then(() => true, () => false)) {
    const tmp = join(ROOT, '.tmp', `.keep-${name}`)
    await rm(tmp, { recursive: true, force: true })
    await cp(path, tmp, { recursive: true })
    kept.push([tmp, path])
  }
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

for (const entry of SERVABLE) {
  const from = join(ROOT, entry)
  const to = join(OUT, entry)
  if (!await stat(from).then(() => true, () => false)) {
    console.error(`  ${entry} is in the allowlist but not in the repository.`)
    process.exit(1)
  }
  await cp(from, to, { recursive: true })
}

// The host's own config travels with the tree it configures.
await cp(join(ROOT, 'vercel.json'), join(OUT, 'vercel.json'))

for (const [tmp, path] of kept) {
  await cp(tmp, path, { recursive: true })
  await rm(tmp, { recursive: true, force: true })
}

const staged = (await walk(OUT)).filter((p) => !KEEP.some((k) => p.startsWith(k + '/')))
const leaked = staged.filter((p) => FORBIDDEN.some((re) => re.test(p)))

if (leaked.length > 0) {
  console.error('\n  REFUSING TO STAGE. These files are not publishable:\n')
  for (const p of leaked) console.error(`    ${p}`)
  console.error('')
  process.exit(1)
}

console.log(`\n  staged ${staged.length} file(s) in .tmp/vercel from ${SERVABLE.length} allowlisted path(s):`)
for (const entry of SERVABLE) {
  const n = staged.filter((p) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry)).length
  console.log(`    ${entry.padEnd(18)} ${n} file(s)`)
}
console.log(`\n  nothing matching ${FORBIDDEN.length} forbidden pattern(s) is present.\n`)
