// A real stake in a merchant on public NEAR testnet, and the margin that
// repays it.
//
//   npm run live:stake
//
// The `games` prompt ends its description of merchants with "it closes its shop
// until someone invests in it". `invest` and `invest_with_credit` have been
// built and tested since C3 — against unit tests, against a real nearcore node
// in the sandbox, and through the relayer — but until this script ran, the
// `backers` map that the second migration carried had stayed **empty on the
// public chain**. A mechanic that has never executed where anyone can see it is
// a claim about code, not about a deployment.
//
// What this does, in one run:
//
//   1. an account stakes real NEAR in a merchant;
//   2. the player buys from that same merchant, gaslessly, through the relayer;
//   3. the margin on that sale repays part of the stake, on chain.
//
// ## Two things this does NOT claim, stated here rather than in a footnote
//
// **It is signed with a full-access operator key.** `invest` is `#[payable]`,
// and a function-call access key cannot attach a deposit at all, so the
// scoped-key path is `invest_with_credit`. That path is proven in the sandbox
// (tests/near/gasless.mjs relays it for a key-less player) and is unreachable
// for the live player: its key grants [buy_with_credit, sell] and, because
// onboarding deleted its bootstrap key, can never be given a third method.
// `npm run keys` checks exactly that against the chain.
//
// **The margin here is larger than the design intends**, because most live
// stock predates cost recording. `basis` was introduced by the C2 migration, so
// only units bought by the market *since* then have a recorded cost;
// `cost_of_goods` returns 0 for an unrecorded basis, which makes an unknown
// cost indistinguishable from a free one and reports the whole sale price as
// margin. This script therefore prefers a merchant whose shelf has a real
// recorded basis, prints the cost it actually used, and says which case it hit.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Account, JsonRpcProvider } from 'near-api-js'
import { createRelayer } from '../backend/near/relayer.mjs'
import { transactionHash } from '../backend/near/signer.mjs'

const root = new URL('../', import.meta.url)
const say = (...a) => console.log(...a)
const explorer = (h) => `https://testnet.nearblocks.io/txns/${h}`
const yocto = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(6)

const ITEM = process.env.NEAR_STAKE_ITEM || 'iron_ingot'
const COUNT = Number(process.env.NEAR_STAKE_COUNT || 3)
const STAKE = BigInt(process.env.NEAR_STAKE_YOCTO || 50_000_000_000_000_000_000_000n) // 0.05 NEAR

const manifest = JSON.parse(await readFile(new URL('deployment.json', root), 'utf8'))
const keys = JSON.parse(await readFile(new URL('.local/nearcraft-keys.json', root), 'utf8'))

const market = manifest.contracts.market
const provider = new JsonRpcProvider({ url: manifest.rpc })
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args })

// The investor is an agent account, signing with the operator key its owner
// holds — not with the scoped key the agent process is given.
const investorId = manifest.agents?.[0]?.account_id
if (!investorId) throw new Error('deployment.json lists no agents; run npm run deploy')
const investorKey = keys[investorId]
if (!investorKey) throw new Error(`no full-access key on record for ${investorId}`)

const playerId = manifest.players?.[0]?.account_id
const playerKey = keys[`${playerId}#scoped`]
const relayerId = manifest.relayer?.account_id
const relayerKey = keys[relayerId]
if (!playerId || !playerKey) throw new Error('no live player with a scoped key; run npm run deploy')
if (!relayerId || !relayerKey) throw new Error('no relayer on record; run npm run deploy')

say(`\n  NearCraft — a live stake on NEAR testnet`)
say(`  ${'─'.repeat(62)}`)
say(`  investor ${investorId}  (operator full-access key: invest is payable)`)
say(`  player   ${playerId}  (scoped key, no full-access key)`)
say(`  market   ${market}`)
say(`  rpc      ${manifest.rpc}\n`)

// ------------------------------------------------------- pick the merchant
//
// Prefer a merchant whose shelf carries a recorded cost basis, so the margin
// split runs against a real cost rather than against an unknown one treated as
// zero. On this deployment exactly one shelf qualifies, and it got there by the
// player selling into it.
const quotes = await view(market, 'quotes', { item: ITEM, count: COUNT })
const open = quotes.filter((q) => !q.closed)
if (!open.length) throw new Error(`no merchant is quoting ${ITEM}`)

const withBasis = []
for (const q of open) {
  const basis = await view(market, 'basis_of', { merchant_id: q.merchant_id, item: ITEM })
  withBasis.push({ ...q, basis: BigInt(basis ?? 0) })
}
withBasis.sort((a, b) => (a.basis === b.basis ? Number(BigInt(a.total) - BigInt(b.total)) : (b.basis > a.basis ? 1 : -1)))
const merchant = withBasis[0]
const basisIsReal = merchant.basis > 0n

