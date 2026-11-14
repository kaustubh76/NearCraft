// Does the chain run the code in this repo? No credentials.
//
//   npm run verify:deployed
//
// NEAR reports a contract's `code_hash` as base58(sha256(wasm)), so the answer
// is computable from a public view_account call and the local build. Anyone can
// run this against the public RPC and get the same answer we do.
//
// That hash comparison alone answers a NARROWER question than the one above:
// "does the chain run the wasm sitting on this disk?" It says nothing about
// whether that wasm was built from the source now in the repository. Edit a
// contract, skip the rebuild, and every hash still matched — demonstrated, not
// feared. So each contract is also asked which commit it was built from, and
// its build inputs at that commit are compared against the working tree.
//
// Why it exists: `items` was found running bytes that the repo does not build,
// and nothing here could see it. That is the A3 bug class — a fix that never
// reached the chain — and the only clue at the time was a deploy log line that
// looked like success. A claim about a deployment that cannot be checked is the
// one kind of claim this project does not get to make.
//
// The deployed contracts are built with `cargo near build reproducible-wasm`,
// so these hashes are a function of the committed source and a digest-pinned
// container rather than of this machine. That is what makes the comparison
// meaningful to someone else: run the same command on the same commit and you
// get the same bytes. `npm run build:contracts` does NOT — it uses the local
// rustc — so comparing against that build proves nothing, which the failure
// message spells out.

import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { baseEncode } from 'near-api-js'
import { names, provider, rootAccountId } from './near-env.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const git = (args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/// The paths whose contents end up inside `<name>`'s wasm. The workspace
/// manifest and lockfile are shared, so a change to either moves all three.
///
/// `contracts/integration/` is deliberately absent: it is a dev-only crate that
/// no contract build reads, and flagging it would make this check cry wolf
/// every time a sandbox test changed — which is how a check stops being read.
const buildInputs = (name) => [
  `contracts/${name}/src`,
  `contracts/${name}/Cargo.toml`,
  'contracts/Cargo.toml',
  'contracts/Cargo.lock',
]

/// Has the source that builds `<name>` moved since `<rev>`?
///
/// Returns a list of changed paths, or `null` when the question cannot be
/// answered here — no git, or a clone that does not contain that commit. A
/// check that cannot run must say so rather than pass.
function sourceDrift(rev, name) {
  try {
    git(['rev-parse', '--git-dir'])
    git(['cat-file', '-e', `${rev}^{commit}`])
  } catch {
    return null
  }
  try {
    // `git diff <rev> -- <paths>` compares that commit against the WORKING
    // TREE, so this catches both commits made since and edits not yet
    // committed. Untracked files are invisible to it, hence the second call.
    const changed = git(['diff', '--name-only', rev, '--', ...buildInputs(name)])
    const untracked = git([
      'ls-files', '--others', '--exclude-standard', '--', `contracts/${name}/src`,
    ])
    return [...changed.split('\n'), ...untracked.split('\n')].filter(Boolean)
  } catch {
    return null
  }
}

/// An account with no contract reports this sentinel rather than a hash.
const NO_CODE = '11111111111111111111111111111111'

const WASM = {
  items: new URL('../contracts/target/near/nearcraft_items/nearcraft_items.wasm', import.meta.url),
  market: new URL('../contracts/target/near/nearcraft_market/nearcraft_market.wasm', import.meta.url),
  guard: new URL('../contracts/target/near/nearcraft_guard/nearcraft_guard.wasm', import.meta.url),
}

let manifest
try {
  manifest = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))
} catch {
  console.error(
    'deployment.json not found — nothing is deployed yet.\n' +
    '  Run npm run deploy first, or point NEAR_ROOT_ACCOUNT at a deployed root.'
  )
  process.exit(1)
}

const p = provider()
const n = names(manifest.root || rootAccountId())

/// What the contract says about its own build, per NEP-330.
///
/// This is not decoration. A reproducible build embeds the commit hash in the
/// wasm, so the deployed bytes are pinned to ONE commit: rebuilding the same
/// source at a later commit produces different bytes and a DIFFERS here. A
/// verifier therefore has to check out the commit the contract names, and the
/// only place that commit is recorded is the contract itself.
async function buildInfo(accountId) {
  try {
    const meta = await p.callFunction({ contractId: accountId, method: 'contract_source_metadata', args: {} })
    return meta?.build_info ?? null
  } catch {
    return null
  }
}

/// `git+https://host/org/repo?rev=<sha>` -> the sha.
const revOf = (info) => info?.source_code_snapshot?.match(/rev=([0-9a-f]{7,40})/)?.[1] ?? null

console.log('\nIs the deployed code the code in this repo?')
console.log(`rpc ${manifest.rpc}\n`)

