// A player buying AND selling on public NEAR testnet, paying nothing.
//
//   npm run live:player
//
// This is the `games` track's headline requirement — no seed phrase, no wallet
// popup, no gas prompt — measured on a public chain rather than in a sandbox.
// Until this existed, `backend/near/relayer.mjs` was proved only by
// tests/near/gasless.mjs against a local node, and no relayer account had ever
// been deployed, so the claim had no live footprint at all.
//
// SPENDS REAL TESTNET BALANCE, which is why it is not part of npm run evidence.
// Deliberately two transactions, not a loop: this is a proof, not a load test.
//
// What it asserts, and what it cannot:
//   * the player's NEAR balance does not FALL        — the gasless claim
//   * the relayer's balance does fall               — somebody paid, and it was not the player
//   * the player holds no full-access key           — so there is no seed phrase to show
//   * materials actually move, both ways            — the trade was real, not just accepted
//
// The player's balance is asserted `>= 0`, not `== 0`. nearcore refunds unused
// gas to a delegate action's SENDER, which is the player, so the balance can
// RISE by a few hundred yocto. Asserting equality here would be asserting an
// accident, and this project got that wrong once already — see docs/GASLESS.md.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { JsonRpcProvider } from 'near-api-js'
import { createRelayer } from '../backend/near/relayer.mjs'
import { transactionHash } from '../backend/near/signer.mjs'

const root = new URL('../', import.meta.url)
const say = (...a) => console.log(...a)
const explorer = (h) => `https://testnet.nearblocks.io/txns/${h}`
const yocto = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(6)

const manifest = JSON.parse(await readFile(new URL('deployment.json', root), 'utf8'))
const keys = JSON.parse(await readFile(new URL('.local/nearcraft-keys.json', root), 'utf8'))

const playerId = manifest.players?.[0]?.account_id
const relayerId = manifest.relayer?.account_id
if (!playerId) throw new Error('no player in deployment.json — run npm run deploy first')
if (!relayerId) throw new Error('no relayer in deployment.json — run npm run deploy first')

const playerKey = keys[`${playerId}#scoped`]
const relayerKey = keys[relayerId]
if (!playerKey) throw new Error(`no scoped key on record for ${playerId}`)
if (!relayerKey) throw new Error(`no key on record for ${relayerId}`)

const provider = new JsonRpcProvider({ url: manifest.rpc })
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args })
const balance = async (accountId) => BigInt(
  (await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: accountId })).amount,
)

const ITEM = 'iron_ingot'
const COUNT = 2

say('\n  NearCraft — a player buys and sells on NEAR testnet, and pays nothing')
say('  ' + '─'.repeat(66))
say(`  player   ${playerId}`)
say(`  relayer  ${relayerId}`)
say(`  market   ${manifest.contracts.market}`)
say(`  scale    economy_scale ${manifest.economy_scale} — see the README\n`)

// The claim this whole script exists to support: there is no seed phrase,
// because there is no full-access key. Checked against the protocol, not our
// own records, and checked FIRST — if it were false, nothing below would matter.
const accessKeys = await provider.query({
  request_type: 'view_access_key_list', finality: 'optimistic', account_id: playerId,
})
const full = accessKeys.keys.filter((k) => k.access_key.permission === 'FullAccess')
const scoped = accessKeys.keys.filter((k) => k.access_key.permission !== 'FullAccess')
if (full.length) {
  console.error(`  the player holds ${full.length} full-access key(s); the gasless claim is void\n`)
  process.exit(1)
}
for (const k of scoped) {
  const fc = k.access_key.permission.FunctionCall
  say(`  key      function-call -> ${fc.receiver_id}  methods=[${fc.method_names}]`)
}
say(`  keys     ${scoped.length} scoped, 0 full-access — nothing here can move NEAR or add a key\n`)

const relayer = createRelayer({
  relayerAccountId: relayerId,
  relayerKey,
  marketContract: manifest.contracts.market,
  permittedMethods: manifest.relayer.relays,
  rpcUrl: manifest.rpc,
})

const quotes = await view(manifest.contracts.market, 'quotes', { item: ITEM, count: COUNT })
const open = quotes.filter((q) => !q.closed).sort((a, b) => (BigInt(a.unit_price) < BigInt(b.unit_price) ? -1 : 1))
if (!open.length) {
  console.error(`  no merchant is quoting ${ITEM}\n`)
  process.exit(1)
}
const merchant = open[0]
say(`  cheapest ${ITEM}: ${merchant.merchant_name} at ${yocto(merchant.unit_price)} NEAR/unit`)
say(`    "${merchant.reason}"\n`)

const snapshot = async () => ({
  held: String(await view(manifest.contracts.items, 'mt_balance_of', { account_id: playerId, token_id: ITEM })),
  credit: String(await view(manifest.contracts.market, 'credit_of', { account_id: playerId })),
  near: await balance(playerId),
  relayer: await balance(relayerId),
})

