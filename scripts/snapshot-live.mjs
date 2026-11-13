// Everything the live contracts will admit to, as one comparable blob.
//
//   npm run snapshot -- before.json
//   ...redeploy...
//   npm run snapshot -- after.json
//   npm run snapshot -- --diff before.json after.json
//
// `scripts/redeploy.mjs` probes ONE view per contract, which answers "is it
// bricked". This answers the other question: did any number move. The money
// semantics changed when `sell`, `buy` and `restock` stopped paying up front
// and started paying on their callbacks, so "it still answers" is not the bar
// for a redeploy — "nothing moved" is.
//
// Exit code is the gate: 0 when every value is identical, 1 when any moved, so
// it can sit in front of a deploy rather than beside it. The code hash is
// expected to change and is reported rather than counted.
//
// Read-only. Every call here is a VIEW; this script cannot write anything.
import { readFile, writeFile } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))
const RPC = manifest.rpc
const C = manifest.contracts

/// Every read retries, because a public RPC will rate-limit 169 of them.
///
/// The first version did not, and the gate reported 56 values as MOVED on a
/// redeploy where nothing had moved: FastNear answered "Rate limits exceeded"
/// for the tail of the run and the diff compared that error against the real
/// value. A gate that cries wolf gets ignored, which is worse than no gate —
/// so a throttled read waits and asks again rather than becoming a finding.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(params, attempt = 0) {
  let j
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'query', params }),
    })
    j = await r.json()
  } catch (e) {
    j = { error: { message: String(e?.message ?? e) } }
  }
  const err = j.error ?? j.result?.error
  if (err) {
    const text = String(err?.data ?? err?.message ?? err)
    // Throttling and transport hiccups are worth waiting out. A contract that
    // panicked is a real answer and is returned as one.
    const retriable = /rate limit|too many requests|timeout|ECONN|socket|fetch failed|503|502/i.test(text)
    if (retriable && attempt < 6) {
      await sleep(400 * 2 ** attempt)
      return rpc(params, attempt + 1)
    }
    return { ERROR: text.slice(0, 160) }
  }
  return j.result
}

const call = async (contractId, method, args = {}) => {
  const res = await rpc({
    request_type: 'call_function', finality: 'optimistic',
    account_id: contractId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  })
  if (res?.ERROR) return res
  return JSON.parse(Buffer.from(res.result).toString())
}

const codeHash = async (id) => {
  const res = await rpc({ request_type: 'view_account', finality: 'optimistic', account_id: id })
  return res?.code_hash ?? 'UNREADABLE'
}

async function snapshot() {
  const players = (manifest.players ?? []).map((p) => p.account_id ?? p)
  const agents = (manifest.agents ?? []).map((a) => a.account_id ?? a)
  const merchants = (manifest.merchants ?? []).map((m) => m.account_id ?? m.merchant_id ?? m)
  const materials = (manifest.materials ?? []).map((m) => m.item ?? m)

  const out = { code: {}, market: {}, items: {}, guard: {} }
  for (const [k, id] of Object.entries(C)) out.code[k] = await codeHash(id)

  out.market.ledger_total = await call(C.market, 'ledger_total')
  out.market.merchants = await call(C.market, 'merchants')
  out.market.items_contract = await call(C.market, 'items_contract')
  for (const m of merchants) {
    out.market[`merchant:${m}`] = await call(C.market, 'merchant', { merchant_id: m })
    out.market[`closed:${m}`] = await call(C.market, 'is_closed', { merchant_id: m })
    for (const item of materials) {
      const q = await call(C.market, 'quote', { merchant_id: m, item, count: 1 })
      // Skip the materials this merchant does not deal in, so the blob stays
      // about state rather than about which errors each pair produces.
      if (!q.ERROR) out.market[`quote:${m}:${item}`] = q
    }
  }
  for (const who of [...players, ...agents, ...merchants]) {
    out.market[`credit:${who}`] = await call(C.market, 'credit_of', { account_id: who })
  }

  for (const item of materials) out.items[`supply:${item}`] = await call(C.items, 'mt_supply', { token_id: item })
  for (const who of [...players, ...agents, C.market]) {
    for (const item of materials) {
      out.items[`balance:${who}:${item}`] = await call(C.items, 'mt_balance_of', { account_id: who, token_id: item })
    }
    for (const item of materials) {
      const a = await call(C.items, 'mt_token_approval', { token_id: item, account_id: who })
      if (!a.ERROR) out.items[`approval:${who}:${item}`] = a
    }
  }
  out.guard.threshold = await call(C.guard, 'threshold')
  for (const who of [...merchants, ...agents]) {
    out.guard[`reports:${who}`] = await call(C.guard, 'reports_for', { account_id: who })
  }
  return out
}

const args = process.argv.slice(2)
if (args[0] === '--diff') {
  const a = JSON.parse(await readFile(args[1], 'utf8'))
  const b = JSON.parse(await readFile(args[2], 'utf8'))
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  let moved = 0, same = 0, unreadable = 0
  for (const section of keys) {
    const ka = [...new Set([...Object.keys(a[section] ?? {}), ...Object.keys(b[section] ?? {})])]
    for (const k of ka) {
      const x = JSON.stringify(a[section]?.[k]), y = JSON.stringify(b[section]?.[k])
      // The code hash is SUPPOSED to change; that is the deploy.
      if (section === 'code') {
        console.log(`  code    ${k.padEnd(8)} ${x === y ? 'unchanged' : `${JSON.parse(x)} -> ${JSON.parse(y)}`}`)
        continue
      }
      if (x === y) { same++; continue }
      // An unreadable value is UNKNOWN, not changed. Reporting it as moved
      // would be a false alarm; ignoring it would be worse, because an
      // incomplete comparison cannot establish that nothing moved. So it is
      // counted separately and still fails the gate.
      if (/"ERROR"/.test(String(x)) || /"ERROR"/.test(String(y)) || x === undefined || y === undefined) {
        unreadable++
        console.log(`  UNREAD  ${section}.${k}  (${/"ERROR"/.test(String(y)) ? 'after' : 'before'} could not be read)`)
        continue
      }
      moved++
      console.log(`  MOVED   ${section}.${k}`)
      console.log(`            before ${String(x).slice(0, 150)}`)
      console.log(`            after  ${String(y).slice(0, 150)}`)
    }
  }
  console.log(
    `\n  ${same} value(s) identical, ${moved} moved` +
    (unreadable ? `, ${unreadable} UNREADABLE — this comparison is incomplete` : '') + '\n',
  )
  process.exit(moved === 0 && unreadable === 0 ? 0 : 1)
}

const snap = await snapshot()
const n = Object.values(snap).reduce((t, s) => t + Object.keys(s).length, 0)
await writeFile(args[0], JSON.stringify(snap, null, 1) + '\n')
console.log(`  ${n} live values -> ${args[0]}`)
