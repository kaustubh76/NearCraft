// Build the ONLY key material that leaves this machine for the hosted play
// service, and prove by construction that it is the smallest set that works.
//
// .local/nearcraft-keys.json holds 16 entries, three of which are the
// items/market/guard CONTRACT accounts — i.e. authority to redeploy the live
// economy and migrate its state. Uploading that file to any host would hand a
// third party the project. So this writes a NEW file containing exactly two
// entries:
//
//   <relayer>              the gas payer. Full-access by necessity: a
//                          SignedDelegate is not a function call, so a scoped
//                          key cannot submit one (deployment.json relayer note).
//   <player>#scoped        one player's function-call key. Bounded by the
//                          protocol, not by trust: one contract, a named method
//                          list, no transfer, no AddKey.
//
// The ROOT key is deliberately absent. serve-play.mjs:151 then leaves rootKey
// null, /api/health reports canOnboard:false, and a new identity gets the
// ONBOARDING_MISCONFIGURED refusal play.mjs:305 already defines. That is what
// shuts the faucet: seed login accepts any string and funds a new account from
// root, so the only safe public posture is for there to be no root key to spend.
//
// Nothing here prints a key. The output is written 0600 under .tmp/, which is
// gitignored, and the console gets names and a fingerprint only.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const all = JSON.parse(await readFile(new URL('.local/nearcraft-keys.json', ROOT), 'utf8'))

/// Default: the player deployment.json records as the one `npm run mc:up` demos.
const player = process.argv[2] ?? 'p-62b0b2438ca03ae4.nearcraftmc.testnet'
const relayer = manifest.relayer.account_id

/// Accounts whose keys must never leave this machine, checked against what was
/// ASKED FOR rather than against what was selected.
///
/// The first version of this check read the finished output. That output is
/// built as [relayer, player#scoped], and the player has to appear in
/// manifest.players to get that far — so no forbidden id could ever reach it and
/// the check could not fail. That is the same shape of bug this repository has
/// found four times now: a check placed where it cannot fire. Validating the
/// REQUEST makes it reachable, and `node scripts/build-render-secret.mjs
/// items.nearcraftmc.testnet` demonstrates it.
const FORBIDDEN = [manifest.root, ...Object.values(manifest.contracts),
  ...manifest.merchants.map((m) => m.account_id), ...manifest.agents.map((a) => a.account_id)]

if (FORBIDDEN.includes(player)) {
  const role = player === manifest.root ? 'the root account: it funds and creates every player'
    : Object.values(manifest.contracts).includes(player) ? 'a CONTRACT account: its key can redeploy and migrate the live economy'
    : 'a merchant or agent account'
  console.error(`\n  REFUSING. ${player} is ${role}.`)
  console.error('  Its key must never leave this machine.\n')
  process.exit(1)
}

const listed = manifest.players.find((p) => p.account_id === player)
if (!listed) {
  console.error(`\n  ${player} is not a player in deployment.json. Refusing to ship a key`)
  console.error('  for an account this deployment does not claim.\n')
  process.exit(1)
}

const wanted = [relayer, `${player}#scoped`]

const out = {}
for (const name of wanted) {
  if (typeof all[name] !== 'string') {
    console.error(`\n  ${name} is not in .local/nearcraft-keys.json. Nothing to ship.\n`)
    process.exit(1)
  }
  out[name] = all[name]
}

/// A second, independent reading of the finished file: exactly the two intended
/// names, and nothing forbidden, whatever the code above did. Cheap, and the
/// cost of being wrong here is someone else owning the contracts.
const got = Object.keys(out).sort().join(',')
const want = [...wanted].sort().join(',')
if (got !== want) {
  console.error(`\n  REFUSING. The file would hold ${got}\n  but should hold exactly ${want}.\n`)
  process.exit(1)
}
const leaked = Object.keys(out).filter((name) =>
  FORBIDDEN.some((bad) => name === bad || name.startsWith(`${bad}#`)))
if (leaked.length > 0) {
  console.error('\n  REFUSING. These must never leave this machine:\n')
  for (const name of leaked) console.error(`    ${name}`)
  console.error('')
  process.exit(1)
}

const dir = new URL('.tmp/render/', ROOT)
await mkdir(dir, { recursive: true })
const file = new URL('nearcraft-keys.json', dir)
const body = JSON.stringify(out, null, 2) + '\n'
await writeFile(file, body, { mode: 0o600 })

console.log(`\n  wrote ${Object.keys(out).length} of ${Object.keys(all).length} key(s) to .tmp/render/nearcraft-keys.json (0600)\n`)
for (const name of Object.keys(out)) {
  const role = name.endsWith('#scoped') ? 'function-call, one contract' : 'full-access (gas payer)'
  console.log(`    ${name}`)
  console.log(`      ${role}`)
}
console.log(`\n  withheld: ${manifest.root} (root), ${Object.values(manifest.contracts).join(', ')},`)
console.log(`            ${manifest.merchants.length} merchant(s), ${manifest.agents.length} agent(s)`)
console.log(`\n  sha256(file) ${createHash('sha256').update(body).digest('hex').slice(0, 32)}…`)
console.log('  No root key, so this instance cannot create accounts: canOnboard will be false.\n')
