// The plugin's HTTP contract, tested without a chain.
//
// The Minecraft plugin builds no NEAR requests itself — it enqueues an action
// and the backend turns it into a call. These are those turnings. A wrong field
// name here is invisible until a player loses an item, so they get asserted
// rather than eyeballed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buyRequest, displayNear, MarketRequestError, menuRows,
  PLAYER_GAS, quoteRequest, quotesRequest, sellRequest,
} from '../../backend/near/market.mjs'

const MARKET = 'market.nearcraftmc.testnet'
const ITEMS = 'items.nearcraftmc.testnet'
const MERCHANT = 'ironmonger.nearcraftmc.testnet'

function refuses(code, fn) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof MarketRequestError, `expected MarketRequestError, got ${e?.name}`)
    assert.equal(e.code, code, `expected ${code}, got ${e.code}`)
    return true
  })
}

test('a quotes view asks for every merchant on one material', () => {
  assert.deepEqual(quotesRequest({ marketContract: MARKET, item: 'iron_ingot', count: 8 }), {
    contractId: MARKET,
    // Views take `method`, not `methodName` — near-api-js v7 differs between
    // provider.callFunction and account.callFunction, and mixing them up fails
    // at runtime rather than at build time.
    method: 'quotes',
    args: { item: 'iron_ingot', count: 8 },
  })
})

test('a single-merchant quote names the merchant', () => {
  const r = quoteRequest({ marketContract: MARKET, merchantId: MERCHANT, item: 'oak_log', count: 1 })
  assert.equal(r.method, 'quote')
  assert.deepEqual(r.args, { merchant_id: MERCHANT, item: 'oak_log', count: 1 })
})

test('a buy carries the quoted total as a deposit, never a number', () => {
  const total = '4000000000000000000000000' // 4 NEAR
  const r = buyRequest({ marketContract: MARKET, merchantId: MERCHANT, item: 'iron_ingot', count: 10, total })
  assert.equal(r.methodName, 'buy', 'change calls take methodName')
  assert.deepEqual(r.args, { merchant_id: MERCHANT, item: 'iron_ingot', count: 10 })
  assert.equal(r.deposit, BigInt(total))
  assert.equal(typeof r.deposit, 'bigint', 'a 24-digit amount must never pass through a JS number')
  assert.equal(r.gas, PLAYER_GAS)
})

test('a total that is not a yocto string is refused', () => {
  const base = { marketContract: MARKET, merchantId: MERCHANT, item: 'iron_ingot', count: 1 }
  // A float would silently lose precision; a number would too, above 2^53.
  for (const total of [4e24, 4.5, '4.0', '-1', '0x10', '', null, undefined, '4 NEAR']) {
    refuses('TOTAL_NOT_A_YOCTO_STRING', () => buyRequest({ ...base, total }))
  }
  refuses('TOTAL_IS_ZERO', () => buyRequest({ ...base, total: '0' }))
})

test('a sale routes through the items contract, not the market', () => {
  const r = sellRequest({ itemsContract: ITEMS, marketContract: MARKET, merchantId: MERCHANT, item: 'iron_ingot', count: 12 })
  assert.equal(r.contractId, ITEMS, 'mt_transfer_call lives on the items contract')
  assert.equal(r.methodName, 'mt_transfer_call')
  assert.deepEqual(r.args, {
    receiver_id: MARKET,
    token_id: 'iron_ingot',
    amount: '12',          // NEP-245 amounts are strings
    approval: null,        // the push path carries no approval; market.sell uses one
    memo: null,
    msg: MERCHANT,         // the market reads this to know who is buying
  })
  assert.equal(r.deposit, 1n, 'NEP-245 requires exactly 1 yoctoNEAR')
})

