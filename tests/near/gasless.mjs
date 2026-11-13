// Gasless play, proved against a real nearcore node.
//
//   npm run test:gasless     (needs `npm run build:contracts` first)
//
// The games track requires "no seed phrases, no wallet popups, and no gas
// prompts in the normal game loop". The first two are a matter of never handing
// a player a key. The third is a claim about who pays, and a claim about money
// should be measured rather than asserted — so this test watches both balances.
//
// Three findings, each asserted below rather than assumed:
//
//   1. A **function-call access key can sign** a NEP-366 delegate action.
//   2. When a relayer submits it, **the relayer pays and the player's balance
//      does not move** — the player's delta is exactly zero.
//   3. The delegate's **inner action cannot carry a deposit**: nearcore answers
//      "Deposit is not allowed with function call". This is why players buy
//      from a credit balance rather than attaching NEAR.
//   4. And therefore why **selling needs NEP-245 Approval Management**: the
//      player cannot attach the 1 yoctoNEAR `mt_transfer_call` requires, so the
//      market pulls instead, under an approval granted once at account setup
//      while a full-access key still existed. The second test below proves a
//      player with **no full-access key at all** sells for free.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox'
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from 'near-api-js'
import { createPlayService } from '../../backend/near/play.mjs'
import { createOnboarding } from '../../backend/near/onboarding.mjs'
import { createRelayer } from '../../backend/near/relayer.mjs'
import { createMarketReader } from '../../backend/near/market.mjs'

const near = (n) => BigInt(n) * 10n ** 24n

async function wasm(name) {
  const path = new URL(`../../contracts/target/near/${name}/${name}.wasm`, import.meta.url)
  try { return new Uint8Array(await readFile(path)) }
  catch { throw new Error(`missing ${path.pathname}\n  Build first: npm run build:contracts`) }
}

test('a player buys with no key of their own and pays no gas', async (t) => {
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)
  const balance = async (id) =>
    BigInt((await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).amount)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  // --- a stocked market, the same shape scripts/deploy.mjs builds ----------
  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayer = await sub('relayer', near(50))
  const player = await sub('player', near(1))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })

  // --- the player: a scoped key the server holds, and a credit balance -----
  const scoped = KeyPair.fromRandom('ed25519')
  await new Account(player.id, provider, player.key.toString()).addFunctionCallAccessKey({
    publicKey: scoped.getPublicKey().toString(),
    contractId: market.id,
    methodNames: ['buy_with_credit', 'sell'],
    allowance: near(2).toString(),
  })
  await root.callFunction({ contractId: market.id, methodName: 'fund_credit', args: { account_id: player.id }, deposit: near(2), gas: teraToGas('30') })

  // Everything below signs with ONLY the scoped key.
  const asPlayer = new Account(player.id, provider, scoped.toString())

  // --- finding 1: a function-call key can sign a delegate action ----------
  const signed = await asPlayer.createSignedMetaTransaction({
    receiverId: market.id,
    actions: [actions.functionCall('buy_with_credit',
      { merchant_id: merchant.id, item: 'iron_ingot', count: 3 }, teraToGas('60'), 0n)],
  })
  assert.ok(signed?.signedDelegate, 'a function-call access key must be able to sign a delegate action')
  // An API seam: createSignedMetaTransaction resolves to {delegateHash,
  // signedDelegate} while relayMetaTransaction wants the bare signedDelegate.
  assert.ok(signed.delegateHash, 'the wrapper carries the hash alongside the delegate')

  // --- finding 2: the relayer pays, the player does not -------------------
  const before = { player: await balance(player.id), relayer: await balance(relayer.id) }
  await new Account(relayer.id, provider, relayer.key.toString())
    .relayMetaTransaction(signed.signedDelegate)
  const after = { player: await balance(player.id), relayer: await balance(relayer.id) }

  const held = await provider.callFunction({
    contractId: items.id, method: 'mt_balance_of',
    args: { account_id: player.id, token_id: 'iron_ingot' },
  })

  console.log('\n--- gasless purchase ---')
  console.log(`  player  delta ${after.player - before.player} yoctoNEAR`)
  console.log(`  relayer delta ${after.relayer - before.relayer} yoctoNEAR`)
  console.log(`  player received ${held} iron_ingot\n`)

  // The whole claim, in one line.
  assert.equal(after.player - before.player, 0n, 'the player must not pay a single yoctoNEAR')
  assert.ok(after.relayer < before.relayer, 'the relayer must be the one that paid')
  assert.equal(BigInt(held), 3n, 'and the goods must actually arrive')

  // --- finding 3: the inner action cannot carry a deposit -----------------
  const withDeposit = await asPlayer.createSignedMetaTransaction({
    receiverId: market.id,
    actions: [actions.functionCall('buy_with_credit',
      { merchant_id: merchant.id, item: 'iron_ingot', count: 1 }, teraToGas('60'), near(1) / 5n)],
  })
  await assert.rejects(
    () => new Account(relayer.id, provider, relayer.key.toString()).relayMetaTransaction(withDeposit.signedDelegate),
    (e) => {
      // This is why players spend credit rather than attaching NEAR, and why a
      // scoped key cannot sell: NEP-245 requires 1 yoctoNEAR on a transfer.
      assert.match(String(e.message), /Deposit is not allowed with function call/)
      console.log(`  deposit on a delegate's inner action: REFUSED — ${String(e.message).split('\n')[0]}\n`)
      return true
    },
  )
})

