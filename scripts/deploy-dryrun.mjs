// Rehearse the real deployment against a local sandbox.
//
//   npm run test:deploy
//
// scripts/deploy.mjs had never been executed. A script whose first run is the
// thing you publish is a bad bet — and inspection had already found it stale:
// it knew nothing about the guard contract, so a live deployment would have had
// no blocklist and the counterparty check would have degraded *silently* rather
// than failing. This runs the real deploy, the real reads and the real key
// audit against a throwaway node, where a mistake costs nothing.
//
// It uses the env knobs scripts/near-env.mjs already reads, so there is no
// sandbox-only code path in the deployment itself — what runs here is what runs
// against testnet.

import { spawn } from 'node:child_process'
import { copyFile, rm, stat } from 'node:fs/promises'
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox'

const ROOT = new URL('../', import.meta.url)
/// deployment.json is committed, and the keys file is real state. The rehearsal
/// writes sandbox values into both, so they are set aside and put back.
const PRESERVE = ['deployment.json', '.local/nearcraft-keys.json']

async function exists(p) {
  try { await stat(new URL(p, ROOT)); return true } catch { return false }
}

async function setAside() {
  const saved = []
  for (const p of PRESERVE) {
    if (await exists(p)) {
      await copyFile(new URL(p, ROOT), new URL(p + '.dryrun-backup', ROOT))
      saved.push(p)
    }
  }
  return saved
}

async function putBack(saved) {
  for (const p of PRESERVE) {
    await rm(new URL(p, ROOT), { force: true })
    if (saved.includes(p)) {
      await copyFile(new URL(p + '.dryrun-backup', ROOT), new URL(p, ROOT))
      await rm(new URL(p + '.dryrun-backup', ROOT), { force: true })
    }
  }
}

function run(label, args, env) {
  return new Promise((resolve) => {
    console.log(`\n${'─'.repeat(70)}\n  ${label}\n${'─'.repeat(70)}`)
    const child = spawn('node', args, { cwd: ROOT, env, stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
}

const saved = await setAside()
const sandbox = await Sandbox.start({})
let failures = 0

try {
  const env = {
    ...process.env,
    NEAR_RPC: sandbox.rpcUrl,
    NEAR_ROOT_ACCOUNT: DEFAULT_ACCOUNT_ID,
    NEAR_ROOT_KEY: DEFAULT_PRIVATE_KEY,
  }
  console.log(`sandbox at ${sandbox.rpcUrl}, root ${DEFAULT_ACCOUNT_ID}`)

  for (const [label, script] of [
    ['npm run deploy — the real bootstrap', 'scripts/deploy.mjs'],
    // Deploy is meant to be idempotent, and a fresh sandbox never exercises
    // that: every step takes its create branch. A second pass is the only way
    // to test the resume path — which is how an off-by-a-word regex in the
    // "already initialised" guard survived until a live re-run hit it.
    ['npm run deploy AGAIN — the idempotent resume path', 'scripts/deploy.mjs'],
    ['npm run reads — every merchant quote and reason', 'scripts/reads.mjs'],
    ['npm run keys — agent key limits, read back from the chain', 'scripts/keys.mjs'],
  ]) {
    const code = await run(label, [script], env)
    if (code !== 0) {
      console.error(`\n  FAILED: ${script} exited ${code}`)
      failures++
      // Stop at the first failure: reads and keys cannot mean anything if the
      // deploy did not finish.
      break
    }
  }
} finally {
  await sandbox.tearDown()
  await putBack(saved)
  console.log(`\nsandbox down; deployment.json and keys restored`)
}

if (failures) {
  console.error(`\n${failures} step(s) failed — do NOT run this against testnet yet\n`)
  process.exit(1)
}
console.log('\ndeploy, reads and keys all succeeded against a sandbox\n')
