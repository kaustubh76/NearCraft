// Real OIDC identity verification — the last stub in this project.
//
// `backend/near/onboarding.mjs` takes a `verifyIdentity(token)` that returns
// `{provider, subject}`, and until now every caller supplied a fake. The
// mechanism around it was real and measured; the verification was not, and the
// README said so in six places. This is that function, for real.
//
// No new dependency. Node verifies a JWT against a JWKS with `crypto` alone:
// `createPublicKey({ format: 'jwk' })` imports the provider's key and
// `crypto.verify` checks the signature. This repo has one runtime dependency
// and is better for keeping it that way.
//
// ## What it checks, and why each one is load-bearing
//
//   * **`alg` against an allowlist.** The single most important check here.
//     `alg: "none"` is a token with no signature at all, and an HMAC `alg` is
//     the classic confusion attack: the verifier is holding the provider's
//     PUBLIC key, which is public, so an attacker who can make us treat it as
//     an HMAC secret can mint any token they like. The algorithm comes from the
//     attacker-controlled header, so it is never trusted — only matched.
//   * **`kid`, required.** Without it we would have to try every key in the
//     JWKS, which turns a rotation into a guessing game.
//   * **The signature over the exact bytes received.** Verified against
//     `header.payload` as transmitted, never re-serialised — canonicalising
//     first would verify a document the provider never signed.
//   * **`iss` exactly, `aud` containing our client id.** A valid Google token
//     issued for somebody else's application is still somebody else's token.
//   * **`exp`, and `nbf`/`iat` when present**, with a small clock skew.
//   * **`sub` non-empty.** It is what the account id derives from, so an empty
//     one would collide every anonymous login onto one NEAR account.
//
// ## What it deliberately does not do
//
// No userinfo call, no email, no profile. The only thing this project needs
// from an identity is a stable, unique subject to derive an account from — see
// `playerAccountId` — so asking for more would be collecting data we have no
// use for.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export class IdentityRejected extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'IdentityRejected'
    this.code = code
    this.detail = detail
  }
}

/// Signature algorithms we accept, and how Node must be told to check each.
///
/// An allowlist, not a denylist. A denylist would have to anticipate every
/// algorithm name a provider or an attacker might send; this only has to name
/// the two that real providers actually use.
const ALGORITHMS = {
  RS256: { hash: 'RSA-SHA256', options: {} },
  RS384: { hash: 'RSA-SHA384', options: {} },
  RS512: { hash: 'RSA-SHA512', options: {} },
  // JOSE carries an ECDSA signature as raw r‖s; Node defaults to DER and would
  // reject every valid Apple token without this.
  ES256: { hash: 'SHA256', options: { dsaEncoding: 'ieee-p1363' } },
}

const DEFAULT_SKEW_SEC = 60
const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000

function base64UrlToBuffer(part, what) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new IdentityRejected('TOKEN_MALFORMED', `${what} is not base64url`)
  }
  return Buffer.from(part, 'base64url')
}

function parseJson(buffer, what) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new IdentityRejected('TOKEN_MALFORMED', `${what} is not JSON`)
  }
}

