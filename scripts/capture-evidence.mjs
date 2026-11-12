// Run each check and retain what it actually printed.
//
//   npm run evidence
//
// The baseline project's credibility came from an evidence/ directory that kept
// failures next to passes, so a reader could see what was tried rather than only
// what worked. This reproduces that discipline: every run is recorded with its
// command, exit code, duration and a hash of its output, and a FAILING run is
// written out exactly like a passing one.
//
// Nothing here edits a previous record. Each run gets its own directory.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const ROOT = new URL('../', import.meta.url)
const started = new Date()
/// Directory name sorts chronologically and carries no spaces.
const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)

/// `requiresWasm` runs are skipped with a recorded reason rather than reported
/// as failures when the contracts have not been built — a skipped check and a
/// failing one are different facts.
const CHECKS = [
  { topic: 'unit-tests', cmd: 'npm', args: ['run', '--silent', 'test:contracts'],
    proves: 'Every Rust unit test across all three contracts, offline, with no wasm target and no network. The count is in the retained output below rather than in this sentence — it has drifted three times in one day, and this project has already had to correct eight stale counts at once.' },
  { topic: 'policy-and-injection', cmd: 'node', args: ['--test', 'tests/near/policy.mjs', 'tests/near/injection.mjs', 'tests/near/market.mjs'],
    proves: 'The policy layer refuses out-of-policy agent calls, a prompt-injected agent is blocked across two layers AND recognised as paying a known-bad account, and the plugin HTTP contract is well-formed. Offline.' },
  { topic: 'live-testnet-reads', cmd: 'npm', args: ['run', '--silent', 'reads'],
    proves: 'The deployed contracts on NEAR testnet answering a public, credential-free query: every merchant ask, bid, stock band and the contract\'s own reason string. Needs no account and no key. Exits non-zero if the market reports no merchants, if the manifest records no materials, or if no merchant quotes a price for anything — a deployment that answers nothing is not a deployment that answered.' },
  { topic: 'live-testnet-keys', cmd: 'npm', args: ['run', '--silent', 'keys'],
    proves: 'Each live agent key\'s receiver_id, method_names and allowance, read back from the chain rather than asserted, plus the spend budgets and a count of the disclosed operator keys. Exits non-zero if any agent key is unrestricted, if the chain carries a scoped key the manifest does not record, if the manifest records one the chain does not have, or IF THERE IS NOTHING TO AUDIT — that last case shipped: the manifest said agents: [] and this check reported success having examined zero accounts.' },
  { topic: 'deployed-code-matches-repo', cmd: 'npm', args: ['run', '--silent', 'verify:deployed'], requiresWasm: true,
    proves: 'The code running on NEAR testnet is the code this repo builds: for each contract, base58 of sha256 of the local wasm equals the code_hash the chain reports, read with a public credential-free view_account call. Written because items was found running bytes this repo does not build — the A3 bug class, a fix that silently never reaches the chain, whose only clue is a deploy log line that looks like success. It FAILED on items the first time it ran, and passed after a redeploy. The three deployed contracts are now built with cargo near build reproducible-wasm inside a digest-pinned container from a named commit, so these hashes are a function of the committed source and not of this machine: anyone can run npm run build:reproducible on this commit and get the same bytes. The chain says which commit and which container, because NEP-330 build_info is populated where it read null before — which is what lets SourceScan and NearBlocks verify the contracts. It also checks the half a hash cannot see: a hash match only proves the chain runs the wasm on this disk, not that the wasm was built from the source now in the repo. Editing a contract and skipping the rebuild left all three hashes matching, demonstrated rather than feared, so the script now reads the commit each contract names and compares that commit's build inputs against the working tree, reporting SOURCE MOVED and exiting non-zero when they differ. No rebuild, no credentials, no Docker. The remaining limit, which the script prints itself: npm run build:contracts uses the local rustc and is deliberately NOT byte-stable, so comparing against that build proves nothing, and the failure message says so rather than leaving a reader to guess.' },
  { topic: 'agent-run', cmd: 'npm', args: ['run', '--silent', 'agent'], requiresWasm: true,
    proves: 'An agent with a scoped key shopping on a real nearcore node, end to end, with five ASSERTIONS rather than printed output a reader has to judge: a counterparty is parked for a human and settles once approved when the persisted ledger does not yet trust it (and clears on its own when it does), the same counterparty then clears without a human, a prompt-injected objective is BLOCKED and never settles, that block rests on corroborated reports read off the public guard contract, and the injected purchase moves no materials. Exits non-zero if any of those is untrue. Every layer is the real one, including two vendored baseline modules.' },
  { topic: 'gasless-play', cmd: 'node', args: ['--test', 'tests/near/gasless.mjs'], requiresWasm: true,
    proves: 'On a real nearcore node, a player holding only a function-call access key buys goods and pays nothing: the player balance delta is exactly 0 and the relayer pays. It also SELLS: a player with no full-access key at all sells under a NEP-245 approval through the non-payable market.sell, and pays nothing. Records that a delegate action\'s inner call cannot carry a deposit, which is why selling cannot go through mt_transfer_call. And it BACKS a merchant for free: a relayed invest_with_credit records a 1 NEAR stake against the player, who pays nothing. invest is #[payable], so a scoped key could never reach it — without the non-payable twin the mechanic the games prompt describes would be unreachable for exactly the players it is for.' },
  { topic: 'identity-verification', cmd: 'node', args: ['--test', 'tests/near/oidc.mjs'],
    proves: 'Real OIDC token verification: JWKS fetch, JWT signature check, and iss/aud/exp/nbf/sub validation, with 25 tests that generate their own RS256 keypair and serve a JWKS from a stubbed fetch, so none of it needs a provider or a network. The attacks are the substance: alg:none refused, an HMAC alg signed with the public key refused before the signature is checked, a swapped payload refused, a token minted for a DIFFERENT application refused, rotation handled with exactly one refetch. No provider client id is configured, so no token Google actually issued has been verified — that is the remaining gap, and it is configuration, not code.' },
  { topic: 'counterparty-and-approval', cmd: 'node', args: ['--test', 'tests/near/counterparty.mjs', 'tests/near/human-approval.mjs', 'tests/near/onboarding.mjs', 'tests/near/relayer.mjs'],
    proves: 'allow/warn/block scoring over the four named signals, including that reports alone can never reach block however many there are, that an unknown counterparty warns and is never allowed, and that a warn parks the call for a human whose approval cannot override a later block. Offline.' },
  { topic: 'baseline-integrity', cmd: 'npm', args: ['run', '--silent', 'verify:baseline'],
    proves: '11 vendored baseline files are byte-identical to their recorded SHA-256, AND no file sits in backend/baseline/ without being recorded. Checked in both directions, because iterating the manifest alone can only catch a recorded file that changed, never an unrecorded one that appeared. An empty manifest is a failure rather than a vacuous pass. This is what makes the eligibility disclosure checkable rather than a promise.' },
  { topic: 'nep245-conformance', cmd: 'npm', args: ['run', '--silent', 'check:nep245'], requiresWasm: true,
    proves: 'NEP-245 core 10/10, Enumeration 2/2 and Approval Management 5/5 present, Metadata absent as documented, and security-relevant modifiers correct — including that market.sell and buy_with_credit carry NO modifiers, since a function-call key cannot attach NEAR. Read off the ABI cargo-near emitted, not off our source comments.' },
  { topic: 'view-methods-callable', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'views', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'All 29 view methods across the three contracts can actually be entered as view calls on a real node, AND the list is checked against the compiled ABI so it cannot fall behind in silence — it already had: ledger_total was added in the money-invariant release and never added here, so the one view whose entire purpose is to be callable from outside was going uncalled by the test that exists to check exactly that. nearcore forbids some host functions in a view context, and a &self method that reaches for one compiles, passes every unit test, and then fails for every real client with ProhibitedInView — mt_is_approved shipped with exactly that bug and no test here caught it. A view that panics on its arguments is recorded as reached; only an unenterable view fails this check.' },
  { topic: 'access-key-limits', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'keys', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'A function-call access key scoped to one method, signed with THAT key against a real nearcore node. The protocol refuses everything else and names its own refusals.' },
  { topic: 'money-invariant', cmd: 'cargo', args: ['test', '-p', 'nearcraft-market', '--lib', 'every_yocto_is_accounted_for', '--', '--nocapture'],
    cwd: 'contracts',
    proves: 'Every yoctoNEAR entering the market contract is still accounted for: sum(treasuries) + sum(credits) == deposited - paid out, asserted after EVERY ONE of the fourteen money-moving calls rather than once at the end, so a failure names the step rather than the session. Four payable entry points add, two withdrawals remove, and every other path — purchases, sales, the push path, restocks, credit investments and all four rollbacks — must net to exactly zero. Verified by injecting a real leak (a sale that credits the seller without debiting the treasury): the test names "after sell" and the 1.66 NEAR created from nothing.' },
  { topic: 'solvency', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'economy', 'the_market_never_owes_more_than_it_holds', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'The market never promises more than it holds, across a real trading session on a real node: buys, a sale through the push path, an investment and a real withdrawal. This is the half a unit test cannot reach, because a unit test has no account balance. Asserted as >= rather than ==, because the contract spends 1 yoctoNEAR of its own balance per mt_transfer and locks a slice as storage stake — both drift the balance in the safe direction, and the run prints the figures so a reader can see the gap is exactly that.' },
  { topic: 'state-migration', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'migration', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'The migration mechanism, against the bytes testnet is actually running. The test deploys contracts/integration/fixtures/market-live.wasm — fetched from market.nearcraftmc.testnet with a public view_code call, with its code_hash pinned and re-checked after deploying, so the fixture cannot be swapped for a convenient local build — writes state through it, then BREAKS the contract with a plain redeploy and asserts every view really does fail to deserialize, then rescues it with deploy+migrate as two actions in ONE transaction and asserts the ledger total, treasury, stock, credit and a live quote all came through unchanged. Also: a second migrate is a no-op rather than a reset, and a stranger calling migrate is refused with "Method migrate is private" — which no unit test can show, because near-sdk emits that check only in the wasm32 wrapper, and an un-private migrate would let anyone overwrite the contract state. Verified by injecting a real migration bug (dropping credits): the test named the 2 NEAR that vanished from ledger_total, which credit_of alone could not see.' },
  { topic: 'cross-contract-economy', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'economy', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'Buy, the rollback on a failed delivery, a sale through mt_transfer_call, a closed merchant refusing and the resolver refunding, withdrawals moving real NEAR, and a BACKER earning its stake back: it invests in a restocked merchant, that merchant is REFUSED when it tries to withdraw the principal it was just lent, and the next sale pays the backer half its margin as withdrawable credit, to the yoctoNEAR.' },
]

function run({ cmd, args, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: cwd ? new URL(cwd + '/', ROOT) : ROOT, env: process.env })
    let out = ''
    const at = Date.now()
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (e) => resolve({ output: `${out}\nspawn failed: ${e.message}`, code: -1, ms: Date.now() - at }))
    child.on('close', (code) => resolve({ output: out, code, ms: Date.now() - at }))
  })
}

