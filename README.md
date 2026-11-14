# NearCraft

**An agent-run market economy inside Minecraft, settled on NEAR.** Merchants are AI agents holding their own named NEAR
accounts, their own inventory and their own money. Their prices come from their
stock and from what players just sold them, so the market — not a quest script —
is what you play against. Players never see a wallet, a seed phrase or a gas
prompt.

Built for the **NEAR HACKATHON** (1–14 November 2026). Tracks entered:
`games` (primary), `security`.

**Open it without cloning:** the market page is at
<https://nearcraft.vercel.app> and reads the deployed contracts live over public
RPC. The play API behind it is at <https://nearcraft-play.onrender.com>. Both are
described in [Open it without cloning](#open-it-without-cloning) — including
what the hosted service deliberately *cannot* do.

---

## Status — 14 November 2026

This README describes what exists today, not what is planned. Read the status
column before the description.

| Component | Status |
|---|---|
| `GAME_LOOP.md` — the game loop on paper | **Done.** Required by the `games` prompt before any code. |
| `RULES.md` — round rules + sequence diagram | **Done.** Required by the `swarms` prompt before any code. |
| `BASELINE.md` + hash-verified baseline import | **Done, machine-checked.** `npm run verify:baseline` |
| `contracts/items` — NEP-245 materials | **Built and tested.** 33 unit tests. NEP-245 core 10/10 + Enumeration 2/2 + Approval Management **6/6**, verified against the compiled ABI. Three spec ambiguities are decided and disclosed in the module header, including that `mt_is_approved` takes an explicit `owner_id` — the spec's signature names none, which a multi-token cannot answer. |
| `contracts/market` — merchants, pricing, treasury | **Built and tested.** 107 unit tests (the pricing rule, the payout rollbacks, restocking, investment and the money invariant — including the three interleaved ones that caught `sell`, `buy` and `restock` each paying somebody before the goods had moved). **NEP-297 events are built and NOT YET DEPLOYED.** `buy` and `sell` emitted nothing at all — not a plain log line — so the two central events of the economy are silent on chain; the token leg of a trade is visible through `items`' NEP-245 `mt_transfer`, the money leg names no merchant, no price and no margin. Ten kinds of event under its own standard, `nearcraft_market` `1.0.0`, emitted where a trade *settles* rather than where it is requested — in **source**, with 4 unit tests on the envelope and a sandbox rehearsal that redeployed over the real deployed bytes and watched the event fire on a real nearcore node carrying the price. What is deployed today predates all of it: `npm run verify:deployed` reports three `DIFFERS` and says so. The redeploy is one command and has not been run. |
| `contracts/guard` — the shared blocklist, on-chain | **Built and tested.** 13 unit tests. Public, attributed by the runtime, not deletable by us. |
| `backend/near/counterparty.mjs` — allow/warn/block | **Built and tested.** 23 tests. Pure scoring, no API key, no indexer. |
| `backend/near` — signer, policy, warn→human approval | **Built and tested.** 90 tests across policy, counterparty, human approval, the plugin contract and the injection demo. |
| **Sandbox integration tests** | **Built and passing.** A real local NEAR node via `near-workspaces`. 18 tests: 4 prove a restricted key's limits *at the protocol level*, 9 cover the cross-contract buy/sell/rollback paths, the economy, the money invariant and solvency, 3 the state migration (including bricking a contract with a plain redeploy and rescuing it), 1 that every view is callable *as a view*, and 1 that the node starts. These counts are checked by `npm run check:docs` against the tests that actually exist — they had rotted to 74 and 12. |
| **Deployed to NEAR testnet** | **Yes.** `items.nearcraftmc.testnet`, `market.nearcraftmc.testnet`, `guard.nearcraftmc.testnet` — 5 merchants, 2 agents, 4 players. `npm run reads` and `npm run keys` query it with no credentials. |
| The economy simulation | **Built and passing.** 20 buyers, 6 strategies, 5 merchants, 8 rounds, no model calls — **135 real transactions in 26.4s** on a real nearcore node — 5.1 trades a second, measured over three runs — buyers running concurrently. `npm run build:contracts && npm run sim` |
| `web/market.html` | **Built, reads the live chain, and is playable.** Every merchant's ask, bid, stock band and the contract's own reason string, read from the deployed contract over public RPC with no API key. Falls back to the retained simulation snapshot when offline, and says which it is showing. With `npm run play` behind it the page also signs players in and trades: buy and sell on each row, and a strip showing your NEAR balance before and after every call. 19 tests. `npm run web` / `npm run play` |
| **A real stake in a merchant on public testnet** | **Done.** [`CwWMeG5t…`](https://testnet.nearblocks.io/txns/CwWMeG5txLAobS7dozomcBqKBZturJ7iKiY21e3FDEUG) — 0.05 NEAR staked in the Ironmonger and recorded by the contract, then [`8s6e5vqw…`](https://testnet.nearblocks.io/txns/8s6e5vqwysZj8pMRubF8TkngzZ5erfr7EMdvUyr1pJYA), a gasless purchase whose margin repaid 0.005924 NEAR of it. `ledger_total` rose by exactly the stake and the purchase moved it by nothing. `npm run live:stake`, retained in `evidence/live/`. |
| **A real agent transaction on public testnet** | **Done.** [`CJXc3vK8Yom…`](https://testnet.nearblocks.io/txns/CJXc3vK8YomMVAZn6j6R6FHKqtSF9t4Ev4Tbcq4eqnhZ) — an agent signing with a `buy_with_credit`-scoped key, after being parked for human approval. `npm run live:agent`, retained in `evidence/live/`. |
| `npm run agent` — an agent shopping end to end | **Built and runnable.** An agent with a scoped key on a real node: an unknown merchant parked for a human, the same merchant clearing itself once trust accrued, and a prompt-injected objective **blocked** by the on-chain guard. |
| `AGENTS.md` | **Written.** Repo instructions and the claims policy, for the AI judges the organisers named. |
| `evidence/` | **Built.** `npm run evidence` retains each check's real output with its exit code and an output hash. Failures are kept, not edited out. |
| Social / email login | **Built and tested.** [`backend/near/oidc.mjs`](backend/near/oidc.mjs) — JWKS fetch, JWT signature verification, `iss`/`aud`/`exp`/`nbf`/`sub` checks. 25 offline tests including `alg: none`, the HMAC confusion attack, a swapped payload and a token minted for another application. A Google client id **is** configured, in gitignored `.local/oidc.json`, and `/api/health` reports `verifier: "oidc"`. `tests/near/oidc-runtime.mjs` drives the real verifier with its default global `fetch` against a real `node:http` JWKS inside the real service, and asserts fifteen refusals **by code** at the service boundary. What is still disclosed is one step narrower: **no token Google itself issued has been through it**, because obtaining one needs a browser and a consent screen. `npm run oidc:verify` settles that in one command. |
| **A brand-new player onboarded on public testnet** | **Done.** [`2FNytLGE…`](https://testnet.nearblocks.io/txns/2FNytLGEDMPRBjrf5TsYZBsT1ZVWrMu8uCUKeDKmCbp5) created [`p-62b0b243.nearcraftmc.testnet`](https://testnet.nearblocks.io/address/p-62b0b243.nearcraftmc.testnet) from a login, and [`6fe1RTHS…`](https://testnet.nearblocks.io/txns/6fe1RTHSf1sxH8LYRbC8ko3pQLgMF9feXZfBVn6S8f5t) installed its scoped key and **deleted the full-access one in the same transaction**. Read back from the chain: zero full-access keys, one function-call key, exactly the three methods the catalog lists, an approval over all eight sellable materials. Root paid 0.107115 NEAR; the player paid nothing and never saw a key. `npm run mc:up` then played that account in Minecraft, 9 of 9. This README disclosed for weeks that it could not be done, because root held 0.091081 NEAR against a 0.107607 cost. `npm run live:onboard`, retained in `evidence/live/`. |
| Gasless play — no seed phrase, no popup, no gas prompt | **Built and measured on public testnet.** `npm run live:player`: a player holding **no full-access key at all** buys and sells on NEAR testnet and its balance moves by **exactly 0** — the relayer pays. Reproduced twice, hashes retained in `evidence/live/`. Also `npm run test:gasless` on a local node — three tests, the third a key-less player **backing a merchant** for nothing — plus the relayer and onboarding tests. [docs/GASLESS.md](docs/GASLESS.md) |
| The money invariant | **Built and tested.** `sum(treasuries) + sum(credits) == deposited − paid out`, asserted after **every one** of the contract's fourteen money-moving calls, so a failure names the step rather than the session. Proved by injecting a real leak — a sale that credits the seller without debiting the treasury — which the test catches as "the ledger drifted after sell" with the 1.66 NEAR created from nothing. Plus the half a unit test cannot see: a sandbox test that the market's own NEAR balance always covers what it owes, across buys, a sale, an investment and a real withdrawal. `docs/RECAPITALIZATION.md`'s own formula for this was **wrong** — it double-counted stakes — and is corrected there. |
| Reopening a broke merchant — the prompt's own sentence | **Built and tested.** The `games` prompt ends its description with "it closes its shop **until someone invests in it**". `market.invest(merchant_id)` is payable and permissionless; `market.invest_with_credit` is **non-payable** so a player holding one scoped key can call it at all — without that the mechanic would be unreachable for exactly the players it is for. `invest` returns whether the shop reopened, and says so in its log rather than claiming success when the amount fell short. A funder gets back the shop — a closed merchant will not buy from you, so the player holding iron is exactly the person who wants the ironmonger funded — **and now the stake too**: it is recorded, and half of every later sale's margin repays it until the claim is settled. That is the design in [docs/RECAPITALIZATION.md](docs/RECAPITALIZATION.md), which needed new contract state and the migration to carry it, and both now exist. Covered by `backing_tests` in [contracts/market/src/pricing.rs](contracts/market/src/pricing.rs) for the arithmetic, the `invest`/`backer`/`basis` tests in [contracts/market/src/lib.rs](contracts/market/src/lib.rs) for the behaviour, and one end-to-end run on a real node in [contracts/integration/tests/economy.rs](contracts/integration/tests/economy.rs). **And it has now run on public testnet**: `worker-1` staked 0.05 NEAR in the Ironmonger ([`CwWMeG5t…`](https://testnet.nearblocks.io/txns/CwWMeG5txLAobS7dozomcBqKBZturJ7iKiY21e3FDEUG)), `ledger_total` rose by exactly that and nothing else, and the next gasless purchase ([`8s6e5vqw…`](https://testnet.nearblocks.io/txns/8s6e5vqwysZj8pMRubF8TkngzZ5erfr7EMdvUyr1pJYA)) repaid 0.005924 NEAR of it out of the margin — stake, sale, repayment, on a public chain. `npm run live:stake` reproduces it and asserts every step. Two things it does not claim are in that script's header: it is signed with a **full-access operator key**, because `invest` is payable and a scoped key cannot attach a deposit; and the margin is **larger than the design intends**, because most live stock predates the migration that introduced cost recording, so an unknown cost reads as a zero one. The script prints the cost it used and says which case it hit. |
| Merchant restocking — "an economy that evolves without a dev patch" | **Built and tested.** `market.restock(merchant_id, item)` is **permissionless and non-payable**, so anyone may refill a thin shelf and a scoped key can do it. The merchant pays out of its own treasury at the bid it *would post for the restocked shelf* — provably below what it sells for, so a restock can never be a loss — and never spends into its floor. It **mints** the goods through `items.mt_mint`, so a shelf never claims stock the contract does not hold; a sandbox test on a real node proves the market's NEP-245 balance rises by exactly the units added. 13 tests. |
| Payout rollbacks | **Built and tested.** `withdraw` and `withdraw_treasury` used to zero the ledger and then fire a bare transfer with no callback: a failed payout debited the claimant and delivered nothing, and the market silently kept money it no longer accounted for. Both now roll back. 3 unit tests. |
| NEP-245 Approval Management | **Built and tested.** 10 unit tests. Implemented because without it a key-less player could buy but never sell. |
| Minecraft plugin settlement path | **Built, and settled on public testnet from inside a Minecraft server.** `npm run mc:server -- --token player-1 --trade` boots a hash-pinned Paper 26.3 build 231 with a new plugin loaded, signs in from the server console, and sells iron: credit rose **0.0048768 → 0.0080768 NEAR**, exactly the bid the Ironmonger had posted two commands earlier, holdings fell 3 → 2, and the player's NEAR balance moved by **0** ([`H6HpWytt…`](https://testnet.nearblocks.io/txns/H6HpWyttACf9g1PE2HBZpzNLkEAwedFxzM1vY5EaZixt)). A later run did the **round trip** — `/sell` then `/buy` in one session — and the credit moved by exactly the merchant's spread (+0.0032 the bid, then −0.004 the ask), holdings ended where they started, and both NEAR deltas were 0 ([`4Dmr8LKk…`](https://testnet.nearblocks.io/txns/4Dmr8LKkJYtRYVAmg3RfxfJQoq6g9TeQp4SkaparWJPP), [`5pPhhd4h…`](https://testnet.nearblocks.io/txns/5pPhhd4h9H7wb3sv9bYM1C3TkrhbmiaW4wF9w1vGHhwE)). **And a real Minecraft player has now played it.** `npm run mc:bot` connects a headless client — a bot, not a person — which joins, signs in, buys iron and receives the ingot in a **real `PlayerInventory`** (0 → 1), then sells it back (1 → 0), paying no gas either way ([`CmbQGYwK…`](https://testnet.nearblocks.io/txns/CmbQGYwKpbg9knBCviGB1eoaoEJFJk4fnP9qNHySsWig), [`2Uz4KTr2…`](https://testnet.nearblocks.io/txns/2Uz4KTr2dnGSPc7LWfaySX6RCB9bXUqhHHuXRM7J6Msx)). At each step the chain and the inventory moved by **the same amount** — the first time the game and the ledger have been compared at all. 9 of 9 checks, retained in `evidence/live/minecraft-player.json`. The plugin is a client of the play service and **holds no keys, no signer and no chain code**; 7 in-game commands — including `/invest`, the `games` prompt's own closing sentence, and `/agent`, which sends a worker shopping on its own key and its own budget — 2110 lines of new Java, 211 Java checks offline. It is **not** a port of EthCraft's plugin and no line of it was copied — `check:docs` fails if any file under `minecraft/` carries that package name. **And the world is now one you can play in.** It generated a *default superflat* world — bedrock, two dirt, one grass — in survival mode, while the economy trades `iron_ingot`, `oak_log`, `stone`, `glass`, `coal`, `copper_ingot`, `oak_planks` and `redstone`: not one of the eight existed where a player spawned, so `GAME_LOOP.md`'s first core action — mine, chop or harvest — was impossible, and nothing noticed because nothing ever asked the world what was in it. `/nearcraft world-selftest` asks, and the answer went from **0 of 8 materials gatherable** on the flat world to **7 of 8** on ordinary terrain from a pinned seed (`glass` is the miss: spawn is inland and sand is a beach). `mc-server` gates its exit on it. What it still does not do is move blocks for a player who joined: there is no Minecraft account here, so the console and a headless bot drove it. [docs/MINECRAFT.md](docs/MINECRAFT.md) |
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
npm run keys      # every agent AND player key: receiver, method list, allowance, from the chain
npm run verify:deployed   # the code on chain hashes to the wasm this repo builds
npm run web       # the market page, reading those same contracts live in a browser
npm run play      # the same page, playable: sign in and trade (needs .local/ keys)
npm run mc:test   # the Minecraft plugin's Java checks, offline (needs a JDK)
npm run mc:server # Paper + the plugin, driven from its console (downloads 53 MiB)
npm run mc:up     # ONE command: brings everything up, proves it, tears it down
npm run mc:bot    # a headless client joins and plays the loop for real
npm run oidc:dev  # a local OIDC issuer, so the real login path can be driven
npm run play:oidc # the service against it: /api/health reports verifier "oidc"
npm run oidc:verify -- "<token>"   # verify a REAL provider token, print its account
```

**`npm run mc:up` is the one to run.** It pre-flights what can be known before
spending three minutes booting a server — JDK, disk, ports, the relayer's gas,
and whether the player's budget covers the run it is about to attempt — then
starts the OIDC issuer and the play service itself, boots Paper, proves the
loop, and tears down only what it started. `-- --oidc` for a real token through
a one-time code, `-- --keep` to leave the server joinable, and `-- --sandbox`
to run the whole thing against a **local node** with no balance ceiling at all,
where `deploy.mjs` builds the full-size economy (5 merchants, scale 1) instead
of the 1% one testnet can afford. A sandbox run is not a public-chain run and
nothing from it goes into `evidence/live/`.

The three scripts below still work on their own; `mc:up` just spawns them in the
right order with the right environment, which is what used to be the manual part.

**`npm run mc:server` is the same loop inside Minecraft.** It fetches a
hash-pinned Paper 26.3 build 231, builds and installs the plugin, boots the
server and runs the commands from the console. Add `--token player-1 --trade`
and it signs in and sells iron on public testnet. The plugin holds no keys: it
calls the same play service the browser does. [docs/MINECRAFT.md](docs/MINECRAFT.md)
has the transcript and the limits. `npm run mc:bot` goes further: a headless
client joins as a real player and the ingot lands in a real inventory. **No
human has played it** — there is no Minecraft account on this machine — and
every document here says "a headless client" rather than implying otherwise.

**`npm run play` is the whole loop in a browser.** Sign in with any string —
the account id is derived from the login, so the same identity always lands on
the same account — then buy and sell from the merchants, each beside the
contract's own reason for its price. The panel shows your NEAR balance before
and after every call, which is the gasless claim as a number on screen rather
than a sentence here. It is **custodial**: the server holds the player's scoped
key and submits for them, which is exactly what makes "no seed phrase" true,
and the key it holds cannot transfer NEAR, cannot add another key, and can call
only its named methods on one contract. `npm run web` serves the same page
read-only with no credentials at all, and the play panel simply does not appear.

**A login becomes a brand-new account, and that is now measured on the public
chain.** This section used to disclose the opposite: creating an account costs
0.107607 NEAR, the root account held 0.091081, so sign-in answered
`ROOT_UNDERFUNDED` and named the faucet, and the three-transaction bootstrap
had only ever run against a local node in `tests/near/gasless.mjs`. Root was
funded. `npm run live:onboard -- --seed player-3` then ran the real runtime path
— it spawns the service and posts to `/api/session` exactly as a browser does,
rather than calling the onboarding module directly:

1. [`2FNytLGE…`](https://testnet.nearblocks.io/txns/2FNytLGEDMPRBjrf5TsYZBsT1ZVWrMu8uCUKeDKmCbp5)
   created and funded [`p-62b0b243.nearcraftmc.testnet`](https://testnet.nearblocks.io/address/p-62b0b243.nearcraftmc.testnet)
   with a temporary full-access key.
2. The market was granted its NEP-245 pull rights over every sellable material
   **while that key still existed** — a player holding only a function-call key
   can never attach the deposit `mt_approve` needs, so the approval has to
   happen here or never.
3. [`6fe1RTHS…`](https://testnet.nearblocks.io/txns/6fe1RTHSf1sxH8LYRbC8ko3pQLgMF9feXZfBVn6S8f5t)
   installed the scoped key and **deleted the full-access one in the same
   transaction** — in that order, in one batch, or the account would lock itself
   out between the two.

Read back from the chain afterwards, not taken from the reply: **zero**
full-access keys, exactly one function-call key bound to the market granting
exactly the three methods `config/catalog.json` lists, and an approval over all
eight sellable materials. Root paid 0.107115 NEAR. The player paid nothing and
never saw a key, so there is no seed phrase to show — not by our restraint, but
because no full-access key for that account exists anywhere any more. Then
`npm run mc:up` played that account in Minecraft, 9 checks of 9. Both records
are in `evidence/live/`.

The first run of that script **reported a catastrophe that had not happened**:
one full-access key, no scoped key, no methods. It had read the account with
`finality: 'final'`, which lags `optimistic` by a block or two, immediately
after the third transaction — so it observed the account one transaction in the
past and was about to call a correct onboarding broken. The read now polls
until the chain settles, and returns what it last saw on timeout rather than
throwing, so a genuinely broken onboarding still fails. Same bug class as the
wait that did not wait.

One honest limit remains on the live deployment, and the service names it
rather than failing obscurely:

- The demo player's **spend budget is finite**, and this document used to say
  only the contract owner could top it up. **That was wrong.**
  `market.fund_credit` has no `assert_owner()` — `register_merchant` directly
  above it does — so it is **permissionless**: any account that can attach a
  deposit may fund any player's budget. That is deliberate, because an agent
  holding a function-call key cannot attach NEAR and so cannot fund itself.
  `npm run topup` uses it, signing with `worker-1` and keeping the gas headroom
  nearcore reserves; the budget now sits at 0.05 NEAR, about **62 round trips**
  at the merchant's spread, and when a run cannot afford itself `npm run mc:up` prints the `npm run topup` command and stops — it does **not** top up on its own, and this sentence used to say it did when a run
  cannot afford itself. When it does run out a buy comes back
  `502 INNER_CALL_FAILED` carrying the contract's own words — *"insufficient
  credit for this purchase"* — and selling pays credit back in. That is the
  economy working, not a bug, and it is why the panel shows credit beside
  balance.

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

**Solvency, checkable by anyone with no credentials.** The deployed market
answers `ledger_total()` — everything it owes, every merchant treasury plus
every credit balance — so the one property that matters for a contract holding
other people's money can be verified from outside:

```
ledger_total()                 0.897569 NEAR owed
market.nearcraftmc.testnet     3.389757 NEAR held      solvent
```

**And the code being audited is the code that is running.** `npm run
verify:deployed` hashes each local build and compares it to the `code_hash` the
chain reports, over public RPC with no credentials:

```
items    items.nearcraftmc.testnet        MATCH    GKsTsdXEsUJz1vQvrCgvRxkxHzvzwqzc78eiKLXyF1qM
market   market.nearcraftmc.testnet       MATCH    7KML46Pr78rCqEipQ1ch2tNkQ9ULfG6wtHg4PPuazBQJ
guard    guard.nearcraftmc.testnet        MATCH    3cbYjTpBugxCNZdHmJR4CM3D7mHThJWEoTVfvYMnNbRn
```

It exists because the first time it ran it **failed**: `items` was serving bytes
this repo does not build. The behaviour was right — the fix it was supposed to
carry was on chain — but no check here could have told the difference, and that
is the same bug class as a contract fix that silently never ships. It is now
green on all three after a redeploy.

**And you can rebuild those bytes yourself.** That used to be the limit here:
`npm run build:contracts` uses your local rustc and is not byte-stable, so a
hash match only ever meant "matches the artifact on *this* machine". The three
deployed contracts are now built with `cargo near build reproducible-wasm`,
inside a digest-pinned container, from a commit:

```sh
git checkout 46d812fb4d661ede3cdba1a92c81b8c3bbff313c
npm run build:reproducible      # needs Docker; ~3 min per contract
npm run verify:deployed
```

**The checkout is not optional, and the reason is worth knowing:** a
reproducible build embeds the commit hash *in the wasm* — `strings` will find it
— so the deployed bytes are pinned to exactly one commit. Rebuild the identical
contract source at a later commit and you get different bytes and a mismatch.
`npm run verify:deployed` prints the commit the chain names and the command to
use, so you do not have to find it here.

So the hashes above are a function of the committed source and nothing else. The
chain will tell you which commit and which container, because NEP-330
`build_info` is now populated where it used to read `null`:

```
build_environment      sourcescan/cargo-near:0.22.0-rust-1.99.1@sha256:c9655eaf…
source_code_snapshot   git+https://github.com/kaustubh76/NearCraft?rev=46d812fb…
build_command          cargo near build non-reproducible-wasm --locked
```

That is also what lets SourceScan and NearBlocks verify a contract, and it is
the strongest form of the `security` track's claim: the code you audited is the
code running, and you do not have to take our word for either half.

**A hash match alone is not that claim, which is why the commit is checked too.**
Comparing hashes answers "does the chain run the wasm on this disk?" — it says
nothing about whether that wasm was built from the source now in the repository.
Edit a contract, skip the rebuild, and all three hashes still matched; that was
demonstrated rather than feared. So `npm run verify:deployed` also asks each
contract which commit it was built from and compares that commit's build inputs
— `contracts/<name>/src`, its `Cargo.toml`, and the workspace manifest and
lockfile — against the working tree. Unchanged, it says so. Changed, it reports
**SOURCE MOVED** and exits non-zero, which is a different failure from DIFFERS
and gets a different explanation. It needs no rebuild, no credentials, and no
Docker.

This is also why `build_info` naming an earlier commit than `HEAD` is correct
rather than drift: the bytes are pinned to the commit that built them and should
not follow `HEAD`. The claim that matters is that the *contract source* has not
moved since then, and that is now checked on every run instead of asserted once.

`npm run build:contracts` is deliberately still the non-reproducible one, since
it needs no Docker — which is what keeps `npm test` working on a clean clone
with no credentials. The two therefore produce **different bytes from the same
source**, and `npm run verify:deployed` says so when it fails, rather than
leaving you to guess.

**And the deployed contract can be changed without losing anything.** Borsh
contract state is positional, so the moment code with an extra field lands over
existing state, every method *and every view* panics with "Cannot deserialize
the contract state" — including the view you would use to find out whether it
worked. A contract nobody can read is a contract nobody can fix, so until today
no state field could safely change.

`market` now has a `migrate` method, and it has been run on public testnet.
The cost-basis field went in with it, and nothing was lost:

```
ledger_total                 897569600000000000000000  ->  897569600000000000000000
ironmonger treasury          262569600000000000000000  ->  262569600000000000000000
player credit                 20000000000000000000000  ->   20000000000000000000000
items_contract            items.nearcraftmc.testnet   ->  items.nearcraftmc.testnet
```

Three things make that more than a hopeful anecdote:

- **Deploy and migrate are one transaction with two actions**, never two
  transactions. Actions in a single transaction also revert together, so a
  `migrate` that panics leaves the old code and the old state untouched. That is
  what makes it safe to try at all. `NEAR_MIGRATE=market npm run deploy`.
- **It was rehearsed against the bytes testnet was really running, not against a
  fresh build of them.** [contracts/integration/tests/migration.rs](contracts/integration/tests/migration.rs)
  deploys [contracts/integration/fixtures/market-live.wasm](contracts/integration/fixtures/market-live.wasm)
  — fetched from the chain with a public `view_code` call just before the
  migration superseded it, `code_hash` pinned in the test and re-checked after
  deploying — then **breaks the contract on purpose** with a plain redeploy,
  asserts every view really does fail, and only then rescues it. A migration
  test that never sees the failure it exists to prevent would pass on a
  migration that does nothing, which is why the fixture is not re-fetched after
  each migration: that would make fixture and build the same shape and quietly
  retire the test.
- **`migrate` is `#[private]`.** An un-private one would let anyone overwrite
  every treasury and every credit balance in a single call, which makes it the
  most dangerous signature in the project. `npm run check:nep245` pins both its
  modifiers off the compiled ABI, and the sandbox proves the refusal — near-sdk
  emits that check only in the wasm wrapper, so no unit test can reach it.

The honest limit: `migrate` carries the current shape and the one before it, and
nothing older. The `basis` map it adds comes through **empty**, because restocks
that happened before the migration spent money nobody recorded.

**So an investment is now a stake, not a donation.** `invest` records who put
money in; a sale attributes margin in `on_items_delivered`'s **Ok** branch; half
of it becomes the backer's withdrawable credit until the stake is repaid. On a
real node, a backer staking 3 NEAR into a restocked ironmonger earned 1.53 NEAR
back from a single sale of 8 iron.

Four decisions in it are worth more than the feature:

- **Margin, not revenue.** The tempting rule is `margin = paid × 20%`, the
  merchant's spread. It is wrong in a way that costs the investor money: a
  merchant that restocked a thin shelf at a scarcity price and then sold into a
  glut made a **loss**, and that rule would pay the backer out of its own
  principal. `pricing.rs` uses weighted-average cost basis and saturates at
  zero, so a loss pays nothing. The first of its seven tests is that case.
- **A player selling into a merchant is an acquisition too.** Cost basis that
  counted only restocks would make every resale look like pure margin, so both
  sell paths — the pull and the push — record what the merchant paid.
- **Nothing to unwind.** Margin is attributed only once delivery has succeeded,
  so a failed delivery never attributed any. That also avoids adding an argument
  to an existing `#[private]` callback, which would break any receipt already in
  flight and take the rollback that refunds a player with it.
- **`withdraw_treasury` is refused while a stake is open.** The principal lands
  in the treasury, so without that guard a merchant could simply cash out the
  money it was just lent.
- **A backer can be bought out, and that is a fix, not a feature.** One backer
  per merchant keeps the payout O(1) inside a callback — but the first version
  meant **one yoctoNEAR claimed the slot and locked everyone else out** until the
  merchant happened to make a sale. That is cheap enough to be free, and it
  denies the exact mechanic `invest` exists for: a shop nobody can rescue. So a
  newcomer takes the slot by covering the incumbent's outstanding claim in full
  — the incumbent gets back everything it was owed and nothing is taken from it,
  only the remainder becomes working capital, and squatting now costs the
  squatter their stake and buys them nothing.

And the limit, stated because it is the honest answer: a backer whose shop never
trades again does not get its money back. `invest` refuses a merchant with no
shelves at all, so the one case where repayment was impossible from the start is
blocked — but after that, the risk is real. That is what investing is.

One consequence of the gasless design worth naming: **a player's key is
immutable for life.** Onboarding deletes the bootstrap full-access key in the
same transaction that installs the scoped one, and a function-call key cannot add
keys. So `p-1d6a3c5d`, onboarded before this existed, carries
`[buy_with_credit, sell]` and can **never** be given `invest_with_credit`. New
players get all three. The security property that makes a player safe is the same
property that freezes what they can do.

**And the prompt's own sentence, on the public chain.** The `games` prompt ends
its description with "it closes its shop until someone invests in it". Chandler
withdrew its spare treasury down to its floor, reported closed, and an
investment reopened it:

```
1. withdraw_treasury  ->  treasury 0.005000 = floor 0.005000   closed? true
   8P6DQLSJzxTZq2TJGUGstDhKGQYJ4M2bworn3JWw4pmc

2. invest 0.01 NEAR   ->  treasury 0.015000                    closed? false
   AvTEkD3Hm9DkF4uVKwPzJxKujm1usNnFTmdmY548XhLz
```

Retained in `evidence/live/`. Nine on-chain transactions are now indexed there.

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

What is left is not code, and it is now one step narrower than this paragraph
used to claim. It said nobody had configured a real provider's client id. **That
is no longer true**: a Google client id sits in gitignored `.local/oidc.json`,
`/api/health` reports `verifier: "oidc"`, and `tests/near/oidc-runtime.mjs`
drives the real verifier over a real HTTP JWKS inside the real service. What
remains is that **no token Google itself issued has been verified**, because
obtaining one needs a browser and a consent screen. `npm run oidc:verify` takes
a pasted `id_token` and settles it against Google's live JWKS in one command;
until someone runs it, that sentence stands.

**On the Minecraft integration,** with two earlier statements of our own
corrected rather than quietly edited.

*The first correction.* This README said **"this machine has no Java runtime at
all"**, and used that to explain why no Minecraft code was written. It was
wrong. Homebrew's `openjdk@11` was installed the whole time, merely unlinked, so
`/usr/bin/java` fell through to the macOS stub that prints "Unable to locate a
Java Runtime". The obstacle was a PATH entry. One `brew install openjdk@25`
later there is a plugin, and `docs/MINECRAFT.md` is the write-up.

*The second correction stands.* An earlier version estimated repointing
EthCraft's plugin at NEAR as "about six edit sites in one file". Six is the GUI
side. The validation itself, `InventoryMarketplace.gameOrder`, enforces
`chainId == 1301`, an 18-decimal `totalBaseUnits` cross-check, a
`0x[a-fA-F0-9]{40}` address, Privy consent nonces and a ten-state order machine
— all EVM-shaped. Repointing it is a rewrite of the order flow, not an edit
pass, and that is still true. So it was **not** repointed. What exists instead
is a new, small plugin in `minecraft/` that settles through the play service,
and EthCraft's 5,201 lines of world, menus, escrow, item delivery, voice and
property protection **remain unported**.

**That includes the world itself, and this README used to claim otherwise.** Its
first line read "a Minecraft recreation of South Mumbai" for the whole project.
There is no such geometry here — no region file, no schematic, no world
download, nothing in the repository and nothing fetched. EthCraft's Mumbai world
is EthCraft's, and like its menus and its escrow it is not ported. What this
project boots is a generated world from a pinned seed, and
`/nearcraft world-selftest` says what is in it. The sentence is corrected rather
than footnoted, because a headline a judge can disprove by booting the thing is
worse than no headline.

**What is now demonstrated, and what is still not.** A Paper server boots with
the plugin, reads live merchant quotes with the contract's own reason strings,
signs a player in, and settles trades on public testnet with the player's NEAR
balance moving by exactly zero. A **headless client** then joins as a real
player, and the iron it buys arrives in a real `PlayerInventory` — so the half
of the loop a console cannot reach is exercised too.

**No human has played it.** There is no Minecraft account on this machine, so
the player is a bot: mineflayer speaking a pinned protocol. It is a real
protocol client with a real server-side player entity, which is exactly what was
missing, and it is not a person. The bot fixture also runs `online-mode=false`,
because a headless client has no Mojang account to authenticate — that applies to
`npm run mc:bot` alone, in its own directory; `npm run mc:server` keeps
`online-mode=true`. The `games` track is
entered on what is actually demonstrated: NEP-245 materials, one readable price
rule, merchant reasoning the contract itself produces, a measured key-less buy
and sell, a real testnet transaction, a full economy run anyone can reproduce,
and now a settlement that starts at a Minecraft server console.

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

## The NEAR audit — what it found, and what is still open

The contracts and the backend were audited against NEAR protocol semantics and
the NEP specifications read from the NEPs repository, in two rounds.

The first round found two money bugs and a trust bug. The second round went
back over what the first had disclosed rather than fixed, and found that **the
headline money bug had the same shape in three places, not one** — and that one
of those three had not been found at all. It also found one disclosure that was
simply wrong: the buy side was written up as unfixable without new state and a
migration, and it was fixable the same way the sell side had been.

Everything below is proved by a test written to fail first. What is still open
is listed after, because it is not fixed.

**Fixed, and the tests that catch them again**

| | |
|---|---|
| The conformance gate could not see a signature | `npm run check:nep245` read method names and modifiers off the compiled ABI and nothing else — so a contract taking entirely the wrong arguments passed it, and this README said so in its own open list. The ABI had carried parameter names, types, the view/call kind and return types all along. It now checks **54 signature facts across all 18 NEP-245 methods** against a table transcribed from the NEPs repository, and it was made to fail five ways first: a renamed parameter, a changed type, a view turned into a call, a changed return type, and a declared deviation that no longer matches. |
| An approval id was a number in and a string out | What the gate found the moment it could see. `mt_transfer` takes an approval id as a plain number, matching the spec — but `mt_is_approved` took `Vec<U64>`, which is a **string**, so a spec-conformant client sending `[1]` failed deserialization. The input side is now `u64` in both. `Approval.approval_id` stays a string on the way **out**, declared rather than changed: a u64 above 2^53 cannot survive a JSON number in a JavaScript client, which is why near-sdk has `U64` at all. Conformant where the spec can be met safely, declared where it cannot. |
| `restock` could pin a merchant closed forever | It is permissionless, and when the merchant could not afford the full gap it bought whatever its spare cash allowed — leaving the shelf under the trigger, so the trigger stayed **armed** with the treasury now at its floor. Not a loop inside one block, a ratchet across time: every yocto the merchant earned above one unit's cost could be converted to shelf stock by anyone the moment it landed, so spare never climbed back above `buy_price`, `is_closed` kept reporting closed, and the merchant refused every player trying to sell to it. Money was conserved throughout; availability was not. A restock must now clear `RESTOCK_TRIGGER_STOCK` or be refused, so a poor merchant keeps its cash, goes on earning from players who buy from it, and restocks when it can actually refill the shelf — or is rescued by `invest`, which is the recovery path the game already describes. I had written this off as "a policy decision, not a bug fix"; it is twelve lines. |
| The session id travelled in a query string | It can buy, sell and invest on the player's behalf, and a URL is written into the access log of every server and proxy it crosses — as well as browser history and any `Referer`. It is a bearer token in an `Authorization` header now, in the browser, the bot and the Minecraft plugin. The server **deletes** `sessionId` from the query rather than also accepting it: leaving the old path working would have made the change cosmetic. Proved against a running server — the query form answers `NO_SESSION` ("sign in first", the id never arrived) while the header form answers `SESSION_UNKNOWN` (it arrived and was looked up). Two different codes, so the two paths are distinguishable rather than taken on trust. |
| A deviation now has to be declared | Two deviations from NEP-245 remain, and each must now name its exact before and after in `DECLARED_DEVIATIONS` or the build fails. A declaration that stops matching fails too — otherwise the list becomes a graveyard of excuses for problems that no longer exist, still quietly excusing the next one. |
| The same money bug was in three places | `sell` was fixed in round one. `buy`/`settle_purchase` and `restock` were not, and **`restock` had not been found at all**. All three credited somebody before a cross-contract call and clawed it back with `saturating_sub` if the call failed, while restoring the other side in full — so spending inside the window left `ledger_total` above the NEAR held. All three now pay on the callback. Three interleaved tests, each red first: a treasury emptied by `withdraw_treasury` between a purchase and its failed delivery, the same on the credit path, and the house withdrawing between a restock and its failed mint. |
| A disclosure that was wrong | This README said the buy side "cannot be fixed the way `sell` was" and needed "reserving in-flight funds, which needs new state and therefore a migration". That was wrong. `withdraw_treasury` can only pay out what is **in** the treasury, so money never put there cannot leave: not crediting until the goods arrive **is** the reservation. No new field, no migration. A gap written down is still only a claim. |
| `verifyKeyScope` was never called | It asks the chain whether the agent's key really is as narrow as the agent believes, and **nothing invoked it** — the definition, the export, and a comment leaning on it. It runs on both signing paths now. The human-approval path re-reads the chain rather than a memo, because a key's permission *can* widen in place (`DeleteKey` then `AddKey` on the same public key) and a parked call waits on a person for an unbounded time. Against the memo that check could not fail; the first version of it was exactly that, and the test caught it. |
| Two relays for one player collided | The delegate nonce belongs to the **player**, not the relayer. Two calls built before either landed signed the same nonce and nearcore rejected the second — `Invalid delegate nonce (ak: 41000001, delegate: 41000001)`, measured in the sandbox. Reachable from the product: Minecraft and the web page both let a player act twice quickly. Relays are queued per player now, across sign **and** submit, since the nonce only advances on inclusion. |
| A half-finished sign-in stranded an identity forever | `signIn` is three transactions and the bootstrap full-access key was a local `const`. A failure at step 2 lost it while it was still installed — leaving an account that exists, holds a live full-access key nobody holds, and sends every later login down the `created: false` branch with no key to return. A permanent 503 for that player, and the state `npm run keys` reports as FAIL. The key is parked before the account is created and dropped once it is dead on chain, and the next sign-in finishes the job. Opt-in, so the players onboarded before it behave exactly as they did. |
| A short answer from a receiver forfeited materials | `mt_on_transfer` returns one unused figure per token. An over-long answer was clamped; a **short** one was read as "the receiver kept everything". It refunds now. The market always returns one entry per token, so nothing on the live path changes — this hardens against a third-party receiver. |
| The approvals vector was unbounded | Every transfer on a (material, owner) pair deserializes it, so it was a balance that could eventually not move. Bounded at 64, the way `guard` already bounds its per-subject reports. Only the owner can grow their own list, so it was self-inflicted rather than a way to attack anyone else — and the comment says so rather than overstating it. |
| Two counts in this README had rotted | One row said five of the six NEP-245 Approval Management methods were present and another said six of six, and `market` was described as emitting twelve `env::log_str` lines where there were thirteen. Both are derived from source now. The first version of that check looked for the count written against a literal six, so it did not match the stale row **at all** and passed — a check whose pattern encodes the expected answer cannot report an unexpected one. It reads both numbers now, and every occurrence rather than the first, since two rows disagreeing was the actual defect. It then caught this very row quoting the stale figures as examples, and they are spelled out in words above for exactly that reason. |
| `market.sell` created money | It credited the seller **before** pulling the materials, then unwound asymmetrically: treasury restored in full and unconditionally, credit clawed back with `saturating_sub`. Spend the credit inside that window and the clamp absorbed the shortfall. Free to trigger — `approval_id` came straight from the caller and was never validated, so a garbage id failed the pull every time from a scoped key with the relayer paying. The seller is now credited only once the materials arrive. `a_failed_pull_must_not_restore_a_treasury_it_cannot_debit` creates 6.4 NEAR out of nothing against the old ordering. |
| A rolled-back purchase bought trust | `backend/near/signer.mjs` called `callFunctionRaw` and never read `receipts_outcome`. near-api-js throws only on the **top-level** status, which stays `SuccessValue` when a contract absorbs its own failure — so a purchase the contract rolled back was logged `settled`, and `counterparty.recordSuccess` incremented the counter governing `INTERACTIONS_FOR_TRUST`. The check now lives in `backend/near/outcome.mjs` and **both** signing paths import it. |
| That check had never seen a receipt | `grep innerFailure` returned three lines: the definition, its loop, its one call site. The test that looked like coverage stubs the whole relayer. `tests/near/gasless.mjs` now relays a call whose inner action panics on a real node and asserts the contract's own words survive the walk. |
| `mt_token_approvals` did not exist | The sixth Approval Management method. `npm run check:nep245` reported "5/5" because its own required-method list was missing it too — the implementation was its own denominator. |
| NEP-330 understated the contract | `#[near]` emits `nep330` alone, so the chain reported one standard for a contract implementing NEP-245 and emitting NEP-297 events. It declares all three now. |
| 32-bit account ids | A derivation collision made the second identity inherit the first player's custodial key. 64 bits now, which also brought `ACCOUNT_ID_TOO_LONG` to life — at 32 bits it was unreachable. |
| Two vacuous assertions | `assert!(x.contains(r#""old_owner_id":"alice""#) || x.contains("old_owner_id"))` — the right disjunct subsumes the left, so both passed for the wrong owner. |

**Open, and disclosed rather than fixed.** Each is a real finding with a file
and a line; none of them is claimed to be harmless.

- **No NEP-145.** `fund_credit` creates a permanent entry for any account id for
  a yoctoNEAR, and `mt_transfer` the same for any receiver. The approvals vector
  is bounded now, but there is still no storage-management standard and no way
  to reclaim a deposit.
- **A refused transfer burns approval allowance.** `mt_resolve_transfer` refunds the tokens
  but not the approval allowance a refused transfer consumed, so a refused
  transfer silently burns allowance. Reachability was checked rather than
  assumed: `market.sell` pulls with plain `mt_transfer`, which has no refund
  callback, and the push path carries no approval — so the combination needs a
  third party calling `mt_transfer_call` under an approval. **Not fixed, with a
  reason:** restoring the allowance means telling the resolver which approval
  was spent, and that is a new argument on a `#[private]` callback. Any
  `mt_resolve_transfer` receipt already in flight at the moment of deploy would
  then fail to deserialize — and that receipt *is* the refund a player is owed.
  The wrong change to make on a live deployment.
- **`mt_is_approved` takes a required fifth `owner_id`**, so a spec-conformant
  client fails deserialization — **deliberately not changed**: the spec's
  four-argument signature gives no way to say whose approval is being checked,
  our approvals are keyed by `(owner, approved, token)`, and `Option<AccountId>`
  would need a default the NEP does not define. Guessing at semantics the
  standard does not state is worse than a documented deviation.
- **`npm run check:nep245` still cannot see semantics.** It now reads
  signatures — 54 facts across all 18 methods — so it will catch a renamed
  parameter, a changed type, a view turned into a call or a changed return
  type. What it cannot see is whether the number coming back is the right
  number. `mt_balance_of` returning a correctly-typed lie passes it. Semantics
  rest on the unit tests, and that is a real limit, not a formality.
- **`market`'s NEP-297 events are in source and not on chain.** The deployed
  build predates them, so the money leg of a trade is still invisible to an
  indexer today: nothing on chain names the merchant, the price or the margin.
  `npm run verify:deployed` reports three `DIFFERS` rather than hiding it. The
  redeploy is built, rehearsed against the real deployed bytes, and not run.
- **And they do not make `market` NEP-245 conformant**, nor are they meant to.
  It is not a multi-token contract, has no `mt_` methods and claims none; the
  events are its own standard, `nearcraft_market` version `1.0.0`, spanning
  10 kinds of NEP-297 event. An indexer has to be told that name — nothing
  would tell it.
- **An audit is not a proof of correctness.** The second round found three
  things the first one missed, including a money bug in a function the first
  round had read. There is no reason to believe a third would find nothing.

## Open it without cloning

| | | |
|---|---|---|
| the market page | <https://nearcraft.vercel.app> | Vercel. No keys, no API, nothing to sign with. |
| the play API | <https://nearcraft-play.onrender.com/api/health> | Render. Custodial, and holds two keys. |

`npm run check:hosted` checks both from outside, over the network. It is **not**
part of `npm test`, for the same reason `npm run verify:deployed` is not: the
suite has to pass offline from a clean clone.

**The page is the read-only one.** It is staged by `npm run deploy:vercel`, which
copies the allowlist `scripts/serve-web.mjs` serves — `web/`, `backend/`,
`deployment.json` — into an empty directory and uploads that. Not an ignore
file: `.local/` holds the deploying account's key *and* the three contract
accounts' keys, and a deny list is correct only until someone adds a path it
does not mention. Nothing outside the allowlist is on disk at upload time, and
`check:hosted` then tries eight paths that must not be reachable and fails if
any of them answers.

**The hosted play service cannot create accounts, and that is the point.** The
seeded login accepts *any string* as an identity and funds a new account from
the root account, with no rate limit on `/api/session`. A public instance that
could onboard would therefore be a faucet anyone could empty in a shell loop —
taking the funded merchants and the live demo with it. So the root key is simply
not there:

```sh
curl -s https://nearcraft-play.onrender.com/api/health
# ... "canOnboard": false, "custodial": true ...
```

`/api/health` reporting `canOnboard: false` is that absence, visible. An unknown
identity gets `ONBOARDING_MISCONFIGURED` — a refusal the service already had,
and `check:hosted` proves it by sending a random identity and checking that
nothing was created. **Absent beats guarded:** there is no key to spend, so
there is nothing to get past.

It holds exactly two keys, built by `npm run secret:render`: the relayer's
(full-access, because a `SignedDelegate` is not a function call, so it pays gas
for everyone) and **one** player's scoped key — one contract, three methods, no
transfer, no `AddKey`. No agent keys either, so `/api/agent` refuses there and
`/api/health` reports `agents: []` rather than offering a command that cannot
work; `npm run check:hosted` asserts that no worker's key ever reached the host. Withheld: the root account, the `items`/`market`/`guard`
contract accounts, every merchant and every agent. The local key file has
sixteen entries and three of them can redeploy this economy; those do not leave
the deploying machine. `npm run secret:render` refuses to put them in the file.

**Still open, and not dressed up.** The hosted service is *unauthenticated for
the one player it can sign for*: anyone who opens the page can sign in as that
player and trade with its testnet credit, and each call spends the relayer's
gas. The protocol bounds it — the key reaches one contract and three methods and
is re-read from the chain on every `/api/me` — but it is not a gate, and
[docs/MINECRAFT.md](docs/MINECRAFT.md) keeps saying so. Closing it properly is a
per-IP limit plus a shared secret, which is not built.

Two operational facts worth knowing before you click. The service runs on
Render's free tier, which spins down after fifteen idle minutes and takes about
a minute to wake — **a slow first request is the free tier, not a hang.** And it
runs as a single instance deliberately: `backend/near/relayer.mjs` serialises
sign-and-submit per player in an in-process map, because a delegate nonce is
read from the chain and signed as nonce+1, so a second instance reintroduces a
failure this project has already measured.

## Verify it yourself

**Rehearsed the way you will meet it, twice, and it failed both times.**

On 12 November 2026 this repository was cloned fresh from GitHub into an empty
directory — no `.local/`, no `node_modules`, no build cache — and every command
below was run against that clone. It found a real failure on the first one:
`npm test` exited 1, because a documentation check added hours earlier flagged
the gitignored `.local/` directory as missing. Fixed, re-cloned, re-run.

**On 14 November it was done again, because twenty-five files had changed since,
and `npm test` exited 1 again — five times over, on `.local/oidc.json`.** The
same defect one level deeper: the fix in November had taught the *directory*
rule to skip gitignored paths, and the *file* rule never consulted it, so a
gitignored file named in three documents still had to exist. It passed on the
machine that wrote the documents only because that untracked file was sitting
there. Green because of something not in the repository is the trap this whole
section exists to catch, and it caught it. `npm run sim` failed on the same
clone too: it is documented under *"what a judge can watch in sixty seconds"*
with no mention of the build it needs. Both fixed, both now policed by
`npm run check:docs`, and re-cloned from the fix to confirm — `npm install`
with no engine warning, then `npm install && npm test` — 183 checks on the day of the rehearsal, more now, and the
point is that the number comes from the run rather than from this sentence,
which is exactly why this sentence no longer carries one. `npm run reads` and `npm run keys` work with
no credentials, `npm run check:nep245` without a build says
`ABI not found — run npm run build:contracts first`, `npm run evidence` records
its **skips** rather than pretending — the wasm-dependent and JDK-dependent
topics among its eighteen, and the run prints the split rather than this
sentence, which carried `6 pass and 6 skipped` for a week after there were
twelve — and `npm run build:contracts` compiles from the cloned sources.
`.gitignore` excludes credentials, `node_modules/`, build output **and**
`.tmp/` with `*.jar` — the whole Minecraft runtime, which is fetched and
hash-verified from `config/minecraft-runtime.json` rather than vendored. So a
clone has every input it does not download.

### Runs today, no credentials, and offline once installed

```sh
npm install
npm test
```

Needs Rust and Node 22.22.2+, nothing else — not even the wasm target, because
near-sdk unit tests build for the host. All three checks pass right now:

```sh
npm run test:contracts    # the Rust unit tests across all three contracts
npm run test:near         # policy, injection, counterparty, market, web, OIDC
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
Enumeration 2 are present, that Approval Management's 6 are present and
payable, that Metadata is absent as documented, and that the modifiers carrying security meaning are right —
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
do not exercise any Minecraft gameplay. Two of them — the topics named
`live-testnet-*` — **are** credential-free reads of the deployed contracts on
public NEAR testnet, which this paragraph denied for a week while
`SUMMARY.json` said so in the same breath.

### The economy, running

```sh
npm run build:contracts && npm run sim
```

The build first: the simulation deploys the real wasm to a real nearcore node,
and wasm is gitignored build output. A clean clone running `npm run sim` alone
fails with `Build first: npm run build:contracts` — the test names its own fix,
and this block used not to.

Twenty buyers across six scripted strategies, five merchants, four materials
over eight shelves, eight rounds, **no model calls** — plain arithmetic, so what
is being tested is the market and not a language model's taste. A run, in about
26 seconds:

```
round   trades   sales   refused   restocks     volume    closed  cheapest iron / oak
    1       12       3         8          0     10.070         0  0.448 / 0.084
    3       16       3         3          0     29.852         0  0.506 / 0.100
    6       17       5         0          0     62.457         1  0.592 / 0.100
    8       10       4         0          0     82.590         1  0.614 / 0.100
110 purchases, 25 sell-backs, 0 merchant restocks, 17 refused on a stale quote,
82.590 NEAR of volume, 1 merchant(s) closed (first in round 6), in 26.4s of wall clock

bargain   x4  spent    3.252  earned    0.571  holding   48 units
dumper    x3  spent   18.557  earned   19.471  holding    0 units
greedy    x4  spent   25.286  earned    4.172  holding  120 units
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
transactions on a real nearcore node in 26.4 seconds — 5.1 trades per second.**
Measured three times, 25.8s / 26.4s / 27.0s, because one sample of a wall clock
is not a measurement.

**That rate has come down, and the cost is ours rather than the chain's.** It
was 5.7 a second — 23.7s for the identical 135 transactions — before cost basis
and the margin split went in. Those added state writes to the hottest path in
the contract: every purchase now also consumes the sold goods' basis, and may
pay a backer out of the treasury. **Roughly 11% slower, which is outside the
spread above**, so it is a real cost and not noise. Worth saying plainly, since
the feature that bought it is the one that makes an investment a stake rather
than a donation.

The concurrency gain that got the rate here in the first place was 4.7× when it
was measured, and came from running each buyer's turn concurrently rather than
serially, plus dropping `max_gas()`. Prepaid gas is
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
a week**. At the measured 5.1 trades per second that is **roughly five and a
half minutes, not one**.

**A correction to the reason this file used to give.** It said the shortfall was
because "merchants do not restock", and that restocking was the missing piece.
Merchants now restock — permissionlessly, out of their own treasuries — and it
changed the figure by nothing, because that was never the binding constraint.
Measured, and re-measured since: across eight rounds the simulation pokes every
one of its **eight** shelves after every round — 64 pokes — and performs
**zero** restocks, because no shelf ever falls below the trigger of 32 units.
The fixture's shelves start at 64 to 2048. (This file, and the comment in
`simulation.rs` it was copied from, both said 25 shelves. Neither had counted:
the fixture has four materials across eight shelves, and 25 is what you get from
imagining five merchants times five materials.)

Trades fall from 17 a round to 10 for a different reason, which the run shows
plainly: the *price* rises. Iron goes 0.448 to 0.614 NEAR as the demand
multiplier climbs, and the bargain-hunting strategies stop buying once the unit
price passes base. That is the price rule working, not the market running out of
goods — and no amount of restocking addresses it.

So: a week of trading in about five and a half minutes, under a stated
definition, and the limit is throughput rather than stock. **Still not a week in
a minute**, and now slightly further from it than before, because we chose a
correct margin split over a faster one. We would rather print the rate we
measured, three times, than round it up.

### Needs a live testnet deployment (the bonus, not the proof)

```sh
npm run deploy    # idempotent; needs NEAR_ROOT_KEY
npm run reads     # every merchant's price, bid, stock band and reason
npm run keys      # reads method_names + allowance back from the chain, agents and players
```

---

## How the tracks are addressed

| Track | How |
|---|---|
| **`games`** | Requirement by requirement, with the gaps named. **(1)** Materials as NEP-245 multi-tokens, one contract holding every item type — core 10/10, Enumeration 2/2, Approval Management 6/6, read off the compiled ABI. **(2)** No seed phrase, no wallet popup, no gas prompt: **measured on public testnet**, a player holding no full-access key buys and sells while its balance moves by exactly 0. Identity verification is real and now runs where it counts: a **Google OAuth client id is configured**, `/api/health` reports `verifier: "oidc"`, and a genuine RS256 token is verified against the issuer's **live JWKS over HTTPS** by the running service ([`oidc.mjs`](backend/near/oidc.mjs), 25 offline tests plus [`oidc-runtime.mjs`](tests/near/oidc-runtime.mjs), which drives the real verifier over a real HTTP JWKS inside the real service and asserts fifteen refusals by code). What is still missing is narrow and named: **no token Google itself issued has been through it**, because obtaining one needs a browser and a consent screen — `npm run oidc:verify -- "<token>"` closes that in one command. A real login also cannot reach the game: a Google id token is **977 characters** and Minecraft carries **256**, so the browser mints a single-use eight-character code and `/nearcraft claim <code>` is what a player types. **(3)** The price rule in one readable file, [`pricing.rs`](contracts/market/src/pricing.rs), and the merchant's own reason string rendered beside every quote — on the live web page today; **the in-game tooltip needs the Minecraft host, which is not up**. **(4)** Fast-forward: 135 real transactions in 26.4s, 5.1 a second, measured three times. **That is still not "a week in a minute"** — and it got 11% slower when cost basis and the margin split went in, which is reported rather than quietly re-measured away — the arithmetic is worked out above, and the limit turned out to be throughput rather than stock. Plus the two things the prompt's own description asks for: a broke merchant **reopens when someone invests in it** (shown on chain), and merchants **restock themselves**, so the economy evolves without a dev patch. The loop is specified in [GAME_LOOP.md](GAME_LOOP.md), written before any code. |
| **`security`** | All three requirements. **(1)** A counterparty check returning `allow`/`warn`/`block` with reasons, scoring the four named signals — account activity, is-a-contract and code-changed, prior interactions, and an on-chain shared blocklist other agents report to with evidence. The wrapper refuses to sign on `block` and **parks the call for a human on `warn`**. **(2)** Agents sign with a function-call access key scoped to one contract with an explicit method list and allowance, never a full-access key — its limits are explained below, proved at the protocol level in the sandbox, and read back off the live chain by `npm run keys`. The agent *account* does also carry an operator key, which that command discloses and counts; the section below says exactly who holds it and why players are treated differently. **(3)** The attack demo: a prompt-injected agent tries to pay a known-bad account, is stopped, and the log is printed. Signals and their data sources are written up in [docs/SECURITY_SIGNALS.md](docs/SECURITY_SIGNALS.md), which was written before the code, as the prompt asks. **Beyond the three:** the deployed contracts are built reproducibly, so `npm run verify:deployed` lets anyone confirm that the code running on testnet is the code in this repository at a named commit — the premise every other security claim here rests on, and one we were asserting rather than proving until it was checked and `items` turned out to be running bytes this repo does not build. |

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
└── near/       new: function-call-key signer, policy refusal, market/items wrappers, relayer, play service

minecraft/      new: a small Paper plugin that settles through the play service.
                Holds no keys and no chain code. NOT a port of EthCraft's plugin
                and shares no code with it — check:docs enforces that.

contracts/integration/tests/
                a real local nearcore node: access-key limits, the cross-contract
                economy, and the scripted no-model-calls simulation
```

There is no `plugin/` directory, and that is not an oversight: EthCraft's
plugin lives in a directory of that name and **none of it is vendored or
ported**. The Minecraft code here is new, in `minecraft/`, deliberately under a
different name so the two cannot be confused. See the note above for what it
settles and what it still does not do.

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

That audit covered only agents until it was widened, which meant the one account
in the deployment holding **no** full-access key — the player, the strongest key
claim here — was the one account it never looked at. It now reads every player's
keys back too, and compares the recorded method list against the chain in both
directions. On the live deployment that check failed immediately:
`deployment.json` advertised `invest_with_credit` on a key that does not grant
it and can never be given it. The prose in this file was right; the JSON beside
it was not, and only the JSON was machine-readable.

The player's account id is not a name someone chose. It is derived from the
login — `p-<first 8 hex of sha256("provider:subject")>` — so the same identity
always lands on the same account and no mapping table is needed. `p-1d6a3c5d`
is `seed:player-1`, the demo identity. See [docs/GASLESS.md](docs/GASLESS.md);
verifying the identity token is implemented in [`backend/near/oidc.mjs`](backend/near/oidc.mjs) and is now configured against a real Google client id in gitignored `.local/oidc.json`. What the demo lacks is one step narrower than before: a token **Google itself signed** has not been verified, because getting one needs a browser and a consent screen. `npm run oidc:verify -- "<token>"` does it in one command against Google's live JWKS and prints the NEAR account that login owns.

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
