// The warn -> human path. Offline: every assertion below lands before the
// signer would touch the network, which is the point — a call awaiting a person
// must not have been signed already.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPolicy } from '../../backend/near/policy.mjs'
import { createAgentSigner, HumanApprovalRequired, PolicyRefusal } from '../../backend/near/signer.mjs'
import { ALLOW, BLOCK, WARN } from '../../backend/near/counterparty.mjs'
import { KeyPair } from 'near-api-js'

/// Generated per run, never committed. Nothing here gets far enough to sign
/// with it, but the hackathon checklist requires no keys anywhere in the repo
/// history and a scanner cannot tell a decoy from a real one.
const THROWAWAY_KEY = KeyPair.fromRandom('ed25519').toString()

const MARKET = 'market.nearcraftmc.testnet'
const policy = agentPolicy({
  agentId: 'worker-1.nearcraftmc.testnet',
  marketContract: MARKET,
  methods: ['buy_with_credit'],
  maxUnitsPerOrder: 32,
})

/// A stand-in counterparty service whose verdict the test controls.
function fakeCounterparty(verdict, reasons = ['because the test says so']) {
  const calls = []
  return {
    service: {
      async check(agentId, accountId) { calls.push({ agentId, accountId }); return { verdict, reasons, signals: {} } },
      async recordSuccess() {},
    },
    calls,
  }
}

const request = {
  contractId: MARKET,
  methodName: 'buy_with_credit',
  args: { merchant_id: 'ironmonger.nearcraftmc.testnet', item: 'iron_ingot', count: 4 },
}

function signer(counterparty) {
  return createAgentSigner({ policy, secretKey: THROWAWAY_KEY, counterparty })
}

test('block refuses before anything is signed', async () => {
  const { service, calls } = fakeCounterparty(BLOCK, ['3 reporters and the code changed'])
  const s = signer(service)
  await assert.rejects(() => s.call(request), (e) => {
    assert.ok(e instanceof PolicyRefusal)
    assert.equal(e.code, 'COUNTERPARTY_BLOCKED')
    assert.match(e.message, /code changed/)
    return true
  })
  assert.equal(calls.length, 1, 'the counterparty was consulted')
  assert.equal(s.pendingDecisions().length, 0, 'a block is not a thing for a human to approve')
})

test('warn parks the call for a human instead of signing or dropping it', async () => {
  const { service } = fakeCounterparty(WARN, ['no prior interaction', 'barely-used account'])
  const s = signer(service)

  await assert.rejects(() => s.call(request), (e) => {
    assert.ok(e instanceof HumanApprovalRequired, `expected HumanApprovalRequired, got ${e?.name}`)
    assert.equal(e.code, 'HUMAN_APPROVAL_REQUIRED')
    assert.deepEqual(e.reasons, ['no prior interaction', 'barely-used account'])
    return true
  })

  const waiting = s.pendingDecisions()
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].merchantId, 'ironmonger.nearcraftmc.testnet')
  assert.equal(waiting[0].item, 'iron_ingot')
  assert.equal(waiting[0].count, 4)
  assert.ok(waiting[0].reasons.length, 'a person needs the reasons to decide')
  assert.ok(waiting[0].intentId)
})

// The distinct error type is the whole reason a caller can behave correctly.
test('a refusal and a pending decision are different types', async () => {
  const blocked = signer(fakeCounterparty(BLOCK).service)
  const warned = signer(fakeCounterparty(WARN).service)

  const a = await blocked.call(request).catch((e) => e)
  const b = await warned.call(request).catch((e) => e)
  assert.ok(a instanceof PolicyRefusal && !(a instanceof HumanApprovalRequired))
  assert.ok(b instanceof HumanApprovalRequired && !(b instanceof PolicyRefusal))
})

test('rejecting discards the call and signs nothing', async () => {
  const { service } = fakeCounterparty(WARN)
  const s = signer(service)
  await s.call(request).catch(() => {})
  const [held] = s.pendingDecisions()

  s.reject(held.intentId, 'I do not recognise that merchant')
  assert.equal(s.pendingDecisions().length, 0)
  assert.throws(() => s.reject(held.intentId), (e) => e.code === 'NO_SUCH_PENDING_DECISION')
})

// A human approval is permission to proceed, not permission to override safety.
test('an approval cannot override a counterparty that has since been blocked', async () => {
  let verdict = WARN
  const service = {
    async check() { return { verdict, reasons: ['it changed under us'], signals: {} } },
    async recordSuccess() {},
  }
  const s = createAgentSigner({
    policy,
    secretKey: THROWAWAY_KEY,
    counterparty: service,
  })

  await s.call(request).catch(() => {})
  const [held] = s.pendingDecisions()

  // Between the human seeing it and clicking approve, the account got reported.
  verdict = BLOCK
  await assert.rejects(() => s.approve(held.intentId), (e) => {
    assert.equal(e.code, 'COUNTERPARTY_BLOCKED_SINCE_APPROVAL')
    return true
  })
  assert.equal(s.pendingDecisions().length, 0, 'the parked call is consumed either way')
})

test('approving something that is not pending is refused', async () => {
  const s = signer(fakeCounterparty(WARN).service)
  await assert.rejects(() => s.approve('not-an-intent'), (e) => e.code === 'NO_SUCH_PENDING_DECISION')
})

test('an unrecognised verdict is not treated as permission', async () => {
  const s = signer({ async check() { return { verdict: 'probably-fine', reasons: [], signals: {} } } })
  await assert.rejects(() => s.call(request), (e) => {
    assert.equal(e.code, 'COUNTERPARTY_VERDICT_UNKNOWN')
    return true
  })
})

test('policy refusal still happens before the counterparty is even consulted', async () => {
  // Screening costs a network round trip, so an out-of-policy call should never
  // pay for one.
  const { service, calls } = fakeCounterparty(ALLOW)
  const s = signer(service)
  await assert.rejects(() => s.call({ ...request, methodName: 'withdraw' }), (e) => {
    assert.equal(e.code, 'METHOD_NOT_PERMITTED')
    return true
  })
  assert.equal(calls.length, 0, 'no counterparty lookup for a call that was never allowed')
})

test('with no counterparty service wired in, screening is skipped not faked', async () => {
  // Pointed at a closed port so this fails instantly instead of waiting on a
  // real RPC timeout — a unit test that needs the internet is a liability.
  const s = createAgentSigner({
    policy,
    secretKey: THROWAWAY_KEY,
    counterparty: null,
    rpcUrl: 'http://127.0.0.1:1',
  })
  // It gets past screening and fails reaching the node, which proves screening
  // neither silently refused nor silently approved.
  const err = await s.call(request).catch((e) => e)
  assert.ok(!(err instanceof HumanApprovalRequired), 'must not invent a pending decision')
  assert.notEqual(err?.code, 'COUNTERPARTY_BLOCKED', 'must not invent a block')
  assert.ok(err, 'it should have tried and failed at the transport, not been refused')
})