say(`  merchant ${merchant.merchant_name} (${merchant.merchant_id})`)
say(`    quoting ${COUNT} ${ITEM} at ${yocto(merchant.total)} NEAR, stock ${merchant.stock}`)
say(`    recorded cost basis on that shelf: ${basisIsReal ? yocto(merchant.basis) + ' NEAR' : 'NONE'}`)
if (!basisIsReal) {
  say('    ^ no shelf has a recorded basis, so this sale will report the whole')
  say('      price as margin. That overstates the mechanic — see the header.')
}
say('')

const snapshot = async () => ({
  backer: await view(market, 'backer_of', { merchant_id: merchant.merchant_id }),
  ledger: BigInt(await view(market, 'ledger_total')),
  treasury: BigInt((await view(market, 'merchant', { merchant_id: merchant.merchant_id })).treasury),
  basis: BigInt(await view(market, 'basis_of', { merchant_id: merchant.merchant_id, item: ITEM }) ?? 0),
  playerCredit: BigInt(await view(market, 'credit_of', { account_id: playerId })),
  investorCredit: BigInt(await view(market, 'credit_of', { account_id: investorId })),
})

const before = await snapshot()
say(`  before:  backer ${before.backer ? before.backer.account_id : 'none'}`)
say(`           ledger_total ${yocto(before.ledger)} NEAR, ${merchant.merchant_name} treasury ${yocto(before.treasury)} NEAR\n`)

const failures = []
const check = (ok, msg) => { if (!ok) { failures.push(msg); say(`  ^ FAIL: ${msg}`) } }
const hashes = []

// Every read above is free and credential-light; everything below spends real
// balance and writes to a public chain. NEAR_STAKE_DRYRUN=1 stops here, which
// is how the read paths and the merchant choice get checked without betting a
// stake on the plumbing being right.
if (process.env.NEAR_STAKE_DRYRUN) {
  say(`  DRY RUN — would stake ${yocto(STAKE)} NEAR from ${investorId}, then buy`)
  say(`  ${COUNT} ${ITEM} as ${playerId} through the relayer. Nothing was sent.\n`)
  process.exit(0)
}

// ----------------------------------------------------------------- staking
const investor = new Account(investorId, provider, investorKey)
// `callFunction` returns the method's PARSED RETURN VALUE, not the outcome.
// `invest` returns a boolean, so transactionHash() of it is null — and the one
// artifact this script exists to produce is lost while every assertion still
// passes. `callFunctionRaw` returns the outcome. Found the hard way, on a run
// that staked real NEAR and then wrote the hash down as "null".
const invested = await investor.callFunctionRaw({
  contractId: market,
  methodName: 'invest',
  args: { merchant_id: merchant.merchant_id },
  deposit: STAKE,
  gas: 60_000_000_000_000n,
})
const stakeHash = transactionHash(invested)
// A missing hash is a failed run, not a cosmetic problem: an unverifiable
// claim about a public chain is the one kind this project does not make.
if (!stakeHash) throw new Error('the stake was sent but its transaction hash was not captured')
hashes.push(['stake', stakeHash])
say(`  staked   ${yocto(STAKE)} NEAR in ${merchant.merchant_name}`)

const staked = await snapshot()
check(staked.backer?.account_id === investorId, `backer_of should be ${investorId}, got ${staked.backer?.account_id ?? 'none'}`)
check(BigInt(staked.backer?.principal ?? 0) === STAKE, `principal should be ${STAKE}, got ${staked.backer?.principal}`)
check(BigInt(staked.backer?.repaid ?? 0) === 0n, 'a fresh stake should have been repaid nothing')
// The money invariant, live: a payable deposit enters the ledger exactly once.
check(staked.ledger - before.ledger === STAKE,
  `ledger_total should rise by exactly the stake (${STAKE}), rose by ${staked.ledger - before.ledger}`)
check(staked.treasury - before.treasury === STAKE,
  `treasury should rise by exactly the stake, rose by ${staked.treasury - before.treasury}`)
say(`           backer_of -> ${staked.backer?.account_id}, principal ${yocto(staked.backer?.principal ?? 0)}, repaid ${yocto(staked.backer?.repaid ?? 0)}`)
say(`           ledger_total +${yocto(staked.ledger - before.ledger)} NEAR, treasury +${yocto(staked.treasury - before.treasury)} NEAR\n`)

// ------------------------------------------------- the sale that repays it
//
// Gasless, through the relayer, with the player's scoped key — the same path
// npm run live:player proves, reused here so the repayment is driven by an
// ordinary purchase rather than by anything arranged for the demo.
const relayer = createRelayer({
  relayerAccountId: relayerId,
  relayerKey,
  marketContract: market,
  permittedMethods: manifest.relayer?.relays ?? ['buy_with_credit', 'sell'],
  rpcUrl: manifest.rpc,
})

