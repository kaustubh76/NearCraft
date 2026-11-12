// The play service, tested offline.
//
// Every dependency is injected, so this suite needs no network, no chain, no
// keys and no provider — the same reason tests/near/web.mjs can exercise the
// judge-facing page. What it does NOT prove is that the relayed call really
// costs the player nothing; that is a claim about a real node and is measured
// in contracts/integration/tests/play.rs and tests/near/gasless.mjs.
//
// The two tests worth reading first are the ones that were written to fail
// before they passed: `no response ever carries a secret key`, because this
// server is custodial, and `a call with no session is refused`, because every
// other write test would be meaningless if that one were vacuous.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlayService } from '../../backend/near/play.mjs'

const PLAYER = 'p-1d6a3c5d.x.testnet'
const SECRET = 'ed25519:5JveMEmwBF7g8LpM9vZmpaXQhnhNz4Sq5qXh1t3Secret00000000000000000000000000000000000'
const KEYS = { [`${PLAYER}#scoped`]: SECRET }

const DEPLOYMENT = {
  network: 'testnet',
  rpc: 'https://test.rpc.fastnear.com',
  contracts: { items: 'items.x.testnet', market: 'market.x.testnet', guard: 'guard.x.testnet' },
  relayer: { account_id: 'relayer.x.testnet' },
}

/// A player holding exactly what the live one holds: two methods, no
/// full-access key.
const LIMITS = [
  { publicKey: 'ed25519:pub', fullAccess: false, receiverId: 'market.x.testnet',
    methodNames: ['buy_with_credit', 'sell'], allowance: '2000000000000000000000000' },
]

function build(overrides = {}) {
  const relayed = []
  const svc = createPlayService({
    deployment: DEPLOYMENT,
    keys: KEYS,
    verifierKind: 'seed',
    onboarding: {
      signIn: async () => ({ accountId: PLAYER, created: false }),
      keyLimits: async () => LIMITS,
      ...(overrides.onboarding ?? {}),
    },
    relayer: {
      relay: async (call) => {
        relayed.push(call)
        return { outcome: { transaction: { hash: 'HASH123' } } }
      },
      ...(overrides.relayer ?? {}),
    },
    reader: {
      rpcUrl: DEPLOYMENT.rpc,
      quotes: async () => [{ merchantId: 'ironmonger.x.testnet', reason: 'because' }],
      materials: async () => ['iron_ingot', 'coal'],
      heldBy: async () => ['3', '0'],
      creditOf: async () => '18476800000000000000000',
      approvalFor: async () => '7',
      // Identical either side: the player pays nothing.
      nearBalance: async () => '100000000000000000000000',
      ...(overrides.reader ?? {}),
    },
    newSessionId: () => 'SESSION-1',
  })
  return { svc, relayed }
}

const signIn = async (svc) => (await svc.handle('POST', '/api/session', { token: 'player-1' })).body.sessionId

/// Assert a response is a refusal with this exact code. Asserting the code,
/// not merely that something failed, is the house idiom — a test that accepts
/// any error passes when the service breaks in a new way.
function refuses(res, code, status) {
  assert.equal(res.body.error, code, `expected ${code}, got ${res.body.error}`)
  if (status) assert.equal(res.status, status)
}

// ------------------------------------------------------------------- health