const problems = []
const revs = new Set()
/// What the CHAIN says each contract was built from, keyed by contract name.
/// Both the record check below and `--record` read this, so they cannot disagree.
const observed = {}
let checked = 0

/// `npm run verify:deployed -- --record` writes what the chain reports into
/// deployment.json's `built_from`. Reproducible by anyone, rather than a number
/// somebody pasted in once.
const RECORD = process.argv.includes('--record')

for (const [name, wasmUrl] of Object.entries(WASM)) {
  const accountId = n[name]

  let local
  try {
    local = new Uint8Array(await readFile(wasmUrl))
  } catch {
    // Not a mismatch — we simply cannot answer the question. Say which, because
    // "cannot check" reported as "differs" would send someone redeploying for
    // no reason.
    problems.push(`${name}: no local build to compare against — run npm run build:contracts`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} NOT BUILT`)
    continue
  }

  const expected = baseEncode(createHash('sha256').update(local).digest())

  let live
  try {
    const state = await p.query({ request_type: 'view_account', finality: 'final', account_id: accountId })
    live = state.code_hash
  } catch (e) {
    problems.push(`${name}: cannot read ${accountId} — ${e.message?.split('\n')[0] ?? e}`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} UNREADABLE`)
    continue
  }

  checked += 1
  const info = await buildInfo(accountId)
  const rev = revOf(info)
  if (rev) { revs.add(rev); observed[name] = rev }
  if (live === NO_CODE) {
    problems.push(`${name}: ${accountId} has no contract deployed at all`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} NO CODE`)
  } else if (live === expected) {
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} MATCH    ${live}`)
    console.log(`  ${' '.repeat(8)} ${' '.repeat(32)}          ${
      info ? `built reproducibly from ${rev ?? 'an unnamed revision'}` : 'no build_info — built outside a pinned container'
    }`)

    // The second question, and the one the hash cannot answer: the bytes match
    // a build, but is that build THIS source? The contract names the commit it
    // was built from, so git can settle it without rebuilding anything.
    const pad = `  ${' '.repeat(8)} ${' '.repeat(32)}          `
    if (!rev) {
      console.log(`${pad}source check skipped — the contract names no commit`)
    } else {
      const drift = sourceDrift(rev, name)
      if (drift === null) {
        console.log(`${pad}source check unavailable — no git, or ${rev.slice(0, 7)} is not in this clone`)
      } else if (drift.length === 0) {
        console.log(`${pad}and its build inputs are unchanged since that commit`)
      } else {
        problems.push(
          `${name}: the deployed bytes were built from ${rev.slice(0, 7)}, but ` +
          `${drift.length} of its build input(s) have changed since — ${drift.join(', ')}`,
        )
        console.log(`${pad}SOURCE MOVED since that commit:`)
        for (const f of drift) console.log(`${pad}  ${f}`)
      }
    }
  } else {
    problems.push(`${name}: the chain runs ${live}, this repo builds ${expected}`)
    console.log(`  ${name.padEnd(8)} ${accountId.padEnd(32)} DIFFERS  ${live}`)
    console.log(`  ${' '.repeat(8)} ${' '.repeat(32)}          ${expected}  <- local build`)
  }
}

// ----------------------------------------------------------------- verdict

// What commit is DEPLOYED, recorded where an offline check can read it.
//
// check-docs.mjs rule 8a tells a verifier `git checkout <commit>` so they can
// reproduce the deployed bytes. It used to read that commit out of the locally
// built wasm, which is a proxy for "what is deployed" and is only correct while
// the two agree. The moment this tree built ahead of its deployment, the rule
// demanded the README name a commit that does NOT reproduce what is running —
// the exact failure it was written to prevent, from the other direction.
//
// The chain knows the answer and says so in `contract_source_metadata`. This
// copies it into deployment.json so `npm run check:docs` can hold the README to
// it without a network, and asserts it has not drifted so the committed record
// cannot quietly go stale. `--record` writes; a plain run checks.
if (RECORD) {
  const path = new URL('../deployment.json', import.meta.url)
  const doc = JSON.parse(await readFile(path, 'utf8'))
  doc.built_from = { ...observed }
  doc.built_from_note =
    'The commit each deployed contract names in its own contract_source_metadata, ' +
    'copied from the chain by `npm run verify:deployed -- --record`. check:docs holds ' +
    "the README's `git checkout` line to this, and a plain verify:deployed run fails if " +
    'it drifts from what the chain says.'
  await writeFile(path, JSON.stringify(doc, null, 2) + '\n')
  console.log(`\n  recorded built_from in deployment.json: ${JSON.stringify(observed)}`)
} else if (Object.keys(observed).length > 0) {
  const recorded = manifest.built_from ?? null
  if (!recorded) {
    problems.push(
      'deployment.json records no `built_from`, so nothing offline knows which commit ' +
      'reproduces the deployed bytes. Run: npm run verify:deployed -- --record',
    )
  } else {
    for (const [name, rev] of Object.entries(observed)) {
      if (recorded[name] !== rev) {
        problems.push(
          `deployment.json says ${name} was built from ${recorded[name] ?? '(nothing)'}, but the ` +
          `chain says ${rev}. The record is stale — re-record it, because check:docs holds the ` +
          "README's instructions to it.",
        )
      }
    }
    if (problems.length === 0) {
      console.log(`\n  deployment.json's built_from matches what the chain reports  ${[...revs].join(', ')}`)
    }
  }
}