async function wasmBuilt() {
  const { stat } = await import('node:fs/promises')
  for (const n of ['nearcraft_items', 'nearcraft_market']) {
    try { await stat(new URL(`contracts/target/near/${n}/${n}.wasm`, ROOT)) }
    catch { return false }
  }
  return true
}

const haveWasm = await wasmBuilt()
if (!haveWasm) {
  console.log('note: contracts are not built, so wasm-dependent checks will be recorded as skipped.')
  console.log('      run `npm run build:contracts` first to capture them.\n')
}

const records = []
for (const check of CHECKS) {
  const dir = new URL(`evidence/runs/${check.topic}/${stamp}/`, ROOT)
  await mkdir(dir, { recursive: true })

  let record
  if (check.requiresWasm && !haveWasm) {
    record = {
      topic: check.topic, status: 'skipped',
      reason: 'contracts not built; run npm run build:contracts',
      command: [check.cmd, ...check.args].join(' '), proves: check.proves,
    }
    console.log(`skip  ${check.topic}`)
  } else {
    const { output, code, ms } = await run(check)
    await writeFile(new URL('output.txt', dir), output)
    record = {
      topic: check.topic,
      // A failure is recorded, not hidden. That is the point of this directory.
      status: code === 0 ? 'pass' : 'fail',
      exit_code: code,
      duration_ms: ms,
      command: [check.cmd, ...check.args].join(' '),
      cwd: check.cwd ?? '.',
      proves: check.proves,
      output_sha256: createHash('sha256').update(output).digest('hex'),
      output_bytes: Buffer.byteLength(output),
    }
    console.log(`${code === 0 ? 'ok  ' : 'FAIL'}  ${check.topic.padEnd(24)} ${(ms / 1000).toFixed(1)}s`)
  }
  record.recorded_at = new Date().toISOString()
  await writeFile(new URL('report.json', dir), JSON.stringify(record, null, 2) + '\n')
  records.push(record)
}

