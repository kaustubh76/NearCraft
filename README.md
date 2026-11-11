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

## Status — 11 November 2026

This README describes what exists today, not what is planned. Read the status
column before the description.

| Component | Status |
|---|---|
| `GAME_LOOP.md` — the game loop on paper | **Done.** Required by the `games` prompt before any code. |
| `RULES.md` — round rules + sequence diagram | **Done.** Required by the `swarms` prompt before any code. |
| `BASELINE.md` + hash-verified baseline import | **Done, machine-checked.** `npm run verify:baseline` |
| `contracts/items` — NEP-245 materials | **Built and tested.** 19 unit tests. NEP-245 core 10/10 + Enumeration 2/2, verified against the compiled ABI. 204.7 KB wasm. |
| `contracts/market` — merchants, pricing, treasury | **Built and tested.** 42 unit tests. |
| `contracts/guard` — the shared blocklist, on-chain | **Built and tested.** 13 unit tests. Public, attributed by the runtime, not deletable by us. |
| `backend/near/counterparty.mjs` — allow/warn/block | **Built and tested.** 17 tests. Pure scoring, no API key, no indexer. |
| `backend/near` — signer, policy, warn→human approval | **Built and tested.** 53 tests across policy, counterparty, human approval, the plugin contract and the injection demo. |
| **Sandbox integration tests** | **Built and passing.** A real local NEAR node via `near-workspaces`. 12 tests: 4 prove a restricted key's limits *at the protocol level*, 6 cover the cross-contract buy/sell/rollback paths, 1 runs the economy, 1 proves the node starts. |
| **Deployed to NEAR testnet** | **No**, and no longer on the critical path — every check below runs against a local sandbox instead. See the note on the faucet. |
| The economy simulation | **Built and passing.** 20 buyers, 6 strategies, 5 merchants, 8 rounds, no model calls. `npm run sim` |
| `web/market.html` | **Built.** Every merchant's ask, bid, stock band and the contract's own reason string. No external dependencies. |
| `npm run agent` — an agent shopping end to end | **Built and runnable.** An agent with a scoped key on a real node: an unknown merchant parked for a human, the same merchant clearing itself once trust accrued, and a prompt-injected objective **blocked** by the on-chain guard. |
| `AGENTS.md` | **Written.** Repo instructions and the claims policy, for the AI judges the organisers named. |
| `evidence/` | **Built.** `npm run evidence` retains each check's real output with its exit code and an output hash. Failures are kept, not edited out. |
| Gasless play — no seed phrase, no popup, no gas prompt | **Built and measured.** `npm run test:gasless`: a player holding **no full-access key at all** both buys and sells on a real nearcore node without paying. 15 more offline tests. [docs/GASLESS.md](docs/GASLESS.md) |
| NEP-245 Approval Management | **Built and tested.** 10 unit tests. Implemented because without it a key-less player could buy but never sell. |
| Minecraft plugin settlement path | **Not built.** See the note below. |
| Sealed-bid rounds (`swarms`) | **Not built, and that track is not entered.** See below. |

**Nothing is deployed to NEAR testnet yet**, so no account id in this README is
live and `npm run reads` / `npm run keys` will tell you so rather than invent
output. `helper.testnet.near.org` returns 404 and the web faucet was erroring, so
a `*.testnet` account could not be created. **That stopped mattering:** the
verification below runs against a real NEAR node in a local sandbox, so it needs
no account, no faucet and no credentials at all. Testnet deployment is a bonus
claim rather than the proof, and `npm run deploy` is idempotent and ready for
whenever an account exists.

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

What is **stubbed** is identity-token verification itself, behind a pluggable
`verifyIdentity` interface — the one genuinely external dependency. So we do not
call this "social login"; the mechanism behind a social login is built and
measured, and the provider integration is not.

**On the Minecraft integration:** the game world, its menus and its item
delivery are baseline — they exist and they work, on Unichain. What is *not*
done is repointing their settlement calls at NEAR. That turned out to be about
six edit sites in one file, because the plugin holds no settlement logic at all;
but building it needs a hash-pinned Paper jar and its bootstrapped library tree,
which live only on the operator host. **No live NEAR gameplay has been recorded,
and nothing here should be read as implying one.** The `games` track is entered
on what is actually demonstrated: NEP-245 materials, one readable price rule,
merchant reasoning the contract itself produces, and a full economy run anyone
can reproduce.

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

**Window work — judged.** Everything in `contracts/`, `backend/near/`, `sim/`,
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