test('a player with no full-access key sells, and still pays nothing', async (t) => {
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)
  const balance = async (id) =>
    BigInt((await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).amount)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayer = await sub('relayer', near(50))
  const player = await sub('player', near(1))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })

  // Give the player something to sell.
  await marketAcc.callFunction({
    contractId: items.id, methodName: 'mt_transfer',
    args: { receiver_id: player.id, token_id: 'iron_ingot', amount: '50', approval: null, memo: null },
    deposit: 1n, gas: teraToGas('30'),
  })

  const playerFull = new Account(player.id, provider, player.key.toString())

  // --- the onboarding bootstrap, exactly as onboarding.mjs performs it ----
  // Step 2: approve the market WHILE a full-access key still exists. A
  // function-call key could never do this — it cannot attach the deposit.
  await playerFull.callFunction({
    contractId: items.id, methodName: 'mt_approve',
    args: { token_ids: ['iron_ingot'], amounts: ['1000000'], account_id: market.id, msg: null },
    deposit: near(1) / 100n, gas: teraToGas('60'),
  })
  const approval = await provider.callFunction({
    contractId: items.id, method: 'mt_token_approval',
    args: { token_id: 'iron_ingot', account_id: player.id },
  })
  const approvalId = approval.approved_account_ids[market.id].approval_id

  // Step 3: install the scoped key and destroy the full-access one, in that
  // order, in one transaction.
  const scoped = KeyPair.fromRandom('ed25519')
  await playerFull.signAndSendTransaction({
    receiverId: player.id,
    actions: [
      actions.addFunctionCallAccessKey(scoped.getPublicKey(), market.id, ['buy_with_credit', 'sell'], near(2)),
      actions.deleteKey(player.key.getPublicKey()),
    ],
  })

  // The claim this test exists for: there is no full-access key left.
  const { keys } = await provider.query({
    request_type: 'view_access_key_list', finality: 'optimistic', account_id: player.id,
  })
  const full = keys.filter((k) => k.access_key.permission === 'FullAccess' || k.access_key.permission?.FullAccess !== undefined)
  assert.equal(full.length, 0, 'the player must hold no full-access key after onboarding')
  assert.equal(keys.length, 1, 'exactly one key, and it is scoped')

  // --- the sale, relayed, signed only by the scoped key -------------------
  const asPlayer = new Account(player.id, provider, scoped.toString())
  const signed = await asPlayer.createSignedMetaTransaction({
    receiverId: market.id,
    actions: [actions.functionCall('sell',
      { merchant_id: merchant.id, item: 'iron_ingot', count: 10, approval_id: approvalId },
      teraToGas('120'), 0n)],
  })

  const before = { player: await balance(player.id), relayer: await balance(relayer.id) }
  await new Account(relayer.id, provider, relayer.key.toString()).relayMetaTransaction(signed.signedDelegate)
  const after = { player: await balance(player.id), relayer: await balance(relayer.id) }

  const held = await provider.callFunction({
    contractId: items.id, method: 'mt_balance_of', args: { account_id: player.id, token_id: 'iron_ingot' },
  })
  const credit = await provider.callFunction({
    contractId: market.id, method: 'credit_of', args: { account_id: player.id },
  })

  console.log('\n--- gasless sale, player holds no full-access key ---')
  console.log(`  player  delta ${after.player - before.player} yoctoNEAR`)
  console.log(`  relayer delta ${after.relayer - before.relayer} yoctoNEAR`)
  console.log(`  player materials 50 -> ${held}, credited ${credit} yoctoNEAR\n`)

  // The claim is "the player never pays", not "the balance never moves".
  // Measured: on this path the player's balance goes slightly UP — nearcore
  // refunds unused gas to the delegate's *sender*, even though the relayer
  // prepaid it. So a sender can finish a relayed call marginally ahead. The buy
  // path above happens to net to exactly zero; this one does not, and asserting
  // equality here would be asserting an accident.
  const playerDelta = after.player - before.player
  assert.ok(playerDelta >= 0n, `the player must never pay to sell; delta was ${playerDelta}`)
  if (playerDelta > 0n) console.log(`  (player gained ${playerDelta} — unused gas refunded to the delegate sender)\n`)
  assert.ok(after.relayer < before.relayer, 'the relayer is the one that paid')
  assert.equal(BigInt(held), 40n, 'ten materials left the player')
  assert.ok(BigInt(credit) > 0n, 'and the player was paid for them')
})

