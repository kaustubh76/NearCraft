// Conformance check against the built ABI, not against our own source comments.
//
//   npm run check:nep245
//
// Offline, no credentials, no network. cargo-near emits an ABI describing the
// contract's real public surface, so this verifies what was actually compiled:
// the NEP-245 core and Enumeration methods are present, and the modifiers that
// carry security meaning are correct.

import { readFile } from 'node:fs/promises'

const ABI = {
  items: new URL('../contracts/target/near/nearcraft_items/nearcraft_items_abi.json', import.meta.url),
  market: new URL('../contracts/target/near/nearcraft_market/nearcraft_market_abi.json', import.meta.url),
}

/// nep-0245.md core. `mt_resolve_transfer` is the resolver; the spec permits
/// renaming it, but we keep the canonical name.
const NEP245_CORE = [
  'mt_transfer', 'mt_batch_transfer', 'mt_transfer_call', 'mt_batch_transfer_call',
  'mt_resolve_transfer', 'mt_token', 'mt_balance_of', 'mt_batch_balance_of',
  'mt_supply', 'mt_batch_supply',
]
const NEP245_ENUMERATION = ['mt_tokens', 'mt_tokens_for_owner']

/// Modifiers that are load-bearing rather than cosmetic.
const REQUIRED_MODIFIERS = {
  items: {
    // The spec requires exactly 1 yoctoNEAR on every transfer.
    mt_transfer: ['payable'], mt_batch_transfer: ['payable'],
    mt_transfer_call: ['payable'], mt_batch_transfer_call: ['payable'],
    // A resolver callable by anyone would let a caller fake a refund.
    mt_resolve_transfer: ['private'],
  },
  market: {
    // A rollback callable by anyone would let a caller unwind someone's purchase.
    on_items_delivered: ['private'],
    // THE one that matters for the agent design: a function-call access key
    // cannot attach NEAR, so the agent's purchase path must NOT be payable.
    // If this ever becomes payable, agents silently stop being able to shop.
    buy_with_credit: [],
  },
}

const problems = []
const abis = {}

for (const [name, url] of Object.entries(ABI)) {
  try {
    abis[name] = JSON.parse(await readFile(url, 'utf8'))
  } catch {
    problems.push(`${name}: ABI not found — run npm run build:contracts first`)
  }
}
if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`)
  process.exit(1)
}

function fns(name) {
  return new Map(abis[name].body.functions.map((f) => [f.name, f]))
}

// ----------------------------------------------------- NEP-245 completeness

const items = fns('items')
for (const [label, group] of [['core', NEP245_CORE], ['enumeration', NEP245_ENUMERATION]]) {
  const missing = group.filter((m) => !items.has(m))
  if (missing.length) problems.push(`items: NEP-245 ${label} missing ${missing.join(', ')}`)
  else console.log(`ok    NEP-245 ${label}: ${group.length}/${group.length} present`)
}

// Not implemented, and deliberately so — see BASELINE.md and the contract docs.
// If one of these ever appears, the README's scope statement has gone stale.
const NOT_CLAIMED = ['mt_approve', 'mt_revoke', 'mt_revoke_all', 'mt_is_approved', 'mt_metadata_contract']
const unexpected = NOT_CLAIMED.filter((m) => items.has(m))
if (unexpected.length) {
  problems.push(`items: exposes ${unexpected.join(', ')} but the README says Approval/Metadata are not implemented`)
} else {
  console.log('ok    Approval Management and Metadata absent, as documented')
}

// -------------------------------------------------------------- modifiers

for (const [contract, expectations] of Object.entries(REQUIRED_MODIFIERS)) {
  const have = fns(contract)
  for (const [method, required] of Object.entries(expectations)) {
    const f = have.get(method)
    if (!f) { problems.push(`${contract}: ${method} is missing entirely`); continue }
    const mods = f.modifiers ?? []
    for (const m of required) {
      if (!mods.includes(m)) problems.push(`${contract}: ${method} must be ${m}, got [${mods}]`)
    }
    // An empty requirement means the modifier list must be empty too.
    if (required.length === 0 && mods.length) {
      problems.push(`${contract}: ${method} must carry no modifiers, got [${mods}]`)
    }
  }
}
if (!problems.length) console.log('ok    security-relevant modifiers correct (payable / private / non-payable)')

// `buy_with_credit` is the agent path; spell the reason out so a future reader
// does not "fix" it by making it payable.
const buyWithCredit = fns('market').get('buy_with_credit')
if (buyWithCredit && (buyWithCredit.modifiers ?? []).includes('payable')) {
  problems.push('market: buy_with_credit is payable, so a function-call access key could not call it')
}

console.log()
if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`)
  console.error(`\n${problems.length} conformance problem(s)\n`)
  process.exit(1)
}
console.log(`conformance ok — items ${items.size} methods, market ${fns('market').size} methods\n`)
