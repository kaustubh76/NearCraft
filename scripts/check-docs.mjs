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
              'docs/MINECRAFT.md',
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
    why: 'the Java in minecraft/ is new code, not a diff against EthCraft\'s plugin — ' +
         'nothing was copied, so there is no diff to point at and never was' },
  { pattern: /and the sealed-bid round coordinator/i,
    why: 'the coordinator was never built and the swarms track is not entered' },
  { pattern: /read-only live market and round page/i,
    why: 'web/market.html has no round UI' },
  { pattern: /Approval Management extension, which did not fit/i,
    why: 'Approval Management is implemented and is what the player sell path uses' },
  { pattern: /which is why a scoped key cannot sell/i,
    why: 'a scoped key sells through the non-payable market.sell under an approval' },
  // Not one stale number but the whole class. Hand-written test counts have now
  // rotted FIVE times in this repository: eight at once in the claims audit,
  // then 183, then 116, then 135 within a single day of each other — and then
  // the status table's own "74 unit tests" and "12 tests", which these two
  // patterns do not match because neither says "Rust" or "offline". That is
  // the limit of banning a phrasing: the next writer picks a different one.
  // Counts that CAN be checked are now checked instead, further down.
  { pattern: /\b\d+ Rust unit tests?\b/i,
    why: 'a hand-written Rust unit-test count rots — npm run test:contracts prints it, so cite the command instead of a number' },
  { pattern: /\b\d+ offline (?:Node )?checks\b/i,
    why: 'a hand-written offline-check TOTAL rots — npm test prints it, so cite the command instead of a number. A per-file count is fine: it is a claim about one file that a reader can check' },
  { pattern: /does not model, because merchants do not restock/i,
    why: 'merchants do restock now, permissionlessly, and it was never the binding constraint on throughput' },
  { pattern: /holds a function-call key, nothing more/i,
    why: 'an agent account also carries a disclosed operator full-access key; only the agent PROCESS holds just the scoped key' },
  { pattern: /the mechanic is built; the stake accounting is not/i,
    why: 'the stake accounting is built: basis, backers, and margin attributed in on_items_delivered' },
  { pattern: /a tracked stake repaid out of the merchant.{0,3}s future margin.{0,80}(is not built|only designed)/i,
    why: 'the tracked stake is built and its migration has run on testnet' },
  { pattern: /no contract here has (a migrate method|one) yet/i,
    why: 'market.migrate() exists and has run on public testnet' },
  { pattern: /poked all 25 shelves|all 25 shelves/i,
    why: 'the simulation fixture has four materials across EIGHT shelves; 25 was never counted, it was five merchants times five materials imagined' },
  { pattern: /5\.7 trades per second/i,
    why: 'the rate is 5.1 a second since cost basis and the margin split added writes to the buy path — re-measure with npm run sim rather than reusing a figure' },
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
    // The escape-hatch list is deliberately narrow. It used to include
    // "rather than quietly", which is a STYLISTIC phrase this project uses all
    // the time — and it duly disarmed a brand-new rule within minutes of that
    // rule being written, because the prose beside the claim happened to say
    // "rather than quietly dropped". An escape hatch that ordinary wording can
    // trip is an escape hatch that turns every rule into a coin flip, so each
    // pattern here has to be something a writer only says when correcting a
    // claim, never something they might say while making one.
    if (/not true|was false|was wrong|superseded|retired|declined|an earlier version|there was no such|no such file|never written|never built/i.test(near)) continue
    fail(doc, `makes a claim we retired: ${why}`)
  }
}

// ------------------------------------------- test counts, checked not banned
//
// Hand-written test counts have now rotted FIVE times here. The RETIRED_CLAIMS
// rules above ban two phrasings of a TOTAL, but the status table writes
// "74 unit tests" and "12 tests", which neither pattern matches — and both were
// wrong: the market crate had 95 and the sandbox suite 18.
//
// Banning the number is one answer. CHECKING it is a better one, because the
// number is worth having and it is cheap to verify: a unit test is a `#[test]`
// in that crate's `src`, and a sandbox test is a `#[tokio::test]` in the files
// `test:sandbox` actually runs. Counted this way they agree exactly with what
// the runners print — verified against both before this check was written.
//
// The sandbox file list is read out of `test:sandbox` itself rather than
// written here, so adding `--test foo` updates the expected number instead of
// silently making it stale. A count written down in two places is the problem;
// this one is written down in none.
async function countInFiles(dir, pattern, only = null, ext = '.rs') {
  let n = 0
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += await countInFiles(`${dir}${entry.name}/`, pattern, only, ext)
      continue
    }
    if (!entry.name.endsWith(ext)) continue
    if (only && !only.includes(entry.name.slice(0, -ext.length))) continue
    const text = await readFile(new URL(`${dir}${entry.name}`, ROOT), 'utf8')
    n += (text.match(pattern) ?? []).length
  }
  return n
}

