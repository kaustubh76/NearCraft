//! The cross-contract paths, against a real local NEAR node.
//!
//!   cargo test --test economy -- --nocapture
//!
//! Unit tests cannot reach any of this: a `Promise` does not resolve in a unit
//! test, so the `mt_transfer` a purchase depends on, the rollback callback when
//! that transfer fails, and the `mt_transfer_call` → `mt_on_transfer` sale path
//! are all invisible to them. This is where the two-contract design is actually
//! checked.

mod common;

use common::{World, IRON};
use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn a_purchase_moves_materials_across_contracts() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    let total = world.quote_total(IRON, 10).await?;
    let treasury_before = world.merchant_treasury().await?;

    player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 10 }))
        .deposit(NearToken::from_yoctonear(total))
        .max_gas()
        .transact().await?.into_result()?;

    let held = world.balance_of(&player, IRON).await?;
    println!("\n--- purchase across two contracts ---");
    println!("  paid {total} yoctoNEAR, received {held} {IRON}");
    println!("  shelf now {}, merchant treasury +{}", world.stock_of(IRON).await?,
             world.merchant_treasury().await? - treasury_before);

    assert_eq!(held, 10, "the materials must actually arrive via NEP-245");
    assert_eq!(world.stock_of(IRON).await?, 246);
    assert_eq!(world.merchant_treasury().await?, treasury_before + total);
    Ok(())
}

/// The rollback path. The shelf is bookkeeping in the market contract; the
/// materials are NEP-245 balances in the items contract. If those ever diverge —
/// which is exactly what a bug or a partial deploy would cause — a purchase must
/// not take the player's money and deliver nothing.
#[tokio::test]
async fn a_failed_delivery_rolls_the_whole_purchase_back() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    // Advertise a material the market has no tokens of: the shelf claims 64,
    // the items contract holds none.
    world.root.call(world.market.id(), "list_item")
        .args_json(json!({
            "merchant_id": world.ironmonger.id(), "item": "glass",
            "base_price": NearToken::from_millinear(250).as_yoctonear().to_string(), "stock": "64",
        }))
        .transact().await?.into_result()?;

    let total: u128 = {
        let q: serde_json::Value = world.market.view("quote")
            .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": "glass", "count": 4 }))
            .await?.json()?;
        q["total"].as_str().unwrap().parse()?
    };
    let treasury_before = world.merchant_treasury().await?;

    let outcome = player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": "glass", "count": 4 }))
        .deposit(NearToken::from_yoctonear(total))
        .max_gas()
        .transact().await?;

    // The outer call succeeds — the rollback is the contract handling the inner
    // failure, not the transaction aborting.
    let logs = outcome.logs().join(" | ");
    println!("\n--- delivery failed, purchase rolled back ---");
    println!("  logs: {}", logs.chars().take(200).collect::<String>());

    let credited = world.credit_of(&player).await?;
    println!("  player holds {} glass, credited {credited} yoctoNEAR",
             world.balance_of(&player, "glass").await?);

    assert_eq!(world.balance_of(&player, "glass").await?, 0, "nothing was delivered");
    assert_eq!(credited, total, "the player must be made whole");
    assert_eq!(world.merchant_treasury().await?, treasury_before, "the merchant keeps nothing");
    assert!(logs.contains("rolled back"), "the rollback must say so in the log");

    // And the shelf is restored, so the next buyer sees the same (wrong) stock
    // rather than a silently decremented one.
    let q: serde_json::Value = world.market.view("quote")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": "glass", "count": 1 }))
        .await?.json()?;
    assert_eq!(q["stock"].as_str().unwrap(), "64", "the shelf must be restored");
    Ok(())
}

