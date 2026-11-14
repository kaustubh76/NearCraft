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
import { declaredAgents, signableAccounts, signInHint } from '../backend/near/deployment.mjs'
import { agentPolicy } from '../backend/near/policy.mjs'
import { createAgentSigner, transactionHash } from '../backend/near/signer.mjs'
import { buyWithCreditRequest } from '../backend/near/market.mjs'
import { createRelayer } from '../backend/near/relayer.mjs'
import { createMarketReader } from '../backend/near/market.mjs'
import { createOidcVerifier } from '../backend/near/oidc.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 8080)

/// LOOPBACK BY DEFAULT, and explicitly.
///
/// This was `server.listen(PORT)` with no host, which binds the IPv6 wildcard
/// `::`. That is two bugs at once.
///
/// The security one: this service is custodial — it holds players' scoped
/// signing keys and submits calls for them — and docs/MINECRAFT.md says it is
/// "meant to sit on loopback beside the game server". It was in fact listening
/// on every interface, while the banner printed `localhost` and understated it.
///
/// The one that stopped the game working: a wildcard bind SILENTLY LOSES a
/// race. If anything already holds IPv4 `*:8080` — a Docker published port, say
/// — Node still binds `::` successfully, reports itself up, and is unreachable
/// at `127.0.0.1:8080`, which is the literal address mc-up.mjs, mc-server.mjs,
/// mc-bot.mjs and the plugin's own config.yml all dial. The result was
/// `the play service never came up` after a 30-second timeout, from a service
/// that had started perfectly.
///
/// Naming the address makes that collision an immediate EADDRINUSE instead.
/// A host that needs every interface asks for it: Render sets
/// NEARCRAFT_BIND=0.0.0.0, because a PaaS routes to the container's public
/// interface and loopback would be unreachable there — render.yaml declares it.
///
/// `||`, NOT `??`. A declared-but-empty variable is an ordinary PaaS state, and
/// `??` only falls back on null and undefined: NEARCRAFT_BIND="" gave HOST="",
/// which Node treats as falsy and routes to the host-less path. Measured:
/// {"address":"::","family":"IPv6"} — the exact wildcard this whole comment
/// exists to prevent, restored by an empty string.
const HOST = process.env.NEARCRAFT_BIND || '127.0.0.1'

/// The same two overrides scripts/deploy.mjs reads, so a sandbox deployment can
/// be served without the committed testnet manifest being involved at all.
const MANIFEST_PATH = process.env.NEARCRAFT_MANIFEST
  ? new URL(`file://${process.env.NEARCRAFT_MANIFEST}`)
  : new URL('../deployment.json', import.meta.url)
const KEYS_PATH = process.env.NEARCRAFT_KEYS
  ? new URL(`file://${process.env.NEARCRAFT_KEYS}`)
  : new URL('../.local/nearcraft-keys.json', import.meta.url)

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))

