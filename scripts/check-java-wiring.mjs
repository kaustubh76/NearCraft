// Is every Java method in the plugin actually reachable, and is it checked?
//
//   npm run check:java-wiring   (and it runs inside `npm test`)
//
// Why this exists. "Fully wired" is a claim, and claims rot. The plugin has
// already shipped a method that was written, tested and called by nothing
// (`PlayClient.invest`, until `/invest` existed) and a subcommand that worked
// but appeared in neither the usage string nor the help text. Both were found
// by reading, which does not scale and does not run in CI.
//
// Two properties, both enforced:
//
//   1. REACHABLE  — every method has a caller, or is a lifecycle method the
//                   server calls (@Override, @EventHandler, main).
//   2. CHECKED    — every method is referenced by a test, unless it is on the
//                   allowlist below with a reason. The allowlist is checked in
//                   BOTH directions: an entry that has since become tested is a
//                   failure too, because a stale exemption is how a coverage
//                   gap becomes permanent.
//
// Text analysis, so it needs no JDK and runs with everything else.

import { readFile, readdir } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url)
const MAIN = new URL('minecraft/src/main/java/', ROOT)
const TEST = new URL('minecraft/src/test/java/', ROOT)

/// Methods that cannot be referenced from an offline test, with the reason.
/// Every one of these needs a live Bukkit server, which is what
/// `/nearcraft inventory-selftest` and `npm run mc:bot` are for.
const UNTESTABLE_OFFLINE = {
  'Items.materialFor': 'Material.matchMaterial needs the server registry; covered by inventory-selftest',
  'Items.held': 'takes a Bukkit Inventory; covered by inventory-selftest',
  'Items.take': 'takes a Bukkit Inventory; covered by inventory-selftest',
  'Items.give': 'takes a Bukkit Inventory; covered by inventory-selftest',
  'Items.giveOrDrop': 'needs a Player and a World; covered by npm run mc:bot',
  'NearCraftPlugin.onEnable': 'Bukkit lifecycle',
  'NearCraftPlugin.onDisable': 'Bukkit lifecycle',
  'NearCraftPlugin.onQuit': 'Bukkit event dispatch',
  'NearCraftPlugin.onCommand': 'Bukkit command dispatch; covered by mc:server and mc:bot',
}

/// Called by the server, not by us, so "no caller" is correct for these.
const LIFECYCLE = /@Override|@EventHandler/

const failures = []
const fail = (what) => failures.push(what)

async function javaFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) out.push(...(await javaFiles(child)))
    else if (entry.name.endsWith('.java')) out.push(child)
  }
  return out
}

/// A method declaration, loosely. Java is not parsed here — the point is to
/// catch a method nobody calls, and a regex that occasionally misses one is far
/// better than no check at all. False positives would be the problem, so the
/// filters below are deliberately generous.
const DECL = /^[ \t]{2,}(?!private\b)(?:(?:public|protected|static|final|synchronized|abstract|default)\s+)*[\w$<>\[\],.?\s]+?\s+(\w+)\s*\([^;{]*\)\s*(?:throws\s+[\w\s,.]+)?\{/
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'try', 'do', 'else', 'return', 'new', 'synchronized'])

const mainFiles = await javaFiles(MAIN)
const testFiles = await javaFiles(TEST)
const mainText = new Map()
for (const f of mainFiles) mainText.set(f.pathname, await readFile(f, 'utf8'))
let testText = ''
for (const f of testFiles) testText += await readFile(f, 'utf8') + '\n'

/// A class nobody outside the file can reach. Methods inside one are private by
/// enclosure however they are spelled, so they are not part of the surface this
/// check is about — Json's recursive-descent `Reader` is eight of them.
const PRIVATE_CLASS = /^[ \t]*private\s+(?:static\s+)?(?:final\s+)?class\s+\w+/

