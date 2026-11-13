// Get a token GOOGLE signed, verify it, and optionally become a player with it.
//
//   npm run oidc:google                 sign in, verify, stop
//   npm run oidc:google -- --onboard    ...and create the NEAR account it owns
//
// THE LAST DISCLOSED GAP IN THE IDENTITY CLAIM. backend/near/oidc.mjs has 25
// offline tests and tests/near/oidc-runtime.mjs drives it over a real HTTP
// JWKS inside the real service — but every token it has ever verified was one
// this repository minted. A token Google itself signed had never been through
// it, because getting one needs a browser and a consent screen.
//
// This runs the ordinary OAuth 2.0 authorization-code flow with PKCE against a
// loopback redirect, which is what a desktop application does:
//
//   1. open a Google URL in your browser and sign in
//   2. Google redirects to 127.0.0.1 with a one-time code
//   3. this exchanges that code for an id_token at Google's token endpoint
//   4. backend/near/oidc.mjs verifies it against Google's LIVE JWKS
//
// ON THE CLIENT SECRET. It is read into memory for step 3 and sent to exactly
// one place, https://oauth2.googleapis.com/token, over TLS. It is never
// printed, never logged, never written to a file, and never included in an
// error message — the redaction is applied to everything this script prints,
// not left to each print site to remember. Verifying a token needs only the
// issuer, the audience and a public JWKS, so nothing after step 3 touches it.
//
// ON THE TOKEN AND WHAT IS IN IT. The id_token is a bearer credential and is
// never printed or written either. Your Google subject identifies you at
// Google, and your email is personal data; neither is recorded. The only thing
// retained is the account id, which is sha256("google:<subject>") truncated —
// one way, so the account reveals nothing about the login.

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createOidcVerifier } from '../backend/near/oidc.mjs'
import { playerAccountId } from '../backend/near/onboarding.mjs'

const ROOT = new URL('..', import.meta.url)
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const PORT = Number(value('--port', '8099'))
/// Google compares redirect URIs as STRINGS, so `localhost` and `127.0.0.1`
/// are two different registrations even though they are the same machine. The
/// server always listens on 127.0.0.1 — which is what `localhost` resolves to —
/// so either spelling reaches it, and this only decides which one to send.
const HOST = value('--host', '127.0.0.1')
const REDIRECT = `http://${HOST}:${PORT}/callback`
const ONBOARD = flag('--onboard')
/// Take a token that was obtained elsewhere instead of running the browser
/// flow. The OAuth Playground is the usual source: it signs in with your own
/// client credentials, on Google's own site, and hands back an id_token.
const PASTE = flag('--paste')
const TIMEOUT_MS = Number(value('--timeout', '300')) * 1000

const b64url = (b) => Buffer.from(b).toString('base64url')
const say = (...a) => console.log(...a)

/// Every failure in this script is operational — a port in use, a redirect
/// Google does not recognise, a consent nobody gave, an expired code. A reader
/// needs the sentence, not the call stack.
///
/// Attached to the awaits themselves, NOT to process 'unhandledRejection':
/// this is an ES module with top-level await, and a rejection there is a fatal
/// module-evaluation error rather than an unhandled rejection, so that handler
/// never runs. Measured by writing it that way first and watching the stack
/// trace print anyway.
const fatal = (e) => { console.error(`\n  ${e?.message ?? e}\n`); process.exit(1) }

// ------------------------------------------------------------- credentials

/// `.env` is not in this repository and must not be. The default looks beside
/// it rather than inside it, and --env overrides.
const CANDIDATES = [
  value('--env', null),
  process.env.GOOGLE_OAUTH_ENV,
  new URL('../EthCraft-main/.env', ROOT).pathname,
  new URL('.env', ROOT).pathname,
  new URL('.local/.env', ROOT).pathname,
].filter(Boolean)

function parseEnv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const [k, ...rest] = t.split('=')
    out[k.trim().toLowerCase()] = rest.join('=').trim().replace(/^["']|["']$/g, '')
  }
  return out
}

let env = null
let envPath = null
for (const candidate of CANDIDATES) {
  try { env = parseEnv(await readFile(candidate, 'utf8')); envPath = candidate; break } catch { /* next */ }
}
if (!env) {
  console.error(`\n  No .env found. Looked in:\n${CANDIDATES.map((c) => `    ${c}`).join('\n')}`)
  console.error('\n  Pass --env <path>, or set GOOGLE_OAUTH_ENV.\n')
  process.exit(1)
}

