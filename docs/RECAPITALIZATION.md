# Reopening a closed merchant

**Status: the mechanic is built; the stake accounting is not.**

`market.invest(merchant_id)` and `market.invest_with_credit(merchant_id, amount)`
are implemented, permissionless and tested, so the sentence the `games` prompt
actually writes — "it closes its shop until someone invests in it" — now holds:
anyone can reopen a broke merchant, and `invest` returns whether it reopened.

What an investor gets back is **the shop, not a dividend**, and that is a real
incentive rather than charity: a closed merchant will not buy from you, so the
player holding iron is exactly the person who wants the ironmonger funded.

**What is still only designed is everything below:** a tracked stake repaid out
of the merchant's future margin. That needs per-stakeholder accounting and a
cost basis per shelf — new contract state, and therefore a state migration the
contracts have no mechanism for yet. The rest of this document is that design,
and it is still accurate as a design.

## Why a merchant closes

A merchant holds its own money. It earns on every sale and spends only when it
buys from a player. If players sell it more than it sells them, its treasury
falls; when the treasury reaches its floor the merchant stops posting a bid and
reports closed. It keeps selling from whatever stock it has — it is out of cash,
not out of goods.

That half is built, in `contracts/market/src/lib.rs`, and proved
deterministically by `a_merchant_can_be_flooded_until_it_stops_buying` in
`contracts/integration/tests/economy.rs`.

One thing building it taught us, which shapes everything below: **a merchant
that sells briskly cannot go broke.** The merchants that close are the ones that
opened undercapitalised, or that a player flooded on purpose. So recapitalisation
is not a routine maintenance chore — it is a response to a deliberate act.

## The mechanic

A closed merchant is a visible, locatable opportunity. A player funds its
treasury and takes a share of its future margin until the stake is repaid with a
premium.

```
player → market.invest(merchant_id)        payable
         treasury += deposit
         stake[(merchant, player)] += deposit

on every subsequent sale by that merchant:
         margin = sale price − bid price previously paid
         margin is split: merchant keeps (1 − s), stakeholders share s pro rata
         a stakeholder's claim retires once it has drawn its stake × premium
```

The merchant reopens — posts a bid again — as soon as its treasury is back above
its floor, which the existing `is_closed` rule already handles with no change.

## Why it is deferred

Not because it is hard to write, but because of what it adds to a contract that
currently has one money flow.

1. **A second token flow and a payout ledger.** Today money moves player →
   merchant treasury, and merchant treasury → player. Stakes add a third
   direction with per-stakeholder accounting that must survive partial fills,
   rollbacks and a merchant closing again mid-stake. The rollback path
   (`on_items_delivered`) would have to unwind a margin split as well as a sale.
2. **Per-sale margin is not currently computed.** The contract knows the price
   it sold at and the bid it paid, but not as a matched pair — stock is fungible
   within a listing. Attributing margin needs either a cost basis per listing or
   an approximation, and an approximation is the sort of thing that quietly
   stops adding up.
3. **It needs rules we have not fixed.** What the share `s` is, whether a second
   investor dilutes the first, whether a stake is transferable, what happens to
   an unretired claim if the merchant closes permanently. These are the kind of
   decisions this project writes down before coding (`RULES.md`, `GAME_LOOP.md`),
   and they were not written down in time.

Shipping it half-specified would mean a contract holding player money under
rules we had not settled. The decision was to build the half that makes the
economy legible — a merchant that closes when broke, which the fast-forward run
demonstrates — and to say plainly that the other half is not there.

## What would have to be true before building it

- The margin attribution rule written down and unit-tested in `pricing.rs`
  alongside the price rule, in the same readable style.
- A rollback test proving a failed delivery unwinds a margin split.
- An invariant test: the sum of treasury, stakes outstanding and payouts made
  equals everything ever deposited. A money contract without that is a guess.

Until those exist, this stays a design note.
