//! The fast-forward economy run: many rounds of trading, compressed.
//!
//!   npm run sim        (= cargo test --test simulation -- --nocapture)
//!
//! Scripted strategies, **no model calls**, against a real local NEAR node. No
//! credentials, no faucet, no testnet, no Minecraft.
//!
//! ## What "fast-forward" means here, precisely
//!
//! The `games` prompt asks for "a week of trading in about a minute". What this
//! compresses is **trading volume**: a few hundred real transactions that would
//! take a populated server days to generate, run in about a minute.
//!
//! It does **not** advance a week of block height. `worker.fast_forward()` in the
//! sandbox produces blocks rather than jumping, and a week is 604,800 of them —
//! measured as far too slow to be part of a test. Demand decay, the one
//! time-dependent mechanic, is exercised by the unit tests in
//! `contracts/market/src/pricing.rs`, which drive `decay_demand` with a
//! synthetic `elapsed_ns` — so the arithmetic is proved but **not** against
//! real sandbox block time. Saying "a week of wall-clock time" would be a claim
//! this does not support.
//!
//! (An earlier version of this comment pointed at a `decay.rs` in this
//! directory. No such file was ever written.)

mod common;

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;
use std::collections::BTreeMap;

const ROUNDS: usize = 8;

/// Prepaid gas per trade. NOT max_gas(): prepaid gas is what reserves room in a
/// chunk, and nearcore's per-chunk limit is 1000 TGas — so 300 TGas per call
/// caps a block at three trades however many buyers are ready. These are
/// ceilings measured from the receipts, with headroom.
///
/// `buy` is market -> items.mt_transfer -> on_items_delivered.
/// A sale is items.mt_transfer_call -> market.mt_on_transfer -> mt_resolve_transfer,
/// which is one receipt deeper.
/// Slippage tolerance, in basis points.
///
/// Concurrent buyers all read the same quote, and the first one to clear moves
/// the price — stock down, demand up. A deposit sized exactly to the quote is
/// therefore refused by the time it executes, which is the contract being right,
/// not a bug: `require!(paid >= total)`. A real buyer tolerates a little
/// slippage, and overpayment is credited straight back, so the buffer costs
/// nothing.
///
/// Note what this does NOT do: the decision to buy at all is still judged on the
/// quoted unit price, so a bargain-hunter stays a bargain-hunter. The buffer
/// only covers execution.
const SLIPPAGE_BPS: u128 = 2_000;

const BUY_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(100);
const SELL_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(150);
const BUYERS: usize = 20;

/// Materials and their base prices, mirroring config/catalog.json.
const MATERIALS: &[(&str, u128)] = &[
    ("iron_ingot", 400),   // millinear
    ("oak_log", 100),
    ("stone", 50),
    ("coal", 150),
];

/// Merchant name, opening treasury in **millinear**, and stock per material.
/// Millinear because a merchant that opens undercapitalised needs sub-NEAR precision.
const MERCHANTS: &[(&str, u128, &[(&str, u64)])] = &[
    ("ironmonger", 30_000, &[("iron_ingot", 256), ("coal", 512)]),
    ("timberwright", 30_000, &[("oak_log", 1024), ("stone", 256)]),
    ("stonecutter", 25_000, &[("stone", 2048), ("iron_ingot", 64)]),
    ("collier", 3_000, &[("coal", 256)]),      // thin, but trades its way clear — the contrast case
    // Opens barely above its 1 NEAR floor, so a single lot sold into it
    // exhausts what it can pay with and it withdraws its bid. A merchant that
    // sells briskly is net-positive and cannot go broke, so demonstrating the
    // rule needs one that opened undercapitalised — which is also the realistic
    // case the rule exists for.
    ("chandler", 1_500, &[("oak_log", 128)]),  // millinear, not NEAR — see open()
];

