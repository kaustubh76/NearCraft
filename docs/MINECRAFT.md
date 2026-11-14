# The Minecraft settlement path

For most of this project's life the `games` track rested on a gap. The premise
is an agent economy *inside Minecraft*, and the README said, in eight places,
that the Minecraft half was not built. Part of that disclosure was also wrong:
it said this machine had no Java runtime at all. It had one — Homebrew's
`openjdk@11`, installed but unlinked, so `/usr/bin/java` fell through to the
macOS stub that prints "Unable to locate a Java Runtime" and exits non-zero.
The obstacle was a PATH entry, and the documentation had been overstating it.

This is what is there now.

## What it is, in one run

```sh
npm run play                                   # the service that holds the key
npm run mc:server -- --token player-3 --trade  # Paper, the plugin, a real trade
```

That second command fetches a hash-pinned Paper 26.3 build 231, writes
`eula=true`, boots the server with the plugin installed, and drives it from the
console. The log it keeps is the claim:

```
[NearCraft] settling through http://127.0.0.1:8080 - this plugin holds no keys
> nearcraft selftest
  health  200 testnet via https://test.rpc.fastnear.com
  iron_ingot - 2 merchant(s)
    Ironmonger (ironmonger)  asks 0.004  bids 0.0032  stock 253  buying
      Ironmonger holds 253 (normally stocked); demand is quiet.
    Stonecutter (stonecutter)  asks 0.006  bids 0.0048  stock 64  buying
> nearcraft link player-3
  signed in as p-1d6a3c5d.nearcraftmc.testnet
    verifier seed   key may call buy_with_credit, sell
    full-access keys on your account: 0 - nothing can transfer your NEAR or
    add a key, not even this server
> wallet
  credit 0.0048768 NEAR of spend budget
  holds  3 iron_ingot
> sell ironmonger iron_ingot 1
  settled on NEAR with Ironmonger (ironmonger)  tx H6HpWyttACf9g1PE2HBZpzNLkEAwedFxzM1vY5EaZixt
  your NEAR balance moved by 0 - the relayer paid the gas
> wallet
  credit 0.0080768 NEAR of spend budget
  holds  2 iron_ingot
```

