// A local OpenID Connect issuer, so the real login path can be driven without
// a provider.
//
//   node scripts/oidc-dev.mjs                 serve the JWKS and print a token
//   node scripts/oidc-dev.mjs --token alice   print a token for one subject
//
// WHY. `.local/oidc.json` points at Google, which is correct for a deployment
// and useless for a demo: obtaining a Google id token needs a browser, a
// consent screen and a redirect URI. This issues tokens that are real in every
// way that matters to the verifier — RS256, a published JWKS, correct
// iss/aud/sub/iat/exp — and are signed by a key on this machine.
//
// It proves the CODE PATH, not the provider. A token from here is not a token
// Google signed, and no document in this repository says otherwise.

import { createServer } from 'node:http'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url)
const KEYFILE = new URL('.local/oidc-dev-key.json', ROOT)
const PORT = Number(process.env.OIDC_DEV_PORT ?? 8090)
const KID = 'nearcraft-dev-1'
const AUDIENCE = process.env.OIDC_DEV_AUDIENCE ?? 'nearcraft-dev'
const TTL_SEC = 3600

/// The key is persisted so tokens stay valid across restarts — and, more
/// importantly, so a player's account id stays the same. The id derives from
/// the subject, not the key, but a fresh issuer with a fresh key would still
/// invalidate every token already handed out.
async function keypair() {
  try {
    const saved = JSON.parse(await readFile(KEYFILE, 'utf8'))
    return { privateKeyPem: saved.privateKey, jwk: saved.jwk }
  } catch { /* first run */ }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }
  await mkdir(new URL('.local/', ROOT), { recursive: true })
  await writeFile(KEYFILE, JSON.stringify({
    note: 'Development OIDC signing key. Private, gitignored, and NOT a provider credential — it signs tokens for npm run play:oidc and the bot fixture. Deleting it is harmless; a new one is generated and previously issued tokens stop verifying.',
    privateKey: privateKeyPem, jwk,
  }, null, 2) + '\n')
  await chmod(KEYFILE, 0o600)
  return { privateKeyPem, jwk }
}

const { privateKeyPem, jwk } = await keypair()
const issuer = process.env.OIDC_DEV_ISSUER ?? `http://127.0.0.1:${PORT}`
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function mintToken(subject, { audience = AUDIENCE, ttlSec = TTL_SEC } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: KID })
  const payload = b64({ iss: issuer, aud: audience, sub: String(subject), iat: now - 5, exp: now + ttlSec })
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString('base64url')}`
}

// --token prints one and exits, for scripts that need a token without a server.
const at = process.argv.indexOf('--token')
if (at >= 0) {
  process.stdout.write(mintToken(process.argv[at + 1] ?? 'dev-player'))
  process.exit(0)
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/.well-known/jwks.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
    return
  }
  if (req.url.startsWith('/.well-known/openid-configuration')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      issuer, jwks_uri: `${issuer}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['RS256'],
    }))
    return
  }
  res.writeHead(404).end('jwks is at /.well-known/jwks.json')
})

// An 'error' event with no listener is re-thrown by EventEmitter, so a taken
// port was a raw stack — and `npm run mc:up -- --oidc` then waited its full
// twenty seconds before reporting "the OIDC issuer never came up". The play
// service got this handler; the issuer did not, and the two are started by the
// same script.
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n  127.0.0.1:${PORT} is already taken by another process.`)
    console.error('  Free it, or choose another port:  OIDC_DEV_PORT=8091 npm run oidc:dev')
    console.error('  npm run mc:up takes --issuer-port <n> for the same reason.\n')
    process.exit(1)
  }
  throw e
})

server.listen(PORT, '127.0.0.1', () => {
  const token = mintToken('dev-player')
  console.log(`\n  a local OIDC issuer, for driving the real login path\n`)
  console.log(`  issuer    ${issuer}`)
  console.log(`  jwks      ${issuer}/.well-known/jwks.json`)
  console.log(`  audience  ${AUDIENCE}`)
  console.log(`  key       .local/oidc-dev-key.json  (private, gitignored)`)
  console.log(`\n  Run the service against it, in another terminal:\n`)
  console.log(`    npm run play:oidc\n`)
  console.log(`  A token for "dev-player", valid ${TTL_SEC / 60} minutes — paste it into the page's sign-in box:\n`)
  console.log(`${token}\n`)
  console.log(`  ${token.length} characters. Minecraft caps chat at 256, which is why the game`)
  console.log(`  uses /nearcraft claim <code> instead — see docs/GASLESS.md.\n`)
  console.log(`  This proves the code path. It is NOT a token Google signed.\n`)
})