test('a player with no full-access key backs a merchant, and still pays nothing', async (t) => {
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)
  const balance = async (id) =>
    BigInt((await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).amount)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayer = await sub('relayer', near(50))
  const player = await sub('player', near(1))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })

  // The scoped key carries invest_with_credit. It has to be issued with it:
  // onboarding deletes the bootstrap full-access key, and a function-call key
  // cannot add keys, so a player's method list is fixed for life.
  const scoped = KeyPair.fromRandom('ed25519')
  const asBootstrap = new Account(player.id, provider, player.key.toString())
  await asBootstrap.addFunctionCallAccessKey({
    publicKey: scoped.getPublicKey().toString(),
    contractId: market.id,
    methodNames: ['buy_with_credit', 'sell', 'invest_with_credit'],
    allowance: near(2),
  })
  await root.callFunction({ contractId: market.id, methodName: 'fund_credit', args: { account_id: player.id }, deposit: near(2), gas: teraToGas('30') })

  const asPlayer = new Account(player.id, provider, scoped.toString())
  const stake = near(1)
  const signed = await asPlayer.createSignedMetaTransaction({
    receiverId: market.id,
    actions: [actions.functionCall('invest_with_credit',
      { merchant_id: merchant.id, amount: stake.toString() }, teraToGas('60'), 0n)],
  })

  const before = { player: await balance(player.id), relayer: await balance(relayer.id) }
  await new Account(relayer.id, provider, relayer.key.toString())
    .relayMetaTransaction(signed.signedDelegate)
  const after = { player: await balance(player.id), relayer: await balance(relayer.id) }

  const backer = await provider.callFunction({
    contractId: market.id, method: 'backer_of', args: { merchant_id: merchant.id },
  })

  console.log('\n--- gasless investment ---')
  console.log(`  player  delta ${after.player - before.player} yoctoNEAR`)
  console.log(`  relayer delta ${after.relayer - before.relayer} yoctoNEAR`)
  console.log(`  stake recorded: ${JSON.stringify(backer)}\n`)

  // `invest` is #[payable], so a scoped key could never call it — this is the
  // non-payable twin, and without it the mechanic the games prompt describes
  // would be unreachable for exactly the players it is for.
  assert.equal(after.player - before.player, 0n, 'the player must not pay a single yoctoNEAR')
  assert.ok(after.relayer < before.relayer, 'the relayer must be the one that paid')
  assert.ok(backer, 'the stake must be recorded against the merchant')
  assert.equal(backer.account_id, player.id, 'and recorded against the player who made it')
  assert.equal(backer.principal, stake.toString(), 'for the full amount')
  assert.equal(backer.repaid, '0', 'with nothing earned back before any trade')
})

