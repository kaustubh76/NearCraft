// Compile and run the plugin's Java checks.
//
//   npm run mc:test
//
// No Minecraft and no NEAR: PlayClient holds no Bukkit types precisely so the
// transport can be proven on its own, against a stub HTTP server, in about a
// second. What is left to find on a real server is whether the plugin loads —
// which is what npm run mc:server is for.

import { mkdir, rm } from 'node:fs/promises'
import { fetchPinned, javaHome, javaSources, run, ROOT, TMP, runtime } from './mc-java.mjs'

const MAIN = new URL('minecraft/src/main/java/', ROOT)
const TEST = new URL('minecraft/src/test/java/', ROOT)
const CLASSES = new URL('test-classes/', TMP)

// `npm test` runs this with --optional so a clone with no JDK is told rather
// than failed: every other check in this repository needs neither Java nor a
// network, and breaking that for a plugin would be the wrong trade. Run
// `npm run mc:test` directly and a missing JDK is an error, because then you
// asked for it specifically.
const optional = process.argv.includes('--optional')
let home
try {
  home = await javaHome()
} catch (e) {
  if (!optional) throw e
  console.log(`\n  skipping the Minecraft plugin checks: ${e.message.split('\n')[0]}`)
  console.log('  everything else in `npm test` needs no JDK.\n')
  process.exit(0)
}

const classpath = []
for (const name of runtime.compileClasspath) classpath.push((await fetchPinned(name)).pathname)

await rm(CLASSES, { recursive: true, force: true })
await mkdir(CLASSES, { recursive: true })

// Main and test sources are compiled together rather than against the built
// jar, so a test cannot pass against a stale build of the thing it is testing.
const sources = [...(await javaSources(MAIN)), ...(await javaSources(TEST))]

const compiled = await run(`${home}/bin/javac`, [
  '--release', String(runtime.java.minimum),
  '-proc:none',
  '-Xlint:all,-classfile',
  '-classpath', classpath.join(':'),
  '-d', CLASSES.pathname,
  ...sources,
])
if (compiled !== 0) { console.error('\n  compile FAILED'); process.exit(1) }

const status = await run(`${home}/bin/java`, [
  '-classpath', [CLASSES.pathname, ...classpath].join(':'),
  'org.nearcraft.mc.Harness',
])
process.exit(status)