/// The retained live-write records, summarised into the index so a reader does
/// not have to go looking for the transaction hashes.
async function liveTransactions() {
  try {
    const dir = new URL('evidence/live/', ROOT)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    return Promise.all(files.map(async (f) => {
      const r = JSON.parse(await readFile(new URL(f, dir), 'utf8'))
      // Two record shapes: the agent purchase carries one `transaction_hash`,
      // the player proof carries a `transactions` map (a buy and a sell). Index
      // both rather than silently emitting undefined for one of them.
      // Records carry one `transaction_hash` or a `transactions` map, and each
      // kind describes itself differently. Derive a description where the
      // fields are there, and otherwise fall back to the record's own note —
      // the first version of this assumed one shape and would have indexed a
      // later one as a row of `undefined`.
      if (r.transactions) {
        const described = r.player
          ? `${r.player} bought and sold ${r.count}x ${r.item} holding ${r.player_full_access_keys} full-access keys, paying ${r.player_near_delta_yocto === '0' ? 'nothing' : `${r.player_near_delta_yocto} yocto`}; relayer paid ${r.relayer_paid_yocto} yocto`
          : (r.note ?? `${Object.keys(r.transactions).join(' then ')} on ${r.merchant ?? 'the market'}`)
        return {
          transactions: Object.fromEntries(
            Object.entries(r.transactions).map(([k, v]) => [k, v.hash]),
          ),
          what: described,
          explorer: Object.values(r.transactions).map((v) => v.explorer),
          path: `evidence/live/${f}`,
        }
      }
      return {
        transaction_hash: r.transaction_hash,
        what: `${r.agent} bought ${r.count}x ${r.item} from ${r.merchant}`,
        explorer: r.explorer,
        path: `evidence/live/${f}`,
      }
    }))
  } catch {
    // Absent is a legitimate state: a fresh clone has sent no transactions.
    return []
  }
}

