# NearCraft — bulk round rules

Written before any contract code, as the `swarms` track prompt asks. These are
the rules the coordinator enforces. The coordinator is a contract, not a
service, so these rules are the only rules.

## What a round is for

A single player buying 8 iron pays a merchant's shelf price. Twenty worker
agents each needing 8 iron are, together, worth competing for — so they pool
their demand into one round and let merchants bid for the whole lot. Each buyer
pays only its own share of the clearing price.

This is the part of the economy that has no human in it. Buyer agents represent
players; merchant agents represent themselves; the coordinator holds the rules.

## Accounts

Every participant is a named NEAR sub-account, so every action in a round
traces to exactly one agent:

- buyers — `worker-1.nearcraftmc.testnet` … `worker-20.nearcraftmc.testnet`
- sellers — `ironmonger.nearcraftmc.testnet`, `timberwright.nearcraftmc.testnet`, …
- coordinator — `market.nearcraftmc.testnet`

## The rules

**R1 — Opening.** Anyone may open a round for one material. A round fixes the
material, a join deadline, a commit deadline and a reveal deadline at creation
and they are never extended. One open round per material at a time.

**R2 — Joining.** A buyer joins with a quantity and a reserve price, and
deposits `quantity × reserve`. The reserve is the most it will pay per unit.
Deposits are held by the coordinator. A buyer may not join twice, and may not
withdraw before settlement.

**R3 — Sealed commits.** A seller commits `sha256(price_per_unit ‖ nonce ‖
account_id)`. The coordinator stores only the hash. Including `account_id` in
the preimage stops a seller copying another's commitment without knowing the
price inside it. One commit per seller per round; commits cannot be replaced.

**R4 — Reveal.** After the commit deadline, a seller reveals `price` and
`nonce`. The coordinator recomputes the hash and rejects a mismatch. A commit
that is never revealed is discarded and its seller is recorded as having failed
to reveal — visible on the live page, and that is the whole penalty. No slashing;
nothing a round can take from a seller is worth the complexity here.

**R5 — Clearing.** Lowest revealed price wins the right to supply the lot. The
price everyone pays is the **second**-lowest revealed price, or the winner's own
price if only one seller revealed. Paying second price means a seller's best
move is to reveal the price it would actually accept, which is the behaviour
that makes the simulation legible instead of a guessing contest.

**R6 — Participation.** Only buyers whose reserve is at or above the clearing
price are filled. The rest are refunded in full. If the winning seller's stock
is less than the filled demand, buyers are filled in join order until the stock
runs out; the unfilled are refunded in full. Partial fills within a single
buyer's quantity are not allowed — a buyer is filled or refunded, never half.

**R7 — Settlement.** Each filled buyer pays `clearing_price × quantity` and is
refunded `(reserve − clearing_price) × quantity`. The winning seller transfers
the material as NEP-245 tokens and receives the total. Settlement is one
transaction; if it fails, the round is void and every deposit is refundable.

**R8 — Void rounds.** A round with no reveals, or no buyer at or above the
clearing price, settles as void. Every deposit is refundable. Void is a normal
outcome, not an error, and the simulation produces them.

**R9 — Idempotency.** Every round action is keyed by `(round_id, account_id,
phase)`. Re-sending an action that already landed returns the stored result and
changes nothing. An uncertain send never creates a second bid or a second
deposit.

**R10 — No privileged reader.** Commit hashes, reveals, the clearing price and
the fill list are all public contract state. The coordinator has no information
a player could not query, and nothing in a round depends on trusting the game
server.

## One round, in sequence

```
  buyer-1..20        coordinator (market.nearcraftmc.testnet)        ironmonger / timberwright / ...
      |                          |                                          |
      |                   open_round(iron_ingot,                            |
      |                     join<t1, commit<t2, reveal<t3)                  |
      |                          |                                          |
      |-- join(qty 8, reserve 1.10) -->|                                    |
      |     deposit 8.80 held          |                                    |
      |-- join(qty 8, reserve 0.95) -->|   (x20 buyers, qty 148 total)      |
      |                          |                                          |
      |                      [t1 join deadline passes]                      |
      |                          |                                          |
      |                          |<-- commit_bid(sha256(0.82|n1|ironmonger)) |
      |                          |<-- commit_bid(sha256(0.90|n2|timberwright))
      |                          |      only hashes stored                  |
      |                          |                                          |
      |                      [t2 commit deadline passes]                    |
      |                          |                                          |
      |                          |<-- reveal_bid(0.82, n1) ---------------- |
      |                          |      hash checks out                     |
      |                          |<-- reveal_bid(0.90, n2) ---------------- |
      |                          |      hash checks out                     |
      |                          |      (a third seller never reveals ->    |
      |                          |       discarded, recorded)               |
      |                          |                                          |
      |                      [t3 reveal deadline passes]                    |
      |                          |                                          |
      |                      settle():                                      |
      |                        winner   = ironmonger (lowest, 0.82)         |
      |                        clearing = 0.90       (second lowest, R5)    |
      |                        filled   = buyers with reserve >= 0.90       |
      |                                   in join order, capped by stock    |
      |                          |                                          |
      |<-- pay 0.90*8 = 7.20, refund 1.60 (reserve was 1.10) --|            |
      |<-- full refund 7.60 (reserve 0.95 ... below clearing? no: filled) --|
      |<-- full refund (reserve below clearing, or stock ran out) ----------|
      |                          |-- transfer 8 iron_ingot each (NEP-245) ->|
      |                          |-- pay clearing * filled_qty ------------>|
      |                          |                                          |
      |                      round closed, public: commits, reveals,        |
      |                      clearing price, fill list, non-revealers       |
```

## The simulation — designed here, never built

**Nothing in this section runs.** It is retained as the design it was, because
deleting it would hide that the round mechanism was scoped and then dropped.

The intent was: `npm run sim` running rounds with twenty buyers and five sellers
on scripted strategies and no model calls — `undercut` (shade below last
clearing price), `hold` (quote cost plus a fixed margin), `starve` (refuse below
a floor), `mimic` (copy last round's winner), `noise` (uniform random inside a
band) — printing each round's commits, reveals, clearing price and fills.

What `npm run sim` **actually** runs is
`contracts/integration/tests/simulation.rs`: shelf-price trading against a real
local nearcore node, with a different strategy set and no rounds, commits or
reveals anywhere in it. There is no sealed-bid coordinator in
`contracts/market/`, so the `swarms` track is not entered.

## Known limits

- One material per round. Cross-material bundles are not modelled.
- No collusion detection. Five sellers running `mimic` converge, and the
  simulation shows that happening; the contract does nothing about it.
- Non-revealers are recorded, not punished. A seller can grief a round at the
  cost of its own reputation line on the public page and nothing else.
- Deposits are held per round, so a buyer's capital is locked for the round's
  duration. There is no netting across concurrent rounds.
