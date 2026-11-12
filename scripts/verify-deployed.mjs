// Does the chain run the code in this repo? No credentials.
//
//   npm run verify:deployed
//
// NEAR reports a contract's `code_hash` as base58(sha256(wasm)), so the answer
// is computable from a public view_account call and the local build. Anyone can
// run this against the public RPC and get the same answer we do.
//
// Why it exists: `items` was found running bytes that the repo does not build,
// and nothing here could see it. That is the A3 bug class — a fix that never
// reached the chain — and the only clue at the time was a deploy log line that
// looked like success. A claim about a deployment that cannot be checked is the
// one kind of claim this project does not get to make.

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { baseEncode } from 'near-api-js'
import { names, provider, rootAccountId } from './near-env.mjs'

/// An account with no contract reports this sentinel rather than a hash.
const NO_CODE = '11111111111111111111111111111111'

const WASM = {
  items: new URL('../contracts/target/near/nearcraft_items/nearcraft_items.wasm', import.meta.url),
  market: new URL('../contracts/target/near/nearcraft_market/nearcraft_market.wasm', import.meta.url),
  guard: new URL('../contracts/target/near/nearcraft_guard/nearcraft_guard.wasm', import.meta.url),
}

let manifest
try {
  manifest = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))
} catch {
  console.error(
    'deployment.json not found — nothing is deployed yet.\n' +
    '  Run npm run deploy first, or point NEAR_ROOT_ACCOUNT at a deployed root.'
  )
  process.exit(1)
}

const p = provider()
const n = names(manifest.root || rootAccountId())

console.log('\nIs the deployed code the code in this repo?')
console.log(`rpc ${manifest.rpc}\n`)

const problems = []
let checked = 0

for (const [name, wasmUrl] of Object.entries(WASM)) {
  const accountId = n[name]

  let local
  try {
    local = new Uint8Array(await readFile(wasmUrl))
  } catch {
    // Not a mismatch — we simply cannot answer the question. Say which, because
    // "cannot check" reported as "differs" would send someone redeploying for
    // no reason.
    problems.push(`${name}: no local build to compare against — run npm run build:contracts`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} NOT BUILT`)
    continue
  }

  const expected = baseEncode(createHash('sha256').update(local).digest())

  let live
  try {
    const state = await p.query({ request_type: 'view_account', finality: 'final', account_id: accountId })
    live = state.code_hash
  } catch (e) {
    problems.push(`${name}: cannot read ${accountId} — ${e.message?.split('\n')[0] ?? e}`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} UNREADABLE`)
    continue
  }

  checked += 1
  if (live === NO_CODE) {
    problems.push(`${name}: ${accountId} has no contract deployed at all`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} NO CODE`)
  } else if (live === expected) {
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} MATCH    ${live}`)
  } else {
    problems.push(`${name}: the chain runs ${live}, this repo builds ${expected}`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} DIFFERS  ${live}`)
    console.log(`  ${' '.repeat(8)} ${' '.repeat(32)}          ${expected}  <- local build`)
  }
}

// ----------------------------------------------------------------- verdict

if (problems.length) {
  console.error(`\nthe chain is not running this repo's code (${problems.length}):`)
  for (const x of problems) console.error(`  ${x}`)
  console.error(
    '\nDIFFERS has two causes and this check cannot tell them apart, because\n' +
    '`cargo near build non-reproducible-wasm` is not byte-stable — rebuilding\n' +
    'unchanged source yields different bytes. So it means either:\n' +
    '  - this build was never deployed (a fix that silently never shipped), or\n' +
    '  - the contract was rebuilt after it was deployed.\n' +
    'Behaviour is what distinguishes them: npm run reads, and the live view\n' +
    'calls in contracts/integration/tests/views.rs.\n' +
    '\nEither way the remedy is the same:  NEAR_REDEPLOY=<name> npm run deploy\n'
  )
  process.exit(1)
}

console.log(
  `\nall ${checked} deployed contract(s) hash to the wasm this repo builds, ` +
  'verified with no credentials\n'
)
