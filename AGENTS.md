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
key or a Minecraft server. The Minecraft plugin is the one exception and it is
kept out of `npm test` on purpose: `npm run mc:test` needs a JDK, so a clone
without one records that check as *skipped* rather than failing.

```sh
npm install
npm test                     # every offline check, ~6s — it PRINTS the count, so
                             # do not copy one into a doc; eight were stale at once
```

That is the Rust unit tests (`contracts/`), the Node tests (`tests/near/`) and the
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

And the Minecraft side, which needs a JDK rather than the wasm:

```sh
brew install openjdk@25           # Paper 26.3 refuses anything older
npm run mc:test                   # the plugin's Java checks, offline, ~2s
npm run mc:up                     # ← one command: brings it all up and proves it
npm run mc:up -- --sandbox        # the same, on a local node, no balance ceiling
npm run mc:up -- --keep           # leave the server joinable
```

`mc:up` is the one to reach for. It pre-flights what is knowable in seconds,
starts the issuer and the play service itself, boots Paper, proves the loop and
stops only what it started — a service you were already using survives it. The
three scripts it spawns (`oidc-dev`, `serve-play`, `mc-bot`/`mc-server`) all
still work on their own; `mc:up` exists because running them in the right order
by hand was where every failure came from once the code was right.

`npm run topup` refills the player's spend budget. `market.fund_credit` is
permissionless — it has no `assert_owner()` — so any funded account can do it,
which is why this needs neither the root account nor a faucet.

`npm run agent` is the single best summary of what this project does, and
`npm run mc:server -- --token player-1 --trade` is the one that looks like a
game: a Paper server boots, the plugin loads, and a sale settles on testnet
while the player's balance moves by zero. It downloads a 55 MiB server jar and
spends live balance, so it is not part of any suite.

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
  not an exception to it. What remains disclosed: a provider client id IS now
  configured and the verifier runs on the runtime path against a live JWKS over
  HTTP, but no token GOOGLE issued has been through it — that needs a browser,
  and `npm run oidc:verify -- "<token>"` is the one command that would settle
  it. The
  Minecraft settlement path now exists as NEW code in `minecraft/`, has settled
  real trades on testnet, and has been played by a **headless client** whose
  real `PlayerInventory` received the iron — but EthCraft's plugin is still
  **not** ported, **no human** has played it (the player is a bot, and the bot
  fixture runs `online-mode=false` because a headless client has no Mojang
  account), and the plugin's inventory moves are not atomic with the chain. `games` requirement 4 is not "a
  week in a minute". These are stated in `README.md` and `docs/MINECRAFT.md` and
  must stay stated.
- **A wait that does not wait is a check that cannot fail.** `mc-up`'s poller
  tested `test()` for truthiness, and an async predicate returns a Promise,
  which is always truthy — so every wait returned on its first tick. The live
  run passed anyway because the service happened to be quick; the sandbox run
  crashed reading a field off the null that came back. Await the predicate.
- **Put the code in the branch you meant.** `--serve` was inserted at the end of
  the `catch` block instead of the `try`, so the server stayed up only when
  something had gone wrong, and stopped on a clean run. It read correctly and
  did the opposite of what it said.
- **Derive the network, never assert it.** Every manifest `deploy.mjs` wrote
  said `network: 'testnet'`, including the ones written against a local
  sandbox — and that label travelled, so a sandbox transaction was retained in
  `evidence/live/` as though an explorer could confirm it. It is a fact about
  the RPC URL and is now read off the RPC URL, and `mc-bot` refuses to write
  into `evidence/live/` for anything that is not a public chain.
- **A config fallback changes behaviour you did not ask it to change.** Adding
  `.local/oidc.json` as a fallback silently put every run into real-OIDC mode,
  so `mc:up --sandbox` refused its own seeded player as a malformed token. Any
  orchestrator must be able to state the mode it means — `NEARCRAFT_LOGIN`.
- **An unspecified behaviour is not a bug until you check.** `Items.take` moved
  blocks by mutating the array `Inventory.getContents()` returns, which the
  Bukkit API guarantees nothing about. Rewriting it on `removeItemAnySlot` was
  right — but the old version was then run against a real server and **passed
  all twelve checks**, because CraftBukkit happens to return live mirrors. The
  claim "it was probably broken" was wrong and the commit does not make it. What
  was true is narrower: it relied on behaviour the contract does not promise.
  Say the narrower thing.
