// Bootstrap the whole NearCraft economy onto NEAR testnet, idempotently.
//
//   npm run deploy
//
// Needs NEAR_ROOT_KEY (see scripts/near-env.mjs for the message it prints
// otherwise). Re-running is safe: every step checks before it acts, so a
// partial run can simply be repeated.
//
// Order matters. Merchants need accounts before they can hold a treasury;
// market needs the items contract id before it can be initialised; agents need
// the market deployed before a key can be scoped to it.

import { writeFile, mkdir, readFile, chmod } from 'node:fs/promises'
import { Account, KeyPair, actions, teraToGas } from 'near-api-js'
import { catalog, fromYocto, names, provider, rootAccount, rootAccountId, toYocto } from './near-env.mjs'

const KEYS_PATH = new URL('../.local/nearcraft-keys.json', import.meta.url)
const MANIFEST_PATH = new URL('../deployment.json', import.meta.url)
const WASM = {
  items: new URL('../contracts/target/near/nearcraft_items/nearcraft_items.wasm', import.meta.url),
  market: new URL('../contracts/target/near/nearcraft_market/nearcraft_market.wasm', import.meta.url),
  guard: new URL('../contracts/target/near/nearcraft_guard/nearcraft_guard.wasm', import.meta.url),
}

const p = provider()
const root = rootAccount()
const n = names()
const cat = await catalog()
const log = (...a) => console.log(...a)

// ---------------------------------------------------------------- key storage

/// Generated keys live outside git. They are regenerated only if absent, so a
/// second deploy reuses the same accounts.
async function keystore() {
  try {
    return JSON.parse(await readFile(KEYS_PATH, 'utf8'))
  } catch {
    return {}
  }
}
async function saveKeys(store) {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true })
  await writeFile(KEYS_PATH, JSON.stringify(store, null, 2))
  await chmod(KEYS_PATH, 0o600)
}

const keys = await keystore()
function keyFor(accountId) {
  if (!keys[accountId]) keys[accountId] = KeyPair.fromRandom('ed25519').toString()
  return keys[accountId]
}

// ------------------------------------------------------------------- helpers

async function exists(accountId) {
  try {
    await p.query({ request_type: 'view_account', finality: 'final', account_id: accountId })
    return true
  } catch {
    return false
  }
}

async function ensureAccount(accountId, fundYocto) {
  if (await exists(accountId)) {
    log(`  exists   ${accountId}`)
    return
  }
  const secret = keyFor(accountId)
  const publicKey = KeyPair.fromString(secret).getPublicKey().toString()
  // `nearToTransfer` is yoctoNEAR despite its name — verified against the v7 source.
  await root.createSubAccount({ accountOrPrefix: accountId, publicKey, nearToTransfer: fundYocto })
  log(`  created  ${accountId}  (${fromYocto(fundYocto)} NEAR)`)
}

function as(accountId) {
  // The root's key comes from the environment, not the generated keystore, so
  // looking it up there yields undefined and near-api-js fails with the
  // unhelpful "Please set a signer". Caught by the sandbox rehearsal rather
  // than by the first live run.
  if (accountId === rootAccountId()) return root
  const key = keys[accountId]
  if (!key) throw new Error(`no key on record for ${accountId}; delete .local/nearcraft-keys.json to start over`)
  return new Account(accountId, p, key)
}

async function deployed(accountId) {
  const state = await p.query({ request_type: 'view_account', finality: 'final', account_id: accountId })
  return state.code_hash && state.code_hash !== '11111111111111111111111111111111'
}

async function deploy(accountId, wasmUrl) {
  let code
  try {
    code = new Uint8Array(await readFile(wasmUrl))
  } catch {
    throw new Error(
      `missing ${wasmUrl.pathname}\n  Build first:  npm run build:contracts`
    )
  }
  await as(accountId).deployContract(code)
  log(`  deployed ${accountId}  (${(code.length / 1024).toFixed(1)} KiB)`)
}

async function call(accountId, contractId, methodName, args, { deposit = 0n, tgas = 60 } = {}) {
  return as(accountId).callFunction({
    contractId, methodName, args,
    gas: teraToGas(String(tgas)),
    deposit,
  })
}

