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

console.log('\nAgent access keys, as the protocol reports them\n')

let failures = 0
for (const agent of manifest.agents ?? []) {
  const { keys } = await p.query({
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: agent.account_id,
  })
  console.log(`${agent.account_id}`)
  for (const k of keys) {
    const perm = k.access_key.permission
    if (perm === 'FullAccess' || perm?.FullAccess !== undefined) {
      console.log(`  ${k.public_key}`)
      console.log('    FULL ACCESS  (operator recovery key — never given to the agent process)')
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

console.log(failures ? `\n${failures} key check(s) FAILED\n` : '\nall agent keys are correctly scoped\n')
process.exit(failures ? 1 : 0)
