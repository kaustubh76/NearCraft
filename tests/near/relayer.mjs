// The relayer's own guards, offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRelayer, playerCall, RelayRefusal } from '../../backend/near/relayer.mjs'
import { KeyPair } from 'near-api-js'

/// Generated per run; never committed. Nothing here signs with it.
const THROWAWAY_KEY = KeyPair.fromRandom('ed25519').toString()

const MARKET = 'market.nearcraftmc.testnet'
const base = {
  relayerAccountId: 'relayer.nearcraftmc.testnet',
  relayerKey: THROWAWAY_KEY,
  marketContract: MARKET,
  permittedMethods: ['buy_with_credit'],
}

test('a delegate action is built with no deposit, by construction', () => {
  const built = playerCall({ marketContract: MARKET, methodName: 'buy_with_credit', args: { count: 1 } })
  assert.equal(built.receiverId, MARKET)
  assert.equal(built.actions.length, 1)
  // Measured in the sandbox: nearcore refuses a deposit on the inner action of
  // a delegate signed by a function-call key. There is deliberately no deposit
  // parameter, so a caller cannot build something unrelayable.
  assert.equal(built.actions[0].functionCall.deposit, 0n)
})

test('a relayer that would submit anything is refused at construction', () => {
  // Otherwise it is an open faucet for whoever asks.
  assert.throws(() => createRelayer({ ...base, permittedMethods: [] }), (e) => {
    assert.ok(e instanceof RelayRefusal)
    assert.equal(e.code, 'EMPTY_METHOD_LIST')
    return true
  })
  assert.throws(() => createRelayer({ ...base, relayerKey: null }), (e) => e.code === 'NO_RELAYER_KEY')
})

test('the relayer keeps its own allowlist rather than trusting the caller', async () => {
  const r = createRelayer(base)
  await assert.rejects(
    () => r.relay({ playerAccountId: 'p.testnet', playerKey: THROWAWAY_KEY, methodName: 'withdraw' }),
    (e) => { assert.equal(e.code, 'METHOD_NOT_RELAYED'); return true },
  )
})

test('building a call without a method or market is refused', () => {
  assert.throws(() => playerCall({ marketContract: MARKET }), (e) => e.code === 'NO_METHOD')
  assert.throws(() => playerCall({ methodName: 'buy_with_credit' }), (e) => e.code === 'NO_MARKET_CONTRACT')
})