let keys = {}
try {
  keys = JSON.parse(await readFile(KEYS_PATH, 'utf8'))
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
/// Force the login mode, for callers that must not inherit a config file.
///
/// Adding the `.local/oidc.json` fallback had a consequence I did not see: a
/// run that expected the seeded login silently got real OIDC instead, because
/// the file was there. `npm run mc:up --sandbox` failed exactly that way — a
/// seeded subject refused as a malformed token against a Google issuer. An
/// orchestrator has to be able to say which mode it means.
///
///   NEARCRAFT_LOGIN=seed   never use OIDC, whatever is configured
///   NEARCRAFT_LOGIN=oidc   require OIDC, and refuse to start without it
///   unset                  env vars, then the file, else seeded
const forced = process.env.NEARCRAFT_LOGIN ?? null
if (forced && forced !== 'seed' && forced !== 'oidc') {
  console.error(`\n  NEARCRAFT_LOGIN must be "seed" or "oidc", not "${forced}".\n`)
  process.exit(1)
}
const haveOidc = Boolean(oidc.issuer && oidc.audience && oidc.jwksUri)
if (forced === 'oidc' && !haveOidc) {
  console.error('\n  NEARCRAFT_LOGIN=oidc was asked for, but no issuer, audience and JWKS are')
  console.error('  configured. Set OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URI, or put them')
  console.error('  in .local/oidc.json.\n')
  process.exit(1)
}
const oidcConfigured = forced === 'seed' ? false : haveOidc

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
// Resolve first, then complain only about the source we would actually use.
//
// The earlier version refused outright whenever the root-key FILE disagreed
// with the manifest, which is correct for a testnet deployment and fatal for a
// sandbox one: the file is pinned to nearcraftmc.testnet and a sandbox root is
// `sandbox`, so the whole local mode exited here. A mismatched file only
// matters when nothing better was supplied.
const rootKeyFromFile = rootKeyFile?.account_id === manifest.root ? rootKeyFile?.private_key : null
const rootKey = process.env.NEAR_ROOT_KEY ?? keys[manifest.root] ?? rootKeyFromFile ?? null
if (!rootKey && rootKeyFile?.account_id && rootKeyFile.account_id !== manifest.root) {
  console.error(`\n  The only root key available is for ${rootKeyFile.account_id}, but this`)
  console.error(`  deployment's root is ${manifest.root}. Refusing to sign with the wrong account;`)
  console.error(`  new players cannot be created until a key for ${manifest.root} is available.\n`)
}

// -------------------------------------------------- half-finished sign-ins
//
// `signIn` is three transactions, and the bootstrap full-access key that signs
// steps 2 and 3 used to live only in a local variable. A failure in between —
// `mt_approve` panicking on a mis-listed material is enough — lost that key
// while it was still installed on the account, and because `signIn` only tests
// whether the account EXISTS, every later login for that identity returned
// `created: false` with no key. A permanent 503 for one player, and an account
// left holding a live full-access key nobody holds.
//
// Parking the key makes that recoverable: the next sign-in finishes the job.
//
// A SEPARATE FILE from nearcraft-keys.json on purpose. These are FULL-ACCESS
// keys and that file holds scoped ones; the play service reads that map to
// decide what to sign with, and a full-access key sitting in it under a
// slightly different suffix is one typo away from being used as a player's
// key. Different risk, different file. Both are 0600 inside gitignored
// .local/, and an entry is deleted the moment the key is destroyed on chain —
// so in steady state this file is empty.
const BOOTSTRAP_PATH = process.env.NEARCRAFT_BOOTSTRAP
  ? new URL(`file://${process.env.NEARCRAFT_BOOTSTRAP}`)
  : new URL('../.local/nearcraft-bootstrap.json', import.meta.url)

let parkedKeys = {}
try {
  parkedKeys = JSON.parse(await readFile(BOOTSTRAP_PATH, 'utf8'))
} catch { /* nothing parked is the normal state */ }

if (Object.keys(parkedKeys).length > 0) {
  console.log(`\n  ${Object.keys(parkedKeys).length} half-finished sign-in(s) parked; they will be`)
  console.log('  completed when those players next sign in.\n')
}

async function writeParked() {
  await writeFile(BOOTSTRAP_PATH, JSON.stringify(parkedKeys, null, 2) + '\n', { mode: 0o600 })
}

const bootstrapStore = {
  async get(accountId) { return parkedKeys[accountId] ?? null },
  async set(accountId, secret) {
    parkedKeys[accountId] = secret
    await writeParked()
  },
  async delete(accountId) {
    if (!(accountId in parkedKeys)) return
    delete parkedKeys[accountId]
    await writeParked()
  },
}

const onboarding = createOnboarding({
  rootAccountId: manifest.root,
  rootKey,
  marketContract: manifest.contracts.market,
  itemsContract: manifest.contracts.items,
  sellableItems: cat.players?.sellable_items ?? [],
  playerMethods: cat.players?.methods ?? ['buy_with_credit', 'sell'],
  verifyIdentity,
  rpcUrl: manifest.rpc,
  bootstrapStore,
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
const KEYS_FILE = KEYS_PATH
async function saveKey(accountId, secret) {
  keys[`${accountId}#scoped`] = secret
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  console.log(`  saved key for ${accountId} -> .local/nearcraft-keys.json`)
}


// --------------------------------------------------------- the visitor pool
//
// NEARCRAFT_POOL turns this instance into one that hands out a pre-funded
// account per visitor instead of deriving one from their login and creating it.
//
// OPT-IN, and deliberately not inferred from the keys present. A local run
// holds several players' scoped keys and must go on behaving as it always has —
// derive the account from the identity, create it if the root key is here. An
// instance that silently became a pool because of which keys it happened to
// hold would be a surprise in the one direction that matters: two people
// sharing an account.
//
// The hosted instance sets it because it cannot create accounts at all. That is
// not a limitation to work around; it is the control. The seeded verifier
// accepts ANY string, so a public endpoint that could onboard would cost the
// root account 0.11 NEAR per distinct string with nothing to stop a loop. A
// finite set of accounts funded in advance cannot be drained past its own size,
// needs no `x-forwarded-for` to be trustworthy — the caller sets that header's
// leftmost entry — and needs no counter that would reset every time a free
// instance woke from its fifteen-minute sleep.
const pool = (() => {
  const asked = (process.env.NEARCRAFT_POOL ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  if (asked.length === 0) return null
  const signable = signableAccounts({ manifest, keys })
  const usable = asked.filter((id) => signable.includes(id))
  const missing = asked.filter((id) => !signable.includes(id))
  if (missing.length > 0) {
    console.error(`\n  NEARCRAFT_POOL names ${missing.length} account(s) this server cannot sign for:`)
    for (const id of missing) console.error(`    ${id}`)
    console.error('  Either the manifest does not list them or their #scoped key is not in the key file.')
    console.error('  Refusing to start: a pool with a hole in it hands somebody a session that cannot act.\n')
    process.exit(1)
  }
  return usable
})()

if (pool) {
  console.log(`\n  ${pool.length} pre-funded player(s) to hand out, one per visitor:`)
  for (const id of pool) console.log(`    ${id}`)
  console.log('  This server does NOT create accounts; it lends these. /api/health says how many are left.\n')
}

// ------------------------------------------------------------- agent dispatch
//
// GAME_LOOP.md has always described sending an agent shopping from inside the
// game. Nothing implemented it: there was no `agent` command in plugin.yml and
// no handler, so the documented mechanic was reachable only by running
// `npm run agent` against a sandbox.
//
// This dispatches a DECLARED agent, with its own scoped key, through the SAME
// path scripts/agent-run.mjs uses — agentPolicy + createAgentSigner — rather
// than opening a second way to sign. That matters: the signer verifies the
// key's scope against the chain before it spends anything, refuses a deposit a
// function-call key could not attach anyway, and bounds the order. None of that
// would come for free in a hand-rolled route.
//
// The agent pays its own gas here. It is not a player; it has a budget and a
// key of its own, and the relayer exists so that PLAYERS never see a gas
// prompt.
const MAX_AGENT_UNITS = 16

/// Only accounts this deployment declares, and only the methods it declares for
/// them. An agent id that came off the wire is never trusted as an account.
const workers = declaredAgents({ manifest, keys })

const agents = workers.length === 0 ? null : {
  /// What a caller may ask for, so a client does not have to guess.
  list: () => workers.map((a) => ({
    accountId: a.account_id,
    // The short name the game uses: `worker-1`, not the whole account id.
    name: a.account_id.split('.')[0],
    methods: [...(a.permitted_methods ?? [])],
    maxUnitsPerOrder: MAX_AGENT_UNITS,
  })),

  async dispatch({ name, merchantId, item, count }) {
    const agent = workers.find((a) => a.account_id.split('.')[0] === name || a.account_id === name)
    if (!agent) {
      const known = workers.map((a) => a.account_id.split('.')[0]).join(', ')
      throw Object.assign(new Error(`no agent named "${name}" — this deployment has ${known}`),
        { code: 'UNKNOWN_AGENT' })
    }

    const policy = agentPolicy({
      agentId: agent.account_id,
      marketContract: manifest.contracts.market,
      // From the manifest, not from this file: the key on chain is scoped to
      // these and a wider list here would only produce a refusal later.
      methods: [...(agent.permitted_methods ?? [])],
      maxUnitsPerOrder: MAX_AGENT_UNITS,
    })

    const signer = createAgentSigner({
      policy,
      secretKey: keys[`${agent.account_id}#function-call`],
      rpcUrl: manifest.rpc,
      log: (e) => console.log(`  agent      ${JSON.stringify(e)}`),
    })

    const outcome = await signer.call({
      contractId: manifest.contracts.market,
      ...buyWithCreditRequest({ merchantId, item, count }),
    })
    // The hash comes out of the outcome through the shared helper, not by
    // reaching into a field name. The first version of this route read
    // `outcome.hash`, which does not exist on a raw nearcore outcome, so it
    // answered HTTP 200 with `"hash": null` — a settled transaction reported as
    // if nothing had happened. A dispatch with no hash is not provable, and
    // this route exists to be provable.
    const hash = transactionHash(outcome)
    if (!hash) {
      throw Object.assign(new Error('the call settled but no transaction hash could be read from it'),
        { code: 'AGENT_HASH_UNREADABLE' })
    }
    return { agentId: agent.account_id, hash }
  },
}

if (agents) {
  console.log(`\n  ${agents.list().length} agent(s) can be dispatched from in game: `
    + agents.list().map((a) => a.name).join(', '))
} else {
  console.log('\n  no agent keys in this key file, so /api/agent will refuse. Players are unaffected.')
}

const play = createPlayService({
  deployment: manifest, keys, verifierKind, onboarding, relayer, reader, saveKey, agents, pool,
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
    const query = Object.fromEntries(url.searchParams)

    // The session id is a bearer credential, so it travels in a header and not
    // in the URL. A query string is written to the access log of every proxy
    // and server it passes, and it lands in browser history and in a Referer —
    // so a read-only GET was quietly leaving a token that can buy, sell and
    // invest on behalf of a player in half a dozen logs.
    //
    // DELETED from the query, not merely also accepted from the header. Leaving
    // the old path working would make this change cosmetic: the browser and the
    // plugin would keep sending it in the URL and nothing would say so. If a
    // caller still puts it there it is dropped on the floor and the request is
    // refused as unauthenticated, which is a loud failure rather than a silent
    // one.
    delete query.sessionId
    const auth = req.headers.authorization ?? ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null

    const body = {
      ...query,
      ...(req.method === 'POST' ? await readBody(req) : {}),
      ...(bearer ? { sessionId: bearer } : {}),
    }
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

server.on('error', (e) => {
  // Say which address, and say what to do. EADDRINUSE on a bare port number is
  // how half an hour goes into discovering that another project's container
  // publishes 8080.
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n  ${HOST}:${PORT} is already taken by another process.`)
    console.error('  Free it, or choose another port:  PORT=8099 npm run play')
    console.error('  npm run mc:up takes --port <n> and tells the plugin and the bot about it.\n')
    process.exit(1)
  }
  throw e
})

server.listen(PORT, HOST, () => {
  const hint = signInHint({ manifest, keys, verifierKind })
  if (!rootKey) {
    console.log('  NOTE      this server cannot create NEW players: no key for the root')
    console.log('            account in .local/. Existing players sign in normally, and')
    console.log('            /api/health reports canOnboard: false.')
  }
  // The address actually bound, not a friendly fiction. The old line said
  // `localhost` while listening on every interface.
  const shown = HOST === '0.0.0.0' || HOST === '::' ? `all interfaces, port ${PORT}` : `http://${HOST}:${PORT}/`
  console.log(`\n  NearCraft — playable: ${shown}\n`)
  console.log(`  network   ${manifest.network ?? 'testnet'}  via ${manifest.rpc}`)
  console.log(`  login     ${verifierKind === 'oidc'
    ? `real OIDC against ${oidc.issuer} (audience ...${String(oidc.audience).slice(-24)})`
    : 'SEEDED demo identity — any string is accepted. No OIDC provider is configured.'}`)
  console.log(`  relayer   ${manifest.relayer.account_id} pays the gas; players pay nothing`)
  if (hint?.token) console.log(`  try       sign in as "${hint.token}" -> ${hint.id}`)
  else if (hint) console.log(`  signs for ${hint.id} — the login that derives them is not guessable from here`)
  console.log('\n  This server is CUSTODIAL: it holds players\' scoped signing keys from')
  console.log('  .local/ and submits calls for them. Those keys cannot transfer NEAR,')
  console.log('  cannot add keys, and can call only their named methods on one')
  console.log('  contract — the runtime enforces that, not this process.')
  console.log('  Onboarding a NEW player needs root balance; signing in as an existing')
  console.log('  one does not.\n')
})
