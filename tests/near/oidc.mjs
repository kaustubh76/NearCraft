// The identity verifier, which until now was the one stubbed piece.
//
// Entirely offline: the test generates its own RS256 keypair, mints real tokens
// with it, and serves a JWKS from a stubbed fetch. Nothing here needs a
// provider, a network or a client id — which is the only reason it can be part
// of `npm test`.
//
// The attacks matter more than the happy path. A verifier that accepts a valid
// Google token is easy; one that refuses `alg: none`, refuses an HMAC algorithm
// signed with the public key, and refuses a token minted for somebody else's
// application is the point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto'
import { createOidcVerifier, IdentityRejected } from '../../backend/near/oidc.mjs'
import { playerAccountId } from '../../backend/near/onboarding.mjs'

const ISSUER = 'https://accounts.example.com'
const AUDIENCE = 'nearcraft-client-id.apps.example.com'
const JWKS_URI = 'https://accounts.example.com/jwks'
const KID = 'key-1'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const NOW_MS = 1_765_000_000_000
const nowSec = Math.floor(NOW_MS / 1000)

/// Mint a token the way a provider would.
function mint({ header = {}, claims = {}, key = privateKey, breakSignature = false } = {}) {
  const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })
  const p = b64({
    iss: ISSUER, aud: AUDIENCE, sub: 'subject-abc-123',
    iat: nowSec - 10, exp: nowSec + 3600, ...claims,
  })
  const signer = createSign('RSA-SHA256')
  signer.update(`${h}.${p}`)
  let sig = signer.sign(key).toString('base64url')
  if (breakSignature) sig = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA')
  return `${h}.${p}.${sig}`
}

/// A JWKS endpoint. `keys` lets a test simulate rotation; `calls` proves how
/// many times it was hit, which is how the no-hammering test works.
function jwksServer({ keys = [JWK], status = 200, body = null } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (status !== 200) return { ok: false, status }
    return { ok: true, json: async () => body ?? { keys: keys.map((k) => ({ ...k })) } }
  }
  return { fetchImpl, calls }
}

const verifier = (opts = {}) => {
  const { fetchImpl, calls } = opts.server ?? jwksServer()
  return {
    calls,
    v: createOidcVerifier({
      issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI,
      fetchImpl, now: () => NOW_MS, ...opts.overrides,
    }),
  }
}