test('the play service runs the whole loop on a real node, and the player pays nothing', async (t) => {
  // The three tests above prove the PROTOCOL behaviour with hand-built calls.
  // This one proves the thing a person actually touches: backend/near/play.mjs,
  // composing the real onboarding, the real relayer and the real market
  // reader, driven exactly as scripts/serve-play.mjs drives it.
  //
  // It also covers creating a NEW player: onboarding's three-transaction
  // bootstrap, the approval granted while a bootstrap key still exists, and the
  // deletion of that key in the same transaction that installs the scoped one.
  //
  // That used to be the ONLY place this ran, because the live root account was
  // below the gas headroom needed to create an account. Root was funded and
  // `npm run live:onboard` now does it on public testnet too. This stays
  // because a local node is where it is cheap to run repeatedly, and because
  // 0.1 NEAR per account is a poor way to pay for a test.
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)
  const balance = async (id) =>
    BigInt((await provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: id })).amount)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayerAcc = await sub('relayer', near(50))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })

  // ------------------------------------------------- the service, assembled
  const saved = []
  const keys = {}
  const service = createPlayService({
    deployment: { network: 'sandbox', rpc: sandbox.rpcUrl, contracts: { market: market.id, items: items.id } },
    keys,
    verifierKind: 'seed',
    onboarding: createOnboarding({
      rootAccountId: DEFAULT_ACCOUNT_ID,
      rootKey: DEFAULT_PRIVATE_KEY,
      marketContract: market.id,
      itemsContract: items.id,
      sellableItems: ['iron_ingot'],
      // The three methods config/catalog.json actually grants a new player. This
      // test used to onboard with two, which meant the only real-node exercise
      // of the play service never touched the invest route at all — the `games`
      // prompt's own closing mechanic went unproven through the service that
      // serves it.
      playerMethods: ['buy_with_credit', 'sell', 'invest_with_credit'],
      verifyIdentity: async (token) => ({ provider: 'seed', subject: String(token) }),
      rpcUrl: sandbox.rpcUrl,
    }),
    relayer: createRelayer({
      relayerAccountId: relayerAcc.id,
      relayerKey: relayerAcc.key.toString(),
      marketContract: market.id,
      permittedMethods: ['buy_with_credit', 'sell', 'invest_with_credit'],
      rpcUrl: sandbox.rpcUrl,
    }),
    reader: createMarketReader({ marketContract: market.id, itemsContract: items.id, rpcUrl: sandbox.rpcUrl }),
    saveKey: async (id, secret) => { saved.push(id); keys[`${id}#scoped`] = secret },
  })

  // ------------------------------------------------------------- signing in
  const session = await service.handle('POST', '/api/session', { token: 'player-1' })
  assert.equal(session.status, 200, JSON.stringify(session.body))
  const sessionId = session.body.sessionId
  const playerId = session.body.accountId

  assert.equal(session.body.created, true, 'this run must have created the account')
  assert.equal(session.body.fullAccessKeys, 0, 'onboarding must leave no full-access key behind')
  assert.deepEqual(saved, [playerId], 'the one-time scoped key must be handed to the operator')
  assert.ok(!JSON.stringify(session.body).includes('ed25519:'), 'no key may reach the caller')

  await root.callFunction({ contractId: market.id, methodName: 'fund_credit', args: { account_id: playerId }, deposit: near(5), gas: teraToGas('30') })

  // --------------------------------------------------------------- the loop
  const quotes = await service.handle('GET', '/api/market', { item: 'iron_ingot', count: 2 })
  assert.equal(quotes.status, 200)
  assert.ok(quotes.body.merchants[0].reason, 'the merchant must explain its price')

  const before = await balance(playerId)

  const buy = await service.handle('POST', '/api/buy',
    { sessionId, merchantId: merchant.id, item: 'iron_ingot', count: 2 })
  assert.equal(buy.status, 200, JSON.stringify(buy.body))
  assert.ok(buy.body.hash, 'a successful buy must name its transaction')

  const sell = await service.handle('POST', '/api/sell',
    { sessionId, merchantId: merchant.id, item: 'iron_ingot', count: 1 })
  assert.equal(sell.status, 200, JSON.stringify(sell.body))

  const after = await balance(playerId)
  const me = await service.handle('GET', '/api/me', { sessionId })


  console.log('\n--- the play service, end to end ---')
  console.log(`  player   ${playerId}`)
  console.log(`  bought 2, sold 1 -> holding ${me.body.holdings.iron_ingot}`)
  console.log(`  player NEAR delta ${after - before} yoctoNEAR`)
  console.log(`  buy reported ${buy.body.playerNearDelta}, sell reported ${sell.body.playerNearDelta}\n`)

  // ------------------------------------------------- and it can back a merchant
  //
  // invest_with_credit is the non-payable twin of a #[payable] method, and it
  // exists for exactly one reason: a player holding one function-call key
  // cannot attach a deposit, so without it the mechanic the games prompt
  // describes would be unreachable by the players it is for. Until now no
  // client called it and this test never reached it.
  const stake = '1000000000000000000000'
  const invest = await service.handle('POST', '/api/invest',
    { sessionId, merchantId: merchant.id, amount: stake })
  assert.equal(invest.status, 200, JSON.stringify(invest.body))
  assert.equal(invest.body.playerNearDelta, '0', 'backing a merchant must also be free')

  const backer = await provider.callFunction({
    contractId: market.id, method: 'backer_of', args: { merchant_id: merchant.id },
  })
  assert.ok(backer, 'the contract must record who backed the merchant')
  assert.equal(backer.account_id, playerId, 'and record the player, not the relayer')
  assert.equal(backer.principal, stake, 'for exactly the amount staked')

  console.log(`  staked ${stake} yocto -> backer ${backer.account_id}, principal ${backer.principal}`)

  // The headline claim, measured rather than asserted.
  assert.equal(after - before, 0n, 'the player must not pay a single yoctoNEAR')
  assert.equal(buy.body.playerNearDelta, '0', 'and the service must report that honestly')
  assert.equal(sell.body.playerNearDelta, '0')
  assert.equal(me.body.holdings.iron_ingot, '1', 'bought two, sold one')
  assert.equal(me.body.fullAccessKeys, 0, 'still holding no full-access key after trading')
})

