// The counterparty verdict. Offline — `score()` does no I/O by design, so the
// policy that actually decides whether an agent pays someone is testable
// without a chain.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW, BLOCK, WARN, createMemoryLedger, score } from '../../backend/near/counterparty.mjs'

const CLEAN_GUARD = { distinctReporters: 0, atOrOverThreshold: false, threshold: 3, reasons: [] }

/// A well-used, long-known, well-dealt-with plain account.
function trusted(over = {}) {
  return {
    accountId: 'merchant.nearcraftmc.testnet',
    agentId: 'worker-1.nearcraftmc.testnet',
    exists: true, isContract: false, codeHash: '1'.repeat(32),
    storageUsage: 4_200, blockHeight: 1_000,
    firstSeenBlockHeight: 10, codeChangedSinceFirstSeen: false,
    priorInteractions: { count: 9, firstBlockHeight: 10, lastBlockHeight: 900 },
    guard: CLEAN_GUARD, denylisted: false,
    ...over,
  }
}

test('a known, well-used counterparty with history is allowed', () => {
  const r = score(trusted())
  assert.equal(r.verdict, ALLOW)
  assert.match(r.reasons[0], /9 prior successful interactions/)
})

// The single most important property. A permissionless list is sybil-reportable,
// so three colluding accounts must not be able to cut someone off.
test('reports alone can never reach block, however many there are', () => {
  for (const distinctReporters of [3, 10, 500]) {
    const r = score(trusted({
      guard: { distinctReporters, atOrOverThreshold: true, threshold: 3, reasons: ['scam'] },
    }))
    assert.equal(r.verdict, WARN, `${distinctReporters} reporters must warn, not block`)
    assert.ok(
      r.reasons.some((x) => /no independent signal corroborates/.test(x)),
      'the verdict must say why it stopped short of blocking',
    )
  }
})

test('reports plus an independent adverse signal do block', () => {
  const r = score(trusted({
    guard: { distinctReporters: 3, atOrOverThreshold: true, threshold: 3, reasons: ['drained an agent'] },
    codeChangedSinceFirstSeen: true,
  }))
  assert.equal(r.verdict, BLOCK)
  assert.match(r.reasons.join(' '), /3 distinct accounts reported/)
  assert.match(r.reasons.join(' '), /code changed/)
})

test('an explicit local denylist entry blocks on its own', () => {
  // Operator judgment should not have to wait for three strangers to agree.
  const r = score(trusted({ denylisted: true }))
  assert.equal(r.verdict, BLOCK)
  assert.match(r.reasons[0], /explicit denylist/)
})

// The other property that matters: optimism about strangers is worse than
// having no safety service at all.
test('an unknown counterparty warns and is never allowed', () => {
  const r = score({
    accountId: 'stranger.testnet', exists: true, isContract: false,
    storageUsage: 4_200, firstSeenBlockHeight: null,
    codeChangedSinceFirstSeen: null, priorInteractions: null, guard: CLEAN_GUARD,
  })
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /no prior interaction/.test(x)))
})

test('a barely-used account warns, with its storage named', () => {
  const r = score(trusted({ storageUsage: 264, priorInteractions: null }))
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /barely-used account \(264 bytes/.test(x)))
})

test('an account that does not exist warns rather than erroring', () => {
  const r = score({ accountId: 'ghost.testnet', exists: false, isContract: false, guard: CLEAN_GUARD })
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /does not exist/.test(x)))
})

test('a redeployed contract warns even with a clean record', () => {
  // A redeploy under a familiar name is the classic rug, so it must not pass
  // just because the account has history.
  const r = score(trusted({ isContract: true, codeChangedSinceFirstSeen: true }))
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /code changed since this service first saw it/.test(x)))
})

test('a never-before-seen contract warns', () => {
  const r = score(trusted({ isContract: true, firstSeenBlockHeight: null }))
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /contract this service has never seen/.test(x)))
})