/// How each buyer decides. Deliberately a few lines of arithmetic each — the
/// mechanism under test is the market, not a language model's taste.
#[derive(Clone, Copy, Debug)]
enum Strategy {
    /// Buys only when the price is at or below base.
    Bargain,
    /// Always buys from whoever is cheapest.
    Greedy,
    /// Buys every round regardless of price.
    Hoarder,
    /// Buys cheap, then sells back once a merchant's bid beats what it paid.
    Flipper,
    /// Buys on a fixed cycle, ignoring price entirely.
    Noise,
    /// The arbitrageur. Buys wherever it is cheapest and dumps into whichever
    /// merchant bids highest, without checking its own profit. A thin merchant
    /// posts the best bid precisely because it is short of stock, so this is the
    /// pressure that drains one to its floor — the "flood a merchant and watch
    /// it close" behaviour GAME_LOOP.md describes.
    Dumper,
}

impl Strategy {
    fn of(i: usize) -> Self {
        match i % 6 {
            0 => Self::Bargain,
            1 => Self::Greedy,
            2 => Self::Hoarder,
            3 => Self::Flipper,
            4 => Self::Noise,
            _ => Self::Dumper,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Bargain => "bargain",
            Self::Greedy => "greedy",
            Self::Hoarder => "hoarder",
            Self::Flipper => "flipper",
            Self::Noise => "noise",
            Self::Dumper => "dumper",
        }
    }
}

struct Market {
    /// Held for its lifetime, not read: dropping the worker kills the sandbox
    /// node and every subsequent call would fail.
    #[allow(dead_code)]
    worker: Worker<Sandbox>,
    items: Contract,
    market: Contract,
    root: Account,
    merchants: Vec<(String, Account)>,
}

fn wasm(name: &str) -> anyhow::Result<Vec<u8>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/near").join(name).join(format!("{name}.wasm"));
    std::fs::read(&path).map_err(|e| anyhow::anyhow!(
        "cannot read {}: {e}\n\nBuild first:  npm run build:contracts", path.display()))
}

impl Market {
    /// Funded from the sandbox **root** account, not a dev account: a dev account
    /// holds 100 NEAR and five funded merchants plus twenty buyers needs more.
    async fn open() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let items_acc = root.create_subaccount("items")
            .initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
        let market_acc = root.create_subaccount("market")
            .initial_balance(NearToken::from_near(40)).transact().await?.into_result()?;

        let items = items_acc.deploy(&wasm("nearcraft_items")?).await?.into_result()?;
        let market = market_acc.deploy(&wasm("nearcraft_market")?).await?.into_result()?;

        items.call("new").args_json(json!({ "owner_id": market.id() }))
            .transact().await?.into_result()?;
        market.call("new")
            .args_json(json!({ "owner_id": root.id(), "items_contract": items.id() }))
            .transact().await?.into_result()?;

        for (token_id, _) in MATERIALS {
            market.as_account().call(items.id(), "mt_mint")
                .args_json(json!({ "token_id": token_id, "amount": "1000000", "receiver_id": market.id() }))
                .transact().await?.into_result()?;
        }

        let mut merchants = Vec::new();
        for (name, treasury, shelves) in MERCHANTS {
            let acc = root.create_subaccount(name)
                .initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
            root.call(market.id(), "register_merchant")
                .args_json(json!({
                    "merchant_id": acc.id(), "name": name,
                    "floor": NearToken::from_near(1).as_yoctonear().to_string(),
                }))
                .transact().await?.into_result()?;
            root.call(market.id(), "fund_merchant")
                .args_json(json!({ "merchant_id": acc.id() }))
                .deposit(NearToken::from_millinear(*treasury))
                .transact().await?.into_result()?;
            for (item, stock) in *shelves {
                let base = MATERIALS.iter().find(|(m, _)| m == item).unwrap().1;
                root.call(market.id(), "list_item")
                    .args_json(json!({
                        "merchant_id": acc.id(), "item": item,
                        "base_price": NearToken::from_millinear(base).as_yoctonear().to_string(),
                        "stock": stock.to_string(),
                    }))
                    .transact().await?.into_result()?;
            }
            merchants.push((name.to_string(), acc));
        }
        Ok(Self { worker, items, market, root, merchants })
    }

    async fn quotes(&self, item: &str, count: u32) -> anyhow::Result<Vec<serde_json::Value>> {
        Ok(self.market.view("quotes")
            .args_json(json!({ "item": item, "count": count })).await?.json()?)
    }

    async fn credit_of(&self, who: &Account) -> anyhow::Result<u128> {
        let c: String = self.market.view("credit_of")
            .args_json(json!({ "account_id": who.id() })).await?.json()?;
        Ok(c.parse()?)
    }

    async fn treasury_of(&self, id: &str) -> anyhow::Result<u128> {
        let m: serde_json::Value = self.market.view("merchant")
            .args_json(json!({ "merchant_id": id })).await?.json()?;
        Ok(m["treasury"].as_str().unwrap().parse()?)
    }

    /// Ask the contract, rather than reimplementing its rule here: `is_closed`
    /// means the merchant posts no buy price on anything it stocks.
    async fn closed_count(&self) -> anyhow::Result<usize> {
        let mut closed = 0;
        for (_, acc) in &self.merchants {
            let shut: bool = self.market.view("is_closed")
                .args_json(json!({ "merchant_id": acc.id() })).await?.json()?;
            if shut { closed += 1 }
        }
        Ok(closed)
    }
}