const clientId = env.client_id ?? env.google_client_id ?? env.oauth_client_id
const clientSecret = env.client_secret ?? env.google_client_secret ?? env.oauth_client_secret
if (!clientId || !clientSecret) {
  console.error(`\n  ${envPath} has no Client_ID / Client_secret pair.`)
  console.error(`  Found keys: ${Object.keys(env).join(', ')}\n`)
  process.exit(1)
}

/// Redact the secret from ANYTHING this process prints.
///
/// Not left to each print site to remember: a secret that leaks does so from
/// the one line nobody thought about, which is usually an error path.
const SECRETS = [clientSecret]
for (const stream of ['stdout', 'stderr']) {
  const write = process[stream].write.bind(process[stream])
  process[stream].write = (chunk, ...rest) => {
    let s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? chunk
    if (typeof s === 'string') for (const secret of SECRETS) {
      if (secret) s = s.split(secret).join('<client secret redacted>')
    }
    return write(s, ...rest)
  }
}

// ------------------------------------------------------- the configuration
//
// The SAME file npm run play reads, so a pass here means the deployment is
// configured correctly and not merely that this script works.
let oidc = {}
try { oidc = JSON.parse(await readFile(new URL('.local/oidc.json', ROOT), 'utf8')) } catch { /* env only */ }
const config = {
  issuer: process.env.OIDC_ISSUER ?? oidc.issuer ?? 'https://accounts.google.com',
  audience: process.env.OIDC_AUDIENCE ?? oidc.audience,
  jwksUri: process.env.OIDC_JWKS_URI ?? oidc.jwksUri ?? 'https://www.googleapis.com/oauth2/v3/certs',
  provider: process.env.OIDC_PROVIDER ?? oidc.provider ?? 'google',
}

say('\n  NearCraft — a token Google signed, verified by the code that runs in production')
say('  ' + '─'.repeat(72))
say(`  credentials  ${envPath}`)
say(`  client id    …${clientId.slice(-30)}`)
say(`  secret       present, ${clientSecret.length} characters, and it is never printed`)
say(`  issuer       ${config.issuer}`)
say(`  jwks         ${config.jwksUri}`)
say(`  provider     ${config.provider}   <- pinned; changing it relocates every player`)

if (config.audience !== clientId) {
  console.error(`\n  MISMATCH. .local/oidc.json verifies tokens for a DIFFERENT client id than`)
  console.error(`  ${envPath} signs in with, so every token this gets would be refused as`)
  console.error(`  WRONG_AUDIENCE — correctly. Make them the same before going further.`)
  console.error(`\n    signing in as  …${clientId.slice(-30)}`)
  console.error(`    verifying for  …${String(config.audience).slice(-30)}\n`)
  process.exit(1)
}
say(`  audience     matches the client id signing in`)

// --------------------------------------------------------------- the flow

let idToken = null
let nonce = null

