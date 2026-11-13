// Identity to account, offline. The derivation is the part that must never
// change silently: it decides which on-chain account a login lands on, so a
// change here would orphan every existing player.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOnboarding, OnboardingError, playerAccountId } from '../../backend/near/onboarding.mjs'

const ROOT = 'nearcraftmc.testnet'

test('the same login always derives the same account', () => {
  const a = playerAccountId('google', 'alice@example.com', ROOT)
  const b = playerAccountId('google', 'alice@example.com', ROOT)
  assert.equal(a, b, 'a player must not get a new account on every sign-in')
  assert.match(a, /^p-[0-9a-f]{16}\.nearcraftmc\.testnet$/)
})

test('the same address at two providers is two players', () => {
  // google:a@b.com and discord:a@b.com are different people and must not
  // collide onto one account.
  assert.notEqual(
    playerAccountId('google', 'alice@example.com', ROOT),
    playerAccountId('discord', 'alice@example.com', ROOT),
  )
})

test('the account id leaks nothing about the identity', () => {
  const id = playerAccountId('google', 'alice@example.com', ROOT)
  assert.ok(!id.includes('alice'), 'the login must not be readable off the chain')
  assert.ok(!id.includes('example'))
  assert.ok(!id.includes('google'))
})

test('different subjects do not collide', () => {
  const seen = new Set()
  for (let i = 0; i < 2_000; i++) seen.add(playerAccountId('google', `user${i}@example.com`, ROOT))
  assert.equal(seen.size, 2_000, `expected 2000 distinct ids, got ${seen.size}`)
})

test('the derivation carries 64 bits, not 32', () => {
  // Why this is asserted rather than left to the comment: at 32 bits a
  // deliberate collision is minutes of sha256, and a collision is not a
  // cosmetic clash here. `signIn` only tests whether the derived account
  // EXISTS, so the colliding identity gets a session bound to the FIRST
  // player's stored key — custodial control of someone else's balance. The
  // original identity is never stored, so nothing downstream can tell.
  const digest = playerAccountId('google', 'alice@example.com', ROOT)
    .slice('p-'.length, -(`.${ROOT}`.length))
  assert.match(digest, /^[0-9a-f]{16}$/, `expected 16 hex characters (64 bits), got "${digest}"`)
})

test('an exact collision would be caught by the account id, not by the login', () => {
  // The property that makes the width matter: two identities colliding produce
  // the SAME account id, and nothing else in the system distinguishes them.
  // Same preimage, same id — which is what makes it idempotent for one person
  // and dangerous for two.
  assert.equal(
    playerAccountId('google', 'alice@example.com', ROOT),
    playerAccountId('google', 'alice@example.com', ROOT),
  )
  assert.notEqual(
    playerAccountId('google', 'alice@example.com', ROOT),
    playerAccountId('google', 'alice@example.co', ROOT),
  )
})

test('an account id can never exceed NEAR\'s 64-byte limit', () => {
  // `p-` + 16 hex + `.` = 19 characters, so a root of 45 is the longest that
  // fits and 46 is the shortest that cannot.
  const longest = playerAccountId('google', 'someone@example.com', 'a'.repeat(45))
  assert.equal(longest.length, 64, `the longest fitting id should be exactly 64, got ${longest.length}`)

  // ACCOUNT_ID_TOO_LONG was UNREACHABLE while the digest was 32 bits: the
  // worst case was 59 characters, so the guard could never fire and nothing
  // tested it. Widening the digest brought it to life, and this is the test
  // that reaches it. A guard that cannot fire is not a guard.
  assert.throws(() => playerAccountId('google', 'someone@example.com', 'a'.repeat(46)),
    (e) => e.code === 'ACCOUNT_ID_TOO_LONG')

  assert.throws(() => playerAccountId('google', 'x', 'a'.repeat(49)), (e) => e.code === 'ROOT_MALFORMED')
})

test('a root NEAR itself would refuse is refused here too', () => {
  // The old pattern was [a-z0-9._-]{2,48}, which let all of these through —
  // so "the derived id is always a valid NEAR account id" held for the digest
  // half only.
  for (const bad of ['-x', 'x-', '_x', 'x_', 'a..b', '.a', 'a.', 'A.testnet', 'x', 'a-.b']) {
    assert.throws(() => playerAccountId('seed', 's', bad),
      (e) => e.code === 'ROOT_MALFORMED', `"${bad}" should be refused`)
  }
  for (const ok of ['testnet', 'nearcraftmc.testnet', 'a-b.testnet', 'a_b.near', 'x1.y2.near']) {
    assert.ok(playerAccountId('seed', 's', ok).endsWith(`.${ok}`), `"${ok}" should be accepted`)
  }
})

test('incomplete identities and malformed roots are refused', () => {
  for (const [p, s] of [[null, 'x'], ['google', null], ['', 'x'], ['google', '']]) {
    assert.throws(() => playerAccountId(p, s, ROOT), (e) => e.code === 'IDENTITY_INCOMPLETE')
  }
  for (const root of ['UPPERCASE.testnet', 'has spaces', '', 'x']) {
    assert.throws(() => playerAccountId('google', 'a', root), (e) => e.code === 'ROOT_MALFORMED')
  }
})

test('onboarding refuses to start without an identity verifier', () => {
  assert.throws(
    () => createOnboarding({ rootAccountId: ROOT, marketContract: `market.${ROOT}`, playerMethods: ['buy_with_credit'] }),
    (e) => { assert.ok(e instanceof OnboardingError); assert.equal(e.code, 'NO_IDENTITY_VERIFIER'); return true },
  )
})

test('an empty player method list is refused, not issued', () => {
  // The protocol reads an empty method_names as "any method on that contract",
  // so issuing one would hand every player an unrestricted key.
  assert.throws(
    () => createOnboarding({
      rootAccountId: ROOT, marketContract: `market.${ROOT}`,
      playerMethods: [], verifyIdentity: async () => ({ provider: 'g', subject: 's' }),
    }),
    (e) => e.code === 'EMPTY_METHOD_LIST',
  )
})

test('a rejected token surfaces as IDENTITY_REJECTED, not as a crash', async () => {
  const onboarding = createOnboarding({
    rootAccountId: ROOT, rootKey: 'ed25519:x', marketContract: `market.${ROOT}`,
    playerMethods: ['buy_with_credit'],
    verifyIdentity: async () => { throw new Error('token expired') },
  })
  await assert.rejects(() => onboarding.signIn('bad'), (e) => {
    assert.equal(e.code, 'IDENTITY_REJECTED')
    assert.match(e.message, /token expired/)
    return true
  })
})

test('a verifier returning junk is refused rather than trusted', async () => {
  for (const identity of [null, {}, { provider: 'g' }, { subject: 's' }]) {
    const onboarding = createOnboarding({
      rootAccountId: ROOT, rootKey: 'ed25519:x', marketContract: `market.${ROOT}`,
      playerMethods: ['buy_with_credit'], verifyIdentity: async () => identity,
    })
    await assert.rejects(() => onboarding.signIn('t'), (e) => e.code === 'IDENTITY_INCOMPLETE')
  }
})

test('playerAccountId on the instance agrees with the bare function', () => {
  const onboarding = createOnboarding({
    rootAccountId: ROOT, rootKey: 'ed25519:x', marketContract: `market.${ROOT}`,
    playerMethods: ['buy_with_credit'], verifyIdentity: async () => ({ provider: 'g', subject: 's' }),
  })
  assert.equal(onboarding.playerAccountId('g', 's'), playerAccountId('g', 's', ROOT))
})