const summary = {
  note: 'Written by npm run evidence. Each run keeps its own directory; failures are retained alongside passes and are never edited out.',
  recorded_at: started.toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  wasm_built: haveWasm,
  totals: {
    pass: records.filter((r) => r.status === 'pass').length,
    fail: records.filter((r) => r.status === 'fail').length,
    skipped: records.filter((r) => r.status === 'skipped').length,
  },
  // What these records do NOT establish, stated here so a reader does not have
  // to infer it.
  boundaries: [
    'Most of these run locally, against a nearcore sandbox. The two topics named live-testnet-* are real, credential-free reads of the deployed contracts on public NEAR testnet.',
    'Those live reads are VIEW calls only. No check in this script sends a transaction, so no record below is evidence of live write behaviour.',
    'Live write behaviour is evidenced separately, by the retained records in evidence/live/ — each names real transaction hashes on public testnet that anyone can open on an explorer. Those come from npm run live:agent (an agent purchase under a scoped key, screened and human-approved) and npm run live:player (a player with NO full-access key buying and selling while its balance moves by exactly zero). Both are deliberately outside this script because they spend real testnet balance.',
    'The live deployment runs at a reduced economy scale (see economy_scale in deployment.json); its figures are not the full-size economy the sandbox runs.',
    'No Minecraft gameplay is recorded; the plugin is not exercised by any check here.',
    'A passing check establishes what its own output shows and nothing wider.',
  ],
  live_transactions: await liveTransactions(),
  runs: records.map((r) => ({ topic: r.topic, status: r.status, path: `evidence/runs/${r.topic}/${stamp}/` })),
}
await writeFile(new URL(`evidence/SUMMARY.json`, ROOT), JSON.stringify(summary, null, 2) + '\n')

console.log(`\n${summary.totals.pass} pass, ${summary.totals.fail} fail, ${summary.totals.skipped} skipped`)
console.log(`records -> evidence/runs/*/${stamp}/   summary -> evidence/SUMMARY.json`)
process.exit(summary.totals.fail > 0 ? 1 : 0)
