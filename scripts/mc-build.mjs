// Build the Minecraft plugin: fetch the pinned Paper API, compile, jar.
//
//   npm run mc:build
//
// Output lands in .tmp/mc/, which is disposable and gitignored. The jar is a
// build artifact and is never committed — a repository that ships a jar is
// asking to be read as the thing it claims to build.

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { fetchPinned, javaHome, javaSources, run, ROOT, TMP, runtime } from './mc-java.mjs'

const SRC = new URL('minecraft/src/main/java/', ROOT)
const RESOURCES = new URL('minecraft/src/main/resources/', ROOT)
const CLASSES = new URL('classes/', TMP)
const JAR = new URL('NearCraft.jar', TMP)

console.log('\n=== NearCraft plugin ===\n')

const home = await javaHome()
const javac = `${home}/bin/javac`
const jar = `${home}/bin/jar`

// Say which JDK, because "it compiled" means nothing without it: the plugin
// must be class-file compatible with a server that refuses anything below 25.
const version = await run(javac, ['-version'], { stdio: 'inherit' })
if (version !== 0) throw new Error(`${javac} -version failed`)

// Paper's API jar alone is not enough to compile against: javac has to resolve
// the supertypes of what this plugin extends, and those reach into Adventure.
// Each extra jar is pinned by hash like the rest, and none of them is shipped —
// they are compile-time only, because the server already has them.
const classpath = []
for (const name of runtime.compileClasspath) classpath.push((await fetchPinned(name)).pathname)

await rm(CLASSES, { recursive: true, force: true })
await mkdir(CLASSES, { recursive: true })

const sources = await javaSources(SRC)
console.log(`\n  compiling ${sources.length} source file(s) against Paper ${runtime.artifacts['paper-api'].version}`)

const compiled = await run(javac, [
  '--release', String(runtime.java.minimum),
  // Annotation processing is not used and running it would let a jar on the
  // classpath execute code at build time.
  '-proc:none',
  // Guava's errorprone annotations are not on the classpath and do not need to be;
  // -classfile silences eight warnings about them so a real one would stand out.
  '-Xlint:all,-classfile',
  '-classpath', classpath.join(':'),
  '-d', CLASSES.pathname,
  ...sources,
])
if (compiled !== 0) { console.error('\n  compile FAILED'); process.exit(1) }

// Resources (plugin.yml, config.yml) are jarred from their own tree rather
// than copied into the class output, so the sources stay the only thing in
// minecraft/src that a reader has to look at twice.
const resources = await readdir(RESOURCES)
const packed = await run(jar, [
  '--create', '--file', JAR.pathname,
  '-C', CLASSES.pathname, '.',
  '-C', RESOURCES.pathname, '.',
])
if (packed !== 0) { console.error('\n  jar FAILED'); process.exit(1) }

const size = (await stat(JAR)).size
console.log(`\n  built ${JAR.pathname}`)
console.log(`  ${(size / 1024).toFixed(1)} KiB, ${sources.length} classes, resources: ${resources.join(', ')}`)
console.log(`\n  it holds no keys and no chain code — every write goes to the play service.\n`)
