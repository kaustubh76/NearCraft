// Boot a real Paper server with the NearCraft plugin, drive it from the
// console, and keep the log.
//
//   npm run mc:server                 load the plugin and run the selftest
//   npm run mc:server -- --trade      also sign in and settle a real trade
//   npm run mc:server -- --token seed:player-1 --sell ironmonger:iron_ingot:1
//
// WHY EVERY COMMAND IS ALSO CONSOLE-RUNNABLE. There is no PAID Minecraft
// account on this machine, so an unattended run cannot join its own server;
// the console drives it instead, and the one thing the console cannot do —
// move blocks in an inventory — is the one thing the plugin says out loud it
// skipped. That is a smaller gap than proving nothing at all.
//
// A client does exist here, though, and `--offline` is what lets it in: it
// turns off Mojang authentication for a non-premium launcher and binds the
// server to 127.0.0.1 in the same breath. So the console path is still how
// this is tested unattended, and a person can now also play it.
//
// THE EULA. Starting a Minecraft server means agreeing to Mojang's End User
// Licence Agreement. This script writes eula=true because the operator of this
// repository said to; it prints what it is doing rather than doing it quietly.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { fetchPinned, javaHome, run, ROOT, TMP, runtime, serverProperties, protocolBridge, typistNote }
  from './mc-java.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const SERVER = new URL('server/', TMP)
const PLUGINS = new URL('plugins/', SERVER)
const JAR = new URL('NearCraft.jar', TMP)
const PORT = value('--port', '25565')
const SERVICE = value('--service', 'http://127.0.0.1:8080')
const TOKEN = value('--token', null)
const SELL = value('--sell', flag('--trade') ? 'ironmonger:iron_ingot:1' : null)
const BUY = value('--buy', null)
const TRADE = SELL ?? BUY
/// Which agent to dispatch from the console, or null to skip it.
const AGENT = value('--agent', null)
/// The address a player outside this machine actually types.
///
/// Render cannot host a Minecraft server — it exposes HTTP only on 80/443, UDP
/// is not on its roadmap, and its TCP support reaches only its own private
/// network. So a joinable server runs here behind a tunnel, and the banner has
/// to print the tunnel's address rather than the loopback one it binds. Live
/// while this machine is on, which is a demo window and not hosting;
/// docs/MINECRAFT.md says so in those words.
/// Turn off Mojang authentication, for a client that has no Mojang account.
///
/// Opt-in, and it carries a cost that is stated rather than buried: the server
/// then trusts whatever username a client asserts, and the UUID it records is
/// the offline, name-derived kind. So a session played this way proves that A
/// PERSON at a real client did it, not WHICH person. serverProperties() binds
/// the same branch to 127.0.0.1 so that trust cannot extend past this machine.
const OFFLINE = flag('--offline')
const PUBLIC = value('--public', null)
const BOOT_TIMEOUT_MS = 10 * 60 * 1000

console.log('\n=== NearCraft on Paper ===\n')

// ------------------------------------------------------- is anyone listening
//
// The plugin is a client of the play service. Booting a server to watch every
// command answer SERVICE_UNREACHABLE wastes five minutes, so say it up front.
let servicePlayable = false
/// Kept so the join banner can derive its login hint from what the service
/// ANSWERED, instead of hard-coding one.
let health = null
try {
  // 20s, not 3s. A free Render instance sleeps after fifteen idle minutes and
  // answers its first request in about twenty-three seconds, so a 3s probe
  // timed out against a service that was merely asleep -- and `health` then
  // stayed null, which makes the join banner below offer `/nearcraft claim
  // <code>` when the right instruction is `/nearcraft link <any name>`. The
  // cost of being wrong the other way is twenty seconds on a genuinely dead
  // service, which is a run that was not going to be played anyway.
  const probe = await fetch(`${SERVICE}/api/health`, { signal: AbortSignal.timeout(20_000) })
  servicePlayable = probe.ok
  const body = await probe.json()
  health = body
  console.log(`  play service  ${SERVICE}  ${body.network ?? '?'}  verifier ${body.verifier ?? '?'}`)
  if (body.pool) console.log(`                ${body.pool.free} of ${body.pool.size} pre-funded player(s) left`)
} catch {
  console.log(`  play service  ${SERVICE}  NOT RUNNING`)
  console.log('                start it in another terminal with: npm run play')
  console.log('                booting anyway — the plugin still has to load.')
}

// ----------------------------------------------------------------- the build
await run('node', [new URL('mc-build.mjs', import.meta.url).pathname])

const home = await javaHome()
const paper = await fetchPinned('paper')

await mkdir(PLUGINS, { recursive: true })
await copyFile(JAR, new URL('NearCraft.jar', PLUGINS))

