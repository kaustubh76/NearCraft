// Show that every agent AND player key really is limited — read back from the
// protocol, not asserted by us.
//
//   npm run keys
//
// No credentials. This is the check behind the security-track claim: an agent
// signs with a function-call access key scoped to one contract and an explicit
// method list, and such a key cannot transfer NEAR or add keys at all.
//
// Players are audited too, and they are the harder claim: a player holds NO
// full-access key, so its key is immutable for life. For a long time this
// script read `manifest.agents` and nothing else, which meant the one account
// in the deployment with no full-access key was the one account the key audit
// never looked at. See the players section below for what that hid.

import { readFile } from 'node:fs/promises'
import { fromYocto, provider } from './near-env.mjs'

/// What one 60 TGas agent call actually burns from a key's allowance, measured
/// on public testnet: `worker-1`'s allowance fell by 670133550974700000000
/// yoctoNEAR across exactly one live `buy_with_credit`.
///
/// Used only to turn a remaining allowance into "about this many calls left",
/// which is the number that matters, because the security prompt's own closing
/// note warns that an account holding ONLY function-call keys "can lock itself
/// out if the gas allowance runs out". Gas prices move, so this is an estimate
/// from a real measurement rather than a guarantee, and it is labelled as one.
const MEASURED_BURN_PER_CALL = 670_133_550_974_700_000_000n

/// Print one function-call key as the protocol reports it, and return the
/// number of checks that failed.
///
/// Shared by the agent and the player audit so the two cannot drift into
/// describing the same kind of key differently, and so the lock-out headroom is
/// computed in one place rather than two.
function describeScopedKey(publicKey, fc, siblings) {
  let failed = 0
  console.log(`  ${publicKey}`)
  console.log(`    receiver_id   ${fc.receiver_id}`)
  console.log(`    method_names  [${(fc.method_names ?? []).join(', ') || '*** ANY METHOD ***'}]`)
  console.log(`    allowance     ${fc.allowance ? fromYocto(fc.allowance) + ' NEAR (gas only)' : 'unlimited'}`)
  console.log('    cannot transfer NEAR, cannot add keys — enforced by the runtime')

  // Lock-out headroom. An allowance is spent, never refilled, and a key whose
  // allowance falls below one call's PREPAID gas stops working entirely — so
  // an account with no full-access key to add a replacement is then stuck for
  // good. Reporting the remaining calls makes that visible years before it
  // happens instead of on the day it does.
  if (fc.allowance) {
    const left = BigInt(fc.allowance) / MEASURED_BURN_PER_CALL
    const rescue = siblings.some((o) => {
      const q = o.access_key.permission
      return q === 'FullAccess' || q?.FullAccess !== undefined
    })
    console.log(
      `    headroom      ~${left} more call(s) at the measured testnet burn` +
      `${rescue ? '; an operator key can re-key this account' : ' — and no full-access key to re-key it'}`,
    )
    if (left < 50n) {
      console.log('    ^ FAIL: fewer than 50 calls of allowance left; re-key before it locks out')
      failed++
    }
  }

  // An empty method_names list means "any method on that contract". Passing
  // methodNames is optional in near-api-js, so this is a real footgun; the
  // check exists so a regression would be loud rather than silent.
  if (!fc.method_names?.length) {
    console.log('    ^ FAIL: unrestricted within the contract')
    failed++
  }
  return failed
}

const p = provider()
let manifest
try {
  manifest = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))
} catch {
  console.error('deployment.json not found — run npm run deploy first.')
  process.exit(1)
}

const agents = manifest.agents ?? []

