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

import { mkdir, writeFile } from 'node:fs/promises'
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
    proves: '61 Rust unit tests across both contracts. Offline, no wasm target, no network.' },
  { topic: 'policy-and-injection', cmd: 'node', args: ['--test', 'tests/near/policy.mjs', 'tests/near/injection.mjs', 'tests/near/market.mjs'],
    proves: 'The policy layer refuses out-of-policy agent calls, a prompt-injected agent is blocked across two layers AND recognised as paying a known-bad account, and the plugin HTTP contract is well-formed. Offline.' },
  { topic: 'counterparty-and-approval', cmd: 'node', args: ['--test', 'tests/near/counterparty.mjs', 'tests/near/human-approval.mjs'],
    proves: 'allow/warn/block scoring over the four named signals, including that reports alone can never reach block however many there are, that an unknown counterparty warns and is never allowed, and that a warn parks the call for a human whose approval cannot override a later block. Offline.' },
  { topic: 'baseline-integrity', cmd: 'npm', args: ['run', '--silent', 'verify:baseline'],
    proves: '11 vendored baseline files are byte-identical to their recorded SHA-256. This is what makes the eligibility disclosure checkable rather than a promise.' },
  { topic: 'nep245-conformance', cmd: 'npm', args: ['run', '--silent', 'check:nep245'], requiresWasm: true,
    proves: 'NEP-245 core 10/10 and Enumeration 2/2 present, Approval/Metadata absent as documented, and security-relevant modifiers correct — read off the ABI cargo-near emitted, not off our source comments.' },
  { topic: 'access-key-limits', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'keys', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'A function-call access key scoped to one method, signed with THAT key against a real nearcore node. The protocol refuses everything else and names its own refusals.' },
  { topic: 'cross-contract-economy', cmd: 'cargo', args: ['test', '-p', 'nearcraft-integration', '--test', 'economy', '--', '--nocapture'],
    cwd: 'contracts', requiresWasm: true,
    proves: 'Buy, the rollback on a failed delivery, a sale through mt_transfer_call, a closed merchant refusing and the resolver refunding, and withdrawals moving real NEAR.' },
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
    'All of this runs locally. Nothing here is a public-chain result.',
    'No NEAR testnet deployment exists, so no live-network behaviour is recorded.',
    'No Minecraft gameplay is recorded; the plugin is not exercised by any check here.',
    'A passing check establishes what its own output shows and nothing wider.',
  ],
  runs: records.map((r) => ({ topic: r.topic, status: r.status, path: `evidence/runs/${r.topic}/${stamp}/` })),
}
await writeFile(new URL(`evidence/SUMMARY.json`, ROOT), JSON.stringify(summary, null, 2) + '\n')

console.log(`\n${summary.totals.pass} pass, ${summary.totals.fail} fail, ${summary.totals.skipped} skipped`)
console.log(`records -> evidence/runs/*/${stamp}/   summary -> evidence/SUMMARY.json`)
process.exit(summary.totals.fail > 0 ? 1 : 0)