Credit rose by **0.0032**, which is exactly the bid the Ironmonger posted two
commands earlier. Holdings fell by exactly one. The player's NEAR balance moved
by **zero**. That transaction is on public testnet:
[`H6HpWytt…`](https://testnet.nearblocks.io/txns/H6HpWyttACf9g1PE2HBZpzNLkEAwedFxzM1vY5EaZixt).

### The round trip

`--sell ironmonger:iron_ingot:1 --buy ironmonger:iron_ingot:1` runs both halves
in one boot, and the arithmetic closes:

| | credit | holds | NEAR delta |
|---|---|---|---|
| before | 0.0104768 | 1 iron_ingot | — |
| after `/sell` | 0.0136768 (**+0.0032**, the bid) | nothing | 0 |
| after `/buy` | 0.0096768 (**−0.004**, the ask) | 1 iron_ingot | 0 |

The player ended holding what they started with, 0.0008 NEAR of credit lighter —
the merchant's spread, which is the whole point of the price rule — and paid no
gas either way. Both transactions are retained in
`evidence/live/minecraft-4Dmr8LKk….json` along with the console transcript they
came from: [`4Dmr8LKk…`](https://testnet.nearblocks.io/txns/4Dmr8LKkJYtRYVAmg3RfxfJQoq6g9TeQp4SkaparWJPP)
and [`5pPhhd4h…`](https://testnet.nearblocks.io/txns/5pPhhd4h9H7wb3sv9bYM1C3TkrhbmiaW4wF9w1vGHhwE).

## A real player, and what it took

`npm run mc:bot` connects a **headless client** — mineflayer, pinned — which
joins the server as an ordinary player and plays the loop:

```
ok    a headless client joined the server            as nearcraft_bot, protocol 1.21.11
ok    the player signed in from inside the game      signed in as p-1d6a3c5d.nearcraftmc.testnet
      before: carrying 0 iron_ingot, chain says 1
ok    the purchase settled on NEAR                   tx CmbQGYwKpbg9knBCviGB1eoaoEJFJk4fnP9qNHySsWig
ok    the player paid no gas for it                  balance moved by 0
ok    the iron_ingot arrived in a real player inventory          0 -> 1
ok    the purchase moved the chain and the inventory by the same amount   chain 1 -> 2, carrying 0 -> 1
ok    the sale settled on NEAR                       tx 2Uz4KTr2dnGSPc7LWfaySX6RCB9bXUqhHHuXRM7J6Msx
ok    the iron_ingot left the inventory when sold                1 -> 0
ok    the sale moved the chain and the inventory by the same amount       chain 1 -> 1, carrying 0 -> 0

9 passed, 0 failed
```

That is the half of the loop a console cannot reach. It is also the first time
the game and the ledger have been **compared** at all.

### It is a bot, not a person

mineflayer is a headless client. It has a real server-side player entity and a
real `PlayerInventory`, which is what was missing — and nobody played this. No
document here says otherwise.

### Three things it took, each a finding

**The chain and the inventory are not equal, and should not be.** The first
version of the cross-check compared totals and failed: *chain 1, carrying 0*.
That was right. The NEAR account is shared with the browser client and earlier
console runs, so it already owned an ingot, while a player entity in a fresh
world starts empty. The chain is the ledger of record and the inventory is one
view of it. What has to agree is **how much each moved**, and that is what the
check asserts now.

**Paper rejected every position packet.** The bot was kicked one second after
each command with `Invalid move player packet received`, losing the reply it was
waiting for. That is a hard validity check on the values in the packet, not the
`moved-wrongly` threshold — so relaxing thresholds did nothing, and neither did
turning mineflayer's physics off. The protocol hop is the cause: mineflayer
speaks a pinned older protocol and ViaVersion translates it for this server.
Connecting as the newest protocol mineflayer supports got *less* far. The fix is
that the harness **drops outgoing position packets**: a Minecraft client is not
required to report its position, and this one never moves. It still runs
commands and reads its own inventory, which is all it is for.

**`online-mode=false`, and only here.** A headless client has no Mojang account.
The bot fixture therefore runs with authentication off, in **its own directory**,
so a normal run cannot inherit it. `npm run mc:server` keeps
`online-mode=true` — that sentence elsewhere in this document is still true of
the documented way to run this.

## A real login, which cannot fit through a chat box

This is the measurement that shaped the whole identity path:

| | characters |
|---|---|
| a Google id token | **977** |
| the local dev issuer's token | 551 |
| what Minecraft carries | **256** |

`mineflayer/lib/plugins/chat.js:9` caps chat at 256, which mirrors the vanilla
client. So `/nearcraft link <token>` is not merely awkward with a real provider
— it is impossible. What arrives is a truncated credential, and the service
would reject it with a parse error that explains nothing.

So the token stays in the browser, which can hold it, and hands over eight
characters instead:

```
      browser:  sign in (977-char token)  ->  "Code for Minecraft"  ->  BYS7W823
  in the game:  /nearcraft claim BYS7W823
```

The code is the security object, so its properties are the design:

- **8 characters of Crockford base32** — 40 bits from `randomBytes`, with I, L,
  O and U removed so nothing is misread off a screen.
- **Single use.** Deleted on the first claim; a second is refused.
- **Two minutes.** Swept on access, and checked again when redeemed.
- **Attempt-capped**, because 40 bits is a loop away otherwise — and the cap
  self-heals after the window, because a permanent lockout would be its own
  denial of service.
- **A wrong code and an expired one answer identically**, so the route cannot
  be used to learn which codes existed.
- **Claiming mints a new session**, so quitting the game revokes the game's and
  leaves the browser signed in.

The plugin refuses anything JWT-shaped outright — including a *truncated* one,
by the `eyJ` prefix every JWT header starts with — and says why rather than
sending a fragment of a credential.

Proven end to end by `npm run mc:bot -- --oidc`: a real RS256 token minted by
the local issuer, verified by the running service against that issuer's JWKS
over HTTP, exchanged for a code, claimed in-game, and then a purchase settled on
NEAR with the ingot landing in a real inventory.

**Disclosed:** `npm run play:oidc` labels the local issuer `seed`, so a verified
subject derives the same account a seeded login would. The label is a namespace
string and the verification is entirely real, but a *different* label derives a
*different* account — which is why that label is pinned once and never moved.

That used to be a hard limit, because a new account could not be created: the
live root was below the gas headroom. It no longer is. `npm run live:onboard`
creates one on the public chain, and `npm run mc:up` then plays it — which is how
`p-62b0b243.nearcraftmc.testnet` came to exist and to hold iron. The demo's
identity now lives in `config/catalog.json` as `demo_subject`, because a subject
hard-coded in a script and an account id recorded in `deployment.json` are two
hand-written facts that have to agree, and the moment a second player existed
they stopped agreeing: `mc:up` pre-flighted `players[0]`'s budget while the bot
spent a different player's. It now derives the account from the identity it is
about to present and refuses to start if the manifest does not record it.

## What it is not

**It is not a port of EthCraft's plugin.** That plugin is 5,201 lines across 28
files: a world, menus, an inventory escrow, a durable journal, voice, property
protection, WorldGuard and WorldEdit integration, and NMS access through a
mojang-mapped manifest. Its order flow is EVM-shaped down to a hard-coded
`chainId == 1301`, 18-decimal base units, `0x…{40}` addresses, Privy consent
nonces and a ten-state machine. None of it is vendored here and **no line of it
was copied** — `npm run check:docs` fails if any file under `minecraft/` so much
as carries EthCraft's package name, because that claim should be enforced rather
than promised.

What is here is new, small and deliberately boring: a client of the play
service, in seven classes.

## Design: the plugin holds no keys

```
Minecraft client ──► Paper + NearCraft plugin ──HTTP──► npm run play ──► NEAR
                            no keys                     holds the scoped key
```

Every write goes to `backend/near/play.mjs`, which already had 42 unit tests and
an end-to-end test against a real node. There is no signer, no RPC client and no
NEP-366 delegate construction in Java — a second implementation would be a
second thing to get wrong, and a custodial key in the *least* trustworthy
process in the system, the one players connect to.

| Class | Role |
|---|---|
| `NearCraftPlugin` | commands, async dispatch, inventory |
| `PlayClient` | the ten routes; **no Bukkit types**, so it tests standalone |
| `Json` | a strict reader and writer |
| `Amounts` | yoctoNEAR to NEAR by string arithmetic |
| `Sessions` | player UUID to session, memory only |
| `Items` | token id to `Material`, take and give |
| `Orders` | merchant name resolution and the count clamp; **no Bukkit types**, so it tests offline |

The total is in `README.md` and is counted by `check:docs` rather than written
by hand here — seven line counts in a table is seven numbers that would start
rotting the next time a comment is added to one of these files.

Seven in-game commands: `/nearcraft link|claim|status|selftest|inventory-selftest|world-selftest`,
`/market`, `/buy`, `/sell`, `/wallet`, `/invest`, and `/agent`. All of them are
runnable **from the server console** as well as by a player, which is what let
the chain half be proven before any client could connect.

`/agent <worker> buy <item> [count]` sends a declared agent shopping. It is the
one command here that spends somebody else's money: `worker-1` holds its own
NEAR account, its own credit at the market and its own function-call key scoped
to one method on one contract, and it pays its own gas — the relayer exists so
that *players* never see a gas prompt, and an agent is not a player. The service
dispatches it through the same `agentPolicy` + `createAgentSigner` path
`npm run agent` uses rather than a second way to sign, so the order is bounded,
a deposit is refused, the key's scope is re-read from the chain before anything
is spent, and a merchant outside this world is turned down. Proved on testnet:
`worker-1.nearcraftmc.testnet` → `market.nearcraftmc.testnet`,
`buy_with_credit`, `SuccessValue`
([`EHSKS6ai…`](https://testnet.nearblocks.io/txns/EHSKS6aiZnhAAEkYVE3Qfi1zAHfLkBFkWRpdqy1vmAT9)).

**It was documented and unbuilt for two weeks.** `GAME_LOOP.md` specified
`/agent worker task gather 64 iron` from its first draft; there was no `agent`
entry in `plugin.yml` and no handler, so the one mechanic that makes this an
*agent* economy was the one a player could not reach. What is built is a
purchase, not a gather — nothing here can make an agent mine a block — and
`check:docs` now fails when a command named in these documents is absent from
the plugin, at the subcommand level too.

`/nearcraft world-selftest` asks the world whether the materials this economy
trades can actually be gathered in it. That question had never been asked, and
the answer was no: the server generated a **default superflat** world — bedrock,
two dirt, one grass — in survival mode, while the economy trades `iron_ingot`,
`oak_log`, `stone`, `glass`, `coal`, `copper_ingot`, `oak_planks` and
`redstone`. Not one of the eight existed in the world a player spawned into, so
the first of the three core actions in `GAME_LOOP.md` — *"Mine, chop, or harvest
one stack-worth of a material"* — was impossible. You could trade, but only
things you had bought.

`npm run mc:server` now generates ordinary terrain from a seed pinned in
`config/minecraft-runtime.json`, and the check reports per material what it
found. Measured on the flat world first, which is how the defect was
demonstrated rather than argued:

| world | result |
|---|---|
| `level-type=minecraft:flat` (what it was) | `world selftest: 0 of 8 materials gatherable, 1 failed` |
| `level-type=minecraft:normal`, seed `nearcraft` | `world selftest: 7 of 8 materials gatherable, 0 failed` |

The one that is still missing is `glass`: spawn is inland and sand is a beach.
That is distribution rather than absence, which is why the bar is half the
materials and not all of them — and why the per-material lines are printed
either way. `mc-server.mjs` gates its exit on this, so a world nobody can play
in now fails the run instead of booting quietly.

**The bot fixture keeps its flat world on purpose.** `scripts/mc-bot.mjs` runs a
headless client that never sends position packets, so real terrain could leave
it in water or inside a block; what it proves is settlement, not scenery, and
the 9-of-9 that already passes is not traded for a view.

`/invest` is the `games` prompt's own closing sentence — *"it closes its shop
until someone invests in it"*. It calls `invest_with_credit`, the non-payable
twin of a `#[payable]` method, which exists precisely because a function-call
key cannot attach a deposit: without it the mechanic would be unreachable by the
players it is for. Every layer of it was built and tested before this, and no
client called it. The live demo player's key predates the method and can never
gain it, so for that account the command refuses and says why; a player
onboarded today is granted all three methods.

### Two things that are easy to get wrong, and are not

**Nothing blocks the main thread.** Every HTTP call runs on
`runTaskAsynchronously` and anything touching an inventory hops back with
`runTask`. A relayed call takes seconds; doing it synchronously in a command
handler would freeze the world for every player on the server.

**A sale takes the stack before the chain call, and refunds if anything
refuses.** Taking afterwards would let two commands in flight sell the same
stack twice and the chain would settle both. A refund is visible and bounded; a
double sale is neither.

## What the Java checks actually check

`npm run mc:test` compiles main and test sources together — so a test cannot
pass against a stale build — and runs 211 checks against a stub HTTP server. No
Minecraft, no network, about a second.

The substance is the refusals:

- **A strict JSON reader.** Every relaxation a lenient parser offers is
  rejected: trailing commas, unquoted keys, single quotes, comments, `NaN`,
  trailing bytes after the value, short or non-hex `\u` escapes, and a **raw
  control character inside a string** — which would otherwise let a service
  smuggle extra lines into what the plugin prints in game chat. Nesting depth
  and input length are both bounded, because this parses bytes off a socket and
  recursive descent has exactly one denial-of-service.
- **The service address is validated at startup.** Plain `http` is accepted
  *only* for loopback. Every call after sign-in carries a session id, which is
  bearer authority over a player's account, and sending one in clear text across
  a network hands it to anything on the path.
- **The response body is read with a bound.** A game server should not be the
  thing that runs out of heap because of whatever answered on that port.
- **Amounts never pass through a `double`.** A yoctoNEAR u128 has up to 39
  digits and a double carries about 15, so `Double.parseDouble` would silently
  round a balance. It is string arithmetic throughout.

Three of these were **deliberately broken to confirm they fail** — plain http
allowed everywhere, the size bound removed, and any answer counted as success.
Each went red, then was restored. The house rule in `AGENTS.md` is that a check
is not believed until it has failed once, and it was earned by a key audit that
passed for weeks while auditing nothing.

Two of the amount tests failed on first run because the *test* had the wrong
number of zeros in a literal, twice. They are now composed (`"4" + "0".repeat(21)`)
rather than hand-counted — the same failure class that has rotted the counted
claims in this repository five times.

## Limits, stated rather than hidden

- **No human has played it.** There is no Minecraft account on this machine. A
  headless client has — a real protocol client with a real server-side player
  entity and a real `PlayerInventory`, which is what the console could not
  reach — but it is a bot, and no claim here should be read as a person playing.
  The console path still exists and still prints its own gap:
  `(console: chain only, no inventory to move)`.
- **`online-mode` is `true` for `npm run mc:server`** and **`false` for
  `npm run mc:bot`**, because a headless client has no Mojang account to
  authenticate. The bot fixture lives in its own directory so a normal run
  cannot inherit that, and it also relaxes Paper's move-packet validation and
  drops the client's outgoing position packets — all three are properties of a
  test fixture for a client that never moves, and none of them touch the
  documented way to run this.
- **The inventory arithmetic is proven, but not against every slot.** The 27
  console checks run against a real `Bukkit.createInventory`, which has no
  offhand; `take` uses `removeItemAnySlot` specifically so the offhand is
  reachable, and only the bot run exercises a real `PlayerInventory` at all.
  Selling a stack held *only* in the offhand is not separately asserted.
- **Inventory and chain are not atomic.** The relayed call is the settlement and
  the `ItemStack` is a game-side effect applied after it. A crash in between
  diverges them and nothing here repairs that. EthCraft solved this with an
  escrow and a durable journal; neither is ported.
- **`/nearcraft link <token>` passes a token as a command argument.** It is never
  written to disk and never logged by the plugin. In seeded demo mode the token
  is a subject like `player-1` and is worth nothing — but pointed at a real OIDC
  provider it would be a bearer JWT typed into a game client, which is the wrong
  shape. The fix is a one-time code completed in the browser, and it **is**
  built — `/nearcraft claim <code>`, documented above. This sentence said "it
  is not built" for a week after it was, which is the same defect in the
  other direction: a limits section that understates what exists teaches a
  reader to distrust the ones that do not.
- **The service must be running.** The plugin is a client; with nothing on
  `127.0.0.1:8080` every command answers `SERVICE_UNREACHABLE` and says to start
  `npm run play`.
- **The play service itself is unauthenticated.** It is meant to sit on loopback
  beside the game server, and anything else that can reach that port can call it
  with a session id it has obtained. The plugin's refusal to send a session id
  over plain http to a non-loopback host narrows how one could leak; it does not
  put a door on the service. Running the service on a shared host without one is
  a deployment mistake, and nothing here stops you making it.

  **There is now a shared host, and this warning still applies to it.**
  <https://nearcraft-play.onrender.com> runs the service publicly, so what the
  paragraph above describes is live: anyone who finds it can sign in as the one
  player it can sign for and trade with that player's testnet credit, spending
  the relayer's gas. What was done instead of writing the door was to take away
  everything the door would have been protecting. That instance holds two keys —
  the relayer's and one player's scoped key — and **not** the root account, the
  `items`/`market`/`guard` contract accounts, the merchants or the agents. With
  no root key it cannot create an account at all, which matters because the
  seeded login accepts any string and funds a new account from root: a public
  instance that *could* onboard would be a faucet. `/api/health` reports
  `canOnboard: false`, and `npm run check:hosted` proves it by sending a random
  identity and checking that nothing was created. Narrower, not closed. The gate
  — a per-IP limit on `/api/session` and a shared secret — is still not built.
- **EthCraft's world, menus, escrow, item delivery, voice and property
  protection remain unported**, and this does not change that.

## Making it joinable

Render cannot host a Minecraft server. It exposes HTTP only on 80 and 443, UDP
is not on its roadmap, and its TCP support reaches only its own private network.
Minecraft Java needs inbound TCP 25565. So a joinable server runs on a machine
you control, behind a tunnel, and points the plugin at the **hosted** play
service.

```sh
# 1. a tunnel to TCP 25565 — playit.gg is free and needs no port forwarding
#    (any TCP tunnel works; it gives you an address like xxxx.playit.gg:12345)

# 2. the server, with the plugin aimed at the hosted service and the public
#    address printed in the banner
npm run mc:server -- \
  --service https://nearcraft-play.onrender.com \
  --public <your-tunnel-address> \
  --serve

# 3. put that address in config/hosting.json so the check can reach it
npm run check:hosted
```

`PlayClient.normaliseBase` already allows a remote `https` service and refuses
plain `http` to anything but loopback, so nothing in the plugin changes to reach
Render — a session id is bearer authority over an account and it is not going
across a network in clear text.

**What a visitor does.** `/nearcraft link <any name you like>`. The hosted
service lends them one of five pre-funded players, so they get their **own**
account, their own credit and their own scoped key — not a shared one. The
banner prints how many are left. Then `/market iron_ingot`, `/buy ironmonger
iron_ingot 1`, `/wallet`.

**Why a pool and not onboarding.** The service cannot create accounts: that
needs the root key, and the seeded verifier accepts *any* string, so a public
endpoint with a root key would cost the root account 0.11 NEAR per distinct
string with nothing to stop a loop. The gate considered instead — a per-IP limit
plus a cap — does not survive this topology: behind Vercel **and** Render the
caller's address arrives in `x-forwarded-for`, whose leftmost entry the caller
sets, and the counter would reset every time a free instance woke from its
fifteen-minute sleep. Five accounts funded in advance need no header to be
trustworthy and cannot be drained past their own number. `npm run check:hosted`
proves it by signing in as a stranger and checking that **root's balance did not
move**.

**`npm run check:hosted` pings it with Minecraft's own Server List Ping** — a
handshake packet, a status request, and the JSON the server answers with —
rather than a bare TCP connect, because on a tunnel the thing listening on that
port might be the tunnel's own error page. The MOTD in that JSON is set by
`scripts/mc-server.mjs`, so a reply carrying it proves *this* server answered.
With no address configured the check says so and does not pass.

**The honest limit: it is live while that machine is on.** That is a demo
window, not hosting, and no sentence here should be read as otherwise. What is
hosted permanently is the browser game — <https://nearcraft.vercel.app> signs a
visitor in and renders Buy and Sell per merchant against live testnet, with the
relayer paying the gas.

## One command

```sh
npm run mc:up                  # live testnet, prove it, tear down
npm run mc:up -- --oidc        # a real RS256 token, via a one-time code
npm run mc:up -- --keep        # leave the server up and joinable
npm run mc:up -- --sandbox     # a local economy, no balance ceiling
```

Everything in this document worked before `mc:up` existed, and still failed
often — because it took three terminals in the right order. `mc:bot` needs the
play service already listening, and `--oidc` needs the issuer and an
OIDC-configured service as well. **Every failure after the code was correct was
orchestration.**

So `mc:up` owns the lifecycle: it pre-flights what is knowable in seconds
(JDK, disk, the pinned jars, ports, the relayer's gas, and whether the player's
budget covers the run it is about to attempt), starts what is missing, boots
Paper, runs the proof, and stops only the processes it started — a service you
were already using survives it.

Two deliberate behaviours:

- **It retries the client connection, twice by default, and nothing else.**
  `--attempts <n>` changes that, and `--attempts 1` makes the word "twice"
  false, which is why the default is named rather than asserted. That hop goes
  through ViaVersion and is the one step outside this repository. A failed
  *check* is never retried, because that would be hiding a result, and the
  retry count is reported whenever it is used.
- **A run that cannot trade does not claim it traded.** If the budget will not
  cover the round trip, every free check still runs and the trade is reported
  skipped with the arithmetic.

### `--sandbox`: the version with no ceiling

`Sandbox.start()` in-process, then the same `scripts/deploy.mjs` testnet uses,
pointed at it with four environment variables — so there is no sandbox-only
deployment path to drift. It builds the **full-size** economy (`scale 1`, five
merchants) rather than the 1% one the testnet faucet can afford, and the
genesis account holds 10,000 NEAR, so credit never runs out.

Two traps worth naming, both found while building it:

- `deploy.mjs` inherits `economy_scale` from whatever manifest is on disk, so a
  sandbox run silently built a 1%-size economy until it was set explicitly.
- The manifest and keys paths are now overridable (`NEARCRAFT_MANIFEST`,
  `NEARCRAFT_KEYS`), so a local run never touches the committed testnet
  `deployment.json`. There were **two** hardcoded copies of that path in
  `deploy.mjs`, and only one of them was the constant.

**A sandbox is a local node, not a public chain.** No hash from it is presented
as live evidence and `evidence/live/` stays for public-chain records only. It
exists so the demo always works, and so somebody with no credentials can run
the whole thing.

## Reproducing it

```sh
brew install openjdk@25     # Paper 26.3 refuses anything older
npm run mc:build            # fetch the pinned API jar, compile, jar
npm run mc:test             # 211 Java checks, offline
npm run play                # in another terminal
npm run mc:server -- --token player-3 --trade
npm run mc:server -- --token player-3 \
  --sell ironmonger:iron_ingot:1 --buy ironmonger:iron_ingot:1   # the round trip
```

Every downloaded artifact is pinned by sha256 in
[config/minecraft-runtime.json](../config/minecraft-runtime.json) and refused if
the bytes do not match, so a tampered mirror is caught rather than compiled
against. Nothing is vendored: a 53 MiB server jar in a clone is weight, not
provenance.
