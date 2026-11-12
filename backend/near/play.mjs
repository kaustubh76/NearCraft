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

import { randomUUID } from 'node:crypto'
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
  newSessionId = () => randomUUID(),
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
            if (/NotEnoughBalance|insufficient|exceed/i.test(e?.message ?? '')) {
              throw new PlayRefusal(
                'ROOT_UNDERFUNDED',
                'this deployment cannot onboard a NEW player: the root account is below the ' +
                'gas headroom nearcore reserves. Top it up at https://near-faucet.io. ' +
                'Players already onboarded can still sign in.',
              )
            }
            throw new PlayRefusal('IDENTITY_REJECTED', e?.message ?? String(e))
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
          log({ event: 'signed_in', accountId, created: Boolean(result.created) })

          return ok({
            sessionId,
            accountId,
            created: Boolean(result.created),
            verifier: verifierKind,
            permittedMethods: scoped?.methodNames ?? [],
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
