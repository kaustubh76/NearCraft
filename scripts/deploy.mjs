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
import { catalog, fromYocto, names, provider, rootAccount, rootAccountId, toYocto, RPC_URL } from './near-env.mjs'
import { createOnboarding } from '../backend/near/onboarding.mjs'

const KEYS_PATH = new URL('../.local/nearcraft-keys.json', import.meta.url)
const MANIFEST_PATH = new URL('../deployment.json', import.meta.url)
const WASM = {
  items: new URL('../contracts/target/near/nearcraft_items/nearcraft_items.wasm', import.meta.url),
  market: new URL('../contracts/target/near/nearcraft_market/nearcraft_market.wasm', import.meta.url),
  guard: new URL('../contracts/target/near/nearcraft_guard/nearcraft_guard.wasm', import.meta.url),
}

/// Every economic amount in the catalog is multiplied by this.
///
/// A faucet account holds 10 NEAR and the three contracts alone stake ~5.7 of
/// it in storage, so the catalog's full-size economy (77 NEAR of merchant
/// treasuries) cannot fit. Scaling is uniform, so every *ratio* — prices to
/// treasuries to floors to budgets — is preserved exactly and the market
/// behaves identically; only the units shrink. Contract account funding is NOT
/// scaled, because storage staking is a fixed cost in real NEAR.
///
/// The scale is sticky. When a deployment.json already exists, its recorded
/// `economy_scale` is the default, because re-running deploy against a live
/// economy at a *different* scale is never what anyone means: every figure is a
/// top-up to a target, so a scale of 1 over a 0.01 deployment tries to inflate
/// the whole economy a hundredfold. That is not idempotent, and `npm run
/// deploy` is documented as idempotent. It was caught by a re-run dying with
/// `NotEnoughBalance` for 5.02 NEAR of credit top-up — which only failed safely
/// because the root account was poor. With a funded root it would have
/// quietly rewritten the live economy and invalidated the README's figures.
///
/// An explicit NEAR_ECONOMY_SCALE still wins, so changing scale on purpose is
/// possible — it just has to be on purpose.
const priorScale = await (async () => {
  try {
    const prior = JSON.parse(await readFile(new URL('../deployment.json', import.meta.url), 'utf8'))
    return typeof prior.economy_scale === 'number' && prior.economy_scale > 0 ? prior.economy_scale : null
  } catch {
    return null // no prior deployment; a first run is unconstrained
  }
})()

const SCALE = Number(process.env.NEAR_ECONOMY_SCALE ?? priorScale ?? '1')
if (!(SCALE > 0)) throw new Error('NEAR_ECONOMY_SCALE must be a positive number')
if (priorScale !== null && SCALE !== priorScale) {
  log(`  NOTE: deployment.json records economy_scale ${priorScale}, and this run uses ${SCALE}.`)
  log('        Every economy figure is a top-up to a target, so changing scale rewrites them.')
}

const p = provider()
const root = rootAccount()
const n = names()
const cat = await catalog()
const log = (...a) => console.log(...a)
/// Scaled catalog amount, for anything economic.
const econ = (amount) => (toYocto(amount) * BigInt(Math.round(SCALE * 1e6))) / 1_000_000n

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

/// Deposit only the shortfall against a target, so re-running does not keep
/// adding budget. `fund_credit` has no "set" form — it only adds — so
/// idempotency has to live here.
async function topUpCredit(accountId, target) {
  const current = BigInt(await p.callFunction({
    contractId: n.market, method: 'credit_of', args: { account_id: accountId },
  }).catch(() => '0'))
  if (current >= target) {
    log(`  funded   ${accountId} already at ${fromYocto(current)} NEAR`)
    return
  }
  const short = target - current
  await call(rootAccountId(), n.market, 'fund_credit', { account_id: accountId }, { deposit: short })
  log(`  funded   ${accountId} +${fromYocto(short)} -> ${fromYocto(target)} NEAR`)
}

async function exists(accountId) {
  try {
    await p.query({ request_type: 'view_account', finality: 'final', account_id: accountId })
    return true
  } catch {
    return false
  }
}

/// Returns true if it created the account, false if it was already there.
async function ensureAccount(accountId, fundYocto) {
  if (await exists(accountId)) {
    log(`  exists   ${accountId}`)
    return false
  }
  const secret = keyFor(accountId)
  const publicKey = KeyPair.fromString(secret).getPublicKey().toString()
  // `nearToTransfer` is yoctoNEAR despite its name — verified against the v7 source.
  await root.createSubAccount({ accountOrPrefix: accountId, publicKey, nearToTransfer: fundYocto })
  log(`  created  ${accountId}  (${fromYocto(fundYocto)} NEAR)`)
  return true
}