const affordable = before.playerCredit >= BigInt(merchant.total)
if (!affordable) {
  say(`  the player has ${yocto(before.playerCredit)} NEAR of credit and the order costs ${yocto(merchant.total)}.`)
  say('  Skipping the sale: the stake above is recorded, but nothing repays it in this run.\n')
} else {
  const bought = await relayer.relay({
    playerAccountId: playerId, playerKey, methodName: 'buy_with_credit',
    args: { merchant_id: merchant.merchant_id, item: ITEM, count: COUNT },
  })
  const buyHash = transactionHash(bought.outcome)
  hashes.push(['buy', buyHash])
  say(`  bought   ${COUNT} ${ITEM} from ${merchant.merchant_name}, paid by the player's credit, gas by the relayer`)

  const after = await snapshot()
  const repaid = BigInt(after.backer?.repaid ?? 0)
  const paid = BigInt(merchant.total)
  const costUsed = before.basis === 0n ? 0n : (before.basis * BigInt(COUNT)) / BigInt(merchant.stock)

  check(repaid > 0n, 'the sale should have repaid part of the stake, repaid is still 0')
  check(after.backer?.account_id === investorId, 'the backer should not have changed')
  // A buy moves credit -> treasury -> credit. Every yocto stays inside the
  // ledger, so the total must not move at all.
  check(after.ledger === staked.ledger,
    `a purchase moves money inside the ledger; total should not change, moved by ${after.ledger - staked.ledger}`)

  say(`           repaid   ${yocto(repaid)} NEAR of the ${yocto(STAKE)} stake (${(Number(repaid * 10000n / STAKE) / 100).toFixed(1)}%)`)
  say(`           still owed ${yocto(STAKE - repaid)} NEAR`)
  say(`           ledger_total moved ${yocto(after.ledger - staked.ledger)} NEAR across the purchase (a purchase is internal)\n`)

  say(`  how that number was reached:`)
  say(`    paid by the player        ${yocto(paid)} NEAR`)
  say(`    recorded cost of goods    ${yocto(costUsed)} NEAR${basisIsReal ? '' : '   <- no basis recorded; unknown cost read as zero'}`)
  say(`    margin                    ${yocto(paid - costUsed)} NEAR`)
  say(`    backer's half of it       ${yocto((paid - costUsed) / 2n)} NEAR`)
  if (!basisIsReal || costUsed * 20n < paid) {
    say('')
    say('    Most of this shelf predates the migration that introduced cost')
    say('    recording, so its weighted-average cost is dominated by units whose')
    say('    cost was never written down. The margin above is therefore larger')
    say('    than the design intends. It is bounded — a payout cannot exceed what')
    say('    is owed, or the treasury above its floor — but it is not the number')
    say('    a merchant stocked entirely after C2 would produce.')
  }
  say('')
}

// --------------------------------------------------------------- evidence
for (const [what, h] of hashes) {
  say(`  ${what.padEnd(5)} ${h}`)
  say(`        ${explorer(h)}`)
}

const final = await snapshot()
await mkdir(new URL('evidence/live/', root), { recursive: true })
const file = `stake-${stakeHash}.json`
await writeFile(
  new URL(`evidence/live/${file}`, root),
  JSON.stringify({
    note: 'A real stake in a merchant on public NEAR testnet, recorded in the contract and repaid out of the margin on a real gasless purchase. The stake is signed with a full-access operator key because invest is payable; the scoped-key path is invest_with_credit, which the live player cannot call because its key predates that method and can never be changed.',
    recorded_at: new Date().toISOString(),
    network: 'testnet', rpc: manifest.rpc, economy_scale: manifest.economy_scale,
    investor: investorId, player: playerId, relayer: relayerId,
    market, merchant: merchant.merchant_id, item: ITEM, count: COUNT,
    stake_yocto: STAKE.toString(),
    shelf_had_recorded_basis: basisIsReal,
    basis_before_yocto: before.basis.toString(),
    transactions: Object.fromEntries(hashes.map(([k, h]) => [k, { hash: h, explorer: explorer(h) }])),
    backer_before: before.backer,
    backer_after: final.backer,
    ledger_total_before_yocto: before.ledger.toString(),
    ledger_total_after_yocto: final.ledger.toString(),
    treasury_before_yocto: before.treasury.toString(),
    treasury_after_yocto: final.treasury.toString(),
    checks_failed: failures.length,
  }, null, 2) + '\n',
)
say(`\n  retained -> evidence/live/${file}`)

if (failures.length) {
  console.error(`\n  ${failures.length} assertion(s) FAILED\n`)
  process.exit(1)
}
say('\n  the stake is recorded on chain and the margin is repaying it\n')