// --------------------------------------------------------------------- steps

log(`\nNearCraft deploy — root ${rootAccountId()}\n`)

if (!(await exists(rootAccountId()))) {
  throw new Error(
    `root account ${rootAccountId()} does not exist.\n` +
    '  Create it at https://near-faucet.io first. Programmatic creation of a\n' +
    '  *.testnet account is no longer available (helper.testnet.near.org is gone).'
  )
}

log('contracts')
await ensureAccount(n.items, toYocto('4'))
await ensureAccount(n.market, toYocto('8'))
await ensureAccount(n.guard, toYocto(cat.guard?.fund_near ?? '3'))
await saveKeys(keys)

for (const [accountId, wasm] of [[n.items, WASM.items], [n.market, WASM.market], [n.guard, WASM.guard]]) {
  if (!(await deployed(accountId))) await deploy(accountId, wasm)
  else log(`  has code ${accountId}`)
}

log('\ninitialise')
for (const [accountId, args] of [
  [n.items, { owner_id: n.market }],
  [n.market, { owner_id: rootAccountId(), items_contract: n.items }],
  // Without the guard initialised, the counterparty check cannot read it and
  // degrades silently rather than loudly. Deploying it is not optional.
  [n.guard, {}],
]) {
  try {
    await call(rootAccountId(), accountId, 'new', args)
    log(`  init     ${accountId}  ${JSON.stringify(args)}`)
  } catch (e) {
    // `new` is `#[init]`, so a second call fails. That is the idempotent path.
    if (/already initialized|Contract already/i.test(String(e))) log(`  already  ${accountId} initialised`)
    else throw e
  }
}

// The items contract's owner is the market, so the market mints its own pool.
log('\nmaterials (minted to the market, which custodies the shop floor)')
for (const m of cat.materials) {
  const held = await p.callFunction({
    contractId: n.items, method: 'mt_balance_of',
    args: { account_id: n.market, token_id: m.token_id },
  }).catch(() => '0')
  if (BigInt(held ?? 0) > 0n) { log(`  minted   ${m.token_id} already (${held})`); continue }
  await call(n.market, n.items, 'mt_mint', {
    token_id: m.token_id, amount: String(m.supply), receiver_id: n.market,
  })
  log(`  minted   ${m.token_id}  ${m.supply}`)
}

log('\nmerchants')
const registered = new Map((await p.callFunction({ contractId: n.market, method: 'merchants', args: {} }).catch(() => [])).map(([id, m]) => [id, m]))
for (const merchant of cat.merchants) {
  const id = n.sub(merchant.prefix)
  await ensureAccount(id, toYocto('0.5'))
  if (registered.has(id)) { log(`  known    ${id}`); continue }
  await call(rootAccountId(), n.market, 'register_merchant', {
    merchant_id: id, name: merchant.name, floor: toYocto(merchant.floor_near).toString(),
  })
  await call(rootAccountId(), n.market, 'fund_merchant', { merchant_id: id }, { deposit: toYocto(merchant.fund_near) })
  log(`  opened   ${id}  "${merchant.name}"  treasury ${merchant.fund_near} NEAR, floor ${merchant.floor_near}`)
}
await saveKeys(keys)

log('\nshelves')
for (const m of cat.materials) {
  for (const [prefix, stock] of Object.entries(m.stock)) {
    await call(rootAccountId(), n.market, 'list_item', {
      merchant_id: n.sub(prefix), item: m.token_id,
      base_price: toYocto(m.base_near).toString(), stock: String(stock),
    })
    log(`  stocked  ${prefix.padEnd(13)} ${m.token_id.padEnd(13)} ${String(stock).padStart(5)} @ ${m.base_near} NEAR`)
  }
}

// ---------------------------------------------------------------- agent keys