test('thin history warns and says how much more is needed', () => {
  const r = score(trusted({ priorInteractions: { count: 1, lastBlockHeight: 5 } }))
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /only 1 prior interaction/.test(x)))
})

test('sub-threshold reports are surfaced, not hidden', () => {
  const r = score(trusted({
    guard: { distinctReporters: 1, atOrOverThreshold: false, threshold: 3, reasons: ['suspicious'] },
  }))
  assert.equal(r.verdict, WARN)
  assert.ok(r.reasons.some((x) => /1 account\(s\) reported this one, below the threshold/.test(x)))
})

test('every verdict carries reasons and is frozen', () => {
  for (const s of [trusted(), trusted({ denylisted: true }), { exists: false, guard: CLEAN_GUARD }]) {
    const r = score(s)
    assert.ok(r.reasons.length > 0, 'a verdict with no reason is useless to a human reviewer')
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.reasons))
  }
})

test('missing or malformed signals warn rather than throwing', () => {
  // A safety check that crashes on odd input fails open, which is the worst
  // possible behaviour for this component.
  for (const s of [undefined, null, {}, { guard: null }, { priorInteractions: undefined }]) {
    const r = score(s)
    assert.equal(r.verdict, WARN, `${JSON.stringify(s)} should warn`)
  }
})

test('an unreadable guard contract does not read as clean', () => {
  // gather() sets unavailable:true when the view fails. It must not be treated
  // as an absence of reports.
  const r = score(trusted({
    guard: { distinctReporters: 0, atOrOverThreshold: false, threshold: 0, reasons: [], unavailable: true },
    priorInteractions: null,
  }))
  assert.equal(r.verdict, WARN)
})

// ------------------------------------------------------------------- ledger

test('a first sighting is recorded once and never overwritten', async () => {
  const ledger = createMemoryLedger()
  await ledger.noteAccount('a.testnet', { blockHeight: 100, codeHash: 'hash-one' })
  await ledger.noteAccount('a.testnet', { blockHeight: 900, codeHash: 'hash-two' })

  const got = await ledger.account('a.testnet')
  assert.equal(got.firstSeenBlockHeight, 100, 'the first sighting is the whole value of it')
  assert.equal(got.firstCodeHash, 'hash-one')
  assert.equal(got.lastCodeHash, 'hash-two', 'but the latest code hash is tracked too')
})

test('interactions accumulate per agent and counterparty pair', async () => {
  const ledger = createMemoryLedger()
  await ledger.noteInteraction('worker-1.testnet', 'shop.testnet', { blockHeight: 10 })
  await ledger.noteInteraction('worker-1.testnet', 'shop.testnet', { blockHeight: 20 })
  await ledger.noteInteraction('worker-2.testnet', 'shop.testnet', { blockHeight: 30 })

  const one = await ledger.interactions('worker-1.testnet', 'shop.testnet')
  assert.equal(one.count, 2)
  assert.equal(one.firstBlockHeight, 10)
  assert.equal(one.lastBlockHeight, 20)
  // Trust is not transferable between agents.
  assert.equal((await ledger.interactions('worker-2.testnet', 'shop.testnet')).count, 1)
  assert.equal(await ledger.interactions('worker-3.testnet', 'shop.testnet'), null)
})

test('trust accrues: three interactions turn a warn into an allow', async () => {
  const ledger = createMemoryLedger()
  const agent = 'worker-1.testnet', shop = 'shop.testnet'
  const signals = () => trusted({ accountId: shop, agentId: agent })

  for (let i = 0; i < 2; i++) await ledger.noteInteraction(agent, shop, { blockHeight: 10 + i })
  let r = score({ ...signals(), priorInteractions: await ledger.interactions(agent, shop) })
  assert.equal(r.verdict, WARN, 'two is not yet enough')

  await ledger.noteInteraction(agent, shop, { blockHeight: 12 })
  r = score({ ...signals(), priorInteractions: await ledger.interactions(agent, shop) })
  assert.equal(r.verdict, ALLOW, 'the third crosses the line')
})
