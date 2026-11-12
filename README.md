# NearCraft

**An agent-run market economy inside a Minecraft recreation of South Mumbai,
settled on NEAR.** Merchants are AI agents holding their own named NEAR
accounts, their own inventory and their own money. Their prices come from their
stock and from what players just sold them, so the market — not a quest script —
is what you play against. Players never see a wallet, a seed phrase or a gas
prompt.

Built for the **NEAR HACKATHON** (1–14 November 2026). Tracks entered:
`games` (primary), `security`, `swarms`.

---

## Status — 12 November 2026

This README describes what exists today, not what is planned. Read the status
column before the description.

| Component | Status |
|---|---|
| `GAME_LOOP.md` — the game loop on paper | **Done.** Required by the `games` prompt before any code. |
| `RULES.md` — round rules + sequence diagram | **Done.** Required by the `swarms` prompt before any code. |
| `BASELINE.md` + hash-verified baseline import | **Done, machine-checked.** `npm run verify:baseline` |
| `contracts/items` — NEP-245 materials | **Built and tested.** 29 unit tests. NEP-245 core 10/10 + Enumeration 2/2 + Approval Management 5/5, verified against the compiled ABI. Three spec ambiguities are decided and disclosed in the module header, including that `mt_is_approved` takes an explicit `owner_id` — the spec's signature names none, which a multi-token cannot answer. |
| `contracts/market` — merchants, pricing, treasury | **Built and tested.** 51 unit tests (including the pricing rule and the payout rollbacks). |
| `contracts/guard` — the shared blocklist, on-chain | **Built and tested.** 13 unit tests. Public, attributed by the runtime, not deletable by us. |
| `backend/near/counterparty.mjs` — allow/warn/block | **Built and tested.** 23 tests. Pure scoring, no API key, no indexer. |
| `backend/near` — signer, policy, warn→human approval | **Built and tested.** 59 tests across policy, counterparty, human approval, the plugin contract and the injection demo. |
| **Sandbox integration tests** | **Built and passing.** A real local NEAR node via `near-workspaces`. 12 tests: 4 prove a restricted key's limits *at the protocol level*, 6 cover the cross-contract buy/sell/rollback paths, 1 runs the economy, 1 proves the node starts. |
| **Deployed to NEAR testnet** | **Yes.** `items.nearcraftmc.testnet`, `market.nearcraftmc.testnet`, `guard.nearcraftmc.testnet` — 5 merchants, 2 agents, 1 player. `npm run reads` and `npm run keys` query it with no credentials. |
| The economy simulation | **Built and passing.** 20 buyers, 6 strategies, 5 merchants, 8 rounds, no model calls — **135 real transactions in 23.7s** on a real nearcore node, buyers running concurrently. `npm run sim` |
| `web/market.html` | **Built, and reads the live chain.** Every merchant's ask, bid, stock band and the contract's own reason string, read from the deployed contract over public RPC with no API key. Falls back to the retained simulation snapshot when offline, and says which it is showing. 8 tests. `npm run web` |
| **A real agent transaction on public testnet** | **Done.** [`CJXc3vK8Yom…`](https://testnet.nearblocks.io/txns/CJXc3vK8YomMVAZn6j6R6FHKqtSF9t4Ev4Tbcq4eqnhZ) — an agent signing with a `buy_with_credit`-scoped key, after being parked for human approval. `npm run live:agent`, retained in `evidence/live/`. |
| `npm run agent` — an agent shopping end to end | **Built and runnable.** An agent with a scoped key on a real node: an unknown merchant parked for a human, the same merchant clearing itself once trust accrued, and a prompt-injected objective **blocked** by the on-chain guard. |
| `AGENTS.md` | **Written.** Repo instructions and the claims policy, for the AI judges the organisers named. |
| `evidence/` | **Built.** `npm run evidence` retains each check's real output with its exit code and an output hash. Failures are kept, not edited out. |
| Social / email login | **Built and tested.** [`backend/near/oidc.mjs`](backend/near/oidc.mjs) — JWKS fetch, JWT signature verification, `iss`/`aud`/`exp`/`nbf`/`sub` checks. 25 offline tests including `alg: none`, the HMAC confusion attack, a swapped payload and a token minted for another application. **Not configured against a real provider**, so the demo onboards seeded identities. |
| Gasless play — no seed phrase, no popup, no gas prompt | **Built and measured on public testnet.** `npm run live:player`: a player holding **no full-access key at all** buys and sells on NEAR testnet and its balance moves by **exactly 0** — the relayer pays. Reproduced twice, hashes retained in `evidence/live/`. Also `npm run test:gasless` on a local node, plus 15 offline tests. [docs/GASLESS.md](docs/GASLESS.md) |
| Payout rollbacks | **Built and tested.** `withdraw` and `withdraw_treasury` used to zero the ledger and then fire a bare transfer with no callback: a failed payout debited the claimant and delivered nothing, and the market silently kept money it no longer accounted for. Both now roll back. 3 unit tests. |
| NEP-245 Approval Management | **Built and tested.** 10 unit tests. Implemented because without it a key-less player could buy but never sell. |
| Minecraft plugin settlement path | **Not built**, and not startable here — no Java runtime on this machine and the Paper jar lives on the operator host. The note below also corrects our own earlier estimate of the work. |
| Sealed-bid rounds (`swarms`) | **Not built, and that track is not entered.** See below. |

**Live on NEAR testnet.** The contracts below are deployed and queryable by
anyone, with no credentials:

```
items    items.nearcraftmc.testnet
market   market.nearcraftmc.testnet
guard    guard.nearcraftmc.testnet
```

```sh
npm run reads     # every merchant's ask, bid, stock band and the contract's own reason
npm run keys      # each agent key's receiver, method list and allowance, from the chain
npm run web       # the market page, reading those same contracts live in a browser
```

**And the headline claim, measured on the public chain.** A player bought 2 iron
and sold them back, holding one function-call key and no full-access key:

```
player   p-1d6a3c5d.nearcraftmc.testnet      1 scoped key, 0 full-access
balance  0.089437 NEAR  ->  0.089437 NEAR    moved by exactly 0
relayer  paid 0.001513 NEAR for both calls

buy   4EZNk7HbNb17pBneKRtZrV8XgzmS4jU95VgGriXBh5wQ
sell  q7hdf2y7jkBoZSoLNeMtSyoZMDMxb9rPKLuPHTDvYAz
```

`npm run live:player`, reproduced twice with the same result. The script checks
the no-full-access-key property against the protocol **first**, because if that
were false nothing else would matter. It does not report per-call gas: measured
either side of a single call, before nearcore credits the unused gas back, the
two figures summed to 0.076 NEAR on a run that actually cost 0.0015.

**And a real agent transaction to open.** An agent bought 2 iron from Ironmonger
on public testnet, signing with a key scoped to `buy_with_credit`:

```
CJXc3vK8YomMVAZn6j6R6FHKqtSF9t4Ev4Tbcq4eqnhZ
https://testnet.nearblocks.io/txns/CJXc3vK8YomMVAZn6j6R6FHKqtSF9t4Ev4Tbcq4eqnhZ
```

That run is reproducible with `npm run live:agent` and is retained in
`evidence/live/`. Before sending it, the same agent tried `withdraw` and the
protocol refused it with `MethodNameMismatch` — no transaction, no gas. The
counterparty check then returned **warn** for a merchant it had never dealt
with, parked the purchase for a human, and only signed once approved.

**One thing to know about the figures.** A testnet faucet account holds 10 NEAR
and the three contracts stake about 5.7 of it in storage, so the full-size
economy in `config/catalog.json` (77 NEAR of merchant treasuries) does not fit.
The deployment therefore runs at `NEAR_ECONOMY_SCALE=0.01`, recorded as
`economy_scale` in `deployment.json`. Scaling is **uniform**, so every ratio —
price to treasury to floor to budget — is preserved and the market behaves
identically; only the units shrink. The sandbox runs the full-size economy.

The web faucet was failing, and `helper.testnet.near.org` is 404. What worked is
`POST https://helper.nearprotocol.com/account`, the endpoint `near-cli-rs` uses
for `sponsor-by-faucet-service`.

Note also that **`rpc.testnet.near.org` is deprecated** and answers HTTP 429
telling you to stop using it — it killed a deploy part-way through. Everything
here defaults to `https://test.rpc.fastnear.com`.

**On the `swarms` track:** not entered. The sealed-bid coordinator described in
[RULES.md](RULES.md) is designed and not implemented, so its requirements are
unmet and selecting the track would be a false claim. `RULES.md` stays in the
repo as the design it is. Tracks entered: **`games`** and **`security`**.

**On `games` requirement 2 (social login, no seed phrase, no popup, no gas
prompt):** the mechanism is built and measured on a real nearcore node; the
OAuth front door is not. Accounts are derived deterministically from a verified
identity, and onboarding grants the market a NEP-245 approval while a temporary
full-access key exists, then **destroys that key in the same transaction that
installs the scoped one** — so a player holds no full-access key, and
`tests/near/gasless.mjs` asserts that before it transacts. Both halves of the
loop then work for free: the player **buys and sells** while the relayer pays.

**Identity-token verification is now real too**, in
[`backend/near/oidc.mjs`](backend/near/oidc.mjs): it fetches the provider's
JWKS, verifies the JWT signature, and checks `iss`, `aud`, `exp`, `nbf`/`iat`
and `sub`. 25 tests, all offline — the suite generates its own RS256 keypair,
mints real tokens and serves a JWKS from a stubbed fetch, so it needs no
provider and no network. The attacks are the point: `alg: none` is refused, an
HMAC `alg` signed with the public key is refused before the signature is even
checked, a swapped payload is refused, and a perfectly valid token minted for a
**different** application is refused. No new dependency — Node's `crypto` does
JWKS import and verification on its own.

What is left is not code: nobody has configured a real provider's client id, so
the deployed demo still onboards seeded `seed:` identities. The verifier is
built and tested; pointing it at Google or Apple is an operator step, and until
someone does that we have no screenshot of a real login to show.

**On the Minecraft integration:** the game world, its menus and its item
delivery are baseline — they exist and they work, on Unichain. What is *not*
done is repointing their settlement calls at NEAR, and this README previously
estimated that as "about six edit sites in one file". **That estimate was too
low, and here is the correction.** Six is the GUI side. The validation itself,
`InventoryMarketplace.gameOrder`, enforces `chainId == 1301`, an 18-decimal
`totalBaseUnits` cross-check, a `0x[a-fA-F0-9]{40}` address, Privy consent
nonces and a ten-state order machine — all EVM-shaped. Repointing it at NEAR is
a rewrite of the order flow, not an edit pass.

Two hard blockers, both verified rather than assumed: building the plugin needs
a hash-pinned Paper jar and its bootstrapped library tree, which exist only on
the operator host; and **this machine has no Java runtime at all**, so nothing
Java could be compiled or tested here even in extract. Writing a port we could
not compile would put unverified code into a submission whose whole claim is
that everything in it was checked, so we did not write one.

**No live NEAR gameplay has been recorded, and nothing here should be read as
implying one.** The `games` track is entered on what is actually demonstrated:
NEP-245 materials, one readable price rule, merchant reasoning the contract
itself produces, a measured key-less buy and sell, a real testnet transaction,
and a full economy run anyone can reproduce.

---

## What is baseline and what is being built in the window

The full disclosure, with per-file hashes, is in **[BASELINE.md](BASELINE.md)**.
Short version:

**Baseline — pre-existing, not judged.** NearCraft's game world, its AI agent
loop and its model routing come from **EthCraft / AgentCity**, a prior project
that settles on Unichain Sepolia through a custom Uniswap v4 hook. 11 files,
2,208 lines, vendored **byte-identical** into `backend/baseline/`. That prior
project contains **zero** NEAR code — no `near-sdk`, no `near-api-js`, no `.near`
account, no Rust — so none of the NEAR work existed before this hackathon.

Those files were reusable across a chain change for one structural reason: the
agent loop contains no chain code at all and reaches settlement through exactly
one HTTP call. That call is the thing being rewritten.

**Window work — judged.** Everything in `contracts/`, `backend/near/`,
`web/`, `tests/near/`, plus `GAME_LOOP.md`, `RULES.md`, `BASELINE.md` and this
file. Per hackathon rule Q-002, only this is judged; per Q-005, the baseline is
disclosed rather than hidden.

A new repository does not make reused work new. This repo says so in the same
words the prior project used about itself, and `npm run verify:baseline` makes
the boundary checkable instead of asking anyone to take it on trust.

---

## The argument

On EVM, answering *"what is this agent allowed to spend?"* cost the prior
project roughly **800 lines**: two separate Privy delegate quorums, two policy
documents compared by stable fingerprint, disjoint allowed-target sets, and ABI
decoding of calldata against a derived per-stage operation id — four independent
enforcement layers, all written and tested by hand, all expressed in
`eth_signTransaction` and `ethereum_calldata` conditions pinned to one chain id.

On NEAR that answer is a **protocol primitive**. A function-call access key is
scoped to one `receiver_id`, an explicit `method_names` list and an `allowance`.
The runtime enforces it. The key cannot transfer NEAR and cannot add keys.

So NearCraft deletes a security subsystem and gets a stronger guarantee, because
the guarantee no longer depends on our code being correct. That trade is why the
port was worth doing rather than relabelling, and it is what the `security`
track is being entered on.

---

## Verify it yourself

**Rehearsed the way you will meet it.** On 12 November 2026 this repository was
cloned fresh from GitHub into an empty directory — no `.local/`, no
`node_modules`, no build cache — and every command below was run against that
clone. It found a real failure on the first one: `npm test` exited 1, because a
documentation check added hours earlier flagged the gitignored `.local/`
directory as missing. Fixed, re-cloned, re-run. `npm install && npm test` now
passes all 183 checks from clean, `npm run reads` and `npm run keys` work with
no credentials, `npm run check:nep245` without a build says
`ABI not found — run npm run build:contracts first`, `npm run evidence` records
6 pass and 6 **skipped** rather than pretending, and `npm run build:contracts`
compiles from the cloned sources. The only things `.gitignore` excludes are
credentials, `node_modules/` and build output, so a clone has every input.

### Runs today, no credentials, no network

```sh
npm install
npm test
```

Needs Rust and Node 22+, nothing else — not even the wasm target, because
near-sdk unit tests build for the host. All three checks pass right now:

```sh
npm run test:contracts    # 93 Rust unit tests across all three contracts
npm run test:near         # 107 offline tests: policy, injection, counterparty, market, web, OIDC
npm run verify:baseline   # 11 vendored files, SHA-256 unchanged
```

The one worth reading the output of:

```sh
node --test tests/near/injection.mjs
```

A poisoned objective instructs an agent to pay `attacker.testnet`. Nine hostile
requests are refused across two layers and the log prints each refusal with its
reason — then the legitimate half of the same objective is authorised, because
this is a policy boundary and not a kill switch.

To rebuild the wasm yourself (needs `cargo-near`):

```sh
rustup target add wasm32-unknown-unknown
cargo install cargo-near      # compiles from source; takes a few minutes
npm run build:contracts
npm run check:nep245          # NEP-245 conformance, read off the compiled ABI
```

`check:nep245` is kept out of `npm test` on purpose: it reads the ABI that
`cargo-near` emits, and a conformance check that quietly passed when it could
not find an ABI would be worse than no check. It asserts the core 10 and
Enumeration 2 are present, that Approval Management and Metadata are absent as
documented, and that the modifiers carrying security meaning are right —
including that `buy_with_credit` is **not** payable, since a function-call
access key cannot attach NEAR and would otherwise be unable to call it.

### A real NEAR node, locally — no credentials, no faucet

These need the wasm built first, because they deploy it into a sandbox:

```sh
rustup target add wasm32-unknown-unknown
cargo install cargo-near          # compiles from source; takes a few minutes
npm run build:contracts
npm run test:sandbox              # smoke + keys + economy
```

`near-workspaces` starts an actual NEAR node locally. It downloads a node binary
once and caches it, so the first run needs network and later ones do not. No
account, no faucet, no credentials, at any point.

### The single best summary of what this does

```sh
npm run agent
```

An agent with a function-call key, on a real nearcore node, running three
objectives through every real layer — the two vendored baseline modules
(`survival-tools` validation, `adaptive-planner` routing), then `policy.mjs`,
`counterparty.mjs`, the on-chain guard, `signer.mjs`, and the market contract:

```
OBJECTIVE  legitimate, unknown counterparty
    screen    WARN
    PARKED    a human must decide:
                · barely-used account, never seen before (182 bytes of storage)
                · no prior interaction between this agent and this account
    operator  approves (unknown, but nothing against it)
    settle    ok  (after human approval)

OBJECTIVE  same merchant, trust accrued
    screen    ALLOW
    settle    ok

OBJECTIVE  PROMPT INJECTION
    screen    BLOCK
    REFUSED   COUNTERPARTY_BLOCKED
                rogue.sandbox: 3 distinct accounts reported this one
                (threshold 3); barely-used account, never seen before
```

The agent's holdings and budget are unchanged after the injection — the attack
cost nothing. The decision source is scripted rather than a language model,
deliberately: what is under test is the money path, and a scripted agent
exercises it identically while keeping the run free and reproducible.

**Also worth reading the output of** is the key test, because it is the
submission's central claim checked against the runtime rather than against our
own code:

```sh
cargo test -p nearcraft-integration --test keys -- --nocapture
```

It issues a genuine function-call access key scoped to `["buy_with_credit"]`,
signs with *that key*, and lets the protocol answer:

```
buy_with_credit         ALLOWED   (8 iron delivered, shelf 256 -> 248)
withdraw                REFUSED   InvalidAccessKeyError(MethodNameMismatch { method_name: "withdraw" })
withdraw_treasury       REFUSED   InvalidAccessKeyError(MethodNameMismatch { method_name: "withdraw_treasury" })
register_merchant       REFUSED   InvalidAccessKeyError(MethodNameMismatch { method_name: "register_merchant" })
fund_credit             REFUSED   InvalidAccessKeyError(MethodNameMismatch { method_name: "fund_credit" })
transfer 1 NEAR         REFUSED   InvalidAccessKeyError(RequiresFullAccess)
add full-access key     REFUSED   InvalidAccessKeyError(RequiresFullAccess)
mt_transfer (items)     REFUSED   InvalidAccessKeyError(DepositWithFunctionCall)
```

Those error names are the runtime's, not ours.

Three things we measured while building this, each of which contradicted an
assumption we had started from:

- **A function-call key cannot attach NEAR.** So an agent cannot call a payable
  method at all. That is why agents spend a budget credited inside the market
  contract instead of sending NEAR, and why their spending is bounded twice over.
- **The key's `allowance` is a gas budget checked as a per-call ceiling against
  *prepaid* gas, then drawn down by gas actually burned.** A 60 TGas call needs
  about 0.2 NEAR of headroom and burns about 0.007. `max_gas()` demands about
  1 NEAR of headroom per call, so an agent that uses it dies immediately on a
  modest allowance.
- **An empty `method_names` means *any method on that contract*.** near-api-js
  defaults it to `[]`, which is a quiet way to issue an unrestricted key.
  `npm run keys` exits non-zero if it ever finds one.
- **An allowance is spent and never refilled, so a key can lock its account
  out.** The `security` prompt closes by warning about exactly this: an account
  holding *only* function-call keys cannot add a replacement, so once its
  allowance falls below one call's prepaid gas it is stuck for good. We measured
  who is actually exposed, on public testnet:

  | Account | How it signs | Allowance drawn |
  |---|---|---|
  | `p-1d6a3c5d…` (a player), 6 calls | relayed, NEP-366 | **0 yoctoNEAR — not drawn at all** |
  | `worker-1` (an agent), 1 call | its own scoped key | 670,133,550,974,700,000,000 (~0.00067 NEAR) |

  Two consequences, and the first is a property of the design rather than luck.
  **Relaying immunises the player**: the relayer's key pays, so the player's
  allowance is never touched — which matters because the player is the one
  account deliberately left with no full-access key, and so the one that could
  not be rescued. A directly-signing agent *does* drain, at roughly 3,000 calls
  per 2 NEAR, and for an agent that is recoverable: the operator key exists
  precisely so it can be re-keyed. That is a second concrete reason for the key
  `npm run keys` discloses.

  `npm run keys` now prints the remaining headroom in calls and **fails below
  fifty**, so this is visible long before it bites rather than on the day it
  does.

### Look at the market

```sh
npm run web      # then open localhost:8080
```

Every merchant's ask, bid, stock band and — under each row — the contract's own
explanation of the price. **The page reads the deployed contracts**: it imports
the same `backend/near/market.mjs` reader the Minecraft plugin uses, over plain
JSON-RPC with no API key, so the prices a judge sees here and the prices a
player sees in-game cannot diverge.

With no network it falls back to the retained simulation snapshot and **says so
in the banner, naming the error** — a silent fallback would be the page lying by
omission. To regenerate that snapshot:

```sh
npm run build:contracts && npm run sim    # writes web/market-snapshot.json
```

The server exists because the page imports a module, which a browser will not
resolve over `file://`. It serves only `web/`, `backend/` and `deployment.json`
— deliberately not the repository root, because `.local/` is in the root and
holds the deploying account's private key. A test asserts it cannot be talked
into serving that.

### Keep the evidence

```sh
npm run evidence
```

Runs each check and retains what it actually printed, under
`evidence/runs/<topic>/<timestamp>/`, with the command, exit code, duration and
a SHA-256 of the output. A failing run is written out exactly like a passing one.
`evidence/SUMMARY.json` also records what these runs do **not** establish: they
are all local, there is no public-chain result among them, and no Minecraft
gameplay is exercised by any of them.

### The economy, running

```sh
npm run sim
```

Twenty buyers across six scripted strategies, five merchants, eight materials,
eight rounds, **no model calls** — plain arithmetic, so what is being tested is
the market and not a language model's taste. A representative run, in about 24
seconds:

```
round   trades   sales  refused     volume    closed  cheapest iron / oak
    3       16       3        3     29.852         0  0.506 / 0.100
    6       17       5        0     62.457         1  0.592 / 0.100
    8       10       3        0     82.590         1  0.614 / 0.100
110 purchases, 25 sell-backs, 17 refused on a stale quote, 82.590 NEAR of volume,
1 merchant(s) closed (first in round 6), in 23.7s of wall clock

bargain   x4  spent    3.702  earned   0.648  holding   52 units
dumper    x3  spent   18.677  earned  19.543  holding    0 units
greedy    x4  spent   25.566  earned   4.756  holding  120 units
```

Iron rose from 0.448 to 0.614 NEAR because buyers drained the shelves, and
trades fell as the bargain hunters priced themselves out. Nobody scripted that;
it falls out of the price rule.

**The `refused` column is the interesting one.** Each buyer's turn now runs
concurrently — they are separate accounts with separate nonces, so this is safe,
and it models a market town better than twenty players queuing politely. But it
means all twenty read the *same* quote, and the first one to clear moves the
price. A deposit sized exactly to the quote is then refused by the time it
executes, which is the contract being right: `require!(paid >= total)`. Buyers
therefore carry a 20% slippage tolerance, and the contract credits any
overpayment straight back. The refusals that remain are real stale quotes, and
they are counted rather than swallowed — the first parallel run silently lost 86
trades to this before the counter existed. The test asserts the things that
are robustly true — volume, that iron rose above base, that sell-backs happened,
and that a bargain hunter spends less than half what a hoarder does.

Merchant closures are **reported, not asserted** here. Whether a short run
drives one under depends on which materials its dumpers happen to cycle through,
so requiring it would make this run flaky. The rule is proved deterministically
instead by `a_merchant_can_be_flooded_until_it_stops_buying` in `economy.rs`,
which floods an undercapitalised merchant until the contract reports it closed,
then checks it still sells while posting no bid.

One thing building this taught us, recorded in `GAME_LOOP.md`: **a merchant that
sells briskly cannot go broke.** It earns on every sale and only spends when
buying from you. The merchants that close are the ones that opened
undercapitalised, or that you flooded on purpose.

**On "fast-forward", with numbers.** The `games` prompt asks for a week of
trading in about a minute. Here is exactly what we do and do not deliver.

What this compresses is *trading volume and price discovery*: **135 real
transactions on a real nearcore node in 23.7 seconds — 5.7 trades per second.**
That is 4.7× what it was, and the gain came from running each buyer's turn
concurrently rather than serially, plus dropping `max_gas()`. Prepaid gas is
what reserves room in a chunk and nearcore's per-chunk limit is 1000 TGas, so
300 TGas per call had been capping a block at three trades no matter how many
buyers were ready; the two paths now prepay measured ceilings of 100 and 150
TGas.

It does **not** advance a week of block height. `fast_forward` in the sandbox
produces blocks rather than jumping, and a week is 604,800 of them, which we
measured as far too slow to put in a test. Demand decay is the only
time-dependent mechanic and is exercised separately.

**Is 135 trades a week?** Only for a quiet town, so here is the arithmetic
rather than an adjective. Take the cadence in `GAME_LOOP.md` — a player makes a
trading decision every few minutes — and say each of five merchants serves one
trade every ten minutes across eight active hours: that is about **1,680 trades
a week**. At the measured 5.7 trades per second that is **roughly five minutes,
not one** — and only if the shelves could be kept stocked, which this contract
does not model, because merchants do not restock. Trades already fall from 17 a
round to 10 as the market drains.

So: a week of trading in about five minutes, under a stated definition, with
restocking unimplemented. Not a week in a minute. We would rather print the rate
we measured than round it up.

### Needs a live testnet deployment (the bonus, not the proof)

```sh
npm run deploy    # idempotent; needs NEAR_ROOT_KEY
npm run reads     # every merchant's price, bid, stock band and reason
npm run keys      # reads method_names + allowance back from the chain
```

---

## How the tracks are addressed

| Track | How |
|---|---|
| **`games`** | Requirement by requirement, with the gaps named. **(1)** Materials as NEP-245 multi-tokens, one contract holding every item type — core 10/10, Enumeration 2/2, Approval Management 5/5, read off the compiled ABI. **(2)** No seed phrase, no wallet popup, no gas prompt: measured, a player holding **no full-access key at all** both buys and sells for free. Identity verification is real too — [`backend/near/oidc.mjs`](backend/near/oidc.mjs) does JWKS fetch, JWT signature verification and `iss`/`aud`/`exp`/`sub` checks, with 25 offline tests covering `alg: none`, the HMAC confusion attack, a swapped payload and a token minted for another application. What is missing is not code but configuration: no real provider client id is set, so the deployed demo onboards seeded identities. **(3)** The price rule in one readable file, [`contracts/market/src/pricing.rs`](contracts/market/src/pricing.rs), and the merchant's own reason string rendered beside every quote — on the live web page today; **the in-game tooltip needs the Minecraft host, which is not up**. **(4)** Fast-forward: 135 real transactions in 23.7s. **That is not "a week in a minute"** — the arithmetic is worked out above and the claim declined. The loop is specified in [GAME_LOOP.md](GAME_LOOP.md), written before any code. |
| **`security`** | All three requirements. **(1)** A counterparty check returning `allow`/`warn`/`block` with reasons, scoring the four named signals — account activity, is-a-contract and code-changed, prior interactions, and an on-chain shared blocklist other agents report to with evidence. The wrapper refuses to sign on `block` and **parks the call for a human on `warn`**. **(2)** Agents sign with a function-call access key scoped to one contract with an explicit method list and allowance, never a full-access key — its limits are explained below, proved at the protocol level in the sandbox, and read back off the live chain by `npm run keys`. The agent *account* does also carry an operator key, which that command discloses and counts; the section below says exactly who holds it and why players are treated differently. **(3)** The attack demo: a prompt-injected agent tries to pay a known-bad account, is stopped, and the log is printed. Signals and their data sources are written up in [docs/SECURITY_SIGNALS.md](docs/SECURITY_SIGNALS.md), which was written before the code, as the prompt asks. |

**Two tracks are entered: `games` and `security`.**

**`swarms` is not entered.** It was planned as a third. Its round rules were
fixed in [RULES.md](RULES.md) before any code, as that prompt asks — and then
the sealed-bid coordinator was never built, so the track's stated requirements
are unmet and we do not select it. `RULES.md` stays in the repo, labelled as
designed-and-not-implemented, because deleting it would hide that we scoped
something and dropped it. Entering a track whose requirements we did not meet is
not something this project will do, and the gate that stopped it existed
precisely so a third ticket could not eat the primary track's remaining time.

---

## Architecture

```
NEAR testnet
├── items.nearcraftmc.testnet      NEP-245: every material is one token id in one contract
├── market.nearcraftmc.testnet     merchant inventories, pricing, treasuries, buy/sell settlement
├── guard.nearcraftmc.testnet      the public blocklist other agents report to, with evidence
├── ironmonger.nearcraftmc.testnet merchant agents — one named account each
├── worker-1.nearcraftmc.testnet   player-hired agents — the agent process holds only a scoped key
└── p-1d6a3c5d.nearcraftmc.testnet a player — one scoped key, no full-access key at all

backend/
├── baseline/   vendored unchanged: agent loop, tool registry + validator, model router, spend ledgers
└── near/       new: function-call-key signer, policy refusal, market/items wrappers, relayer

contracts/integration/tests/
                a real local nearcore node: access-key limits, the cross-contract
                economy, and the scripted no-model-calls simulation
```

There is no `plugin/` directory. The Minecraft settlement path is not ported —
see the note above for why, and for what that costs the `games` track.

**Two key models, and the difference is deliberate.** A *player's* account ends
up holding exactly one scoped key and no full-access key — `onboarding.mjs`
installs the scoped key and deletes the bootstrap full-access key in the same
transaction, because the entire point is that there is no seed phrase for a
player to lose. An *agent's* account holds its scoped key **plus an operator
full-access key**, created with the account and kept in gitignored `.local/`.

That operator key is disclosed rather than hidden, and `npm run keys` counts it
on every run. The reason it is not a hole in the security claim: the question
the track asks is what the *agent* can do, and the agent process is given only
the scoped key — it cannot transfer NEAR, cannot add keys, and can call exactly
one method on exactly one contract, all enforced by the runtime rather than by
us. The operator already owns the agent, so an operator key adds no authority
that was not already theirs. An earlier version of this file claimed the agent
account held "a function-call key, nothing more", which was simply false, and
`npm run keys` audited **zero** accounts while reporting success — both are
fixed, and the audit now refuses to pass when it has nothing to check.

The player's account id is not a name someone chose. It is derived from the
login — `p-<first 8 hex of sha256("provider:subject")>` — so the same identity
always lands on the same account and no mapping table is needed. `p-1d6a3c5d`
is `seed:player-1`, the demo identity. See [docs/GASLESS.md](docs/GASLESS.md);
verifying the identity token is implemented in [`backend/near/oidc.mjs`](backend/near/oidc.mjs); what the demo lacks is a configured provider client id, not the code.

A `player-1.nearcraftmc.testnet` account also exists on testnet. It is a
leftover: an earlier deploy created players inline with literal names, before
that logic was de-duplicated into `backend/near/onboarding.mjs`. Nothing refers
to it and it is not in `deployment.json`.

The root account is `nearcraftmc.testnet` rather than `nearcraft.testnet`
because the latter is already registered by a third party.

## Honest state of the baseline

The prior project is candid about its own maturity and NearCraft does not
improve on it by restating it. In EthCraft, 31 of 270 canonical scenario
families pass; 236 are not run and 3 are blocked. Its high-water mark for
demonstrated agent autonomy is small and dated: on 6 November 2026 two agents
withdrew two oak planks, crafted four sticks and deposited them. One real player
once bought one oak plank for 0.01 test CITY. A complete player liquidity
lifecycle was never finished.

None of those are NEAR results and none are claimed here. What NearCraft claims
is whatever the commands above actually print.

## Documents

- [GAME_LOOP.md](GAME_LOOP.md) — the game loop, the price rule, where the chain hides
- [RULES.md](RULES.md) — bulk round rules and a sequence diagram of one round
- [BASELINE.md](BASELINE.md) — what was reused, with hashes
- [docs/PROVENANCE.md](docs/PROVENANCE.md) — prior-art links and AI-assistance disclosure

## License

MIT — see [LICENSE](LICENSE). AI assisted the implementation, tests and
documentation of both this project and its baseline.