/// Selling goes the other way, through NEP-245's own transfer-and-call hook:
/// the player sends materials to the market with the merchant id as `msg`.
#[tokio::test]
async fn a_sale_routes_through_mt_transfer_call() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    // Buy first so the player has something to sell.
    let total = world.quote_total(IRON, 20).await?;
    player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 20 }))
        .deposit(NearToken::from_yoctonear(total)).max_gas().transact().await?.into_result()?;

    let bid = world.merchant_bid(IRON).await?.expect("an open merchant posts a bid");
    let treasury_before = world.merchant_treasury().await?;
    let credit_before = world.credit_of(&player).await?;

    player.call(world.items.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": world.market.id(), "token_id": IRON, "amount": "12",
            "approval": null, "memo": null, "msg": world.ironmonger.id(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact().await?.into_result()?;

    let proceeds = world.credit_of(&player).await? - credit_before;
    println!("\n--- sale via mt_transfer_call -> mt_on_transfer ---");
    println!("  sold 12 {IRON} at a bid of {bid}, proceeds {proceeds}");
    println!("  player holds {} {IRON}, shelf {}", world.balance_of(&player, IRON).await?, world.stock_of(IRON).await?);

    assert_eq!(world.balance_of(&player, IRON).await?, 8, "12 of 20 left the player");
    assert_eq!(proceeds, bid * 12, "paid at the posted bid");
    assert!(world.merchant_treasury().await? < treasury_before, "the merchant paid for them");
    Ok(())
}

/// A closed merchant refuses the lot, and NEP-245's resolver hands the materials
/// back automatically. The player loses nothing by trying.
#[tokio::test]
async fn a_closed_merchant_refuses_a_sale_and_the_materials_come_back() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    let total = world.quote_total(IRON, 6).await?;
    player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 6 }))
        .deposit(NearToken::from_yoctonear(total)).max_gas().transact().await?.into_result()?;

    // Strip the merchant to its floor so it stops bidding.
    world.ironmonger.call(world.market.id(), "withdraw_treasury")
        .max_gas().transact().await?.into_result()?;
    assert!(world.is_closed().await?, "the merchant should now be closed");

    let credit_before = world.credit_of(&player).await?;
    player.call(world.items.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": world.market.id(), "token_id": IRON, "amount": "6",
            "approval": null, "memo": null, "msg": world.ironmonger.id(),
        }))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;

    println!("\n--- closed merchant refuses, resolver refunds ---");
    println!("  player still holds {} {IRON}, credit unchanged: {}",
             world.balance_of(&player, IRON).await?,
             world.credit_of(&player).await? == credit_before);

    assert_eq!(world.balance_of(&player, IRON).await?, 6, "the materials came back");
    assert_eq!(world.credit_of(&player).await?, credit_before, "and nothing was paid");
    Ok(())
}

#[tokio::test]
async fn withdrawals_move_real_near() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;

    // Give the player a credit balance by selling into the merchant.
    let total = world.quote_total(IRON, 10).await?;
    player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 10 }))
        .deposit(NearToken::from_yoctonear(total)).max_gas().transact().await?.into_result()?;
    player.call(world.items.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": world.market.id(), "token_id": IRON, "amount": "10",
            "approval": null, "memo": null, "msg": world.ironmonger.id(),
        }))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;

    let credit = world.credit_of(&player).await?;
    assert!(credit > 0, "the sale should have credited the player");
    let before = player.view_account().await?.balance.as_yoctonear();

    player.call(world.market.id(), "withdraw").max_gas().transact().await?.into_result()?;

    let after = player.view_account().await?.balance.as_yoctonear();
    println!("\n--- withdrawal ---");
    println!("  credit {credit} yoctoNEAR; account balance {before} -> {after}");
    assert_eq!(world.credit_of(&player).await?, 0, "credit cleared");
    // Gas comes out of the same balance, so assert the credit dominates it.
    assert!(after > before, "the withdrawal must outweigh its own gas");

    // A second withdrawal has nothing to take.
    let again = player.call(world.market.id(), "withdraw").max_gas().transact().await?;
    assert!(again.is_failure(), "withdrawing twice must fail, not pay twice");
    println!("  second withdrawal refused\n");
    Ok(())
}

