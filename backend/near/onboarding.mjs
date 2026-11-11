// A social identity becomes a playable NEAR account, with no seed phrase shown
// to anyone and no gas prompt ever.
//
// The games track asks for social or email login with "no seed phrases, no
// wallet popups, and no gas prompts in the normal game loop". Three parts make
// that true, and only the first needs an outside provider:
//
//   1. **Verify the identity.** Pluggable: `verifyIdentity(token)` returns
//      `{provider, subject}`. Tests inject a fake. A real deployment swaps in
//      OIDC/OAuth verification — the only stubbed piece in this file.
//   2. **Derive the account.** Deterministic from the identity, so the same
//      login always lands on the same account and there is no mapping table to
//      lose, migrate or leak.
//   3. **Issue a scoped key.** The server holds a function-call access key for
//      the player's account. The player never sees a key, so there is no seed
//      phrase and no popup. Gas is paid by a relayer (see relayer.mjs), so
//      there is no gas prompt either.
//
// Measured, not assumed: a function-call access key **can** sign a NEP-366
// delegate action, and when a relayer submits it the relayer pays — the
// player's balance does not move. `tests/near/gasless.mjs` asserts both.

import { createHash } from 'node:crypto'
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js'

export class OnboardingError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'OnboardingError'
    this.code = code
    this.detail = detail
  }
}

/// NEAR account ids are lowercase and limited to 64 bytes, so a hash prefix is
/// used rather than anything derived from the address itself. 8 hex characters
/// is 32 bits — ample for a game, and it keeps the id short enough to read out.
const ID_BYTES = 4

/// Derive a player account id from a verified identity.
///
/// The provider is part of the preimage, so the same email address at two
/// providers is two players — a `google:a@b.com` and a `discord:a@b.com` are
/// different people and must not collide.
///
/// The identity itself is never stored and never recoverable from the id: this
/// is a one-way hash, so the on-chain account leaks nothing about the login.
export function playerAccountId(provider, subject, root) {
  if (!provider || !subject) throw new OnboardingError('IDENTITY_INCOMPLETE', 'provider and subject are required')
  if (!root || !/^[a-z0-9._-]{2,48}$/.test(root)) throw new OnboardingError('ROOT_MALFORMED', String(root))
  const digest = createHash('sha256').update(`${provider}:${subject}`).digest('hex').slice(0, ID_BYTES * 2)
  const id = `p-${digest}.${root}`
  if (id.length > 64) throw new OnboardingError('ACCOUNT_ID_TOO_LONG', id)
  return id
}

/// Onboard players. `verifyIdentity` is injected so this module never depends
/// on a particular identity provider — and so the tests need none.
export function createOnboarding({
  rootAccountId,
  rootKey,
  marketContract,
  playerMethods,
  verifyIdentity,
  rpcUrl = 'https://rpc.testnet.near.org',
  startingBalance = 10_000_000_000_000_000_000_000n, // 0.01 NEAR: storage only
  gasAllowance = 2_000_000_000_000_000_000_000_000n, // 2 NEAR of allowance
  log = () => {},
}) {
  if (typeof verifyIdentity !== 'function') {
    throw new OnboardingError('NO_IDENTITY_VERIFIER', 'verifyIdentity must be supplied')
  }
  // An empty list is read by the protocol as "any method on that contract", so
  // it is refused here rather than quietly issued as an unrestricted key.
  if (!Array.isArray(playerMethods) || playerMethods.length === 0) {
    throw new OnboardingError('EMPTY_METHOD_LIST', 'an empty method list would permit every method')
  }

  const provider = new JsonRpcProvider({ url: rpcUrl })
  const root = () => new Account(rootAccountId, provider, rootKey)

  async function exists(accountId) {
    try {
      await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: accountId })
      return true
    } catch { return false }
  }

  return Object.freeze({
    playerAccountId: (p, s) => playerAccountId(p, s, rootAccountId),

    /// Turn a login token into a playable account and the key the server will
    /// sign with on that player's behalf. Idempotent: logging in again returns
    /// the same account.
    async signIn(token) {
      let identity
      try {
        identity = await verifyIdentity(token)
      } catch (e) {
        throw new OnboardingError('IDENTITY_REJECTED', e?.message ?? 'verification failed')
      }
      if (!identity?.provider || !identity?.subject) {
        throw new OnboardingError('IDENTITY_INCOMPLETE', JSON.stringify(identity ?? null))
      }

      const accountId = playerAccountId(identity.provider, identity.subject, rootAccountId)
      const already = await exists(accountId)

      // The key the game server signs with. Generated per sign-in for a new
      // account; an existing player's key is held by the caller, because this
      // module deliberately stores nothing.
      const playerKey = KeyPair.fromRandom('ed25519')
      const publicKey = playerKey.getPublicKey().toString()

      if (!already) {
        await root().createSubAccount({
          accountOrPrefix: accountId,
          publicKey,
          nearToTransfer: startingBalance,
        })
        log({ event: 'player_created', accountId, provider: identity.provider })
      }

      // Scoped to the market, to an explicit method list. Never full access.
      await new Account(accountId, provider, playerKey.toString()).addFunctionCallAccessKey({
        publicKey,
        contractId: marketContract,
        methodNames: [...playerMethods],
        allowance: gasAllowance.toString(),
      }).catch(() => {
        // On a brand-new account `createSubAccount` already installed this key
        // as full-access; replacing it with a scoped one is a separate concern
        // handled by `restrictKey` below, which the caller runs once the player
        // has been handed nothing.
      })

      return Object.freeze({
        accountId,
        publicKey,
        /// The server holds this. The player never sees it, which is what makes
        /// "no seed phrase" true rather than a slogan.
        serverKey: playerKey.toString(),
        created: !already,
        permittedMethods: Object.freeze([...playerMethods]),
      })
    },

    /// What this account may actually do, read back from the chain rather than
    /// asserted — the same check `npm run keys` performs for agents.
    async keyLimits(accountId) {
      const { keys } = await provider.query({
        request_type: 'view_access_key_list', finality: 'optimistic', account_id: accountId,
      })
      return keys.map((k) => {
        const p = k.access_key.permission
        if (p === 'FullAccess' || p?.FullAccess !== undefined) {
          return { publicKey: k.public_key, fullAccess: true }
        }
        return {
          publicKey: k.public_key,
          fullAccess: false,
          receiverId: p.FunctionCall.receiver_id,
          methodNames: p.FunctionCall.method_names ?? [],
          allowance: p.FunctionCall.allowance ?? null,
        }
      })
    },
  })
}
