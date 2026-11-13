// OIDC on the runtime path: a real token, a real JWKS fetch over HTTP, and the
// real play service deciding what to do about it.
//
// WHY THIS FILE EXISTS. tests/near/oidc.mjs is thorough — 25 tests covering 17
// of the verifier's 20 refusals — and every one of them injects a stubbed
// `fetchImpl` that returns a bare object literal rather than a `Response`. So
// before this file: no JWKS had ever been fetched over HTTP, the real
// `res.ok` / `res.json()` contract was unexercised, `JWKS_UNREACHABLE` (the
// code a genuine network failure takes) had never been reached, and no running
// service had verified a token. `/api/health` had never once reported
// `verifier: "oidc"`. The verifier was excellent and entirely unexercised in
// place.
//
// What is real here: the verifier, its default `globalThis.fetch`, a `node:http`
// JWKS server, RSA keys generated in the test, `createOnboarding`'s identity
// handling, `playerAccountId`'s derivation, and `createPlayService`'s status
// mapping. What is faked: the chain. Nothing else.
//
// Note that every refusal below runs through the REAL `createOnboarding`,
// because verification happens before it touches a node — so the refusal path
// needs no network at all beyond the JWKS fetch it is supposed to make.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac, createSign, generateKeyPairSync } from 'node:crypto'
import { createOidcVerifier } from '../../backend/near/oidc.mjs'
import { createOnboarding, playerAccountId } from '../../backend/near/onboarding.mjs'
import { createPlayService } from '../../backend/near/play.mjs'

const ISSUER = 'https://oidc.test.invalid'
const AUDIENCE = 'nearcraft-test-client.apps.example.com'
const ROOT = 'nearcraftmc.testnet'
const KID = 'test-key-1'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** A signed RS256 token. Everything overridable, so each refusal is one field. */
function mint({ header = {}, claims = {}, key = privateKey, signature = null } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: KID, ...header })
  const p = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'subject-abc', iat: now - 10, exp: now + 600, ...claims })
  if (signature !== null) return `${h}.${p}.${signature}`
  const signer = createSign('RSA-SHA256')
  signer.update(`${h}.${p}`)
  return `${h}.${p}.${signer.sign(key).toString('base64url')}`
}

/** A REAL HTTP server. This is the whole point of the file. */
async function jwksServer({ mode = 'ok' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    if (mode === 'error') { res.writeHead(500).end('nope'); return }
    if (mode === 'garbage') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('<html>'); return }
    if (mode === 'empty') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"keys":[]}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { requests, port, uri: `http://127.0.0.1:${port}/.well-known/jwks.json`, close: () => server.close() }
}

/**
 * The production composition, with the chain removed.
 *
 * `createOnboarding` is the real module: it calls the real verifier, and on a
 * refusal it never reaches a node, which is why `rpcUrl` here can be a hole.
 */
function build({ jwksUri, provider, audience = AUDIENCE, issuer = ISSUER, fakeOnboarding = null, keys = {} }) {
  const verifier = createOidcVerifier({ issuer, audience, jwksUri, provider })
  const onboarding = fakeOnboarding ?? createOnboarding({
    rootAccountId: ROOT,
    rootKey: 'ed25519:3D4YudUahN1nawWogh8pAKSj92sLJgoMwjUEj3PMbRRdWqN2zbxrp8LEoEEbAiHxY8nm1ufMi3cv9mqo2WvMFGeS',
    marketContract: `market.${ROOT}`,
    itemsContract: `items.${ROOT}`,
    playerMethods: ['buy_with_credit', 'sell'],
    verifyIdentity: (token) => verifier.verifyIdentity(token),
    rpcUrl: 'http://127.0.0.1:1/unused',
  })
  const svc = createPlayService({
    deployment: { network: 'testnet', rpc: 'https://test.rpc.fastnear.com', contracts: { market: `market.${ROOT}` } },
    keys,
    // The label and the verifier are chosen together, exactly as
    // scripts/serve-play.mjs does it.
    verifierKind: 'oidc',
    onboarding,
    relayer: { relay: async () => ({ outcome: { transaction: { hash: 'H' } } }) },
    reader: { rpcUrl: 'x', nearBalance: async () => '0' },
  })
  return { svc, verifier }
}

