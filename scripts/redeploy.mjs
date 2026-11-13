// Replace the code on a live contract whose state layout has not changed.
//
//   npm run redeploy -- items market          what it would do
//   npm run redeploy -- items market --yes    actually do it
//
// WHY THIS IS NOT `npm run deploy`. That script is a first-run deployer: after
// its deploy loop it registers merchants, lists items, funds treasuries and
// onboards every subject in config/catalog.json. All of that is idempotent by
// design, but onboarding is idempotent only against the CURRENT derivation —
// widen `ID_BYTES` and the same subjects derive new accounts, so a run would
// try to create them and fund each with the catalog budget. On a root holding
// under 2 NEAR that fails part-way through, after paying for some of it.
//
// So this does one thing: `deployContract`, and then check the contract still
// works.
//
// WHEN A BARE REDEPLOY IS SAFE, which is the whole question. Borsh state is
// positional. Adding or altering METHODS leaves it untouched; adding or
// reordering a FIELD in the state struct makes every method and every view
// panic with "Cannot deserialize the contract state", and recovering from that
// needs `migrate` deployed in the same transaction — `scripts/deploy.mjs` has
// NEAR_MIGRATE for that, and contracts/integration/tests/migration.rs proves
// the failure is real rather than theoretical.
//
// Reading the struct and concluding "no field changed" is necessary and not
// sufficient, so this refuses to be the only check: it reads state back
// immediately after deploying and fails loudly if the contract has been
// bricked, rather than leaving that to be discovered by a player.

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Account, JsonRpcProvider, baseEncode } from 'near-api-js'
import { names, provider, rootAccountId, RPC_URL } from './near-env.mjs'

const ROOT = new URL('..', import.meta.url)
const args = process.argv.slice(2)
const KNOWN = ['items', 'market', 'guard']
const wanted = args.filter((a) => !a.startsWith('--'))
const CONFIRM = args.includes('--yes')

const unknown = wanted.filter((w) => !KNOWN.includes(w))
if (unknown.length) {
  console.error(`\n  unknown contract(s): ${unknown.join(', ')}. Known: ${KNOWN.join(', ')}\n`)
  process.exit(1)
}
if (wanted.length === 0) {
  console.error('\n  Name the contracts to redeploy, e.g.\n')
  console.error('    npm run redeploy -- items market --yes\n')
  process.exit(2)
}

const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const n = names(manifest.root ?? rootAccountId())

/// A contract's OWN key, not the root's.
///
/// `DeployContract` is only valid in a transaction whose receiver is its own
/// signer: an account deploys to itself, and a parent cannot deploy to its
/// child however much NEAR it holds. The first version of this signed as root
/// and nearcore refused all of it — loudly, and without changing a byte on
/// chain, which is the right way for that mistake to land. `scripts/deploy.mjs`
/// gets this right via its `as(accountId)` helper; this reads the same
/// keystore.
const keys = JSON.parse(await readFile(new URL('.local/nearcraft-keys.json', ROOT), 'utf8'))

const p = provider()
const WASM = {
  items: new URL('contracts/target/near/nearcraft_items/nearcraft_items.wasm', ROOT),
  market: new URL('contracts/target/near/nearcraft_market/nearcraft_market.wasm', ROOT),
  guard: new URL('contracts/target/near/nearcraft_guard/nearcraft_guard.wasm', ROOT),
}
const ACCOUNT = { items: n.items, market: n.market, guard: n.guard }

/// A view that proves the contract can still deserialize its own state. A
/// method that merely EXISTS is not enough — a bricked contract still has
/// methods, they all panic.
const PROBE = {
  items: ['mt_supply', { token_id: manifest.materials?.[0]?.item ?? 'iron_ingot' }],
  market: ['ledger_total', {}],
  // No arguments, so the probe cannot fail on an argument name rather than on
  // the thing it is probing. `reports_for` takes `account_id`, not `subject`,
  // and getting that wrong looked exactly like a bricked contract.
  guard: ['threshold', {}],
}

const hashOf = async (id) =>
  (await p.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).code_hash

