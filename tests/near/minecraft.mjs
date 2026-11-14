// What the Minecraft server becomes, and who a record says played it.
//
// These cover scripts/mc-java.mjs rather than scripts/mc-server.mjs, because
// that file has a top-level `await fetch` and a `spawn`: importing it boots a
// Paper server. The three functions under test were split out of it for
// exactly that reason, the same way backend/near/deployment.mjs was split out
// of scripts/serve-play.mjs.
//
// Offline, no JDK, no network, no Minecraft.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { serverProperties, protocolBridge, typistNote, runtime, ROOT } from '../../scripts/mc-java.mjs'

const WORLD = runtime.world

/// server.properties is a flat key=value file, so read it back as one rather
/// than substring-matching: `online-mode=true` is a substring of nothing, but
/// `white-list=false` is a substring of a line that could just as well have
/// said something else, and a test that passes on a coincidence is worse than
/// no test.
const props = (opts) => Object.fromEntries(
  serverProperties({ port: '25565', world: WORLD, ...opts })
    .split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    }),
)

// ------------------------------------------------------- the default posture

test('a default run keeps Mojang authentication on', async () => {
  // The flag is opt-in and this is the half that says so. A demo is not a
  // reason to turn authentication off for everybody who runs this.
  const p = props({})
  assert.equal(p['online-mode'], 'true')
  assert.equal(p['server-ip'], undefined,
    'a default run must not pin the bind address — only the offline branch does')
  assert.equal(p['white-list'], undefined)
})

// --------------------------------------------------------- --offline, and the
//                                                           coupling that
//                                                           makes it safe

test('authentication is never turned off without binding to loopback', async () => {
  // THE SECURITY PROPERTY, and the reason serverProperties exists at all.
  //
  // scripts/mc-server.mjs wrote no `server-ip`, so Paper bound the wildcard
  // address. `online-mode=false` on a wildcard bind is an unauthenticated
  // Minecraft server on whatever network the laptop is attached to, where any
  // client may assert any username. The two settings are therefore one branch,
  // and this asserts it over BOTH modes so a one-sided change cannot satisfy
  // it: whenever authentication is off, the bind must be loopback.
  for (const offline of [false, true]) {
    const p = props({ offline })
    if (p['online-mode'] === 'false') {
      assert.equal(p['server-ip'], '127.0.0.1',
        'authentication is OFF and the server is not bound to loopback — any machine '
        + 'on this network could join as any username')
    }
  }
  // And that the offline branch really does reach that state, so the loop above
  // is not vacuously satisfied by never seeing `false`.
  assert.equal(props({ offline: true })['online-mode'], 'false')
})

test('--offline writes every property Paper needs to let a non-premium client in', async () => {
  // All five, because Paper rejects such a client at a different gate for each
  // one and the first four were each learned by scripts/mc-bot.mjs the hard
  // way. `white-list` is the one that was true on disk while this went
  // unwritten: the server directory held `white-list=true` beside an empty
  // whitelist.json, so a joining human was told "You are not whitelisted on
  // this server!".
  const p = props({ offline: true })
  assert.equal(p['online-mode'], 'false')
  assert.equal(p['server-ip'], '127.0.0.1')
  assert.equal(p['enforce-secure-profile'], 'false', 'an offline client carries no signed profile')
  assert.equal(p['white-list'], 'false')
  assert.equal(p['enforce-whitelist'], 'false')
})

test('--offline changes who may join and nothing about the world', async () => {
  // The seed is pinned so /nearcraft world-selftest is a statement about a
  // known place. A flag about authentication that moved the world would make
  // that answer mean something different without saying so.
  const on = props({})
  const off = props({ offline: true })
  for (const key of ['level-type', 'level-seed', 'level-name', 'gamemode', 'difficulty', 'motd']) {
    assert.equal(off[key], on[key], `--offline changed ${key}`)
  }
})

test('the world type survives .properties escaping', async () => {
  // An unescaped colon ends the key in a .properties file, so `minecraft:normal`
  // would silently become a different world type — and the economy trades eight
  // materials that a superflat world contains none of.
  assert.equal(props({})['level-type'], 'minecraft\\:normal')
})

