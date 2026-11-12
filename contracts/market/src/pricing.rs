//! The price rule. This is the only file that decides what anything costs.
//!
//! `GAME_LOOP.md` promises a player can predict prices after twenty minutes of
//! play, so the rule is three multiplied terms and nothing else:
//!
//! ```text
//! unit_price = base_price
//!            * scarcity(stock)          rises as the merchant's stock falls
//!            * demand(recent buying)    rises when people buy, decays with time
//! ```
//!
//! Everything is integer basis-point maths — a contract has no business doing
//! floating point, and bands are legible in a way a curve is not. A player can
//! say "it jumps when they drop under 128"; nobody can eyeball an exponent.

/// One times, in basis points.
pub const BPS: u128 = 10_000;

/// Scarcity multiplier. A **step** function on purpose: the steps are the thing
/// a player learns, and the tooltip can name the band they are standing in.
pub fn scarcity_bps(stock: u128) -> u128 {
    match stock {
        0 => 30_000,            // 3.00x  sold out
        1..=31 => 20_000,       // 2.00x  nearly gone
        32..=127 => 15_000,     // 1.50x  thin
        128..=511 => BPS,       // 1.00x  the reference band
        512..=2047 => 7_500,    // 0.75x  well stocked
        _ => 6_000,             // 0.60x  glutted
    }
}

/// Human-readable name of the band `stock` falls in, for the in-game tooltip.
pub fn scarcity_band(stock: u128) -> &'static str {
    match stock {
        0 => "sold out",
        1..=31 => "nearly gone",
        32..=127 => "thin",
        128..=511 => "normally stocked",
        512..=2047 => "well stocked",
        _ => "glutted",
    }
}

/// Each unit bought pushes demand up by this much.
pub const DEMAND_PER_UNIT_BPS: u128 = 60;
/// Demand never more than doubles the price.
pub const DEMAND_MAX_BPS: u128 = 20_000;
/// Demand bleeds back toward 1.00x at this rate.
pub const DEMAND_DECAY_BPS_PER_MINUTE: u128 = 120;
/// Nanoseconds in a minute, which is the unit `env::block_timestamp` speaks.
pub const NANOS_PER_MINUTE: u64 = 60_000_000_000;

/// Demand after `elapsed_ns` of decay, floored at 1.00x.
///
/// Decay is linear, not exponential: a player can count minutes, and a glutted
/// market recovering on a predictable slope is more readable than an asymptote.
pub fn decay_demand(demand_bps: u128, elapsed_ns: u64) -> u128 {
    let minutes = (elapsed_ns / NANOS_PER_MINUTE) as u128;
    let shed = minutes.saturating_mul(DEMAND_DECAY_BPS_PER_MINUTE);
    demand_bps.saturating_sub(shed).max(BPS)
}

/// Demand after someone buys `count` units, capped.
pub fn bump_demand(demand_bps: u128, count: u128) -> u128 {
    demand_bps
        .saturating_add(count.saturating_mul(DEMAND_PER_UNIT_BPS))
        .min(DEMAND_MAX_BPS)
}

/// Selling into a merchant pushes demand the other way, floored at 1.00x.
pub fn ease_demand(demand_bps: u128, count: u128) -> u128 {
    demand_bps
        .saturating_sub(count.saturating_mul(DEMAND_PER_UNIT_BPS))
        .max(BPS)
}

/// A price is never zero and never more than six times base. Without the clamp
/// a sold-out merchant in a demand spike could quote an absurd number, and an
/// absurd number reads as a bug rather than as scarcity.
pub const MIN_PRICE_BPS: u128 = 2_500; // 0.25x
pub const MAX_PRICE_BPS: u128 = 60_000; // 6.00x

/// What one unit costs to **buy from** a merchant.
pub fn unit_price(base_price: u128, stock: u128, demand_bps: u128) -> u128 {
    let multiplier = scarcity_bps(stock)
        .saturating_mul(demand_bps)
        .saturating_div(BPS)
        .clamp(MIN_PRICE_BPS, MAX_PRICE_BPS);
    base_price.saturating_mul(multiplier).saturating_div(BPS).max(1)
}

/// The merchant's **buy** price — what it pays a player per unit.
///
/// A fixed spread below the sell price. The spread is the merchant's whole
/// income, and it is what makes a merchant able to go broke: buy high into a
/// glut, fail to sell, treasury drains.
pub const SPREAD_BPS: u128 = 8_000; // merchant bids 80% of its ask

