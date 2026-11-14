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

let minted = 0
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
    // Distinct ids, because the link code mints a SECOND session and a test
    // that cannot tell them apart cannot check that they are separate.
    agents: overrides.agents ?? null,
    newSessionId: overrides.newSessionId ?? (() => `SESSION-${++minted}`),
    now: overrides.now,
    log: overrides.log,
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

// --------------------------------------------------- the one-time server key

test('a newly onboarded player\'s key is kept and handed to the operator', async () => {
  // signIn returns serverKey only on the run that CREATES the account, and
  // deletes that account's full-access key in the same transaction. A service
  // that only ever looks keys up would refuse the very player it just made.
  const saved = []
  const { svc, relayed } = build({
    onboarding: {
      signIn: async () => ({ accountId: 'p-new.x.testnet', created: true, serverKey: 'ed25519:BRANDNEWKEY' }),
    },
  })
  // Rebuild with a saveKey hook, since build() does not take one.
  const svc2 = (await import('../../backend/near/play.mjs')).createPlayService({
    deployment: DEPLOYMENT,
    keys: {},
    onboarding: {
      signIn: async () => ({ accountId: 'p-new.x.testnet', created: true, serverKey: 'ed25519:BRANDNEWKEY' }),
      keyLimits: async () => LIMITS,
    },
    relayer: { relay: async () => ({ outcome: { transaction: { hash: 'H' } } }) },
    reader: { nearBalance: async () => '1', materials: async () => [], heldBy: async () => [],
              creditOf: async () => '0', approvalFor: async () => null, quotes: async () => [] },
    saveKey: async (id, secret) => { saved.push([id, secret]) },
    newSessionId: () => 'S2',
  })
  const res = await svc2.handle('POST', '/api/session', { token: 'brand-new' })
  assert.equal(res.status, 200)
  assert.deepEqual(saved, [['p-new.x.testnet', 'ed25519:BRANDNEWKEY']])
  // And the key must not come back to the caller.
  assert.ok(!JSON.stringify(res.body).includes('BRANDNEWKEY'))
  void svc, relayed
})

test('if the one-time key cannot be persisted the sign-in is refused', async () => {
  // Better to refuse than to hand back a session that works until restart and
  // then strands an account nothing can ever re-key.
  const svc = (await import('../../backend/near/play.mjs')).createPlayService({
    deployment: DEPLOYMENT,
    keys: {},
    onboarding: {
      signIn: async () => ({ accountId: 'p-new.x.testnet', created: true, serverKey: 'ed25519:BRANDNEWKEY' }),
      keyLimits: async () => LIMITS,
    },
    relayer: { relay: async () => ({}) },
    reader: { nearBalance: async () => '1', materials: async () => [], heldBy: async () => [],
              creditOf: async () => '0', approvalFor: async () => null, quotes: async () => [] },
    saveKey: async () => { throw new Error('disk full') },
    newSessionId: () => 'S3',
  })
  refuses(await svc.handle('POST', '/api/session', { token: 'brand-new' }), 'KEY_NOT_PERSISTED', 500)
})

// ---------------------------------------------------------------------------
// Three failures that were only ever found by attempting a real login. Each one
// was invisible because signing in as an EXISTING player takes an early return
// and never touches the chain, so every test and every demo passed.

test('a server with no root key says so, instead of blaming the login', async () => {
  // near-api-js throws "Please set a signer" from deep inside the account
  // creation. The service used to relay that as IDENTITY_REJECTED with a 401,
  // telling a player their perfectly good token was refused.
  const { svc } = build({
    onboarding: {
      signIn: async () => { throw new Error('Please set a signer') },
    },
  })
  const res = await svc.handle('POST', '/api/session', { token: 'player-1' })
  refuses(res, 'ONBOARDING_MISCONFIGURED', 503)
  assert.match(res.body.detail, /not a problem with your login/)
})

