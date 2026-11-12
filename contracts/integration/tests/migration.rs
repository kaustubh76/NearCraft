//! The state-migration mechanism, proven against the bytes testnet is running.
//!
//!   cargo test --test migration -- --nocapture
//!
//! Borsh contract state is positional. Adding a field to `Market` and deploying
//! makes every method **and every view** panic with "Cannot deserialize the
//! contract state", and a contract nobody can read is a contract nobody can
//! fix. `migrate` is the way out, and it has to run in the same transaction as
//! the deploy.
//!
//! Three things make this test worth more than a description of that:
//!
//! 1. It deploys **`fixtures/market-live.wasm`** — the bytes fetched from
//!    `market.nearcraftmc.testnet` with a public `view_code` call — so what is
//!    migrated is the code that is actually running, not a fresh build of it.
//!    The hash is pinned below and checked against what the node reports after
//!    deploying, so the fixture cannot be swapped quietly.
//! 2. It **breaks the contract first**, with a plain redeploy, and asserts a
//!    view really does fail. A migration test that never sees the failure it
//!    exists to prevent is a test that would pass on an identity migration —
//!    which is exactly why this release does not ship one.
//! 3. It proves `#[private]`. near-sdk emits that check only inside the
//!    `target_arch = "wasm32"` wrapper, so no unit test can reach it, and an
//!    un-private `migrate` would let anyone overwrite the contract's state.

mod common;

use common::{wasm, World, IRON};
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::ContractState;
use serde_json::json;

/// The `code_hash` that `market.nearcraftmc.testnet` reports, and therefore the
/// hash of the fixture.
///
/// Pinned rather than computed so that replacing the fixture with a convenient
/// local build is a loud failure. Re-pin it deliberately, when the live
/// contract's own shape moves on — see MarketV1's note in market/src/lib.rs.
const LIVE_MARKET_CODE_HASH: &str = "7KML46Pr78rCqEipQ1ch2tNkQ9ULfG6wtHg4PPuazBQJ";

fn live_market_wasm() -> anyhow::Result<Vec<u8>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/market-live.wasm");
    std::fs::read(&path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read {}: {e}\n\n\
             This is the wasm running on testnet, fetched with a view_code call. \
             It is committed; .gitignore's blanket *.wasm is negated for it.",
            path.display()
        )
    })
}

/// What the node says is deployed at the market account.
async fn deployed_hash(w: &World) -> anyhow::Result<String> {
    let details = w.worker.view_account(w.market.id()).await?;
    match details.contract_state {
        ContractState::LocalHash(h) => Ok(h.to_string()),
        other => anyhow::bail!("the market account holds no local contract: {other:?}"),
    }
}

