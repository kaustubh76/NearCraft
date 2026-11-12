// Shared NEAR wiring for every script in this repo.
//
// near-api-js v7 removed `connect()` and all the keystores: you build a
// JsonRpcProvider and hand an Account a key directly. Nothing here reads a
// global config file, so a judge can point these scripts at their own accounts.

import { readFile } from 'node:fs/promises'
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js'

/// `rpc.testnet.near.org` is **deprecated** and answers HTTP 429 with
/// "THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!" — it killed a live deploy
/// part-way through. FastNEAR's testnet endpoint is the documented replacement
/// and was verified returning chain_id "testnet" before this change.
export const RPC_URL = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com'

/// Read-only access needs no credentials at all.
export function provider() {
  return new JsonRpcProvider({ url: RPC_URL })
}

/// Account ids are derived from the root, so there is one name to change.
export function names(root = rootAccountId()) {
  return {
    root,
    items: `items.${root}`,
    market: `market.${root}`,
    guard: `guard.${root}`,
    relayer: `relayer.${root}`,
    sub: (prefix) => `${prefix}.${root}`,
  }
}

export function rootAccountId() {
  return process.env.NEAR_ROOT_ACCOUNT || 'nearcraftmc.testnet'
}

/// The signing root account. Throws a readable message rather than a stack
/// trace when the key is absent, because that is the normal state of a fresh
/// clone and a judge should not have to debug it.
export function rootAccount() {
  const key = process.env.NEAR_ROOT_KEY
  if (!key) {
    throw new Error(
      'NEAR_ROOT_KEY is not set.\n' +
      '  This script signs transactions, so it needs the root account\'s key.\n' +
      `  Create ${rootAccountId()} at https://near-faucet.io, then:\n` +
      `    export NEAR_ROOT_ACCOUNT=${rootAccountId()}\n` +
      '    export NEAR_ROOT_KEY=ed25519:...\n' +
      '  Read-only checks (npm run reads, npm run keys) need neither.'
    )
  }
  return new Account(rootAccountId(), provider(), key)
}

export async function catalog() {
  return JSON.parse(await readFile(new URL('../config/catalog.json', import.meta.url), 'utf8'))
}

/// NEAR amounts in the catalog are written as human strings ("0.40"); on-chain
/// they are yoctoNEAR. Done with BigInt string maths so no float ever touches a
/// token amount.
export function toYocto(amount) {
  const [whole, frac = ''] = String(amount).split('.')
  return BigInt(whole + frac.padEnd(24, '0').slice(0, 24))
}

export function fromYocto(yocto) {
  const s = BigInt(yocto).toString().padStart(25, '0')
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, '')
  const frac = s.slice(-24).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

export async function view(contractId, method, args = {}) {
  return provider().callFunction({ contractId, method, args })
}
