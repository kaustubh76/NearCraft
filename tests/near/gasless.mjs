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
//      from a credit balance, and why selling is blocked for a scoped key —
//      NEP-245 mandates 1 yoctoNEAR on `mt_transfer_call`. See docs/GASLESS.md.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox'
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from 'near-api-js'

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
    methodNames: ['buy_with_credit'],
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
