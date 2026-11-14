// One command that brings the whole Minecraft demo up and proves it.
//
//   npm run mc:up                 live testnet, seeded login, prove it, tear down
//   npm run mc:up -- --oidc       a real RS256 token, via a one-time code
//   npm run mc:up -- --keep       leave the server running and joinable
//   npm run mc:up -- --sandbox    a fresh local economy, no balance ceiling
//
// WHY. Everything here already worked, and still failed often — because it took
// three terminals in the right order. `mc:bot` needs `npm run play` listening;
// `--oidc` needs `npm run oidc:dev` and `npm run play:oidc` as well. Forget one
// and you get an exit telling you to go and start it. Every failure in this
// demo after the code was correct was orchestration, so orchestration is what
// this file removes.
//
// It is a SUPERVISOR, not a reimplementation: it spawns the same
// scripts/oidc-dev.mjs, scripts/serve-play.mjs and scripts/mc-bot.mjs that work
// today, in the right order, with the right environment. Nothing about how they
// behave changes, and running any of them by hand still works.
//
// Two promises worth stating:
//   - it only ever tears down what IT started, so a service you are using
//     survives this script;
//   - a run that cannot trade does not print a tick for trading. It reports the
//     trade as skipped, with the arithmetic.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises'
import { javaHome, fetchPinned, runtime } from './mc-java.mjs'
import { playerAccountId } from '../backend/near/onboarding.mjs'

const ROOT = new URL('..', import.meta.url)
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const OIDC = flag('--oidc')
const KEEP = flag('--keep')
const SANDBOX = flag('--sandbox')
const PORT = Number(value('--port', '8080'))
const SERVICE = `http://127.0.0.1:${PORT}`
const ISSUER_PORT = Number(value('--issuer-port', '8090'))
const SPAWN_ATTEMPTS = Number(value('--attempts', '3'))
/// Which identity to sign in as. From config/catalog.json, so the subject and
/// the manifest's player list have a single source rather than two.
const catalog = JSON.parse(await readFile(new URL('config/catalog.json', ROOT), 'utf8'))
const TOKEN = value('--token', catalog.players?.demo_subject ?? 'player-1')
/// One round trip costs the merchant's spread. Measured from the live quotes:
/// 0.004 out, 0.0032 back.
const ROUND_TRIP_COST = 0.0008
const TOPUP_TARGET = value('--credit', '0.05')

const started = []
const log = (...a) => console.log(...a)

function script(name, extra = [], env = {}) {
  const child = spawn('node', [new URL(name, import.meta.url).pathname, ...extra], {
    cwd: ROOT.pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) lines.push(l) })
  }
  return { child, lines }
}

/// Wait for a condition, awaiting it properly.
///
/// The first version of this checked `test()` for truthiness — and an async
/// predicate returns a Promise, which is ALWAYS truthy. So every wait returned
/// on its first tick without waiting for anything. The live run passed anyway,
/// because the service happened to be quick; the sandbox run crashed reading a
/// field off the null that came back. A wait that cannot wait is the same bug
/// class as a check that cannot fail.
async function until(test, ms, what) {
  const at = Date.now()
  for (;;) {
    if (await test()) return true
    if (Date.now() - at > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function health(url = SERVICE) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2500) })
    return res.ok ? await res.json() : null
  } catch { return null }
}

// --------------------------------------------------------------- pre-flight
//
// Everything that can be known before spending three minutes booting a
// Minecraft server. Each failure names its own fix, because the alternative is
// a reader guessing at a timeout.

