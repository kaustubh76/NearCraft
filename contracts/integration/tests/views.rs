//! Every view method must actually be callable as a view.
//!
//! nearcore forbids a handful of host functions in a view context —
//! `env::predecessor_account_id()` among them. A `&self` method that calls one
//! compiles cleanly, passes every unit test, and then fails for *every real
//! caller* with `HostError(ProhibitedInView)`.
//!
//! Unit tests structurally cannot catch this: `testing_env!` always supplies a
//! predecessor, so the method works perfectly in a test and only breaks over
//! RPC. `mt_is_approved` shipped with exactly that bug, and it was found by
//! calling the *deployed* contract by hand — not by anything in this suite.
//! This test is what should have found it.
//!
//! It asserts the weak property on purpose. A view that panics with a contract
//! message is fine: it was reached, and refusing bad arguments is its job. The
//! only failure here is a view that cannot be *entered* as a view at all.

mod common;

use common::{wasm, World, IRON, OAK};
use near_workspaces::types::NearToken;
use near_workspaces::Contract;
use serde_json::json;

/// The host functions nearcore refuses inside a view call. A method reaching
/// for any of them is unreachable for every client, including a judge with curl.
const PROHIBITED: &str = "ProhibitedInView";

/// The view method names a contract's compiled ABI declares.
///
/// Read from the same build directory `wasm()` reads, so the two cannot
/// disagree about which build is under test.
fn abi_view_names(crate_name: &str) -> anyhow::Result<Vec<String>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/near")
        .join(crate_name)
        .join(format!("{crate_name}_abi.json"));
    let text = std::fs::read_to_string(&path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read {}: {e}\n\nBuild the contracts first:\n    npm run build:contracts",
            path.display()
        )
    })?;
    let abi: serde_json::Value = serde_json::from_str(&text)?;
    Ok(abi["body"]["functions"]
        .as_array()
        .map(|fns| {
            fns.iter()
                .filter(|f| f["kind"] == "view")
                .filter_map(|f| f["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

#[tokio::test]
async fn every_view_method_is_callable_as_a_view() -> anyhow::Result<()> {
    let world = World::setup().await?;

    // The guard is not part of `World`, so stand one up here — otherwise a
    // third of the project's view surface would go unchecked.
    let guard_account = world
        .root
        .create_subaccount("guard")
        .initial_balance(NearToken::from_near(3))
        .transact()
        .await?
        .into_result()?;
    let guard = guard_account.deploy(&wasm("nearcraft_guard")?).await?.into_result()?;
    guard.call("new").args_json(json!({})).transact().await?.into_result()?;

    let who = world.root.id().to_string();
    let merchant = world.ironmonger.id().to_string();
    let market_id = world.market.id().to_string();

    // Every view the three contracts expose, with arguments good enough to
    // enter the method. The coverage assertion after the loop is what keeps
    // this list honest — see the note there.
    let cases: Vec<(&Contract, &str, serde_json::Value)> = vec![
        // ----------------------------------------------------------- items
        (&world.items, "contract_source_metadata", json!({})),
        (&world.items, "mt_owner", json!({})),
        (&world.items, "mt_balance_of", json!({ "account_id": market_id, "token_id": IRON })),
        (&world.items, "mt_batch_balance_of", json!({ "account_id": market_id, "token_ids": [IRON, OAK] })),
        (&world.items, "mt_supply", json!({ "token_id": IRON })),
        (&world.items, "mt_batch_supply", json!({ "token_ids": [IRON, OAK] })),
        (&world.items, "mt_token", json!({ "token_ids": [IRON] })),
        (&world.items, "mt_tokens", json!({ "from_index": "0", "limit": 10 })),
        (&world.items, "mt_tokens_for_owner", json!({ "account_id": market_id, "from_index": "0", "limit": 10 })),
        (&world.items, "mt_token_approval", json!({ "token_id": IRON, "account_id": market_id })),
        // THE one that was broken. Left in the list rather than given a test of
        // its own, because the bug was never specific to it.
        (&world.items, "mt_is_approved", json!({
            "token_ids": [IRON], "approved_account_id": market_id,
            "amounts": ["1"], "approval_ids": null, "owner_id": who,
        })),
        // ---------------------------------------------------------- market
        (&world.market, "contract_source_metadata", json!({})),
        (&world.market, "items_contract", json!({})),
        (&world.market, "merchants", json!({})),
        (&world.market, "merchant", json!({ "merchant_id": merchant })),
        (&world.market, "is_closed", json!({ "merchant_id": merchant })),
        (&world.market, "credit_of", json!({ "account_id": who })),
        (&world.market, "quote", json!({ "merchant_id": merchant, "item": IRON, "count": 1 })),
        (&world.market, "quotes", json!({ "item": IRON, "count": 1 })),
        (&world.market, "ledger_total", json!({})),
        (&world.market, "basis_of", json!({ "merchant_id": merchant, "item": IRON })),
        (&world.market, "backer_of", json!({ "merchant_id": merchant })),
        // ----------------------------------------------------------- guard
        (&guard, "contract_source_metadata", json!({})),
        (&guard, "threshold", json!({})),
        (&guard, "blocked", json!({ "from_index": "0", "limit": 10 })),
        (&guard, "is_reported", json!({ "account_id": who })),
        (&guard, "reporter_count", json!({ "account_id": who })),
        (&guard, "reports_for", json!({ "account_id": who })),
        (&guard, "summary", json!({ "account_id": who })),
    ];

    println!("\n--- calling {} view methods as real view calls ---", cases.len());

    // Collect every offender rather than stopping at the first, so one run
    // names the whole problem.
    let mut unreachable = Vec::new();
    for (contract, method, args) in &cases {
        match contract.view(method).args_json(args).await {
            Ok(_) => println!("  ok        {}.{method}", contract.id()),
            Err(e) => {
                let text = format!("{e:?}");
                if text.contains(PROHIBITED) {
                    println!("  UNUSABLE  {}.{method}  <- {PROHIBITED}", contract.id());
                    unreachable.push(format!("{}.{method}", contract.id()));
                } else {
                    // A contract panic means the method was entered and chose to
                    // refuse these arguments. That is not the bug under test.
                    let first = text.lines().next().unwrap_or("").trim().to_string();
                    println!("  panicked  {}.{method}  (reached, refused args: {first})", contract.id());
                }
            }
        }
    }

    // The list above has to cover EVERY view the ABI declares.
    //
    // This used to be a comment claiming the list was "taken from the compiled
    // ABI", with nothing enforcing it — so `ledger_total`, added later, was
    // silently never called here, and this check quietly stopped covering the
    // method whose whole purpose is to be callable from outside. A list that can
    // fall behind in silence is the same defect as a check that cannot fail.
    let mut uncovered = Vec::new();
    for (crate_name, contract) in [
        ("nearcraft_items", &world.items),
        ("nearcraft_market", &world.market),
        ("nearcraft_guard", &guard),
    ] {
        for name in abi_view_names(crate_name)? {
            if !cases.iter().any(|(c, m, _)| c.id() == contract.id() && *m == name) {
                uncovered.push(format!("{crate_name}.{name}"));
            }
        }
    }
    assert!(
        uncovered.is_empty(),
        "these views exist in the compiled ABI but are never called by this test, \
         so nothing here would notice if they became unreachable: {uncovered:?}"
    );
    println!("  covered every view the ABI declares");

    assert!(
        unreachable.is_empty(),
        "these view methods cannot be called as views at all, so no client can ever \
         use them — almost certainly an env:: call that nearcore forbids in a view \
         context: {unreachable:?}"
    );
    Ok(())
}
