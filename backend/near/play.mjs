// The play service: the piece that turns these modules into a game.
//
// Everything this file calls was already built and tested — the OIDC verifier,
// onboarding, the relayer, the market reader. None of it was connected to
// anything a person could use: the web page was read-only, the real verifier
// ran only in tests, and the relayer was reached only by one-shot scripts a
// judge would have to run from a terminal holding credentials.
//
// So the two headline `games` claims — "players sign in with a social or email
// login" and "no seed phrases, no wallet popups, no gas prompts" — were true
// and undemonstrable. This is the composition that makes them clickable.
//
// ## Shape, and why
//
// `handle(method, path, body)` is a plain async function over plain data. It
// binds no port, reads no environment, and takes every dependency as an
// argument. That is the same shape as `resolveFile` in scripts/serve-web.mjs,
// for the same reason: the tests can then drive the whole service offline with
// fakes, and the sandbox test can drive the identical code against a real node.
//
// ## This server is CUSTODIAL, and that is not hidden
//
// It holds players' scoped keys, read from .local/. That is the design the rest
// of the project already documents — "the server holds this, the player never
// sees it" is what makes "no seed phrase" true rather than a slogan — but a
// running service makes it concrete, so: the key never leaves this process, and
// a test asserts no response body ever contains one.
//
// The authority a held key carries is bounded by the protocol, not by us: it
// can call a named list of methods on one contract, cannot transfer NEAR, and
// cannot add another key. `GET /api/me` reports exactly that, read back from
// the chain, so a player can check what is being held on their behalf.

import { randomBytes, randomUUID } from 'node:crypto'
import { PLAYER_GAS } from './market.mjs'
import {
  buyWithCreditRequest,
  sellUnderApprovalRequest,
  investWithCreditRequest,
  MarketRequestError,
} from './market.mjs'

export class PlayRefusal extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'PlayRefusal'
    this.code = code
    this.detail = detail
  }
}

/// How a refusal becomes a status code. A malformed order is the caller's
/// fault; a missing session is unauthenticated; an underfunded root is ours.
const STATUS = {
  NO_SESSION: 401,
  SESSION_UNKNOWN: 401,
  NO_TOKEN: 400,
  ROOT_UNDERFUNDED: 503,
  NO_PLAYER_KEY: 503,
  KEY_NOT_PERSISTED: 500,
  METHOD_NOT_PERMITTED: 403,
  NOT_FOUND: 404,
  // The chain refused the call. Not the caller's fault and not a bug here, so
  // it is an upstream failure rather than a 400 or a 500.
  INNER_CALL_FAILED: 502,
  METHOD_NOT_RELAYED: 403,
  PLAYER_COULD_NOT_SIGN: 502,

  // The identity verifier's own refusals, passed through rather than flattened.
  // The split matters: a bad token is the caller's problem and a 401 tells them
  // to sign in again, while a JWKS the provider will not serve is OUR problem
  // and a 401 would send them round a loop that cannot succeed.
  IDENTITY_REJECTED: 401,
  NO_TOKEN_GIVEN: 400,
  TOKEN_MALFORMED: 401,
  ALG_NOT_ALLOWED: 401,
  NO_KID: 401,
  BAD_SIGNATURE: 401,
  WRONG_ISSUER: 401,
  WRONG_AUDIENCE: 401,
  NO_EXPIRY: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_NOT_YET_VALID: 401,
  TOKEN_FROM_THE_FUTURE: 401,
  NO_SUBJECT: 401,
  UNKNOWN_KEY: 401,
  // Upstream, not the caller.
  JWKS_UNREACHABLE: 502,
  JWKS_HTTP_ERROR: 502,
  JWKS_MALFORMED: 502,
  // Ours: the service was built wrong.
  NO_ISSUER: 500,
  NO_AUDIENCE: 500,
  NO_JWKS_URI: 500,
  NO_FETCH: 500,
  // Ours as well: the server is not set up to do what it was asked.
  ONBOARDING_MISCONFIGURED: 503,
  // Ours, and permanent. The account finished onboarding and its scoped key
  // was never recorded, so no server can act for it and retrying cannot help.
  // 410 rather than 503: 503 invites a retry, and there is nothing to retry.
  ACCOUNT_ALREADY_RESTRICTED: 410,

  // Link codes.
  LINK_CODE_INVALID: 401,
  TOO_MANY_LINK_ATTEMPTS: 429,
}

