// The policy layer refuses before anything is signed. Offline; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPolicy, authorize, intentId, PolicyRefusal } from '../../backend/near/policy.mjs'

const MARKET = 'market.nearcraftmc.testnet'
const policy = agentPolicy({
  agentId: 'worker-1.nearcraftmc.testnet',
  marketContract: MARKET,
  methods: ['buy_with_credit'],
  maxUnitsPerOrder: 32,
})

const good = {
  contractId: MARKET,
  methodName: 'buy_with_credit',
  args: { merchant_id: 'ironmonger.nearcraftmc.testnet', item: 'iron_ingot', count: 8 },
}

/// Asserts a refusal with a specific code — a test that only checked "it threw"
/// would pass even if the wrong guard fired.
function refuses(code, request, opts) {
  assert.throws(() => authorize(policy, request, opts), (e) => {
    assert.ok(e instanceof PolicyRefusal, `expected PolicyRefusal, got ${e?.name}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code}`)
    return true
  })
}

test('a well-formed purchase is authorised and normalised', () => {
  const intent = authorize(policy, good)
  assert.equal(intent.methodName, 'buy_with_credit')
  assert.equal(intent.args.count, 8)
  assert.equal(intent.deposit, '0', 'a function-call key can never attach NEAR')
  assert.ok(Object.isFrozen(intent), 'the intent must not be mutable after authorisation')
})

test('an empty method list is refused at construction, not treated as "any"', () => {
  // This is how NEAR reads an empty `method_names`, and it is the wrong default.
  assert.throws(
    () => agentPolicy({ agentId: 'a.testnet', marketContract: MARKET, methods: [], maxUnitsPerOrder: 1 }),
    (e) => e.code === 'POLICY_EMPTY_METHOD_LIST',
  )
})

test('a policy without an order cap is refused', () => {
  assert.throws(
    () => agentPolicy({ agentId: 'a.testnet', marketContract: MARKET, methods: ['buy_with_credit'], maxUnitsPerOrder: 0 }),
    (e) => e.code === 'POLICY_NO_ORDER_CAP',
  )
})

test('another contract is refused', () => {
  refuses('CONTRACT_NOT_PERMITTED', { ...good, contractId: 'attacker.testnet' })
})

test('another method on the right contract is refused', () => {
  for (const methodName of ['withdraw', 'withdraw_treasury', 'register_merchant', 'fund_credit', 'buy']) {
    refuses('METHOD_NOT_PERMITTED', { ...good, methodName })
  }
})

test('an attached deposit is refused', () => {
  refuses('DEPOSIT_NOT_PERMITTED', { ...good, deposit: '1000000000000000000000000' })
})

test('unexpected and missing arguments are both refused', () => {
  refuses('UNEXPECTED_ARGUMENT', { ...good, args: { ...good.args, recipient: 'attacker.testnet' } })
  refuses('MISSING_ARGUMENT', { ...good, args: { item: 'iron_ingot', count: 1 } })
})

test('a merchant outside this world is refused', () => {
  refuses('MERCHANT_OUTSIDE_WORLD', { ...good, args: { ...good.args, merchant_id: 'attacker.testnet' } })
  refuses('MERCHANT_OUTSIDE_WORLD', { ...good, args: { ...good.args, merchant_id: 'evil.othergame.testnet' } })
})

test('malformed identifiers are refused', () => {
  refuses('MERCHANT_ID_MALFORMED', { ...good, args: { ...good.args, merchant_id: 'NOT AN ACCOUNT' } })
  refuses('ITEM_MALFORMED', { ...good, args: { ...good.args, item: '../../etc/passwd' } })
  refuses('ITEM_MALFORMED', { ...good, args: { ...good.args, item: 'Iron Ingot' } })
})

test('counts must be positive integers within the order cap', () => {
  for (const count of [0, -1, 1.5, '8', null, NaN]) {
    refuses('COUNT_NOT_A_POSITIVE_INTEGER', { ...good, args: { ...good.args, count } })
  }
  refuses('ORDER_TOO_LARGE', { ...good, args: { ...good.args, count: 33 } })
  assert.equal(authorize(policy, { ...good, args: { ...good.args, count: 32 } }).args.count, 32)
})

test('only one order may be outstanding at a time', () => {
  refuses('ORDER_ALREADY_OUTSTANDING', good, { outstanding: 1 })
})

test('intent ids are stable and distinguish every field', () => {
  const a = intentId(authorize(policy, good))
  assert.equal(a, intentId(authorize(policy, good)), 'same request, same id')
  const b = intentId(authorize(policy, { ...good, args: { ...good.args, count: 9 } }))
  assert.notEqual(a, b, 'a different count must be a different intent')
})

test('non-object requests are refused rather than coerced', () => {
  for (const request of [null, undefined, 'buy', 42, []]) {
    assert.throws(() => authorize(policy, request), (e) => e instanceof PolicyRefusal)
  }
})