const signIn = (svc, token) => svc.handle('POST', '/api/session', { token })

test('a genuine token is verified over a real HTTP JWKS fetch, and derives the account', async () => {
  const jwks = await jwksServer()
  try {
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: jwks.uri, provider: 'test' })

    // The account id is a one-way hash of `${provider}:${subject}`. Computed
    // here independently, so the test does not simply agree with itself — and
    // computed FIRST, because the service refuses a sign-in for an account it
    // holds no key for, which is the right behaviour and had to be fed.
    //
    // The WIDTH is pinned here on purpose, not imported. It was 8 while the
    // digest was 32 bits, and widening `ID_BYTES` to 8 bytes broke this test —
    // which is the independent computation doing its job. Changing the
    // derivation should cost a deliberate edit in two places; calling
    // `playerAccountId` here instead would make this agree with whatever the
    // module does and assert nothing about the width at all.
    const expected = `p-${createHash('sha256').update('test:subject-abc').digest('hex').slice(0, 16)}.${ROOT}`

    // Only the chain write is faked. The verifier and the derivation are real.
    let derived = null
    const { svc } = build({
      jwksUri: jwks.uri,
      keys: { [`${expected}#scoped`]: 'ed25519:3D4YudUahN1nawWogh8pAKSj92sLJgoMwjUEj3PMbRRdWqN2zbxrp8LEoEEbAiHxY8nm1ufMi3cv9mqo2WvMFGeS' },
      fakeOnboarding: {
        signIn: async (token) => {
          const identity = await verifier.verifyIdentity(token)
          derived = playerAccountId(identity.provider, identity.subject, ROOT)
          return { accountId: derived, created: false }
        },
        keyLimits: async () => [{ fullAccess: false, methodNames: ['buy_with_credit', 'sell'], publicKey: 'ed25519:p' }],
      },
    })

    const res = await signIn(svc, mint())
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.verifier, 'oidc', 'the service must report the verifier that actually ran')

    assert.equal(derived, expected, 'the account must derive from the VERIFIED subject')
    assert.equal(res.body.accountId, expected)

    // The proof that this was not a stub: a request actually arrived.
    assert.ok(jwks.requests.length > 0, 'the JWKS must have been fetched over HTTP')
    assert.match(jwks.requests[0], /jwks\.json/)

    console.log(`\n  real token -> ${res.body.accountId}`)
    console.log(`  JWKS fetched over HTTP ${jwks.requests.length} time(s) from ${jwks.uri}\n`)
  } finally {
    jwks.close()
  }
})

test('the service names WHICH check refused, and picks the status from it', async () => {
  const jwks = await jwksServer()
  try {
    const { svc } = build({ jwksUri: jwks.uri })
    const now = Math.floor(Date.now() / 1000)

    // Each of these used to arrive as one indistinguishable IDENTITY_REJECTED.
    const cases = [
      ['WRONG_AUDIENCE', 401, mint({ claims: { aud: 'someone-elses-client-id' } })],
      ['WRONG_ISSUER', 401, mint({ claims: { iss: 'https://evil.invalid' } })],
      ['TOKEN_EXPIRED', 401, mint({ claims: { exp: now - 3600, iat: now - 7200 } })],
      ['TOKEN_NOT_YET_VALID', 401, mint({ claims: { nbf: now + 3600 } })],
      ['TOKEN_FROM_THE_FUTURE', 401, mint({ claims: { iat: now + 3600 } })],
      ['NO_SUBJECT', 401, mint({ claims: { sub: '' } })],
      ['NO_EXPIRY', 401, mint({ claims: { exp: 'soon' } })],
      ['NO_KID', 401, mint({ header: { kid: undefined } })],
      ['UNKNOWN_KEY', 401, mint({ header: { kid: 'a-key-that-was-never-published' } })],
      ['TOKEN_MALFORMED', 401, 'two.segments'],
      ['BAD_SIGNATURE', 401, mint({ signature: 'not-the-real-signature' })],
    ]

    for (const [code, status, token] of cases) {
      const res = await signIn(svc, token)
      assert.equal(res.body.error, code, `expected ${code}, got ${JSON.stringify(res.body)}`)
      assert.equal(res.status, status, `${code} should be ${status}`)
      // A refusal must never leak the token back to the caller.
      assert.ok(!JSON.stringify(res.body).includes(String(token).slice(0, 40)),
        `${code} echoed the token back`)
    }

    // alg:none, which is the classic. Refused before any signature check.
    const unsigned = `${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${b64({ iss: ISSUER, aud: AUDIENCE, sub: 'x', exp: now + 600 })}.`
    assert.equal((await signIn(svc, unsigned)).body.error, 'ALG_NOT_ALLOWED')

    // An HMAC signed with the PUBLIC key — the confused-algorithm attack.
    const h = b64({ alg: 'HS256', typ: 'JWT', kid: KID })
    const p = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'x', exp: now + 600 })
    const forged = `${h}.${p}.${createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' })).update(`${h}.${p}`).digest('base64url')}`
    assert.equal((await signIn(svc, forged)).body.error, 'ALG_NOT_ALLOWED')

    // A token signed by a different RSA key, with the right kid.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    assert.equal((await signIn(svc, mint({ key: other.privateKey }))).body.error, 'BAD_SIGNATURE')

    // And no token at all.
    assert.equal((await svc.handle('POST', '/api/session', {})).body.error, 'NO_TOKEN')

    console.log(`  ${cases.length + 4} refusals, each reported by its own code\n`)
  } finally {
    jwks.close()
  }
})

