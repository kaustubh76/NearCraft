// What an agent is allowed to do with money, and the refusal that enforces it.
//
// This file replaces EthCraft's `agent-shop.mjs`, which was the single HTTP
// endpoint its agent loop used to reach settlement. On EVM that enforcement
// needed four layers of our own code — two Privy delegate quorums, two policy
// documents compared by fingerprint, disjoint allowed-target sets, and ABI
// decoding of calldata. On NEAR most of it is a protocol primitive.
//
// What remains here is deliberately *not* the only protection. Three
// independent bounds have to hold for an agent to spend anything:
//
//   1. this policy layer, which refuses before a signature is ever requested
//   2. the function-call access key, whose `method_names` the RUNTIME enforces
//      and which cannot transfer NEAR or add keys at all
//   3. the spend budget inside the market contract
//
// Layer 1 is the weakest of the three, because it is the only one that is our
// code. It exists so that refusals are legible and logged, not because the
// other two need help.

/// Errors are thrown as this class so a caller can tell a policy refusal from a
/// bug or a network failure, and never retry one as if it were transient.
export class PolicyRefusal extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'PolicyRefusal'
    this.code = code
    this.detail = detail
  }
}

/// A frozen policy. `methods` must list every method the agent may name — an
/// empty list is refused rather than treated as "any", because that is exactly
/// how NEAR reads an empty `method_names` and it is the wrong default here.
export function agentPolicy({ agentId, marketContract, methods, maxUnitsPerOrder, maxOrdersOutstanding = 1 }) {
  if (!agentId || !marketContract) throw new PolicyRefusal('POLICY_INCOMPLETE', 'agentId and marketContract are required')
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new PolicyRefusal('POLICY_EMPTY_METHOD_LIST', 'an empty method list would permit every method')
  }
  if (!Number.isInteger(maxUnitsPerOrder) || maxUnitsPerOrder <= 0) {
    throw new PolicyRefusal('POLICY_NO_ORDER_CAP', 'maxUnitsPerOrder must be a positive integer')
  }
  return Object.freeze({
    agentId,
    marketContract,
    methods: Object.freeze([...methods]),
    maxUnitsPerOrder,
    maxOrdersOutstanding,
  })
}

/// Every field an agent-initiated call is permitted to carry, per method. A
/// request with any other key is refused outright rather than filtered, because
/// an unexpected field means the caller believes something we do not implement.
const ALLOWED_FIELDS = {
  buy_with_credit: ['merchant_id', 'item', 'count'],
}

const ITEM = /^[a-z][a-z0-9_]{1,30}$/
const ACCOUNT = /^[a-z0-9._-]{2,64}$/

/// Decide whether an agent may make this call. Returns a frozen, normalised
/// intent; throws `PolicyRefusal` otherwise. Pure — no I/O, no signing.
export function authorize(policy, request, { outstanding = 0 } = {}) {
  if (!request || typeof request !== 'object') throw new PolicyRefusal('REQUEST_NOT_AN_OBJECT')

  const { contractId, methodName, args, deposit } = request

  // An agent never names a contract other than the market it was scoped to.
  if (contractId !== policy.marketContract) {
    throw new PolicyRefusal('CONTRACT_NOT_PERMITTED', `${contractId} is not ${policy.marketContract}`)
  }
  if (!policy.methods.includes(methodName)) {
    throw new PolicyRefusal('METHOD_NOT_PERMITTED', `${methodName} is not in [${policy.methods}]`)
  }
  // A function-call key cannot attach a deposit, so a request carrying one is
  // either confused or an attempt to use the wrong key. Refuse either way.
  if (deposit !== undefined && String(deposit) !== '0') {
    throw new PolicyRefusal('DEPOSIT_NOT_PERMITTED', 'a function-call key cannot attach NEAR')
  }

  const allowed = ALLOWED_FIELDS[methodName]
  if (!allowed) throw new PolicyRefusal('METHOD_HAS_NO_FIELD_POLICY', methodName)
  if (!args || typeof args !== 'object') throw new PolicyRefusal('ARGS_NOT_AN_OBJECT')

  const extra = Object.keys(args).filter((k) => !allowed.includes(k))
  if (extra.length) throw new PolicyRefusal('UNEXPECTED_ARGUMENT', extra.join(', '))
  const missing = allowed.filter((k) => args[k] === undefined)
  if (missing.length) throw new PolicyRefusal('MISSING_ARGUMENT', missing.join(', '))

  if (!ACCOUNT.test(String(args.merchant_id))) throw new PolicyRefusal('MERCHANT_ID_MALFORMED', String(args.merchant_id))
  // A merchant must be under the same root as the market, so an agent cannot be
  // talked into trading with an account an attacker controls.
  const root = policy.marketContract.split('.').slice(1).join('.')
  if (!String(args.merchant_id).endsWith(`.${root}`)) {
    throw new PolicyRefusal('MERCHANT_OUTSIDE_WORLD', `${args.merchant_id} is not under ${root}`)
  }
  if (!ITEM.test(String(args.item))) throw new PolicyRefusal('ITEM_MALFORMED', String(args.item))

  const count = args.count
  if (!Number.isInteger(count) || count <= 0) throw new PolicyRefusal('COUNT_NOT_A_POSITIVE_INTEGER', String(count))
  if (count > policy.maxUnitsPerOrder) {
    throw new PolicyRefusal('ORDER_TOO_LARGE', `${count} exceeds ${policy.maxUnitsPerOrder}`)
  }

  if (outstanding >= policy.maxOrdersOutstanding) {
    throw new PolicyRefusal('ORDER_ALREADY_OUTSTANDING', `${outstanding} in flight`)
  }

  return Object.freeze({
    contractId: policy.marketContract,
    methodName,
    args: Object.freeze({ merchant_id: String(args.merchant_id), item: String(args.item), count }),
    deposit: '0',
  })
}

/// A stable fingerprint of an authorised intent.
///
/// Ported from EthCraft's pending-effect fencing: the intent is pinned *before*
/// the call goes out, and a reply that does not match the pinned intent is
/// refused rather than reconciled. An uncertain send never becomes a second
/// purchase.
export function intentId(intent) {
  return `${intent.contractId}|${intent.methodName}|${intent.args.merchant_id}|${intent.args.item}|${intent.args.count}`
}
