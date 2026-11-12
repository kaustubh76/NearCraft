// Does the documentation describe a repository that exists?
//
// Stage-1 judging is an AI reading these documents and running what they say.
// Twice in this project a document has told a reader to run a command that
// failed on line one (npm run sim, npm run test:sandbox — no root Cargo.toml),
// and twice a document has described something that was not true (GAME_LOOP.md
// claiming the simulation ran against deployed testnet contracts). Both classes
// are mechanically checkable, so they get checked rather than re-read.
//
// Deliberately offline and dependency-free.
import { readFile, readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const DOCS = ['README.md', 'AGENTS.md', 'GAME_LOOP.md', 'RULES.md', 'BASELINE.md',
              'docs/GASLESS.md', 'docs/SECURITY_SIGNALS.md', 'docs/PROVENANCE.md',
              'docs/RECAPITALIZATION.md']

const failures = []
const fail = (doc, what) => failures.push(`${doc}: ${what}`)
const exists = async (rel) => access(new URL(rel, ROOT)).then(() => true, () => false)

/// Is this mention of `path` a DENIAL that it exists, rather than a claim?
///
/// Mirrors the quotation escape hatch rule 5 uses. A document that says "there
/// is no `plugin/` directory" is doing the right thing, and a path rule that
/// punished it would push the honest wording out of the docs — which is the
/// opposite of the point. Keep the window tight so a denial has to sit beside
/// the mention, not merely somewhere in the file.
const DENIAL = /there is no|does not exist|is not ported|was never|never built|no such|no part of it|not vendored|no Java in this repos/i
function deniesExistence(text, index) {
  return DENIAL.test(text.slice(Math.max(0, index - 300), index + 300))
}

/// Resolve a link the way a reader's browser would: relative to the document it
/// appears in, not to the repository root. Getting this wrong made this very
/// check report four false failures against docs/SECURITY_SIGNALS.md.
const existsFrom = async (doc, rel) =>
  access(new URL(rel, new URL(doc, ROOT))).then(() => true, () => false)

/// Directories .gitignore excludes are legitimately absent from a clone, so the
/// docs may describe them without lying.
///
/// This is not hypothetical tidiness: the first fresh-clone rehearsal of this
/// repository failed on its very first command, `npm test`, because rule 6
/// flagged `.local/` — the gitignored directory that holds deploy keys, which
/// by design never exists in a clone. A judge would have hit that before
/// reading anything else.
const ignored = await (async () => {
  try {
    const text = await readFile(new URL('.gitignore', ROOT), 'utf8')
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => l.replace(/^\/+/, '').replace(/\/+$/, ''))
  } catch {
    return []
  }
})()
const isIgnored = (dir) => {
  const clean = dir.replace(/\/+$/, '')
  return ignored.some((pat) => clean === pat || clean.startsWith(`${pat}/`) || pat.startsWith(`${clean}/`))
}

const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'))
const scripts = new Set(Object.keys(pkg.scripts))

let commandsChecked = 0
let linksChecked = 0

