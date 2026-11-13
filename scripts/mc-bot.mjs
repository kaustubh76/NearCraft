// A real Minecraft player buys iron, and the ingot lands in a real inventory.
//
//   npm run play      # in another terminal
//   npm run mc:bot
//
// WHY THIS EXISTS. Everything the Minecraft plugin had been proven to do was
// driven from the server CONSOLE, and a console has no inventory — the plugin
// says so itself, printing "(console: chain only, no inventory to move)". So
// the half of the loop that moves a player's property had never run anywhere:
// `Items.take` and `Items.give` were reachable only from a `Player`, and no
// player had ever joined. This connects one.
//
// IT IS A BOT, NOT A PERSON. mineflayer is a headless client. It is a real
// protocol client with a real server-side `Player` entity and a real
// `PlayerInventory`, which is exactly what was missing — but nobody played
// this, and no document here says otherwise.
//
// ONLINE-MODE. A headless client has no Mojang account, so this server runs
// `online-mode=false` and `enforce-secure-profile=false`. That applies HERE
// ONLY, in its own directory: `npm run mc:server` keeps `online-mode=true`,
// and a run of one can never inherit the other's properties.
//
// The mineflayer / protocol / ViaVersion combination is not guesswork: it is
// the one the sibling EthCraft repository records as working against this exact
// Paper build.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { fetchPinned, javaHome, run, ROOT, TMP, runtime } from './mc-java.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const SERVER = new URL('bot-server/', TMP)
const PLUGINS = new URL('plugins/', SERVER)
const JAR = new URL('NearCraft.jar', TMP)
const PORT = Number(value('--port', '25566'))
const SERVICE = value('--service', 'http://127.0.0.1:8080')
const TOKEN = value('--token', 'player-1')
const MERCHANT = value('--merchant', 'ironmonger')
const ITEM = value('--item', 'iron_ingot')
const COUNT = Number(value('--count', '1'))
const USERNAME = value('--username', 'nearcraft_bot')
const BOOT_TIMEOUT_MS = 10 * 60 * 1000
const SPAWN_TIMEOUT_MS = 90 * 1000

console.log('\n=== NearCraft: a real player ===\n')

// ------------------------------------------------------------ the service
let service = null
try {
  const probe = await fetch(`${SERVICE}/api/health`, { signal: AbortSignal.timeout(3000) })
  service = await probe.json()
  console.log(`  play service  ${SERVICE}  ${service.network}  verifier ${service.verifier}`)
} catch {
  console.error(`  play service  ${SERVICE}  NOT RUNNING`)
  console.error('                start it with `npm run play` and try again.')
  console.error('                this check settles a real trade, so it cannot be faked offline.\n')
  process.exit(1)
}

// -------------------------------------------------------------- the build
await run('node', [new URL('mc-build.mjs', import.meta.url).pathname])

const home = await javaHome()
const paper = await fetchPinned('paper')

await rm(SERVER, { recursive: true, force: true })
await mkdir(PLUGINS, { recursive: true })
await copyFile(JAR, new URL('NearCraft.jar', PLUGINS))

// ViaVersion lets a client speaking an older protocol reach this server, which
// is how a pinned mineflayer talks to a newer Paper.
for (const name of runtime.botClasspath) {
  await copyFile(await fetchPinned(name), new URL(`${name}.jar`, PLUGINS))
}

await mkdir(new URL('NearCraft/', PLUGINS), { recursive: true })
await writeFile(new URL('NearCraft/config.yml', PLUGINS), `service: '${SERVICE}'\n`)
await writeFile(new URL('eula.txt', SERVER), 'eula=true\n')

// Paper's move validation rejects this client.
//
// Twice now the bot has been kicked one second after its command with "Invalid
// move player packet received", losing the reply it was waiting for. The cause
// is the protocol hop: mineflayer's position updates are translated between two
// Minecraft versions by ViaVersion, and the result does not survive Paper's
// consistency check. Turning mineflayer's physics off was not enough — it still
// sends position packets.
//
// So the fixture relaxes the two thresholds that drive that check. This is a
// test server for a client that never moves, in its own directory, and the
// relaxation is as confined as online-mode=false is. It does not touch
// npm run mc:server.
await writeFile(new URL('spigot.yml', SERVER), [
  'settings:',
  '  moved-wrongly-threshold: 1000.0',
  '  moved-too-quickly-multiplier: 10000.0',
  '',
].join('\n'))

