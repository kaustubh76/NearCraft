// Top up a player's spend budget, so the demo does not run out.
//
//   npm run topup                      # top the demo player up to the default
//   npm run topup -- --to 0.05         # aim for 0.05 NEAR of credit
//   npm run topup -- --from stonecutter --account p-xxxx.nearcraftmc.testnet
//   npm run topup -- --dry             # say what it would do and stop
//
// WHY THIS CAN EXIST AT ALL. `market.fund_credit` is **permissionless** — see
// contracts/market/src/lib.rs, where it has no `assert_owner()` while
// `register_merchant` right above it does. Any account that can attach a
// deposit may top up any player's budget. That is deliberate in the contract
// (an agent holding a function-call key cannot attach NEAR, so somebody else
// has to fund it) and it is what makes this script possible without the root
// account, which is too poor to do anything.
//
// I had this wrong once and said in writing that only the contract owner could
// refill credit. It is worth knowing exactly who can spend what.
//
// It spends REAL testnet balance, so it refuses to leave the funding account
// without the gas headroom nearcore reserves (~0.0609 NEAR for a 60 TGas call;
// the arithmetic is in AGENTS.md) and prints every figure it used.

import { readFile } from 'node:fs/promises'
import { Account, JsonRpcProvider } from 'near-api-js'
import { names, provider, rootAccountId, RPC_URL } from './near-env.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const YOCTO = 10n ** 24n
const near = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n
const show = (y) => (Number(y) / 1e24).toFixed(7)

/// What nearcore reserves against a pessimistically inflated gas price for a
/// 60 TGas call. Measured, and the reason a 0.05 NEAR account cannot make one.
const GAS_HEADROOM = near('0.0609')

const manifest = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))
const keys = JSON.parse(await readFile(new URL('../.local/nearcraft-keys.json', import.meta.url), 'utf8'))

const n = names(manifest.root ?? rootAccountId())
const target = near(value('--to', '0.05'))
const fromPrefix = value('--from', 'worker-1')
const fromId = fromPrefix.includes('.') ? fromPrefix : n.sub(fromPrefix)
const account = value('--account', manifest.players?.[0]?.account_id)

if (!account) {
  console.error('\n  No player to top up. Pass --account <id>.\n')
  process.exit(1)
}
const fromKey = keys[fromId]
if (!fromKey) {
  console.error(`\n  No key for ${fromId} in .local/nearcraft-keys.json.`)
  console.error(`  Available: ${Object.keys(keys).filter((k) => !k.includes('#')).join(', ')}\n`)
  process.exit(1)
}

const rpc = provider()
const view = (contractId, method, params = {}) => rpc.callFunction({ contractId, method, args: params })
const balanceOf = async (id) =>
  BigInt((await rpc.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).amount)

const creditBefore = BigInt(await view(n.market, 'credit_of', { account_id: account }))
const fromBefore = await balanceOf(fromId)

console.log(`\n  network   ${manifest.network ?? 'testnet'} via ${RPC_URL}`)
console.log(`  player    ${account}`)
console.log(`  credit    ${show(creditBefore)} NEAR`)
console.log(`  target    ${show(target)} NEAR`)
console.log(`  funder    ${fromId}  holding ${show(fromBefore)} NEAR`)

if (creditBefore >= target) {
  console.log(`\n  Already at or above the target. Nothing to do.\n`)
  process.exit(0)
}

const shortfall = target - creditBefore
const spendable = fromBefore > GAS_HEADROOM ? fromBefore - GAS_HEADROOM : 0n
const amount = shortfall < spendable ? shortfall : spendable

console.log(`  shortfall ${show(shortfall)} NEAR`)
console.log(`  spendable ${show(spendable)} NEAR  (keeping ${show(GAS_HEADROOM)} for one 60 TGas call)`)

if (amount === 0n) {
  console.error(`\n  ${fromId} cannot fund anything without dropping below the gas headroom`)
  console.error(`  nearcore reserves. Pick a richer account with --from, or top it up at`)
  console.error(`  https://near-faucet.io.\n`)
  process.exit(1)
}
if (amount < shortfall) {
  console.log(`\n  NOTE: funding ${show(amount)} of the ${show(shortfall)} shortfall — that is all`)
  console.log(`        ${fromId} can spend without losing its own gas headroom.`)
}

if (flag('--dry')) {
  console.log(`\n  --dry: would send ${show(amount)} NEAR to fund_credit for ${account}. Stopping.\n`)
  process.exit(0)
}

console.log(`\n  funding ${show(amount)} NEAR...`)
const funder = new Account(fromId, new JsonRpcProvider({ url: RPC_URL }), fromKey)
const outcome = await funder.callFunctionRaw({
  contractId: n.market,
  methodName: 'fund_credit',
  args: { account_id: account },
  deposit: amount,
  gas: 60_000_000_000_000n,
})

const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id
if (!hash) {
  console.error('\n  the call returned no transaction hash, so nothing can be verified. Refusing to claim success.\n')
  process.exit(1)
}

// Read it back from the chain rather than trusting the call.
const creditAfter = BigInt(await view(n.market, 'credit_of', { account_id: account }))
const fromAfter = await balanceOf(fromId)
const moved = creditAfter - creditBefore

console.log(`\n  tx        ${hash}`)
console.log(`            https://testnet.nearblocks.io/txns/${hash}`)
console.log(`  credit    ${show(creditBefore)} -> ${show(creditAfter)} NEAR  (+${show(moved)})`)
console.log(`  funder    ${show(fromBefore)} -> ${show(fromAfter)} NEAR`)

if (moved !== amount) {
  console.error(`\n  the credit moved by ${show(moved)} but ${show(amount)} was sent. Something else`)
  console.error('  touched this balance, or the contract did not credit the whole deposit.\n')
  process.exit(1)
}
console.log(`\n  about ${Number(creditAfter / (near('0.0008') || 1n))} more round trips at the current spread.\n`)
