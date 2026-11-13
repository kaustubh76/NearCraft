# Reopening a closed merchant

**Status: built, including the stake accounting this document deferred — and now
run on public testnet.** A stake of 0.05 NEAR was recorded in the Ironmonger
([`CwWMeG5t…`](https://testnet.nearblocks.io/txns/CwWMeG5txLAobS7dozomcBqKBZturJ7iKiY21e3FDEUG)),
and the next gasless purchase repaid 0.005924 NEAR of it out of the merchant's
margin ([`8s6e5vqw…`](https://testnet.nearblocks.io/txns/8s6e5vqwysZj8pMRubF8TkngzZ5erfr7EMdvUyr1pJYA)).
`npm run live:stake` reproduces it. See "What the live run showed" at the end,
which includes the one number that came out wrong and why.

The three reasons for deferring it are answered under "Why it was deferred"
below, with the two places the design was **superseded by something better**
marked as such rather than quietly dropped. The share is
`pricing::BACKER_SHARE_BPS` — half the margin, until the stake is repaid.

`market.invest(merchant_id)` and `market.invest_with_credit(merchant_id, amount)`
are implemented, permissionless and tested, so the sentence the `games` prompt
actually writes — "it closes its shop until someone invests in it" — now holds:
anyone can reopen a broke merchant, and `invest` returns whether it reopened.

What an investor gets back is **the shop, not a dividend**, and that is a real
incentive rather than charity: a closed merchant will not buy from you, so the
player holding iron is exactly the person who wants the ironmonger funded.

**The tracked stake is now built too.** It needed per-stakeholder accounting and
a cost basis per shelf — new contract state, and therefore the state migration
the contracts had no mechanism for. Both now exist: `market.migrate()` has run
on public testnet twice, and `basis` plus `backers` are live state. The rest of
this document is the design it was built from, with the deviations marked.

In one paragraph: `invest` records who staked what; a sale attributes margin in
`on_items_delivered`'s **Ok** branch, using weighted-average cost basis; half of
that margin becomes the backer's withdrawable credit until the stake is repaid;
and `withdraw_treasury` is refused while a claim is open, because the principal
sits in the treasury and an unguarded merchant could simply cash it out.

One detail of that Ok branch changed after the audit and matters here: the
merchant is now **paid** in it too, immediately before the margin is
attributed. The payment used to land in the treasury when the purchase was
made, which left it withdrawable while the delivery was still in flight. The
ordering inside the branch is deliberate — `attribute_margin` sizes a backer's
payout from `treasury - floor`, and the treasury it has always read included
the sale, so paying after would quietly shrink every repayment.

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

## Why it was deferred, and what answered each reason

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

## The three reasons, answered

1. **"A second token flow and a payout ledger… the rollback path would have to
   unwind a margin split as well as a sale."** It does not, and this is the
   design being **superseded**: margin is attributed in
   `on_items_delivered`'s **Ok** branch, which already carries `count` and
   `paid`. So there is no signature change — and adding an argument to an
   existing `#[private]` callback would break any receipt already in flight,
   taking the rollback that refunds a player with it — and nothing to unwind on
   failure, because on failure no margin was ever attributed. A test asserts
   exactly that: `a_failed_delivery_attributes_no_margin_at_all`.
2. **"Per-sale margin is not currently computed… an approximation is the sort of
   thing that quietly stops adding up."** Correct, and the approximation was
   rejected. `margin = paid × 20%` (the merchant's spread) would pay a backer out
   of its own principal whenever a merchant restocked a thin shelf at a scarcity
   price and then sold into a glut — a real **loss** dressed up as profit.
   `pricing::cost_of_goods` uses weighted average instead, and
   `pricing::margin` saturates at zero, so a loss pays nothing. Weighted average
   rather than FIFO because a shelf is fungible: NEP-245 balances carry no
   acquisition lot, so there is no queue to keep, and it stays O(1) inside a
   callback with a fixed gas budget.
   One thing this document did not anticipate: **a player selling into a
   merchant is also an acquisition at a price**, so `basis` is written by that
   path too. A basis built only from restocks would make every resale look like
   pure margin.
3. **"It needs rules we have not fixed."** Fixed by construction, with **one
   backer per merchant**:
   - *dilution* and *pro rata* — cannot arise; two accounts never hold a claim
     on the same merchant at once. It keeps the payout O(1), where pro rata
     means unbounded iteration inside a 12 TGas callback.
     A newcomer takes the slot by **covering the incumbent's outstanding claim
     in full**, which was not in the first version and had to be: without it, a
     one-yoctoNEAR stake claimed the slot and locked out every real rescue until
     the merchant happened to make a sale — denying the mechanic `invest` exists
     for, for free. The incumbent is repaid exactly what it was owed, so the
     buy-out takes nothing from it; only the remainder reaches the treasury, and
     the money invariant covers that split because it is the one step where a
     single deposit has two destinations.
   - *transferability* — not supported, and nothing depends on it.
   - *an unretired claim if the merchant closes permanently* — the claim stays
     open and unpaid. Stated plainly because it is the honest answer: a backer
     whose shop never trades again does not get its money back. That is what
     investing is, and `invest` refuses a merchant with no shelves at all, so
     the one case where repayment was *impossible from the start* is blocked.
   - *the share* — half, `pricing::BACKER_SHARE_BPS`. A backer taking all the
     margin would leave the merchant unable to restock, which turns a rescue
     into a slow second bankruptcy.

   As a game rule one-backer is also better than pro rata: the first player to
   reach a shut shop gets the deal.

## What had to be true before building it

- The margin attribution rule written down and unit-tested in `pricing.rs`
  alongside the price rule, in the same readable style. **Done** — seven tests
  in `backing_tests`, with no VM context, led by the sale-at-a-loss case.
- ~~A rollback test proving a failed delivery unwinds a margin split.~~
  **Superseded**, see reason 1: the stronger property is that there is no split
  to unwind, and that is what is tested.
- An invariant test. **This one is built**, and the formula this document used
  to state was wrong. It said "the sum of treasury, stakes outstanding and
  payouts made equals everything ever deposited", which double-counts: a
  stake's principal goes straight into the treasury, so it is already inside
  the first term, and an outstanding claim is a promise about future margin
  rather than money held. The identity that is actually asserted, in
  `every_yocto_is_accounted_for`, is:

  ```
  sum(merchant treasuries) + sum(credit balances)
      == everything ever deposited − everything ever paid out
  ```

  It is checked after every one of the contract's fourteen money-moving calls,
  not once at the end, so a failure names the step. Four payable entry points
  add, two withdrawals remove, and everything else must net to exactly zero.
  Solvency — that the NEAR to honour the ledger is really there — is the
  separate sandbox half, `the_market_never_owes_more_than_it_holds`.

  When stakes are added, they change nothing about this identity: a stake is a
  deposit that lands in a treasury, and a payout is a credit. That is a reason
  to be glad the formula was corrected before the accounting was built on it.

~~Until the first two exist, the stake design stays a design note.~~ **All
three now exist**, so that sentence was retired rather than left to rot: the
first is done, the second superseded by a stronger property, the third built.

## What the live run showed

`npm run live:stake` ran this on public testnet. `worker-1` staked 0.05 NEAR in
the Ironmonger, then the live player made an ordinary gasless purchase from the
same merchant.

| | |
|---|---|
| stake | [`CwWMeG5t…`](https://testnet.nearblocks.io/txns/CwWMeG5txLAobS7dozomcBqKBZturJ7iKiY21e3FDEUG) — `invest`, 0.05 NEAR, returned `false` |
| purchase | [`8s6e5vqw…`](https://testnet.nearblocks.io/txns/8s6e5vqwysZj8pMRubF8TkngzZ5erfr7EMdvUyr1pJYA) — 3 iron_ingot, relayed, player paid no gas |
| `ledger_total` | 0.899092 → 0.949092 NEAR: **exactly** the stake, and unmoved by the purchase |
| market balance | 3.383910 → 3.433910 NEAR: the same 0.05, so solvency held with 2.48 NEAR of headroom |
| `backer_of` | principal 0.050000, repaid 0.005924, still owed 0.044075 |

Three things that run is worth having done, beyond "it works":

**`invest` returned `false`, and that is the right answer.** The Ironmonger was
not closed, so nothing reopened. The contract reports what happened instead of
reporting success — which is the behaviour this document asked for and the kind
that only a live run with an open merchant would exercise.

**The repayment lands as credit inside the market, not as NEAR in a wallet.**
`worker-1`'s credit went from 0.05 to 0.055924. It is withdrawable through
`withdraw`, which has its own rollback callback; it is not a transfer, so
nothing about the ledger identity moves.

**The margin was larger than the design intends, and the reason matters.** The
player paid 0.012 NEAR; the recorded cost of goods was 0.000151; so the margin
came out at 0.011848 and the backer took half. But `basis` only exists for units
the market bought **after** the C2 migration, and `cost_of_goods` returns 0 for
an unrecorded basis — so an *unknown* cost is indistinguishable from a *free*
one. Thirteen of the fourteen live shelves have no basis at all; the one used
here has a real but tiny one, covering only the handful of units the player had
sold back into a shelf of 256. The weighted average is therefore dominated by
stock whose cost was never written down.

That is the documented consequence of recording starting at migration, now
measured rather than predicted. It is bounded — a payout cannot exceed what is
owed, nor the treasury above its floor, and the money invariant is unaffected
because the payout moves treasury to credit inside the ledger. It is not a leak.
It is an overstatement, and the honest figure for a merchant stocked entirely
after C2 would be smaller. Collapsing "cost unknown" into "cost zero" is the
approximation this document warned "quietly stops adding up"; it was not changed
36 hours before a deadline, and `npm run live:stake` prints the cost it used so
the number is never presented without it.