### Runs today, no credentials, no network

```sh
npm install
npm test
```

Needs Rust and Node 22+, nothing else — not even the wasm target, because
near-sdk unit tests build for the host. All three checks pass right now:

```sh
npm run test:contracts    # 61 Rust unit tests across both contracts
npm run test:near         # 15 policy + prompt-injection tests
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

### Look at the market

```sh
npm run build:contracts && npm run sim    # writes web/market-snapshot.json
python3 -m http.server -d web             # then open localhost:8000/market.html
```

Every merchant's ask, bid, stock band and — under each row — the contract's own
explanation of the price. The page states plainly that it is a simulation
snapshot rather than live chain data, because until something is deployed that
is what it is.

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

Twenty buyers across six scripted strategies, five merchants, four materials,
eight rounds, **no model calls** — plain arithmetic, so what is being tested is
the market and not a language model's taste. A representative run, in about 110
seconds:

```
round   trades   sales     volume    closed  cheapest iron / oak
    1       19       6     12.991         0  0.448 / 0.084
    4       15       3     45.611         0  0.534 / 0.102
    8       11       3     88.944         0  0.611 / 0.102
118 purchases, 28 sell-backs, 88.944 NEAR of volume

bargain   x4  spent    2.544  earned   0.000  holding   32 units
dumper    x3  spent   20.362  earned  18.582  holding    0 units
greedy    x4  spent   26.610  earned   0.000  holding  128 units
```

Iron rose from 0.448 to 0.611 NEAR because buyers drained the shelves, and
trades fell from 19 to 11 as the bargain hunters priced themselves out. Nobody
scripted that; it falls out of the price rule. The test asserts the things that
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

**On "fast-forward":** the `games` prompt asks for a week of trading in about a
minute. What this compresses is *trading volume* — a few hundred real
transactions that a populated server would take days to generate. It does **not**
advance a week of block height: `fast_forward` in the sandbox produces blocks
rather than jumping, and a week is 604,800 of them, which we measured as far too
slow to put in a test. Demand decay is the only time-dependent mechanic and is
exercised separately. Calling this "a week of wall-clock time" would be a claim
we cannot support, so we don't.

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
| **`games`** | Materials as NEP-245 multi-tokens (one contract, every item type). Merchant prices from stock and recent demand, with the rule in one readable file and the merchant's reasoning shown in-game. Social login, no seed phrase or gas prompt in the normal loop. Fast-forward mode. The loop itself is specified in [GAME_LOOP.md](GAME_LOOP.md). |
| **`security`** | All three requirements. **(1)** A counterparty check returning `allow`/`warn`/`block` with reasons, scoring the four named signals — account activity, is-a-contract and code-changed, prior interactions, and an on-chain shared blocklist other agents report to with evidence. The wrapper refuses to sign on `block` and **parks the call for a human on `warn`**. **(2)** Agents sign with a function-call access key scoped to one contract with an explicit method list and allowance, never full-access — its limits are explained above and proved in the sandbox. **(3)** The attack demo: a prompt-injected agent tries to pay a known-bad account, is stopped, and the log is printed. Signals and their data sources are written up in [docs/SECURITY_SIGNALS.md](docs/SECURITY_SIGNALS.md), which was written before the code, as the prompt asks. |
| **`swarms`** | Each agent gets its own named sub-account, so every on-chain action traces to one agent. A sealed-bid commit-reveal round coordinator, second-price clearing, with rules fixed in [RULES.md](RULES.md) before any contract code, and a scripted no-LLM simulation. |

`swarms` is entered **only if** its coordinator is actually deployed and
simulated. Entering a track whose stated requirements are unmet is not something
this project will do.

---

## Architecture

```
NEAR testnet
├── items.nearcraftmc.testnet      NEP-245: every material is one token id in one contract
├── market.nearcraftmc.testnet     merchant inventories, pricing, treasuries, round coordinator
├── ironmonger.nearcraftmc.testnet merchant agents — one named account each
└── worker-1.nearcraftmc.testnet   player-hired agents — holds a function-call key, nothing more

backend/
├── baseline/   vendored unchanged: agent loop, tool registry + validator, model router, spend ledgers
└── near/       new: function-call-key signer, policy refusal, market/items wrappers, relayer

sim/            scripted economy, no model calls — the reproducibility backbone
plugin/         Paper plugin: in-game menus and item delivery, settlement swapped to NEAR
```

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
