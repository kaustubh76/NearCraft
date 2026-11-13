// Did a NEAR transaction actually do what it was asked to?
//
// This module exists because that question has TWO answers and only one of them
// is obvious, and because this repository answered it correctly in one place and
// incorrectly in another for as long as both existed.
//
// ## The two layers
//
// A transaction can succeed — well formed, signed, paid for, included in a block
// — while the function call inside it panics. nearcore reports that panic as a
// Failure on a RECEIPT, not on the transaction. near-api-js v7 throws only on
// the top-level status (`Account.signAndSendTransaction`, `throwOnFailure`), so
// `callFunctionRaw` returns normally and a caller that checks for a thrown error
// gets a transaction hash for a call that did nothing.
//
// It is worse than that for a contract that handles its own failures. When
// `market.buy_with_credit` cannot deliver, `on_items_delivered` *absorbs* the
// failure: it unwinds the stock, treasury and credit, logs, and returns `false`.
// So the failed `mt_transfer` receipt carries `status.Failure` while the callback
// receipt succeeds — and the FINAL status is `SuccessValue`. The transaction did
// succeed. The purchase did not happen.
//
// ## Found live, twice
//
// First on the relayed path: a player's `sell` panicked on a malformed
// approval_id and the play service answered 200 with a transaction hash. The
// player would have seen "sold" and still been holding the iron. That was fixed
// where it was found, in `relayer.mjs`, and nowhere else.
//
// Then on the agent path, by audit: `signer.mjs` called `callFunctionRaw` and
// returned the outcome unexamined, so a rolled-back purchase was logged as
// `settled`, `scripts/agent-run.mjs` asserted on that as proof the run worked,
// and `counterparty.recordSuccess` incremented the very counter that governs
// `INTERACTIONS_FOR_TRUST`. **A failed trade bought trust.**
//
// One implementation, imported by both, so the next signing path cannot get it
// wrong by being written somewhere else.

/// Raised when the transaction landed but the call inside it did not.
export class InnerCallFailed extends Error {
  constructor(detail, outcome = null) {
    super(`the transaction succeeded but the call inside it failed: ${detail}`)
    this.name = 'InnerCallFailed'
    this.code = 'INNER_CALL_FAILED'
    this.detail = detail
    /// Kept, so a caller can still point at the receipt. The first version of
    /// this discarded the outcome and a failed call lost its explorer link.
    this.outcome = outcome
  }
}

/// The transaction hash out of a raw outcome, whichever shape the RPC used.
export function transactionHash(outcome) {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null
}

/// The first receipt-level failure in an outcome, or null if every receipt
/// succeeded.
///
/// Returns the contract's own panic text where nearcore provides it, so the
/// message a caller sees is the one the contract wrote rather than a generic
/// one. Falls back to the whole failure object stringified, because a shape
/// this does not recognise must still be reported rather than swallowed — the
/// cost of a missing branch here is silence about a failure.
export function innerFailure(outcome) {
  for (const receipt of outcome?.receipts_outcome ?? []) {
    const failure = receipt?.outcome?.status?.Failure
    if (failure) {
      const panic = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError
      return panic ?? JSON.stringify(failure)
    }
  }
  return null
}

/// Pass the outcome through, or throw if any receipt failed.
///
/// Note what this deliberately treats as a failure: a cross-contract call that
/// the contract itself rolled back. The rollback is correct behaviour and the
/// caller was made whole, but the thing they asked for did not happen, so
/// reporting success would be a lie — a refunded purchase is still not a
/// purchase. `contracts/integration/tests/economy.rs` asserts that same case
/// from the contract's side.
export function assertInnerSuccess(outcome) {
  const failure = innerFailure(outcome)
  if (failure) throw new InnerCallFailed(failure, outcome)
  return outcome
}
