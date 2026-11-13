// Does the agent ever actually check the key it signs with?
//
// `verifyKeyScope` has been in `signer.mjs` since the beginning. It asks the
// chain what the agent's access key may really do and refuses to go on if the
// answer is "anything": a full-access key, a key pointed at the wrong contract,
// a key with an empty `method_names` (which the protocol reads as EVERY
// method), or one naming a method the policy does not.
//
// The audit found that NOTHING CALLED IT. `grep -rn verifyKeyScope backend
// scripts tests` returned the definition, one prose mention in a comment
// claiming it "still holds", and the export — no call site anywhere. The
// comment at signer.mjs:91 leans on it explicitly while screening is skipped,
// so the one guarantee the agent made when it had no counterparty service was
// never checked.
//
// A defence that never runs is not a defence. These tests pin that it runs
// before a signature, on both signing paths, and that each refusal is reached.
//
// The chain is a `node:http` stub here, which is the real RPC contract — the
// signer's own `JsonRpcProvider` does the POST and parses the reply. What is
// faked is only what the node would answer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyPair } from 'near-api-js'
import { agentPolicy } from '../../backend/near/policy.mjs'
import { createAgentSigner, PolicyRefusal } from '../../backend/near/signer.mjs'
import { WARN } from '../../backend/near/counterparty.mjs'
import { scopedTo, stubNode as nodeAnswering } from './stub-node.mjs'

const THROWAWAY_KEY = KeyPair.fromRandom('ed25519').toString()
const MARKET = 'market.nearcraftmc.testnet'
const AGENT = 'worker-1.nearcraftmc.testnet'

const scoped = scopedTo('market.nearcraftmc.testnet', ['buy_with_credit'])

const policy = agentPolicy({
  agentId: AGENT,
  marketContract: MARKET,
  methods: ['buy_with_credit'],
  maxUnitsPerOrder: 32,
})

const request = {
  contractId: MARKET,
  methodName: 'buy_with_credit',
  args: { merchant_id: 'ironmonger.nearcraftmc.testnet', item: 'iron_ingot', count: 4 },
}


/// Drive a call far enough to need a signature, and report how it refused.
async function refusalFrom(permission) {
  const node = await nodeAnswering(permission)
  try {
    const s = createAgentSigner({ policy, secretKey: THROWAWAY_KEY, rpcUrl: node.rpcUrl })
    return await s.call(request).then(() => null, (e) => e)
  } finally {
    await node.close()
  }
}

test('a full-access key stops the agent before it signs', async () => {
  const e = await refusalFrom('FullAccess')
  assert.ok(e instanceof PolicyRefusal, `expected a PolicyRefusal, got ${e?.name}: ${e?.message}`)
  assert.equal(e.code, 'AGENT_KEY_IS_FULL_ACCESS')
})

test('a key scoped to the wrong contract stops the agent', async () => {
  const e = await refusalFrom({ FunctionCall: { receiver_id: 'someone-else.testnet', method_names: ['buy_with_credit'] } })
  assert.equal(e?.code, 'AGENT_KEY_WRONG_RECEIVER')
})

test('an empty method list stops the agent, because the protocol reads it as every method', async () => {
  const e = await refusalFrom({ FunctionCall: { receiver_id: MARKET, method_names: [] } })
  assert.equal(e?.code, 'AGENT_KEY_UNRESTRICTED')
})

test('a key wider than the policy stops the agent', async () => {
  const e = await refusalFrom({ FunctionCall: { receiver_id: MARKET, method_names: ['buy_with_credit', 'withdraw'] } })
  assert.equal(e?.code, 'AGENT_KEY_WIDER_THAN_POLICY')
  assert.match(e.detail ?? e.message, /withdraw/)
})

test('an unreadable permission is not read as permission', async () => {
  const e = await refusalFrom({ SomethingNearcoreDoesNotHaveYet: {} })
  assert.equal(e?.code, 'AGENT_KEY_PERMISSION_UNREADABLE')
})

test('the scope is checked once and then remembered', async () => {
  const node = await nodeAnswering(scoped)
  try {
    const s = createAgentSigner({ policy, secretKey: THROWAWAY_KEY, rpcUrl: node.rpcUrl })
    // Each call gets past the scope check and then fails at the stub, which
    // cannot actually broadcast a transaction. Reaching that failure is the
    // proof the scope check passed.
    await s.call(request).catch(() => {})
    await s.call(request).catch(() => {})
    assert.equal(node.scopeQueries(), 1, 'the key scope should cost one RPC, not one per call')
  } finally {
    await node.close()
  }
})

test('a key widened while a person was deciding is caught on approval', async () => {
  // The one window long enough to matter. `call` checks the scope and parks
  // the trade for a human; the key is then deleted and re-added as full-access
  // — same public key, wider permission, which NEAR allows — and the person
  // says yes. The approval is permission to make that trade, never permission
  // to sign it with a key the agent was built to refuse.
  //
  // This is also why `approve` re-reads the chain instead of the memo. Against
  // a memo it could not fail, and a check that cannot fail is not a check.
  const node = await nodeAnswering(scoped)
  try {
    const counterparty = {
      async check() { return { verdict: WARN, reasons: ['a person should look'], signals: {} } },
      async recordSuccess() { throw new Error('a refused call must never record success') },
    }
    const s = createAgentSigner({ policy, secretKey: THROWAWAY_KEY, rpcUrl: node.rpcUrl, counterparty })
    const parked = await s.call(request).then(() => null, (e) => e)
    assert.equal(parked?.code, 'HUMAN_APPROVAL_REQUIRED', 'the warn should park it for a person')

    node.becomes('FullAccess')

    const e = await s.approve(parked.intentId).then(() => null, (x) => x)
    assert.ok(e instanceof PolicyRefusal, `expected a PolicyRefusal, got ${e?.name}: ${e?.message}`)
    assert.equal(e.code, 'AGENT_KEY_IS_FULL_ACCESS')
  } finally {
    await node.close()
  }
})

test('a full-access key is refused before a person is ever bothered', async () => {
  // The scope check runs ahead of screening, so a key the agent must refuse
  // never reaches a human at all. Raising a decision nobody can act on is
  // worse than refusing it.
  const node = await nodeAnswering('FullAccess')
  try {
    let asked = false
    const counterparty = {
      async check() { asked = true; return { verdict: WARN, reasons: ['look'], signals: {} } },
      async recordSuccess() {},
    }
    const s = createAgentSigner({ policy, secretKey: THROWAWAY_KEY, rpcUrl: node.rpcUrl, counterparty })
    const e = await s.call(request).then(() => null, (x) => x)
    assert.equal(e?.code, 'AGENT_KEY_IS_FULL_ACCESS')
    assert.equal(asked, false, 'no person should be asked about a call that cannot be signed')
  } finally {
    await node.close()
  }
})

test('an out-of-policy request is still refused without touching the network', async () => {
  // The scope check must not be moved ahead of `authorize`. That property is
  // documented on `call` and is why a malformed request costs nothing.
  const node = await nodeAnswering(scoped)
  try {
    const s = createAgentSigner({ policy, secretKey: THROWAWAY_KEY, rpcUrl: node.rpcUrl })
    const e = await s.call({ ...request, args: { ...request.args, count: 9999 } }).then(() => null, (x) => x)
    assert.ok(e instanceof PolicyRefusal, `expected a PolicyRefusal, got ${e?.name}`)
    assert.equal(node.seen.length, 0, 'an out-of-policy request must not reach the node at all')
  } finally {
    await node.close()
  }
})
