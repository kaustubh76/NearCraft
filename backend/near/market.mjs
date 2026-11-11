// What the Minecraft plugin asks the chain, and how.
//
// The plugin is a Paper (Java) server that renders menus and delivers items. It
// speaks plain HTTP+JSON to this module over loopback and never touches NEAR
// itself — which is why a player never sees a wallet, a seed phrase or a gas
// prompt. Every request shape here is built by a pure function so it can be
// tested without a chain, because the plugin's correctness depends on these
// shapes being exactly right and a wrong one is invisible until a player loses
// an item.

import { JsonRpcProvider } from 'near-api-js'

/// Gas for a player purchase: one cross-contract mt_transfer plus the rollback
/// callback. Players sign with a full-access key so there is no allowance
/// ceiling to respect, unlike an agent (see policy.mjs).
export const PLAYER_GAS = 100_000_000_000_000n

/// Materials a player may name. The plugin sends Minecraft item ids, which are
/// lowercase with underscores, and the contract's token ids are the same
/// strings — that is the whole point of using the material name as the token id.
const ITEM = /^[a-z][a-z0-9_]{1,30}$/
const ACCOUNT = /^[a-z0-9._-]{2,64}$/

export class MarketRequestError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'MarketRequestError'
    this.code = code
    this.detail = detail
  }
}

function requireItem(item) {
  if (!ITEM.test(String(item ?? ''))) throw new MarketRequestError('ITEM_MALFORMED', String(item))
  return String(item)
}

function requireAccount(id, code) {
  if (!ACCOUNT.test(String(id ?? ''))) throw new MarketRequestError(code, String(id))
  return String(id)
}

/// Minecraft stacks are 1..64. A menu that offered more would be lying about
/// what it can deliver in one inventory slot.
function requireCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new MarketRequestError('COUNT_OUT_OF_STACK_RANGE', String(count))
  }
  return count
}

// -------------------------------------------------------------------- reads

/// A view request for every merchant's quote on one material. Pure.
export function quotesRequest({ marketContract, item, count }) {
  return {
    contractId: requireAccount(marketContract, 'MARKET_CONTRACT_MALFORMED'),
    method: 'quotes',
    args: { item: requireItem(item), count: requireCount(count) },
  }
}

/// A view request for one merchant's quote. Pure.
export function quoteRequest({ marketContract, merchantId, item, count }) {
  return {
    contractId: requireAccount(marketContract, 'MARKET_CONTRACT_MALFORMED'),
    method: 'quote',
    args: {
      merchant_id: requireAccount(merchantId, 'MERCHANT_ID_MALFORMED'),
      item: requireItem(item),
      count: requireCount(count),
    },
  }
}

// ------------------------------------------------------------------ writes

/// A player purchase. Pure: builds the call, signs nothing.
///
/// `deposit` is the quoted total, passed through as a string so a 24-digit
/// yoctoNEAR amount never touches a JS number.
export function buyRequest({ marketContract, merchantId, item, count, total }) {
  if (typeof total !== 'string' || !/^[0-9]+$/.test(total)) {
    throw new MarketRequestError('TOTAL_NOT_A_YOCTO_STRING', String(total))
  }
  if (total === '0') throw new MarketRequestError('TOTAL_IS_ZERO')
  return {
    contractId: requireAccount(marketContract, 'MARKET_CONTRACT_MALFORMED'),
    methodName: 'buy',
    args: {
      merchant_id: requireAccount(merchantId, 'MERCHANT_ID_MALFORMED'),
      item: requireItem(item),
      count: requireCount(count),
    },
    gas: PLAYER_GAS,
    deposit: BigInt(total),
  }
}

/// A player sale. Routed through NEP-245's transfer-and-call on the *items*
/// contract, with the merchant account id as `msg` — the market contract's
/// `mt_on_transfer` reads that to know who is buying.
export function sellRequest({ itemsContract, marketContract, merchantId, item, count }) {
  return {
    contractId: requireAccount(itemsContract, 'ITEMS_CONTRACT_MALFORMED'),
    methodName: 'mt_transfer_call',
    args: {
      receiver_id: requireAccount(marketContract, 'MARKET_CONTRACT_MALFORMED'),
      token_id: requireItem(item),
      amount: String(requireCount(count)),
      approval: null,
      memo: null,
      msg: requireAccount(merchantId, 'MERCHANT_ID_MALFORMED'),
    },
    gas: PLAYER_GAS,
    // NEP-245 requires exactly 1 yoctoNEAR on a transfer.
    deposit: 1n,
  }
}

// ------------------------------------------------------- menu presentation

/// Turn contract quotes into what the plugin renders: one row per merchant,
/// cheapest first, each carrying the contract's own `reason` string.
///
/// The reason is passed through untouched. It is built inside the contract from
/// the same numbers the price came from, so it cannot drift from the price — and
/// rewording it here would break that guarantee.
export function menuRows(quotes) {
  if (!Array.isArray(quotes)) throw new MarketRequestError('QUOTES_NOT_AN_ARRAY')
  return quotes
    .map((q) => ({
      merchantId: q.merchant_id,
      merchantName: q.merchant_name,
      unitPrice: q.unit_price,
      total: q.total,
      // null means the merchant is not buying — the menu must show that rather
      // than offering a sell button that would fail.
      bid: q.merchant_bid ?? null,
      buying: q.merchant_bid != null,
      stock: Number(q.stock),
      band: q.band,
      closed: Boolean(q.closed),
      reason: q.reason,
    }))
    .sort((a, b) => (BigInt(a.unitPrice) < BigInt(b.unitPrice) ? -1 : 1))
}

/// Yocto to a short display string for a Minecraft lore line.
export function displayNear(yocto) {
  const s = BigInt(yocto).toString().padStart(25, '0')
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, '')
  const frac = s.slice(-24).slice(0, 3)
  return `${whole}.${frac}`
}

// ------------------------------------------------------------------ runtime

/// Read-only market client. Needs no key and no credentials.
export function createMarketReader({ marketContract, itemsContract, rpcUrl = 'https://test.rpc.fastnear.com' }) {
  const provider = new JsonRpcProvider({ url: rpcUrl })
  return Object.freeze({
    async quotes(item, count) {
      const { contractId, method, args } = quotesRequest({ marketContract, item, count })
      return menuRows(await provider.callFunction({ contractId, method, args }))
    },
    async merchants() {
      return provider.callFunction({ contractId: marketContract, method: 'merchants', args: {} })
    },
    async heldBy(accountId, tokenIds) {
      return provider.callFunction({
        contractId: itemsContract,
        method: 'mt_batch_balance_of',
        args: { account_id: requireAccount(accountId, 'ACCOUNT_MALFORMED'), token_ids: tokenIds.map(requireItem) },
      })
    },
  })
}