test('counts are held to a Minecraft stack', () => {
  const base = { marketContract: MARKET, merchantId: MERCHANT, item: 'iron_ingot', total: '1' }
  // A menu offering more than 64 would be promising a delivery it cannot make
  // in one inventory slot.
  for (const count of [0, -1, 65, 1000, 1.5, '8', null]) {
    refuses('COUNT_OUT_OF_STACK_RANGE', () => buyRequest({ ...base, count }))
  }
  assert.equal(buyRequest({ ...base, count: 64 }).args.count, 64)
  assert.equal(buyRequest({ ...base, count: 1 }).args.count, 1)
})

test('malformed items and accounts are refused', () => {
  refuses('ITEM_MALFORMED', () => quotesRequest({ marketContract: MARKET, item: 'Iron Ingot', count: 1 }))
  refuses('ITEM_MALFORMED', () => quotesRequest({ marketContract: MARKET, item: '../../etc/passwd', count: 1 }))
  refuses('ITEM_MALFORMED', () => quotesRequest({ marketContract: MARKET, item: '', count: 1 }))
  refuses('MARKET_CONTRACT_MALFORMED', () => quotesRequest({ marketContract: 'NOT AN ACCOUNT', item: 'stone', count: 1 }))
  refuses('MERCHANT_ID_MALFORMED', () =>
    quoteRequest({ marketContract: MARKET, merchantId: 'Bad Merchant', item: 'stone', count: 1 }))
})

// ------------------------------------------------------------ menu rendering

const QUOTES = [
  {
    merchant_id: 'stonecutter.nearcraftmc.testnet', merchant_name: 'Stonecutter',
    unit_price: '600000000000000000000000', total: '600000000000000000000000',
    merchant_bid: '480000000000000000000000', stock: '2048', band: 'glutted',
    demand_bps: '10000', closed: false, reason: 'Stonecutter holds 2048 (glutted); demand is quiet.',
  },
  {
    merchant_id: 'ironmonger.nearcraftmc.testnet', merchant_name: 'Ironmonger',
    unit_price: '400000000000000000000000', total: '400000000000000000000000',
    merchant_bid: null, stock: '12', band: 'nearly gone',
    demand_bps: '14000', closed: true,
    reason: 'Ironmonger holds 12 (nearly gone) but will not buy more: it has 0.020 NEAR left to spend and one costs 0.320.',
  },
]

test('menu rows are cheapest-first and keep the contract reason verbatim', () => {
  const rows = menuRows(QUOTES)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].merchantName, 'Ironmonger', 'cheapest first — that is what makes a player walk')
  assert.ok(BigInt(rows[0].unitPrice) < BigInt(rows[1].unitPrice))
  // The reason is built inside the contract from the same numbers the price came
  // from. Rewording it here would break that guarantee.
  assert.equal(rows[0].reason, QUOTES[1].reason)
  assert.equal(rows[1].reason, QUOTES[0].reason)
})

test('a merchant posting no bid is marked not-buying, not bid-zero', () => {
  const rows = menuRows(QUOTES)
  const closed = rows.find((r) => r.merchantName === 'Ironmonger')
  assert.equal(closed.bid, null)
  assert.equal(closed.buying, false, 'the menu must not offer a sell button that would fail')
  assert.equal(closed.closed, true)

  const open = rows.find((r) => r.merchantName === 'Stonecutter')
  assert.equal(open.buying, true)
  assert.equal(open.bid, '480000000000000000000000')
})

test('menuRows refuses a non-array rather than coercing', () => {
  for (const bad of [null, undefined, {}, 'quotes', 42]) {
    refuses('QUOTES_NOT_AN_ARRAY', () => menuRows(bad))
  }
})

test('display amounts are short and never raw yocto', () => {
  assert.equal(displayNear('0'), '0.000')
  assert.equal(displayNear('400000000000000000000000'), '0.400')
  assert.equal(displayNear('1000000000000000000000000'), '1.000')
  assert.equal(displayNear('1234250000000000000000000000'), '1234.250')
  // A lore line is a few characters wide; a 25-digit integer is not a price.
  assert.ok(displayNear('88944000000000000000000000').length < 12)
})