pub fn buy_price(base_price: u128, stock: u128, demand_bps: u128) -> u128 {
    unit_price(base_price, stock, demand_bps)
        .saturating_mul(SPREAD_BPS)
        .saturating_div(BPS)
        .max(1)
}

// ----------------------------------------------------------------- restocking

/// Below this, a merchant's shelf is thin enough to restock.
///
/// It is the top of the "nearly gone" band, so the trigger lines up with a
/// price band a player can already see rather than being a number from nowhere.
pub const RESTOCK_TRIGGER_STOCK: u128 = 32;

/// What it restocks up to: the bottom of the reference band, where the
/// scarcity multiplier is exactly 1.00x.
pub const RESTOCK_TARGET_STOCK: u128 = 128;

/// How many units a merchant should buy back, and what each one costs it.
///
/// The price is the bid it *would post for the restocked shelf*, not for the
/// thin one it has. That inversion is the whole design, and it is provable
/// rather than a matter of taste: `scarcity_bps` is non-increasing in stock, so
/// for every `s < RESTOCK_TARGET_STOCK`
///
///   restock_cost = 0.8 x unit_price(target) < unit_price(target) <= unit_price(s)
///
/// — a merchant can never restock above what it just sold at. Pricing at the
/// *current* thin bid (1.5-2.0x) would do the opposite: the merchant would pay
/// more for goods than it sells them for, so every restock would be a
/// guaranteed loss and the feature meant to keep merchants alive would kill
/// them. `restocking_never_costs_more_than_the_shelf_just_sold_for` pins it.
///
/// Returns `(units, cost_per_unit)`, and `(0, _)` when nothing should happen —
/// above the trigger, or too poor to afford even one unit.
pub fn restock_plan(base_price: u128, stock: u128, demand_bps: u128, spare: u128) -> (u128, u128) {
    let cost_per_unit = buy_price(base_price, RESTOCK_TARGET_STOCK, demand_bps);
    if stock >= RESTOCK_TRIGGER_STOCK || cost_per_unit == 0 {
        return (0, cost_per_unit);
    }
    let wanted = RESTOCK_TARGET_STOCK.saturating_sub(stock);
    // Never spend into the floor: `spare` is already treasury minus floor, the
    // same quantity every other buy-side path in this contract uses.
    let affordable = spare / cost_per_unit;
    (wanted.min(affordable), cost_per_unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: u128 = 1_000_000;

    #[test]
    fn scarcity_bands_are_monotonic_as_stock_grows() {
        let samples = [0u128, 10, 64, 256, 1_024, 10_000];
        let mut previous = u128::MAX;
        for stock in samples {
            let bps = scarcity_bps(stock);
            assert!(bps <= previous, "scarcity must not rise with stock at {stock}");
            previous = bps;
        }
    }

    #[test]
    fn band_names_match_the_multiplier_boundaries() {
        assert_eq!(scarcity_band(0), "sold out");
        assert_eq!(scarcity_band(127), "thin");
        assert_eq!(scarcity_band(128), "normally stocked");
        assert_eq!(scarcity_band(512), "well stocked");
        assert_eq!(scarcity_band(5_000), "glutted");
    }

    /// The promise in GAME_LOOP.md: flood a merchant with iron and iron gets cheap there.
    #[test]
    fn flooding_the_market_makes_a_material_cheaper() {
        let thin = unit_price(BASE, 20, BPS);
        let normal = unit_price(BASE, 256, BPS);
        let glutted = unit_price(BASE, 5_000, BPS);
        assert!(thin > normal, "scarce iron must cost more than normal iron");
        assert!(normal > glutted, "glutted iron must be the cheapest");
    }

    #[test]
    fn buying_raises_the_price_and_waiting_lowers_it_again() {
        let quiet = unit_price(BASE, 256, BPS);
        let after_a_rush = unit_price(BASE, 256, bump_demand(BPS, 64));
        assert!(after_a_rush > quiet, "a buying rush must move the price up");

        // Enough idle minutes and demand returns to its floor.
        let decayed = decay_demand(bump_demand(BPS, 64), 60 * NANOS_PER_MINUTE);
        assert_eq!(decayed, BPS);
        assert_eq!(unit_price(BASE, 256, decayed), quiet);
    }

    #[test]
    fn demand_is_capped_and_floored() {
        let mut d = BPS;
        for _ in 0..1_000 {
            d = bump_demand(d, 64);
        }
        assert_eq!(d, DEMAND_MAX_BPS, "demand must not run away");
        assert_eq!(decay_demand(BPS, 0), BPS, "demand never falls below 1.00x");
        assert_eq!(ease_demand(BPS, 10_000), BPS, "selling cannot push demand below 1.00x");
    }

    #[test]
    fn selling_into_a_merchant_eases_demand() {
        let hot = bump_demand(BPS, 100);
        let eased = ease_demand(hot, 50);
        assert!(eased < hot && eased >= BPS);
    }

    #[test]
    fn price_is_clamped_at_both_ends() {
        // Sold out and maximum demand: 3.00x * 2.00x = 6.00x, exactly the cap.
        let worst = unit_price(BASE, 0, DEMAND_MAX_BPS);
        assert_eq!(worst, BASE * MAX_PRICE_BPS / BPS);
        // Never free, even with a tiny base price.
        assert!(unit_price(1, 100_000, BPS) >= 1);
    }

    #[test]
    fn a_merchant_always_bids_below_its_ask() {
        for stock in [0u128, 31, 64, 256, 1_024, 9_999] {
            let ask = unit_price(BASE, stock, BPS);
            let bid = buy_price(BASE, stock, BPS);
            assert!(bid < ask, "merchant must not bid at or above its ask at stock {stock}");
        }
    }

    /// The spread is the merchant's only income, so it must survive a round trip.
    #[test]
    fn a_round_trip_through_a_merchant_loses_the_player_the_spread() {
        let ask = unit_price(BASE, 256, BPS);
        let bid = buy_price(BASE, 256, BPS);
        assert!(bid < ask);
        assert_eq!(bid, ask * SPREAD_BPS / BPS);
    }

    #[test]
    fn no_arithmetic_overflows_at_absurd_inputs() {
        let _ = unit_price(u128::MAX, 0, DEMAND_MAX_BPS);
        let _ = buy_price(u128::MAX, 0, DEMAND_MAX_BPS);
        let _ = decay_demand(u128::MAX, u64::MAX);
        let _ = bump_demand(u128::MAX, u128::MAX);
        let _ = ease_demand(0, u128::MAX);
    }
}

#[cfg(test)]
mod restock_tests {
    use super::*;

    const BASE: u128 = 400_000_000_000_000_000_000_000; // 0.4 NEAR, as the catalog

    #[test]
    fn a_full_shelf_is_not_restocked() {
        for stock in [RESTOCK_TRIGGER_STOCK, 64, 128, 512, 9_999] {
            let (units, _) = restock_plan(BASE, stock, BPS, u128::MAX);
            assert_eq!(units, 0, "stock {stock} is at or above the trigger");
        }
    }

    #[test]
    fn a_thin_shelf_is_restocked_to_the_reference_band() {
        let (units, _) = restock_plan(BASE, 31, BPS, u128::MAX);
        assert_eq!(units, RESTOCK_TARGET_STOCK - 31, "fills exactly to the target");
        let (units, _) = restock_plan(BASE, 0, BPS, u128::MAX);
        assert_eq!(units, RESTOCK_TARGET_STOCK, "a sold-out shelf fills completely");
    }

    #[test]
    fn a_poor_merchant_restocks_only_what_it_can_afford() {
        let (_, unit) = restock_plan(BASE, 10, BPS, u128::MAX);
        let (units, _) = restock_plan(BASE, 10, BPS, unit * 5);
        assert_eq!(units, 5, "five units of spare buys five units");
        let (units, _) = restock_plan(BASE, 10, BPS, unit - 1);
        assert_eq!(units, 0, "and not one unit buys none");
    }

    #[test]
    fn restocking_never_costs_more_than_the_shelf_just_sold_for() {
        // THE invariant. If this ever fails, restocking is a money pump running
        // backwards and merchants die of the feature meant to save them.
        for demand in [BPS, 12_000, DEMAND_MAX_BPS] {
            let (_, cost) = restock_plan(BASE, 0, demand, u128::MAX);
            for stock in [0, 1, 31, 64, 127] {
                let sold_at = unit_price(BASE, stock, demand);
                assert!(
                    cost < sold_at,
                    "restock at {cost} must undercut the {sold_at} it sells for at stock {stock} (demand {demand})"
                );
            }
        }
    }

    #[test]
    fn the_restock_price_is_the_target_shelf_bid_not_the_thin_one() {
        let (_, cost) = restock_plan(BASE, 1, BPS, u128::MAX);
        assert_eq!(cost, buy_price(BASE, RESTOCK_TARGET_STOCK, BPS));
        assert!(
            cost < buy_price(BASE, 1, BPS),
            "pricing at the thin shelf's own bid would be the trap"
        );
    }

    #[test]
    fn restocking_cannot_overflow() {
        let (units, cost) = restock_plan(u128::MAX, 0, u128::MAX, u128::MAX);
        assert!(units <= RESTOCK_TARGET_STOCK);
        assert!(cost > 0);
    }
}

// ---------------------------------------------------------------- backing

/// Share of a sale's **margin** that goes to a merchant's backer while its
/// stake is still outstanding.
///
/// Half, so the shop keeps growing while it repays. A backer who took all the
/// margin would leave the merchant unable to restock, which is how a rescue
/// turns into a slow second bankruptcy.
pub const BACKER_SHARE_BPS: u128 = 5_000;

/// Margin on a sale, from what the buyer paid and what the goods cost.
///
/// **Saturating, and that is the whole point.** A merchant that restocked a
/// thin shelf at a scarcity price and then sold into a glut made a LOSS, and the
/// tempting shortcut — `margin = paid * 20%`, the merchant's spread — would pay
/// a backer out of its principal in exactly that case. Weighted-average cost
/// basis cannot: it bottoms out at zero and pays nothing.
pub fn margin(paid: u128, cost_of_goods: u128) -> u128 {
    paid.saturating_sub(cost_of_goods)
}

/// What the goods in a sale of `count` units cost, by weighted average.
///
/// Weighted average rather than FIFO because a shelf is fungible: NEP-245
/// balances carry no acquisition lot, so there is nothing to queue. It also
/// keeps this O(1), which matters inside a callback with a fixed gas budget.
pub fn cost_of_goods(basis_total: u128, stock_before: u128, count: u128) -> u128 {
    if stock_before == 0 || basis_total == 0 {
        return 0;
    }
    let count = count.min(stock_before);
    basis_total * count / stock_before
}

/// What a backer is actually paid out of one sale's margin: its share, capped by
/// what it is still owed and by what the merchant can pay without closing.
pub fn backer_payout(margin: u128, owed: u128, spare: u128) -> u128 {
    (margin * BACKER_SHARE_BPS / BPS).min(owed).min(spare)
}

#[cfg(test)]
mod backing_tests {
    use super::*;

    #[test]
    fn a_sale_at_a_loss_pays_the_backer_nothing() {
        // Restocked 100 units for 500, so 5 each. Sold 10 into a glut for 30.
        let cogs = cost_of_goods(500, 100, 10);
        assert_eq!(cogs, 50);
        assert_eq!(margin(30, cogs), 0, "a loss is zero margin, never negative");
        assert_eq!(backer_payout(margin(30, cogs), 1_000, 1_000), 0);
    }

    #[test]
    fn the_backer_takes_half_the_margin_and_no_more() {
        let cogs = cost_of_goods(500, 100, 10); // 50
        let m = margin(150, cogs); // 100
        assert_eq!(backer_payout(m, 1_000, 1_000), 50);
    }

    #[test]
    fn the_payout_stops_at_what_is_still_owed() {
        assert_eq!(backer_payout(1_000, 20, 1_000), 20, "never more than the claim");
    }

    #[test]
    fn the_payout_never_pushes_a_merchant_below_its_floor() {
        // `spare` is treasury above floor. Paying a backer into the floor would
        // close the shop, which is a perverse way to reward investing in it.
        assert_eq!(backer_payout(1_000, 1_000, 7), 7);
    }

    #[test]
    fn unrecorded_basis_reads_as_free_rather_than_as_profit_on_everything() {
        // Stock that predates cost-basis recording has basis 0. That makes the
        // whole sale look like margin — generous to the backer, but it cannot
        // overpay, because the claim and the spare both cap it.
        assert_eq!(cost_of_goods(0, 100, 10), 0);
        assert_eq!(margin(100, 0), 100);
    }

    #[test]
    fn selling_the_whole_shelf_consumes_the_whole_basis() {
        assert_eq!(cost_of_goods(500, 100, 100), 500);
        // And a count beyond the shelf cannot claim more than the shelf cost.
        assert_eq!(cost_of_goods(500, 100, 250), 500);
    }

    #[test]
    fn cost_of_goods_cannot_divide_by_an_empty_shelf() {
        assert_eq!(cost_of_goods(500, 0, 10), 0);
    }
}
