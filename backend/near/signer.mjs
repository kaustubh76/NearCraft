// The only path by which an agent's intent becomes a signed NEAR transaction.
//
// It holds a function-call access key and nothing else. It refuses out-of-policy
// requests before a signature is requested, and it can verify against the chain
// that the key it holds really is as narrow as it believes.

import { Account, JsonRpcProvider, KeyPair } from 'near-api-js'
import { authorize, intentId, PolicyRefusal } from './policy.mjs'

export { PolicyRefusal }

/// Gas for one `buy_with_credit`, which makes one cross-contract call and one
/// callback. Drawn from the key's allowance, which is gas-only.
const GAS = 60_000_000_000_000n

export function createAgentSigner({ policy, secretKey, rpcUrl = 'https://rpc.testnet.near.org', log = () => {} }) {
  if (!secretKey) throw new PolicyRefusal('NO_AGENT_KEY', 'the agent has no function-call key')
  const provider = new JsonRpcProvider({ url: rpcUrl })
  const keyPair = KeyPair.fromString(secretKey)
  const publicKey = keyPair.getPublicKey().toString()
  const account = new Account(policy.agentId, provider, secretKey)

  /// Pinned intent of the call currently in flight. Set before the call goes
  /// out and cleared only by a matching reply, so an uncertain send is
  /// reconciled against the same intent rather than becoming a second order.
  let pending = null

  /// Ask the chain what this key may actually do. Cheap, and worth doing at
  /// startup: a key that turned out to be full-access, or scoped to the wrong
  /// contract, should stop the agent rather than be trusted.
  async function verifyKeyScope() {
    const view = await provider.query({
      request_type: 'view_access_key',
      finality: 'final',
      account_id: policy.agentId,
      public_key: publicKey,
    })
    const permission = view?.permission
    if (permission === 'FullAccess' || permission?.FullAccess !== undefined) {
      throw new PolicyRefusal('AGENT_KEY_IS_FULL_ACCESS', 'an agent must never sign with a full-access key')
    }
    const fc = permission?.FunctionCall
    if (!fc) throw new PolicyRefusal('AGENT_KEY_PERMISSION_UNREADABLE', JSON.stringify(permission))
    if (fc.receiver_id !== policy.marketContract) {
      throw new PolicyRefusal('AGENT_KEY_WRONG_RECEIVER', `${fc.receiver_id} is not ${policy.marketContract}`)
    }
    // Empty means "any method on that contract" — never acceptable here.
    if (!fc.method_names?.length) {
      throw new PolicyRefusal('AGENT_KEY_UNRESTRICTED', 'method_names is empty, which permits every method')
    }
    const widened = fc.method_names.filter((m) => !policy.methods.includes(m))
    if (widened.length) {
      throw new PolicyRefusal('AGENT_KEY_WIDER_THAN_POLICY', widened.join(', '))
    }
    return Object.freeze({
      publicKey,
      receiverId: fc.receiver_id,
      methodNames: Object.freeze([...fc.method_names]),
      allowance: fc.allowance ?? null,
    })
  }

  /// Authorise and send. Throws `PolicyRefusal` without contacting the network
  /// when the request is out of policy.
  async function call(request, { outstanding = pending ? 1 : 0 } = {}) {
    let intent
    try {
      intent = authorize(policy, request, { outstanding })
    } catch (refusal) {
      log({ event: 'refused', agent: policy.agentId, code: refusal.code, detail: refusal.detail, request })
      throw refusal
    }

    const id = intentId(intent)
    pending = id
    log({ event: 'authorized', agent: policy.agentId, intent: id })
    try {
      const outcome = await account.callFunction({
        contractId: intent.contractId,
        methodName: intent.methodName,
        args: intent.args,
        gas: GAS,
        deposit: 0n,
      })
      log({ event: 'settled', agent: policy.agentId, intent: id })
      return outcome
    } catch (error) {
      // Deliberately does NOT clear `pending`: an uncertain send must be
      // reconciled against this same intent, never replaced by a fresh one.
      log({ event: 'uncertain', agent: policy.agentId, intent: id, error: String(error?.message ?? error) })
      throw error
    } finally {
      if (pending === id) pending = null
    }
  }

  return Object.freeze({ agentId: policy.agentId, publicKey, policy, call, verifyKeyScope })
}