/// Flood a merchant until it stops buying — the "broke merchant closes" rule,
/// driven deterministically.
///
/// The simulation reports closures rather than requiring one, because whether a
/// short run drives a merchant under depends on which materials its dumpers
/// happen to cycle through. That would make a flaky assertion in the headline
/// artifact. This test removes the chance: it sells into an undercapitalised
/// merchant until the contract says it is closed, and bounds how long that takes.
#[tokio::test]
async fn a_merchant_can_be_flooded_until_it_stops_buying() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let player = world.root.create_subaccount("player")
        .initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;

    // A second merchant that opened with very little working capital.
    let pauper = world.root.create_subaccount("pauper")
        .initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    world.root.call(world.market.id(), "register_merchant")
        .args_json(json!({ "merchant_id": pauper.id(), "name": "Pauper", "floor": "0" }))
        .transact().await?.into_result()?;
    world.root.call(world.market.id(), "fund_merchant")
        .args_json(json!({ "merchant_id": pauper.id() }))
        .deposit(NearToken::from_millinear(1_500))   // 1.5 NEAR, floor 0
        .transact().await?.into_result()?;
    world.root.call(world.market.id(), "list_item")
        .args_json(json!({
            "merchant_id": pauper.id(), "item": IRON,
            "base_price": NearToken::from_millinear(400).as_yoctonear().to_string(),
            "stock": "256",
        }))
        .transact().await?.into_result()?;

    // Stock the player up from the solvent merchant.
    let total = world.quote_total(IRON, 40).await?;
    player.call(world.market.id(), "buy")
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 40 }))
        .deposit(NearToken::from_yoctonear(total)).max_gas().transact().await?.into_result()?;

    let is_closed = |id: String| {
        let market = world.market.clone();
        async move {
            let shut: bool = market.view("is_closed")
                .args_json(json!({ "merchant_id": id })).await?.json::<bool>()?;
            Ok::<bool, anyhow::Error>(shut)
        }
    };

    assert!(!is_closed(pauper.id().to_string()).await?, "it should open able to buy");

    println!("\n--- flooding an undercapitalised merchant ---");
    let mut lots = 0;
    for _ in 0..10 {
        if is_closed(pauper.id().to_string()).await? { break }
        player.call(world.items.id(), "mt_transfer_call")
            .args_json(json!({
                "receiver_id": world.market.id(), "token_id": IRON, "amount": "4",
                "approval": null, "memo": null, "msg": pauper.id(),
            }))
            .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
        lots += 1;
        let m: serde_json::Value = world.market.view("merchant")
            .args_json(json!({ "merchant_id": pauper.id() })).await?.json()?;
        println!("  after lot {lots}: treasury {} yoctoNEAR", m["treasury"].as_str().unwrap());
    }

    assert!(is_closed(pauper.id().to_string()).await?,
        "a 1.5 NEAR merchant should be exhausted within 10 lots; it was not after {lots}");
    println!("  closed after {lots} lot(s)");

    // Closed means it stops *buying*. It must still sell what it holds.
    let q: serde_json::Value = world.market.view("quote")
        .args_json(json!({ "merchant_id": pauper.id(), "item": IRON, "count": 1 })).await?.json()?;
    assert!(q["merchant_bid"].is_null(), "a closed merchant posts no bid");
    assert!(q["unit_price"].as_str().unwrap().parse::<u128>()? > 0, "but it still sells");
    println!("  posts no bid, still sells: \"{}\"\n", q["reason"].as_str().unwrap());

    // And it refuses any further lot outright, so the seller keeps their goods.
    let held_before = world.balance_of(&player, IRON).await?;
    player.call(world.items.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": world.market.id(), "token_id": IRON, "amount": "4",
            "approval": null, "memo": null, "msg": pauper.id(),
        }))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    assert_eq!(world.balance_of(&player, IRON).await?, held_before,
        "a refused lot must come back to the seller");
    Ok(())
}