test('an underfunded root is reported as such, in the words nearcore actually uses', async () => {
  // The real message is "Not enough balance for X (balance: N, cost: M)". The
  // pattern here used to look for `NotEnoughBalance` — the name of the error
  // variant, not the text — so ROOT_UNDERFUNDED was documented in README.md
  // and unreachable in code. Both spellings are covered now so neither can
  // silently stop matching.
  for (const message of [
    'Not enough balance for nearcraftmc.testnet (balance: 91080802419303700000000, cost: 107607442456250000000000)',
    'NotEnoughBalance',
    'account has insufficient funds',
  ]) {
    const { svc } = build({ onboarding: { signIn: async () => { throw new Error(message) } } })
    const res = await svc.handle('POST', '/api/session', { token: 'player-1' })
    refuses(res, 'ROOT_UNDERFUNDED', 503)
    assert.match(res.body.detail, /near-faucet\.io/, 'the refusal must say how to fix it')
  }
})

test('an identity refusal keeps the code the verifier gave it', async () => {
  // Twenty distinct refusals used to arrive as one. A caller cannot tell
  // "your token expired, sign in again" from "the provider is unreachable"
  // unless the code survives the trip.
  for (const [code, status] of [['TOKEN_EXPIRED', 401], ['WRONG_AUDIENCE', 401], ['JWKS_UNREACHABLE', 502]]) {
    const { svc } = build({
      onboarding: {
        signIn: async () => {
          const e = new Error(`${code}: whatever the verifier said`)
          e.code = 'IDENTITY_REJECTED'
          e.identityCode = code
          e.detail = 'the verifier detail'
          throw e
        },
      },
    })
    const res = await svc.handle('POST', '/api/session', { token: 'x' })
    refuses(res, code, status)
    assert.equal(res.body.detail, 'the verifier detail')
  }
})

test('health says whether this deployment can create a new player', async () => {
  // Reported, rather than discovered by the first person who tries to sign up.
  const { svc } = build()
  assert.equal((await svc.handle('GET', '/api/health', {})).body.canOnboard, null,
    'unknown is null, not a cheerful true')
})

// ---------------------------------------------------------------------------
// The link code. A Google id token is 977 characters and Minecraft caps input
// at 256, so this is the only way a real login reaches the game. It is a bearer
// credential, so every property below is load-bearing.

const claim = (svc, code) => svc.handle('POST', '/api/link', { code })
const mintCode = async (svc, sessionId) => svc.handle('POST', '/api/link-code', { sessionId })

test('a code signs a second client in on the same account', async () => {
  const { svc } = build()
  const browserSession = await signIn(svc)
  const minted = await mintCode(svc, browserSession)
  assert.equal(minted.status, 200, JSON.stringify(minted.body))

  const code = minted.body.code
  assert.equal(code.length, 8, 'eight characters is what a person is asked to type')
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/, 'Crockford base32: no I, L, O or U to misread')

  const claimed = await claim(svc, code)
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
  assert.equal(claimed.body.accountId, PLAYER, 'the same account, or it is not a link')
  assert.notEqual(claimed.body.sessionId, browserSession,
    'a NEW session, so quitting the game does not sign the browser out')
  assert.deepEqual(claimed.body.permittedMethods, ['buy_with_credit', 'sell'])
  assert.equal(claimed.body.fullAccessKeys, 0)

  // And the new session can actually trade.
  const bought = await svc.handle('POST', '/api/buy',
    { sessionId: claimed.body.sessionId, merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 })
  assert.equal(bought.status, 200, 'a claimed session must be a working session')
})

test('a code works exactly once', async () => {
  const { svc } = build()
  const sessionId = await signIn(svc)
  const code = (await mintCode(svc, sessionId)).body.code
  assert.equal((await claim(svc, code)).status, 200)
  refuses(await claim(svc, code), 'LINK_CODE_INVALID', 401)
})