fn near(y: u128) -> String {
    format!("{:.3}", y as f64 / 1e24)
}

#[tokio::test]
async fn a_scripted_economy_moves_without_a_single_model_call() -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let m = Market::open().await?;

    // Twenty buyers, each with its own named sub-account and its own budget.
    // Created concurrently — twenty account creations in sequence was several
    // seconds of the wall clock this run is measured by.
    let created = futures::future::join_all((0..BUYERS).map(|i| {
        let root = m.root.clone();
        async move {
            root.create_subaccount(&format!("buyer-{i}"))
                .initial_balance(NearToken::from_near(12))
                .transact().await?.into_result().map_err(anyhow::Error::from)
        }
    })).await;

    let mut buyers = Vec::new();
    for (i, acc) in created.into_iter().enumerate() {
        buyers.push((Strategy::of(i), acc?, 0u128 /* spent */, BTreeMap::<String, (u64, u128)>::new()));
    }
    println!("\n{BUYERS} buyers, {} merchants, {} materials, {ROUNDS} rounds, no model calls\n",
             MERCHANTS.len(), MATERIALS.len());
    println!("{:>5}  {:>7}  {:>6}  {:>8}  {:>9}  {:>9}  {:>8}  {}",
             "round", "trades", "sales", "refused", "restocks", "volume", "closed", "cheapest iron / oak");
    println!("{}", "-".repeat(100));

    let mut total_trades = 0u32;
    let mut total_sales = 0u32;
    let mut volume = 0u128;
    let mut total_refused = 0u32;
    let mut total_restocks = 0u32;
    let mut first_closure: Option<usize> = None;

    for round in 1..=ROUNDS {
        let mut trades = 0u32;
        let mut sales = 0u32;
        let mut refused = 0u32;

        // Every buyer's turn runs concurrently. They are separate accounts with
        // separate access keys, so their nonces cannot collide — which is what
        // makes this safe, and is also why the merchants' own calls stay serial.
        //
        // It is a better model of the game too: twenty players in a market town
        // act at the same time and all see the same prices, rather than queuing
        // politely while each one's transaction clears.
        let turns = std::mem::take(&mut buyers).into_iter().enumerate().map(|(idx, state)| {
            let m = &m;
            async move {
                let (strategy, buyer, mut spent, mut held) = state;
                let mut trades = 0u32;
                let mut sales = 0u32;
                let mut vol = 0u128;
                let mut refused = 0u32;

                let item = MATERIALS[(round + idx) % MATERIALS.len()].0;
                let base = MATERIALS.iter().find(|(x, _)| *x == item).unwrap().1;
                let base_yocto = NearToken::from_millinear(base).as_yoctonear();

                let mut quotes = m.quotes(item, 4).await?;
                quotes.retain(|q| q["stock"].as_str().unwrap().parse::<u128>().unwrap() >= 4);
                if quotes.is_empty() {
                    return Ok(((strategy, buyer, spent, held), trades, sales, vol, refused));
                }
                quotes.sort_by_key(|q| q["unit_price"].as_str().unwrap().parse::<u128>().unwrap());
                let best = &quotes[0];
                let unit: u128 = best["unit_price"].as_str().unwrap().parse()?;
                let total: u128 = best["total"].as_str().unwrap().parse()?;
                let merchant = best["merchant_id"].as_str().unwrap().to_string();

                let buy = match strategy {
                    Strategy::Bargain => unit <= base_yocto,
                    Strategy::Greedy => true,
                    Strategy::Hoarder => true,
                    Strategy::Flipper => unit < base_yocto * 11 / 10,
                    Strategy::Noise => (round + idx) % 3 != 0,
                    Strategy::Dumper => true,
                };

                let offered = total * (10_000 + SLIPPAGE_BPS) / 10_000;
                if buy && buyer.view_account().await?.balance.as_yoctonear() > offered + NearToken::from_near(2).as_yoctonear() {
                    let outcome = buyer.call(m.market.id(), "buy")
                        .args_json(json!({ "merchant_id": merchant, "item": item, "count": 4 }))
                        .deposit(NearToken::from_yoctonear(offered))
                        .gas(BUY_GAS).transact().await?;
                    if outcome.is_success() {
                        trades += 1;
                        // What the purchase cost is the quoted total; anything
                        // over it came back as credit.
                        spent += total;
                        vol += total;
                        // Remember the unit price paid: a flipper needs it to judge a sale.
                        let e = held.entry(item.to_string()).or_insert((0, unit));
                        e.0 += 4;
                        e.1 = unit; // most recent cost basis
                    } else {
                        // The market refused it — almost always a quote that
                        // went stale while a simultaneous buyer cleared first.
                        // Counted rather than swallowed, because a silent drop
                        // is how the first parallel run lost 86 trades without
                        // saying so.
                        refused += 1;
                    }
                }

                // A flipper sells back once some merchant's bid beats what it paid.
                // It shops the bids, so the best bid wins — and the best bid comes
                // from whichever merchant is thinnest on stock, which is how a thin
                // merchant gets drained and eventually closes.
                if matches!(strategy, Strategy::Flipper | Strategy::Dumper) {
                    if let Some((count, paid)) = held.get(item).copied().filter(|(c, _)| *c >= 4) {
                        let mut bids: Vec<(u128, String)> = quotes
                            .iter()
                            .filter_map(|q| {
                                let bid = q["merchant_bid"].as_str()?.parse::<u128>().ok()?;
                                Some((bid, q["merchant_id"].as_str()?.to_string()))
                            })
                            .collect();
                        bids.sort_by(|a, b| b.0.cmp(&a.0));
                        if let Some((bid, to)) = bids.first() {
                            // A flipper needs a profit; a dumper does not care.
                            if *bid > paid || matches!(strategy, Strategy::Dumper) {
                                let sold = buyer.call(m.items.id(), "mt_transfer_call")
                                    .args_json(json!({
                                        "receiver_id": m.market.id(), "token_id": item, "amount": "4",
                                        "approval": null, "memo": null, "msg": to,
                                    }))
                                    .deposit(NearToken::from_yoctonear(1))
                                    .gas(SELL_GAS).transact().await?;
                                if sold.is_success() {
                                    sales += 1;
                                    held.insert(item.to_string(), (count - 4, paid));
                                }
                            }
                        }
                    }
                }

                Ok::<_, anyhow::Error>(((strategy, buyer, spent, held), trades, sales, vol, refused))
            }
        }).collect::<Vec<_>>();

        // join_all drives them all on this one task. The work is waiting on RPC,
        // not computing, so concurrency is the whole win — no threads needed.
        for result in futures::future::join_all(turns).await {
            let (state, t, s, v, r) = result?;
            buyers.push(state);
            trades += t;
            sales += s;
            volume += v;
            refused += r;
        }

        // ── anyone keeps the town alive ──────────────────────────────────────
        //
        // `restock` is permissionless and non-payable, so the market no longer
        // needs the contract owner to put goods back on a shelf — which is what
        // the `games` track means by an economy that evolves without a dev
        // patch. Here one buyer sweeps every shelf after each round; a thin one
        // refills itself out of its own treasury, a well-stocked one refuses.
        //
        // Concurrent, because it is 25 independent view-and-poke pairs and the
        // round above already established that buyers do not collide.
        let sweeps = MERCHANTS.iter().flat_map(|(name, _, shelves)| {
            shelves.iter().map(move |(item, _)| (*name, *item))
        }).map(|(name, item)| {
            let m = &m;
            let poker = &buyers[0].1;
            async move {
                let merchant_id = m.merchants.iter().find(|(n, _)| n == &name).map(|(_, a)| a.id().clone());
                let Some(merchant_id) = merchant_id else { return 0u32 };
                let outcome = poker
                    .call(m.market.id(), "restock")
                    .args_json(json!({ "merchant_id": merchant_id, "item": item }))
                    .gas(BUY_GAS)
                    .transact()
                    .await;
                // A refusal is the normal case — most shelves are above the
                // trigger — so it is counted, never treated as an error.
                match outcome {
                    Ok(o) if o.is_success() => 1,
                    _ => 0,
                }
            }
        }).collect::<Vec<_>>();
        let restocks: u32 = futures::future::join_all(sweeps).await.into_iter().sum();
        total_restocks += restocks;

        total_trades += trades;
        total_sales += sales;

        let iron = m.quotes("iron_ingot", 1).await?.into_iter()
            .map(|q| q["unit_price"].as_str().unwrap().parse::<u128>().unwrap()).min().unwrap_or(0);
        let oak = m.quotes("oak_log", 1).await?.into_iter()
            .map(|q| q["unit_price"].as_str().unwrap().parse::<u128>().unwrap()).min().unwrap_or(0);

        let closed_now = m.closed_count().await?;
        if closed_now > 0 && first_closure.is_none() {
            first_closure = Some(round);
        }
        println!("{:>5}  {:>7}  {:>6}  {:>8}  {:>9}  {:>9}  {:>8}  {} / {}",
                 round, trades, sales, refused, restocks, near(volume), closed_now, near(iron), near(oak));
        total_refused += refused;
    }

    // ---------------------------------------------------------------- report

    println!("\nmerchants");
    for (name, acc) in &m.merchants {
        let t = m.treasury_of(acc.id().as_str()).await?;
        let shelves = MERCHANTS.iter().find(|(n, _, _)| n == name).unwrap().2;
        let mut bids = Vec::new();
        for (item, _) in shelves {
            let quotes = m.quotes(item, 1).await?;
            let posts = quotes.iter().any(|q| {
                q["merchant_id"].as_str() == Some(acc.id().as_str()) && !q["merchant_bid"].is_null()
            });
            bids.push(format!("{item}:{}", if posts { "bidding" } else { "no bid" }));
        }
        let closed = !bids.iter().any(|b| b.ends_with("bidding"));
        println!("  {:<14} treasury {:>8} NEAR  {:<7}  {}",
                 name, near(t), if closed { "CLOSED" } else { "open" }, bids.join("  "));
    }

    println!("\nbuyers by strategy");
    let mut by_strategy: BTreeMap<&str, (u32, u128, u64, u128)> = BTreeMap::new();
    for (strategy, buyer, spent, held) in &buyers {
        // Credit is what a sell-back paid them, so flippers should be the only
        // strategy showing any.
        let earned = m.credit_of(buyer).await?;
        let e = by_strategy.entry(strategy.label()).or_default();
        e.0 += 1;
        e.1 += spent;
        e.2 += held.values().map(|(c, _)| *c).sum::<u64>();
        e.3 += earned;
    }
    for (label, (n, spent, goods, earned)) in &by_strategy {
        println!("  {:<9} x{}  spent {:>8}  earned {:>8}  holding {:>4} units",
                 label, n, near(*spent), near(*earned), goods);
    }

    let closed = m.closed_count().await?;
    println!("\n{total_trades} purchases, {total_sales} sell-backs, {total_restocks} merchant restocks, \
              {total_refused} refused on a stale quote, \
              {} NEAR of volume, {closed} merchant(s) closed{}, in {:.1}s of wall clock\n",
             near(volume),
             match first_closure { Some(r) => format!(" (first in round {r})"), None => String::new() },
             started.elapsed().as_secs_f64());

    // -------------------------------------------------------------- assertions

    // ------------------------------------------------------------- snapshot
    //
    // web/market.html renders this. It is real output from this run, not a
    // mock-up, and the page labels it as a simulation snapshot rather than
    // live chain data — because until something is deployed, that is what it is.
    {
        let mut materials = Vec::new();
        for (item, _) in MATERIALS {
            let quotes = m.quotes(item, 1).await?;
            materials.push(serde_json::json!({ "item": item, "quotes": quotes }));
        }
        let mut merchants = Vec::new();
        for (name, acc) in &m.merchants {
            let treasury = m.treasury_of(acc.id().as_str()).await?;
            let shut: bool = m.market.view("is_closed")
                .args_json(json!({ "merchant_id": acc.id() })).await?.json()?;
            merchants.push(serde_json::json!({
                "name": name, "account_id": acc.id(), "treasury": treasury.to_string(), "closed": shut,
            }));
        }
        let snapshot = serde_json::json!({
            "note": "Output of `npm run sim` against a local nearcore sandbox. Not live chain data.",
            "generated_at_unix": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
            "network": "local sandbox (near-workspaces)",
            "rounds": ROUNDS,
            "buyers": BUYERS,
            "purchases": total_trades,
            "sell_backs": total_sales,
            "volume_yocto": volume.to_string(),
            "wall_clock_seconds": started.elapsed().as_secs(),
            "merchants": merchants,
            "materials": materials,
            "strategies": by_strategy.iter().map(|(label, (n, spent, goods, earned))| serde_json::json!({
                "strategy": label, "agents": n,
                "spent_yocto": spent.to_string(), "earned_yocto": earned.to_string(), "units_held": goods,
            })).collect::<Vec<_>>(),
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/market-snapshot.json");
        std::fs::write(&path, serde_json::to_string_pretty(&snapshot)? + "\n")?;
        println!("snapshot -> web/market-snapshot.json");
    }

    assert!(total_trades > 40, "a {ROUNDS}-round run should produce real volume, got {total_trades}");
    assert!(volume > 0, "volume must be non-zero");

    // Prices must have responded to all that buying rather than sitting still.
    let iron_now = m.quotes("iron_ingot", 1).await?.into_iter()
        .map(|q| q["unit_price"].as_str().unwrap().parse::<u128>().unwrap()).min().unwrap();
    assert!(iron_now > NearToken::from_millinear(400).as_yoctonear(),
        "iron should have risen above its 0.4 base after {total_trades} trades, got {}", near(iron_now));

    // The round trip has to actually work, or "sell-backs" means nothing.
    assert!(total_sales > 0, "sell-backs must happen for the economy to be two-sided");

    // Strategies must diverge. If a price-sensitive buyer spends as much as one
    // that ignores price, the market is not transmitting any information.
    let bargain_spend = by_strategy.get("bargain").map(|e| e.1).unwrap_or(0);
    let hoarder_spend = by_strategy.get("hoarder").map(|e| e.1).unwrap_or(0);
    assert!(bargain_spend * 2 < hoarder_spend,
        "a bargain hunter should spend far less than a hoarder; got {} vs {}",
        near(bargain_spend), near(hoarder_spend));

    // Closures are REPORTED, not required. Whether a merchant is driven under
    // inside a short run depends on which materials the dumpers happen to cycle
    // through, so asserting one here would be flaky. The mechanic itself is
    // proved deterministically by `a_merchant_can_be_flooded_until_it_stops_buying`
    // in economy.rs and by the unit tests in market/src/lib.rs.
    println!("closures this run: {closed}{}",
             match first_closure { Some(r) => format!(", first in round {r}"), None => String::from(" (none; see economy.rs for the deterministic case)") });

    Ok(())
}