for (const doc of DOCS) {
  if (!(await exists(doc))) { fail(doc, 'listed here but missing from the repository'); continue }
  const text = await readFile(new URL(doc, ROOT), 'utf8')

  // 1. Every `npm run X` must name a script that exists.
  for (const m of text.matchAll(/npm run ([a-z0-9:-]+)/g)) {
    commandsChecked++
    if (!scripts.has(m[1])) fail(doc, `tells a reader to run "npm run ${m[1]}", which is not in package.json`)
  }

  // 2. Every relative markdown link must resolve. Anchors and URLs are skipped.
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    linksChecked++
    const path = target.split('#')[0]
    if (path && !(await existsFrom(doc, path))) fail(doc, `links to ${target}, which does not exist`)
  }

  // 3. Every backticked path that looks like a repository file must exist.
  //
  // This used to whitelist eight directory names, and that whitelist was the
  // entire reason a dangling `sim/fastforward.mjs` claim survived every run:
  // `sim/` was simply not in the list, so the rule never looked. Any
  // slash-containing backticked token is now a candidate. Measured against
  // these docs when the whitelist was dropped: one real failure, zero false
  // positives.
  for (const m of text.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9._/-]+)`/g)) {
    const path = m[1].replace(/[.,]$/, '')
    // Globs and directories-with-wildcards are descriptive, not paths.
    if (path.includes('*')) continue
    linksChecked++
    if (!(await exists(path)) && !deniesExistence(text, m.index)) {
      fail(doc, `names \`${path}\`, which does not exist`)
    }
  }

  // 6. A directory the docs describe must exist AND contain something.
  //
  // Rules 2 and 3 only ever asked "does this path exist". Two directories,
  // `sim/` and `plugin/`, existed and were empty while the README's
  // architecture block described their contents — a claim about work that was
  // not there, which is the exact failure this whole script exists to prevent.
  //
  // Two shapes are matched, because the architecture block is a fenced code
  // block and no backtick rule can see inside it: a backticked token ending in
  // `/`, and a line that starts with `dir/` followed by two or more spaces and
  // a description.
  for (const m of [
    ...text.matchAll(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9._-]+)*\/)`/g),
    ...text.matchAll(/^([a-z][A-Za-z0-9_.-]*\/)\s{2,}\S/gm),
  ]) {
    const dir = m[1]
    linksChecked++
    if (deniesExistence(text, m.index)) continue
    // Gitignored, so absent from a clone on purpose — see `ignored` above.
    if (isIgnored(dir)) continue
    if (!(await exists(dir))) { fail(doc, `describes the directory ${dir}, which does not exist`); continue }
    try {
      if ((await readdir(new URL(dir, ROOT))).length === 0) {
        fail(doc, `describes the contents of ${dir}, which is empty`)
      }
    } catch { /* not a directory; rules 2 and 3 already cover files */ }
  }
}

// 4. Every cargo invocation in package.json must say which workspace it means.
// There is no root Cargo.toml, so one that does not is broken for everyone.
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  if (!/\bcargo\b/.test(cmd)) continue
  commandsChecked++
  if (!cmd.includes('--manifest-path')) {
    fail('package.json', `script "${name}" runs cargo without --manifest-path; there is no root Cargo.toml`)
  }
}

// 5. The claims a document must NOT make, because they were once made and were
// false. A regression test for honesty, not for behaviour.
const RETIRED_CLAIMS = [
  { pattern: /week of trading compressed into about a minute/i,
    why: 'the simulation runs 135 transactions in ~24s; a week is about five minutes at that rate' },
  { pattern: /against the real deployed testnet contracts/i,
    why: 'npm run sim runs against a local sandbox, not the deployment' },
  { pattern: /simulation snapshot, not live chain data[\s\S]{0,200}Nothing is deployed/i,
    why: 'the contracts are deployed and the page reads them live' },
  // Retired by the claims audit. Each of these was in the docs and false.
  { pattern: /the diff is the new part/i,
    why: 'no Java is vendored here, so there is no plugin diff to point at' },
  { pattern: /and the sealed-bid round coordinator/i,
    why: 'the coordinator was never built and the swarms track is not entered' },
  { pattern: /read-only live market and round page/i,
    why: 'web/market.html has no round UI' },
  { pattern: /Approval Management extension, which did not fit/i,
    why: 'Approval Management is implemented and is what the player sell path uses' },
  { pattern: /which is why a scoped key cannot sell/i,
    why: 'a scoped key sells through the non-payable market.sell under an approval' },
  { pattern: /61 Rust unit tests/i,
    why: 'there are 90, across three contracts' },
  { pattern: /holds a function-call key, nothing more/i,
    why: 'an agent account also carries a disclosed operator full-access key; only the agent PROCESS holds just the scoped key' },
]
for (const doc of [...DOCS, 'web/market.html']) {
  if (!(await exists(doc))) continue
  const text = await readFile(new URL(doc, ROOT), 'utf8')
  for (const { pattern, why } of RETIRED_CLAIMS) {
    // The README quotes one of these while explaining that it was wrong, which
    // is the opposite of claiming it. Allow a quotation that sits next to its
    // own correction.
    if (!pattern.test(text)) continue
    const near = text.slice(Math.max(0, text.search(pattern) - 400), text.search(pattern) + 600)
    if (/not true|was false|was wrong|corrections?|declined|rather than quietly|an earlier version|there was no such|no such file|never written|never built/i.test(near)) continue
    fail(doc, `makes a claim we retired: ${why}`)
  }
}

console.log(`\n  ${commandsChecked} command(s) and ${linksChecked} path(s) checked across ${DOCS.length} documents\n`)
if (failures.length === 0) {
  console.log('  the documentation describes a repository that exists\n')
  process.exit(0)
}
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log(`\n  ${failures.length} problem(s)\n`)
process.exit(1)
