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
npm run mc:server -- --token player-1 --trade  # Paper, the plugin, a real trade
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
> nearcraft link player-1
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
service, in six classes.

## Design: the plugin holds no keys

```
Minecraft client ──► Paper + NearCraft plugin ──HTTP──► npm run play ──► NEAR
                            no keys                     holds the scoped key
```

Every write goes to `backend/near/play.mjs`, which already had 21 unit tests and
an end-to-end test against a real node. There is no signer, no RPC client and no
NEP-366 delegate construction in Java — a second implementation would be a
second thing to get wrong, and a custodial key in the *least* trustworthy
process in the system, the one players connect to.

| Class | Role |
|---|---|
| `NearCraftPlugin` | commands, async dispatch, inventory |
| `PlayClient` | the eight routes; **no Bukkit types**, so it tests standalone |
| `Json` | a strict reader and writer |
| `Amounts` | yoctoNEAR to NEAR by string arithmetic |
| `Sessions` | player UUID to session, memory only |
| `Items` | token id to `Material`, take and give |
| `Orders` | merchant name resolution and the count clamp; **no Bukkit types**, so it tests offline |

The total is in `README.md` and is counted by `check:docs` rather than written
by hand here — six line counts in a table is six numbers that would start
rotting the next time a comment is added to one of these files.

Six in-game commands: `/nearcraft link|status|selftest|inventory-selftest`,
`/market`, `/buy`, `/sell`, `/wallet`, and `/invest`. All of them are runnable
**from the server console** as well as by a player, which is what let the chain
half be proven before any client could connect.

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
pass against a stale build — and runs 84 checks against a stub HTTP server. No
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
- **The inventory arithmetic is proven, but not against every slot.** The twelve
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
  shape. The fix is a one-time code completed in the browser. It is not built.
- **The service must be running.** The plugin is a client; with nothing on
  `127.0.0.1:8080` every command answers `SERVICE_UNREACHABLE` and says to start
  `npm run play`.
- **The play service itself is unauthenticated.** It is meant to sit on loopback
  beside the game server, and anything else that can reach that port can call it
  with a session id it has obtained. The plugin's refusal to send a session id
  over plain http to a non-loopback host narrows how one could leak; it does not
  put a door on the service. Running the service on a shared host without one is
  a deployment mistake, and nothing here stops you making it.
- **EthCraft's world, menus, escrow, item delivery, voice and property
  protection remain unported**, and this does not change that.

## Reproducing it

```sh
brew install openjdk@25     # Paper 26.3 refuses anything older
npm run mc:build            # fetch the pinned API jar, compile, jar
npm run mc:test             # 84 Java checks, offline
npm run play                # in another terminal
npm run mc:server -- --token player-1 --trade
npm run mc:server -- --token player-1 \
  --sell ironmonger:iron_ingot:1 --buy ironmonger:iron_ingot:1   # the round trip
```

Every downloaded artifact is pinned by sha256 in
[config/minecraft-runtime.json](../config/minecraft-runtime.json) and refused if
the bytes do not match, so a tampered mirror is caught rather than compiled
against. Nothing is vendored: a 55 MiB server jar in a clone is weight, not
provenance.
