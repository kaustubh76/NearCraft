// Boot a real Paper server with the NearCraft plugin, drive it from the
// console, and keep the log.
//
//   npm run mc:server                 load the plugin and run the selftest
//   npm run mc:server -- --trade      also sign in and settle a real trade
//   npm run mc:server -- --token seed:player-1 --sell ironmonger:iron_ingot:1
//
// WHY A CONSOLE AND NOT A PLAYER. Joining a server needs a paid Minecraft
// account and the game client, and neither exists on this machine. Every
// command is therefore console-runnable, and the one thing the console cannot
// do — move blocks in an inventory — is the one thing the plugin says out loud
// it skipped. That is a smaller gap than proving nothing at all.
//
// THE EULA. Starting a Minecraft server means agreeing to Mojang's End User
// Licence Agreement. This script writes eula=true because the operator of this
// repository said to; it prints what it is doing rather than doing it quietly.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { fetchPinned, javaHome, run, ROOT, TMP, runtime } from './mc-java.mjs'

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
const BOOT_TIMEOUT_MS = 10 * 60 * 1000

console.log('\n=== NearCraft on Paper ===\n')

// ------------------------------------------------------- is anyone listening
//
// The plugin is a client of the play service. Booting a server to watch every
// command answer SERVICE_UNREACHABLE wastes five minutes, so say it up front.
let servicePlayable = false
try {
  const probe = await fetch(`${SERVICE}/api/health`, { signal: AbortSignal.timeout(3000) })
  servicePlayable = probe.ok
  const body = await probe.json()
  console.log(`  play service  ${SERVICE}  ${body.network ?? '?'}  verifier ${body.verifier ?? '?'}`)
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

// The plugin's own config, written each run so --service is honoured.
await mkdir(new URL('NearCraft/', PLUGINS), { recursive: true })
await writeFile(new URL('NearCraft/config.yml', PLUGINS), `service: '${SERVICE}'\n`)

console.log('\n  I am accepting Mojang\'s EULA on your behalf, as agreed: eula=true')
await writeFile(new URL('eula.txt', SERVER), 'eula=true\n')

// A flat world, four chunks of view distance and no spawn protection: this
// server exists to run two commands, not to be played, and world generation is
// the slowest part of booting one. online-mode stays TRUE — a demo is not a
// reason to turn authentication off.
await writeFile(new URL('server.properties', SERVER), [
  `server-port=${PORT}`,
  'online-mode=true',
  'level-type=minecraft\\:flat',
  'level-name=nearcraft',
  'view-distance=4',
  'simulation-distance=4',
  'spawn-protection=0',
  'max-players=5',
  'motd=NearCraft - an agent economy settled on NEAR',
  'sync-chunk-writes=false',
  '',
].join('\n'))

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
  if (/NearCraft|selftest|settled on NEAR|signed in|refused|Enabling NearCraft|Exception|ERROR\]: Could not/.test(line)) {
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
  } else if (TRADE) {
    console.log('\n  --trade needs --token <subject>; skipping the trade')
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
  const record = {
    note: `${what} settled on public NEAR testnet from inside a Minecraft server. `
      + 'Every line below was printed by the NearCraft plugin running on Paper '
      + `${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build}; the commands were issued at the `
      + 'server console, because there is no Minecraft account on the machine that ran this. '
      + 'The plugin holds no keys: it calls the play service, which holds the player\'s scoped key.',
    recorded_at: new Date().toISOString(),
    network: 'testnet',
    service: SERVICE,
    paper: `${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build}`,
    paper_sha256: runtime.artifacts.paper.sha256,
    java: runtime.java.minimum,
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
      .filter((l) => /NearCraft|selftest|signed in|credit |holds |settled on NEAR|balance moved|asks /.test(l))
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

console.log('\n=== result ===')
console.log(`  plugin loaded on Paper        ${enabled ? 'yes' : 'NO'}`)
console.log(`  reached the play service      ${healthy ? 'yes' : 'no'}`)
console.log(`  settled a trade on NEAR       ${settled ? 'yes' : (TRADE ? 'NO' : 'not attempted')}`)
console.log(`  log                           ${logPath}`)
if (retained) console.log(`  retained                      evidence/live/${retained}`)

if (!flag('--keep')) {
  // The world is 100 MiB of flat chunks nobody will visit again.
  await rm(new URL('nearcraft/', SERVER), { recursive: true, force: true })
}

process.exit(enabled && (!TRADE || settled) ? 0 : 1)
