// The only path by which an agent's intent becomes a signed NEAR transaction.
//
// It holds a function-call access key and nothing else. It refuses out-of-policy
// requests before a signature is requested, and it can verify against the chain
// that the key it holds really is as narrow as it believes.

import { Account, JsonRpcProvider, KeyPair } from 'near-api-js'
import { authorize, intentId, PolicyRefusal } from './policy.mjs'
import { ALLOW, BLOCK, WARN } from './counterparty.mjs'
import { assertInnerSuccess, InnerCallFailed, transactionHash } from './outcome.mjs'

export { PolicyRefusal, InnerCallFailed }

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

/// Re-exported from `outcome.mjs`, which is now the single home for "did this
/// actually succeed?". Kept exported here because scripts import it from this
/// module and there is no reason to make them move.
export { transactionHash }

/// Gas for one `buy_with_credit`, which makes one cross-contract call and one
/// callback. Drawn from the key's allowance, which is gas-only.
const GAS = 60_000_000_000_000n

export function createAgentSigner({ policy, secretKey, rpcUrl = 'https://test.rpc.fastnear.com', log = () => {}, counterparty = null }) {
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

  /// The same check, made to actually happen.
  ///
  /// `verifyKeyScope` was written at the start and then never called from
  /// anywhere — the audit found the definition, the export, and a comment at
  /// `screen()` leaning on it, and no call site. So the one bound the agent
  /// kept when no counterparty service was wired in was never checked against
  /// the chain.
  ///
  /// Memoised for the ordinary path: one RPC per signer, not one per call.
  ///
  /// Memoised is NOT the same as permanent, and the difference matters. A key's
  /// permission CAN widen in place — `DeleteKey(pk)` then `AddKey(pk,
  /// FullAccess)` keeps the same public key and anyone holding the account's
  /// full-access key can do it. So `approve()` below re-verifies rather than
  /// reading this memo: a parked call waits on a person for an unbounded time,
  /// and that is the one window long enough for the key underneath it to
  /// change. Everywhere else the memo is read, because the gap between
  /// authorising a call and signing it is microseconds.
  ///
  /// A failure is NOT cached. A node that was unreachable at the first call
  /// says nothing about the key, and caching that would turn a blip into an
  /// agent that never signs again.
  let scopeCheck = null
  function assertScope() {
    if (!scopeCheck) {
      scopeCheck = verifyKeyScope().catch((e) => {
        scopeCheck = null
        throw e
      })
    }
    return scopeCheck
  }

  /// Ask the counterparty service about whoever is about to be paid.
  ///
  /// `block` refuses outright. `warn` parks the call for a human. `allow`
  /// proceeds. With no service wired in, this is skipped — and the key scope
  /// check still holds, so the agent is never unbounded, only less well
  /// informed. That sentence was false until `assertScope` was wired into both
  /// signing paths: the check existed and nothing ran it.
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

    // After `authorize`, which is offline: an out-of-policy request must keep
    // costing nothing. Before everything else, because a key that turned out
    // to be full-access should stop the agent rather than be screened,
    // approved and then used.
    await assertScope()

    const id = intentId(intent)
    await screen(intent, id)

    pending = id
    log({ event: 'authorized', agent: policy.agentId, intent: id })
    try {
      // `assertInnerSuccess`, not a bare await. v7 throws only on the
      // TOP-LEVEL status, and a contract that rolls its own failure back — as
      // `on_items_delivered` does — leaves that status SuccessValue. Without
      // this line a rolled-back purchase was logged as `settled` and
      // `scripts/agent-run.mjs` asserted on it as proof the run worked.
      const outcome = assertInnerSuccess(await account.callFunctionRaw({
        contractId: intent.contractId,
        methodName: intent.methodName,
        args: intent.args,
        gas: GAS,
        deposit: 0n,
      }))
      log({ event: 'settled', agent: policy.agentId, intent: id })
      return outcome
    } catch (error) {
      // A rolled-back call is not an UNCERTAIN one. We know exactly what
      // happened: it landed, the inner call failed, the contract unwound it.
      // Logging that as uncertain would invite a reconciliation that has
      // nothing to reconcile.
      const settled = error instanceof InnerCallFailed
      log({
        event: settled ? 'rolled_back' : 'uncertain',
        agent: policy.agentId, intent: id,
        error: String(error?.message ?? error),
        ...(settled ? { hash: transactionHash(error.outcome) } : {}),
      })
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

    // Re-verified from the chain, not read from the memo. A person approving
    // a trade is not a person approving the key it gets signed with, and this
    // is the only path where enough time passes for that key to have been
    // deleted and re-added wider underneath the decision.
    await verifyKeyScope()

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
      // The order here is load-bearing. `assertInnerSuccess` throws BEFORE
      // `recordSuccess`, because `recordSuccess` increments the counter
      // `counterparty.score()` reads for INTERACTIONS_FOR_TRUST — so without
      // it, a purchase the contract rolled back earned the counterparty trust
      // towards clearing itself without a human next time. A failed trade must
      // buy nothing.
      const outcome = assertInnerSuccess(await account.callFunctionRaw({
        contractId: held.intent.contractId, methodName: held.intent.methodName,
        args: held.intent.args, gas: GAS, deposit: 0n,
      }))
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