test('health says which verifier is actually live', async () => {
  const { svc } = build()
  const res = await svc.handle('GET', '/api/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.playable, true)
  // Reporting "oidc" here while the seed verifier runs would be the exact
  // overclaim this project spent a round removing from its own docs.
  assert.equal(res.body.verifier, 'seed')
  assert.equal(res.body.custodial, true)
})

test('an unknown route is a 404, not a 500', async () => {
  const { svc } = build()
  refuses(await svc.handle('GET', '/api/nope'), 'NOT_FOUND', 404)
})

// ------------------------------------------------------------------ sign in

test('signing in returns a session and the methods the CHAIN grants', async () => {
  const { svc } = build()
  const res = await svc.handle('POST', '/api/session', { token: 'player-1' })
  assert.equal(res.status, 200)
  assert.equal(res.body.accountId, PLAYER)
  assert.deepEqual(res.body.permittedMethods, ['buy_with_credit', 'sell'])
  assert.equal(res.body.fullAccessKeys, 0)
})

test('signing in without a token is refused', async () => {
  const { svc } = build()
  refuses(await svc.handle('POST', '/api/session', {}), 'NO_TOKEN', 400)
})

test('signing in is refused when this server holds no key for the account', async () => {
  const { svc } = build({ onboarding: { signIn: async () => ({ accountId: 'someone-else.x.testnet' }) } })
  // Better to fail the sign-in than hand back a session that cannot act.
  refuses(await svc.handle('POST', '/api/session', { token: 'x' }), 'NO_PLAYER_KEY', 503)
})

test('an underfunded root is a 503 naming the faucet, not a stack trace', async () => {
  const { svc } = build({
    onboarding: {
      signIn: async () => { throw new Error('NotEnoughBalanceError: needs 609...') },
    },
  })
  const res = await svc.handle('POST', '/api/session', { token: 'brand-new' })
  refuses(res, 'ROOT_UNDERFUNDED', 503)
  assert.match(res.body.detail, /faucet/)
  assert.match(res.body.detail, /already onboarded can still sign in/)
})

// ------------------------------------------------------------------ session

test('a call with no session is refused', async () => {
  const { svc, relayed } = build()
  refuses(await svc.handle('POST', '/api/buy', { merchantId: 'm.x.testnet', item: 'iron_ingot', count: 3 }),
    'NO_SESSION', 401)
  assert.equal(relayed.length, 0, 'nothing may be relayed without a session')
})

test('an unknown session is refused rather than treated as anonymous', async () => {
  const { svc } = build()
  refuses(await svc.handle('GET', '/api/me', { sessionId: 'INVENTED' }), 'SESSION_UNKNOWN', 401)
})

// ------------------------------------------------------------------- buying

test('a buy is relayed as buy_with_credit and costs the player exactly nothing', async () => {
  const { svc, relayed } = build()
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/buy', { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 3 })

  assert.equal(res.status, 200)
  assert.equal(relayed[0].methodName, 'buy_with_credit')
  assert.deepEqual(relayed[0].args, { merchant_id: 'ironmonger.x.testnet', item: 'iron_ingot', count: 3 })
  assert.equal(res.body.hash, 'HASH123')
  assert.equal(res.body.playerNearDelta, '0')
})

test('a malformed order is refused by code before anything is relayed', async () => {
  const { svc, relayed } = build()
  const sessionId = await signIn(svc)
  refuses(await svc.handle('POST', '/api/buy', { sessionId, merchantId: 'm.x.testnet', item: 'Iron Ingot', count: 3 }),
    'ITEM_MALFORMED', 400)
  refuses(await svc.handle('POST', '/api/buy', { sessionId, merchantId: 'm.x.testnet', item: 'iron_ingot', count: 99 }),
    'COUNT_OUT_OF_STACK_RANGE', 400)
  assert.equal(relayed.length, 0)
})

// ------------------------------------------------------------------ selling

test('a sell quotes the approval id read from the chain, not from the caller', async () => {
  const { svc, relayed } = build()
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/sell',
    { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 2, approvalId: '999' })

  assert.equal(res.status, 200)
  assert.equal(relayed[0].methodName, 'sell')
  // '7' from the chain, never the '999' the caller supplied. A string, not a
  // number: approval_id is a U64 and the contract refuses an integer.
  assert.equal(relayed[0].args.approval_id, '7')
})

test('selling without an approval explains why a scoped key cannot make one', async () => {
  const { svc } = build({ reader: { approvalFor: async () => null } })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/sell', { sessionId, merchantId: 'm.x.testnet', item: 'iron_ingot', count: 1 })
  refuses(res, 'NO_APPROVAL')
  assert.match(res.body.detail, /granted once at onboarding/)
})

// ---------------------------------------------------------------- investing

test('invest is refused for a key that does not grant it, and says it never can', async () => {
  const { svc, relayed } = build()
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/invest',
    { sessionId, merchantId: 'ironmonger.x.testnet', amount: '50000000000000000000000' })

  // The live player's key predates invest_with_credit. The product should
  // surface that property, not error on it.
  refuses(res, 'METHOD_NOT_PERMITTED', 403)
  assert.match(res.body.detail, /immutable for life/)
  assert.equal(relayed.length, 0)
})