// ---------------------------------------------------------------------------
// The two-layer problem, fed a REAL receipt.
//
// `backend/near/outcome.mjs` scans `receipts_outcome[].outcome.status.Failure`
// and digs out `ActionError.kind.FunctionCallError.ExecutionError`. That path
// existed for weeks and NO test, fixture or script ever fed it nearcore JSON —
// `grep -rn innerFailure\|receipts_outcome` returned three lines: the
// definition, its loop, and its one call site.
//
// The test that looked like coverage, `tests/near/play.mjs:272`, stubs the whole
// relayer and throws a pre-made INNER_CALL_FAILED. It proves the service maps a
// code to 502. It exercises no parsing at all. Every relayed call in the tests
// above succeeds, and the one `assert.rejects` in this file is a SUBMISSION
// refusal, which fails the outer transaction — the opposite case.
//
// So the field path that stands between a player and "sold!" while they still
// hold the iron was never checked against the shape it parses. This checks it,
// against a real nearcore node, through the real relayer module.
test('a relayed call whose INNER action panics is reported as a failure, not a hash', async (t) => {
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayer = await sub('relayer', near(50))
  const player = await sub('player', near(1))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })

  await marketAcc.callFunction({
    contractId: items.id, methodName: 'mt_transfer',
    args: { receiver_id: player.id, token_id: 'iron_ingot', amount: '50', approval: null, memo: null },
    deposit: 1n, gas: teraToGas('30'),
  })

  // Onboard properly: a real approval exists, so the only thing wrong below is
  // the id. That matters — a MISSING approval panics on a different line, and
  // this test is about the one a real player hit in production.
  const playerFull = new Account(player.id, provider, player.key.toString())
  await playerFull.callFunction({
    contractId: items.id, methodName: 'mt_approve',
    args: { token_ids: ['iron_ingot'], amounts: ['1000000'], account_id: market.id, msg: null },
    deposit: near(1) / 100n, gas: teraToGas('60'),
  })
  const scoped = KeyPair.fromRandom('ed25519')
  await playerFull.signAndSendTransaction({
    receiverId: player.id,
    actions: [
      actions.addFunctionCallAccessKey(scoped.getPublicKey(), market.id, ['buy_with_credit', 'sell'], near(2)),
      actions.deleteKey(player.key.getPublicKey()),
    ],
  })

  const held = async () => BigInt(await provider.callFunction({
    contractId: items.id, method: 'mt_balance_of', args: { account_id: player.id, token_id: 'iron_ingot' },
  }))
  const creditOf = async () => BigInt(await provider.callFunction({
    contractId: market.id, method: 'credit_of', args: { account_id: player.id },
  }))

  const relay = createRelayer({
    relayerAccountId: relayer.id,
    relayerKey: relayer.key.toString(),
    marketContract: market.id,
    permittedMethods: ['buy_with_credit', 'sell'],
    rpcUrl: sandbox.rpcUrl,
  })

  const heldBefore = await held()

  // The exact production bug: a real approval, a stale id. nearcore runs the
  // outer transaction successfully — it was well formed, signed and paid for —
  // and the mt_transfer receipt inside it panics.
  let caught = null
  try {
    await relay.relay({
      playerAccountId: player.id, playerKey: scoped.toString(),
      methodName: 'sell',
      // A STRING, not a number: `approval_id` is near-sdk's U64, which
      // deserializes from a JSON string. Passing 999_999 bare made the call
      // panic on deserialization instead — which still proved the receipt walk
      // works, but tested the wrong panic.
      args: { merchant_id: merchant.id, item: 'iron_ingot', count: 10, approval_id: '999999' },
      gas: 120_000_000_000_000n,
    })
  } catch (e) { caught = e }

  console.log('\n--- a relayed call whose inner action panicked ---')
  console.log(`  threw      ${caught ? `${caught.code}: ${caught.detail ?? caught.message}` : 'NOTHING'}`)
  console.log(`  materials  ${heldBefore} -> ${await held()}`)
  console.log(`  credit     ${await creditOf()}\n`)

  assert.ok(caught, 'the relayer must not return normally for a call whose inner action panicked')
  assert.equal(caught.code, 'INNER_CALL_FAILED',
    `expected INNER_CALL_FAILED, got ${caught.code}: ${caught.message}`)
  // The contract's OWN words have to survive the receipt walk. If the field
  // path is wrong, `innerFailure` falls back to JSON.stringify of the whole
  // failure object and this is what notices.
  assert.match(String(caught.detail ?? caught.message), /approval_id does not match the current approval/,
    'the contract\'s panic text must reach the caller, not a stringified blob')

  // And the sale must not have half-happened.
  assert.equal(await held(), heldBefore, 'no materials may move when the pull fails')
})