/// A verifier for one provider.
///
/// `issuer` and `audience` are required and have no defaults on purpose: a
/// verifier that accepted any issuer, or any audience, would accept tokens
/// minted for a different application and hand that person someone else's
/// NEAR account.
export function createOidcVerifier({
  issuer,
  audience,
  jwksUri,
  provider,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  clockSkewSec = DEFAULT_SKEW_SEC,
  jwksTtlMs = DEFAULT_JWKS_TTL_MS,
}) {
  if (!issuer) throw new IdentityRejected('NO_ISSUER', 'an issuer is required')
  if (!audience) throw new IdentityRejected('NO_AUDIENCE', 'a client id is required')
  if (!jwksUri) throw new IdentityRejected('NO_JWKS_URI', 'a JWKS endpoint is required')
  if (typeof fetchImpl !== 'function') throw new IdentityRejected('NO_FETCH')

  // The label that goes into the account derivation. Defaults to the issuer,
  // which is canonical and distinct per provider — and because
  // `playerAccountId` hashes it, changing this moves every account, so it must
  // be stable for the life of a deployment.
  const providerLabel = provider ?? issuer

  let cache = { keys: new Map(), fetchedAt: 0 }

  async function fetchJwks() {
    let res
    try {
      res = await fetchImpl(jwksUri)
    } catch (e) {
      throw new IdentityRejected('JWKS_UNREACHABLE', e?.message ?? String(e))
    }
    if (!res?.ok) throw new IdentityRejected('JWKS_HTTP_ERROR', `${res?.status} from ${jwksUri}`)

    let body
    try {
      body = await res.json()
    } catch {
      throw new IdentityRejected('JWKS_MALFORMED', 'not JSON')
    }
    if (!Array.isArray(body?.keys) || body.keys.length === 0) {
      throw new IdentityRejected('JWKS_MALFORMED', 'no keys')
    }

    const keys = new Map()
    for (const jwk of body.keys) {
      if (!jwk?.kid) continue // unusable: we match on kid
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
      } catch {
        // One unusable key must not poison a rotation that also brought a good
        // one, so skip it rather than failing the whole fetch.
      }
    }
    if (keys.size === 0) throw new IdentityRejected('JWKS_MALFORMED', 'no usable keys with a kid')
    cache = { keys, fetchedAt: now() }
    return keys
  }

  async function keyFor(kid) {
    const fresh = now() - cache.fetchedAt < jwksTtlMs
    if (fresh && cache.keys.has(kid)) return cache.keys.get(kid)
    // An unknown kid is the normal signal that the provider rotated, so refetch
    // once before refusing — but only once, or an attacker could use made-up
    // kids to make us hammer the provider.
    const keys = await fetchJwks()
    const key = keys.get(kid)
    if (!key) throw new IdentityRejected('UNKNOWN_KEY', `no key with kid ${kid}`)
    return key
  }

  return Object.freeze({
    provider: providerLabel,

    /// Verify an ID token and return the identity `onboarding.signIn` expects.
    async verifyIdentity(token) {
      if (typeof token !== 'string' || !token) {
        throw new IdentityRejected('NO_TOKEN')
      }
      const parts = token.split('.')
      if (parts.length !== 3) {
        throw new IdentityRejected('TOKEN_MALFORMED', `expected 3 segments, got ${parts.length}`)
      }
      const [rawHeader, rawPayload, rawSignature] = parts

      const header = parseJson(base64UrlToBuffer(rawHeader, 'header'), 'header')
      const spec = ALGORITHMS[header.alg]
      if (!spec) {
        // Covers alg:none and every HMAC variant without naming them.
        throw new IdentityRejected('ALG_NOT_ALLOWED', `${header.alg} is not in [${Object.keys(ALGORITHMS)}]`)
      }
      if (!header.kid) throw new IdentityRejected('NO_KID', 'the header names no key')

      const key = await keyFor(header.kid)

      // Exactly the bytes the provider signed.
      const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii')
      const signature = base64UrlToBuffer(rawSignature, 'signature')
      if (!cryptoVerify(spec.hash, signed, { key, ...spec.options }, signature)) {
        throw new IdentityRejected('BAD_SIGNATURE', `did not verify under kid ${header.kid}`)
      }

      // Only now is the payload worth reading.
      const claims = parseJson(base64UrlToBuffer(rawPayload, 'payload'), 'payload')

      if (claims.iss !== issuer) {
        throw new IdentityRejected('WRONG_ISSUER', `${claims.iss} != ${issuer}`)
      }
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!audiences.includes(audience)) {
        throw new IdentityRejected('WRONG_AUDIENCE', `${JSON.stringify(claims.aud)} does not include ${audience}`)
      }

      const nowSec = Math.floor(now() / 1000)
      if (typeof claims.exp !== 'number') {
        throw new IdentityRejected('NO_EXPIRY', 'a token that never expires is not acceptable')
      }
      if (nowSec > claims.exp + clockSkewSec) {
        throw new IdentityRejected('TOKEN_EXPIRED', `exp ${claims.exp} < now ${nowSec}`)
      }
      if (typeof claims.nbf === 'number' && nowSec + clockSkewSec < claims.nbf) {
        throw new IdentityRejected('TOKEN_NOT_YET_VALID', `nbf ${claims.nbf} > now ${nowSec}`)
      }
      if (typeof claims.iat === 'number' && nowSec + clockSkewSec < claims.iat) {
        throw new IdentityRejected('TOKEN_FROM_THE_FUTURE', `iat ${claims.iat} > now ${nowSec}`)
      }

      if (typeof claims.sub !== 'string' || !claims.sub) {
        throw new IdentityRejected('NO_SUBJECT', 'sub is what the account id derives from')
      }

      return Object.freeze({ provider: providerLabel, subject: claims.sub })
    },
  })
}