test('invest works for a key that was issued with it', async () => {
  const { svc, relayed } = build({
    onboarding: {
      keyLimits: async () => [{ ...LIMITS[0], methodNames: ['buy_with_credit', 'sell', 'invest_with_credit'] }],
    },
  })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/invest',
    { sessionId, merchantId: 'ironmonger.x.testnet', amount: '50000000000000000000000' })
  assert.equal(res.status, 200)
  assert.equal(relayed[0].methodName, 'invest_with_credit')
})

// ----------------------------------------------------------------------- me

test('me reports the key limits read back from the protocol', async () => {
  const { svc } = build()
  const sessionId = await signIn(svc)
  const res = await svc.handle('GET', '/api/me', { sessionId })
  assert.equal(res.body.fullAccessKeys, 0)
  assert.equal(res.body.scopedKeys, 1)
  assert.equal(res.body.holdings.iron_ingot, '3')
})

// ------------------------------------------------------- the custodial check

test('no response ever carries a secret key', async () => {
  // This server holds players' signing keys. Every route is swept rather than
  // the obvious ones, because the leak that matters is the one nobody thought
  // to look for — and a new route added later is caught by this loop.
  const { svc } = build()
  const sessionId = await signIn(svc)
  const calls = [
    ['GET', '/api/health', {}],
    ['POST', '/api/session', { token: 'player-1' }],
    ['GET', '/api/materials', {}],
    ['GET', '/api/market', { item: 'iron_ingot', count: 1 }],
    ['GET', '/api/me', { sessionId }],
    ['POST', '/api/buy', { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 }],
    ['POST', '/api/sell', { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 }],
    ['GET', '/api/nope', {}],
  ]
  for (const [m, p, b] of calls) {
    const res = await svc.handle(m, p, b)
    const serialised = JSON.stringify(res.body ?? {})
    assert.ok(!serialised.includes(SECRET), `${m} ${p} leaked the player's secret key`)
    assert.ok(!/ed25519:[A-Za-z0-9]{60,}/.test(serialised), `${m} ${p} returned something shaped like a secret key`)
  }
})

test('an unexpected failure returns a code, never a stack', async () => {
  const { svc } = build({ reader: { materials: async () => { throw new Error('boom at line 42\n  at foo') } } })
  const res = await svc.handle('GET', '/api/materials')
  assert.equal(res.status, 500)
  assert.equal(res.body.error, 'INTERNAL')
  assert.ok(!String(res.body.detail).includes('    at '), 'a stack must not reach the client')
})

// ------------------------------------------- the failure that looked like 200

test('a relayed call that panicked is NOT reported as success', async () => {
  // This shipped. A sell panicked inside the contract on a malformed
  // approval_id, the OUTER transaction succeeded because the relayer's
  // submission was fine, and the service answered 200 with a transaction hash.
  // The player would have seen "sold" and still been holding the iron.
  const { svc } = build({
    relayer: {
      relay: async () => {
        const e = new Error('INNER_CALL_FAILED: Smart contract panicked')
        e.code = 'INNER_CALL_FAILED'
        throw e
      },
    },
  })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/buy',
    { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 })

  assert.equal(res.status, 502, 'a panicked call is an upstream failure, not a 200')
  assert.equal(res.body.error, 'INNER_CALL_FAILED')
  assert.ok(!('hash' in res.body), 'a failed call must not hand back a transaction hash')
})

test('an approval id must be the string the chain gave, not a number', async () => {
  // approval_id is a U64. NEAR serialises those as JSON strings, and the
  // contract refuses an integer with "invalid type: integer, expected a
  // string" — which is what a Number() conversion caused on a live sell.
  const { svc } = build({ reader: { approvalFor: async () => 7 } })
  const sessionId = await signIn(svc)
  refuses(await svc.handle('POST', '/api/sell',
    { sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 }),
    'APPROVAL_ID_MALFORMED', 400)
})
