// Verify a REAL id token from a real provider, and print the account it owns.
//
//   npm run oidc:verify -- "<id token>"
//
// This is the last mile of the identity claim. Everything else about OIDC in
// this repository is proven — the verifier has 25 offline tests, and
// tests/near/oidc-runtime.mjs drives it over a real HTTP JWKS inside the real
// service — but a token that GOOGLE signed has never been through it, because
// obtaining one needs a browser and a consent screen. One command, one paste,
// and that sentence changes.
//
// It reads the same configuration `npm run play` reads, so a pass here means
// the deployment is configured correctly and not just that the code works.
// It makes no chain call, spends nothing, and prints no part of the token.

import { readFile } from 'node:fs/promises'
import { createOidcVerifier } from '../backend/near/oidc.mjs'
import { playerAccountId } from '../backend/near/onboarding.mjs'

const ROOT = new URL('..', import.meta.url)
const token = process.argv.slice(2).find((a) => !a.startsWith('--'))

let file = null
try {
  file = JSON.parse(await readFile(new URL('.local/oidc.json', ROOT), 'utf8'))
} catch { /* env-only is fine */ }

const config = {
  issuer: process.env.OIDC_ISSUER ?? file?.issuer,
  audience: process.env.OIDC_AUDIENCE ?? file?.audience,
  jwksUri: process.env.OIDC_JWKS_URI ?? file?.jwksUri,
  provider: process.env.OIDC_PROVIDER ?? file?.provider,
}

const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const root = manifest.root ?? manifest.contracts?.market?.split('.').slice(1).join('.')

console.log('\n  configuration this check and `npm run play` both read:\n')
console.log(`    issuer    ${config.issuer ?? '(unset)'}`)
console.log(`    audience  ${config.audience ? '…' + String(config.audience).slice(-28) : '(unset)'}`)
console.log(`    jwks      ${config.jwksUri ?? '(unset)'}`)
console.log(`    provider  ${config.provider ?? '(unset — accounts are labelled with the issuer URL)'}`)

if (!config.issuer || !config.audience || !config.jwksUri) {
  console.error('\n  Not configured. Put issuer, audience and jwksUri in .local/oidc.json,')
  console.error('  or set OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI.\n')
  process.exit(1)
}

if (!token) {
  console.log('\n  No token given, so nothing has been verified.')
  console.log('  Get one from your provider and run:\n')
  console.log('    npm run oidc:verify -- "<id token>"\n')
  console.log('  For Google: sign in at https://developers.google.com/oauthplayground with')
  console.log('  this client id, request the `openid` scope, and copy the id_token.\n')
  process.exit(2)
}

const verifier = createOidcVerifier(config)

let identity
try {
  identity = await verifier.verifyIdentity(token)
} catch (e) {
  console.error(`\n  REFUSED  ${e.code ?? 'ERROR'}: ${e.detail ?? e.message}\n`)
  if (e.code === 'WRONG_AUDIENCE') {
    console.error('  That token was issued for a different client id than the one configured.\n')
  }
  if (e.code === 'TOKEN_EXPIRED') {
    console.error('  id tokens are short-lived. Get a fresh one and run this again.\n')
  }
  process.exit(1)
}

const accountId = root ? playerAccountId(identity.provider, identity.subject, root) : null

console.log('\n  VERIFIED, against the provider\'s live JWKS.\n')
console.log(`    provider  ${identity.provider}`)
// The subject is a stable per-user identifier at the provider. It is printed
// because it is the input to the account derivation and a reader needs to see
// that the id below is a function of it — nothing else about the token is.
console.log(`    subject   ${identity.subject}`)
if (accountId) {
  console.log(`\n    this login owns  ${accountId}`)
  console.log(`\n  Derived as sha256("${identity.provider}:<subject>") — one way, so the`)
  console.log('  account reveals nothing about the login. Change the provider label and')
  console.log('  this id changes, which would strand the account. Pin it once.\n')
}
