// A social identity becomes a playable NEAR account, with no seed phrase shown
// to anyone and no gas prompt ever.
//
// The games track asks for social or email login with "no seed phrases, no
// wallet popups, and no gas prompts in the normal game loop". Three parts make
// that true, and only the first needs an outside provider:
//
//   1. **Verify the identity.** Pluggable: `verifyIdentity(token)` returns
//      `{provider, subject}`. Tests inject a fake. A real deployment swaps in
//      OIDC/OAuth verification. Implemented in `oidc.mjs`; the seam stays so a
//      test can inject a fake and so seeded demo players can use `seed:`.
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
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from 'near-api-js'

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
  itemsContract,
  /// Materials the player pre-approves the market to pull when they sell.
  sellableItems = [],
  playerMethods,
  verifyIdentity,
  rpcUrl = 'https://test.rpc.fastnear.com',
  startingBalance = 100_000_000_000_000_000_000_000n, // 0.1 NEAR: storage + the approval deposit
  gasAllowance = 2_000_000_000_000_000_000_000_000n,  // 2 NEAR of gas allowance
  approvalDeposit = 10_000_000_000_000_000_000_000n,  // 0.01 NEAR for approval storage
  /// Standing allowance per material, so one approval lasts.
  sellAllowance = 1_000_000_000n,
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

    /// Turn a login token into a playable account and the key the server signs
    /// with on that player's behalf. Idempotent: logging in again returns the
    /// same account id.
    ///
    /// ## Why this is three transactions
    ///
    /// A player who holds only a function-call access key cannot attach a
    /// deposit, which means they can never call `mt_approve` — and without an
    /// approval they can never sell, because NEP-245 requires 1 yoctoNEAR on a
    /// transfer. The approval therefore has to be granted *while a full-access
    /// key still exists*, and that key must then be destroyed.
    ///
    ///   1. root: `CreateAccount` + `Transfer` + `AddKey(full access)`
    ///   2. player, with that key: `mt_approve` granting the market its pull
    ///      rights over every sellable material, deposit paid from the funded
    ///      balance
    ///   3. player: `AddKey(function-call, scoped)` **then** `DeleteKey(full
    ///      access)` — in that order, in one batch, or the account would lock
    ///      itself out between the two
    ///
    /// The player never sees a key at any point, and after this there is no
    /// full-access key in existence for the account. `keyLimits()` proves it.
    async signIn(token) {
      let identity
      try {
        identity = await verifyIdentity(token)
      } catch (e) {
        // Keep WHICH check refused.
        //
        // This used to collapse every refusal into one code, so a wrong
        // audience, an expired token and an unreachable JWKS were
        // indistinguishable at the only boundary a caller ever sees — twenty
        // carefully separated refusals arriving as one. The code travels on the
        // error so the service can report it and choose a status from it: a
        // caller can then tell "your token expired, sign in again" from "the
        // identity provider is down", which are not the same instruction.
        const refusal = new OnboardingError('IDENTITY_REJECTED', e?.detail ?? e?.message ?? 'verification failed')
        refusal.identityCode = e?.code ?? null
        throw refusal
      }
      if (!identity?.provider || !identity?.subject) {
        throw new OnboardingError('IDENTITY_INCOMPLETE', JSON.stringify(identity ?? null))
      }

      const accountId = playerAccountId(identity.provider, identity.subject, rootAccountId)
      if (await exists(accountId)) {
        // Already onboarded. This module stores nothing, so the caller holds
        // the scoped key; there is no key to hand back here.
        return Object.freeze({ accountId, created: false, permittedMethods: Object.freeze([...playerMethods]) })
      }

      const bootstrap = KeyPair.fromRandom('ed25519')
      const scoped = KeyPair.fromRandom('ed25519')

      // 1. Create, fund, and install a temporary full-access key.
      await root().signAndSendTransaction({
        receiverId: accountId,
        actions: [
          actions.createAccount(),
          actions.transfer(startingBalance),
          actions.addFullAccessKey(bootstrap.getPublicKey()),
        ],
      })
      log({ event: 'player_created', accountId, provider: identity.provider })

      const asPlayer = new Account(accountId, provider, bootstrap.toString())

      // 2. Grant the market its pull rights, while a full-access key still
      //    exists to attach the deposit.
      if (sellableItems.length > 0) {
        if (!itemsContract) throw new OnboardingError('NO_ITEMS_CONTRACT', 'sellableItems needs itemsContract')
        await asPlayer.callFunction({
          contractId: itemsContract,
          methodName: 'mt_approve',
          args: {
            token_ids: [...sellableItems],
            // A standing allowance, so one approval lasts rather than needing
            // a fresh deposit per sale.
            amounts: sellableItems.map(() => sellAllowance.toString()),
            account_id: marketContract,
            msg: null,
          },
          deposit: approvalDeposit,
          gas: teraToGas('60'),
        })
        log({ event: 'market_approved', accountId, items: sellableItems.length })
      }

      // 3. Install the scoped key and destroy the full-access one — add before
      //    delete, in one transaction, or a failure between them would leave an
      //    account nobody can use.
      await asPlayer.signAndSendTransaction({
        receiverId: accountId,
        actions: [
          actions.addFunctionCallAccessKey(
            scoped.getPublicKey(), marketContract, [...playerMethods], gasAllowance,
          ),
          actions.deleteKey(bootstrap.getPublicKey()),
        ],
      })
      log({ event: 'player_restricted', accountId, methods: playerMethods })

      return Object.freeze({
        accountId,
        publicKey: scoped.getPublicKey().toString(),
        /// The server holds this. The player never sees it, which is what makes
        /// "no seed phrase" true rather than a slogan.
        serverKey: scoped.toString(),
        created: true,
        permittedMethods: Object.freeze([...playerMethods]),
        approvedForSale: Object.freeze([...sellableItems]),
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
