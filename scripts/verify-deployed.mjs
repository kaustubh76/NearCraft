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
//
// The deployed contracts are built with `cargo near build reproducible-wasm`,
// so these hashes are a function of the committed source and a digest-pinned
// container rather than of this machine. That is what makes the comparison
// meaningful to someone else: run the same command on the same commit and you
// get the same bytes. `npm run build:contracts` does NOT — it uses the local
// rustc — so comparing against that build proves nothing, which the failure
// message spells out.

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

/// What the contract says about its own build, per NEP-330.
///
/// This is not decoration. A reproducible build embeds the commit hash in the
/// wasm, so the deployed bytes are pinned to ONE commit: rebuilding the same
/// source at a later commit produces different bytes and a DIFFERS here. A
/// verifier therefore has to check out the commit the contract names, and the
/// only place that commit is recorded is the contract itself.
async function buildInfo(accountId) {
  try {
    const meta = await p.callFunction({ contractId: accountId, method: 'contract_source_metadata', args: {} })
    return meta?.build_info ?? null
  } catch {
    return null
  }
}

/// `git+https://host/org/repo?rev=<sha>` -> the sha.
const revOf = (info) => info?.source_code_snapshot?.match(/rev=([0-9a-f]{7,40})/)?.[1] ?? null

console.log('\nIs the deployed code the code in this repo?')
console.log(`rpc ${manifest.rpc}\n`)

const problems = []
const revs = new Set()
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
  const info = await buildInfo(accountId)
  const rev = revOf(info)
  if (rev) revs.add(rev)
  if (live === NO_CODE) {
    problems.push(`${name}: ${accountId} has no contract deployed at all`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} NO CODE`)
  } else if (live === expected) {
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} MATCH    ${live}`)
    console.log(`  ${' '.repeat(8)} ${' '.repeat(32)}          ${
      info ? `built reproducibly from ${rev ?? 'an unnamed revision'}` : 'no build_info — built outside a pinned container'
    }`)
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
    '\nWhat DIFFERS means depends on which build you compared with.\n' +
    '\n`cargo near build reproducible-wasm` IS byte-stable: it builds the\n' +
    'committed commit inside a digest-pinned container, so a mismatch there\n' +
    'means the deployed code is not this commit. That is the comparison a third\n' +
    'party can make, and the one the deployed contracts were built for.\n' +
    '\n`npm run build:contracts` uses non-reproducible-wasm and your local\n' +
    'rustc, so it legitimately produces different bytes from the same source.\n' +
    'A DIFFERS against THAT build tells you nothing on its own.\n' +
    '\nTo reproduce the deployed bytes yourself:\n' +
    '  cargo near build reproducible-wasm --manifest-path contracts/<name>/Cargo.toml\n' +
    '\nIf it still differs, the remedy is:  NEAR_REDEPLOY=<name> npm run deploy\n'
  )
  process.exit(1)
}

console.log(
  `\nall ${checked} deployed contract(s) hash to the wasm this repo builds, ` +
  'verified with no credentials'
)
if (revs.size === 1) {
  const [rev] = revs
  console.log(
    `\nThe chain says all of it was built from commit ${rev}. To reproduce the\n` +
    'bytes yourself — the commit matters, because a reproducible build embeds it:\n' +
    `  git checkout ${rev} && npm run build:reproducible && npm run verify:deployed\n`
  )
} else if (revs.size > 1) {
  console.log(
    `\nNote: the contracts were built from ${revs.size} different commits ` +
    `(${[...revs].join(', ')}).\nThat is legal but worth knowing — verify each against its own.\n`
  )
}
