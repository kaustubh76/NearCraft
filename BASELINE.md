# Baseline and new work

The NEAR HACKATHON rules allow an existing product on another chain and judge
only the NEAR integration built in the window (Q-002), and allow your own
pre-hackathon libraries as disclosed baseline (Q-005). This file is that
disclosure. It is deliberately specific, because a vague version of it would be
worth nothing.

## The short version

NearCraft's game world, its AI agent loop and its model routing come from
**EthCraft / AgentCity**, a pre-existing project that settles on Unichain
Sepolia through a custom Uniswap v4 hook. None of that NEAR work existed before
this hackathon: the prior repository contains **zero** NEAR code — no
`near-sdk`, no `near-api-js`, no `.near` account, no Rust at all. Verified by
grep across every `.md`, `.json`, `.ts`, `.js`, `.java` and `.py` file in it.

Everything in `contracts/`, `backend/near/`, `web/` and `tests/near/`
is new. Everything in `backend/baseline/` is not.

## Vendored unchanged — baseline, not judged

These files are copied byte-for-byte from EthCraft. They contain no chain
code of any kind, which is why they could be reused across a chain change at
all: the agent loop reaches settlement through exactly one HTTP call, and that
call is the thing we rewrote.

| File | Lines | SHA-256 |
|---|---|---|
| `backend/baseline/playable/survival-objectives.mjs` | 277 | `bfaf2c9fd7867fbd61055c71b946611ee7ae6c2ee8bc24843a956d1bf5cd5fb2` |
| `backend/baseline/playable/survival-tools.mjs` | 262 | `7ab517991163d4418c220be7dc43aca0e39ad207c36a83cf2433546be1e680ee` |
| `backend/baseline/playable/adaptive-planner.mjs` | 78 | `73ad6632a65bcec99989a8d675da934ba409c12849dcf76484516650286ce8f4` |
| `backend/baseline/playable/intent-planner.mjs` | 304 | `dcc3a5b47616c352458953528c9f0bb5a90112c4203200a3727a45b420424434` |
| `backend/baseline/playable/task-tools.mjs` | 726 | `b7efc2f93f4436a833b685e6e70b5abce3a888f8ce20fadec07b8fef68997a3a` |
| `backend/baseline/bot/checkpoint-store.cjs` | 56 | `bd857c0b57ca4533c5bde3eb643b99500c35c98fd107b6ce865014c4702654e4` |
| `backend/baseline/inference/anthropic.mjs` | 86 | `013a8c507fb3be76944e7daff372155c23ba857a6f80d4247ce503a8ef07c3d2` |
| `backend/baseline/inference/anthropic-budget.mjs` | 125 | `3ea6d54f681cc8023594cf017e0d02e6b2be505f269a9b99f1399e592b0ce998` |
| `backend/baseline/inference/zero-g.mjs` | 83 | `1c5e268f748a6ca282cadeae2838584e3fc4273df2902aa1a941c56bb7415732` |
| `backend/baseline/inference/zero-g-budget.mjs` | 157 | `442fddea8a612d07357d85e04146d9a47adb1a85444caf917b26bf52be625609` |
| `backend/baseline/inference/providers.mjs` | 54 | `f220fca5300b1befa41819dd843089d6370ecb232e5896304f0c616a42b29df4` |

**2,208 lines of baseline.** Hashes are of the files as they stood in the
source checkout; `npm run verify:baseline` recomputes them and fails on drift,
so a reviewer never has to take this table on trust.

What those files do: the observe → plan → validate → lock → act → receipt agent
loop with durable job state and crash-safe effect fencing; a sixteen-tool
registry with a strict receiving validator; a seven-rule model router with
context compaction; two reserve-then-reconcile spend ledgers.

**EthCraft's Paper plugin is not vendored here, and no part of it was ported.**
An earlier version of this file described it as "a partial port rather than a
byte-identical copy, and the diff is the new part" — there was no such diff,
because there is no Java in this repository at all. The in-game menus and item
delivery remain prior work sitting in the EthCraft repo; repointing their
settlement calls at NEAR is unbuilt, and `README.md` states what that costs.

## Written in the window — the judged work

- `contracts/items/` — NEP-245 multi-token for materials. New.
- `contracts/market/` — merchant registry, stock-and-demand pricing, treasuries,
  closed-when-broke. New. (No sealed-bid round coordinator: it was designed in
  `RULES.md` and never built, so the `swarms` track is not entered.)
- `backend/near/` — the function-call-key signer and the policy layer that
  refuses an out-of-policy call before signing; market and items wrappers; the
  counterparty allow/warn/block check; the NEP-366 relayer. New. This replaces
  EthCraft's `agent-shop.mjs`, which was the single HTTP endpoint the agent loop
  used to reach money.
- `contracts/integration/tests/simulation.rs` — the scripted economy: twenty
  buyers, five merchants, no model calls, against a real local nearcore node.
  New. (An earlier version of this file promised this as `sim/fastforward.mjs`
  "against the deployed testnet contracts". It is Rust, it runs against a
  sandbox, and there is no `sim/` directory.)
- `web/market.html` — read-only market page, reading the deployed contracts live
  over public RPC with a retained sandbox snapshot as its offline fallback. New.
- `tests/near/` — policy refusal, prompt-injection refusal, pricing. New.
- `GAME_LOOP.md`, `RULES.md`, this file, `README.md`. New.

## What we deleted, which is the interesting part

EthCraft enforced "this agent may buy materials but may not invest" with four
independent layers: two separate Privy delegate quorums, two policy documents
compared by stable fingerprint, disjoint allowed-target sets, and ABI decoding
of calldata against a derived per-stage operation id. Roughly eight hundred
lines of security code that we wrote and tested ourselves, all of it expressed
in `eth_signTransaction` and `ethereum_calldata` conditions pinned to
`chain_id == 1301`.

On NEAR that is a function-call access key: one `receiver_id`, an explicit
`method_names` list, an `allowance`. The runtime enforces it, the key cannot
transfer NEAR and cannot add keys. None of those eight hundred lines came
across, and the guarantee is stronger because it no longer depends on our code
being correct.

That trade is the submission's actual argument, and it is why the port was
worth doing rather than a relabel.

## Provenance

The EthCraft repository is the baseline's origin and should be read as the prior
art. Its own documentation is explicit that reuse is reuse — *"a new repository
or condensed history does not make them newly created for a prize track"* — and
that sentence is the standard this file is held to as well.

Repository links are recorded in `docs/PROVENANCE.md`. Confirm they resolve
publicly before submitting; a provenance link a judge cannot open is worse than
no link.

## State of the baseline, not upgraded

The prior project is honest about its own maturity and we do not improve on it
here. In EthCraft, 31 of 270 canonical scenario families pass; 236 are not run
and 3 are blocked. Its high-water mark for demonstrated autonomy is small and
dated: on 6 November 2026 two agents withdrew two oak planks, crafted four
sticks and deposited them. One real player once bought one oak plank for 0.01
test CITY. A complete player liquidity lifecycle was never finished.

Nothing in NearCraft's README claims otherwise, and none of those numbers are
restated here as NEAR results. What NearCraft claims is what `npm run sim`,
`cargo test` and the `near view` calls in the README actually print.
