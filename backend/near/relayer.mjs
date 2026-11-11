// Pays the gas so the player never sees a gas prompt.
//
// NEP-366 meta transactions: the player's scoped key signs a *delegate action*,
// and a relayer account submits it wrapped in a transaction of its own. The
// relayer pays, which is the whole mechanism behind the games track's "no gas
// prompts in the normal game loop".
//
// Measured in a sandbox (`tests/near/gasless.mjs`), not assumed:
//
//   * A **function-call access key can sign a delegate action.** It does not
//     need to be full-access.
//   * When the relayer submits it, **the relayer pays and the player's balance
//     does not move** — measured delta of exactly 0 for the player.
//   * **The inner action cannot carry a deposit.** nearcore answers "Deposit is
//     not allowed with function call". The function-call key's no-deposit rule
//     applies to the delegate's inner action too, which is why players buy from
//     a credit balance rather than by attaching NEAR — and why selling is
//     blocked, since NEP-245 mandates 1 yoctoNEAR on `mt_transfer_call`. See
//     docs/GASLESS.md.
//
// An API seam worth knowing: `createSignedMetaTransaction` resolves to
// `{delegateHash, signedDelegate}`, while `relayMetaTransaction` wants the bare
// `signedDelegate`. Passing the wrapper fails with an unhelpful
// "cannot read properties of undefined (reading 'senderId')".

import { Account, JsonRpcProvider, actions, teraToGas } from 'near-api-js'

export class RelayRefusal extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'RelayRefusal'
    this.code = code
    this.detail = detail
  }
}

export const DEFAULT_GAS = teraToGas('60')

/// Build the delegate action a player's scoped key will sign.
///
/// Pure. `deposit` is deliberately absent and not a parameter: nearcore refuses
/// a deposit on the inner action of a delegate signed by a function-call key, so
/// offering the option would only let a caller build something that cannot be
/// relayed.
export function playerCall({ marketContract, methodName, args, gas = DEFAULT_GAS }) {
  if (!marketContract) throw new RelayRefusal('NO_MARKET_CONTRACT')
  if (!methodName) throw new RelayRefusal('NO_METHOD')
  return {
    receiverId: marketContract,
    actions: [actions.functionCall(methodName, args ?? {}, gas, 0n)],
  }
}

/// A relayer. Holds a funded account and pays for other people's calls.
export function createRelayer({
  relayerAccountId,
  relayerKey,
  marketContract,
  permittedMethods,
  rpcUrl = 'https://test.rpc.fastnear.com',
  log = () => {},
}) {
  if (!relayerKey) throw new RelayRefusal('NO_RELAYER_KEY')
  // A relayer that will submit anything is an open faucet for whoever asks, so
  // it keeps its own allowlist rather than trusting the caller's.
  if (!Array.isArray(permittedMethods) || permittedMethods.length === 0) {
    throw new RelayRefusal('EMPTY_METHOD_LIST', 'a relayer that submits anything is an open faucet')
  }

  const provider = new JsonRpcProvider({ url: rpcUrl })
  const allowed = new Set(permittedMethods)
  // Lazy: constructing a relayer should not derive a key, and an unrelayable
  // method should be refused before any signer is built.
  let relayer = null
  const asRelayer = () => (relayer ??= new Account(relayerAccountId, provider, relayerKey))

  return Object.freeze({
    relayerAccountId,

    /// Sign as the player with their scoped key, then submit and pay as the
    /// relayer. Returns the outcome plus what it cost the relayer.
    async relay({ playerAccountId, playerKey, methodName, args, gas = DEFAULT_GAS }) {
      if (!allowed.has(methodName)) {
        throw new RelayRefusal('METHOD_NOT_RELAYED', `${methodName} is not in [${[...allowed]}]`)
      }
      const player = new Account(playerAccountId, provider, playerKey)
      const built = playerCall({ marketContract, methodName, args, gas })

      let signed
      try {
        signed = await player.createSignedMetaTransaction(built)
      } catch (e) {
        throw new RelayRefusal('PLAYER_COULD_NOT_SIGN', e?.message ?? String(e))
      }

      const before = await this.balance(relayerAccountId)
      // The wrapper is unwrapped here; see the note at the top of this file.
      const outcome = await asRelayer().relayMetaTransaction(signed.signedDelegate)
      const after = await this.balance(relayerAccountId)

      log({
        event: 'relayed', player: playerAccountId, methodName,
        relayerPaid: (before - after).toString(),
      })
      return { outcome, relayerPaid: before - after }
    },

    async balance(accountId) {
      const a = await provider.query({
        request_type: 'view_account', finality: 'optimistic', account_id: accountId,
      })
      return BigInt(a.amount)
    },
  })
}