test('two calls in flight for one player do not collide on the delegate nonce', async (t) => {
  // A relayed call is signed by the PLAYER's scoped key, so it consumes the
  // player's access-key nonce — not the relayer's. `createSignedMetaTransaction`
  // reads that nonce from the chain and uses nonce+1, so two calls built
  // concurrently for one player read the same number and build the same nonce.
  // nearcore accepts the first and rejects the second.
  //
  // This is reachable from the product, not a contrivance: `scripts/mc-up.mjs`
  // and the Minecraft plugin both let a player issue a second command before
  // the first has landed, and the web client does not disable its buttons. The
  // failure is loud, which is the right direction, but losing a player's action
  // because they were quick is not behaviour to keep.
  //
  // Only a real node can show this. A stub cannot reject a stale nonce.
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))
  const merchant = await sub('ironmonger', near(2))
  const relayer = await sub('relayer', near(50))
  const player = await sub('player', near(1))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '100000', receiver_id: market.id }, gas: teraToGas('60') })
  await root.callFunction({ contractId: market.id, methodName: 'register_merchant', args: { merchant_id: merchant.id, name: 'Ironmonger', floor: '0' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_merchant', args: { merchant_id: merchant.id }, deposit: near(10), gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'list_item', args: { merchant_id: merchant.id, item: 'iron_ingot', base_price: (near(1) / 10n).toString(), stock: '1000' }, gas: teraToGas('30') })
  await root.callFunction({ contractId: market.id, methodName: 'fund_credit', args: { account_id: player.id }, deposit: near(5), gas: teraToGas('30') })

  // A player who holds only a scoped key, which is the whole point.
  const playerFull = new Account(player.id, provider, player.key.toString())
  const scoped = KeyPair.fromRandom('ed25519')
  await playerFull.signAndSendTransaction({
    receiverId: player.id,
    actions: [
      actions.addFunctionCallAccessKey(scoped.getPublicKey(), market.id, ['buy_with_credit'], near(2)),
      actions.deleteKey(player.key.getPublicKey()),
    ],
  })

  const held = async () => BigInt(await provider.callFunction({
    contractId: items.id, method: 'mt_balance_of', args: { account_id: player.id, token_id: 'iron_ingot' },
  }))

  const relay = createRelayer({
    relayerAccountId: relayer.id,
    relayerKey: relayer.key.toString(),
    marketContract: market.id,
    permittedMethods: ['buy_with_credit'],
    rpcUrl: sandbox.rpcUrl,
  })

  const buy = (count) => relay.relay({
    playerAccountId: player.id, playerKey: scoped.toString(),
    methodName: 'buy_with_credit',
    args: { merchant_id: merchant.id, item: 'iron_ingot', count },
    gas: 120_000_000_000_000n,
  })

  // Both started before either is awaited. This is the race.
  const results = await Promise.allSettled([buy(3), buy(4)])

  console.log('\n--- two relays in flight for one player ---')
  results.forEach((r, i) => console.log(
    `  call ${i + 1}  ${r.status}${r.status === 'rejected' ? `  ${r.reason?.code ?? ''}: ${r.reason?.detail ?? r.reason?.message ?? ''}`.slice(0, 160) : ''}`,
  ))
  console.log(`  player holds  ${await held()} iron_ingot\n`)

  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(rejected.length, 0,
    `both relays should land; ${rejected.length} was rejected: ${rejected.map((r) => `${r.reason?.code}: ${r.reason?.detail ?? r.reason?.message}`).join(' | ')}`)
  // And both actually delivered, rather than one silently doing nothing.
  assert.equal(await held(), 7n, 'both purchases should have been delivered')
})

test('a sign-in that died half-way is resumed, not stranded forever', async (t) => {
  // `signIn` is three transactions and the bootstrap full-access key used to
  // be a local `const`. If step 2 threw — `mt_approve` panics on a token id
  // that was never minted, which is a config mistake, not an exotic one — the
  // key went with the stack frame. What was left on chain: an account that
  // EXISTS, holding a live full-access key nobody holds. And because `signIn`
  // only tests existence, every later login for that identity took the
  // `created: false` branch and returned no key at all, so the play service
  // answered 503 for that player forever. `npm run keys` reports exactly that
  // shape as FAIL.
  //
  // It needs a real node: the account has to really exist, the approval has to
  // really panic, and the key swap has to really land.
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)

  async function sub(name, funds) {
    const key = KeyPair.fromRandom('ed25519')
    await root.createSubAccount({
      accountOrPrefix: name, publicKey: key.getPublicKey().toString(), nearToTransfer: funds,
    })
    return { id: `${name}.${DEFAULT_ACCOUNT_ID}`, key }
  }

  const items = await sub('items', near(10))
  const market = await sub('market', near(20))

  const itemsAcc = new Account(items.id, provider, items.key.toString())
  const marketAcc = new Account(market.id, provider, market.key.toString())
  await itemsAcc.deployContract(await wasm('nearcraft_items'))
  await marketAcc.deployContract(await wasm('nearcraft_market'))
  await itemsAcc.callFunction({ contractId: items.id, methodName: 'new', args: { owner_id: market.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: market.id, methodName: 'new', args: { owner_id: root.accountId, items_contract: items.id }, gas: teraToGas('30') })
  await marketAcc.callFunction({ contractId: items.id, methodName: 'mt_mint', args: { token_id: 'iron_ingot', amount: '1000', receiver_id: market.id }, gas: teraToGas('60') })

  /// The store a real deployment supplies: gitignored, and holding a
  /// full-access key, so nothing here is ever logged or returned.
  const vault = new Map()
  const bootstrapStore = {
    async get(id) { return vault.get(id) ?? null },
    async set(id, key) { vault.set(id, key) },
    async delete(id) { vault.delete(id) },
  }

  const common = {
    rootAccountId: DEFAULT_ACCOUNT_ID,
    rootKey: DEFAULT_PRIVATE_KEY,
    marketContract: market.id,
    itemsContract: items.id,
    playerMethods: ['buy_with_credit', 'sell', 'invest_with_credit'],
    verifyIdentity: async (token) => ({ provider: 'seed', subject: String(token) }),
    rpcUrl: sandbox.rpcUrl,
    bootstrapStore,
  }

  // The misconfiguration: a material that was never minted. `mt_approve`
  // panics on it, so step 2 fails after step 1 has already paid for an account.
  const broken = createOnboarding({ ...common, sellableItems: ['mithril'] })
  const accountId = broken.playerAccountId('seed', 'unlucky-player')

  const died = await broken.signIn('unlucky-player').then(() => null, (e) => e)
  assert.ok(died, 'step 2 was supposed to fail')

  const strandedKeys = await broken.keyLimits(accountId)
  console.log('\n--- a sign-in that died at step 2 ---')
  console.log(`  account        ${accountId}`)
  console.log(`  threw          ${died.code ?? died.name}`)
  console.log(`  keys on chain  ${strandedKeys.length} (${strandedKeys.filter((k) => k.fullAccess).length} full-access)`)
  console.log(`  key parked     ${vault.has(accountId)}`)

  assert.equal(strandedKeys.filter((k) => k.fullAccess).length, 1,
    'the account should be left holding the live full-access key — that is the state being recovered from')
  assert.ok(vault.has(accountId), 'the bootstrap key must have been parked BEFORE the account was created')
  // Kept for the last case below, where this key is dead but still parked.
  const deadKey = vault.get(accountId)

  // The config is fixed and the player signs in again. Same identity, so the
  // same derived account — the one already sitting there half-finished.
  const fixed = createOnboarding({ ...common, sellableItems: ['iron_ingot'] })
  const session = await fixed.signIn('unlucky-player')

  const after = await fixed.keyLimits(accountId)
  console.log(`  resumed        ${session.resumed}`)
  console.log(`  server key     ${session.serverKey ? 'issued' : 'MISSING'}`)
  console.log(`  keys on chain  ${after.length} (${after.filter((k) => k.fullAccess).length} full-access)`)
  console.log(`  key parked     ${vault.has(accountId)}\n`)

  assert.equal(session.accountId, accountId, 'the same identity must land on the same account')
  assert.equal(session.resumed, true, 'this completed an earlier attempt, and should say so')
  assert.ok(session.serverKey, 'the whole point: a key comes back instead of a permanent 503')
  assert.equal(after.filter((k) => k.fullAccess).length, 0, 'no full-access key may survive onboarding')
  assert.equal(after.length, 1, 'exactly the one scoped key')
  assert.deepEqual(after[0].methodNames, ['buy_with_credit', 'sell', 'invest_with_credit'])
  assert.equal(after[0].receiverId, market.id)
  assert.equal(vault.has(accountId), false, 'the parked key must be dropped once it is dead on chain')

  // And the approval really landed this time, which is what makes the account
  // able to sell. Read from the chain, not inferred from the absence of a throw.
  const approved = await provider.callFunction({
    contractId: items.id, method: 'mt_is_approved',
    args: {
      token_ids: ['iron_ingot'], approved_account_id: market.id,
      amounts: ['1'], approval_ids: null, owner_id: accountId,
    },
  })
  assert.equal(approved, true, 'the resumed sign-in must leave the market approved to pull materials')

  // One state cannot be resumed, and it should say so rather than fail
  // obscurely: step 3 landed, so the account is correctly restricted and holds
  // no full-access key — but the scoped key it was restricted to was generated
  // in memory and never returned to anyone. No key left anywhere can issue
  // another. Modelled here by re-parking the key that is now dead on chain.
  vault.set(accountId, deadKey)
  const hopeless = await fixed.signIn('unlucky-player').then(() => null, (e) => e)
  console.log(`  dead key       ${hopeless?.code}`)
  assert.equal(hopeless?.code, 'ACCOUNT_ALREADY_RESTRICTED',
    `expected a named refusal, got ${hopeless?.code}: ${hopeless?.message}`)
  assert.equal(vault.has(accountId), false,
    'and a bootstrap key that no longer exists on chain must not be kept')
})

test('without a store, a half-finished account behaves exactly as it always did', async (t) => {
  // The resume is opt-in. Omit the store and this module stores nothing, which
  // is what the three players onboarded before it existed depend on: they have
  // no parked key, and must keep taking the `created: false` branch rather
  // than being dragged down a resume path with no key to resume from.
  const sandbox = await Sandbox.start({})
  t.after(() => sandbox.tearDown())

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl })
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY)

  const key = KeyPair.fromRandom('ed25519')
  await root.createSubAccount({
    accountOrPrefix: 'market', publicKey: key.getPublicKey().toString(), nearToTransfer: near(5),
  })
  const marketId = `market.${DEFAULT_ACCOUNT_ID}`

  const onboarding = createOnboarding({
    rootAccountId: DEFAULT_ACCOUNT_ID,
    rootKey: DEFAULT_PRIVATE_KEY,
    marketContract: marketId,
    sellableItems: [],
    playerMethods: ['buy_with_credit'],
    verifyIdentity: async (token) => ({ provider: 'seed', subject: String(token) }),
    rpcUrl: sandbox.rpcUrl,
  })

  const first = await onboarding.signIn('returning-player')
  assert.equal(first.created, true)
  assert.ok(first.serverKey)
  assert.equal(first.resumed, false, 'a first sign-in resumes nothing')

  const second = await onboarding.signIn('returning-player')
  assert.equal(second.created, false, 'an existing account is not re-created')
  assert.equal(second.serverKey, undefined, 'and with nothing stored there is no key to hand back')
})
