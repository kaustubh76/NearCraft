// A login becomes a brand-new NEAR account on a public chain, with no seed
// phrase and no gas prompt.
//
//   npm run live:onboard -- --seed <subject>   a fresh seeded identity
//   npm run live:onboard                       reads an id token on STDIN
//   npm run live:onboard -- --dry              check everything, create nothing
//   npm run live:onboard -- --promote          make it players[0] in the manifest
//
// WHY THIS EXISTS. `tests/near/gasless.mjs` has run the three-transaction
// onboarding bootstrap against a local node for weeks, but on live testnet it
// had never run at all: the root account held 0.091081 NEAR and creating an
// account costs 0.107607, so sign-in answered ROOT_UNDERFUNDED and the headline
// sentence of the games track — a login becomes a playable account — had no
// public footprint. Root is now funded, so this closes that.
//
// SPENDS REAL TESTNET BALANCE: about 0.1076 NEAR of root's, plus whatever
// credit the new player is funded with. That is why it is not part of
// `npm run evidence`.
//
// It drives the REAL runtime path — it spawns scripts/serve-play.mjs and posts
// to /api/session, exactly as a browser would. It does not import onboarding
// and call it directly, because then it would be proving its own copy of the
// flow rather than the one the product runs.
//
// What it asserts, and all of it read back FROM THE CHAIN rather than from the
// reply the service gave:
//   * the account did not exist before and does after
//   * it holds ZERO full-access keys        — so there is no seed phrase
//   * it holds exactly one function-call key, bound to the market
//   * that key grants exactly the methods config/catalog.json lists
//   * the market holds an NEP-245 approval over every sellable material
//   * root's balance actually fell          — somebody paid, and it was root

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { playerAccountId } from '../backend/near/onboarding.mjs'

const ROOT = new URL('..', import.meta.url)
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const SEED = value('--seed', null)
const DRY = flag('--dry')
const PROMOTE = flag('--promote')
const CREDIT = value('--credit', '0.05')
const FUNDER = value('--from', 'worker-1')
const PORT = Number(value('--port', '8081'))
const SERVICE = `http://127.0.0.1:${PORT}`

const say = (...a) => console.log(...a)
const explorerTx = (h) => `https://testnet.nearblocks.io/txns/${h}`
const explorerAcct = (a) => `https://testnet.nearblocks.io/address/${a}`
const show = (y) => (Number(BigInt(y)) / 1e24).toFixed(7)

const findings = []
const check = (what, ok, detail = '') => {
  findings.push({ what, ok, detail })
  say(`  ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(52)} ${detail}`)
  return ok
}

// ------------------------------------------------------------------- inputs

const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const catalog = JSON.parse(await readFile(new URL('config/catalog.json', ROOT), 'utf8'))
const rootId = manifest.root
const rpc = manifest.rpc

/// A public chain, or this is not evidence of anything.
///
/// Derived from the manifest the service will actually read, never asserted —
/// a sandbox run once wrote a local hash into evidence/live/ labelled testnet,
/// because the code that wrote it had been told what network it was on instead
/// of working it out.
const PUBLIC_CHAINS = new Set(['testnet', 'mainnet'])
if (!PUBLIC_CHAINS.has(manifest.network)) {
  console.error(`\n  the manifest says network "${manifest.network}", which is not a public chain.`)
  console.error('  This command creates an account that an explorer must be able to confirm.\n')
  process.exit(1)
}

// The token. Read from STDIN, never from argv: an id token is a bearer
// credential and argv is visible in `ps` and lands in shell history.
let token = SEED
if (!SEED) {
  if (process.stdin.isTTY) {
    console.error('\n  No identity given.\n')
    console.error('  For a seeded one:   npm run live:onboard -- --seed <subject>')
    console.error('  For a real one:     pbpaste | npm run live:onboard')
    console.error('                      (the token goes on stdin, so it stays out of `ps` and history)\n')
    process.exit(2)
  }
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  token = Buffer.concat(chunks).toString('utf8').trim()
  if (!token) { console.error('\n  stdin was empty, so there is no token to verify.\n'); process.exit(2) }
}

