// What a manifest and a key set say a process can do.
//
// These two functions lived inline in scripts/serve-play.mjs, which cannot be
// imported — it has top-level awaits, exits on a missing key file and binds a
// port — so nothing in `npm test` exercised them, and every change made to that
// file last round was unexercised. Extracted into backend/near/deployment.mjs
// for exactly this, the way serve-web.mjs exports resolveFile and SERVABLE.
//
// Offline: the key map is a parameter, and only the presence of a string at a
// name is ever tested.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DEMO_TOKENS, declaredAgents, signableAccounts, signInHint } from '../../backend/near/deployment.mjs'
import { playerAccountId } from '../../backend/near/onboarding.mjs'

const ROOT = 'x.testnet'
const P1 = playerAccountId('seed', 'player-1', ROOT)
const P3 = playerAccountId('seed', 'player-3', ROOT)

const manifest = (players, agents = []) => ({ root: ROOT, players, agents })
const player = (id) => ({ account_id: id, permitted_methods: ['buy_with_credit'] })

test('a login is offered only when it was checked against what it derives', () => {
  // The defect: the banner printed `sign in as "player-1" -> <players[0]>`, a
  // literal beside an account derived from something else. Here player-3 is the
  // one with a key, so player-3 is what must be offered — and the id must be
  // the one the hash actually produces, not the one the manifest lists first.
  const hint = signInHint({
    manifest: manifest([player(P1), player(P3)]),
    keys: { [`${P3}#scoped`]: 'ed25519:k' },
  })
  assert.equal(hint.token, 'player-3')
  assert.equal(hint.id, P3)
})

test('a manifest entry with no key here is not signable', () => {
  // The hosted deployment ships two keys against a manifest listing four
  // players. Offering one it cannot sign for would be an offer that refuses.
  const hint = signInHint({ manifest: manifest([player(P1), player(P3)]), keys: {} })
  assert.equal(hint, null, 'no key for anyone means no hint at all')
  assert.deepEqual(signableAccounts({ manifest: manifest([player(P1)]), keys: {} }), [])
})

test('an agent key does not make a player signable', () => {
  // `#scoped` is a player's authority and `#function-call` an agent's. A filter
  // that accepted either would offer a login for an account it holds no player
  // key for.
  const hint = signInHint({
    manifest: manifest([player(P3)]),
    keys: { [`${P3}#function-call`]: 'ed25519:k' },
  })
  assert.equal(hint, null)
})

test('when no candidate derives a signable account it says so instead of guessing', () => {
  // Real case: .tmp/sandbox/ holds key files from before the account id went
  // from 4 bytes to 8, so every candidate misses. The old code would have
  // printed nothing useful; this reports what it CAN sign for and admits the
  // login is not guessable.
  const legacy = 'p-1d6a3c5d.x.testnet'
  const hint = signInHint({
    manifest: manifest([player(legacy)]),
    keys: { [`${legacy}#scoped`]: 'ed25519:k' },
  })
  assert.equal(hint.token, null, 'no candidate matched, so no token may be offered')
  assert.equal(hint.id, legacy)
})

test('a real provider subject is not a typeable string, so none is offered', () => {
  const hint = signInHint({
    manifest: manifest([player(P3)]),
    keys: { [`${P3}#scoped`]: 'ed25519:k' },
    verifierKind: 'oidc',
  })
  assert.equal(hint.token, null)
  assert.equal(hint.id, P3)
})

test('a malformed root loses the banner, not the server', () => {
  // signInHint runs inside a `listening` callback, where a throw is an
  // uncaughtException that takes the process down — and mc-up.mjs then waits its
  // full 30 seconds before saying anything. playerAccountId throws on a root it
  // cannot use, so that throw is caught here.
  const id = 'p-deadbeefdeadbeef.x.testnet'
  const hint = signInHint({
    manifest: { root: 'NOT A VALID ROOT', players: [player(id)], agents: [] },
    keys: { [`${id}#scoped`]: 'ed25519:k' },
  })
  assert.equal(hint.token, null, 'no token, because none could be derived')
  assert.equal(hint.id, id, 'but it still reports who it can sign for')
})

test('an agent needs both a manifest entry and a key', () => {
  const both = { account_id: 'worker-1.x.testnet' }
  const keyless = { account_id: 'worker-2.x.testnet' }
  const found = declaredAgents({
    manifest: manifest([], [both, keyless]),
    keys: { 'worker-1.x.testnet#function-call': 'ed25519:k' },
  })
  assert.deepEqual(found.map((a) => a.account_id), ['worker-1.x.testnet'])

  // A key with no manifest entry is an account this deployment never claimed.
  assert.deepEqual(declaredAgents({
    manifest: manifest([], []),
    keys: { 'worker-9.x.testnet#function-call': 'ed25519:k' },
  }), [])

  // The hosted posture: relayer plus one player, no agents.
  assert.deepEqual(declaredAgents({ manifest: manifest([], [both]), keys: {} }), [])
})

test('an empty or absent manifest section is not an error', () => {
  assert.equal(signInHint({ manifest: {}, keys: {} }), null)
  assert.deepEqual(declaredAgents({ manifest: {}, keys: {} }), [])
  assert.deepEqual(signableAccounts({ manifest: {}, keys: {} }), [])
})

test("the committed manifest's demo subject is one of the offered candidates", async () => {
  // Ties the candidate list to the deployment rather than to this file. If
  // config/catalog.json's demo_subject stops being something the banner would
  // try, the operator is told to type one thing while mc-up uses another.
  const catalog = JSON.parse(await readFile(new URL('../../config/catalog.json', import.meta.url), 'utf8'))
  const subject = catalog.players?.demo_subject
  assert.ok(subject, 'config/catalog.json names no demo_subject')
  assert.ok(DEMO_TOKENS.includes(subject),
    `catalog demo_subject "${subject}" is not in DEMO_TOKENS [${DEMO_TOKENS.join(', ')}], so the ` +
    'banner would never offer the login mc:up actually uses')
})