/// Wait for the chain to report the code we just deployed.
///
/// Read the hash the instant `deployContract` returns and it can still be the
/// OLD one — even at `optimistic`. This script reported MISMATCH on a deploy
/// that had in fact succeeded, which is a false alarm on the most alarming
/// line it prints. The third time this exact class bit in one sitting, after
/// `scripts/live-onboard.mjs` read a new account a block too early and the
/// audit found `scripts/deploy.mjs` doing it uncaught.
///
/// On timeout it returns the last reading rather than throwing, so a deploy
/// that genuinely did not land is still reported as a mismatch.
async function settledHash(id, expected, ms = 30000) {
  const at = Date.now()
  for (;;) {
    const h = await hashOf(id)
    if (h === expected || Date.now() - at > ms) return h
    await new Promise((r) => setTimeout(r, 1000))
  }
}

console.log(`\n  network   ${manifest.network} via ${RPC_URL}`)
console.log(`  root      ${manifest.root}`)
console.log(`  mode      ${CONFIRM ? 'REDEPLOYING' : 'dry run — pass --yes to do it'}\n`)

let failed = 0
for (const name of wanted) {
  const accountId = ACCOUNT[name]
  const code = await readFile(WASM[name])
  const local = baseEncode(createHash('sha256').update(code).digest())
  const onChain = await hashOf(accountId)

  console.log(`  ${name}`)
  console.log(`    account   ${accountId}`)
  console.log(`    on chain  ${onChain}`)
  console.log(`    local     ${local}  (${(code.length / 1024).toFixed(1)} KB)`)

  if (local === onChain) { console.log(`    already the same code; nothing to do\n`); continue }
  if (!CONFIRM) { console.log(`    would replace it\n`); continue }

  const [probeMethod, probeArgs] = PROBE[name]
  // Read the probe BEFORE, so "it still answers" can be compared rather than
  // merely observed. A view that returned null both times proves nothing.
  let before = null
  try { before = JSON.stringify(await p.callFunction({ contractId: accountId, method: probeMethod, args: probeArgs })) }
  catch (e) { console.log(`    (probe ${probeMethod} failed before deploying: ${e.message.slice(0, 60)})`) }

  const key = keys[accountId]
  if (!key) {
    console.error(`    no key on record for ${accountId} — it must sign its own deploy\n`)
    failed++
    continue
  }
  try {
    await new Account(accountId, new JsonRpcProvider({ url: RPC_URL }), key).deployContract(code)
  } catch (e) {
    // The outcome object nearcore returns on failure is enormous and includes
    // merkle proofs; printing it buries the one line that matters.
    console.error(`    REFUSED   ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`)
    failed++
    continue
  }

  const after = await settledHash(accountId, local)
  const ok = after === local
  console.log(`    ${ok ? 'deployed' : 'MISMATCH'}  ${after}${ok ? '' : `  expected ${local}`}`)
  if (!ok) failed++

  // The check this script exists for.
  try {
    const probed = JSON.stringify(await p.callFunction({ contractId: accountId, method: probeMethod, args: probeArgs }))
    console.log(`    state     ${probeMethod} -> ${String(probed).slice(0, 48)}`)
    if (before !== null && probed !== before) {
      console.log(`    WARNING   it changed across the redeploy: ${before.slice(0, 40)} -> ${probed.slice(0, 40)}`)
      failed++
    }
  } catch (e) {
    console.error(`    BRICKED   ${probeMethod} now panics: ${String(e?.message ?? e).slice(0, 110)}`)
    console.error(`    This contract can no longer read its own state. A field was added or`)
    console.error(`    reordered, so it needed deploy+migrate in ONE transaction:`)
    console.error(`      NEAR_MIGRATE=${name} npm run deploy\n`)
    failed++
  }
  console.log('')
}

if (CONFIRM) {
  console.log(`  ${failed === 0 ? 'done — run npm run verify:deployed to confirm against the repo' : `${failed} problem(s)`}\n`)
}
process.exit(failed === 0 ? 0 : 1)
