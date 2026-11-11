// The only path by which an agent's intent becomes a signed NEAR transaction.
//
// It holds a function-call access key and nothing else. It refuses out-of-policy
// requests before a signature is requested, and it can verify against the chain
// that the key it holds really is as narrow as it believes.

import { Account, JsonRpcProvider, KeyPair } from 'near-api-js'
import { authorize, intentId, PolicyRefusal } from './policy.mjs'
import { ALLOW, BLOCK, WARN } from './counterparty.mjs'

export { PolicyRefusal }

/// Raised when a counterparty check came back `warn`: the call is parked and a
/// human has to decide. Deliberately a distinct type from `PolicyRefusal` — a
/// caller that cannot tell "refused" from "waiting for a person" will either
/// retry something it shouldn't or drop something it should have escalated.
export class HumanApprovalRequired extends Error {
  constructor(intentId, reasons) {
    super(`a human must approve this call: ${reasons.join('; ')}`)
    this.name = 'HumanApprovalRequired'
    this.code = 'HUMAN_APPROVAL_REQUIRED'
    this.intentId = intentId
    this.reasons = reasons
  }
}

/// Gas for one `buy_with_credit`, which makes one cross-contract call and one
/// callback. Drawn from the key's allowance, which is gas-only.
const GAS = 60_000_000_000_000n

export function createAgentSigner({ policy, secretKey, rpcUrl = 'https://rpc.testnet.near.org', log = () => {}, counterparty = null }) {
  if (!secretKey) throw new PolicyRefusal('NO_AGENT_KEY', 'the agent has no function-call key')
  const provider = new JsonRpcProvider({ url: rpcUrl })
  const keyPair = KeyPair.fromString(secretKey)
  const publicKey = keyPair.getPublicKey().toString()
  const account = new Account(policy.agentId, provider, secretKey)

  /// Pinned intent of the call currently in flight. Set before the call goes
  /// out and cleared only by a matching reply, so an uncertain send is
  /// reconciled against the same intent rather than becoming a second order.
  let pending = null

  /// Calls a human has to rule on, keyed by intent id. A `warn` lands here
  /// instead of being signed or thrown away.
  const awaitingHuman = new Map()

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

  /// Ask the counterparty service about whoever is about to be paid.
  ///
  /// `block` refuses outright. `warn` parks the call for a human. `allow`
  /// proceeds. With no service wired in, this is skipped — and `verifyKeyScope`
  /// still holds, so the agent is never unbounded, only less well informed.
  async function screen(intent, id) {
    if (!counterparty) return
    const subject = intent.args.merchant_id
    const check = await counterparty.check(policy.agentId, subject)
    log({ event: 'counterparty', agent: policy.agentId, subject, verdict: check.verdict, reasons: check.reasons })

    if (check.verdict === BLOCK) {
      throw new PolicyRefusal('COUNTERPARTY_BLOCKED', `${subject}: ${check.reasons.join('; ')}`)
    }
    if (check.verdict === WARN) {
      awaitingHuman.set(id, { intent, reasons: check.reasons, raisedAt: Date.now() })
      throw new HumanApprovalRequired(id, check.reasons)
    }
    if (check.verdict !== ALLOW) {
      // An unrecognised verdict must not be read as permission.
      throw new PolicyRefusal('COUNTERPARTY_VERDICT_UNKNOWN', String(check.verdict))
    }
  }

  /// Authorise and send. Throws `PolicyRefusal` without contacting the network
  /// when the request is out of policy, or `HumanApprovalRequired` when the
  /// counterparty check wants a person to look.
  async function call(request, { outstanding = pending ? 1 : 0 } = {}) {
    let intent
    try {
      intent = authorize(policy, request, { outstanding })
    } catch (refusal) {
      log({ event: 'refused', agent: policy.agentId, code: refusal.code, detail: refusal.detail, request })
      throw refusal
    }

    const id = intentId(intent)
    await screen(intent, id)

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

  /// Calls currently waiting on a person, oldest first.
  function pendingDecisions() {
    return [...awaitingHuman.entries()].map(([id, held]) => ({
      intentId: id, reasons: held.reasons, raisedAt: held.raisedAt,
      merchantId: held.intent.args.merchant_id, item: held.intent.args.item, count: held.intent.args.count,
    }))
  }

  /// A human says yes. The counterparty is re-checked first: an approval given
  /// a minute ago does not license paying an account that has since been
  /// blocked, and a person cannot override a `block`.
  async function approve(id) {
    const held = awaitingHuman.get(id)
    if (!held) throw new PolicyRefusal('NO_SUCH_PENDING_DECISION', id)
    awaitingHuman.delete(id)

    if (counterparty) {
      const recheck = await counterparty.check(policy.agentId, held.intent.args.merchant_id)
      if (recheck.verdict === BLOCK) {
        log({ event: 'approval_overruled', agent: policy.agentId, intent: id, reasons: recheck.reasons })
        throw new PolicyRefusal('COUNTERPARTY_BLOCKED_SINCE_APPROVAL', recheck.reasons.join('; '))
      }
    }

    pending = id
    log({ event: 'human_approved', agent: policy.agentId, intent: id })
    try {
      const outcome = await account.callFunction({
        contractId: held.intent.contractId, methodName: held.intent.methodName,
        args: held.intent.args, gas: GAS, deposit: 0n,
      })
      log({ event: 'settled', agent: policy.agentId, intent: id, afterHumanApproval: true })
      if (counterparty?.recordSuccess) {
        await counterparty.recordSuccess(policy.agentId, held.intent.args.merchant_id, 0)
      }
      return outcome
    } finally {
      if (pending === id) pending = null
    }
  }

  /// A human says no. The call is discarded; nothing is signed.
  function reject(id, note = '') {
    if (!awaitingHuman.delete(id)) throw new PolicyRefusal('NO_SUCH_PENDING_DECISION', id)
    log({ event: 'human_rejected', agent: policy.agentId, intent: id, note })
  }

  return Object.freeze({
    agentId: policy.agentId, publicKey, policy, call, verifyKeyScope,
    pendingDecisions, approve, reject,
  })
}
