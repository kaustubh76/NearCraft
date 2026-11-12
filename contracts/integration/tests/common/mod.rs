//! Shared sandbox setup: a real local NEAR node with both contracts deployed
//! and a working economy, built from scratch in every test.
//!
//! No faucet, no testnet account, no credentials. `near-sandbox` downloads a
//! node binary once and caches it; everything after that is local.

#![allow(dead_code)]

use near_workspaces::types::{NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use near_workspaces::network::Sandbox;
use serde_json::json;

pub const IRON: &str = "iron_ingot";
pub const OAK: &str = "oak_log";

/// Base price used throughout: 0.4 NEAR, matching config/catalog.json.
pub fn base_price() -> NearToken {
    NearToken::from_millinear(400)
}

pub struct World {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub items: Contract,
    pub market: Contract,
    pub ironmonger: Account,
}

pub fn wasm(name: &str) -> anyhow::Result<Vec<u8>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/near")
        .join(name)
        .join(format!("{name}.wasm"));
    std::fs::read(&path).map_err(|e| {
        anyhow::anyhow!(
            "cannot read {}: {e}\n\nBuild the contracts first:\n    npm run build:contracts\n\
             (needs cargo-near: cargo install cargo-near)",
            path.display()
        )
    })
}

impl World {
    /// Deploy both contracts, register one funded merchant, and stock its shelf.
    ///
    /// Budget note: a sandbox dev account starts with 100 NEAR, and every figure
    /// below is drawn from it — 6 (items) + 12 (market) + 2 (merchant account)
    /// + 15 (treasury) + per-agent costs. Raising these without checking the
    /// total produces a NotEnoughBalance failure in setup rather than in a test.
    pub async fn setup() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.dev_create_account().await?;

        let items_account = root
            .create_subaccount("items")
            .initial_balance(NearToken::from_near(6))
            .transact()
            .await?
            .into_result()?;
        let market_account = root
            .create_subaccount("market")
            .initial_balance(NearToken::from_near(12))
            .transact()
            .await?
            .into_result()?;

        let items = items_account.deploy(&wasm("nearcraft_items")?).await?.into_result()?;
        let market = market_account.deploy(&wasm("nearcraft_market")?).await?.into_result()?;

        // The market owns the items contract, so it mints its own shop-floor pool.
        items.call("new").args_json(json!({ "owner_id": market.id() })).transact().await?.into_result()?;
        market
            .call("new")
            .args_json(json!({ "owner_id": root.id(), "items_contract": items.id() }))
            .transact()
            .await?
            .into_result()?;

        // Mint the catalogue to the market.
        for token_id in [IRON, OAK] {
            market
                .as_account()
                .call(items.id(), "mt_mint")
                .args_json(json!({ "token_id": token_id, "amount": "100000", "receiver_id": market.id() }))
                .transact()
                .await?
                .into_result()?;
        }

        // One merchant with its own account, a floor and a funded treasury.
        let ironmonger = root
            .create_subaccount("ironmonger")
            .initial_balance(NearToken::from_near(2))
            .transact()
            .await?
            .into_result()?;

        root.call(market.id(), "register_merchant")
            .args_json(json!({
                "merchant_id": ironmonger.id(),
                "name": "Ironmonger",
                "floor": NearToken::from_near(1).as_yoctonear().to_string(),
            }))
            .transact()
            .await?
            .into_result()?;

        root.call(market.id(), "fund_merchant")
            .args_json(json!({ "merchant_id": ironmonger.id() }))
            .deposit(NearToken::from_near(15))
            .transact()
            .await?
            .into_result()?;

        // 256 iron puts the shelf in the reference band, so quotes start at base.
        root.call(market.id(), "list_item")
            .args_json(json!({
                "merchant_id": ironmonger.id(),
                "item": IRON,
                "base_price": base_price().as_yoctonear().to_string(),
                "stock": "256",
            }))
            .transact()
            .await?
            .into_result()?;

        Ok(Self { worker, root, items, market, ironmonger })
    }

    /// Create an agent sub-account and give it a spend budget.
    pub async fn agent(&self, name: &str, budget: NearToken) -> anyhow::Result<Account> {
        let agent = self
            .root
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(2))
            .transact()
            .await?
            .into_result()?;
        self.root
            .call(self.market.id(), "fund_credit")
            .args_json(json!({ "account_id": agent.id() }))
            .deposit(budget)
            .transact()
            .await?
            .into_result()?;
        Ok(agent)
    }

    /// The merchant's accrued, withdrawable earnings.
    pub async fn merchant_treasury(&self) -> anyhow::Result<u128> {
        let m: serde_json::Value = self
            .market
            .view("merchant")
            .args_json(json!({ "merchant_id": self.ironmonger.id() }))
            .await?
            .json()?;
        Ok(m["treasury"].as_str().unwrap().parse()?)
    }

    /// What the merchant currently pays per unit, or `None` when closed.
    pub async fn merchant_bid(&self, item: &str) -> anyhow::Result<Option<u128>> {
        let q: serde_json::Value = self
            .market
            .view("quote")
            .args_json(json!({ "merchant_id": self.ironmonger.id(), "item": item, "count": 1 }))
            .await?
            .json()?;
        Ok(match q["merchant_bid"].as_str() {
            Some(bid) => Some(bid.parse()?),
            None => None,
        })
    }

    pub async fn is_closed(&self) -> anyhow::Result<bool> {
        Ok(self
            .market
            .view("is_closed")
            .args_json(json!({ "merchant_id": self.ironmonger.id() }))
            .await?
            .json()?)
    }

    pub async fn quote_total(&self, item: &str, count: u32) -> anyhow::Result<u128> {
        let q: serde_json::Value = self
            .market
            .view("quote")
            .args_json(json!({ "merchant_id": self.ironmonger.id(), "item": item, "count": count }))
            .await?
            .json()?;
        Ok(q["total"].as_str().unwrap().parse()?)
    }

    pub async fn credit_of(&self, account: &Account) -> anyhow::Result<u128> {
        let c: String = self
            .market
            .view("credit_of")
            .args_json(json!({ "account_id": account.id() }))
            .await?
            .json()?;
        Ok(c.parse()?)
    }

    pub async fn balance_of(&self, account: &Account, token_id: &str) -> anyhow::Result<u128> {
        let b: String = self
            .items
            .view("mt_balance_of")
            .args_json(json!({ "account_id": account.id(), "token_id": token_id }))
            .await?
            .json()?;
        Ok(b.parse()?)
    }

    pub async fn stock_of(&self, item: &str) -> anyhow::Result<u128> {
        let q: serde_json::Value = self
            .market
            .view("quote")
            .args_json(json!({ "merchant_id": self.ironmonger.id(), "item": item, "count": 1 }))
            .await?
            .json()?;
        Ok(q["stock"].as_str().unwrap().parse()?)
    }
}

pub fn random_key() -> SecretKey {
    SecretKey::from_random(near_workspaces::types::KeyType::ED25519)
}