test('a JWKS the provider will not serve is OUR failure, not the caller\'s', async () => {
  // The distinction matters: a 401 tells a player to sign in again, which
  // cannot possibly work when the identity provider is down.
  for (const [mode, code] of [['error', 'JWKS_HTTP_ERROR'], ['garbage', 'JWKS_MALFORMED'], ['empty', 'JWKS_MALFORMED']]) {
    const jwks = await jwksServer({ mode })
    try {
      const { svc } = build({ jwksUri: jwks.uri })
      const res = await signIn(svc, mint())
      assert.equal(res.body.error, code, JSON.stringify(res.body))
      assert.equal(res.status, 502, `${code} must be an upstream failure, not a 401`)
    } finally {
      jwks.close()
    }
  }

  // Nothing listening at all. This is the path a real network failure takes and
  // the stubbed suite could never reach it: a stub that returns {ok:false}
  // lands on JWKS_HTTP_ERROR instead.
  const jwks = await jwksServer()
  const deadUri = jwks.uri
  jwks.close()
  await new Promise((r) => setTimeout(r, 50))
  const { svc } = build({ jwksUri: deadUri })
  const res = await signIn(svc, mint())
  assert.equal(res.body.error, 'JWKS_UNREACHABLE', JSON.stringify(res.body))
  assert.equal(res.status, 502)
  console.log('  an unreachable JWKS is a 502, reached through the real fetch\n')
})

test('the seed verifier is never reachable once OIDC is configured', async () => {
  const jwks = await jwksServer()
  try {
    const { svc } = build({ jwksUri: jwks.uri })
    // `player-1` is the seeded demo subject. Under the seed verifier it signs
    // in; under OIDC it must be refused, or the two modes are not distinct.
    const res = await signIn(svc, 'player-1')
    assert.equal(res.body.error, 'TOKEN_MALFORMED')
    const health = await svc.handle('GET', '/api/health', {})
    assert.equal(health.body.verifier, 'oidc', 'health must not claim a verifier that is not running')
  } finally {
    jwks.close()
  }
})

test('the provider label is half of every account id, so changing it moves everyone', async () => {
  // Not a behaviour to fix — a trap to pin down. The account preimage is
  // `${provider}:${subject}`, so the same person with the same login lands on a
  // DIFFERENT account if the label changes. config/.local/oidc.json documents
  // this; here it is demonstrated, so nobody discovers it by losing an account.
  const jwks = await jwksServer()
  try {
    const accounts = []
    for (const provider of ['google', undefined]) {
      const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: jwks.uri, provider })
      const identity = await verifier.verifyIdentity(mint())
      accounts.push(playerAccountId(identity.provider, identity.subject, ROOT))
    }
    assert.notEqual(accounts[0], accounts[1],
      'labelling by provider and labelling by issuer must be shown to differ')
    console.log(`  provider "google" -> ${accounts[0]}`)
    console.log(`  provider unset    -> ${accounts[1]}   (the issuer URL is the label)\n`)
  } finally {
    jwks.close()
  }
})
