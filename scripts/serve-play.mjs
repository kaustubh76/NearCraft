// The playable NearCraft server: the market page plus the API behind it.
//
//   npm run play
//
// `npm run web` serves the same page read-only and needs no credentials, which
// is what a judge can run from a clean clone. This one additionally mounts the
// play API, so it needs `.local/` — the deploying account's keys — and is
// therefore CUSTODIAL: it holds players' scoped signing keys and submits calls
// on their behalf. That is the design the project documents; running it makes
// it real, so the banner below says so out loud every time it starts.
//
// Static files go through `resolveFile` from serve-web.mjs rather than a second
// copy of the logic. That function is the thing that stops `.local/` being
// served — it sits *inside* the served root, so a prefix check would hand a
// judge's private key to anything that can reach this port. One guard, one
// test, two servers.
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { resolveFile, TYPES } from './serve-web.mjs'
import { createPlayService } from '../backend/near/play.mjs'
import { createOnboarding } from '../backend/near/onboarding.mjs'
import { createRelayer } from '../backend/near/relayer.mjs'
import { createMarketReader } from '../backend/near/market.mjs'
import { createOidcVerifier } from '../backend/near/oidc.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 8080)

const manifest = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))

let keys = {}
try {
  keys = JSON.parse(await readFile(new URL('../.local/nearcraft-keys.json', import.meta.url), 'utf8'))
} catch {
  console.error('\n  No .local/nearcraft-keys.json — this server cannot sign for anyone.')
  console.error('  Run `npm run web` for the read-only page, or `npm run deploy` to create a deployment.\n')
  process.exit(1)
}

// ------------------------------------------------------------ the verifier
//
// ONE decision, made here, producing both the verifier onboarding will call and
// the label the API reports. Choosing them in two places is how a service ends
// up announcing "oidc" while a stub runs.
// Two places to configure it, one decision made from them.
//
// Environment variables win. `.local/oidc.json` is the fallback, because that
// is where this project already keeps everything credential-shaped and it is
// gitignored — and because asking an operator to export three variables before
// every run is how a deployment ends up on the seed verifier by accident.
//
// There is no .env support anywhere in this repository and none is being added:
// it has one runtime dependency and keeps it.
let oidcFile = null
try {
  oidcFile = JSON.parse(await readFile(new URL('../.local/oidc.json', import.meta.url), 'utf8'))
} catch { /* absent is the normal case */ }

const oidc = {
  issuer: process.env.OIDC_ISSUER ?? oidcFile?.issuer,
  audience: process.env.OIDC_AUDIENCE ?? oidcFile?.audience,
  jwksUri: process.env.OIDC_JWKS_URI ?? oidcFile?.jwksUri,
  // Optional, and load-bearing: it is half the preimage of every player's
  // account id. Unset, createOidcVerifier labels accounts with the issuer URL
  // instead — so adding this later moves every existing player to an account
  // that does not exist. Pin it once per deployment.
  provider: process.env.OIDC_PROVIDER ?? oidcFile?.provider,
}
const oidcConfigured = Boolean(oidc.issuer && oidc.audience && oidc.jwksUri)

let verifyIdentity
let verifierKind
if (oidcConfigured) {
  const verifier = createOidcVerifier({
    issuer: oidc.issuer,
    audience: oidc.audience,
    jwksUri: oidc.jwksUri,
    provider: oidc.provider,
  })
  verifyIdentity = (token) => verifier.verifyIdentity(token)
  verifierKind = 'oidc'
} else {
  // The seeded demo identity. It is NOT a weaker OIDC — it is no OIDC at all,
  // and it is labelled that way everywhere it surfaces, because a login that
  // accepts any string is the kind of thing a reader must not have to infer.
  verifyIdentity = async (token) => ({ provider: 'seed', subject: String(token) })
  verifierKind = 'seed'
}

const cat = JSON.parse(await readFile(new URL('../config/catalog.json', import.meta.url), 'utf8'))

