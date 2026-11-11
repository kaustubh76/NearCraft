# Working on NearCraft

Instructions for anyone — person or coding agent — reading or changing this
repository. The NEAR HACKATHON jury includes Claude Code and Codex, so this file
is written for a machine reader as much as a human one.

## What this is

An agent-run market economy settled on NEAR. Merchants are AI agents with their
own named accounts, their own stock and their own money; prices come from stock
and recent demand; AI worker agents shop with wallets bounded by NEAR's own
access-key primitives. Tracks entered: **`games`** and **`security`**.

## Run every check

Needs Rust and Node 22+. Nothing here needs a NEAR account, a faucet, an API
key or a Minecraft server.

```sh
npm install
npm test                     # 158 offline checks, ~2s
```

That is 90 Rust unit tests (`contracts/`), 68 Node tests (`tests/near/`) and the
11 baseline hash checks. Then, after building the wasm:

```sh
rustup target add wasm32-unknown-unknown
cargo install cargo-near          # compiles from source, a few minutes
npm run build:contracts
npm run check:nep245              # conformance, read off the compiled ABI
npm run test:sandbox              # smoke + access keys + cross-contract economy
npm run test:gasless              # a key-less player buys and sells for free
npm run agent                     # ← the one to watch: an agent shopping, blocked, approved
npm run sim                        # 20 buyers, 5 merchants, scripted, no model calls
npm run evidence                   # re-record every check's real output
```

`npm run agent` is the single best summary of what this project does.

## Layout

```
contracts/items    NEP-245 multi-token: every material is one token id
contracts/market   merchants, pricing, treasuries, buy/sell settlement
contracts/guard    a public blocklist agents report to, with evidence
contracts/integration  sandbox tests against a real nearcore node
backend/baseline   VENDORED UNCHANGED from EthCraft — see BASELINE.md
backend/near       the NEAR layer: policy, signer, counterparty, onboarding, relayer, market
scripts            deploy, reads, keys, conformance, evidence, the agent run
tests/near         offline tests for the NEAR layer
docs               GASLESS.md, SECURITY_SIGNALS.md, PROVENANCE.md
evidence           retained output of every check, failures included
```

## Baseline versus work done in the hackathon window

**`backend/baseline/**` is vendored, byte-identical, and must not be edited.**
`npm run verify:baseline` recomputes all 11 SHA-256 hashes and fails on drift.
Editing one of those files breaks the eligibility disclosure in `BASELINE.md`,
which is the point of having it. If baseline code needs to change, copy it into
`backend/near/` and say so.

Everything else is work done in the window and is what the hackathon judges.

## The claims policy

This is the part that matters most, and it is inherited deliberately from the
baseline project, where it was the thing that made the evidence worth reading.

- **Distinguish measured from asserted.** "The relayer pays" is a claim about
  money; it is asserted as `assert.equal(after - before, 0n)` against a real
  node, not described in prose. If something is not measured, say that.
- **Never upgrade a disclosed gap.** OAuth token verification is stubbed. The
  Minecraft settlement path is not ported. `games` requirement 4 is not "a week
  in a minute". These are stated in `README.md` and must stay stated.
- **Keep failures.** `evidence/runs/` records a failing check exactly like a
  passing one. A check that cannot run is recorded as `skipped` with a reason —
  skipped and failed are different facts and conflating them misleads twice.
- **Do not enter a track whose requirements are unmet.** `swarms` was planned
  and dropped because its sealed-bid coordinator was never built. `RULES.md`
  stays as the design it is.
- **Do not break a standard to pass a requirement.** We declined to add a
  non-payable transfer to the items contract, which would have made gasless
  selling trivial and removed exactly the safety property NEP-245's
  1-yoctoNEAR rule exists to provide. The approval route was more work and is
  correct.
- **Say what a number means.** Where a spec is ambiguous, record the reading
  chosen and why — see the two NEP-245 ambiguities documented at the top of
  `contracts/items/src/lib.rs`.

## Things that will bite you

- **A function-call access key cannot attach NEAR.** This shapes everything.
  Agents and players spend from a credit balance inside the market contract
  rather than attaching a deposit, and `check:nep245` asserts `buy_with_credit`
  and `sell` stay non-payable. Make one payable and every agent silently stops
  working.
- **An empty `method_names` means *any method on that contract*.** near-api-js
  defaults it to `[]`. Always pass it explicitly. `npm run keys` exits non-zero
  if it ever finds an unrestricted key.
- **The key allowance is a per-call ceiling against *prepaid* gas**, drawn down
  by gas actually burned. `max_gas()` demands ~1 NEAR of headroom and kills a
  modest allowance immediately. Agent calls use 60 TGas.
- **NEAR contracts answer in snake_case.** A unit test with a camelCase fake
  will pass while the real integration silently reads zeros — that exact bug
  made on-chain blocklist reports invisible until `npm run agent` caught it.
  `normaliseGuard` now owns the wire shape, and a regression test uses the
  contract's real field names.
- **`near-api-js` v7 removed `connect()`, `keyStores`, `account.functionCall()`
  and `addKey`.** Views take `method`; change calls take `methodName`.
  `createSignedMetaTransaction` resolves to `{delegateHash, signedDelegate}`
  while `relayMetaTransaction` wants the bare `signedDelegate`.
- **`cargo test` at the workspace root pulls in the 110-second simulation.**
  `npm run test:contracts` names the three contract crates and `--lib`
  deliberately, so the fast path stays fast.
- **`rpc.testnet.near.org` is deprecated** and answers HTTP 429 with "STOP
  USING IT NOW". It killed a live deployment part-way through. Use
  `https://test.rpc.fastnear.com`, which is the default here, or set `NEAR_RPC`.
- **`fast_forward` produces blocks rather than jumping.** A week is 604,800 of
  them, which is why no claim about block time is made.

## Changing a contract

Rebuild the wasm before running any sandbox test — they load the compiled
artifact, so a stale build will test the old contract and pass misleadingly:

```sh
npm run build:contracts && npm run test:sandbox && npm run check:nep245
```

Then re-record evidence with `npm run evidence`, since the retained output
refers to a specific build.
