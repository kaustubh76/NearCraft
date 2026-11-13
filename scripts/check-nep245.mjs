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
///
/// SIX methods, not five. This list said five for as long as it existed, and
/// `mt_token_approvals` — the paginated one — was missing from both the list and
/// the contract. So the check reported "approval management: 5/5 present" with
/// the implementation as its own denominator, which is a check that cannot
/// fail. Read from nep-0245/ApprovalManagement.md, not from what we built.
const NEP245_APPROVAL = [
  'mt_approve', 'mt_revoke', 'mt_revoke_all', 'mt_is_approved',
  'mt_token_approval', 'mt_token_approvals',
]

/// What the SPEC says each method looks like, transcribed from the NEPs
/// repository rather than from what we built.
///
/// This is the half of conformance the check could not see. It read names and
/// modifiers, which means a contract implementing every method with the wrong
/// arguments passed it — and the README said so in its open findings. The ABI
/// has carried parameter names, types, the view/call kind and the return type
/// all along; nothing was reading them.
///
/// Sources, fetched and read rather than recalled:
///   core + enumeration  neps/nep-0245.md
///   enumeration         neps/nep-0245/Enumeration.md
///   approval management neps/nep-0245/ApprovalManagement.md
///
/// Types are in the vocabulary of `describe()` below. Where the spec is
/// ambiguous the decision is recorded here rather than papered over:
///
///   * The spec writes `[string]` for a list of token ids. Its own examples
///     pass lists of any length, so that is read as `string[]`, not a 1-tuple.
///   * `mt_transfer_call` returns a bare untyped `Promise`. A typed promise
///     satisfies that, so `describe()` folds any `Promise*` name to `Promise`.
///   * `mt_approve` "returns void, if no msg given", otherwise a promise —
///     which is `Promise?`.
///   * `mt_token` is printed with no colon before its return type and
///     `mt_batch_transfer` refers to an `approval_ids` parameter that does not
///     exist in its own signature. Neither affects what is checked here.
const SPEC = 'nep-0245'
const NEP245_SIGNATURES = {
  // ---- Core, neps/nep-0245.md, CHANGE METHODS
  mt_transfer: { kind: 'call', result: 'void', args: [
    ['receiver_id', 'string'], ['token_id', 'string'], ['amount', 'string'],
    ['approval', '[string,integer]?'], ['memo', 'string?'],
  ] },
  mt_batch_transfer: { kind: 'call', result: 'void', args: [
    ['receiver_id', 'string'], ['token_ids', 'string[]'], ['amounts', 'string[]'],
    ['approvals', '[string,integer]?[]?'], ['memo', 'string?'],
  ] },
  mt_transfer_call: { kind: 'call', result: 'Promise', args: [
    ['receiver_id', 'string'], ['token_id', 'string'], ['amount', 'string'],
    ['approval', '[string,integer]?'], ['memo', 'string?'], ['msg', 'string'],
  ] },
  mt_batch_transfer_call: { kind: 'call', result: 'Promise', args: [
    ['receiver_id', 'string'], ['token_ids', 'string[]'], ['amounts', 'string[]'],
    ['approvals', '[string,integer]?[]?'], ['memo', 'string?'], ['msg', 'string'],
  ] },
  // Under neither heading in the spec; it is the resolver, and the spec both
  // permits renaming it and requires it be callable only by the contract.
  mt_resolve_transfer: { kind: 'call', result: 'string[]', args: [
    ['sender_id', 'string'], ['receiver_id', 'string'], ['token_ids', 'string[]'],
    ['approvals', 'unspecified'],
  ] },
  // ---- Core, VIEW METHODS
  mt_token: { kind: 'view', result: 'Token?[]', args: [['token_ids', 'string[]']] },
  mt_balance_of: { kind: 'view', result: 'string', args: [
    ['account_id', 'string'], ['token_id', 'string'],
  ] },
  mt_batch_balance_of: { kind: 'view', result: 'string[]', args: [
    ['account_id', 'string'], ['token_ids', 'string[]'],
  ] },
  mt_supply: { kind: 'view', result: 'string?', args: [['token_id', 'string']] },
  mt_batch_supply: { kind: 'view', result: 'string?[]', args: [['token_ids', 'string[]']] },
  // ---- Enumeration, neps/nep-0245/Enumeration.md
  mt_tokens: { kind: 'view', result: 'Token[]', args: [
    ['from_index', 'string?'], ['limit', 'integer?'],
  ] },
  mt_tokens_for_owner: { kind: 'view', result: 'Token[]', args: [
    ['account_id', 'string'], ['from_index', 'string?'], ['limit', 'integer?'],
  ] },
  // ---- Approval Management, neps/nep-0245/ApprovalManagement.md
  mt_approve: { kind: 'call', result: 'Promise?', args: [
    ['token_ids', 'string[]'], ['amounts', 'string[]'], ['account_id', 'string'],
    ['msg', 'string?'],
  ] },
  mt_revoke: { kind: 'call', result: 'void', args: [
    ['token_ids', 'string[]'], ['account_id', 'string'],
  ] },
  mt_revoke_all: { kind: 'call', result: 'void', args: [['token_ids', 'string[]']] },
  mt_is_approved: { kind: 'view', result: 'boolean', args: [
    ['token_ids', 'string[]'], ['approved_account_id', 'string'],
    ['amounts', 'string[]'], ['approval_ids', 'integer[]?'],
  ] },
  mt_token_approval: { kind: 'view', result: 'TokenApproval', args: [
    ['token_id', 'string'], ['account_id', 'string'],
  ] },
  mt_token_approvals: { kind: 'view', result: 'TokenApproval[]', args: [
    ['token_id', 'string'], ['from_index', 'string?'], ['limit', 'integer?'],
  ] },
}