// The ROOT key, which creates player accounts.
//
// It does NOT live in .local/nearcraft-keys.json — that file holds the
// contracts, the merchants, the agents and the players, and has no entry for
// the root account at all. It lives in .local/nearcraftmc-root.json under
// `private_key`, and this line used to look only in the wrong file.
//
// The consequence was invisible until a real login was tried: signing in as an
// EXISTING player takes an early return and never needs a signer, so every
// test and every demo passed. Creating a new one threw "Please set a signer"
// from deep inside near-api-js, which the service then reported as
// IDENTITY_REJECTED — a chain failure dressed as a rejected token. The live
// deployment's documented limit was "root is underfunded"; it would also have
// failed on this.
let rootKeyFile = null
try {
  rootKeyFile = JSON.parse(await readFile(new URL('../.local/nearcraftmc-root.json', import.meta.url), 'utf8'))
} catch { /* absent on a clone */ }
if (rootKeyFile && rootKeyFile.account_id && rootKeyFile.account_id !== manifest.root) {
  console.error(`\n  .local/nearcraftmc-root.json is for ${rootKeyFile.account_id}, but the`)
  console.error(`  deployment's root is ${manifest.root}. Refusing to sign with the wrong account.\n`)
  process.exit(1)
}
const rootKey = process.env.NEAR_ROOT_KEY ?? keys[manifest.root] ?? rootKeyFile?.private_key ?? null

const onboarding = createOnboarding({
  rootAccountId: manifest.root,
  rootKey,
  marketContract: manifest.contracts.market,
  itemsContract: manifest.contracts.items,
  sellableItems: cat.players?.sellable_items ?? [],
  playerMethods: cat.players?.methods ?? ['buy_with_credit', 'sell'],
  verifyIdentity,
  rpcUrl: manifest.rpc,
})

const relayer = createRelayer({
  relayerAccountId: manifest.relayer.account_id,
  relayerKey: keys[manifest.relayer.account_id],
  marketContract: manifest.contracts.market,
  permittedMethods: manifest.relayer.relays ?? ['buy_with_credit', 'sell'],
  rpcUrl: manifest.rpc,
})

const reader = createMarketReader({
  marketContract: manifest.contracts.market,
  itemsContract: manifest.contracts.items,
  rpcUrl: manifest.rpc,
})

/// Persist a newly onboarded player's one-time scoped key.
///
/// Onboarding hands this key back exactly once, on the run that creates the
/// account, and deletes that account's full-access key in the same
/// transaction. If it is not written down here, the next restart strands the
/// account permanently: nothing exists that could add another key to it.
///
/// Written with mode 0600 into .local/, which is gitignored and which the
/// static server refuses to serve.
const KEYS_FILE = new URL('../.local/nearcraft-keys.json', import.meta.url)
async function saveKey(accountId, secret) {
  keys[`${accountId}#scoped`] = secret
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  console.log(`  saved key for ${accountId} -> .local/nearcraft-keys.json`)
}

const play = createPlayService({
  deployment: manifest, keys, verifierKind, onboarding, relayer, reader, saveKey,
  canOnboard: Boolean(rootKey),
  log: (e) => console.log(`  ${e.event.padEnd(10)} ${JSON.stringify({ ...e, event: undefined })}`),
})

// ------------------------------------------------------------------- server

const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c; if (raw.length > 64_000) req.destroy() })
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) } })
  req.on('error', () => resolve({}))
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname.startsWith('/api/')) {
    // Query parameters for reads, a JSON body for writes, merged into one plain
    // object so the service never has to know it is behind HTTP.
    const body = { ...Object.fromEntries(url.searchParams), ...(req.method === 'POST' ? await readBody(req) : {}) }
    const out = await play.handle(req.method, url.pathname, body)
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(out.body))
    return
  }

  const file = resolveFile(ROOT, req.url)
  if (file === null) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
    return
  }
  try {
    const content = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${req.url}`)
  }
})

server.listen(PORT, () => {
  const player = manifest.players?.[0]?.account_id
  if (!rootKey) {
    console.log('  NOTE      this server cannot create NEW players: no key for the root')
    console.log('            account in .local/. Existing players sign in normally, and')
    console.log('            /api/health reports canOnboard: false.')
  }
  console.log(`\n  NearCraft — playable: http://localhost:${PORT}/\n`)
  console.log(`  network   ${manifest.network ?? 'testnet'}  via ${manifest.rpc}`)
  console.log(`  login     ${verifierKind === 'oidc'
    ? `real OIDC against ${oidc.issuer} (audience ...${String(oidc.audience).slice(-24)})`
    : 'SEEDED demo identity — any string is accepted. No OIDC provider is configured.'}`)
  console.log(`  relayer   ${manifest.relayer.account_id} pays the gas; players pay nothing`)
  if (player) console.log(`  try       sign in as "player-1" -> ${player}`)
  console.log('\n  This server is CUSTODIAL: it holds players\' scoped signing keys from')
  console.log('  .local/ and submits calls for them. Those keys cannot transfer NEAR,')
  console.log('  cannot add keys, and can call only their named methods on one')
  console.log('  contract — the runtime enforces that, not this process.')
  console.log('  Onboarding a NEW player needs root balance; signing in as an existing')
  console.log('  one does not.\n')
})
