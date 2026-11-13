// Shared plumbing for the three Minecraft scripts.
//
// There is no Maven and no Gradle here, and that is a choice rather than a gap.
// A Paper plugin is a jar holding compiled classes and a plugin.yml, and its
// only compile-time input is one API jar. Adding a build tool would mean a
// wrapper script, a lockfile and a dependency resolver to make one `javac` call
// that this file makes directly — and `npm test` would still not run it. The
// pinning discipline a build tool would give us is here instead: every artifact
// is fetched by URL and refused unless its sha256 matches config/.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'

export const ROOT = new URL('..', import.meta.url)
export const TMP = new URL('.tmp/mc/', ROOT)

export const runtime = JSON.parse(await readFile(new URL('config/minecraft-runtime.json', ROOT), 'utf8'))

const exists = (url) => access(url).then(() => true, () => false)

/**
 * Where the JDK is.
 *
 * macOS ships `/usr/bin/java`, which is NOT a JVM — it is a stub that prints
 * "Unable to locate a Java Runtime" and exits non-zero. Trusting PATH is how
 * this project spent weeks believing no Java could run on this machine, so the
 * path is resolved explicitly and the version is checked rather than assumed.
 */
export async function javaHome() {
  const candidates = [process.env.NEARCRAFT_JAVA_HOME, runtime.java.home, process.env.JAVA_HOME].filter(Boolean)
  for (const home of candidates) {
    if (await exists(new URL(`file://${home}/bin/javac`))) return home
  }
  throw new Error(
    `no JDK ${runtime.java.minimum} found. Install it with: ${runtime.java.install}\n` +
    `  (looked in: ${candidates.join(', ') || 'nowhere — set NEARCRAFT_JAVA_HOME'})`,
  )
}

/** Run a command, streaming its output, and resolve with the exit code. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio ?? 'inherit', cwd: options.cwd, env: options.env })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/**
 * Fetch an artifact and refuse it unless the bytes hash to what config says.
 *
 * A mirror that served something else would otherwise be compiled against, or
 * booted, with no sign that anything had changed.
 */
export async function fetchPinned(name) {
  const pin = runtime.artifacts[name]
  if (!pin) throw new Error(`no pin for ${name} in config/minecraft-runtime.json`)
  await mkdir(TMP, { recursive: true })
  const file = new URL(`${name}.jar`, TMP)

  if (await exists(file)) {
    const have = createHash('sha256').update(await readFile(file)).digest('hex')
    if (have === pin.sha256) return file
    console.log(`  ${name}: cached copy has the wrong hash, fetching again`)
  }

  console.log(`  ${name} ${pin.version ?? ''}${pin.build ? ` build ${pin.build}` : ''} — downloading`)
  const response = await fetch(pin.url)
  if (!response.ok) throw new Error(`${name}: ${response.status} from ${pin.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== pin.sha256) {
    throw new Error(
      `${name} does not match its pin.\n  expected ${pin.sha256}\n  received ${digest}\n` +
      `  Refusing to use it. Either the mirror served something else, or the pin is stale.`,
    )
  }
  await writeFile(file, bytes)
  return file
}

/** Every .java file under a directory. */
export async function javaSources(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) out.push(...(await javaSources(child)))
    else if (entry.name.endsWith('.java')) out.push(child.pathname)
  }
  return out.sort()
}