/// Asserts a refusal with a specific code — "it threw" would pass even when the
/// wrong guard fired, which for a security check is no assurance at all.
async function refuses(code, token, opts = {}) {
  const { v } = verifier(opts)
  await assert.rejects(
    () => v.verifyIdentity(token),
    (e) => {
      assert.ok(e instanceof IdentityRejected, `expected IdentityRejected, got ${e?.name}: ${e?.message}`)
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.detail ?? ''})`)
      return true
    },
  )
}

// ------------------------------------------------------------- the happy path

test('a well-formed token resolves to a provider and a subject', async () => {
  const { v } = verifier()
  const identity = await v.verifyIdentity(mint())
  assert.deepEqual(identity, { provider: ISSUER, subject: 'subject-abc-123' })
  assert.ok(Object.isFrozen(identity))
})

test('the provider label defaults to the issuer and can be overridden', async () => {
  const { v } = verifier({ overrides: { provider: 'google' } })
  const identity = await v.verifyIdentity(mint())
  // It feeds playerAccountId, so it decides the account id — changing it moves
  // every account, which is why it is explicit rather than inferred.
  assert.equal(identity.provider, 'google')
})

test('aud may be an array, as some providers send it', async () => {
  const { v } = verifier()
  const identity = await v.verifyIdentity(mint({ claims: { aud: ['someone-else', AUDIENCE] } }))
  assert.equal(identity.subject, 'subject-abc-123')
})

// ------------------------------------------------------------- the attacks

test('alg: none is refused — a token with no signature at all', async () => {
  const h = b64({ alg: 'none', kid: KID })
  const p = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'attacker', exp: nowSec + 3600 })
  await refuses('ALG_NOT_ALLOWED', `${h}.${p}.`)
})

test('an HMAC alg is refused — the public key is public, so it is not a secret', async () => {
  // The classic confusion attack: sign with HS256 using the verifier's own
  // public key as the HMAC secret. It must never reach the signature check.
  const h = b64({ alg: 'HS256', kid: KID })
  const p = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'attacker', exp: nowSec + 3600 })
  const sig = createHmac('sha256', publicKey.export({ type: 'spki', format: 'pem' }))
    .update(`${h}.${p}`).digest('base64url')
  await refuses('ALG_NOT_ALLOWED', `${h}.${p}.${sig}`)
})

test('a tampered signature is refused', async () => {
  await refuses('BAD_SIGNATURE', mint({ breakSignature: true }))
})

test('a tampered subject is refused — the signature covers it', async () => {
  // Mint a good token, then swap the payload for one naming a different
  // subject. If this passed, anyone could claim anyone's NEAR account.
  const good = mint()
  const [h, , sig] = good.split('.')
  const forged = b64({ iss: ISSUER, aud: AUDIENCE, sub: 'somebody-elses-subject', exp: nowSec + 3600 })
  await refuses('BAD_SIGNATURE', `${h}.${forged}.${sig}`)
})

test('a token signed by the wrong key is refused', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await refuses('BAD_SIGNATURE', mint({ key: other.privateKey }))
})

test('a token for another application is refused, however valid', async () => {
  await refuses('WRONG_AUDIENCE', mint({ claims: { aud: 'someone-elses-client-id' } }))
})

test('a token from another issuer is refused', async () => {
  await refuses('WRONG_ISSUER', mint({ claims: { iss: 'https://evil.example.com' } }))
})

// --------------------------------------------------------------- the clock

test('an expired token is refused', async () => {
  await refuses('TOKEN_EXPIRED', mint({ claims: { exp: nowSec - 120 } }))
})

test('a token that never expires is refused', async () => {
  await refuses('NO_EXPIRY', mint({ claims: { exp: undefined } }))
})

test('a token not yet valid is refused', async () => {
  await refuses('TOKEN_NOT_YET_VALID', mint({ claims: { nbf: nowSec + 600 } }))
})

test('small clock skew is tolerated, because clocks differ', async () => {
  const { v } = verifier()
  // Expired 10 seconds ago, inside the default 60s skew.
  const identity = await v.verifyIdentity(mint({ claims: { exp: nowSec - 10 } }))
  assert.equal(identity.subject, 'subject-abc-123')
})

// --------------------------------------------------------------- the shape

test('a malformed token is refused before anything is parsed', async () => {
  await refuses('TOKEN_MALFORMED', 'not-a-jwt')
  await refuses('NO_TOKEN', '')
  await refuses('NO_TOKEN', undefined)
})

test('a token with no kid is refused rather than guessed at', async () => {
  await refuses('NO_KID', mint({ header: { kid: undefined } }))
})

test('an empty subject is refused — it would collide every login onto one account', async () => {
  await refuses('NO_SUBJECT', mint({ claims: { sub: '' } }))
})

// ----------------------------------------------------------- key rotation

test('an unknown kid triggers one refetch, which is how rotation works', async () => {
  const rotated = { ...JWK, kid: 'key-2' }
  const server = jwksServer({ keys: [rotated] })
  const { v } = verifier({ server })
  // The provider has rotated to key-2; our token names key-2.
  const identity = await v.verifyIdentity(mint({ header: { kid: 'key-2' } }))
  assert.equal(identity.subject, 'subject-abc-123')
  assert.equal(server.calls.length, 1, 'fetched the JWKS once')
})

test('a kid that is genuinely absent is refused, and does not hammer the provider', async () => {
  const server = jwksServer()
  const { v } = verifier({ server })
  await assert.rejects(() => v.verifyIdentity(mint({ header: { kid: 'invented' } })),
    (e) => { assert.equal(e.code, 'UNKNOWN_KEY'); return true })
  // Exactly one refetch. Otherwise made-up kids are a free amplification
  // attack against the provider, using us as the amplifier.
  assert.equal(server.calls.length, 1)
})

test('the JWKS is cached, so a second token does not refetch', async () => {
  const server = jwksServer()
  const { v } = verifier({ server })
  await v.verifyIdentity(mint())
  await v.verifyIdentity(mint({ claims: { sub: 'another' } }))
  assert.equal(server.calls.length, 1, 'one fetch for two tokens')
})

test('an unreachable or broken JWKS is refused, never treated as no keys', async () => {
  await refuses('JWKS_HTTP_ERROR', mint(), { server: jwksServer({ status: 503 }) })
  await refuses('JWKS_MALFORMED', mint(), { server: jwksServer({ body: { keys: [] } }) })
  await refuses('JWKS_MALFORMED', mint(), { server: jwksServer({ body: {} }) })
})

test('one unusable key in the JWKS does not poison a rotation', async () => {
  const server = jwksServer({ keys: [{ kid: 'broken', kty: 'RSA', n: 'not-base64!', e: 'AQAB' }, JWK] })
  const { v } = verifier({ server })
  assert.equal((await v.verifyIdentity(mint())).subject, 'subject-abc-123')
})

// ------------------------------------------------------------ construction

test('a verifier with no issuer or audience refuses to exist', () => {
  const base = { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI }
  for (const [missing, code] of [['issuer', 'NO_ISSUER'], ['audience', 'NO_AUDIENCE'], ['jwksUri', 'NO_JWKS_URI']]) {
    assert.throws(
      () => createOidcVerifier({ ...base, [missing]: undefined }),
      (e) => { assert.equal(e.code, code); return true },
      `missing ${missing} must refuse`,
    )
  }
  // A verifier that accepted any audience would hand out other applications'
  // users, so there is deliberately no default for it.
})

// --------------------------------------------- it fits the onboarding seam

test('the identity it returns is exactly what onboarding.signIn consumes', async () => {
  const { v } = verifier()
  const identity = await v.verifyIdentity(mint())

  // signIn requires both fields and refuses IDENTITY_INCOMPLETE without them.
  assert.equal(typeof identity.provider, 'string')
  assert.equal(typeof identity.subject, 'string')
  assert.ok(identity.provider && identity.subject)

  // And it derives a usable, deterministic NEAR account id — which is the
  // whole reason this function exists.
  const accountId = playerAccountId(identity.provider, identity.subject, 'nearcraftmc.testnet')
  assert.match(accountId, /^p-[0-9a-f]{8}\.nearcraftmc\.testnet$/)
  assert.equal(
    accountId,
    playerAccountId(identity.provider, identity.subject, 'nearcraftmc.testnet'),
    'the same login must always land on the same account',
  )
})

test('two different subjects from one provider get different accounts', async () => {
  const { v } = verifier()
  const a = await v.verifyIdentity(mint({ claims: { sub: 'alice' } }))
  const b = await v.verifyIdentity(mint({ claims: { sub: 'bob' } }))
  assert.notEqual(
    playerAccountId(a.provider, a.subject, 'root.testnet'),
    playerAccountId(b.provider, b.subject, 'root.testnet'),
  )
})
