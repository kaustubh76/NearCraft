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
/// Approval Management. Implemented because a player holding only a
/// function-call access key cannot attach the 1 yoctoNEAR a transfer needs, so
/// without approvals they could buy but never sell. See docs/GASLESS.md.
const NEP245_APPROVAL = [
  'mt_approve', 'mt_revoke', 'mt_revoke_all', 'mt_is_approved', 'mt_token_approval',
]

/// Modifiers that are load-bearing rather than cosmetic.
///
/// A list of pairs rather than an object literal, and that is the whole point.
/// This was written as an object and the key `market` was declared **twice** —
/// in a JS object literal the second declaration wins silently, so
/// `on_materials_pulled: ['private']` and `sell: []` were dropped and never
/// checked. `sell: []` is the assertion that keeps the player sell path
/// non-payable, which is the only reason a scoped key can sell at all; the
/// check reported "modifiers correct" for weeks without ever looking at it.
///
/// A list makes a duplicate detectable, and the guard below refuses to run with
/// one rather than quietly dropping half the rules.
const MODIFIER_RULES = [
  ['items', {
    // The spec requires exactly 1 yoctoNEAR on every transfer.
    mt_transfer: ['payable'], mt_batch_transfer: ['payable'],
    mt_transfer_call: ['payable'], mt_batch_transfer_call: ['payable'],
    // A resolver callable by anyone would let a caller fake a refund.
    mt_resolve_transfer: ['private'],
    // Approvals cost storage, and revocation must prove intent.
    mt_approve: ['payable'], mt_revoke: ['payable'], mt_revoke_all: ['payable'],
  }],
  ['market', {
    // A rollback callable by anyone would let a caller unwind someone's
    // purchase; the same for the sale-side unwind.
    on_items_delivered: ['private'],
    on_materials_pulled: ['private'],
    // The payout rollbacks. Callable by anyone, they would let a caller restore
    // a credit or a treasury that was in fact paid out — minting money.
    on_credit_paid: ['private'],
    on_treasury_paid: ['private'],
    // THE one that matters: a function-call access key cannot attach NEAR, so
    // both the agent purchase path and the player sell path must stay
    // non-payable. If either becomes payable, agents silently stop being able
    // to shop and a key-less player silently stops being able to sell.
    buy_with_credit: [],
    sell: [],
    // Same reason: a scoped key cannot attach NEAR, so the credit paths must
    // never become payable or they stop being reachable by a player.
    invest_with_credit: [],
    restock: [],
  }],
]

const REQUIRED_MODIFIERS = new Map()
for (const [contract, expectations] of MODIFIER_RULES) {
  if (REQUIRED_MODIFIERS.has(contract)) {
    throw new Error(
      `check-nep245: "${contract}" is declared twice in MODIFIER_RULES. Merge the ` +
      'blocks — otherwise one of them is silently dropped and the rules in it are ' +
      'never checked, which is exactly how sell: [] went unenforced.'
    )
  }
  REQUIRED_MODIFIERS.set(contract, expectations)
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
for (const [label, group] of [['core', NEP245_CORE], ['enumeration', NEP245_ENUMERATION], ['approval management', NEP245_APPROVAL]]) {
  const missing = group.filter((m) => !items.has(m))
  if (missing.length) problems.push(`items: NEP-245 ${label} missing ${missing.join(', ')}`)
  else console.log(`ok    NEP-245 ${label}: ${group.length}/${group.length} present`)
}

// Metadata is the one extension still not implemented: a token id *is* the
// material name here, so it would be redundant. If it ever appears, the
// README's scope statement has gone stale.
const NOT_CLAIMED = ['mt_metadata_contract', 'mt_metadata_token_all', 'mt_metadata_base_by_token_id']
const unexpected = NOT_CLAIMED.filter((m) => items.has(m))
if (unexpected.length) {
  problems.push(`items: exposes ${unexpected.join(', ')} but the README says Metadata is not implemented`)
} else {
  console.log('ok    Metadata absent, as documented')
}

// -------------------------------------------------------------- modifiers

for (const [contract, expectations] of REQUIRED_MODIFIERS) {
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