/// Deviations we have decided on, each naming the EXACT difference.
///
/// Keyed by `method/what`, and the value must equal the mismatch the check
/// actually computes. That is deliberate, and it is the same discipline as the
/// escape hatch in `check-docs.mjs`: a declaration that names only a method
/// would go on excusing it after the signature had drifted into something else
/// entirely. Naming the before and the after means a NEW deviation on an
/// already-deviating method still fails.
///
/// An undeclared deviation fails. A declaration nothing matches also fails —
/// otherwise this list would quietly accumulate excuses for problems that no
/// longer exist, and stop describing the contract.
const DECLARED_DEVIATIONS = {
  'mt_resolve_transfer/args': {
    expected: 'sender_id: string, receiver_id: string, token_ids: string[], approvals: unspecified',
    actual: 'sender_id: string, receiver_id: string, token_ids: string[], amounts: string[]',
    why: "the spec's resolver takes `approvals`, but a resolver cannot compute a refund "
       + 'without knowing what was SENT. The spec text has acknowledged copy-paste errors in '
       + 'this section, the resolver is a private callback rather than an interop surface, and '
       + 'the spec permits renaming it. See the note at contracts/items/src/lib.rs.',
  },
  'mt_is_approved/args': {
    expected: 'token_ids: string[], approved_account_id: string, amounts: string[], approval_ids: integer[]?',
    actual: 'token_ids: string[], approved_account_id: string, amounts: string[], approval_ids: integer[]?, owner_id: string',
    why: "the spec's four-argument signature names no owner, which a MULTI-token cannot answer: "
       + 'balances and approvals are keyed per (owner, token), so "is this approved?" has no '
       + 'meaning until you say whose. Reading the predecessor instead made it a view no client '
       + 'could call — nearcore answers HostError(ProhibitedInView).',
  },
}

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
    // THE most dangerous signature in the project. `migrate` overwrites the
    // contract's entire state, so an un-private one would let ANY account reset
    // the market — every treasury, every credit balance, gone, from a single
    // call anyone can make. near-sdk emits the privacy check only inside the
    // wasm32 wrapper, so no unit test can see it; this rule and the sandbox
    // test in contracts/integration/tests/migration.rs are the whole defence.
    // Both modifiers are read off the ABI rather than assumed.
    migrate: ['init', 'private'],
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

// ------------------------------------------------------------- signatures
//
// The half this gate could not see. Everything below reads the ABI that
// `cargo near` emitted from the compiled contract, so it describes what was
// actually built rather than what the source comments claim.