const checks = []
const check = (what, ok, detail = '', fix = '') => {
  checks.push({ what, ok, detail, fix })
  log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(34)} ${detail}`)
  if (!ok && fix) log(`        -> ${fix}`)
  return ok
}

log(`\n=== NearCraft: bringing it up ===\n`)
log(`  mode      ${SANDBOX ? 'local sandbox' : 'live testnet'}${OIDC ? ', real OIDC login' : ', seeded login'}${KEEP ? ', staying up' : ''}`)
log(`  identity  ${TOKEN}`)
log('')

let home = null
try {
  home = await javaHome()
  check('a JDK is installed', true, home)
} catch (e) {
  check('a JDK is installed', false, '', runtime.java.install)
}

// Ordinary terrain is bigger than the flat world this used to generate, so the
// floor moved with it: Paper, its libraries and a real world are closer to
// 2 GiB than to 1.
//
// The catch used to call `check('disk space', true, ...)` — a measurement
// failure reported as a PASS, which is a check that cannot fail. It is now its
// own state: not a pass, not a hard failure, and visible. A pre-flight that
// says "ok" when it learned nothing is worse than one that is missing, because
// the reader stops looking.
try {
  const fs = await statfs(ROOT.pathname)
  const freeGiB = (fs.bsize * fs.bavail) / 1024 ** 3
  check('disk space', freeGiB > 2.5, `${freeGiB.toFixed(1)} GiB free`,
    'Paper, its libraries and a generated world need about 2 GiB; clear some space')
} catch (e) {
  log(`  ??    ${'disk space'.padEnd(34)} could not be measured (${e?.code ?? e?.message ?? 'unknown'})`)
  log('        -> continuing, but if the run dies mid-boot this is the first thing to check')
}

try {
  await fetchPinned('paper-api')
  check('the pinned jars are available', true, 'cached or fetched, hash verified')
} catch (e) {
  check('the pinned jars are available', false, e.message.split('\n')[0], 'check the network')
}

if (SANDBOX) {
  for (const name of ['nearcraft_items', 'nearcraft_market', 'nearcraft_guard']) {
    let ok = false
    try { ok = (await readFile(new URL(`contracts/target/near/${name}/${name}.wasm`, ROOT))).length > 0 } catch { /* no */ }
    check(`${name}.wasm is built`, ok, '', 'npm run build:contracts')
  }
}

// What is already listening, so nothing is started twice and nothing of the
// operator's gets killed later.
const existingService = await health()
const existingIssuer = OIDC ? await health(`http://127.0.0.1:${ISSUER_PORT}`) : null
if (existingService) {
  check('a play service is already up', true, `${SERVICE} verifier ${existingService.verifier}`)
  if (OIDC && existingService.verifier !== 'oidc') {
    check('...and it is the right kind', false, `reports "${existingService.verifier}"`,
      `stop it, or drop --oidc. This script will not kill a service it did not start.`)
  }
} else {
  // "Nothing answered /api/health" is not the same as "the port is free".
  // Something else holding it means serve-play dies with EADDRINUSE several
  // steps later, which is a confusing way to learn it.
  const free = await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(PORT, '127.0.0.1')
  })
  check('the service port is free', free, `${PORT}`,
    `something is holding ${PORT} and it is not a play service. Stop it, or pass --port <n>.`)
}

if (!SANDBOX) {
  // The same manifest the service will read, so a pre-flight cannot pass for a
  // deployment other than the one about to run.
  const manifestPath = process.env.NEARCRAFT_MANIFEST
    ? new URL(`file://${process.env.NEARCRAFT_MANIFEST}`)
    : new URL('deployment.json', ROOT)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const rpc = manifest.rpc
  const view = async (contractId, method, params) => {
    const res = await fetch(rpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'query',
        params: { request_type: 'call_function', finality: 'optimistic', account_id: contractId,
                  method_name: method, args_base64: Buffer.from(JSON.stringify(params)).toString('base64') },
      }),
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.json()
    return JSON.parse(Buffer.from(body.result.result).toString())
  }
  const balance = async (id) => {
    const res = await fetch(rpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query',
        params: { request_type: 'view_account', finality: 'optimistic', account_id: id } }),
      signal: AbortSignal.timeout(15000),
    })
    return Number((await res.json()).result.amount) / 1e24
  }

  try {
    const relayer = await balance(manifest.relayer.account_id)
    // A 60 TGas call needs about 0.0609 reserved, so this is the floor below
    // which relaying simply stops.
    check('the relayer can pay gas', relayer > 0.07, `${relayer.toFixed(4)} NEAR`,
      `npm run topup -- --from stonecutter --account ${manifest.relayer.account_id} is NOT the fix; the relayer needs NEAR, not credit. Use a faucet.`)
  } catch (e) { check('the relayer can pay gas', false, e.message) }

  // The account this run will ACTUALLY sign in as, derived from the identity it
  // is about to present — not `players[0]`.
  //
  // Those were the same account right up until a second player existed, and
  // then they silently diverged: the pre-flight would clear players[0]'s budget
  // while the bot spent a different player's, so a run could pass its own
  // affordability check and then fail on an empty balance three minutes later.
  // A pure local hash, so this costs no round trip.
  //
  // `seed` is the right provider label for both modes here: --oidc runs the
  // local issuer with OIDC_PROVIDER=seed (see below), so the derivation is the
  // same either way. A real provider would label it differently and derive a
  // different account, which is why that label is pinned once and never moved.
  const player = playerAccountId('seed', TOKEN, manifest.root)
  const recorded = (manifest.players ?? []).some((p) => p.account_id === player)
  check('the login maps to a player the manifest records', recorded, `${TOKEN} -> ${player}`,
    `deployment.json records [${(manifest.players ?? []).map((p) => p.account_id).join(', ')}]. ` +
    `Either pass --token <subject>, or onboard this one: npm run live:onboard -- --seed ${TOKEN}`)

  if (recorded) {
    try {
      const credit = Number(await view(manifest.contracts.market, 'credit_of', { account_id: player })) / 1e24
      const runs = Math.floor(credit / ROUND_TRIP_COST)
      check('the player can afford this run', runs >= 1,
        `${credit.toFixed(7)} NEAR, about ${runs} round trip(s)`,
        `npm run topup -- --account ${player} --to ${TOPUP_TARGET}`)
    } catch (e) { check('the player can afford this run', false, e.message) }
  }
}