// ViaVersion and ViaBackwards, on EVERY run.
//
// Paper 26.3 refuses a client on an older protocol, and no Minecraft Java
// client ships on 26.3 -- so without these, nothing a person can launch is
// able to join at all. This was the second reason a human could not play, and
// it is not behind a flag because a flag is the failure mode: pass --offline,
// forget the other one, wait out world generation and read "Outdated client".
//
// It cannot break the case it is not needed for (a client already on the
// server's protocol passes straight through) and it needs no new evidence:
// scripts/mc-bot.mjs already loads these two jars as server plugins on this
// same pinned Paper build, and a client joined through them.
for (const name of protocolBridge()) {
  await copyFile(await fetchPinned(name), new URL(`${name}.jar`, PLUGINS))
}

// The plugin's own config, written each run so --service is honoured.
await mkdir(new URL('NearCraft/', PLUGINS), { recursive: true })
await writeFile(new URL('NearCraft/config.yml', PLUGINS), `service: '${SERVICE}'\n`)

console.log('\n  I am accepting Mojang\'s EULA on your behalf, as agreed: eula=true')
await writeFile(new URL('eula.txt', SERVER), 'eula=true\n')

// ORDINARY TERRAIN, from a pinned seed, and the authentication posture.
//
// Both now come from serverProperties() in scripts/mc-java.mjs, because this
// file cannot be imported -- it has a top-level await fetch and a spawn -- so
// nothing inline here could ever be tested. The long WHY for each line lives
// with the function; the short version is that the world used to be superflat,
// in which none of the eight traded materials existed, and that --offline is
// five properties rather than one because Paper needs all five before a
// non-premium client can get through the door.
const world = runtime.world
await writeFile(new URL('server.properties', SERVER),
  serverProperties({ port: PORT, world, offline: OFFLINE }))

// ------------------------------------------------------------------- the run
const logPath = new URL('mc-server.log', TMP).pathname
const log = createWriteStream(logPath)
console.log(`\n  booting Paper ${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build} on Java ${runtime.java.minimum}`)
console.log(`  full log -> ${logPath}\n`)

const server = spawn(`${home}/bin/java`, ['-Xms512M', '-Xmx1G', '-jar', paper.pathname, '--nogui'], {
  cwd: SERVER.pathname,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let ready = false
let failed = null
const seen = []

/** Print the lines that matter and keep everything. Paper is very chatty. */
function onLine(line) {
  log.write(line + '\n')
  seen.push(line)
  if (/Done \(/.test(line)) ready = true
  if (/NearCraft|selftest|settled on NEAR|signed in|refused| bought |Enabling NearCraft|Exception|ERROR\]: Could not/.test(line)) {
    console.log('  ' + line.replace(/^\[[^\]]*\]:?\s*/, '').trim())
  }
}

let buffer = ''
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
}
server.on('error', (e) => { failed = e })

const until = (test, ms, what) => new Promise((resolve, reject) => {
  const started = Date.now()
  const tick = setInterval(() => {
    if (failed) { clearInterval(tick); reject(failed); return }
    if (test()) { clearInterval(tick); resolve(true); return }
    if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)); }
  }, 250)
})

// SIGINT reaches the Java child too. If it exits before the `finally` below
// sends `stop`, that write lands on a closed pipe -- and an EPIPE on a stream
// with no error listener is an uncaught exception, which kills the process
// before retain() runs. The evidence for a session that went perfectly would
// be lost at the last step. One listener.
server.stdin.on('error', () => {})

const send = async (command, settleMs = 4000) => {
  console.log(`\n  > ${command}`)
  server.stdin.write(command + '\n')
  await new Promise((r) => setTimeout(r, settleMs))
}

