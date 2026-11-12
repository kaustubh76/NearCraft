// Recomputes every baseline hash in backend/baseline/MANIFEST.json and fails on drift.
// Baseline files are vendored unchanged; if one differs, either it was edited (and is no
// longer baseline) or the manifest is stale. Both are reportable, neither is silent.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

const root = new URL('../backend/baseline/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('MANIFEST.json', root), 'utf8'))
const problems = []

// An empty manifest used to pass: there would be nothing to iterate, no
// problems, and a cheerful "baseline verified: 0 files unchanged".
//
// This manifest IS the eligibility disclosure under hackathon rule Q-005 — the
// one artifact whose entire purpose is to be checkable instead of promised — so
// a vacuous pass here is worse than anywhere else in the repo.
const recorded = Object.keys(manifest.files ?? {})
if (recorded.length === 0) {
  console.error('\nFAIL: MANIFEST.json records no files, so there is nothing to verify.')
  console.error('      The baseline disclosure cannot be checked by checking nothing.\n')
  process.exit(1)
}

for (const [name, want] of Object.entries(manifest.files)) {
  let bytes
  try { bytes = await readFile(new URL(name, root)) }
  catch { problems.push(`${name}: missing`); continue }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const lines = bytes.toString('utf8').split('\n').length - 1
  if (sha256 !== want.sha256) problems.push(`${name}: sha256 ${sha256} != ${want.sha256}`)
  else if (lines !== want.lines) problems.push(`${name}: ${lines} lines != ${want.lines}`)
  else console.log(`ok   ${name}  ${want.lines} lines  ${sha256.slice(0, 12)}…`)
}

// The other direction, which was never checked: a file sitting in
// backend/baseline/ that the manifest does not record. Iterating the manifest
// alone can only ever catch a recorded file that changed — never an unrecorded
// one that appeared. The records and the reality have to agree both ways, which
// is the same lesson as the orphan access keys in A7.
async function present(dir = root, prefix = '') {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await present(new URL(`${entry.name}/`, dir), rel)))
    else if (rel !== 'MANIFEST.json') found.push(rel)
  }
  return found
}

const onDisk = await present()
const known = new Set(recorded)
for (const file of onDisk) {
  if (!known.has(file)) {
    problems.push(`${file}: present in backend/baseline/ but NOT recorded in MANIFEST.json`)
  }
}

if (problems.length) {
  console.error(`\nbaseline drift (${problems.length}):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(
  `\nbaseline verified: ${recorded.length} files unchanged, ` +
  `and no unrecorded file in backend/baseline/`,
)