/// A U128 view, decoded the way common/mod.rs already does it: NEAR's JSON
/// U128 is a decimal string, because 2^53 is not enough.
async fn u128_view(
    c: &near_workspaces::Contract,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<u128> {
    let s: String = c.view(method).args_json(args).await?.json()?;
    Ok(s.parse()?)
}

/// Everything that has to survive a migration, read through views.
#[derive(Debug, PartialEq, Eq)]
struct Facts {
    owed: u128,
    treasury: u128,
    stock: u128,
    credit: u128,
    quoted: u128,
}

async fn facts(w: &World, who: &near_workspaces::Account) -> anyhow::Result<Facts> {
    Ok(Facts {
        owed: u128_view(&w.market, "ledger_total", json!({})).await?,
        treasury: w.merchant_treasury().await?,
        stock: w.stock_of(IRON).await?,
        credit: w.credit_of(who).await?,
        quoted: w.quote_total(IRON, 3).await?,
    })
}

#[tokio::test]
async fn a_plain_redeploy_bricks_live_state_and_migrate_rescues_it() -> anyhow::Result<()> {
    let fixture = live_market_wasm()?;
    let w = World::setup_with_market_wasm(&fixture).await?;

    assert_eq!(
        deployed_hash(&w).await?,
        LIVE_MARKET_CODE_HASH,
        "the fixture is not the code testnet is running — re-fetch it with view_code \
         rather than re-pinning the hash to whatever is on disk"
    );

    // ---- give the live code state worth losing, in all three collections ----
    let player = w
        .root
        .create_subaccount("player")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;

    // A buy moves stock and treasury; overpaying leaves the buyer a credit, so
    // `credits` is non-empty too.
    let total = w.quote_total(IRON, 10).await?;
    player
        .call(w.market.id(), "buy")
        .args_json(json!({ "merchant_id": w.ironmonger.id(), "item": IRON, "count": 10 }))
        .deposit(NearToken::from_yoctonear(total + NearToken::from_near(2).as_yoctonear()))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let before = facts(&w, &player).await?;
    assert!(before.owed > 0, "the market owes something before we touch it");
    assert!(before.credit > 0, "the overpayment left a credit to preserve");
    println!("  before migration: {before:?}");

    // ---- step 1: break it, exactly the way a careless deploy would ----------
    let fresh = wasm("nearcraft_market")?;
    w.market
        .as_account()
        .batch(w.market.id())
        .deploy(&fresh)
        .transact()
        .await?
        .into_result()?;

    let bricked = w.market.view("ledger_total").await;
    assert!(
        bricked.is_err(),
        "a plain redeploy over the old shape should have bricked every view, and did not. \
         Either the new build adds no state field — in which case this test proves nothing \
         and the release does not need a migration — or the shape change is not what it looks \
         like."
    );
    let message = format!("{:?}", bricked.unwrap_err());
    assert!(
        message.contains("deserialize"),
        "expected a state-deserialization failure, got: {message}"
    );
    println!("  bricked as expected: every view fails to deserialize the state");

    // ---- step 2: rescue it, deploy and migrate in ONE transaction -----------
    // Two transactions would leave the contract unreadable in between, which is
    // the whole reason this has to be batched.
    w.market
        .as_account()
        .batch(w.market.id())
        .deploy(&fresh)
        .call(Function::new("migrate").args_json(json!({})).gas(Gas::from_tgas(60)))
        .transact()
        .await?
        .into_result()?;

    let after = facts(&w, &player).await?;
    println!("  after migration:  {after:?}");
    assert_eq!(after, before, "the migration did not carry every fact forward unchanged");

    // The new field is present and empty, which is the honest answer: restocks
    // that happened before the migration spent money nobody recorded.
    let basis = u128_view(
        &w.market,
        "basis_of",
        json!({ "merchant_id": w.ironmonger.id(), "item": IRON }),
    )
    .await?;
    assert_eq!(basis, 0, "the new collection reads as empty rather than as garbage");

    Ok(())
}

#[tokio::test]
async fn migrating_again_changes_nothing() -> anyhow::Result<()> {
    let w = World::setup_with_market_wasm(&live_market_wasm()?).await?;
    let player = w
        .root
        .create_subaccount("player")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let total = w.quote_total(IRON, 4).await?;
    player
        .call(w.market.id(), "buy")
        .args_json(json!({ "merchant_id": w.ironmonger.id(), "item": IRON, "count": 4 }))
        .deposit(NearToken::from_yoctonear(total))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let fresh = wasm("nearcraft_market")?;
    w.market
        .as_account()
        .batch(w.market.id())
        .deploy(&fresh)
        .call(Function::new("migrate").args_json(json!({})).gas(Gas::from_tgas(60)))
        .transact()
        .await?
        .into_result()?;
    let once = facts(&w, &player).await?;

    // Running it a second time must be a no-op, not a reset. This is what the
    // "current shape first" probe in `migrate` is for: reading already-migrated
    // state as the OLD shape would leave a trailing tail, which borsh rejects,
    // so without that ordering the second call would panic instead.
    let outcome = w
        .market
        .as_account()
        .call(w.market.id(), "migrate")
        .args_json(json!({}))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    assert!(outcome.is_success(), "a second migrate failed: {outcome:#?}");
    assert!(
        outcome.logs().iter().any(|l| l.contains("already the current shape")),
        "the second migrate should have recognised the state as current, logs: {:?}",
        outcome.logs()
    );

    assert_eq!(facts(&w, &player).await?, once, "the second migrate moved state");
    Ok(())
}

#[tokio::test]
async fn only_the_contract_itself_may_migrate() -> anyhow::Result<()> {
    let w = World::setup().await?;

    // An un-private `migrate` is the single most dangerous signature in this
    // project: anyone could overwrite the contract's state. near-sdk emits the
    // check only in the wasm wrapper, so this is the only place it can be
    // proved — and `assert_eq!` in a unit test would pass either way.
    let outcome = w
        .root
        .call(w.market.id(), "migrate")
        .args_json(json!({}))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    assert!(outcome.is_failure(), "a stranger was allowed to migrate the contract");
    let message = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(
        message.contains("Method migrate is private"),
        "refused, but not for being private: {message}"
    );

    // And the contract is untouched by the attempt.
    assert!(w.market.view("ledger_total").await.is_ok(), "the refused call left state readable");
    Ok(())
}
