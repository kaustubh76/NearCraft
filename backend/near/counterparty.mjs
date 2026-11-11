// Before an agent pays anyone, ask about them.
//
// The AI Security & Defense track asks for a counterparty check that returns
// allow, warn or block plus reasons. The four signals it names, and where each
// actually comes from, are written up in docs/SECURITY_SIGNALS.md — including
// what each one cannot tell us, which matters more than what it can.
//
// Two deliberate properties:
//
//   * **No API key, no indexer.** Only public RPC plus this service's own
//     records. A safety service that needs a credential to answer is much less
//     useful to an agent, and it keeps the whole submission credential-free.
//     The cost is that true account age is unavailable; we use a proxy and say
//     so rather than dressing it up.
//   * **Scoring is pure.** `score()` takes gathered signals and returns a
//     verdict with no I/O, so the policy that matters is unit-testable offline.
//     Gathering is separate and does the network work.

import { readFile, writeFile, mkdir } from 'node:fs/promises'

/// The guard contract answers in snake_case, as NEAR contracts do over JSON.
/// Accepting either shape here is the fix for a bug an end-to-end run caught
/// and the unit tests did not: the scorer read camelCase, so every on-chain
/// report was silently ignored and a reported account scored clean. Normalising
/// at the boundary keeps the wire shape in exactly one place.
export function normaliseGuard(summary) {
  const g = summary ?? {}
  return {
    distinctReporters: Number(g.distinct_reporters ?? g.distinctReporters ?? 0),
    atOrOverThreshold: Boolean(g.at_or_over_threshold ?? g.atOrOverThreshold ?? false),
    threshold: Number(g.threshold ?? 0),
    reasons: g.reasons ?? [],
  }
}

export const ALLOW = 'allow'
export const WARN = 'warn'
export const BLOCK = 'block'

/// An account with no contract has this code hash. All ones, 32 chars.
const NO_CONTRACT = '11111111111111111111111111111111'

/// Below this, an account holds little more than its keys. A bare account with
/// one key measures ~182 bytes; 264 was observed on a faucet-funded one.
///
/// Calibration note, from an end-to-end run: this cannot be adverse on its own.
/// *Every* legitimate new account is near the floor, so treating it as adverse
/// unconditionally made `allow` unreachable for anyone, forever. It now counts
/// only for an account this service has never seen before — where it adds
/// something to "unknown" — and stops mattering once there is history.
const FRESH_STORAGE_BYTES = 400

/// Prior successful interactions before a counterparty can be trusted outright.
const INTERACTIONS_FOR_TRUST = 3

/// Pure. Turns gathered signals into a verdict and the reasons for it.
///
/// Rules, in the order they are applied:
///   1. An explicit local denylist entry blocks. Operator judgment wins.
///   2. On-chain reports at or over the guard's threshold block **only when
///      corroborated** by an independent adverse signal. Reports are
///      sybil-reportable, so reports alone can never reach `block`.
///   3. Anything adverse or unknown warns.
///   4. `allow` needs a history: prior successful interactions and nothing
///      adverse. **Unknown defaults to `warn`, never `allow`** — a safety
///      service that is optimistic about strangers is worse than none.
export function score(signals) {
  const reasons = []
  const s = signals ?? {}
  const guard = s.guard ?? { distinctReporters: 0, atOrOverThreshold: false, threshold: 0, reasons: [] }
  const prior = s.priorInteractions ?? null

  if (s.denylisted) {
    return verdict(BLOCK, ['on this deployment\'s explicit denylist'], s)
  }

  // Adverse signals that are independent of what anyone reported.
  const adverse = []
  if (s.exists === false) adverse.push('the account does not exist on chain')
  if (s.codeChangedSinceFirstSeen === true) {
    adverse.push('the contract code changed since this service first saw it')
  }
  if (s.exists !== false && s.isContract && s.firstSeenBlockHeight == null) {
    adverse.push('a contract this service has never seen before')
  }
  const unseen = s.firstSeenBlockHeight == null
  const fresh = s.exists !== false && typeof s.storageUsage === 'number' && s.storageUsage < FRESH_STORAGE_BYTES
  if (fresh && unseen) adverse.push(`barely-used account, never seen before (${s.storageUsage} bytes of storage)`)

  if (guard.atOrOverThreshold) {
    const why = `${guard.distinctReporters} distinct accounts reported this one (threshold ${guard.threshold})`
    if (adverse.length) {
      return verdict(BLOCK, [why, ...adverse], s)
    }
    // Reported, but nothing independent agrees. Deliberately not a block.
    reasons.push(`${why} — but no independent signal corroborates it, so this is a warning rather than a block`)
  } else if (guard.distinctReporters > 0) {
    reasons.push(`${guard.distinctReporters} account(s) reported this one, below the threshold of ${guard.threshold}`)
  }

  reasons.push(...adverse)

  if (prior && prior.count >= INTERACTIONS_FOR_TRUST && reasons.length === 0) {
    return verdict(ALLOW, [`${prior.count} prior successful interactions and nothing adverse`], s)
  }
  if (!prior || prior.count === 0) {
    reasons.push('no prior interaction between this agent and this account')
  } else if (prior.count < INTERACTIONS_FOR_TRUST) {
    reasons.push(`only ${prior.count} prior interaction(s); ${INTERACTIONS_FOR_TRUST} needed to trust outright`)
  }

  return verdict(reasons.length ? WARN : ALLOW, reasons, s)
}

