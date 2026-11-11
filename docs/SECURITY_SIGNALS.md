# Counterparty signals, and where each one actually comes from

The AI Security & Defense prompt asks, before any code: *list the data sources
you'd use for each signal and how you'd get them.* This is that list, written
first and kept as the record of what was decided. Each row says what the signal
genuinely shows **and what it cannot tell us**, because the second half is what
makes the first half safe to act on.

Implemented in [`backend/near/counterparty.mjs`](../backend/near/counterparty.mjs)
and [`contracts/guard/`](../contracts/guard/).

## One design constraint, chosen deliberately

**No API key and no indexer dependency.** The service uses only public NEAR RPC
plus its own records. A safety service that needs a credential to answer is much
less useful to an agent — and it would break this repo's property that every
check runs from a fresh clone with nothing configured.

That choice has a cost, stated plainly below: **true account age is not
obtainable this way**, so signal 1 is a proxy and is labelled as one rather than
dressed up as age.

Verified by probing rather than assumed: `view_account` returns `amount`,
`code_hash`, `locked`, `storage_usage`, `storage_paid_at` and `block_height` —
and no creation time. FastNEAR's `/v1/account/{id}/full` answers 200 but carries
no age or transaction history either.

## The four signals

### 1. Account age and activity history

**Source.** `view_account` → `storage_usage` and `amount`;
`view_access_key_list` → how many keys and of what kind. Plus this service's own
**first-seen ledger**: the block height at which it first observed the account.

**Shows.** A 264-byte account holding one key with no history is a fresh
throwaway. A large `storage_usage` with several keys is an account that has been
used for something.

**Cannot tell us.** *Age.* NEAR does not expose account creation time through
any view we are willing to depend on. This is a **proxy**, and the verdict names
it as "barely-used account (264 bytes of storage)" rather than claiming an age
it does not know. The first-seen ledger only becomes informative with runtime: a
service started yesterday has seen nobody.

### 2. Is the receiver a contract, and did its code change?

**Source.** `view_account` → `code_hash`. The sentinel
`11111111111111111111111111111111` means no contract is deployed. The hash is
cached per account on first sighting and compared on every later check.

**Shows.** Whether you are paying a plain account or calling code — and whether
that code changed since we last looked. A redeploy under an already-trusted name
is the classic rug, and this is the signal that catches it.

**Cannot tell us.** Only changes **since our first observation** are visible. A
contract that was hostile from the very first block looks perfectly stable.

### 3. Prior interactions between this agent and this receiver

**Source.** This service's own ledger, keyed `(agent, counterparty)`: count,
first and last block height.

**Shows.** The strongest *positive* signal available without an indexer. "This
agent has paid this account nine times and nothing went wrong" is worth more
than any heuristic about strangers.

**Cannot tell us.** Anything about other deployments. Trust is per-agent and
non-transferable on purpose — one agent's good experience is not another's
evidence. A fresh install knows nobody, and in that state the service must
answer `warn`, never `allow`.

### 4. A shared blocklist other agents can report to, with evidence

**Source.** **On-chain**, not in our database:
[`contracts/guard/`](../contracts/guard/src/lib.rs). `report(account_id, reason,
evidence)`, `reports_for`, `reporter_count`, `blocked`, `summary`.

Why a contract rather than a table — three properties a database cannot give:
reports are **public**, they are **attributed** by the runtime via
`predecessor_account_id` rather than by a self-declared field, and **we cannot
delete them**. A safety list the operator can quietly edit is not a safety list.

Reporting costs 0.01 NEAR. That is not revenue; it pays for the storage the
report occupies and makes mass false reporting cost something. A reporter who
reports the same subject twice **replaces** their earlier report, so one account
cannot inflate the distinct-reporter count. A reporter can retract their own
report and nobody else's.

**Cannot tell us.** Whether a report is true. **Anyone can report anyone** — the
list is permissionless and therefore sybil-reportable. This is handled, not
hidden: the scoring layer **never blocks on reports alone**. Reports can reach
`warn`; `block` additionally requires an independent adverse signal from rows
1–3. Three colluding accounts cannot cut anyone off.

## Turning signals into a verdict

`score()` in `counterparty.mjs` is pure — no I/O — so the policy that decides
whether an agent pays someone is unit-testable offline. Rules, in order:

1. An explicit **local denylist** entry blocks. An operator who knows an account
   is bad should not have to wait for three strangers to agree.
2. On-chain reports at or over the guard's threshold block **only when
   corroborated** by a signal from rows 1–3.
3. Anything adverse or unknown → `warn`.
4. `allow` requires three or more prior successful interactions and nothing
   adverse. **An unknown counterparty gets `warn`, never `allow`** — a safety
   service that is optimistic about strangers is worse than having none.

Every verdict carries its reasons, because a `warn` with no explanation gives a
human nothing to decide on. Malformed or missing signals produce `warn` rather
than an exception: a check that crashes fails open, which is the worst possible
behaviour for this component.

## What the agent does with it

[`backend/near/signer.mjs`](../backend/near/signer.mjs) consults the check
before signing anything:

- **`block`** → refuses, with the reasons. Nothing is signed.
- **`warn`** → the call is **parked for a human** and `HumanApprovalRequired` is
  raised — a distinct type from `PolicyRefusal`, so a caller cannot confuse
  "refused" with "waiting for a person". `pendingDecisions()`, `approve(id)`,
  `reject(id)`.
- **`allow`** → proceeds.

`approve()` **re-checks** the counterparty. An approval given a minute ago is not
a licence to pay an account that has since been blocked, and a human cannot
override a `block`.

An unrecognised verdict is refused rather than read as permission.

## Where this sits among the other bounds

This layer is the *best-informed* bound on an agent, and the *weakest*, because
it is the only one that is our code. Two others hold underneath it:

- The **function-call access key** — `method_names` enforced by the NEAR
  runtime. Even if every line above were wrong, the key cannot transfer NEAR,
  cannot add keys, and cannot name a method outside its list. Demonstrated in
  `contracts/integration/tests/keys.rs`.
- The **spend budget** in the market contract. A fully compromised agent can at
  worst buy permitted goods until its budget runs out.

Order matters: the policy layer refuses out-of-policy calls *before* the
counterparty is consulted, so a call that was never going to be allowed does not
cost a network round trip.