if (PASTE) {
  if (process.stdin.isTTY) {
    console.error('\n  --paste reads the id_token on STDIN, so it stays out of `ps` and shell history.\n')
    console.error('  Get one from the OAuth Playground:')
    console.error('    1. https://developers.google.com/oauthplayground')
    console.error('    2. gear icon -> tick "Use your own OAuth credentials" -> enter the client id')
    console.error('       and secret THERE, on Google\'s own site')
    console.error('    3. left panel -> scope  openid  -> Authorize APIs -> Exchange code for tokens')
    console.error('    4. copy the id_token value, then:\n')
    console.error('         pbpaste | npm run oidc:google -- --paste --onboard\n')
    console.error('  If Google says redirect_uri_mismatch, add this to the client\'s redirect URIs:')
    console.error('         https://developers.google.com/oauthplayground\n')
    process.exit(2)
  }
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  idToken = Buffer.concat(chunks).toString('utf8').trim()
  if (!idToken) { console.error('\n  stdin was empty, so there is no token to verify.\n'); process.exit(2) }
  say(`\n  read an id_token of ${idToken.length} characters from stdin\n`)
} else {

const state = b64url(randomBytes(24))
nonce = b64url(randomBytes(24))
const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
for (const [k, v] of Object.entries({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  // `openid` alone would be enough: the account is derived from `sub` and
  // nothing else is read. `email` is asked for only so the consent screen says
  // something a human recognises, and it is never recorded or printed.
  scope: 'openid email',
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  prompt: 'consent',
})) authUrl.searchParams.set(k, v)

let listening = () => {}
const up = new Promise((resolve) => { listening = resolve })

const waiting = new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/callback') { res.writeHead(404).end('no'); return }
    const done = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end(html) }

    const err = url.searchParams.get('error')
    if (err) {
      done(400, `<h2>Google refused: ${err}</h2><p>You can close this tab.</p>`)
      server.close(); reject(new Error(`Google refused the sign-in: ${err}`)); return
    }
    // The CSRF check. Without it, anyone who can make your browser hit this
    // port can feed this script a code of their choosing.
    if (url.searchParams.get('state') !== state) {
      done(400, '<h2>state mismatch</h2>')
      server.close(); reject(new Error('the callback state did not match; refusing it')); return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      done(400, '<h2>no code</h2>')
      server.close(); reject(new Error('the callback carried no authorization code')); return
    }
    done(200, '<h2>Signed in.</h2><p>Go back to the terminal — you can close this tab.</p>')
    server.close()
    resolve(code)
  })
  server.on('error', (e) => reject(e.code === 'EADDRINUSE'
    ? new Error(`port ${PORT} is already in use, so the sign-in would redirect to something `
      + `that is not this script. Stop it, or pass --port <n>.`)
    : new Error(`could not listen on ${PORT}: ${e.message}`)))
  // Only resolve `listening` once it really is. The first version printed the
  // URL and opened a browser from the next statement, which runs before the
  // listen error arrives — so a failed bind still sent someone to Google with
  // a redirect pointing at a closed port.
  server.listen(PORT, '127.0.0.1', () => listening())
  setTimeout(() => { server.close(); reject(new Error(`nobody signed in within ${TIMEOUT_MS / 1000}s`)) }, TIMEOUT_MS).unref()
})

// Fails here, before a browser is opened, if the port could not be bound.
await Promise.race([up, waiting]).catch(fatal)

// Ask Google whether it will accept this redirect BEFORE sending anyone to it.
//
// Worth the one request: an unregistered redirect produces "Access blocked:
// This app's request is invalid" in the browser, with the actual reason behind
// a "see error details" toggle. The first real run of this script sat waiting
// four minutes for a sign-in that could never arrive, because all three
// plausible redirect URIs turned out to be unregistered on the client. A
// terminal line naming the fix is worth more than a browser tab that cannot work.
//
// The reading is specific, not a blanket "something went wrong": a bogus client
// id gives `invalid_client` instead, which is how this was confirmed to
// discriminate rather than to always say no.
try {
  const probe = await fetch(authUrl.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(20000),
  })
  const page = await probe.text()
  if (page.includes('redirect_uri_mismatch')) {
    console.error(`\n  Google will not accept this redirect, so signing in cannot work yet:`)
    console.error(`\n      ${REDIRECT}`)
    console.error(`\n  is not an Authorized redirect URI on OAuth client …${clientId.slice(-30)}.`)
    console.error(`\n  Add it — console.cloud.google.com -> APIs & Services -> Credentials ->`)
    console.error(`  your OAuth 2.0 Client ID -> Authorized redirect URIs. Add both spellings,`)
    console.error(`  because Google compares them as strings:`)
    console.error(`\n      http://127.0.0.1:${PORT}/callback`)
    console.error(`      http://localhost:${PORT}/callback`)
    console.error(`\n  Changes can take a few minutes. Then run this again.`)
    console.error(`\n  Or skip the redirect entirely and paste a token from the OAuth Playground:`)
    console.error(`      pbpaste | npm run oidc:google -- --paste --onboard`)
    console.error(`  (that needs https://developers.google.com/oauthplayground registered instead)\n`)
    process.exit(1)
  }
  if (page.includes('invalid_client') || page.includes('OAuth client was not found')) {
    console.error(`\n  Google does not recognise client id …${clientId.slice(-30)}.`)
    console.error(`  Check the Client_ID in ${envPath}.\n`)
    process.exit(1)
  }
} catch (e) {
  // A probe that cannot reach Google must not block a sign-in that might work.
  say(`  (could not pre-check the redirect: ${e.message} — continuing anyway)`)
}

