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
/// Ask javac what it is. Captured rather than inherited, because the answer is
/// the thing being checked.
///
/// Printed to stdout by modern JDKs and to stderr by older ones, so both are
/// read. A JDK that cannot say its own version is not usable here.
function javacVersion(home) {
  return new Promise((resolve) => {
    const child = spawn(`${home}/bin/javac`, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const major = text.match(/javac\s+(\d+)/)?.[1]
      resolve(major ? Number(major) : null)
    })
  })
}

let resolvedHome = null

export async function javaHome() {
  if (resolvedHome) return resolvedHome

  // An explicit NEARCRAFT_JAVA_HOME is AUTHORITATIVE. Falling through to a
  // different JDK when the one someone named is unusable looks helpful and is
  // not: they set a variable, the build used something else, and nothing said
  // so. The first version of this check did exactly that, which is why
  // pointing it at openjdk@11 still passed and the check looked like it worked.
  const forced = process.env.NEARCRAFT_JAVA_HOME
  if (forced) {
    if (!await exists(new URL(`file://${forced}/bin/javac`))) {
      throw new Error(`NEARCRAFT_JAVA_HOME=${forced} has no bin/javac.`)
    }
    const major = await javacVersion(forced)
    if (major === null || major < runtime.java.minimum) {
      throw new Error(
        `NEARCRAFT_JAVA_HOME=${forced} is javac ${major ?? 'unreadable'}, and this needs `
        + `${runtime.java.minimum} or newer.\n  Unset it to use ${runtime.java.home}, or install: `
        + `${runtime.java.install}`,
      )
    }
    resolvedHome = forced
    return forced
  }

  const candidates = [runtime.java.home, process.env.JAVA_HOME].filter(Boolean)
  const found = []
  for (const home of candidates) {
    if (!await exists(new URL(`file://${home}/bin/javac`))) continue
    // The version, not merely the file. This function's own doc comment has
    // claimed "the version is checked rather than assumed" since it was
    // written, and it was not: anything with a bin/javac was accepted. Both
    // openjdk@11 and openjdk@25 are installed on the machine this was written
    // on, so a path to openjdk@11 was taken happily and failed two steps later
    // with `release version 25 not supported` — an error about a flag, for a
    // problem with a path.
    const major = await javacVersion(home)
    if (major !== null && major >= runtime.java.minimum) {
      resolvedHome = home
      return home
    }
    found.push(`${home} (javac ${major ?? 'unreadable'})`)
  }
  throw new Error(
    `no JDK ${runtime.java.minimum} or newer found. Install it with: ${runtime.java.install}\n` +
    (found.length
      ? `  too old, or unreadable: ${found.join(', ')}\n`
      : '') +
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
  // A bare fetch with no timeout HANGS on a network that black-holes rather
  // than refuses, which is the common failure on a hotel or captive-portal
  // connection: the run stops with no output and no error, and looks like a
  // slow download of a 53 MiB jar. Two minutes is generous for the largest
  // artifact here and finite, which is the point.
  let response
  try {
    response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) })
  } catch (e) {
    throw new Error(`${name}: could not be fetched from ${pin.url}\n  ${e?.message ?? e}`)
  }
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