const MODE = SEED ? 'seed' : 'oidc'
const methodsExpected = [...(catalog.players?.methods ?? [])].sort()
const sellable = catalog.players?.sellable_items ?? []

say('\n  NearCraft — a login becomes a brand-new account on NEAR testnet')
say('  ' + '─'.repeat(70))
say(`  network   ${manifest.network} via ${rpc}`)
say(`  root      ${rootId}`)
say(`  login     ${MODE === 'seed' ? `seeded subject "${SEED}"` : `an id token, ${token.length} characters`}`)
if (MODE === 'oidc') {
  // Not one character of the token is printed, here or anywhere.
  say(`            nothing of the token is logged; only the account it derives`)
}

// ------------------------------------------------------------ chain helpers

const rpcCall = async (params) => {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? 'rpc error')
  if (body.result?.error) throw new Error(body.result.error)
  return body.result
}
/// `optimistic`, not `final`, and the difference is not cosmetic: `final` lags
/// by a block or two, so reading it immediately after a write shows the state
/// BEFORE that write. This script got exactly that wrong on its first live run
/// — see `settle` below.
const viewAccount = (id) => rpcCall({ request_type: 'view_account', finality: 'optimistic', account_id: id })
const accessKeys = (id) => rpcCall({ request_type: 'view_access_key_list', finality: 'optimistic', account_id: id })
const viewFn = async (contractId, method_name, params) => {
  const r = await rpcCall({
    request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name,
    args_base64: Buffer.from(JSON.stringify(params)).toString('base64'),
  })
  return JSON.parse(Buffer.from(r.result).toString())
}
const exists = async (id) => { try { await viewAccount(id); return true } catch { return false } }

/// Read back until the chain agrees, or until a deadline.
///
/// MEASURED, not theorised. The first live run of this script read the new
/// account once, with `finality: 'final'`, immediately after the third
/// transaction — and reported one full-access key and no scoped key. The
/// account on chain had exactly the opposite a few seconds later: zero
/// full-access keys and one function-call key granting all three methods. The
/// onboarding was correct; the observation was a block too early, and it would
/// have been reported as a catastrophic failure of the thing that worked.
///
/// Polling rather than sleeping, because a fixed sleep is a guess that is wrong
/// on a slow day. On timeout it RETURNS the last reading instead of throwing,
/// so the assertions still run against it and a genuinely broken onboarding
/// still fails. A wait that cannot report a failure is worse than no wait.
async function settle(read, done, what, ms = 90000) {
  const at = Date.now()
  let last = await read()
  while (!done(last)) {
    if (Date.now() - at > ms) {
      say(`  (waited ${((Date.now() - at) / 1000).toFixed(0)}s for ${what} and it never settled — asserting on what is there)`)
      return last
    }
    await new Promise((r) => setTimeout(r, 1000))
    last = await read()
  }
  const took = Date.now() - at
  if (took > 1200) say(`  settled   ${what} after ${(took / 1000).toFixed(1)}s`)
  return last
}

// ------------------------------------------------------------- what we know
//
// For a seeded subject the account id is a pure function of the identity, so it
// can be predicted and refused before anything is spent. For a real token the
// subject is inside the token, and working it out here would mean parsing a
// credential this script has deliberately not verified — the service does that,
// and reports `created`, which is the check that matters either way.

let predicted = null
if (MODE === 'seed') {
  predicted = playerAccountId('seed', SEED, rootId)
  say(`  derives   ${predicted}`)
  if (await exists(predicted)) {
    console.error(`\n  ${predicted} already exists.`)
    console.error('  This command creates NEW players. Pick a subject that has never been used,')
    console.error('  or sign in with npm run play if you just want a session.\n')
    process.exit(1)
  }
  check('the account does not exist yet', true, predicted)
}