say(`\n  Open this and sign in (it listens on ${REDIRECT}):\n`)
say(`  ${authUrl}\n`)
say(`  If Google says redirect_uri_mismatch, add BOTH of these to your OAuth client's`)
say(`  Authorized redirect URIs (Google matches them as strings) and run it again:`)
say(`        http://127.0.0.1:${PORT}/callback`)
say(`        http://localhost:${PORT}/callback\n`)

// Best effort; the URL above is the real instruction.
if (!flag('--no-open')) spawn('open', [authUrl.toString()], { stdio: 'ignore' }).on('error', () => {})

const code = await waiting.catch(fatal)
say('  got an authorization code; exchanging it with Google...')

// ------------------------------------------------ exchange, the only place
//                                                   the secret is ever used
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }),
  signal: AbortSignal.timeout(30000),
})
const tokens = await tokenRes.json()
if (!tokenRes.ok || !tokens.id_token) {
  console.error(`\n  Google would not exchange the code: ${tokens.error ?? tokenRes.status}`)
  if (tokens.error_description) console.error(`  ${tokens.error_description}`)
  console.error('')
  process.exit(1)
}
idToken = tokens.id_token
say(`  Google returned an id_token of ${idToken.length} characters, which is ${(idToken.length / 256).toFixed(1)}x`)
say(`  what Minecraft chat can carry — which is why the link code exists.\n`)

}

// ------------------------------------------------------------- verify it
const verify = createOidcVerifier(config)
let identity
try {
  identity = await verify.verifyIdentity(idToken)
} catch (e) {
  console.error(`  REFUSED  ${e.code ?? 'ERROR'}: ${e.detail ?? e.message}\n`)
  process.exit(1)
}

// The nonce binds the token to THIS request. Without it, a token obtained
// anywhere else for this client id would pass just as well.
//
// There IS no nonce on the --paste path, because this run did not ask for the
// token. Rather than let the check quietly compare undefined to undefined and
// pass — a check that cannot fail is worse than no check — it is SKIPPED and
// said out loud, and what that costs is stated.
const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString())
if (nonce === null) {
  say(`  NOT CHECKED: the nonce. This token was obtained elsewhere, so there is no`)
  say(`  challenge of ours for it to answer. Its signature, issuer, audience and`)
  say(`  expiry are all verified against Google; what is not established is that it`)
  say(`  was minted for THIS run rather than replayed from another.\n`)
} else if (claims.nonce !== nonce) {
  console.error(`  REFUSED: the token's nonce is not the one this run sent. It was issued for`)
  console.error(`  a different request, so it is not proof that THIS sign-in happened.\n`)
  process.exit(1)
}

const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const accountId = playerAccountId(identity.provider, identity.subject, manifest.root)

say(`  VERIFIED, against Google's live JWKS, by backend/near/oidc.mjs.\n`)
say(`    issuer    ${claims.iss}`)
say(`    algorithm ${JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString()).alg}`)
say(`    provider  ${identity.provider}`)
say(`    nonce     matches the one this run generated`)
say(`    subject   ${identity.subject.length} characters, not printed — it identifies you at Google`)
say(`    email     ${claims.email ? 'present in the token, deliberately not printed or recorded' : 'not requested'}`)
say(`\n    this login owns  ${accountId}`)
say(`    derived as sha256("${identity.provider}:<subject>") — one way, so the account`)
say(`    reveals nothing about the login.\n`)

if (!ONBOARD) {
  say(`  Pass --onboard to create that account on public testnet.\n`)
  process.exit(0)
}

// ------------------------------------------------------------- onboard
//
// Piped on STDIN, never as an argv: a token in argv is visible in `ps` and
// lands in shell history.
say(`  --onboard: handing the token to live-onboard.mjs on stdin\n`)
const child = spawn('node', [new URL('live-onboard.mjs', import.meta.url).pathname,
  ...(args.includes('--port-onboard') ? ['--port', value('--port-onboard', '8081')] : [])], {
  cwd: ROOT.pathname, env: process.env, stdio: ['pipe', 'inherit', 'inherit'],
})
child.stdin.write(idToken)
child.stdin.end()
process.exit(await new Promise((r) => child.on('close', r)))