log('\nagents — function-call keys scoped to the market, nothing else')
const agentKeys = {}
for (const agent of cat.agents) {
  const id = n.sub(agent.prefix)
  await ensureAccount(id, toYocto('0.3'))

  const fcKey = KeyPair.fromRandom('ed25519')
  const publicKey = fcKey.getPublicKey().toString()

  // THE central claim of the security track, in four lines. `methodNames`
  // defaults to [] in near-api-js, which the protocol reads as "any method on
  // that contract" — so it is always passed explicitly here. The key cannot
  // transfer NEAR and cannot add keys; that is enforced by the runtime.
  await as(id).addFunctionCallAccessKey({
    publicKey,
    contractId: n.market,
    methodNames: cat.agent_permitted_methods,
    allowance: toYocto(agent.gas_allowance_near).toString(),
  })

  // Its spend budget is a separate, second bound — see `fund_credit` in the
  // market contract for why a function-call key needs one.
  await call(rootAccountId(), n.market, 'fund_credit', { account_id: id }, { deposit: toYocto(agent.budget_near) })

  agentKeys[id] = { secretKey: fcKey.toString(), publicKey, permitted: cat.agent_permitted_methods }
  keys[`${id}#function-call`] = fcKey.toString()
  log(`  keyed    ${id}  methods=[${cat.agent_permitted_methods}] gas=${agent.gas_allowance_near} budget=${agent.budget_near} NEAR`)
}
await saveKeys(keys)

// ---------------------------------------------------------------- players

log('\nplayers — a scoped key and a one-time approval, so they can sell')
const players = []
for (const prefix of cat.players?.accounts ?? ['player-1']) {
  const id = n.sub(prefix)
  const existed = await exists(id)
  await ensureAccount(id, toYocto('0.3'))

  if (!existed) {
    // The approval has to be granted while a full-access key still exists: a
    // function-call key cannot attach the deposit mt_approve needs. The
    // bootstrap key is then destroyed in the same transaction that installs the
    // scoped one, so the player never holds a key that can do anything else.
    // See docs/GASLESS.md.
    const sellable = cat.players?.sellable_items ?? []
    if (sellable.length) {
      await call(id, n.items, 'mt_approve', {
        token_ids: sellable,
        amounts: sellable.map(() => '1000000000'),
        account_id: n.market,
        msg: null,
      }, { deposit: toYocto('0.01') })
      log(`  approved ${id} -> ${n.market} for ${sellable.length} material(s)`)
    }

    const scoped = KeyPair.fromRandom('ed25519')
    const methods = cat.players?.methods ?? ['buy_with_credit', 'sell']
    await as(id).signAndSendTransaction({
      receiverId: id,
      actions: [
        actions.addFunctionCallAccessKey(
          scoped.getPublicKey(), n.market, methods,
          toYocto(cat.players?.gas_allowance_near ?? '2'),
        ),
        // Add before delete, in one transaction, or a failure between them
        // leaves an account nobody can use.
        actions.deleteKey(KeyPair.fromString(keys[id]).getPublicKey()),
      ],
    })
    keys[`${id}#scoped`] = scoped.toString()
    delete keys[id] // the bootstrap key no longer exists on chain
    log(`  keyed    ${id}  methods=[${methods}] — no full-access key remains`)
  } else {
    log(`  exists   ${id}`)
  }

  await call(rootAccountId(), n.market, 'fund_credit', { account_id: id },
    { deposit: toYocto(cat.players?.budget_near ?? '2') })
  players.push({ account_id: id, permitted_methods: cat.players?.methods ?? [] })
}
await saveKeys(keys)

// ------------------------------------------------------------------ manifest

const manifest = {
  note: 'Written by npm run deploy. Public ids only — no secret material.',
  network: 'testnet',
  rpc: process.env.NEAR_RPC || 'https://rpc.testnet.near.org',
  deployed_at: new Date().toISOString(),
  root: rootAccountId(),
  contracts: { items: n.items, market: n.market, guard: n.guard },
  merchants: cat.merchants.map((m) => ({ account_id: n.sub(m.prefix), name: m.name })),
  materials: cat.materials.map((m) => m.token_id),
  players,
  agents: Object.entries(agentKeys).map(([account_id, k]) => ({
    account_id,
    function_call_key: k.publicKey,
    permitted_methods: k.permitted,
    scoped_to: n.market,
  })),
}
await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

log(`\ndone. manifest -> deployment.json`)
log(`keys (gitignored) -> .local/nearcraft-keys.json`)
log(`\nverify:  npm run reads   npm run keys\n`)
