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
/// used rather than anything derived from the address itself.
///
/// EIGHT bytes, not four. This was 4 — 32 bits — justified as "ample for a
/// game, and it keeps the id short enough to read out". It is not ample, and
/// the length argument did not hold:
///
///   * A collision is not a cosmetic clash. `signIn` tests only whether the
///     derived account EXISTS, so a second identity colliding with a first
///     takes the `created: false` branch, and the service then issues it a
///     session bound to the FIRST player's stored key — custodial control of
///     someone else's credit, holdings and sell rights. The original identity
///     is never stored, so nothing downstream can notice the mismatch.
///   * 32 bits is a few minutes of sha256 to hit deliberately, and on the
///     seeded login path the subject is whatever string the caller sends
///     (`scripts/serve-play.mjs`), so an attacker picks the preimage.
///   * The id was 38 characters for this root, against a 64-byte limit. The
///     space was there the whole time.
///
/// 64 bits is a birthday bound around 2^32 accounts rather than 2^16, and it
/// makes `ACCOUNT_ID_TOO_LONG` below a live guard instead of dead code: a long
/// root now genuinely cannot fit, and is refused rather than truncated.
const ID_BYTES = 8

/// The transaction hash nearcore reports, under either of the two names the
/// RPC uses for it. Same shape as `transactionHash` in signer.mjs; duplicated
/// rather than imported so this module keeps depending on nothing of ours.
const hashOf = (outcome) => outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null

