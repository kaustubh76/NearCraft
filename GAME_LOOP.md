# NearCraft — the game loop

Written before any code, as the `games` track prompt asks. This is the design
the contracts and the plugin are built to serve. Where the implementation later
diverges from this document, this document is wrong and gets corrected, not
quietly abandoned.

## The one-sentence loop

You gather materials in a Minecraft recreation of South Mumbai and trade them
with merchants who are AI agents holding their own NEAR accounts, their own
inventory and their own money — and because their prices come from their stock
and from what you and everyone else just sold them, the market is the thing you
are actually playing against.

## Why this is a game and not a dashboard

The economy is not a layer on top of the game. It is the opponent. A quest
giver has a fixed price; a merchant with 400 iron in a chest and a draining
treasury does not. Every price in NearCraft is a consequence of player behaviour,
including your own behaviour ten minutes ago.

## Every 30 seconds

One of:

- **Gather.** Mine, chop, or harvest one stack-worth of a material. Ordinary
  Minecraft Survival; no chain involvement at all.
- **Read a quote.** Open a merchant. You see a price and, next to it, the
  merchant's reason in one line: *"iron_ingot 0.82 — I hold 311, up from 180 an
  hour ago. Buying slowly."* The reason is not flavour text; it is rendered
  from the same fields the contract used to compute the number.
- **Trade.** Sell into the quote or buy from it. One click, one confirmation
  screen, no wallet popup, no gas prompt, no seed phrase. The item appears in
  or leaves your inventory.

The 30-second beat is: *act, then watch the number move because of what you
did.* Selling 64 iron to a merchant visibly drops that merchant's iron bid on
your next visit. That is the core feedback and it has to be legible inside half
a minute or the economy feels like weather rather than a system.

## Every 5 minutes

The tactical layer, where prices stop being a readout and start being a map:

- **A merchant re-rates.** Stock crosses a threshold and the price steps. The
  tooltip says which threshold and why.
- **You reroute.** Two merchants hold different stock, so they quote different
  prices for the same material. Walking ten blocks is now worth something. This
  is the first strategy the game teaches and it requires no tutorial.
- **You hire a worker.** `/agent worker task gather 64 iron`. A worker agent
  takes a NEAR sub-account of its own (`worker-1.nearcraftmc.testnet`) and a
  function-call access key with an explicit method list and a spending
  allowance. It gathers while you build. Its key cannot transfer NEAR and
  cannot add keys, so the worst it can do is spend its allowance on the
  materials you scoped it to.
- **You notice a merchant is thin.** Its treasury is falling. It is still
  buying, but less eagerly, and the tooltip says so.

## Every session

The strategic layer, and the part that makes a second session different from
the first:

- **Your inventory reflects prices, not quests.** You are holding copper
  because copper was cheap on Tuesday, not because an NPC asked for copper.
- **A merchant you drained is closed.** If you sold a merchant so much iron
  that its treasury hit the floor, it is shut when you come back, with a sign
  saying so. The market remembers you. (Reopening a closed merchant — players
  funding it for a share of its margin — is designed in `docs/RECAPITALIZATION.md`
  and is explicitly *not* built in the hackathon window. See the README.)
- **Your worker's allowance ran down.** Agents are not free and not unbounded.
  You decide whether to top one up. This is a budget decision, which is the
  point: an agent with a wallet is only interesting if the wallet has limits.
- **The whole market has drifted.** Prices at the end of a session are not the
  prices at the start, and nobody patched anything.

## The price rule

One readable file: `contracts/market/src/pricing.rs`. The whole rule is three
multiplicative terms, and it is deliberately simple enough that a player can
predict it after twenty minutes of play.

```
quote = base_price
      * scarcity(stock)        rises as the merchant's stock falls
      * demand(recent_volume)  rises with recent buying, decays over time
```

- `base_price` is per material, set once at genesis.
- `scarcity` is a step function over stock bands, not a curve. Steps are
  legible; curves are not. A player should be able to say "it jumps when they
  drop under 128."
- `demand` accumulates on buys, decays linearly toward 1.0 over a fixed
  window. Selling into a merchant pushes the other way.
- Both terms are clamped. No merchant ever quotes zero and none quotes
  infinity.
- A merchant stops quoting a **buy** price for a material as soon as it cannot
  fund a single unit of it. It will still sell you what it has.

  This is a correction to what this document first said. The original rule was
  "closed when its treasury drops below its floor", and building it showed that
  rule can never fire: a merchant only ever spends what sits *above* its floor,
  so the treasury approaches the floor without reaching it. Worse, a merchant
  that refused any lot it could not fully afford left its spare cash stranded.
  So a merchant now buys as much of your lot as it can pay for and hands the
  rest back — NEP-245's transfer-and-call returns an unused amount for exactly
  this — and it is closed when it can afford nothing. One consequence worth
  knowing as a player: a rich merchant can be closed to an expensive material
  while still bidding on a cheap one.

  A second thing building it taught us, which is not a correction but is
  counter-intuitive: **a merchant that sells briskly cannot go broke.** It earns
  on every sale and only spends when buying from you. The merchants that close
  are the ones that opened undercapitalised, or that you have deliberately
  flooded. Draining a thriving merchant is not a strategy.

The prompt's example works: flood a merchant with iron, its stock band rises,
`scarcity` falls, iron gets cheap there. Walk to the merchant nobody has
visited and iron is still expensive.

## Where the chain is

Nowhere the player can see, which is the whole bet.

- Materials are NEP-245 multi-tokens — every material is one token id inside
  one contract, so a merchant's whole inventory is one balance query.
- Each merchant and each worker agent is a named NEAR sub-account, so every
  on-chain action in the game traces to one named actor you can look up.
- The player signs nothing. Gas is relayed. Login is a social identity, not a
  seed phrase.
- The only chain-shaped thing a player ever encounters is that their worker
  agent has a spending limit — and that reads as a game mechanic, because it is
  one.

## What a judge can watch in sixty seconds

`npm run sim` runs the loop above with scripted strategies and no model calls:
twenty buyers and five merchants, a week of trading compressed into about a
minute, against the real deployed testnet contracts. Prices move, a merchant
goes broke and closes, and the receipts print. No Minecraft, no credentials, no
wallet.

That is the economy. The Minecraft client is how a human plays it.