// online-mode=false is the whole reason this lives in its own directory.
await writeFile(new URL('server.properties', SERVER), [
  `server-port=${PORT}`,
  'server-ip=127.0.0.1',
  'online-mode=false',
  'enforce-secure-profile=false',
  'level-type=minecraft\\:flat',
  'level-name=nearcraft-bot',
  'gamemode=survival',
  'difficulty=peaceful',
  'spawn-protection=0',
  'view-distance=3',
  'simulation-distance=3',
  'max-players=3',
  // Paper's generated default is a whitelist nobody is on, which kicked the
  // first bot that got this far: "You are not whitelisted on this server!".
  // Stated explicitly rather than relying on a default either way.
  'white-list=false',
  'enforce-whitelist=false',
  'motd=NearCraft bot fixture - no humans, no tokens',
  '',
].join('\n'))

// ---------------------------------------------------------------- the boot
const logPath = new URL('mc-bot.log', TMP).pathname
const log = createWriteStream(logPath)
console.log(`\n  booting Paper ${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build} on :${PORT}`)
console.log(`  plugins: NearCraft + ${runtime.botClasspath.join(' + ')}`)
console.log(`  full log -> ${logPath}\n`)

const server = spawn(`${home}/bin/java`, ['-Xms512M', '-Xmx1G', '-jar', paper.pathname, '--nogui'], {
  cwd: SERVER.pathname, stdio: ['pipe', 'pipe', 'pipe'],
})

let ready = false
const serverLines = []
let buffer = ''
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      log.write(line + '\n')
      serverLines.push(line)
      if (/Done \(/.test(line)) ready = true
      if (/NearCraft|joined the game|Via/.test(line)) console.log('  ' + line.replace(/^\[[^\]]*\]:?\s*/, '').trim())
    }
  })
}

const until = (test, ms, what) => new Promise((resolve, reject) => {
  const started = Date.now()
  const tick = setInterval(() => {
    if (test()) { clearInterval(tick); resolve(true); return }
    // A client that has left will never satisfy the test, and waiting out the
    // timeout hides why: the first failure of this kind looked like "no reply"
    // when the real answer was "kicked for a bad movement packet".
    if (disconnected) {
      clearInterval(tick)
      reject(new Error(`the client disconnected while waiting for ${what}: ${disconnected}`))
      return
    }
    if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)) }
  }, 250)
})