const failed = checks.filter((c) => !c.ok)
if (failed.length > 0) {
  log(`\n  ${failed.length} pre-flight check(s) failed. Nothing was started.\n`)
  process.exit(1)
}
log(`\n  ${checks.length} pre-flight checks passed; nothing left to guess at.\n`)

// ------------------------------------------------------------- bring it up

async function teardown() {
  for (const { child, what } of started.reverse()) {
    if (child.exitCode === null) {
      log(`  stopping ${what}`)
      child.kill('SIGTERM')
    }
  }
  await new Promise((r) => setTimeout(r, 400))
  for (const { child } of started) if (child.exitCode === null) child.kill('SIGKILL')
}
process.on('SIGINT', async () => { log('\n  interrupted'); await teardown(); process.exit(130) })

let sandbox = null
let sandboxEnv = {}

try {
  if (SANDBOX) {
    // A LOCAL NODE, not a public chain. Nothing from here is evidence of
    // anything on testnet, and no hash from this mode goes into
    // evidence/live/. It exists so the demo always works, and so somebody with
    // no credentials at all can run the whole thing.
    //
    // The sandbox lives and dies inside this process: Sandbox.start picks a
    // random port, and a manifest naming a port that no longer exists is worse
    // than no manifest. Cross-process persistence would mean running the
    // nearcore binary with a fixed --home and --rpc-addr; it is not needed for
    // this and is not built.
    const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import('near-sandbox')
    log('  starting  a local nearcore node...')
    sandbox = await Sandbox.start({})
    started.push({ child: { exitCode: null, kill: () => sandbox.tearDown() }, what: 'the local node' })
    log(`  started   a local node at ${sandbox.rpcUrl}  root ${DEFAULT_ACCOUNT_ID} (10,000 NEAR)`)

    const dir = new URL('.tmp/sandbox/', ROOT)
    await mkdir(dir, { recursive: true })
    const manifestPath = new URL('deployment.json', dir).pathname
    const keysPath = new URL('keys.json', dir).pathname
    // The genesis key, so serve-play can create players. It is a published
    // constant in near-sandbox, not a secret.
    await writeFile(keysPath, JSON.stringify({ [DEFAULT_ACCOUNT_ID]: DEFAULT_PRIVATE_KEY }, null, 2) + '\n')

    sandboxEnv = {
      NEAR_RPC: sandbox.rpcUrl,
      NEAR_ROOT_ACCOUNT: DEFAULT_ACCOUNT_ID,
      NEAR_ROOT_KEY: DEFAULT_PRIVATE_KEY,
      // EXPLICIT, because deploy.mjs inherits this from whatever manifest is on
      // disk and the committed one says 0.01 — which would quietly build a
      // 1%-size economy in a sandbox that can afford the whole thing.
      NEAR_ECONOMY_SCALE: '1',
      NEARCRAFT_MANIFEST: manifestPath,
      NEARCRAFT_KEYS: keysPath,
    }

    log('  deploying the contracts and the economy (the same deploy.mjs testnet uses)...')
    const { child, lines } = script('deploy.mjs', [], sandboxEnv)
    const code = await new Promise((resolve) => child.on('close', resolve))
    if (code !== 0) {
      log(lines.slice(-25).map((l) => `    ${l}`).join('\n'))
      throw new Error('the sandbox deployment failed')
    }
    const deployed = JSON.parse(await readFile(new URL('file://' + manifestPath), 'utf8'))
    log(`  deployed  ${Object.keys(deployed.contracts).length} contracts, ` +
        `${deployed.merchants?.length ?? 0} merchants, ${deployed.players?.length ?? 0} player(s), ` +
        `scale ${deployed.economy_scale}`)
  }

  if (OIDC && !existingIssuer && !existingService) {
    const { child } = script('oidc-dev.mjs', [], { OIDC_DEV_PORT: String(ISSUER_PORT) })
    started.push({ child, what: 'the OIDC issuer' })
    // Wait for the JWKS to answer rather than guessing at a sleep.
    await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${ISSUER_PORT}/.well-known/jwks.json`, { signal: AbortSignal.timeout(1000) })).ok }
      catch { return false }
    }, 20000, 'the OIDC issuer').catch(() => { throw new Error('the OIDC issuer never came up') })
    log(`  started   the OIDC issuer on :${ISSUER_PORT}`)
  }

  if (!existingService) {
    // ALWAYS explicit. A service that inherits its login mode from whatever
    // config file happens to exist is how --sandbox got a Google issuer and
    // refused its own seeded player.
    const env = { PORT: String(PORT), ...sandboxEnv, NEARCRAFT_LOGIN: OIDC ? 'oidc' : 'seed' }
    if (OIDC) Object.assign(env, {
      OIDC_ISSUER: `http://127.0.0.1:${ISSUER_PORT}`,
      OIDC_AUDIENCE: 'nearcraft-dev',
      OIDC_JWKS_URI: `http://127.0.0.1:${ISSUER_PORT}/.well-known/jwks.json`,
      OIDC_PROVIDER: 'seed',
    })
    const { child, lines } = script('serve-play.mjs', [], env)
    started.push({ child, what: 'the play service' })
    await until(async () => Boolean(await health()), 30000, 'the play service')
      .catch(() => { throw new Error(`the play service never came up:\n${lines.slice(-8).join('\n')}`) })
    const h = await health()
    if (!h) throw new Error(`the play service answered once and then stopped:\n${lines.slice(-8).join('\n')}`)
    log(`  started   the play service on :${PORT}  verifier ${h.verifier}  linkCodes ${h.linkCodes}`)
  } else {
    log(`  reusing   the play service already on :${PORT} — it will NOT be stopped`)
  }

  // ------------------------------------------------------------- the proof
  if (KEEP) {
    log(`\n  handing over to a long-running server. Ctrl-C stops everything this script started.\n`)
    const { child } = script('mc-server.mjs', ['--service', SERVICE, '--serve'])
    started.push({ child, what: 'the Minecraft server' })
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    await new Promise((resolve) => child.on('close', resolve))
  } else {
    let passed = false
    let attempt = 0
    while (attempt < SPAWN_ATTEMPTS && !passed) {
      attempt++
      log(`\n  --- proving it${attempt > 1 ? `, attempt ${attempt}` : ''} ---\n`)
      const { child, lines } = script('mc-bot.mjs',
        ['--service', SERVICE, '--token', TOKEN, ...(OIDC ? ['--oidc'] : [])])
      child.stdout.on('data', (d) => process.stdout.write(d))
      child.stderr.on('data', (d) => process.stderr.write(d))
      const code = await new Promise((resolve) => child.on('close', resolve))
      if (code === 0) { passed = true; break }

      // Retry ONLY a connection problem. A failed assertion is a result.
      const text = lines.join('\n')
      const connection = /never spawned|disconnected while waiting|kicked|timed out waiting for the server/.test(text)
      if (!connection) {
        log(`\n  it failed on a check, not on the connection. Not retrying — that would be hiding a result.\n`)
        break
      }
      if (attempt < SPAWN_ATTEMPTS) {
        log(`\n  the client could not stay connected. That hop goes through ViaVersion and is the one`)
        log(`  step outside this repository, so retrying (${attempt}/${SPAWN_ATTEMPTS - 1}).\n`)
      }
    }
    log(`\n=== ${passed ? 'up and proven' : 'NOT proven'} ===`)
    if (attempt > 1) log(`  the client needed ${attempt} attempt(s) to stay connected`)
    if (!passed) { await teardown(); process.exit(1) }
  }
} finally {
  if (!KEEP) await teardown()
}

log('')