/// An ABI JSON-schema fragment as a short, comparable string.
///
/// Deliberately total: anything it does not recognise comes back as
/// `unknown(...)`, which can never equal a spec type and so fails loudly. A
/// normaliser that silently returns a plausible default is a check that cannot
/// fail, and this file already carries two scars from that pattern.
function describe(schema) {
  if (schema === undefined || schema === null) return 'void'
  if (typeof schema !== 'object') return `unknown(${JSON.stringify(schema)})`

  if (schema.$ref) return promiseFold(schema.$ref.split('/').pop())

  // `anyOf: [X, null]` — how near-sdk renders an Option of a named type.
  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf.map(describe)
    const nulls = parts.filter((p) => p === 'null')
    const rest = parts.filter((p) => p !== 'null')
    if (nulls.length && rest.length === 1) return `${rest[0]}?`
    return `anyOf(${parts.join('|')})`
  }

  const ty = schema.type
  if (ty === undefined) return 'unknown(no type)'

  // `type: ["array", "null"]` — an Option of an array.
  if (Array.isArray(ty)) {
    const base = ty.filter((t) => t !== 'null')
    if (base.length !== 1) return `unknown(${JSON.stringify(ty)})`
    return `${describe({ ...schema, type: base[0] })}?`
  }

  if (ty === 'array') {
    const items = schema.items
    // A JSON-schema tuple: `items` is an ARRAY of schemas, one per position.
    if (Array.isArray(items)) return `[${items.map(describe).join(',')}]`
    if (items === undefined) return 'unknown(array with no items)'
    return `${describe(items)}[]`
  }
  if (ty === 'null') return 'null'
  if (['string', 'integer', 'number', 'boolean', 'object'].includes(ty)) return ty
  return `unknown(${ty})`
}

/// The spec returns a bare, untyped `Promise`. near-sdk names the concrete one,
/// e.g. `PromiseOrValueArray_of_String`. A typed promise satisfies an untyped
/// one, so they are folded together — and only here, so the folding is visible
/// rather than buried in a comparison.
function promiseFold(name) {
  return /^Promise/.test(name) ? 'Promise' : name
}

const argsOf = (f) =>
  ((f.params ?? {}).args ?? []).map((a) => `${a.name}: ${describe(a.type_schema)}`).join(', ')

const resultOf = (f) => (f.result ? describe(f.result.type_schema) : 'void')

const matched = new Set()
let checkedSignatures = 0

for (const [method, spec] of Object.entries(NEP245_SIGNATURES)) {
  const f = items.get(method)
  if (!f) continue // completeness is reported above; do not say it twice

  const expectedArgs = spec.args.map(([n, t]) => `${n}: ${t}`).join(', ')
  const actualArgs = argsOf(f)

  for (const [what, expected, actual] of [
    ['args', expectedArgs, actualArgs],
    ['kind', spec.kind, f.kind],
    ['result', spec.result, resultOf(f)],
  ]) {
    if (expected === actual) { checkedSignatures++; continue }

    const key = `${method}/${what}`
    const declared = DECLARED_DEVIATIONS[key]
    if (declared && declared.expected === expected && declared.actual === actual) {
      matched.add(key)
      console.log(`note  ${method}: ${what} deviates from ${SPEC}, as declared`)
      console.log(`        spec  ${expected}`)
      console.log(`        ours  ${actual}`)
      checkedSignatures++
      continue
    }
    if (declared) {
      matched.add(key)
      problems.push(
        `items: ${method} ${what} deviates from ${SPEC} DIFFERENTLY than declared — the ` +
        `declaration no longer describes this contract.\n` +
        `        declared spec  ${declared.expected}\n` +
        `        declared ours  ${declared.actual}\n` +
        `        actual spec    ${expected}\n` +
        `        actual ours    ${actual}`,
      )
      continue
    }
    problems.push(
      `items: ${method} ${what} does not match ${SPEC}\n` +
      `        spec  ${expected}\n` +
      `        ours  ${actual}`,
    )
  }
}

// A declaration nothing matches is an excuse for a problem that no longer
// exists, and it would go on excusing the next one.
for (const key of Object.keys(DECLARED_DEVIATIONS)) {
  if (!matched.has(key)) {
    problems.push(
      `items: a deviation is declared for ${key} but the contract does not deviate there — ` +
      'remove the declaration rather than leaving it to excuse something else later',
    )
  }
}

if (!problems.length) {
  console.log(`ok    ${checkedSignatures} signature facts match ${SPEC} ` +
    `(${Object.keys(NEP245_SIGNATURES).length} methods: arguments, view/call kind, return type)`)
}

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