try {
  await until(() => ready, BOOT_TIMEOUT_MS, 'the server to finish starting')
  console.log('\n  server is up\n')

  await send('plugins')
  await send('nearcraft selftest', 6000)
  // Needs no network and no player: it drives Items against a real
  // Bukkit.createInventory, which is the only way the inventory arithmetic can
  // be checked on a machine with no Minecraft account.
  await send('nearcraft inventory-selftest', 5000)
  // Asks the world what is in it, which nothing did before — see the javadoc on
  // NearCraftPlugin.worldSelftest. A flat world answers "0 of 8" here.
  await send('nearcraft world-selftest', 20000)

  if (TOKEN) {
    // The token is passed on the command line and never written to disk. It is
    // the weak point of the whole plugin and is disclosed, not hidden.
    await send(`nearcraft link ${TOKEN}`, 8000)
    await send('wallet', 6000)
    // Both halves of the loop, in one boot, because booting a Minecraft server
    // to prove one command and then booting it again to prove the other is a
    // waste of three minutes and of a reader's patience.
    for (const [verb, spec] of [['sell', SELL], ['buy', BUY]]) {
      if (!spec) continue
      const [merchant, item, count] = spec.split(':')
      await send(`${verb} ${merchant} ${item} ${count ?? '1'}`, 45000)
      await send('wallet', 6000)
    }
    // Send an agent too. This is the one command that spends somebody else's
    // money — the worker's own credit, on the worker's own key — and it was
    // documented in GAME_LOOP.md and implemented nowhere until now, so proving
    // it from the console is worth the twenty seconds.
    if (AGENT) await send(`agent ${AGENT} buy ${(TRADE ?? 'x:iron_ingot:1').split(':')[1]} 1`, 60000)
  } else if (TRADE) {
    console.log('\n  --trade needs --token <subject>; skipping the trade')
  }

  // --serve: stay up instead of stopping, so somebody can actually join.
  //
  // This belongs at the end of the TRY. The first version of it sat at the end
  // of the CATCH, so the server stayed up only when something had gone wrong —
  // and on a clean run it stopped, which is the opposite of what the flag says.
  // `--keep` is a different thing and unchanged: it means "do not delete the
  // world".
  if (flag('--serve')) {
    console.log(`\n=== staying up ===`)
    console.log(`  join at   ${PUBLIC ?? `127.0.0.1:${PORT}`}   (Minecraft Java ${runtime.client})`)
    if (PUBLIC) console.log(`  bound to  127.0.0.1:${PORT} — ${PUBLIC} is a tunnel to it`)
    // Print the posture rather than leaving the operator to assume it. A
    // server that trusts any username should say so in the same breath as the
    // address somebody is about to connect to.
    console.log(OFFLINE
      ? `  login     AUTHENTICATION OFF (--offline) — bound to 127.0.0.1 only, so only this\n`
        + '            machine can reach it. Any username is accepted; the UUID is the\n'
        + '            offline kind, which identifies a client and not a person.'
      : '  login     Mojang authentication ON — a premium account is required to join')
    console.log(`  bridge    ${protocolBridge().join(' + ')} — so a client older than 26.3 can connect`)

    // Derived from the service's own answer. This line read
    // `/nearcraft link player-1` — the stale token replaced in web/market.html
    // and in serve-play's banner and missed here, which on a live server would
    // have sent every visitor to an account that does not exist.
    if (health?.pool) {
      console.log('  in chat   /nearcraft link <any name>   then   /market iron_ingot')
      console.log(`            any name works and you get your OWN pre-funded player —`)
      console.log(`            ${health.pool.free} of ${health.pool.size} left. A demo pool, not a faucet.`)
    } else if (health?.verifier === 'oidc') {
      console.log('  in chat   /nearcraft claim <code>   — the code comes from the web page')
      console.log('            a real login token is about 977 characters and chat carries 256')
    } else {
      console.log('  in chat   /nearcraft claim <code>   from the web page, then /market iron_ingot')
      console.log('            this service derives an account from the login, so only an')
      console.log('            identity it has already onboarded can sign in')
    }
    console.log(`\n  Ctrl-C to stop.\n`)
    await new Promise((resolve) => {
      process.on('SIGINT', resolve)
      process.on('SIGTERM', resolve)
      server.on('close', resolve)
    })
  }
} catch (e) {
  console.error(`\n  ${e.message}`)
  console.error(`  the last few lines:\n${seen.slice(-12).map((l) => '    ' + l).join('\n')}`)
} finally {
  await send('stop', 1000)
  await new Promise((resolve) => {
    server.on('close', resolve)
    setTimeout(() => { server.kill('SIGKILL'); resolve() }, 30000)
  })
  log.end()
}