/// Top an account's NEAR balance up to a floor. Distinct from `topUpCredit`,
/// which funds a spend budget inside the market contract — these are two of the
/// three separate pots described in AGENTS.md, and conflating them is how a
/// freshly deployed agent ended up unable to transact at all.
async function topUpBalance(accountId, floorYocto) {
  const state = await p.query({ request_type: 'view_account', finality: 'optimistic', account_id: accountId })
  const have = BigInt(state.amount)
  if (have >= floorYocto) {
    log(`  gas      ${accountId} already at ${fromYocto(have)} NEAR`)
    return
  }
  await root.transfer({ receiverId: accountId, amount: floorYocto - have })
  log(`  gas      ${accountId}  +${fromYocto(floorYocto - have)} -> ${fromYocto(floorYocto)} NEAR`)
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

log(`\nNearCraft deploy — root ${rootAccountId()}`)
log(`economy scale ${SCALE}${SCALE === 1 ? '' : ' (ratios preserved; only the units shrink)'}\n`)

if (!(await exists(rootAccountId()))) {
  throw new Error(
    `root account ${rootAccountId()} does not exist.\n` +
    '  Create it at https://near-faucet.io first. Programmatic creation of a\n' +
    '  *.testnet account is no longer available (helper.testnet.near.org is gone).'
  )
}

log('contracts')
// Storage staking is ~1e19 yoctoNEAR per byte, so fund each contract account
// from its actual wasm size plus margin rather than from a guess.
const stakeFor = async (wasmUrl, marginNear) => {
  const { stat } = await import('node:fs/promises')
  const { size } = await stat(wasmUrl)
  return BigInt(size) * 10_000_000_000_000_000_000n + toYocto(marginNear)
}
await ensureAccount(n.items, await stakeFor(WASM.items, '0.3'))
await ensureAccount(n.market, await stakeFor(WASM.market, '0.5'))
await ensureAccount(n.guard, await stakeFor(WASM.guard, '0.3'))
await saveKeys(keys)

// Redeploying is opt-in, and until now it was impossible. This loop only ever
// deployed when a contract had NO code, logging "has code" otherwise — so a
// contract fix silently never reached the chain, and the only clue was a line
// that looked like success. The default stays "deploy only if absent", because
// that is what makes a resumed first run idempotent.
//
// IMPORTANT: this is a bare `deployContract`. It is safe for a change that only
// adds or alters METHODS, because borsh state is positional and untouched. A
// change that adds or reorders a field in a contract's state struct will make
// every method and every view panic with "Cannot deserialize the contract
// state", and recovering needs a migrate method deployed in the same
// transaction. No contract here has one yet.
// `NEAR_REDEPLOY=1` replaces all three; `NEAR_REDEPLOY=items,market` replaces
// only those named. Targeting matters: redeploying a contract whose code has
// not changed costs gas and buys nothing, and on a 1.5 NEAR root account that
// is not free.
const redeployRaw = process.env.NEAR_REDEPLOY ?? ''
const redeployAll = redeployRaw === '1'
const redeployNamed = new Set(redeployRaw.split(',').map((x) => x.trim()).filter((x) => x && x !== '1'))
const wantsRedeploy = (name) => redeployAll || redeployNamed.has(name)

for (const [name, accountId, wasm] of [
  ['items', n.items, WASM.items],
  ['market', n.market, WASM.market],
  ['guard', n.guard, WASM.guard],
]) {
  if (!(await deployed(accountId))) {
    await deploy(accountId, wasm)
  } else if (wantsRedeploy(name)) {
    log(`  replacing code on ${accountId}  (NEAR_REDEPLOY names ${name})`)
    await deploy(accountId, wasm)
  } else {
    log(`  has code ${accountId}  (NEAR_REDEPLOY=${name} to replace it)`)
  }
}

const unknownRedeploy = [...redeployNamed].filter((x) => !['items', 'market', 'guard'].includes(x))
if (unknownRedeploy.length) {
  // A typo here would otherwise look exactly like a successful no-op.
  throw new Error(`NEAR_REDEPLOY names unknown contract(s): ${unknownRedeploy.join(', ')}`)
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
    if (/already.{0,16}initiali[sz]ed/i.test(String(e))) log(`  already  ${accountId} initialised`)
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
  await ensureAccount(id, toYocto('0.05'))
  if (registered.has(id)) { log(`  known    ${id}`); continue }
  await call(rootAccountId(), n.market, 'register_merchant', {
    merchant_id: id, name: merchant.name, floor: econ(merchant.floor_near).toString(),
  })
  await call(rootAccountId(), n.market, 'fund_merchant', { merchant_id: id }, { deposit: econ(merchant.fund_near) })
  log(`  opened   ${id}  "${merchant.name}"  treasury ${fromYocto(econ(merchant.fund_near))} NEAR, floor ${fromYocto(econ(merchant.floor_near))}`)
}
await saveKeys(keys)

log('\nshelves')
for (const m of cat.materials) {
  for (const [prefix, stock] of Object.entries(m.stock)) {
    await call(rootAccountId(), n.market, 'list_item', {
      merchant_id: n.sub(prefix), item: m.token_id,
      base_price: econ(m.base_near).toString(), stock: String(stock),
    })
    log(`  stocked  ${prefix.padEnd(13)} ${m.token_id.padEnd(13)} ${String(stock).padStart(5)} @ ${fromYocto(econ(m.base_near))} NEAR`)
  }
}

// ---------------------------------------------------------------- agent keys

log('\nagents — function-call keys scoped to the market, nothing else')
const agentKeys = {}
for (const agent of cat.agents) {
  const id = n.sub(agent.prefix)
  // 0.3 NEAR of gas headroom: enough to prepay several 60 TGas calls. Separate
  // from the spend budget below and from the key allowance — see AGENTS.md.
  await ensureAccount(id, toYocto('0.3'))

  // Skip if this account already carries a function-call key scoped to the
  // market — otherwise every run adds one more.
  const existingScoped = await p.query({
    request_type: 'view_access_key_list', finality: 'optimistic', account_id: id,
  }).then(({ keys: ks }) => ks.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === n.market))
    .catch(() => [])
  if (existingScoped.length) {
    // Record what is ON CHAIN, not only what this run issued.
    //
    // This branch used to `continue` without touching `agentKeys`, so every
    // re-run wrote `agents: []` into deployment.json — and `npm run keys`,
    // which iterates that array, then audited nothing and reported success.
    // The manifest has to describe the deployment, not diary one run.
    //
    // Prefer the key whose secret is in the keystore: that is the one the agent
    // process actually signs with, so it is the one worth publishing.
    const mine = keys[`${id}#function-call`]
    const minePub = mine ? KeyPair.fromString(mine).getPublicKey().toString() : null
    const chosen = existingScoped.find((k) => k.public_key === minePub) ?? existingScoped[0]

    log(`  keyed    ${id} already (${existingScoped.length} scoped key(s))`)

    // Prune orphans: scoped keys on this account that are not the one we hold
    // the secret for.
    //
    // These are the residue of an earlier, non-idempotent version of this loop,
    // which minted a fresh key on every run and overwrote the keystore entry.
    // So an orphan grants real authority over the agent account while NOBODY
    // holds its secret any more — unusable by us, unrotatable, and still live.
    // Leaving that in place is strictly worse than removing it.
    //
    // Only prune when our own key was positively identified on chain. If the
    // keystore and the chain disagree we might be looking at a key we actually
    // need, so say so and change nothing.
    if (existingScoped.length > 1) {
      const orphans = existingScoped.filter((k) => k.public_key !== minePub)
      if (!minePub || orphans.length === existingScoped.length) {
        log('           ^ WARNING: cannot tell which scoped key is ours, so none were')
        log('             removed. npm run keys will name them; resolve by hand.')
      } else {
        for (const o of orphans) {
          await as(id).deleteKey(o.public_key)
          log(`           pruned orphan scoped key ${o.public_key.slice(0, 26)}…`)
        }
      }
    }

    agentKeys[id] = {
      secretKey: mine ?? null,
      publicKey: chosen.public_key,
      permitted: chosen.access_key.permission.FunctionCall.method_names ?? [],
    }
    await topUpCredit(id, econ(agent.budget_near))
    continue
  }

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
  await topUpCredit(id, econ(agent.budget_near))

  agentKeys[id] = { secretKey: fcKey.toString(), publicKey, permitted: cat.agent_permitted_methods }
  keys[`${id}#function-call`] = fcKey.toString()
  log(`  keyed    ${id}  methods=[${cat.agent_permitted_methods}] gas=${agent.gas_allowance_near} budget=${fromYocto(econ(agent.budget_near))} NEAR`)
}
await saveKeys(keys)

