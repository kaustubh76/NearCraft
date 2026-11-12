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
npm test                     # 234 offline checks, ~6s
```

That is 116 Rust unit tests (`contracts/`), 107 Node tests (`tests/near/`) and the
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

Against the live deployment on public testnet (no credentials needed for the
reads):

```sh
npm run reads                # every merchant's ask, bid, band and reason, from the chain
npm run keys                 # each agent key's receiver, methods and allowance
npm run web                  # the market page, reading those contracts live in a browser
npm run live:agent           # ← SPENDS real testnet balance. Needs .local/ keys.
npm run live:player          # ← SPENDS real testnet balance. The gasless proof, on chain.
```

`npm run live:agent` and `npm run live:player` are the only commands here that send transactions. It is
kept out of `npm run evidence` for that reason; its retained records live in
`evidence/live/`, each naming a transaction hash anyone can open on an explorer.

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
- **Never upgrade a disclosed gap.** OAuth verification used to be the example
  here; it is now implemented in `backend/near/oidc.mjs`, so the statements about
  it were changed in the same commit that built it — which is the rule working,
  not an exception to it. What remains disclosed: no provider client id is
  configured, so no real token has been verified. The
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
- **A check that cannot fail is not a check.** This repo shipped four of them.
  `npm run keys` audited `manifest.agents ?? []` and the manifest said `[]`, so
  it examined zero accounts and printed "all agent keys are correctly scoped".
  `scripts/agent-run.mjs` — the demo the README calls the best summary of this
  project — had **no assertions at all** for its whole life, while its retained
  evidence claimed a prompt injection was BLOCKED; that exact claim was already
  false once, when the snake_case bug let the injection through and a human
  reading the output caught it. `npm run reads` had one failure path, a missing
  manifest. `npm run verify:baseline` passed on an empty manifest and could
  never see a file added to `backend/baseline/`.
  **Make every check fail once before believing it**, and prefer asserting the
  sentence the evidence record claims, so the two cannot drift. Two of my own
  negative tests were themselves vacuous — a `grep | head -1` that always
  reported a leak, and a patch that edited a string which did not appear in the
  file. Check that the thing you broke actually broke.
- **`max_gas()` silently caps throughput to three transactions a block.**
  Prepaid gas is what reserves room in a chunk, and nearcore's per-chunk limit
  is 1000 TGas — so 300 TGas per call lets only three share a chunk however many
  callers are ready. The simulation prepays measured ceilings instead (100 TGas
  for a buy, 150 for a sale) and got 4.7× the throughput.
- **Concurrency makes every quote stale, and the contract is right to refuse.**
  Run twenty buyers at once and they all read the same price; the first to clear
  moves it, so a deposit sized exactly to the quote fails `require!(paid >=
  total)`. Buyers need a slippage tolerance. The first parallel run lost 86
  trades to this and said nothing, because the failure was swallowed by
  `if outcome.is_success()`. Count refusals.
- **Never serve the repository root.** `.local/` is inside it and holds the
  deploying account's private key, so a static server confined to the root will
  still hand that key to anything that can reach the port. `scripts/serve-web.mjs`
  serves an allowlist — `web/`, `backend/`, `deployment.json` — and a test
  asserts the key files are unreachable.
- **There is no root `Cargo.toml`.** The workspace is `contracts/Cargo.toml`, so
  every cargo invocation needs `--manifest-path`. `npm run sim` and
  `npm run test:sandbox` were both broken for exactly this reason while
  `npm run evidence` worked, because that script sets `cwd: 'contracts'` instead.
  Two commands the README tells a judge to run, failing on line one.
- **An agent has three separate pots and conflating them wastes an afternoon.**
  (1) its *spend budget*, credited inside the market contract; (2) its *key
  allowance*, capping gas the key may authorise; (3) its *account balance*,
  which must actually cover each call's prepaid gas. A live agent with ample
  budget and allowance still failed to send, because 0.05 NEAR of account
  balance could not prepay a 60 TGas call (~0.061 NEAR).
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