test('the server advertises the MOTD check:hosted looks for', async () => {
  // Two hand-written strings that nothing compared: the MOTD this writes, and
  // the one scripts/check-hosted.mjs asserts a Server List Ping comes back
  // with. If they drift, the hosted check fails against a server that is
  // perfectly fine, or passes against one that is not this one.
  const hosting = JSON.parse(await readFile(new URL('config/hosting.json', ROOT), 'utf8'))
  const want = hosting.minecraft?.expect_motd
  assert.ok(want, 'config/hosting.json should name the MOTD the ping expects')
  assert.ok(props({}).motd.startsWith(want),
    `motd ${JSON.stringify(props({}).motd)} does not start with expect_motd ${JSON.stringify(want)}`)
})

// ------------------------------------------------------- the protocol bridge

test('every protocol-bridge plugin is pinned by hash, and none still claims to be bot-only', async () => {
  // The bridge is what lets a client that is not on 26.3 connect, which is
  // every client a person can actually launch. It is installed on both servers
  // now, so the `use` note that said "bot runs only" became false — and a
  // comment asserting something this repository does not do is a bug here, not
  // a stale aside. Asserted rather than remembered.
  const names = protocolBridge()
  assert.ok(names.length >= 2, 'ViaVersion alone bridges upward; ViaBackwards is what reaches older clients')
  for (const name of names) {
    const pin = runtime.artifacts[name]
    assert.ok(pin, `${name} has no pin in config/minecraft-runtime.json`)
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${name} has no sha256`)
    assert.ok(pin.url.startsWith('https://'), `${name} would be fetched over ${pin.url}`)
    assert.doesNotMatch(pin.use, /bot runs? only/i,
      `${name}'s note still says it is installed for the bot only, which the human server made false`)
  }
})

// ------------------------------------------------------- who played the game

test('a run no client joined says the console issued the commands', async () => {
  const transcript = [
    '[12:00:00 INFO]: [NearCraft] Enabling NearCraft v0.1.0',
    '[12:00:05 INFO]: signed in as p-7b1d6bbacf2fdb5e.nearcraftmc.testnet',
    '[12:00:09 INFO]: settled on NEAR with Ironmonger (ironmonger)  tx ABC123',
  ].join('\n')
  const note = typistNote(transcript, { offline: false })
  assert.match(note, /server console/)
  assert.doesNotMatch(note, /typed in chat/)
})

test('a run a person joined names them and does not claim the console did it', async () => {
  // The record this feeds is the artifact offered as proof that a human played.
  // If the sentence inside it says the console did, the proof refutes itself.
  //
  // These are Paper's real line shapes; the fixture is replaced with the
  // captured lines from .tmp/mc/mc-server.log once a session has been played.
  const transcript = [
    '[12:00:00 INFO]: UUID of player Ruddy is 1e8f0b3a-0000-3000-8000-000000000000',
    '[12:00:01 INFO]: Ruddy[/127.0.0.1:54213] logged in with entity id 42 at (...)',
    '[12:00:01 INFO]: Ruddy joined the game',
    '[12:00:30 INFO]: Ruddy issued server command: /buy ironmonger iron_ingot 1',
    '[12:00:34 INFO]: settled on NEAR with Ironmonger (ironmonger)  tx ABC123',
  ].join('\n')
  const note = typistNote(transcript, { offline: true })
  assert.match(note, /typed in chat by Ruddy/)
  assert.doesNotMatch(note, /server console/,
    'a human-played record must not say the console issued the commands')
  // And the limit of what an offline join proves, stated in the record itself
  // rather than left for a reader to work out.
  assert.match(note, /a person played, not which person/)
})

test('an authenticated join is not described as self-asserted', async () => {
  const transcript = '[12:00:30 INFO]: Ruddy issued server command: /wallet'
  const note = typistNote(transcript, { offline: false })
  assert.match(note, /Mojang account/)
  assert.doesNotMatch(note, /self-asserted/)
})