- **Compare deltas, not totals, when two ledgers started out of step.** The
  game-versus-chain check first compared the player's NEAR holdings to the
  blocks in the bot's inventory and failed with "chain 1, carrying 0" —
  correctly, because the account already owned an ingot from earlier runs while
  a player entity in a fresh world starts empty. The assertion was wrong, not
  the system. What must agree is how much each one MOVED.
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
- **A check that cannot fail is not a check.** This repo shipped seven of them.
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

  Three more shapes, all found by breaking the check rather than reading it:

  - **A denominator taken from the implementation.** `check:nep245` reported
    "Approval Management 5/5" while the spec defines six, because its list of
    required methods was hand-written from the contract. The check could not
    see the method that was missing.
  - **A pattern that only matches the right answer.** The replacement check
    searched the README for "Approval Management N of 6" with the 6 written
    literally, so the stale row claiming five of five did not match it **at
    all** and the check passed. It now
    reads both numbers. If a check's regex encodes the expected value, it
    cannot report the unexpected one.
  - **A check placed where it cannot fire.** `verifyKeyScope` was wired into
    the human-approval path as well as the call path — but the call path had
    already run it and memoised the result, so the second one always read a
    resolved promise. It only became a real check when it re-read the chain,
    which is also the correct behaviour: a key's permission can widen in place
    while a call sits waiting on a person.
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
- **`npm run build:contracts` and `npm run build:reproducible` produce
  DIFFERENT BYTES from the same source, and that is correct.** The first uses
  your local rustc; the second builds the committed commit inside a
  digest-pinned container (rust 1.99.1). The contracts on testnet are the
  reproducible ones, so `npm run verify:deployed` is green after
  `build:reproducible` and goes red after `build:contracts` — which is not a
  bug and not a regression. If you see that red, you have not broken anything;
  you have compared the chain against a local build it was never built from.
  `build:contracts` stays the default because it needs no Docker, which is what
  keeps `npm test` working on a clean clone.
- **`reproducible-wasm` copies only the WASM out of the container, not the
  ABI** — the ABI path it prints is a path inside the container. So
  `npm run check:nep245` fails with "ABI not found" straight after a
  reproducible build, which looks like a broken conformance check and is not
  one. `npm run build:reproducible` therefore ends with `cargo near abi` for
  each contract: that generates no wasm, so it cannot overwrite the artifact
  whose hash the chain is being matched against. Do not reach for
  `build:contracts` to get the ABIs back — it would overwrite all three wasms
  and turn `verify:deployed` red.
- **A reproducible build builds the COMMITTED commit and ignores your working
  tree.** So commit and push before building, or you will ship bytes that do not
  match the source anyone else can fetch — and the mismatch is invisible,
  because the artifact is perfectly self-consistent.
- **A green `verify:deployed` used to be compatible with an edited contract.**
  It hashes the wasm in `contracts/target/`, so editing a contract and not
  rebuilding left all three printing MATCH — the A3 bug class living inside the
  script written to catch it. It now also compares each contract's build inputs
  at the commit the contract itself names against your working tree, and reports
  **SOURCE MOVED**, which is a different failure from DIFFERS: the bytes and the
  local wasm still agree, it is the *source* that has left them behind. The
  check skips `contracts/integration/`, which no contract build reads.
- **`finality: 'final'` lags, and it will make a working write look broken.**
  It has bitten twice. Once a redeploy script read the account at `final`
  immediately after deploying and reported no change on a transaction that had
  in fact succeeded. Then the play service sold an item and showed the player
  still holding it — `optimistic` reported the new balance at once while
  `final` was still reporting the old one three seconds later, measured on a
  real node. Anything a person reads right after acting should use
  `optimistic`; `backend/near/market.mjs` defaults to it and takes an override.
- **Banning a phrasing does not stop a number rotting; checking it does.** A
  rule forbids "N Rust unit tests" and "N offline checks", and the README's
  status table duly rotted as "74 unit tests" and "12 tests" — matching neither.
  The real counts were 95 and 18. `check:docs` now COUNTS them: `#[test]` per
  crate, and `#[tokio::test]` in the files `test:sandbox` names, with the file
  list read out of `package.json` so adding `--test foo` updates the expectation
  by itself. Both agree exactly with what the runners print. It also fails when
  the count is *removed*, because a check that quietly stops checking is the
  failure this repo keeps rediscovering.
- **`build_info` naming an older commit than `HEAD` is not drift.** The bytes
  are pinned to the commit that built them, so they should not track `HEAD`.
  Do not redeploy to make the two match; the question worth asking is whether
  the contract source has changed since, and `verify:deployed` answers it.
- **That ~0.061 NEAR is NOT `prepaid_gas × gas_price`, and the arithmetic will
  mislead you.** At the live gas price of 1e8 yocto/gas, 60 TGas multiplies out
  to 0.006 NEAR — ten times less than what nearcore actually demands. It
  reserves against a *pessimistically inflated* price, assuming the prepaid gas
  might be spent down a long chain of receipts with the price rising in each
  one, so the headroom grows faster than the gas you attach. Measured twice, at
  0.0609 NEAR both times: once when a live agent could not send, and once when
  `npm run deploy` could not afford an `#[init]` call it was going to make
  purely to watch it fail. **Attach the gas the call needs, not the gas you can
  imagine needing.**
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