const rootBefore = BigInt((await viewAccount(rootId)).amount)
/// What nearcore charges for the whole bootstrap: 0.1 transferred plus the gas
/// headroom it reserves against a pessimistically inflated price. Taken from
/// the real refusal, which is pinned as a fixture in tests/near/play.mjs.
const COST = 107607442456250000000000n
say(`  root      ${show(rootBefore)} NEAR — enough for ${rootBefore / COST} more player(s)`)
if (rootBefore < COST) {
  console.error(`\n  root cannot afford one account (needs ${show(COST)}). Top it up at https://near-faucet.io.\n`)
  process.exit(1)
}

if (DRY) {
  say(`\n  --dry: everything needed is in place. Nothing was created.\n`)
  process.exit(0)
}

// ----------------------------------------------------------- the service
//
// Spawned here rather than required to be running, because every failure this
// demo had after the code was correct was orchestration. Only ever torn down
// if this script started it.

const started = []
const teardown = async () => {
  for (const c of started.reverse()) if (c.exitCode === null) c.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  for (const c of started) if (c.exitCode === null) c.kill('SIGKILL')
}
process.on('SIGINT', async () => { await teardown(); process.exit(130) })

const health = async () => {
  try {
    const r = await fetch(`${SERVICE}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

let record = null
let stopped = false
try {
  if (await health()) {
    console.error(`\n  something is already answering on ${SERVICE}. This script starts its own`)
    console.error(`  service so it can be sure which verifier is live. Stop it, or pass --port <n>.\n`)
    process.exit(1)
  }
  const free = await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(PORT, '127.0.0.1')
  })
  if (!free) { console.error(`\n  port ${PORT} is taken. Pass --port <n>.\n`); process.exit(1) }

  const lines = []
  const child = spawn('node', [new URL('serve-play.mjs', import.meta.url).pathname], {
    cwd: ROOT.pathname,
    // ALWAYS explicit. A service that inherits its login mode from whatever
    // config file happens to be on disk is how --sandbox once got a Google
    // issuer and refused its own seeded player.
    env: { ...process.env, PORT: String(PORT), NEARCRAFT_LOGIN: MODE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(child)
  for (const s of [child.stdout, child.stderr]) {
    s.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines.push(l) })
  }

  const at = Date.now()
  let h = null
  while (!(h = await health())) {
    if (child.exitCode !== null) throw new Error(`the service exited:\n${lines.slice(-10).join('\n')}`)
    if (Date.now() - at > 30000) throw new Error(`the service never came up:\n${lines.slice(-10).join('\n')}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  say(`\n  service   :${PORT}  verifier ${h.verifier}  canOnboard ${h.canOnboard}`)

  if (h.verifier !== MODE) {
    throw new Error(`asked for a "${MODE}" verifier and the service reports "${h.verifier}"`)
  }
  if (h.canOnboard !== true) {
    throw new Error('this service cannot create accounts: it holds no key for the root account.\n'
      + `  Put it in .local/nearcraftmc-root.json, or set NEAR_ROOT_KEY.`)
  }

  // ------------------------------------------------------------- sign in
  say(`\n  signing in — this is three transactions, and the third deletes a key\n`)
  const res = await fetch(`${SERVICE}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }), signal: AbortSignal.timeout(120000),
  })
  const body = await res.json()
  if (!res.ok) {
    console.error(`\n  REFUSED  ${body.error}: ${body.detail ?? ''}\n`)
    if (body.error === 'WRONG_AUDIENCE') {
      console.error('  That token was issued for a different client id than .local/oidc.json names.\n')
    }
    if (body.error === 'TOKEN_EXPIRED') {
      console.error('  id tokens last about an hour. Get a fresh one and run this again.\n')
    }
    throw new Error(body.error)
  }

  const accountId = body.accountId
  say(`  account   ${accountId}`)
  say(`            ${explorerAcct(accountId)}\n`)

  // The one assertion that cannot be satisfied by an account that already
  // existed. Without it this whole script could "pass" having created nothing.
  if (!check('the account was CREATED by this run, not reused', body.created === true,
    `created=${body.created}`)) {
    throw new Error('no account was created')
  }
  if (predicted) {
    check('it landed where the derivation said it would', accountId === predicted, predicted)
  }

  // ------------------------------------------------- read it back from chain
  // The shape onboarding promises: the bootstrap key gone, the scoped one in.
  // Anything else and this waits, then asserts on what it found.
  const keyList = await settle(
    async () => (await accessKeys(accountId)).keys,
    (ks) => ks.length === 1 && Boolean(ks[0]?.access_key?.permission?.FunctionCall),
    'the scoped key to replace the bootstrap one',
  )
  const full = keyList.filter((k) => k.access_key.permission === 'FullAccess'
    || k.access_key.permission?.FullAccess !== undefined)
  const scoped = keyList.filter((k) => k.access_key.permission?.FunctionCall)

  check('it holds ZERO full-access keys — no seed phrase exists', full.length === 0,
    `${full.length} full-access`)
  check('it holds exactly one function-call key', scoped.length === 1, `${scoped.length} scoped`)

  const fc = scoped[0]?.access_key?.permission?.FunctionCall
  check('that key can only reach the market', fc?.receiver_id === manifest.contracts.market,
    fc?.receiver_id ?? 'none')

  const granted = [...(fc?.method_names ?? [])].sort()
  // Not "at least these". A function-call key with an EMPTY method list is read
  // by the protocol as "every method on that contract", so a subset check here
  // would pass for the most permissive key it is possible to issue.
  check('it grants exactly the methods the catalog lists', granted.length > 0
    && granted.length === methodsExpected.length
    && granted.every((m, i) => m === methodsExpected[i]),
    `[${granted}] vs catalog [${methodsExpected}]`)

  const approvals = []
  for (const item of sellable) {
    let ok = false
    try {
      const a = await viewFn(manifest.contracts.items, 'mt_token_approval',
        { token_id: item, account_id: accountId })
      ok = Boolean(a?.approved_account_ids?.[manifest.contracts.market])
    } catch { /* absent */ }
    approvals.push([item, ok])
  }
  check('the market may pull every sellable material', approvals.every(([, ok]) => ok),
    `${approvals.filter(([, ok]) => ok).length}/${approvals.length} approved`)

  const rootAfter = BigInt((await viewAccount(rootId)).amount)
  const spent = rootBefore - rootAfter
  check('root actually paid for it', spent > 0n, `${show(spent)} NEAR`)
  say(`            root ${show(rootBefore)} -> ${show(rootAfter)} NEAR`)

  const txs = body.transactions ?? {}
  for (const [what, hash] of Object.entries(txs)) {
    if (hash) { say(`\n  ${what.padEnd(10)} ${hash}`); say(`             ${explorerTx(hash)}`) }
  }

  // ------------------------------------------------------------ credit
  //
  // A new player has no spend budget, and `market.fund_credit` is
  // permissionless — it has no assert_owner() while register_merchant right
  // above it does — so any funded account can grant one. Reusing topup.mjs
  // rather than repeating its gas-headroom arithmetic.
  say(`\n  funding the new player's spend budget...\n`)
  const topup = spawn('node', [new URL('topup.mjs', import.meta.url).pathname,
    '--account', accountId, '--from', FUNDER, '--to', CREDIT], {
    cwd: ROOT.pathname, env: process.env, stdio: 'inherit',
  })
  const topupCode = await new Promise((r) => topup.on('close', r))
  const credit = await settle(
    async () => BigInt(await viewFn(manifest.contracts.market, 'credit_of', { account_id: accountId })),
    (c) => c > 0n,
    "the new player's credit",
    30000,
  )
  check('the new player can afford to trade', credit > 0n,
    `${show(credit)} NEAR${topupCode !== 0 ? ' (topup exited non-zero)' : ''}`)

  // ------------------------------------------------------------- manifest
  //
  // NOT cosmetic. scripts/keys.mjs audits the manifest against the chain in
  // BOTH directions, so a player on chain that the manifest does not know about
  // makes `npm run keys` fail — which is exactly what it is for.
  const entry = {
    account_id: accountId,
    // The chain's own order, not the sorted copy the comparison above used. A
    // manifest is a record of what is there; sorting it would be editorialising
    // a field another script reads back and compares.
    permitted_methods: [...(fc?.method_names ?? [])],
    function_call_public_key: scoped[0]?.public_key ?? null,
  }
  manifest.players = (manifest.players ?? []).filter((p) => p.account_id !== accountId)
  if (PROMOTE) manifest.players.unshift(entry); else manifest.players.push(entry)
  await writeFile(new URL('deployment.json', ROOT), JSON.stringify(manifest, null, 2) + '\n')
  say(`\n  manifest  recorded as players[${PROMOTE ? 0 : manifest.players.length - 1}]`
    + `${PROMOTE ? ' — this is now the player the demo runs as' : ''}`)

  // -------------------------------------------------------------- evidence
  record = {
    note: 'A login became a brand-new NEAR account on public testnet. Three transactions: create and '
      + 'fund with a temporary full-access key; grant the market its NEP-245 pull rights while that key '
      + 'still exists; then install a function-call key and DELETE the full-access one in the same '
      + 'transaction. The player never saw a key, and after this no full-access key for the account '
      + 'exists anywhere — which is what makes "no seed phrase" a fact rather than a slogan.',
    recorded_at: new Date().toISOString(),
    network: manifest.network, rpc,
    // The identity itself is never recorded. For a real login that would be
    // personal data, and the account id is a one-way hash of it by design.
    login: MODE === 'seed'
      ? { kind: 'seed', subject: SEED, provider: 'seed' }
      : { kind: 'oidc', provider: 'google', note: 'subject and token deliberately not recorded' },
    root: rootId,
    account: accountId,
    explorer: explorerAcct(accountId),
    transactions: Object.fromEntries(Object.entries(txs)
      .filter(([, h]) => h).map(([k, h]) => [k, { hash: h, explorer: explorerTx(h) }])),
    approval_transaction_note: 'step 2 sends no hash back: callFunction returns the contract value, not '
      + 'an outcome. The approval is proven by reading it back with mt_token_approval instead.',
    read_back_from_chain: {
      full_access_keys: full.length,
      function_call_keys: scoped.length,
      receiver_id: fc?.receiver_id ?? null,
      method_names: granted,
      catalog_methods: methodsExpected,
      approvals: Object.fromEntries(approvals),
    },
    root_near_before: rootBefore.toString(),
    root_near_after: rootAfter.toString(),
    root_near_spent: spent.toString(),
    credit_after_yocto: credit.toString(),
    checks: findings,
  }
} catch (e) {
  // A readable refusal, not a stack trace. Everything that can go wrong here is
  // operational — an expired token, a service that would not start, a chain
  // that said no — and a reader needs the sentence, not the call stack.
  console.error(`\n  STOPPED: ${e?.message ?? e}`)
  stopped = true
} finally {
  await teardown()
}

const failed = findings.filter((f) => !f.ok)
say(`\n  ${findings.length - failed.length} passed, ${failed.length} failed`)

if (record && failed.length === 0 && !stopped) {
  await mkdir(new URL('evidence/live/', ROOT), { recursive: true })
  const stamp = record.transactions?.created?.hash ?? record.account
  const file = `onboard-${stamp}.json`
  await writeFile(new URL(`evidence/live/${file}`, ROOT), JSON.stringify(record, null, 2) + '\n')
  say(`  retained  evidence/live/${file}\n`)
} else if (failed.length > 0) {
  say(`  nothing retained — evidence/live/ is for runs that passed.\n`)
}

process.exit(failed.length === 0 && !stopped ? 0 : 1)