const sandboxFiles = [...(pkg.scripts?.['test:sandbox'] ?? '').matchAll(/--test\s+(\S+)/g)].map((m) => m[1])

const COUNTED_CLAIMS = [
  { what: 'contracts/items unit tests', dir: 'contracts/items/src/', pattern: /#\[test\]/g,
    claim: /`contracts\/items`[^\n]*?\b(\d+) unit tests\b/ },
  { what: 'contracts/market unit tests', dir: 'contracts/market/src/', pattern: /#\[test\]/g,
    claim: /`contracts\/market`[^\n]*?\b(\d+) unit tests\b/ },
  { what: 'contracts/guard unit tests', dir: 'contracts/guard/src/', pattern: /#\[test\]/g,
    claim: /`contracts\/guard`[^\n]*?\b(\d+) unit tests\b/ },
  { what: 'sandbox integration tests', dir: 'contracts/integration/tests/', pattern: /#\[tokio::test\]/g,
    only: sandboxFiles,
    claim: /\*\*Sandbox integration tests\*\*[^\n]*?\b(\d+) tests\b/ },
  // The page's own suite. Added the moment a number for it was written down,
  // rather than waiting for this one to rot too.
  { what: 'web/market.html tests', dir: 'tests/near/', pattern: /^test\(/gm, only: ['web'], ext: '.mjs',
    claim: /`web\/market\.html`[^\n]*?\b(\d+) tests\b/ },
  // The Minecraft plugin. Counted from the day it was written, for the same
  // reason: a Java suite is one more place a hand-written number can rot, and
  // this one is not even run by `npm test` (it needs a JDK), so nothing else
  // would notice.
  { what: 'Minecraft plugin Java checks', dir: 'minecraft/src/test/java/org/nearcraft/mc/',
    pattern: /\bh\.(?:equals|check|refuses)\(/g, ext: '.java',
    claim: /\b(\d+) Java checks\b/ },
  // Lines, not tests. A table of six per-class line counts in docs/MINECRAFT.md
  // had drifted before it was ever committed (458 written as "~400"), so there
  // is now one number and it is counted.
  { what: 'lines of plugin Java', dir: 'minecraft/src/main/java/',
    pattern: /\n/g, ext: '.java',
    claim: /\b(\d+) lines of new Java\b/ },
  { what: 'Minecraft plugin commands', dir: 'minecraft/src/main/resources/',
    pattern: /^  [a-z]+:$/gm, only: ['plugin'], ext: '.yml',
    claim: /\b(\d+) in-game commands\b/ },
  // NEP-245 Approval Management, counted from the contract rather than from
  // the gate that checks it. `scripts/check-nep245.mjs` cannot help here: its
  // list of required methods is hand-written, so for a while it reported
  // "5/5" while missing `mt_token_approvals` entirely — the denominator was
  // the implementation, which is a check that cannot fail.
  //
  // `all: true` because the real defect was two README rows DISAGREEING: one
  // said 6/6 and the other still said 5/5, and checking only the first
  // occurrence would have passed. Six is the spec's number and is fixed; the
  // numerator is counted.
  //
  // The denominator is read too, and that is not fussiness. The first version
  // of this check matched `Approval Management (\d+)/6` — so the row reading
  // "5/5" did not match it AT ALL and the check passed while the stale row sat
  // there. A regex that only recognises the correct answer cannot report a
  // wrong one. Six is the spec's count and is asserted as a constant; the
  // numerator is counted from the contract.
  { what: 'NEP-245 Approval Management methods', dir: 'contracts/items/src/',
    pattern: /pub fn (?:mt_approve|mt_revoke_all|mt_revoke|mt_is_approved|mt_token_approvals|mt_token_approval)\s*\(/g,
    all: true, denominator: 6,
    claim: /Approval Management \*{0,2}(\d+)\/(\d+)\b/g },
  // Counted the moment a number for it was written down. The README said
  // "twelve" while the source had thirteen, which is the same hand-written
  // count rotting for the same reason as every one above it.
  { what: 'market env::log_str lines', dir: 'contracts/market/src/',
    pattern: /env::log_str\(/g,
    claim: /\b(\d+) plain `env::log_str` lines\b/ },
]

// 7. The Minecraft plugin must stay NEW code.
//
// Copying a file out of EthCraft's plugin would make it baseline work, which
// the eligibility disclosure in BASELINE.md says was not done. That is the kind
// of claim that must be enforced rather than promised, so: nothing under
// minecraft/ may carry EthCraft's package name.
async function scanForEthCraft(dir) {
  let hits = []
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (entry.isDirectory()) { hits.push(...(await scanForEthCraft(`${dir}${entry.name}/`))); continue }
    const text = await readFile(new URL(`${dir}${entry.name}`, ROOT), 'utf8')
    if (/org\.agentcity|org\/agentcity/.test(text)) hits.push(`${dir}${entry.name}`)
  }
  return hits
}
if (await exists('minecraft/')) {
  for (const hit of await scanForEthCraft('minecraft/')) {
    fail('BASELINE.md', `${hit} carries EthCraft's package name; BASELINE.md says no part of that plugin was ported`)
  }
  commandsChecked++
}

const readmeText = await readFile(new URL('README.md', ROOT), 'utf8')

// 8a. The commit the README tells a verifier to check out.
//
// It said `git checkout 4da447eb…` for three deployments after that commit had
// been superseded, so anyone following the instructions got a mismatch and the
// strongest claim in this project looked false. A reproducible build embeds
// the commit IN the wasm, which makes this checkable offline rather than
// hand-maintained: read it back out of the artifact.
//
// Skipped, not failed, when the contracts have not been built — a fresh clone
// has no artifacts and has nothing to be wrong about. Both forms in the README
// are checked, the full hash and the abbreviated one, because they rotted
// together and would again.
try {
  const wasm = await readFile(
    new URL('contracts/target/near/nearcraft_items/nearcraft_items.wasm', ROOT),
  )
  const built = wasm.toString('latin1').match(/rev=([0-9a-f]{40})/)?.[1]
  if (built) {
    const full = readmeText.match(/git checkout ([0-9a-f]{40})/)
    if (!full) {
      fail('README.md', 'no `git checkout <commit>` line found — the reproducible-build '
        + 'instructions were reworded, so this check now verifies nothing')
    } else if (full[1] !== built) {
      fail('README.md', `tells a verifier to check out ${full[1].slice(0, 8)}…, but the built `
        + `contract was made from ${built.slice(0, 8)}… — following the README would mismatch`)
    } else { commandsChecked++ }

    const short = readmeText.match(/\?rev=([0-9a-f]{8})…/)
    if (!short) {
      fail('README.md', 'no abbreviated `?rev=…` line found — it was reworded, so this '
        + 'check now verifies nothing')
    } else if (!built.startsWith(short[1])) {
      fail('README.md', `shows source_code_snapshot rev=${short[1]}…, but the built contract `
        + `was made from ${built.slice(0, 8)}…`)
    } else { commandsChecked++ }
  }
} catch (e) {
  // No artifact is a legitimate state. A malformed one is not.
  if (!/ENOENT/.test(e?.message ?? '')) fail('contracts/target', `could not be read: ${e.message}`)
}

// 8b. What the deployment actually contains, counted from the manifest.
//
// The README said "5 merchants, 2 agents, 1 player" for weeks, and it was true
// when written. The moment a second player was onboarded it became false, and
// nothing noticed — a hand-written count that rots is the single most repeated
// defect in this repository's history, so this one is derived. Same
// anti-vacuity trap as the counts above: rewording the row fails the check
// rather than silently disabling it.
const MANIFEST_CLAIMS = [
  { what: 'merchants', key: 'merchants', claim: /\b(\d+) merchants\b/ },
  { what: 'agents', key: 'agents', claim: /\b(\d+) agents\b/ },
  { what: 'players', key: 'players', claim: /\b(\d+) players?\b(?!\.md)/ },
]
try {
  const deployed = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
  for (const { what, key, claim } of MANIFEST_CLAIMS) {
    const actual = (deployed[key] ?? []).length
    const m = readmeText.match(claim)
    if (!m) {
      fail('README.md', `no ${what} count found to check — the row was reworded, so this check now verifies nothing`)
      continue
    }
    if (Number(m[1]) !== actual) {
      fail('README.md', `claims ${m[1]} ${what}, but deployment.json records ${actual}`)
    }
    commandsChecked++
  }
} catch (e) {
  // No manifest is a legitimate state for a fresh clone, and this check has
  // nothing to say about it. A malformed one is not.
  if (!/ENOENT/.test(e?.message ?? '')) fail('deployment.json', `could not be read: ${e.message}`)
}

// 8c. The hosted URLs, which are otherwise the one claim here nothing can see.
//
// Rule 2 skips `https?:` links on purpose — it cannot tell a real address from a
// dead one. So a URL in these documents was, until this rule, unpoliced: it
// could rot through three redeployments exactly the way the `git checkout`
// commit in 8a did, and the failure mode is the worst kind. BASELINE.md:120
// states it: "a provenance link a judge cannot open is worse than no link."
//
// This does not test whether the URLs answer — `npm run check:hosted` does that,
// over the network, which is why it is not in `npm test`. This checks the
// cheaper and more easily broken thing: that every address these documents
// advertise is one that check:hosted actually tests, and that the README still
// advertises both. Same anti-vacuity trap as the rules above — deleting the row
// fails rather than quietly disabling the rule.
try {
  const hosting = JSON.parse(await readFile(new URL('config/hosting.json', ROOT), 'utf8'))
  const tested = new Set([hosting.web.url, hosting.play.url])

  // Any address on a host we deploy to, anywhere in the documents.
  const HOSTED = /https:\/\/[A-Za-z0-9._-]+\.(?:vercel\.app|onrender\.com)/g

  for (const doc of DOCS) {
    const text = await readFile(new URL(doc, ROOT), 'utf8')
    for (const m of text.matchAll(HOSTED)) {
      if (!tested.has(m[0])) {
        fail(doc, `advertises ${m[0]}, which is not the address config/hosting.json records `
          + `and check:hosted tests (${[...tested].join(', ')}) — a stale link`)
      } else { commandsChecked++ }
    }
  }

  for (const [which, url] of [['web', hosting.web.url], ['play', hosting.play.url]]) {
    if (!readmeText.includes(url)) {
      fail('README.md', `config/hosting.json records the ${which} deployment at ${url}, but the `
        + 'README never names it — a reader is told to clone when there is a URL they could open')
    } else { commandsChecked++ }
  }

  // vercel.json cannot read a config file, so the proxy destination is the one
  // place the play URL is necessarily written twice. If the two drift, the page
  // calls /api/* and reaches a host that is no longer the service — and every
  // other check here would still pass, because each half is internally
  // consistent. So compare them.
  const vercel = JSON.parse(await readFile(new URL('vercel.json', ROOT), 'utf8'))
  const proxy = (vercel.rewrites ?? []).find((r) => String(r.source).startsWith('/api/'))
  if (!proxy) {
    fail('vercel.json', 'has no /api/ rewrite, so the hosted page cannot reach the play service '
      + '— and the page calls /api/* relative, expecting same origin')
  } else if (!String(proxy.destination).startsWith(hosting.play.url)) {
    fail('vercel.json', `proxies /api/ to ${proxy.destination}, but config/hosting.json records the `
      + `play service at ${hosting.play.url} — the page would call a host that is not the service`)
  } else { commandsChecked++ }
} catch (e) {
  // No hosting config is a legitimate state: a fork that deploys nowhere has
  // nothing to be wrong about. A malformed one is not.
  if (!/ENOENT/.test(e?.message ?? '')) fail('config/hosting.json', `could not be read: ${e.message}`)
}

for (const { what, dir, pattern, claim, only, ext, all, denominator } of COUNTED_CLAIMS) {
  const actual = await countInFiles(dir, pattern, only ?? null, ext ?? '.rs')
  // `all` checks EVERY place the number is written, not just the first. The
  // README once carried the same count twice and the two disagreed, which a
  // first-match check passes happily.
  const found = all ? [...readmeText.matchAll(claim)] : [readmeText.match(claim)].filter(Boolean)
  if (found.length === 0) {
    // Not "no claim, no problem": the row was reworded and this check went
    // blind, which is how a vacuous check is born.
    fail('README.md', `no ${what} count found to check — the row was reworded, so this check now verifies nothing`)
    continue
  }
  for (const m of found) {
    if (Number(m[1]) !== actual) {
      fail('README.md', `claims ${m[1]} ${what}, but ${actual} exist`)
    }
    // An "N of M" claim where M is fixed by a spec, not by us. Reading only N
    // let `5/5` slip through, because the regex that looked for `.../6` simply
    // did not match the wrong row.
    if (denominator !== undefined && Number(m[2]) !== denominator) {
      fail('README.md', `claims ${m[1]}/${m[2]} ${what}, but the standard defines ${denominator}`)
    }
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
