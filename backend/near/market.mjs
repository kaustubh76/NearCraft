// What the Minecraft plugin asks the chain, and how.
//
// The plugin is a Paper (Java) server that renders menus and delivers items. It
// speaks plain HTTP+JSON to this module over loopback and never touches NEAR
// itself — which is why a player never sees a wallet, a seed phrase or a gas
// prompt. Every request shape here is built by a pure function so it can be
// tested without a chain, because the plugin's correctness depends on these
// shapes being exactly right and a wrong one is invisible until a player loses
// an item.

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
      // The multiplier the price rule applied for recent demand. The web page
      // shows it beside the ask so a reader can check the reason string against
      // the number it was built from.
      demandBps: q.demand_bps ?? null,
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

/// A NEAR view call over plain JSON-RPC.
///
/// Deliberately written with `fetch` rather than near-api-js so this module has
/// no imports at all and the same code runs in Node and in the browser. The
/// alternative — a second copy of the read logic inside web/market.html — is the
/// duplication that bit us once already with the onboarding bootstrap.
async function viewCall(rpcUrl, { contractId, method, args }) {
  const bytes = new TextEncoder().encode(JSON.stringify(args))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nearcraft',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: btoa(binary),
      },
    }),
  })
  if (!res.ok) throw new MarketRequestError('RPC_HTTP_ERROR', `${res.status} ${res.statusText}`)

  const body = await res.json()
  // Two distinct failure shapes: a transport/node-level error at the top level,
  // and a contract panic nested under result.error. Both must surface, because
  // a silently-empty read would render an empty market that looks deployed.
  if (body.error) {
    throw new MarketRequestError('RPC_ERROR', body.error.data?.toString?.() ?? JSON.stringify(body.error))
  }
  if (body.result?.error) throw new MarketRequestError('CONTRACT_ERROR', body.result.error)
  if (!Array.isArray(body.result?.result)) throw new MarketRequestError('RPC_RESULT_MALFORMED')

  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)))
}

/// Read-only market client. Needs no key and no credentials, and runs in both
/// Node and the browser.
export function createMarketReader({ marketContract, itemsContract, rpcUrl = 'https://test.rpc.fastnear.com' }) {
  return Object.freeze({
    rpcUrl,
    async quotes(item, count) {
      return menuRows(await viewCall(rpcUrl, quotesRequest({ marketContract, item, count })))
    },
    async merchants() {
      return viewCall(rpcUrl, {
        contractId: requireAccount(marketContract, 'MARKET_CONTRACT_MALFORMED'),
        method: 'merchants',
        args: {},
      })
    },
    /// Every material the items contract knows about. Read from the chain rather
    /// than a hardcoded list, so a material minted later needs no code change.
    async materials() {
      const tokens = await viewCall(rpcUrl, {
        contractId: requireAccount(itemsContract, 'ITEMS_CONTRACT_MALFORMED'),
        method: 'mt_tokens',
        args: { from_index: '0', limit: 64 },
      })
      if (!Array.isArray(tokens)) throw new MarketRequestError('TOKENS_NOT_AN_ARRAY')
      return tokens.map((t) => t.token_id)
    },
    async heldBy(accountId, tokenIds) {
      return viewCall(rpcUrl, {
        contractId: requireAccount(itemsContract, 'ITEMS_CONTRACT_MALFORMED'),
        method: 'mt_batch_balance_of',
        args: { account_id: requireAccount(accountId, 'ACCOUNT_MALFORMED'), token_ids: tokenIds.map(requireItem) },
      })
    },
  })
}