function verdict(v, reasons, signals) {
  return Object.freeze({ verdict: v, reasons: Object.freeze([...reasons]), signals })
}

// ------------------------------------------------------------------- ledger

/// What this service remembers: when it first saw an account, that account's
/// code hash at the time, and how often each agent has dealt with it.
///
/// File-backed by default and injectable, so tests use a plain object.
export function createFileLedger(path) {
  let cache = null
  const load = async () => {
    if (cache) return cache
    try { cache = JSON.parse(await readFile(path, 'utf8')) }
    catch { cache = { accounts: {}, interactions: {} } }
    return cache
  }
  const save = async () => {
    await mkdir(new URL('./', path), { recursive: true }).catch(() => {})
    await writeFile(path, JSON.stringify(cache, null, 2) + '\n')
  }
  return {
    async account(id) { return (await load()).accounts[id] ?? null },
    async noteAccount(id, { blockHeight, codeHash }) {
      const db = await load()
      // First sighting is written once and never overwritten — that is the
      // whole value of it. Later code-hash changes are recorded separately.
      db.accounts[id] ??= { firstSeenBlockHeight: blockHeight, firstCodeHash: codeHash }
      db.accounts[id].lastCodeHash = codeHash
      await save()
    },
    async interactions(agent, counterparty) {
      return (await load()).interactions[`${agent}|${counterparty}`] ?? null
    },
    async noteInteraction(agent, counterparty, { blockHeight }) {
      const db = await load()
      const key = `${agent}|${counterparty}`
      const at = db.interactions[key] ?? { count: 0, firstBlockHeight: blockHeight }
      at.count += 1
      at.lastBlockHeight = blockHeight
      db.interactions[key] = at
      await save()
    },
  }
}

/// An in-memory ledger, for tests and for a stateless deployment.
export function createMemoryLedger(seed = {}) {
  const accounts = { ...(seed.accounts ?? {}) }
  const interactions = { ...(seed.interactions ?? {}) }
  return {
    async account(id) { return accounts[id] ?? null },
    async noteAccount(id, { blockHeight, codeHash }) {
      accounts[id] ??= { firstSeenBlockHeight: blockHeight, firstCodeHash: codeHash }
      accounts[id].lastCodeHash = codeHash
    },
    async interactions(agent, counterparty) { return interactions[`${agent}|${counterparty}`] ?? null },
    async noteInteraction(agent, counterparty, { blockHeight }) {
      const key = `${agent}|${counterparty}`
      const at = interactions[key] ?? { count: 0, firstBlockHeight: blockHeight }
      at.count += 1
      at.lastBlockHeight = blockHeight
      interactions[key] = at
    },
  }
}

// ------------------------------------------------------------------ service

/// Gathers the signals and scores them.
///
/// `provider` is a near-api-js JsonRpcProvider. `guardContract` is the shared
/// blocklist. `denylist` is this deployment's own explicit list, which beats
/// everything — an operator who knows an account is bad should not have to wait
/// for three strangers to agree.
export function createCounterpartyService({ provider, guardContract, ledger, denylist = [] }) {
  const denied = new Set(denylist)

  async function gather(agentId, accountId) {
    const signals = { accountId, agentId, denylisted: denied.has(accountId) }

    // Signal 2: is it a contract, and has its code changed?
    try {
      const account = await provider.query({
        request_type: 'view_account', finality: 'final', account_id: accountId,
      })
      signals.exists = true
      signals.codeHash = account.code_hash
      signals.isContract = account.code_hash !== NO_CONTRACT
      signals.storageUsage = Number(account.storage_usage)
      signals.blockHeight = Number(account.block_height)
    } catch {
      // A non-existent account is a signal, not an error.
      signals.exists = false
      signals.isContract = false
    }

    // Signal 1 (proxy): how used does it look, and have we seen it before?
    const remembered = await ledger.account(accountId)
    signals.firstSeenBlockHeight = remembered?.firstSeenBlockHeight ?? null
    signals.codeChangedSinceFirstSeen =
      remembered && signals.codeHash ? remembered.firstCodeHash !== signals.codeHash : null

    // Signal 3: have this agent and this account dealt before?
    signals.priorInteractions = await ledger.interactions(agentId, accountId)

    // Signal 4: what have other agents said, on chain?
    try {
      const summary = await provider.callFunction({
        contractId: guardContract, method: 'summary', args: { account_id: accountId },
      })
      signals.guard = normaliseGuard(summary)
    } catch {
      // If the guard cannot be read we must not silently treat that as "clean".
      signals.guard = { distinctReporters: 0, atOrOverThreshold: false, threshold: 0, reasons: [], unavailable: true }
    }

    if (signals.exists) {
      await ledger.noteAccount(accountId, { blockHeight: signals.blockHeight, codeHash: signals.codeHash })
    }
    return signals
  }

  return Object.freeze({
    /// Ask about a counterparty. Returns `{verdict, reasons, signals}`.
    async check(agentId, accountId) {
      return score(await gather(agentId, accountId))
    },
    /// Record a settled interaction, so trust can accumulate.
    async recordSuccess(agentId, accountId, blockHeight) {
      await ledger.noteInteraction(agentId, accountId, { blockHeight })
    },
    score,
  })
}
