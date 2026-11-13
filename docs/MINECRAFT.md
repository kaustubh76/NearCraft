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

The total is in `README.md` and is counted by `check:docs` rather than written
by hand here — six line counts in a table is six numbers that would start
rotting the next time a comment is added to one of these files.

Five in-game commands: `/nearcraft link|status|selftest`, `/market`, `/buy`,
`/sell`, `/wallet`. All of them are runnable **from the server console**, which
is the only reason any of this could be proven here — see the limits below.

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

- **Nobody walked around.** There is no Minecraft account on this machine, so
  every command was driven from the server console. The one thing a console
  cannot do is hold an inventory, and the plugin says so in its own output:
  `(console: chain only, no inventory to move)`. The chain half is fully
  exercised; the block-moving half is exercised only by the unit checks.
- **`online-mode` stays `true`.** A demo is not a reason to turn authentication
  off, so `mc-server.mjs` does not.
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