export function createPlayService({
  deployment,
  /// .local/nearcraft-keys.json. Values are SECRETS and never leave this
  /// process — see the header.
  keys = {},
  /// Which verifier is live, so /api/health can say so rather than implying a
  /// real provider is configured when none is.
  ///
  /// This service does NOT verify identities itself — `onboarding` owns the
  /// verifier and calls it inside `signIn`. So this label and that verifier
  /// must be chosen at the same place, or they can drift and the service will
  /// cheerfully report "oidc" while a stub runs. scripts/serve-play.mjs picks
  /// both in one decision, which is the only reason it is safe to pass a label.
  verifierKind = 'seed',
  onboarding,
  relayer,
  reader,
  /// Called with a newly onboarded player's scoped key so the operator can
  /// persist it.
  ///
  /// This is not optional in practice, and the reason is permanent: onboarding
  /// returns `serverKey` ONLY on the run that creates the account, and deletes
  /// that account's full-access key in the same transaction. Lose the key and
  /// the player can never be signed for again by anyone — there is nothing left
  /// that could add another. A key held only in process memory survives until
  /// the next restart and then strands the account for good.
  saveKey = null,
  /// Whether this deployment can create a NEW player: it needs a key for the
  /// root account and enough balance. Reported by /api/health rather than
  /// discovered by the first person who tries to sign up.
  canOnboard = null,
  newSessionId = () => randomUUID(),
  /// Injectable so the link code's expiry can be tested without waiting.
  now = () => Date.now(),
  log = () => {},
}) {
  if (!onboarding?.signIn) throw new PlayRefusal('NO_ONBOARDING')
  if (!relayer?.relay) throw new PlayRefusal('NO_RELAYER')
  if (!reader) throw new PlayRefusal('NO_MARKET_READER')

  /// Sessions live in memory for the life of the process. A restart means
  /// signing in again, which is stated rather than papered over: persisting
  /// them would mean a session store, and this repository has one runtime
  /// dependency and keeps it.
  const sessions = new Map()

  // ------------------------------------------------------- the link code
  //
  // Why this exists, measured rather than assumed: a Google id token is about
  // 977 characters and Minecraft caps chat and command input at 256. A real
  // login is 3.8x too long to type into the game, so `/nearcraft link <token>`
  // cannot work with a real provider at all. The browser signs in, asks for one
  // of these, and the player types eight characters instead.
  //
  // It is a bearer credential, so the design is about keeping the window small:
  const LINK_CODE_TTL_MS = 120_000
  const LINK_CODE_LENGTH = 8
  /// Crockford base32: no I, L, O or U, so nothing is ambiguous when read off a
  /// screen and typed. 32 symbols over 8 characters is 40 bits.
  const LINK_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  /// 40 bits is a loop away without this. The window is short, so a cap that
  /// self-heals is enough — a permanent lockout would be its own denial of
  /// service.
  const LINK_MAX_FAILURES = 10

  const linkCodes = new Map()
  let failures = { count: 0, since: now() }

  function newLinkCode() {
    // randomBytes, not Math.random. 256 divides by 32 exactly, so taking the
    // remainder is uniform rather than merely convenient.
    let out = ''
    for (const byte of randomBytes(LINK_CODE_LENGTH)) out += LINK_ALPHABET[byte % 32]
    return out
  }

  function sweepLinkCodes() {
    for (const [code, entry] of linkCodes) if (entry.expiresAt <= now()) linkCodes.delete(code)
    if (now() - failures.since > LINK_CODE_TTL_MS) failures = { count: 0, since: now() }
  }

  const ok = (body) => ({ status: 200, body })
  const refuse = (e) => ({
    status: STATUS[e.code] ?? 400,
    body: { error: e.code, detail: e.detail ?? null },
  })

  /// The scoped key for a player, or a refusal that says which of the two
  /// reasons applies — the server was never given it, or the account has none.
  function playerKey(accountId) {
    const key = keys[`${accountId}#scoped`]
    if (!key) {
      throw new PlayRefusal(
        'NO_PLAYER_KEY',
        `this server holds no scoped key for ${accountId}; it was onboarded elsewhere`,
      )
    }
    return key
  }

  function session(sessionId) {
    if (!sessionId) throw new PlayRefusal('NO_SESSION', 'sign in first')
    const s = sessions.get(sessionId)
    if (!s) throw new PlayRefusal('SESSION_UNKNOWN', 'this session expired, or the server restarted')
    return s
  }

  /// Relay one call for a signed-in player, and measure what it cost them.
  ///
  /// The balance is read either side on purpose. "The player pays nothing" is a
  /// claim about money, and a claim about money should be measured rather than
  /// asserted — the same reason tests/near/gasless.mjs watches both balances.
  async function relayFor(s, { methodName, args }) {
    const permitted = s.permittedMethods ?? []
    if (permitted.length && !permitted.includes(methodName)) {
      throw new PlayRefusal(
        'METHOD_NOT_PERMITTED',
        `this player's key grants [${permitted.join(', ')}]. A player key is immutable ` +
        `for life — onboarding deletes the full-access key — so ${methodName} can never be added to it.`,
      )
    }
    const before = BigInt(await reader.nearBalance(s.accountId))
    const result = await relayer.relay({
      playerAccountId: s.accountId,
      playerKey: playerKey(s.accountId),
      methodName,
      args,
      // EXPLICIT, because the relayer's default is 60 TGas and that is not
      // enough for every method here. `sell` statically reserves 27 TGas for
      // the cross-contract pull and its callback before its own body runs, and
      // `scripts/live-player.mjs` was raised to 100 TGas for exactly that —
      // while this path, the one a browser and the Minecraft plugin actually
      // use, was left on the default. An out-of-gas there lands on the
      // mt_transfer receipt and is absorbed by `on_materials_pulled`, so the
      // symptom is a 502 that never mentions gas.
      gas: PLAYER_GAS,
    })
    const after = BigInt(await reader.nearBalance(s.accountId))
    log({ event: 'relayed', accountId: s.accountId, methodName, delta: (after - before).toString() })
    return {
      hash: result?.outcome?.transaction?.hash ?? result?.outcome?.transaction_outcome?.id ?? null,
      playerNearBefore: before.toString(),
      playerNearAfter: after.toString(),
      // Signed, and expected to be exactly 0. Not clamped: if a player ever did
      // pay, this has to show it.
      playerNearDelta: (after - before).toString(),
    }
  }

  return Object.freeze({
    async handle(method, path, body = {}) {
      try {
        // ------------------------------------------------------------ health
        if (method === 'GET' && path === '/api/health') {
          return ok({
            playable: true,
            // null means "not determined", which is honest; the server that
            // knows passes a boolean.
            canOnboard,
            /// How a long token reaches a game that cannot carry one.
            linkCodes: true,
            // Say which verifier is live. Reporting "oidc" when the seed
            // verifier is running would be the exact overclaim this project
            // spent a round removing from its own documentation.
            verifier: verifierKind,
            custodial: true,
            contracts: deployment?.contracts ?? null,
            network: deployment?.network ?? 'testnet',
            rpc: deployment?.rpc ?? reader.rpcUrl,
            relayer: deployment?.relayer?.account_id ?? null,
          })
        }

        // ----------------------------------------------------------- sign in
        if (method === 'POST' && path === '/api/session') {
          const token = body?.token
          if (!token) throw new PlayRefusal('NO_TOKEN', 'a login token is required')

          let result
          try {
            result = await onboarding.signIn(String(token))
          } catch (e) {
            // Creating an account costs the root account a deposit plus gas
            // headroom, and nearcore reserves against a pessimistically
            // inflated gas price (~0.061 NEAR for a 60 TGas call). An
            // underfunded root is an operational problem, not a bad request,
            // so it gets its own code and a 503 rather than a stack trace.
            // An onboarding failure is not automatically an identity failure.
            //
            // This catch used to label everything IDENTITY_REJECTED, so a
            // missing root signer surfaced as "IDENTITY_REJECTED: Please set a
            // signer" — telling a player their login was refused when their
            // login was fine and the server was misconfigured. Identity
            // refusals carry a code from the verifier; chain failures do not.
            // Carried as a code, not inferred from a message. onboarding.mjs
            // now refuses before it touches disk or chain when there is no root
            // key, so the specific error arrives intact and does not have to be
            // recognised by its prose.
            if (e?.code === 'ONBOARDING_MISCONFIGURED') {
              throw new PlayRefusal('ONBOARDING_MISCONFIGURED', e.detail ?? e.message)
            }
            if (/Please set a signer|no signer|NoSigner/i.test(e?.message ?? '')) {
              throw new PlayRefusal('ONBOARDING_MISCONFIGURED',
                'this server cannot create accounts: it holds no key for the root account. ' +
                'That is a deployment problem, not a problem with your login.')
            }
            // "Not enough balance", with spaces, is what nearcore actually says.
            //
            // This pattern was written as /NotEnoughBalance/ — the name of the
            // error variant, not the text of the message — so ROOT_UNDERFUNDED
            // could never fire. The README documented that refusal, the service
            // could not produce it, and the real message arrived as a 401
            // IDENTITY_REJECTED telling the player their login was bad. Found
            // by funding the path far enough to reach it.
            if (/not.?enough.?balance|insufficient|exceed/i.test(e?.message ?? '')) {
              throw new PlayRefusal(
                'ROOT_UNDERFUNDED',
                'this deployment cannot onboard a NEW player: the root account is below the ' +
                'gas headroom nearcore reserves. Top it up at https://near-faucet.io. ' +
                'Players already onboarded can still sign in.',
              )
            }
            // An account whose sign-in got all the way through step 3 before
            // dying is sound on chain and unusable: it holds a scoped key that
            // was generated in memory and never handed to anyone, and no key
            // left anywhere can issue another. That is a deployment fact, not
            // a verdict on the player's login — reporting it as
            // IDENTITY_REJECTED is the same mislabelling the two branches above
            // exist to undo.
            if (e?.code === 'ACCOUNT_ALREADY_RESTRICTED') {
              throw new PlayRefusal('ACCOUNT_ALREADY_RESTRICTED',
                'this account finished onboarding but its signing key was never recorded, ' +
                'so no server can act for it. Your login is fine; the account is not recoverable.')
            }
            // Surface the specific refusal when the verifier gave one. The
            // generic code remains the fallback, so nothing depends on a new
            // one existing.
            throw new PlayRefusal(e?.identityCode ?? 'IDENTITY_REJECTED', e?.detail ?? e?.message ?? String(e))
          }

          const accountId = result.accountId

          // A newly created player hands its scoped key back exactly once.
          // Keep it, and give the operator a chance to persist it, before
          // anything else can fail — see `saveKey`.
          if (result.serverKey) {
            keys[accountId + '#scoped'] = result.serverKey
            if (saveKey) {
              try {
                await saveKey(accountId, result.serverKey)
              } catch (e) {
                // Refuse rather than hand back a working session whose key will
                // vanish at restart and strand an account nothing can re-key.
                throw new PlayRefusal('KEY_NOT_PERSISTED', e?.message ?? String(e))
              }
            }
          }

          // Fail the sign-in rather than hand back a session that cannot act.
          playerKey(accountId)

          const limits = await onboarding.keyLimits(accountId)
          const scoped = limits.find((k) => !k.fullAccess)
          const sessionId = newSessionId()
          sessions.set(sessionId, {
            accountId,
            // Read from the CHAIN, not from configuration. The manifest
            // claimed a method the key did not grant once already.
            permittedMethods: scoped?.methodNames ?? [],
          })
          log({
            event: 'signed_in', accountId, created: Boolean(result.created),
            ...(result.resumed ? { resumed: true } : {}),
          })

          return ok({
            sessionId,
            accountId,
            created: Boolean(result.created),
            verifier: verifierKind,
            permittedMethods: scoped?.methodNames ?? [],
            fullAccessKeys: limits.filter((k) => k.fullAccess).length,
            // Present only on the run that CREATED the account, because only
            // that run had anything to send. A caller retaining evidence needs
            // somewhere an explorer can be pointed at; a returning player has
            // no new transactions and gets no field.
            ...(result.transactions ? { transactions: result.transactions } : {}),
          })
        }

        // --------------------------------------------------------- link codes
        //
        // Minting needs a session, so a code can only ever be issued for an
        // identity that has already been verified. Without that, this route
        // would mint sessions for arbitrary accounts.
        if (method === 'POST' && path === '/api/link-code') {
          const s = session(body?.sessionId)
          sweepLinkCodes()
          const code = newLinkCode()
          linkCodes.set(code, {
            accountId: s.accountId,
            permittedMethods: s.permittedMethods,
            expiresAt: now() + LINK_CODE_TTL_MS,
          })
          log({ event: 'link_code_issued', accountId: s.accountId })
          // The code is returned, never logged: it is a bearer credential for
          // the next two minutes.
          return ok({ code, expiresInMs: LINK_CODE_TTL_MS, accountId: s.accountId })
        }

        if (method === 'POST' && path === '/api/link') {
          sweepLinkCodes()
          if (failures.count >= LINK_MAX_FAILURES) {
            throw new PlayRefusal('TOO_MANY_LINK_ATTEMPTS',
              'too many wrong codes; wait for the current ones to expire and get a fresh one')
          }
          const code = String(body?.code ?? '').trim().toUpperCase()
          const entry = code ? linkCodes.get(code) : null
          // The TTL is enforced twice on purpose, and neither is redundant for
          // the reason it looks like: the sweep above reclaims memory and
          // happens to remove the entry, while this check is what still holds
          // if a future change makes the sweep lazy or partial. Removing ONLY
          // this one leaves the expiry test passing — verified — so the test is
          // asserting the property rather than either implementation of it.
          if (!entry || entry.expiresAt <= now()) {
            failures.count++
            // One refusal for "wrong" and "expired" alike. Telling them apart
            // would let this route be used to discover which codes existed.
            throw new PlayRefusal('LINK_CODE_INVALID', 'that code is not valid, or it has expired')
          }
          // Single use, deleted before anything else can fail.
          linkCodes.delete(code)
          failures = { count: 0, since: now() }

          const limits = await onboarding.keyLimits(entry.accountId)
          const scoped = limits.find((k) => !k.fullAccess)
          const sessionId = newSessionId()
          // A NEW session, not a share of the browser's. Quitting the game
          // revokes this one and leaves the browser signed in.
          sessions.set(sessionId, {
            accountId: entry.accountId,
            permittedMethods: scoped?.methodNames ?? entry.permittedMethods,
          })
          log({ event: 'link_claimed', accountId: entry.accountId })
          return ok({
            sessionId,
            accountId: entry.accountId,
            created: false,
            verifier: verifierKind,
            permittedMethods: scoped?.methodNames ?? entry.permittedMethods,
            fullAccessKeys: limits.filter((k) => k.fullAccess).length,
          })
        }

        // ------------------------------------------------------------- reads
        if (method === 'GET' && path === '/api/materials') {
          return ok({ materials: await reader.materials() })
        }

        if (method === 'GET' && path === '/api/market') {
          const item = body?.item
          const count = Number(body?.count ?? 1)
          if (!item) throw new PlayRefusal('NO_ITEM', 'name a material')
          return ok({ item, count, merchants: await reader.quotes(item, count) })
        }

        if (method === 'GET' && path === '/api/me') {
          const s = session(body?.sessionId)
          const materials = await reader.materials()
          const [credit, held, near, limits] = await Promise.all([
            reader.creditOf(s.accountId),
            reader.heldBy(s.accountId, materials),
            reader.nearBalance(s.accountId),
            onboarding.keyLimits(s.accountId),
          ])
          return ok({
            accountId: s.accountId,
            credit: String(credit),
            near,
            holdings: Object.fromEntries(materials.map((m, i) => [m, String(held[i] ?? '0')])),
            permittedMethods: s.permittedMethods,
            // The security claim, read back from the protocol on every call
            // rather than asserted once in a README.
            fullAccessKeys: limits.filter((k) => k.fullAccess).length,
            scopedKeys: limits.filter((k) => !k.fullAccess).length,
          })
        }

        // ------------------------------------------------------------ writes
        if (method === 'POST' && path === '/api/buy') {
          const s = session(body?.sessionId)
          const req = buyWithCreditRequest({
            merchantId: body?.merchantId, item: body?.item, count: Number(body?.count),
          })
          return ok(await relayFor(s, req))
        }

        if (method === 'POST' && path === '/api/sell') {
          const s = session(body?.sessionId)
          const item = body?.item
          // The approval id is read from the chain rather than taken from the
          // caller: it is the market's standing grant over this player's
          // materials, and a caller that could name it could name someone
          // else's.
          const approvalId = await reader.approvalFor(s.accountId, item)
          if (approvalId === null) {
            throw new PlayRefusal(
              'NO_APPROVAL',
              'the market holds no approval over this material for this player, and a ' +
              'scoped key cannot grant one — it is granted once at onboarding.',
            )
          }
          const req = sellUnderApprovalRequest({
            merchantId: body?.merchantId, item, count: Number(body?.count), approvalId,
          })
          return ok(await relayFor(s, req))
        }

        if (method === 'POST' && path === '/api/invest') {
          const s = session(body?.sessionId)
          const req = investWithCreditRequest({
            merchantId: body?.merchantId, amount: String(body?.amount ?? ''),
          })
          return ok(await relayFor(s, req))
        }

        throw new PlayRefusal('NOT_FOUND', `${method} ${path}`)
      } catch (e) {
        if (e instanceof PlayRefusal) return refuse(e)
        // A malformed order is the caller's fault and already carries a code.
        if (e instanceof MarketRequestError) return { status: 400, body: { error: e.code, detail: e.detail ?? null } }
        // RelayRefusal and OnboardingError both carry a `code`. Passing it
        // through beats collapsing them into INTERNAL, which is what made a
        // relayed call that panicked indistinguishable from a bug in here.
        if (e?.code && STATUS[e.code]) {
          return { status: STATUS[e.code], body: { error: e.code, detail: e.detail ?? e.message ?? null } }
        }
        // Anything else is ours. Surface the code, never a stack: a stack from
        // a custodial server is a disclosure risk, not a debugging aid.
        log({ event: 'error', message: e?.message ?? String(e) })
        return { status: 500, body: { error: 'INTERNAL', detail: e?.message ?? String(e) } }
      }
    },
  })
}