// ---------------------------------------------------------------- players

log('\nplayers — onboarded through backend/near/onboarding.mjs')

// The three-transaction bootstrap (create, approve while a full-access key
// still exists, then install the scoped key and delete the bootstrap key in one
// transaction) lives in onboarding.mjs and is called from here rather than
// reimplemented. It used to exist in both places, which meant the delicate copy
// the README points at was the one nothing exercised. Now `npm run test:deploy`
// runs it for real.
//
// Seeded demo players use a `seed:` identity provider, so their account ids are
// derived exactly as a real login's would be. The verifier below is local and
// trivial on purpose: a real deployment swaps in OIDC/OAuth behind the same
// interface, which is the only part of onboarding that is stubbed.
const onboarding = createOnboarding({
  rootAccountId: rootAccountId(),
  rootKey: process.env.NEAR_ROOT_KEY,
  marketContract: n.market,
  itemsContract: n.items,
  sellableItems: cat.players?.sellable_items ?? [],
  playerMethods: cat.players?.methods ?? ['buy_with_credit', 'sell'],
  gasAllowance: toYocto(cat.players?.gas_allowance_near ?? '2'),
  verifyIdentity: async (token) => ({ provider: 'seed', subject: String(token) }),
  rpcUrl: RPC_URL,
  log: () => {},
})

