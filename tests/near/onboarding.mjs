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
  assert.match(a, /^p-[0-9a-f]{8}\.nearcraftmc\.testnet$/)
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
  // 32 bits of hash over 2,000 ids: a couple of collisions would be unlucky but
  // possible, so this asserts the derivation is working, not that it is perfect.
  assert.ok(seen.size > 1_990, `expected near-2000 distinct ids, got ${seen.size}`)
})

test('an account id can never exceed NEAR\'s 64-byte limit', () => {
  const id = playerAccountId('google', 'someone@example.com', 'a'.repeat(48))
  assert.ok(id.length <= 64, `${id.length} bytes`)
  assert.throws(() => playerAccountId('google', 'x', 'a'.repeat(49)), (e) => e.code === 'ROOT_MALFORMED')
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