const findings = []
const check = (what, ok, detail = '') => {
  findings.push({ what, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}`)
}

let bot = null
let chat = []
let failure = null
let disconnected = null

try {
  await until(() => ready, BOOT_TIMEOUT_MS, 'the server to finish starting')
  console.log('\n  server is up; connecting a headless client\n')

  const { createBot } = await import('mineflayer')
  bot = createBot({
    host: '127.0.0.1',
    port: PORT,
    username: USERNAME,
    version: runtime.bot.protocol,
    auth: 'offline',
  })

  // Send no position packets at all.
  //
  // This is the fix for "Invalid move player packet received". Paper applies a
  // hard validity check to the values in a move packet, and ViaVersion's
  // translation of mineflayer's position packet does not survive it — the bot
  // was kicked one second after every command, losing the reply. Turning
  // mineflayer's physics off did not stop the packets, and connecting as 26.1
  // (the newest protocol mineflayer speaks) got less far than 1.21.11 did.
  //
  // So the packets are dropped before they leave. A Minecraft client is not
  // required to report its position; one that never moves simply appears
  // stationary, which is exactly what this client is. Everything it is here to
  // do — run commands, read its own inventory — is unaffected.
  //
  // Reaching into bot._client is reaching past mineflayer's public API. That is
  // acceptable in a test harness and nowhere else, and it is why this lives in
  // scripts/ rather than in the plugin.
  const write = bot._client.write.bind(bot._client)
  let dropped = 0
  bot._client.write = (name, params) => {
    if (typeof name === 'string' && name.startsWith('position')) { dropped++; return undefined }
    return write(name, params)
  }
  process.on('exit', () => { if (dropped) console.log(`  (dropped ${dropped} outgoing position packet(s))`) })

  // Physics OFF, before the first tick.
  //
  // The first bot that got this far was kicked one second after its command
  // with "Invalid move player packet received": mineflayer's physics loop sends
  // position updates, those updates are being translated between two protocol
  // versions by ViaVersion, and Paper's move validation rejected the result. It
  // had already left by the time the plugin answered.
  //
  // This client has no reason to move. It is here to run commands and read its
  // own inventory, so the whole class of problem goes away rather than being
  // tuned around with moved-wrongly-threshold on the server.
  bot.physicsEnabled = false

  bot.on('messagestr', (message) => { chat.push(message) })
  bot.on('kicked', (reason) => { failure = failure ?? new Error(`kicked: ${JSON.stringify(reason)}`) })
  bot.on('error', (e) => { failure = failure ?? e })
  bot.on('end', (reason) => { disconnected = disconnected ?? (reason || 'connection ended') })

  // A bot that cannot connect must fail loudly. The protocol hop through
  // ViaVersion is the one step here that depends on nothing in this repository,
  // so a silent skip would turn this whole check into decoration.
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (bot.entity) { clearInterval(tick); resolve() }
      else if (failure) { clearInterval(tick); reject(failure) }
      else if (Date.now() - started > SPAWN_TIMEOUT_MS) {
        clearInterval(tick)
        reject(new Error(`the client never spawned within ${SPAWN_TIMEOUT_MS / 1000}s`))
      }
    }, 250)
  })

  check('a headless client joined the server', true, `as ${bot.username}, protocol ${runtime.bot.protocol}`)

  const carrying = () => bot.inventory.items()
    .filter((i) => i.name === ITEM)
    .reduce((n, i) => n + i.count, 0)

  const say = async (command, expect, ms = 45000) => {
    chat = []
    console.log(`\n  > ${command}`)
    bot.chat(command)
    try {
      await until(() => chat.some((m) => expect.test(m)), ms, `a reply matching ${expect}`)
    } catch (e) {
      console.log(chat.map((m) => '      ' + m).join('\n'))
      throw e
    }
    for (const line of chat) console.log('    ' + line)
    return chat
  }

  await say(`/nearcraft link ${TOKEN}`, /signed in as|refused/, 30000)
  check('the player signed in from inside the game', chat.some((m) => /signed in as/.test(m)),
    chat.find((m) => /signed in as/.test(m)) ?? '')

  await say('/wallet', /credit /, 30000)

  const before = carrying()
  const chainBefore = await chainHolding()
  console.log(`\n  before: carrying ${before} ${ITEM}, chain says ${chainBefore}`)

  // ---------------------------------------------------------------- buying
  await say(`/buy ${MERCHANT} ${ITEM} ${COUNT}`, /settled on NEAR|refused/)
  const bought = chat.find((m) => /settled on NEAR/.test(m))
  check('the purchase settled on NEAR', Boolean(bought), bought ?? chat.join(' | '))
  const buyDelta = chat.find((m) => /balance moved by/.test(m)) ?? ''
  check('the player paid no gas for it', /moved by 0\b/.test(buyDelta), buyDelta.trim())

  if (bought) {
    // THE assertion this whole script exists for: a real PlayerInventory.
    await until(() => carrying() >= before + COUNT, 20000, 'the ingot to arrive in the inventory')
      .then(() => check(`the ${ITEM} arrived in a real player inventory`, true,
        `${before} -> ${carrying()}`))
      .catch(() => check(`the ${ITEM} arrived in a real player inventory`, false,
        `still ${carrying()}, expected ${before + COUNT}`))

    // The game against the ledger, as DELTAS.
    //
    // Not as totals: the first version of this check compared them directly and
    // failed with "chain 1, carrying 0" — correctly, because the NEAR account is
    // shared with the browser client and earlier console runs and already owned
    // an ingot, while a player entity in a fresh world starts empty. The chain
    // is the ledger of record and the inventory is one view of it; what has to
    // agree is how much each of them MOVED.
    const chainAfterBuy = await chainHolding()
    check('the purchase moved the chain and the inventory by the same amount',
      chainAfterBuy - chainBefore === carrying() - before,
      `chain ${chainBefore} -> ${chainAfterBuy}, carrying ${before} -> ${carrying()}`)
  }

  // --------------------------------------------------------------- selling
  const heldBeforeSale = carrying()
  await say(`/sell ${MERCHANT} ${ITEM} ${COUNT}`, /settled on NEAR|refused|carrying/)
  const sold = chat.find((m) => /settled on NEAR/.test(m))
  check('the sale settled on NEAR', Boolean(sold), sold ?? chat.join(' | '))

  if (sold) {
    await until(() => carrying() <= heldBeforeSale - COUNT, 20000, 'the ingot to leave the inventory')
      .then(() => check(`the ${ITEM} left the inventory when sold`, true,
        `${heldBeforeSale} -> ${carrying()}`))
      .catch(() => check(`the ${ITEM} left the inventory when sold`, false,
        `still ${carrying()}, expected ${heldBeforeSale - COUNT}`))
  }

  // And the same for the sale, which closes the loop: whatever the inventory
  // gave up, the ledger gave up too.
  if (sold) {
    const chainAfterSale = await chainHolding()
    check('the sale moved the chain and the inventory by the same amount',
      chainAfterSale - chainBefore === carrying() - before,
      `chain ${chainBefore} -> ${chainAfterSale}, carrying ${before} -> ${carrying()}`)
  }
} catch (e) {
  console.error(`\n  ${e.message}`)
  check('the run completed', false, e.message)
  console.error('\n  last server lines:')
  console.error(serverLines.slice(-15).map((l) => '    ' + l).join('\n'))
} finally {
  try { bot?.quit?.() } catch { /* already gone */ }
  server.stdin.write('stop\n')
  await new Promise((resolve) => {
    server.on('close', resolve)
    setTimeout(() => { server.kill('SIGKILL'); resolve() }, 40000)
  })
  log.end()
}

/**
 * What the CHAIN says this player holds.
 *
 * <p>Signs in over HTTP rather than scraping the bot's chat, because the
 * plugin deliberately never prints a session id: it is bearer authority over
 * the account. Signing in again is idempotent for an existing player and
 * derives the same account id from the same login, so this reads the same
 * player the bot is acting as.
 */
/** How many of the traded item the CHAIN says this player holds, as a number. */
async function chainHolding() {
  const me = await chainHoldings()
  return Number(me?.holdings?.[ITEM] ?? '0')
}

async function chainHoldings() {
  try {
    const signIn = await fetch(`${SERVICE}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
      signal: AbortSignal.timeout(30000),
    })
    if (!signIn.ok) return null
    const { sessionId } = await signIn.json()
    const me = await fetch(`${SERVICE}/api/me?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(30000) })
    return me.ok ? await me.json() : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------- the verdict
const passed = findings.filter((f) => f.ok).length
const failed = findings.filter((f) => !f.ok).length

console.log('\n=== result ===')
for (const f of findings) console.log(`  ${f.ok ? 'ok  ' : 'FAIL'}  ${f.what}`)
console.log(`\n  ${passed} passed, ${failed} failed`)
console.log(`  log  ${logPath}`)

if (failed === 0) {
  const record = {
    note: 'A headless Minecraft client — a bot, not a person — joined a Paper server, signed in '
      + 'with a social-style login, bought iron and received the ingot in a real PlayerInventory, '
      + 'then sold it back. Every write was relayed, so the player paid no gas. The server ran '
      + 'online-mode=false because a headless client has no Mojang account; npm run mc:server, '
      + 'which is the documented way to run this, keeps online-mode=true.',
    recorded_at: new Date().toISOString(),
    network: service?.network ?? 'testnet',
    paper: `${runtime.artifacts.paper.version} build ${runtime.artifacts.paper.build}`,
    client: `mineflayer ${runtime.bot.mineflayer} speaking ${runtime.bot.protocol} through ViaVersion ${runtime.artifacts.ViaVersion.version}`,
    username: USERNAME,
    online_mode: false,
    checks: findings,
  }
  await mkdir(new URL('evidence/live/', ROOT), { recursive: true })
  await writeFile(new URL('evidence/live/minecraft-player.json', ROOT), JSON.stringify(record, null, 2) + '\n')
  console.log('  retained  evidence/live/minecraft-player.json')
}

process.exit(failed === 0 ? 0 : 1)