const players = []
for (const subject of cat.players?.seed_subjects ?? ['player-1']) {
  const result = await onboarding.signIn(subject)
  log(`  ${result.created ? 'onboarded' : 'exists   '} ${result.accountId}  seed:${subject}`)
  if (result.created) {
    keys[`${result.accountId}#scoped`] = result.serverKey
    log(`           methods=[${result.permittedMethods}] approved for ${result.approvedForSale?.length ?? 0} material(s)`)
  }
  // Prove it, rather than trusting the module: no full-access key may remain.
  const limits = await onboarding.keyLimits(result.accountId)
  const full = limits.filter((k) => k.fullAccess)
  if (full.length) throw new Error(`${result.accountId} still holds ${full.length} full-access key(s)`)
  log(`           ${limits.length} key(s), none full-access`)

  await topUpCredit(result.accountId, econ(cat.players?.budget_near ?? '2'))
  players.push({ account_id: result.accountId, permitted_methods: result.permittedMethods ?? [] })
}
await saveKeys(keys)

// ------------------------------------------------------------------ manifest

// ---------------------------------------------------------------- relayer

// Without this, "no gas prompt" is a sandbox claim only: the relayer module was
// built and proved in tests, but no relayer account was ever deployed, so the
// headline games-track property had no live footprint at all.
let relayerId = null
if (cat.relayer) {
  log('\nrelayer — pays gas so a player never sees a gas prompt (NEP-366)')
  relayerId = n.relayer
  // Only top up an account that already existed: a freshly created one was
  // funded with exactly the floor, and querying it at this block height fails
  // because account creation is not final yet.
  const relayerIsNew = await ensureAccount(relayerId, toYocto(cat.relayer.gas_near))
  if (!relayerIsNew) await topUpBalance(relayerId, toYocto(cat.relayer.gas_near))
  await saveKeys(keys)
  // It holds a FULL-ACCESS key, deliberately and unavoidably: a SignedDelegate
  // is not a function call, so a scoped key cannot submit one. That is why it
  // is funded for gas only and carries no spend budget — there is nothing for a
  // stolen relayer key to buy.
  log(`  relays   [${cat.relayer.permitted_methods}] for players`)
  log('  bounds   gas only, no spend budget; its own allowlist, so it is not an open faucet')
}

const manifest = {
  note: 'Written by npm run deploy. Public ids only — no secret material.',
  network: 'testnet',
  rpc: RPC_URL,
  deployed_at: new Date().toISOString(),
  economy_scale: SCALE,
  root: rootAccountId(),
  contracts: { items: n.items, market: n.market, guard: n.guard },
  merchants: cat.merchants.map((m) => ({ account_id: n.sub(m.prefix), name: m.name })),
  materials: cat.materials.map((m) => m.token_id),
  players,
  relayer: relayerId
    ? {
        account_id: relayerId,
        relays: cat.relayer.permitted_methods,
        note: 'Pays gas for player calls. Funded for gas only, no spend budget. Holds a full-access key because a SignedDelegate action is not a function call, so a scoped key cannot submit one.',
      }
    : null,
  agents: Object.entries(agentKeys).map(([account_id, k]) => ({
    account_id,
    function_call_public_key: k.publicKey,
    permitted_methods: k.permitted,
    scoped_to: n.market,
  })),
}
await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

log(`\ndone. manifest -> deployment.json`)
log(`keys (gitignored) -> .local/nearcraft-keys.json`)
log(`\nverify:  npm run reads   npm run keys\n`)
