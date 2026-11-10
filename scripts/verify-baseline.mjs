// Recomputes every baseline hash in backend/baseline/MANIFEST.json and fails on drift.
// Baseline files are vendored unchanged; if one differs, either it was edited (and is no
// longer baseline) or the manifest is stale. Both are reportable, neither is silent.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const root = new URL('../backend/baseline/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('MANIFEST.json', root), 'utf8'))
const problems = []

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

if (problems.length) {
  console.error(`\nbaseline drift (${problems.length}):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`\nbaseline verified: ${Object.keys(manifest.files).length} files unchanged`)