test('a code expires', async () => {
  let clock = 1_000_000
  const { svc } = build({ now: () => clock })
  const sessionId = await signIn(svc)
  const code = (await mintCode(svc, sessionId)).body.code
  clock += 119_000
  assert.equal((await claim(svc, code)).status, 200, 'still valid inside the window')

  const second = (await mintCode(svc, sessionId)).body.code
  clock += 120_001
  refuses(await claim(svc, second), 'LINK_CODE_INVALID', 401)
})

test('an expired code and a wrong one are indistinguishable', async () => {
  // Otherwise this route tells an attacker which codes existed.
  let clock = 1_000_000
  const { svc } = build({ now: () => clock })
  const sessionId = await signIn(svc)
  const code = (await mintCode(svc, sessionId)).body.code
  clock += 200_000
  const expired = await claim(svc, code)
  const wrong = await claim(svc, 'ZZZZZZZZ')
  assert.deepEqual(expired.body, wrong.body, 'the two must answer identically')
})

test('guessing is capped', async () => {
  // 40 bits is a loop away without this.
  const { svc } = build()
  for (let i = 0; i < 10; i++) refuses(await claim(svc, `WRONG${String(i).padStart(3, '0')}`), 'LINK_CODE_INVALID', 401)
  refuses(await claim(svc, 'WRONG999'), 'TOO_MANY_LINK_ATTEMPTS', 429)

  // And a real code is refused too while the cap holds — fail closed.
  const sessionId = await signIn(svc)
  const real = (await mintCode(svc, sessionId)).body.code
  refuses(await claim(svc, real), 'TOO_MANY_LINK_ATTEMPTS', 429)
})

test('the cap self-heals, so guessing cannot lock anyone out for good', async () => {
  let clock = 1_000_000
  const { svc } = build({ now: () => clock })
  for (let i = 0; i < 10; i++) await claim(svc, `WRONG${String(i).padStart(3, '0')}`)
  refuses(await claim(svc, 'WRONG999'), 'TOO_MANY_LINK_ATTEMPTS', 429)
  clock += 120_001
  const sessionId = await signIn(svc)
  const real = (await mintCode(svc, sessionId)).body.code
  assert.equal((await claim(svc, real)).status, 200, 'the window must reopen')
})

test('a code cannot be minted without a verified session', async () => {
  // Otherwise this mints sessions for arbitrary accounts.
  const { svc } = build()
  refuses(await svc.handle('POST', '/api/link-code', {}), 'NO_SESSION', 401)
  refuses(await svc.handle('POST', '/api/link-code', { sessionId: 'made-up' }), 'SESSION_UNKNOWN', 401)
})

test('codes are not guessable from each other', async () => {
  const { svc } = build()
  const sessionId = await signIn(svc)
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add((await mintCode(svc, sessionId)).body.code)
  assert.equal(seen.size, 200, 'two hundred codes, two hundred distinct values')
})

test('a code is never echoed into the log', async () => {
  const lines = []
  const { svc } = build({ log: (e) => lines.push(JSON.stringify(e)) })
  const sessionId = await signIn(svc)
  const code = (await mintCode(svc, sessionId)).body.code
  await claim(svc, code)
  for (const line of lines) {
    assert.ok(!line.includes(code), `the code reached the log: ${line}`)
  }
})

test('claiming is case- and space-insensitive, because people type it', async () => {
  const { svc } = build()
  const sessionId = await signIn(svc)
  const code = (await mintCode(svc, sessionId)).body.code
  assert.equal((await claim(svc, `  ${code.toLowerCase()} `)).status, 200)
})

test('health advertises that link codes exist', async () => {
  const { svc } = build()
  assert.equal((await svc.handle('GET', '/api/health', {})).body.linkCodes, true)
})

// ------------------------------------------------------------ agent dispatch
//
// GAME_LOOP.md described sending an agent shopping from the first draft and
// nothing implemented it: no command, no route. These cover the route; the
// command is covered by the Java suite and by npm run mc:server.

