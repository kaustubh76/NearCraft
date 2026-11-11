//! NEP-297 event logging for the NEP-245 multi-token standard.
//!
//! Shapes follow nep-0245/Events.md exactly: standard "nep245", version "1.0.0",
//! and a `data` array whose entries are one log record each. Amounts are base-10
//! strings because NEP-245 amounts are U128 over JSON.

use near_sdk::serde::Serialize;
use near_sdk::serde_json::json;
use near_sdk::{env, AccountId};

/// One `mt_mint` data entry. `token_ids` and `amounts` must be the same length.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MtMintLog<'a> {
    pub owner_id: &'a AccountId,
    pub token_ids: &'a [String],
    pub amounts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

/// One `mt_burn` data entry.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MtBurnLog<'a> {
    pub owner_id: &'a AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<&'a AccountId>,
    pub token_ids: &'a [String],
    pub amounts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

/// One `mt_transfer` data entry.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct MtTransferLog<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<&'a AccountId>,
    pub old_owner_id: &'a AccountId,
    pub new_owner_id: &'a AccountId,
    pub token_ids: &'a [String],
    pub amounts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

fn emit<T: Serialize>(event: &str, data: &[T]) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": data })
    ));
}

pub fn emit_mint(log: MtMintLog) {
    emit("mt_mint", &[log]);
}

pub fn emit_burn(log: MtBurnLog) {
    emit("mt_burn", &[log]);
}

pub fn emit_transfer(log: MtTransferLog) {
    emit("mt_transfer", &[log]);
}

/// Amounts cross the NEP-245 JSON boundary as base-10 strings.
pub fn amount_strings(amounts: &[u128]) -> Vec<String> {
    amounts.iter().map(|a| a.to_string()).collect()
}