const before = await snapshot()
say(`  before:  holds ${before.held} ${ITEM}, credit ${yocto(before.credit)} NEAR, balance ${yocto(before.near)} NEAR`)

const hashes = []

// ------------------------------------------------------------------ buying
//
// `buy_with_credit`, not `buy`: a payable method is unreachable here, because
// nearcore refuses a deposit on a delegate action's inner call. The player
// spends a pre-credited budget instead — which is also why the chain is
// invisible in the game.
const bought = await relayer.relay({
  playerAccountId: playerId, playerKey, methodName: 'buy_with_credit',
  args: { merchant_id: merchant.merchant_id, item: ITEM, count: COUNT },
})
const buyHash = transactionHash(bought.outcome)
hashes.push(['buy', buyHash])
// Not printing `bought.relayerPaid` here on purpose. It is measured
// immediately either side of the call, before nearcore has credited the unused
// gas back, so it overstates the cost by more than an order of magnitude — the
// two per-call figures summed to 0.076 NEAR on a run whose real cost was
// 0.0015. The settled total is measured at the end instead.
say(`  bought   ${COUNT} ${ITEM}`)

const mid = await snapshot()
if (BigInt(mid.held) <= BigInt(before.held)) {
  console.error('  the player did not receive the materials\n')
  process.exit(1)
}

// ------------------------------------------------------------------ selling
//
// The half that did not work until NEP-245 Approval Management was implemented.
// `market.sell` is non-payable so a scoped key can call it, and the market pulls
// the materials under the player's standing approval, attaching the 1 yoctoNEAR
// the standard demands from its OWN balance.
const approval = await view(manifest.contracts.items, 'mt_token_approval', {
  token_id: ITEM, account_id: playerId,
})
const grant = approval.approved_account_ids?.[manifest.contracts.market]
if (!grant) {
  console.error(`  the market has no approval to pull ${playerId}'s ${ITEM}; selling is impossible\n`)
  process.exit(1)
}
say(`  approval id ${grant.approval_id}, up to ${grant.amount} ${ITEM} — granted at onboarding, never since`)

const sold = await relayer.relay({
  playerAccountId: playerId, playerKey, methodName: 'sell',
  args: { merchant_id: merchant.merchant_id, item: ITEM, count: COUNT, approval_id: grant.approval_id },
  gas: 100_000_000_000_000n,
})
const sellHash = transactionHash(sold.outcome)
hashes.push(['sell', sellHash])
say(`  sold     ${COUNT} ${ITEM} back`)

const after = await snapshot()
say('')
say(`  after:   holds ${after.held} ${ITEM}, credit ${yocto(after.credit)} NEAR, balance ${yocto(after.near)} NEAR`)

// ------------------------------------------------------------- the assertions
const playerDelta = after.near - before.near
const relayerDelta = before.relayer - after.relayer
say('')
say(`  player's NEAR balance moved by ${playerDelta >= 0n ? '+' : ''}${yocto(playerDelta < 0n ? -playerDelta : playerDelta)} NEAR`)
say(`  relayer paid ${yocto(relayerDelta)} NEAR for both calls, once refunds settled`)

let failed = false
if (playerDelta < 0n) {
  console.error('\n  FAIL: the player paid for something. That is a gas prompt waiting to happen.')
  failed = true
}
if (relayerDelta <= 0n) {
  console.error('\n  FAIL: the relayer did not pay. Then who did?')
  failed = true
}
if (BigInt(after.held) !== BigInt(before.held)) {
  console.error(`\n  FAIL: expected the ${ITEM} to come back out again, held ${before.held} -> ${after.held}`)
  failed = true
}

say('')
for (const [what, h] of hashes) {
  say(`  ${what.padEnd(5)} ${h}`)
  say(`        ${explorer(h)}`)
}

await mkdir(new URL('evidence/live/', root), { recursive: true })
const file = `player-gasless-${buyHash}.json`
await writeFile(
  new URL(`evidence/live/${file}`, root),
  JSON.stringify({
    note: 'A real player buying and selling on public NEAR testnet while holding NO full-access key, paying nothing. Gas was paid by the relayer via NEP-366 meta transactions.',
    recorded_at: new Date().toISOString(),
    network: 'testnet', rpc: manifest.rpc, economy_scale: manifest.economy_scale,
    player: playerId, relayer: relayerId,
    market: manifest.contracts.market, merchant: merchant.merchant_id,
    item: ITEM, count: COUNT,
    player_full_access_keys: full.length,
    player_scoped_keys: scoped.length,
    transactions: Object.fromEntries(hashes.map(([k, h]) => [k, { hash: h, explorer: explorer(h) }])),
    player_near_delta_yocto: playerDelta.toString(),
    relayer_paid_yocto: relayerDelta.toString(),
    balances: {
      held_before: before.held, held_after: after.held,
      credit_before: before.credit, credit_after: after.credit,
      player_near_before: before.near.toString(), player_near_after: after.near.toString(),
    },
  }, null, 2) + '\n',
)
say(`\n  retained -> evidence/live/${file}\n`)

process.exit(failed ? 1 : 0)
