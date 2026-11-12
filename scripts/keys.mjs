// Show that every agent key really is limited — read back from the protocol,
// not asserted by us.
//
//   npm run keys
//
// No credentials. This is the check behind the security-track claim: an agent
// signs with a function-call access key scoped to one contract and an explicit
// method list, and such a key cannot transfer NEAR or add keys at all.

import { readFile } from 'node:fs/promises'
import { fromYocto, provider } from './near-env.mjs'

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
    console.log(`  ${k.public_key}`)
    console.log(`    receiver_id   ${fc.receiver_id}`)
    console.log(`    method_names  [${(fc.method_names ?? []).join(', ') || '*** ANY METHOD ***'}]`)
    console.log(`    allowance     ${fc.allowance ? fromYocto(fc.allowance) + ' NEAR (gas only)' : 'unlimited'}`)
    console.log('    cannot transfer NEAR, cannot add keys — enforced by the runtime')

    // An empty method_names list means "any method on that contract". Passing
    // methodNames is optional in near-api-js, so this is a real footgun; the
    // check exists so a regression would be loud rather than silent.
    if (!fc.method_names?.length) {
      console.log('    ^ FAIL: unrestricted within the contract')
      failures++
    }
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

// The spend budget is the second, independent bound — the key's allowance
// covers gas only, so without this a scoped key could still shop without limit.
console.log('Spend budgets (the second bound, enforced by the market contract)\n')
for (const agent of manifest.agents ?? []) {
  const credit = await p.callFunction({
    contractId: manifest.contracts.market,
    method: 'credit_of',
    args: { account_id: agent.account_id },
  })
  console.log(`  ${agent.account_id.padEnd(34)} ${fromYocto(credit).padStart(10)} NEAR remaining`)
}

// Say what was audited, not just that it passed. A bare "all correct" is what
// made the empty-manifest case look like a success.
const summary = `${agents.length} agent(s) audited, ${operatorKeys} operator key(s) disclosed`
console.log(
  failures
    ? `\n${failures} key check(s) FAILED  (${summary})\n`
    : `\nevery agent key is scoped as recorded — ${summary}\n`,
)
process.exit(failures ? 1 : 0)