if (problems.length) {
  console.error(`\nthe chain is not running this repo's code (${problems.length}):`)
  for (const x of problems) console.error(`  ${x}`)
  console.error(
    '\nSOURCE MOVED is not DIFFERS. The deployed bytes still match the wasm on\n' +
    'this disk — but that wasm was built from a commit whose contract source is\n' +
    'no longer what this repository contains, so the chain is not running this\n' +
    'code. Rebuild and redeploy, or check out the commit the contract names.\n' +
    '\nWhat DIFFERS means depends on which build you compared with.\n' +
    '\n`cargo near build reproducible-wasm` IS byte-stable: it builds the\n' +
    'committed commit inside a digest-pinned container, so a mismatch there\n' +
    'means the deployed code is not this commit. That is the comparison a third\n' +
    'party can make, and the one the deployed contracts were built for.\n' +
    '\n`npm run build:contracts` uses non-reproducible-wasm and your local\n' +
    'rustc, so it legitimately produces different bytes from the same source.\n' +
    'A DIFFERS against THAT build tells you nothing on its own.\n' +
    '\nTo reproduce the deployed bytes yourself:\n' +
    '  cargo near build reproducible-wasm --manifest-path contracts/<name>/Cargo.toml\n' +
    '\nIf it still differs, the remedy is:  NEAR_REDEPLOY=<name> npm run deploy\n'
  )
  process.exit(1)
}

// Is the migration test's fixture still the bytes testnet is running?
//
// contracts/integration/tests/migration.rs deploys
// contracts/integration/fixtures/market-live.wasm and its whole claim, quoted
// from capture-evidence.mjs, is "the migration mechanism, against the bytes
// testnet is actually running". The fixture is pinned so it cannot be swapped
// for a convenient local build — and pinned is not the same as current. It was
// fetched on 12 November, market has been redeployed since, and the fixture had
// drifted to bytes nobody runs. Nothing noticed, because nothing compared it to
// the chain.
//
// A stale fixture does not fail the migration test. It makes it pass about the
// wrong contract, which is worse.
try {
  const fixture = await readFile(new URL('../contracts/integration/fixtures/market-live.wasm', import.meta.url))
  const fixtureHash = baseEncode(createHash('sha256').update(fixture).digest())
  const marketId = manifest.contracts.market
  const state = await p.query({ request_type: 'view_account', finality: 'final', account_id: marketId })
  if (state.code_hash === fixtureHash) {
    console.log(`\n  migration fixture matches the bytes ${marketId} is running  ${fixtureHash}`)
  } else {
    problems.push(
      `the migration fixture is stale: contracts/integration/fixtures/market-live.wasm hashes to ` +
      `${fixtureHash}, but ${marketId} is running ${state.code_hash}. The migration test claims to ` +
      `run against the bytes testnet is actually running, and it is not. Re-fetch it with a ` +
      `view_code call.`,
    )
    console.log(`\n  migration fixture STALE  ${fixtureHash}  vs chain ${state.code_hash}`)
  }
} catch (e) {
  if (!/ENOENT/.test(e?.message ?? '')) {
    problems.push(`the migration fixture could not be checked: ${e.message?.split('\n')[0] ?? e}`)
  }
}

console.log(
  `\nall ${checked} deployed contract(s) hash to the wasm this repo builds, and ` +
  'their\nbuild inputs are unchanged since the commit each one names — verified ' +
  'with no credentials'
)
if (revs.size === 1) {
  const [rev] = revs
  console.log(
    `\nThe chain says all of it was built from commit ${rev}. To reproduce the\n` +
    'bytes yourself — the commit matters, because a reproducible build embeds it:\n' +
    `  git checkout ${rev} && npm run build:reproducible && npm run verify:deployed\n`
  )
} else if (revs.size > 1) {
  console.log(
    `\nNote: the contracts were built from ${revs.size} different commits ` +
    `(${[...revs].join(', ')}).\nThat is legal but worth knowing — verify each against its own.\n`
  )
}