// ------------------------------------------------------------- the evidence
//
// Written from the server's OWN log rather than from a second set of queries,
// because what is being evidenced here is precisely what a Minecraft server
// printed. Re-reading the chain afterwards would prove the chain, which other
// checks already do; this proves the game said it.
async function retain() {
  const text = seen.join('\n')
  const settlements = [...text.matchAll(/settled on NEAR with (.+?)\s+tx ([A-Za-z0-9]+)/g)]
  if (settlements.length === 0) return null
  const settlement = settlements[0]
  const credits = [...text.matchAll(/credit (\S+) NEAR/g)].map((m) => m[1])
  const holdings = [...text.matchAll(/holds\s+(\d+) (\w+)/g)].map((m) => [m[1], m[2]])
  const account = text.match(/signed in as (\S+)/)
  const delta = text.match(/NEAR balance moved by (\S+)/)
  const hash = settlement[2]

  // Name what actually ran. The first version of this said "A sale settled"
  // whatever the run did, and a record of a sell AND a buy then described
  // itself as one sale — a small overstatement, but the kind this project
  // exists to not make.
  const ran = [SELL && 'A sale', BUY && 'a purchase'].filter(Boolean)
  const what = ran.length > 1
    ? `${ran[0]} and ${ran.slice(1).join(' and ')}`
    : (ran[0] ?? 'A trade')
  const who = typistNote(text, { offline: OFFLINE })

  const record = {
    note: `${what} settled on public NEAR testnet from inside a Minecraft server. `
      + 'Every line below was printed by the NearCraft plugin running on Paper '
      + `${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build}; `
      + who
      + 'The plugin holds no keys: it calls the play service, which holds the player\'s scoped key.',
    recorded_at: new Date().toISOString(),
    network: 'testnet',
    service: SERVICE,
    paper: `${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build}`,
    paper_sha256: runtime.artifacts.paper.sha256,
    java: runtime.java.minimum,
    // Carried as fields, not only prose, so a reader does not have to parse the
    // note to learn what the server trusted. mc-bot.mjs already records
    // online_mode for the same reason.
    online_mode: !OFFLINE,
    bound_to: OFFLINE ? `127.0.0.1:${PORT}` : `*:${PORT}`,
    protocol_bridge: protocolBridge().map((n) => `${n} ${runtime.artifacts[n].version}`),
    player: account ? account[1] : null,
    merchant: settlement[1],
    credit_before_near: credits[0] ?? null,
    credit_after_near: credits[credits.length - 1] ?? null,
    holdings_before: holdings[0] ? `${holdings[0][0]} ${holdings[0][1]}` : null,
    holdings_after: holdings[holdings.length - 1]
      ? `${holdings[holdings.length - 1][0]} ${holdings[holdings.length - 1][1]}` : null,
    player_near_delta_yocto: delta ? delta[1] : null,
    // Keyed by what was actually run, in order, so a record of a sell-then-buy
    // does not claim to be a record of one sale.
    transactions: Object.fromEntries(settlements.map((m, i) => [
      [SELL && 'sell', BUY && 'buy'].filter(Boolean)[i] ?? `trade_${i + 1}`,
      { hash: m[2], explorer: `https://testnet.nearblocks.io/txns/${m[2]}` },
    ])),
    console_transcript: seen
      // Paper's own join and command lines are kept too. Without them a
      // human-played transcript showed the plugin's replies with nothing to
      // say who had caused them, which is the one thing a console run never
      // needed to prove.
      .filter((l) => /NearCraft|selftest|signed in|credit |holds |settled on NEAR|balance moved|asks | bought |issued server command|joined the game|logged in with entity id|UUID of player/.test(l))
      .map((l) => l.replace(/^\[[^\]]*\]:?\s*/, '').trimEnd()),
  }
  const file = `minecraft-${hash}.json`
  await mkdir(new URL('evidence/live/', ROOT), { recursive: true })
  await writeFile(new URL(`evidence/live/${file}`, ROOT), JSON.stringify(record, null, 2) + '\n')
  return file
}

const retained = await retain()

// ---------------------------------------------------------------- the verdict
const enabled = seen.some((l) => /Enabling NearCraft/.test(l))
const settled = seen.some((l) => /settled on NEAR/.test(l))
const healthy = seen.some((l) => /health\s+200/.test(l))
const dispatched = seen.find((l) => / bought /.test(l))
const inventory = seen.find((l) => /inventory selftest: /.test(l))
const inventoryOk = Boolean(inventory) && /0 failed/.test(inventory)
const worldLine = seen.find((l) => /world selftest: /.test(l))
const worldOk = Boolean(worldLine) && /0 failed/.test(worldLine)

console.log('\n=== result ===')
console.log(`  plugin loaded on Paper        ${enabled ? 'yes' : 'NO'}`)
console.log(`  reached the play service      ${healthy ? 'yes' : 'no'}`)
console.log(`  inventory arithmetic          ${inventory ? (inventoryOk ? 'all passed' : 'FAILED') : 'did not run'}`)
const worldSays = worldLine ? worldLine.replace(/.*world selftest: /, '') : null
console.log(`  the world can be gathered in  ${worldSays ? (worldOk ? worldSays : `FAILED — ${worldSays}`) : 'did not run'}`)
if (AGENT) console.log(`  an agent shopped for itself     ${dispatched ? 'yes' : 'NO'}`)
console.log(`  settled a trade on NEAR       ${settled ? 'yes' : (TRADE ? 'NO' : 'not attempted')}`)
console.log(`  log                           ${logPath}`)
if (retained) console.log(`  retained                      evidence/live/${retained}`)

if (!flag('--keep')) {
  // Generated terrain is a few hundred MiB. A one-shot verification run should
  // not leave it behind; --keep does, and is what you pass when you intend to
  // come back and play, because then the generation is paid once.
  await rm(new URL('nearcraft/', SERVER), { recursive: true, force: true })
}

process.exit(enabled && inventoryOk && worldOk && (!TRADE || settled) && (!AGENT || Boolean(dispatched)) ? 0 : 1)
