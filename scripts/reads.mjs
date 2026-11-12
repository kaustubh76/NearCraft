// Read the live market. No credentials, no signing, no Minecraft.
//
//   npm run reads
//
// Every number below comes from a view call against the deployed contracts, and
// the `reason` line is the same string the in-game tooltip renders.

import { readFile } from 'node:fs/promises'
import { fromYocto, names, provider, rootAccountId } from './near-env.mjs'

const p = provider()
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

const n = names(manifest.root || rootAccountId())
const view = (contractId, method, args = {}) => p.callFunction({ contractId, method, args })

console.log(`\nNearCraft market — ${n.market}`)
console.log(`rpc ${manifest.rpc}\n`)

// -------------------------------------------------------------- merchants

const problems = []

const merchants = await view(n.market, 'merchants')
console.log('merchants')
// A deployment that answers nothing is not a deployment that answered.
//
// This script had exactly one failure path — a missing deployment.json — and
// otherwise could not report a problem, while capture-evidence.mjs retained it
// as proof that "the deployed contracts on NEAR testnet answered a public,
// credential-free query". It is one of only two live-chain checks in that
// record, so part of the claim to have touched the real chain rested on a
// script that always passed.
if (!merchants.length) problems.push('the market contract reports no merchants at all')
if (!manifest.materials?.length) problems.push('deployment.json records no materials')
for (const [id, m] of merchants) {
  const closed = BigInt(m.treasury) <= BigInt(m.floor)
  console.log(
    `  ${m.name.padEnd(14)} ${id.padEnd(34)} treasury ${fromYocto(m.treasury).padStart(10)} NEAR` +
    `  floor ${fromYocto(m.floor)}  ${closed ? 'CLOSED to buying' : 'open'}`
  )
}

// ----------------------------------------------------------------- quotes

console.log('\nquotes (8 units)')
let quotedAnything = false
for (const item of manifest.materials) {
  const quotes = await view(n.market, 'quotes', { item, count: 8 })
  if (!quotes.length) continue
  quotedAnything = true
  // Cheapest first: this is the information that makes a player walk.
  quotes.sort((a, b) => (BigInt(a.unit_price) < BigInt(b.unit_price) ? -1 : 1))
  console.log(`\n  ${item}`)
  for (const q of quotes) {
    const bid = q.merchant_bid ? `${fromYocto(q.merchant_bid)} NEAR` : '— (closed)'
    console.log(
      `    ${q.merchant_name.padEnd(14)} ask ${fromYocto(q.unit_price).padStart(8)}` +
      `  bid ${bid.padStart(14)}  stock ${String(q.stock).padStart(5)} (${q.band})` +
      `  demand ${(Number(q.demand_bps) / 10000).toFixed(2)}x`
    )
    console.log(`      ${q.reason}`)
  }
}

// ------------------------------------------------- the shop floor on-chain

console.log('\nmarket-held NEP-245 balances (the shop floor pool)')
const balances = await view(n.items, 'mt_batch_balance_of', {
  account_id: n.market,
  token_ids: manifest.materials,
})
manifest.materials.forEach((item, i) => {
  console.log(`  ${item.padEnd(14)} ${String(balances[i]).padStart(8)}`)
})

const catalogue = await view(n.items, 'mt_tokens', { from_index: null, limit: null })
console.log(`\nNEP-245 catalogue: ${catalogue.length} token ids in one contract (${n.items})`)
console.log()

// ----------------------------------------------------------------- verdict

if (!quotedAnything) {
  problems.push('no merchant quoted a price for any material in the catalogue')
}

if (problems.length) {
  console.error(`\nthe deployment did not answer as expected (${problems.length}):`)
  for (const x of problems) console.error(`  ${x}`)
  console.error('')
  process.exit(1)
}
console.log(
  `\nread ${merchants.length} merchant(s) and ${manifest.materials.length} material(s) ` +
  'from the deployed contracts, with no credentials\n',
)