// An audit with nothing to audit must not report success.
//
// This is not defensive padding — it shipped. `deploy.mjs` recorded an agent
// only on the branch that ISSUED a new scoped key, so any re-run wrote
// `agents: []`, and this script then printed "all agent keys are correctly
// scoped" having examined zero accounts. That success line is what the README
// offers as proof of the security track's central property, and it was vacuous
// on the live manifest.
if (agents.length === 0) {
  console.error('\nFAIL: deployment.json records no agents, so there is nothing to audit.')
  console.error('      An audit that checks nothing must not report success.')
  console.error('      Run npm run deploy to rebuild the manifest from the chain.\n')
  process.exit(1)
}

console.log('\nAgent access keys, as the protocol reports them\n')

let failures = 0
let operatorKeys = 0
for (const agent of agents) {
  const { keys } = await p.query({
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: agent.account_id,
  })
  console.log(`${agent.account_id}`)
  for (const k of keys) {
    const perm = k.access_key.permission
    if (perm === 'FullAccess' || perm?.FullAccess !== undefined) {
      operatorKeys++
      console.log(`  ${k.public_key}`)
      console.log('    FULL ACCESS — the operator key, created with the account and kept in')
      console.log('                  .local/. It is NOT given to the agent process, which')
      console.log('                  holds only the scoped key below. Disclosed, not a')
      console.log('                  failure: the operator owns the agent, so this does not')
      console.log('                  widen what the AGENT can do. Players are different and')
      console.log('                  delete theirs — see docs/GASLESS.md.')
      continue
    }
    const fc = perm.FunctionCall
    failures += describeScopedKey(k.public_key, fc, keys)
    if (fc.receiver_id !== agent.scoped_to) {
      console.log(`    ^ FAIL: expected receiver ${agent.scoped_to}`)
      failures++
    }
    // A scoped key the manifest does not know about. Nobody holds its secret on
    // purpose, nothing rotates it, and it grants real authority — this is how
    // worker-1 ended up carrying two.
    if (agent.function_call_public_key && k.public_key !== agent.function_call_public_key) {
      console.log('    ^ FAIL: this scoped key is not the one deployment.json records')
      console.log(`             manifest says ${agent.function_call_public_key}`)
      failures++
    }
  }

  // The converse: the manifest claims a key that the chain does not have. Then
  // the published record describes a deployment that does not exist.
  const present = keys.map((k) => k.public_key)
  if (agent.function_call_public_key && !present.includes(agent.function_call_public_key)) {
    console.log(`  FAIL: deployment.json records ${agent.function_call_public_key},`)
    console.log('        which is not on this account at all')
    failures++
  }
  console.log()
}

// ---------------------------------------------------------------- players
//
// Players are audited apart from agents because the claim is stronger and the
// cost of getting it wrong is higher. An agent keeps an operator full-access
// key and can be re-keyed. A player's bootstrap key is DELETED during
// onboarding, in the same transaction that installs the scoped one, so a
// player's key is immutable for life: no method can ever be added to it and
// nothing can rescue it.
//
// This block exists because the manifest was wrong about exactly that.
// `deployment.json` recorded the live player as holding
// [buy_with_credit, sell, invest_with_credit]; the chain granted
// [buy_with_credit, sell]. `deploy.mjs` wrote the CONFIGURED method list rather
// than the one on chain — A7's defect repeated for players — and this script,
// reading only `manifest.agents`, could not see it. A published record claiming
// a capability the key does not grant is the same failure as an audit that
// checks nothing: it reads like evidence and is not.
const players = manifest.players ?? []
if (players.length === 0) {
  console.error('\nFAIL: deployment.json records no players, so the strongest key')
  console.error('      claim in this project — an account holding NO full-access key —')
  console.error('      is never checked against the chain.')
  console.error('      Run npm run deploy to rebuild the manifest from the chain.\n')
  process.exit(1)
}

console.log('Player access keys, as the protocol reports them\n')

