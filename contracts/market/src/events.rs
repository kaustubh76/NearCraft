//! NEP-297 event logging for the market.
//!
//! **Why this exists.** `buy` and `sell` emitted NOTHING. Not a plain log line,
//! nothing — and neither did `settle_purchase`, `on_items_delivered` or
//! `on_materials_pulled`. The twelve `env::log_str` calls this contract did have
//! were two migration notes and ten mostly-rollback paths. So the two central
//! events of the economy were silent, and the disclosed gap, "market has no
//! NEP-297 events", understated it: the shape was not wrong, the events were
//! absent.
//!
//! The token leg of a trade *was* visible, because the market calls
//! `mt_transfer` on the items contract and that emits a proper NEP-245 event.
//! The money leg was not: nothing named the merchant, the price, the credit
//! spent or the margin split. Anyone reconstructing this economy from chain data
//! saw tokens move and never learned what they cost.
//!
//! **Its own standard, not nep245.** NEP-297 lets a contract name the standard
//! it is emitting for, and this one is not a multi-token contract — it has no
//! `mt_` methods and claims no NEP-245 conformance. Borrowing `nep245` here
//! would tell an indexer to expect `token_ids` and `amounts` arrays that do not
//! exist. So: `nearcraft_market`, version `1.0.0`.
//!
//! Amounts are base-10 strings, exactly as `contracts/items/src/events.rs` does
//! it, because a yoctoNEAR u128 has up to 39 digits and a JSON number carries
//! about 15.
//!
//! **Where these are emitted matters.** A purchase is emitted in
//! `on_items_delivered`, not in `buy` — `buy` only starts a cross-contract call,
//! and whether the goods moved is known one receipt later. Emitting at the
//! request would announce purchases that then rolled back. The same holds for a
//! sale and for a restock.

use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;
use near_sdk::{env, AccountId};

/// A purchase that settled: the goods moved and the merchant was paid.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseLog<'a> {
    pub buyer_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    /// yoctoNEAR the buyer actually paid for these units.
    pub paid: String,
}

/// A purchase that did not settle, and what went back to the buyer.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseRolledBackLog<'a> {
    pub buyer_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    /// Credited back, not transferred: the payment never reached the treasury.
    pub credited: String,
}

/// A sale that settled: the materials moved and the seller was paid.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SaleLog<'a> {
    pub seller_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    /// yoctoNEAR of credit the seller received, at the merchant's bid.
    pub proceeds: String,
}

/// A sale the market could not complete, usually a missing or spent approval.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SaleUnwoundLog<'a> {
    pub seller_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    pub reason: &'a str,
}

/// A merchant bought its own shelf back up.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RestockLog<'a> {
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    /// yoctoNEAR the merchant spent, total.
    pub cost: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_cost: Option<String>,
}

/// A restock that failed and was undone.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RestockUnwoundLog<'a> {
    pub merchant_id: &'a AccountId,
    pub item: &'a str,
    pub units: String,
    pub reason: &'a str,
}

/// Someone put money into a merchant.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct InvestmentLog<'a> {
    pub backer_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub amount: String,
    /// Whether this stake was what reopened a closed shop.
    pub reopened: bool,
    /// Whether the shop is open AFTER this stake.
    ///
    /// `reopened` alone could not say it. The prose this event replaced had
    /// three states — reopened, "not yet enough to reopen its shop", and never
    /// closed in the first place — and a single boolean collapsed the last two
    /// into `false`. An indexer could not then tell a rescue that fell short
    /// from an ordinary top-up, which is exactly the distinction a player cares
    /// about. Two booleans carry all three states and no ambiguity.
    pub merchant_open: bool,
    /// `credit` when paid from a spend budget, `deposit` when attached NEAR.
    pub source: &'a str,
}

/// A backer earned part of a sale's margin back.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MarginPaidLog<'a> {
    pub backer_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub payout: String,
    /// What is still owed on this stake afterwards. Zero means settled.
    pub outstanding: String,
}

/// A backer was repaid in full to free their slot.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BackerBoughtOutLog<'a> {
    pub backer_id: &'a AccountId,
    pub merchant_id: &'a AccountId,
    pub repaid: String,
}

/// A transfer out of this contract failed and the balance was restored.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutFailedLog<'a> {
    pub account_id: &'a AccountId,
    pub amount: String,
    /// `credit` or `treasury` — which ledger the money went back into.
    pub restored_to: &'a str,
}

fn emit<T: Serialize>(event: &str, data: &[T]) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nearcraft_market", "version": "1.0.0", "event": event, "data": data })
    ));
}

pub fn emit_purchase(log: PurchaseLog) {
    emit("purchase", &[log]);
}

pub fn emit_purchase_rolled_back(log: PurchaseRolledBackLog) {
    emit("purchase_rolled_back", &[log]);
}

pub fn emit_sale(log: SaleLog) {
    emit("sale", &[log]);
}

pub fn emit_sale_unwound(log: SaleUnwoundLog) {
    emit("sale_unwound", &[log]);
}

pub fn emit_restock(log: RestockLog) {
    emit("restock", &[log]);
}

pub fn emit_restock_unwound(log: RestockUnwoundLog) {
    emit("restock_unwound", &[log]);
}

pub fn emit_investment(log: InvestmentLog) {
    emit("investment", &[log]);
}

pub fn emit_margin_paid(log: MarginPaidLog) {
    emit("margin_paid", &[log]);
}

pub fn emit_backer_bought_out(log: BackerBoughtOutLog) {
    emit("backer_bought_out", &[log]);
}

pub fn emit_payout_failed(log: PayoutFailedLog) {
    emit("payout_failed", &[log]);
}

/// yoctoNEAR and unit counts cross JSON as base-10 strings.
pub fn amount(value: u128) -> String {
    value.to_string()
}