/// A stand-in for the real dispatcher in scripts/serve-play.mjs, which needs
/// .local/ keys and a chain. What matters here is the ROUTE's contract.
function fakeAgents({ fail = null } = {}) {
  const sent = []
  return {
    sent,
    list: () => [{ accountId: 'worker-1.x.testnet', name: 'worker-1', methods: ['buy_with_credit'], maxUnitsPerOrder: 16 }],
    dispatch: async (order) => {
      if (fail) throw fail
      sent.push(order)
      return { agentId: 'worker-1.x.testnet', hash: 'AGENTHASH1' }
    },
  }
}

test('health lists the agents that can be sent, and an empty list when none can', async () => {
  // An empty list rather than a missing field: a client can then show the
  // command or not, instead of offering one that always refuses.
  const bare = await build().svc.handle('GET', '/api/health')
  assert.deepEqual(bare.body.agents, [])

  const { svc } = build({ agents: fakeAgents() })
  const res = await svc.handle('GET', '/api/health')
  assert.equal(res.body.agents.length, 1)
  assert.equal(res.body.agents[0].name, 'worker-1')
})

test('dispatching an agent needs a session, because it spends that agent gas', async () => {
  const { svc } = build({ agents: fakeAgents() })
  refuses(await svc.handle('POST', '/api/agent',
    { agent: 'worker-1', merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 }),
    'NO_SESSION', 401)
})

test('a deployment with no agent keys refuses as a deployment fact, not a bad request', async () => {
  // The hosted instance ships the relayer's key and one player's, so this is
  // its normal state. A 400 would tell a caller to fix a request that was fine.
  const { svc } = build()
  const sessionId = await signIn(svc)
  refuses(await svc.handle('POST', '/api/agent',
    { sessionId, agent: 'worker-1', merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 }),
    'NO_AGENT_KEYS', 503)
})

test('a dispatched agent answers with its OWN account and a hash', async () => {
  const agents = fakeAgents()
  const { svc, relayed } = build({ agents })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/agent',
    { sessionId, agent: 'worker-1', merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 4 })

  assert.equal(res.status, 200)
  assert.equal(res.body.agentId, 'worker-1.x.testnet')
  assert.equal(res.body.hash, 'AGENTHASH1')
  assert.equal(res.body.count, 4)
  assert.deepEqual(agents.sent, [
    { name: 'worker-1', merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 4 },
  ])

  // The POINT of the whole route: an agent is not the player's wallet under
  // another name. It signs with its own key and pays its own gas, so the
  // player's relayer must not have been touched at all.
  assert.deepEqual(relayed, [], 'an agent dispatch must not go through the player relayer')
})

test("an agent's own policy refusal keeps its code instead of becoming a 500", async () => {
  // backend/near/policy.mjs refuses an order larger than the cap, a merchant
  // outside this world, a method the key does not grant. Those are the agent's
  // wallet WORKING; reporting them as an internal error would hide the one
  // thing the caller could act on.
  const refusal = Object.assign(new Error('ironmonger.evil.testnet is not under x.testnet'),
    { code: 'MERCHANT_OUTSIDE_WORLD' })
  const { svc } = build({ agents: fakeAgents({ fail: refusal }) })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/agent',
    { sessionId, agent: 'worker-1', merchantId: 'ironmonger.evil.testnet', item: 'iron_ingot', count: 1 })
  refuses(res, 'MERCHANT_OUTSIDE_WORLD', 403)
  assert.match(res.body.detail, /not under/)
})

test('an unknown agent names the ones that exist', async () => {
  const refusal = Object.assign(new Error('no agent named "worker-9" — this deployment has worker-1'),
    { code: 'UNKNOWN_AGENT' })
  const { svc } = build({ agents: fakeAgents({ fail: refusal }) })
  const sessionId = await signIn(svc)
  const res = await svc.handle('POST', '/api/agent',
    { sessionId, agent: 'worker-9', merchantId: 'ironmonger.x.testnet', item: 'iron_ingot', count: 1 })
  refuses(res, 'UNKNOWN_AGENT', 400)
  assert.match(res.body.detail, /worker-1/)
})