/// Each dot-separated part is alphanumeric, may contain `-` or `_` internally,
/// and must begin and end alphanumeric.
const ROOT_PATTERN = /^(?:[a-z\d]+(?:[-_][a-z\d]+)*\.)*[a-z\d]+(?:[-_][a-z\d]+)*$/

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
  // NEAR's actual account-id grammar, not an approximation of it. The old
  // pattern was `[a-z0-9._-]{2,48}`, which accepts `-x`, `x-`, `_x` and `a..b`
  // — all of which nearcore refuses, so "the id is always valid" was only ever
  // true of the digest half.
  if (!root || root.length < 2 || root.length > 48 || !ROOT_PATTERN.test(root)) {
    throw new OnboardingError('ROOT_MALFORMED', String(root))
  }
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
  /// Where to park the bootstrap key while sign-in is half-finished.
  ///
  /// Optional, and omitting it is exactly the old behaviour — this module
  /// still stores nothing by itself, and the three players onboarded before
  /// this existed have nothing stored, so they keep taking the
  /// `created: false` branch as they always did.
  ///
  /// `{ get(accountId), set(accountId, secretKey), delete(accountId) }`, any
  /// of them async. What it holds is a FULL-ACCESS key, so a real
  /// implementation puts it somewhere gitignored and unreadable by anyone
  /// else, and it is deleted the moment the key is destroyed on chain.
  bootstrapStore = null,
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

  async function accessKeys(accountId) {
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
  }

  /// Has the market already been granted its pull rights over every sellable
  /// material? Read from the chain, because on a resume we cannot know how far
  /// the previous attempt got.
  ///
  /// This matters more than it looks: `mt_approve` appends, so re-approving on
  /// every resume would spend another entry in the approvals vector each time.
  /// That vector is bounded now, so a resume loop could exhaust it.
  async function alreadyApproved(accountId) {
    if (sellableItems.length === 0) return true
    try {
      return await provider.callFunction({
        contractId: itemsContract,
        method: 'mt_is_approved',
        args: {
          token_ids: [...sellableItems],
          approved_account_id: marketContract,
          // 1 of each: any standing allowance at all counts as approved.
          amounts: sellableItems.map(() => '1'),
          approval_ids: null,
          owner_id: accountId,
        },
      }) === true
    } catch {
      // Unreadable is not the same as approved. Re-approving costs a deposit
      // and an entry; believing a failed read would cost the ability to sell.
      return false
    }
  }

  /// Steps 2 and 3, as one resumable unit.
  ///
  /// Split out of `signIn` so a half-finished account can re-enter here with
  /// the parked bootstrap key instead of being stranded. `createdOutcome` is
  /// null on a resume: the creation happened in an earlier process and its
  /// hash is not ours to report.
  ///
  /// Everything below is signed with the bootstrap key, so the first thing it
  /// does is establish that the key is still on the account.
  async function finishSignIn(accountId, bootstrap, identity, createdOutcome) {
    const resuming = createdOutcome === null
    const bootstrapPublicKey = bootstrap.getPublicKey().toString()

    if (resuming) {
      // One state cannot be resumed, and it is worth naming rather than
      // failing obscurely: step 3 landed, so the account is correctly
      // restricted and holds NO full-access key — but the scoped key it was
      // restricted to was generated in memory and never returned to anyone.
      // The account is sound and unusable, and no key here can change that.
      // Say so, and stop keeping a bootstrap key that no longer exists.
      const keys = await accessKeys(accountId)
      if (!keys.some((k) => k.fullAccess && k.publicKey === bootstrapPublicKey)) {
        if (bootstrapStore) await bootstrapStore.delete(accountId)
        throw new OnboardingError(
          'ACCOUNT_ALREADY_RESTRICTED',
          `${accountId} has no bootstrap key left, so its scoped key cannot be reissued`,
        )
      }
      log({ event: 'resuming_signin', accountId, provider: identity.provider })
    }

    const asPlayer = new Account(accountId, provider, bootstrap.toString())
    const scoped = KeyPair.fromRandom('ed25519')

    // 2. Grant the market its pull rights, while a full-access key still
    //    exists to attach the deposit.
    //
    // Skipped when the chain already says it was granted. `mt_approve`
    // appends, so re-approving on a resume would spend another entry in a
    // vector that is bounded — and pay a second storage deposit for nothing.
    if (sellableItems.length > 0) {
      if (!itemsContract) throw new OnboardingError('NO_ITEMS_CONTRACT', 'sellableItems needs itemsContract')
      if (resuming && await alreadyApproved(accountId)) {
        log({ event: 'market_already_approved', accountId, items: sellableItems.length })
      } else {
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
    }

    // 3. Install the scoped key and destroy the full-access one — add before
    //    delete, in one transaction, or a failure between them would leave an
    //    account nobody can use.
    const restrictedOutcome = await asPlayer.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.addFunctionCallAccessKey(
          scoped.getPublicKey(), marketContract, [...playerMethods], gasAllowance,
        ),
        actions.deleteKey(bootstrap.getPublicKey()),
      ],
    })
    log({ event: 'player_restricted', accountId, methods: playerMethods })

    // Only now. The key this was protecting no longer exists on chain, so
    // keeping it would be holding dead full-access key material for nothing.
    // After step 3, never before: a delete that ran earlier would re-open the
    // exact window this whole mechanism exists to close.
    if (bootstrapStore) await bootstrapStore.delete(accountId)

    return Object.freeze({
      accountId,
      publicKey: scoped.getPublicKey().toString(),
      /// The server holds this. The player never sees it, which is what makes
      /// "no seed phrase" true rather than a slogan.
      serverKey: scoped.toString(),
      created: true,
      /// True when this completed a sign-in an earlier attempt left unfinished.
      /// `created` stays true because the caller's job is the same either way:
      /// store the key.
      resumed: resuming,
      permittedMethods: Object.freeze([...playerMethods]),
      approvedForSale: Object.freeze([...sellableItems]),
      /// Where it happened, for a caller that retains evidence.
      ///
      /// Step 2 is absent on purpose: `callFunction` returns the contract's
      /// parsed return value, not an outcome, and switching it to
      /// `callFunctionRaw` to harvest a hash would change what a failed
      /// approval does on the most load-bearing path in this repository. The
      /// approval is proven by reading it back with `mt_token_approval`,
      /// which is a stronger check than a hash anyway.
      ///
      /// `created` is null on a resume — that transaction belongs to an
      /// earlier process, and reporting a hash we did not see would be worse
      /// than reporting none.
      transactions: Object.freeze({
        created: hashOf(createdOutcome),
        restricted: hashOf(restrictedOutcome),
      }),
    })
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
      const parked = bootstrapStore ? await bootstrapStore.get(accountId) : null

      if (await exists(accountId)) {
        if (!parked) {
          // Already onboarded. This module stores nothing by itself, so the
          // caller holds the scoped key; there is no key to hand back here.
          return Object.freeze({ accountId, created: false, permittedMethods: Object.freeze([...playerMethods]) })
        }
        // The account exists AND a bootstrap key is parked, which can only
        // mean the last sign-in died between step 1 and step 3. Before this
        // branch that state was terminal: the key was a local `const`, so it
        // went with the stack frame, the account kept a live full-access key
        // nobody held, and `exists()` sent every later login down the
        // `created: false` path with no key to return — a permanent 503 for
        // that identity, and exactly the state `npm run keys` reports as FAIL.
        return await finishSignIn(accountId, KeyPair.fromString(parked), identity, null)
      }

      // Refuse here, where it is knowable, rather than at the first side effect.
      //
      // Reaching this line means the account does not exist and must be created,
      // which needs the root account's key. Without it the old order failed two
      // statements later instead — at `bootstrapStore.set`, writing into a
      // `.local/` the host does not have — and that failure matches none of the
      // patterns play.mjs special-cases, so it arrived as
      // `401 IDENTITY_REJECTED: ENOENT ... .local/nearcraft-bootstrap.json`.
      // A visitor was told their login was rejected when their login was fine
      // and the deployment simply cannot onboard, which is the exact
      // mislabelling play.mjs:289 was written to undo. Found on the hosted
      // deployment, which runs with no root key deliberately, so for that
      // instance this is the normal path and not an edge case.
      if (!rootKey) {
        throw new OnboardingError('ONBOARDING_MISCONFIGURED',
          'this deployment holds no key for the root account, so it cannot create accounts. '
          + 'Players already onboarded can still sign in.')
      }

      const bootstrap = KeyPair.fromRandom('ed25519')

      // Parked BEFORE the account is created, not after. The key is only worth
      // keeping because the account might come to exist, and the gap this
      // closes is precisely a crash between those two facts — so the write
      // that makes the key recoverable has to happen first.
      if (bootstrapStore) await bootstrapStore.set(accountId, bootstrap.toString())

      // 1. Create, fund, and install a temporary full-access key.
      //
      // The outcomes are kept so a caller can say WHERE this happened. An
      // account that exists is proof on its own, but a hash is what an explorer
      // takes, and `scripts/live-onboard.mjs` retains both.
      const createdOutcome = await root().signAndSendTransaction({
        receiverId: accountId,
        actions: [
          actions.createAccount(),
          actions.transfer(startingBalance),
          actions.addFullAccessKey(bootstrap.getPublicKey()),
        ],
      })
      log({ event: 'player_created', accountId, provider: identity.provider })

      return await finishSignIn(accountId, bootstrap, identity, createdOutcome)
    },


    /// What this account may actually do, read back from the chain rather than
    /// asserted — the same check `npm run keys` performs for agents.
    keyLimits: accessKeys,
  })
}
