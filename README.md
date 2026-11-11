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
| `contracts/items` — NEP-245 materials | **Built and tested.** 19 tests. NEP-245 core 10/10 + Enumeration 2/2, verified against the compiled ABI. 204.7 KB wasm. |
| `contracts/market` — merchants, pricing, treasury | **Built and tested.** 39 tests. 186.8 KB wasm. |
| `backend/near` — function-call-key signer + policy | **Built and tested.** 15 tests, including the prompt-injection attack demo. |
| **Deployed to NEAR testnet** | **No.** Blocked on creating the root account by hand — see below. |
| `sim/fastforward.mjs` — scripted week-in-a-minute | **Not built.** |
| Minecraft plugin settlement path | **Not built.** |
| Sealed-bid rounds (`swarms`) | **Not built.** Entering that track depends on it; see the honest note below. |

**Nothing is deployed to NEAR testnet yet**, so no account id in this README is
live and `npm run reads` / `npm run keys` will tell you so rather than invent
output. Deployment is blocked on one manual step: `helper.testnet.near.org` now
returns 404, so a `*.testnet` account can no longer be created programmatically.
`nearcraftmc.testnet` has to be made at [near-faucet.io](https://near-faucet.io)
first. Everything after that is `npm run deploy`, which is idempotent.

**On the `swarms` track:** the sealed-bid coordinator in `RULES.md` is designed
but not implemented. If it is not deployed and simulated before the deadline, we
will not select that track. Entering a track whose stated requirements are unmet
is not something this project will do.

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
npm run test:contracts    # 58 Rust unit tests across both contracts
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

### Needs a deployment first (not yet true)

```sh
npm run deploy    # idempotent; needs NEAR_ROOT_KEY
npm run reads     # every merchant's price, bid, stock band and reason
npm run keys      # reads each agent key's limits back from the protocol
npm run sim       # 20 buyers, 5 sellers, a week of trading in ~60s
```

`npm run keys` is the check behind the security claim: it reads
`method_names` and `allowance` back from the chain and **exits non-zero** if any
agent key is ever unrestricted. `npm run sim` is the one to care about for the
economy — scripted strategies, no model calls, run against the deployed
contracts, needing no credentials and no Minecraft server.

---

## How the tracks are addressed

| Track | How |
|---|---|
| **`games`** | Materials as NEP-245 multi-tokens (one contract, every item type). Merchant prices from stock and recent demand, with the rule in one readable file and the merchant's reasoning shown in-game. Social login, no seed phrase or gas prompt in the normal loop. Fast-forward mode. The loop itself is specified in [GAME_LOOP.md](GAME_LOOP.md). |
| **`security`** | Agents sign with function-call access keys scoped to one contract with an explicit method list and allowance — never a full-access key. A wrapper refuses to sign on a policy violation and escalates to a human confirmation otherwise. Plus the required attack demo: a prompt-injected agent attempting to pay a known-bad account, blocked, with the log. |
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