for (const player of players) {
  const { keys } = await p.query({
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: player.account_id,
  })
  console.log(`${player.account_id}`)

  const isFull = (k) => {
    const q = k.access_key.permission
    return q === 'FullAccess' || q?.FullAccess !== undefined
  }
  const scoped = keys.filter((k) => !isFull(k))

  for (const k of keys) {
    // For a player a full-access key is not a disclosure, it is a failure: the
    // gasless claim rests on there being none left after onboarding.
    if (isFull(k)) {
      console.log(`  ${k.public_key}`)
      console.log('    ^ FAIL: FULL ACCESS — a player must hold no full-access key.')
      console.log('            Onboarding deletes the bootstrap key in the same')
      console.log('            transaction that adds the scoped one. See docs/GASLESS.md.')
      failures++
      continue
    }

    const fc = k.access_key.permission.FunctionCall
    failures += describeScopedKey(k.public_key, fc, keys)

    if (fc.receiver_id !== manifest.contracts.market) {
      console.log(`    ^ FAIL: expected receiver ${manifest.contracts.market}`)
      failures++
    }

    // The manifest and the chain have to agree in BOTH directions. Claiming
    // more than the key grants publishes a capability that does not exist;
    // claiming less hides authority that does. Only comparing one way is how
    // the live manifest kept advertising invest_with_credit.
    const onChain = [...(fc.method_names ?? [])].sort()
    const recorded = [...(player.permitted_methods ?? [])].sort()
    const overclaimed = recorded.filter((m) => !onChain.includes(m))
    const unrecorded = onChain.filter((m) => !recorded.includes(m))
    if (overclaimed.length) {
      console.log(`    ^ FAIL: deployment.json claims [${overclaimed.join(', ')}], which this key does not grant.`)
      console.log('            A player key is immutable for life, so this can never become true;')
      console.log('            the record has to change, not the key.')
      failures++
    }
    if (unrecorded.length) {
      console.log(`    ^ FAIL: this key grants [${unrecorded.join(', ')}], which deployment.json does not record.`)
      failures++
    }

    // A scoped key the manifest does not know about grants real authority that
    // nothing rotates and nobody holds the secret for on purpose. This is how
    // worker-1 ended up carrying two.
    if (player.function_call_public_key && k.public_key !== player.function_call_public_key) {
      console.log('    ^ FAIL: this scoped key is not the one deployment.json records')
      console.log(`             manifest says ${player.function_call_public_key}`)
      failures++
    }
  }

  const present = keys.map((k) => k.public_key)
  if (player.function_call_public_key && !present.includes(player.function_call_public_key)) {
    console.log(`  ^ FAIL: deployment.json records ${player.function_call_public_key},`)
    console.log('          which is not on this account at all')
    failures++
  }

  if (scoped.length !== 1) {
    console.log(`  ^ FAIL: expected exactly one function-call key, found ${scoped.length}`)
    failures++
  }
  if (!keys.some(isFull)) {
    console.log('  no full-access key — this account cannot transfer NEAR, add a key, or')
    console.log('  gain a method. Not by our restraint: by the runtime.')
  }
  console.log()
}

// The spend budget is the second, independent bound — the key's allowance
// covers gas only, so without this a scoped key could still shop without limit.
console.log('Spend budgets (the second bound, enforced by the market contract)\n')
for (const who of [...agents, ...players]) {
  const credit = await p.callFunction({
    contractId: manifest.contracts.market,
    method: 'credit_of',
    args: { account_id: who.account_id },
  })
  console.log(`  ${who.account_id.padEnd(34)} ${fromYocto(credit).padStart(10)} NEAR remaining`)
}

// Say what was audited, not just that it passed. A bare "all correct" is what
// made the empty-manifest case look like a success.
const summary =
  `${agents.length} agent(s) and ${players.length} player(s) audited, ` +
  `${operatorKeys} operator key(s) disclosed`
console.log(
  failures
    ? `\n${failures} key check(s) FAILED  (${summary})\n`
    : `\nevery agent and player key is scoped as recorded — ${summary}\n`,
)
process.exit(failures ? 1 : 0)