const methods = []
for (const [path, text] of mainText) {
  const className = path.split('/').pop().replace('.java', '')
  const lines = text.split('\n')
  // Brace depth, and the depth at which a private nested class opened. While
  // inside one, declarations are skipped.
  let depth = 0
  let privateFrom = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (privateFrom === null && PRIVATE_CLASS.test(line)) privateFrom = depth

    const m = line.match(DECL)
    const name = m?.[1]
    if (m && privateFrom === null && !NOT_A_METHOD.has(name) && name !== className) {
      // The annotation sits on the preceding non-blank line.
      let before = ''
      for (let j = i - 1; j >= 0 && j > i - 4; j--) {
        if (lines[j].trim()) { before = lines[j]; break }
      }
      methods.push({ className, name, key: `${className}.${name}`, path, lifecycle: LIFECYCLE.test(before) })
    }

    // Strip string AND char literals before counting braces. Json's parser is
    // full of `case '{':` and `'}'`, and counting those closed the private
    // class early enough to report two of its methods as public surface.
    const code = line.replace(/"(?:[^"\\\\]|\\\\.)*"/g, '""').replace(/'(?:[^'\\\\]|\\\\.)*'/g, "''")
    for (const ch of code) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (privateFrom !== null && depth <= privateFrom) privateFrom = null
      }
    }
  }
}

if (methods.length === 0) fail('found no method declarations at all — the parser is broken, not the code')

/// A constructor or nested type, by Java convention: methods are camelCase and
/// start lowercase. These are referenced without a paren — `catch (Json.JsonException e)`
/// — so looking for `name(` misses every one of them.
const isType = (name) => /^[A-Z]/.test(name)

const uses = (name, text, ownFile) => {
  // Occurrences of `name(` minus the declarations themselves.
  //
  // The declaration count must use the SAME pattern that found the method. An
  // earlier version matched any indented line mentioning the name, which also
  // matched every recursive call and drove the count to zero — reporting eight
  // live methods as dead.
  const pattern = isType(name) ? `\\b${name}\\b` : `\\b${name}\\s*\\(`
  const calls = (text.match(new RegExp(pattern, 'g')) ?? []).length
  if (!ownFile) return calls
  const decls = text.split('\n').filter((l) => l.match(DECL)?.[1] === name).length
  return calls - decls
}

for (const method of methods) {
  const inOwnFile = uses(method.name, mainText.get(method.path), true)
  let elsewhere = 0
  for (const [path, text] of mainText) {
    if (path === method.path) continue
    elsewhere += uses(method.name, text, false)
  }
  const inTests = uses(method.name, testText, false)

  // 1. reachable FROM PRODUCTION CODE.
  //
  // Counting test references here would have missed the case this check exists
  // for: `PlayClient.invest` was written, tested and called by nothing until
  // `/invest` existed. A method only its own test calls is dead production
  // code wearing a passing test.
  if (!method.lifecycle && inOwnFile + elsewhere === 0) {
    fail(`${method.key} has no caller in minecraft/src/main — dead code, or a missing call site`
      + (inTests > 0 ? ' (its only references are in tests)' : ''))
  }

  // 2. checked, or allowlisted with a reason
  const exempt = Object.hasOwn(UNTESTABLE_OFFLINE, method.key)
  if (inTests === 0 && !exempt) {
    fail(`${method.key} has no reference in any test. Add one, or add it to UNTESTABLE_OFFLINE with the reason.`)
  }
  if (inTests > 0 && exempt) {
    fail(`${method.key} IS referenced by a test but is still listed as untestable offline — remove the stale exemption`)
  }
}

// The allowlist must not name methods that no longer exist.
const known = new Set(methods.map((m) => m.key))
for (const key of Object.keys(UNTESTABLE_OFFLINE)) {
  if (!known.has(key)) fail(`UNTESTABLE_OFFLINE names ${key}, which is not a method any more`)
}

console.log(`\n  ${methods.length} method(s) across ${mainFiles.length} class(es); ` +
  `${Object.keys(UNTESTABLE_OFFLINE).length} exempt from offline testing, each with a reason`)

if (failures.length === 0) {
  console.log('  every Java method is reachable and checked\n')
  process.exit(0)
}
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log(`\n  ${failures.length} problem(s)\n`)
process.exit(1)
