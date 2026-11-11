//! NearCraft materials — a NEP-245 multi-token contract.
//!
//! Every material in the game is one token id inside this one contract, which is
//! what the NEP-245 multi-token standard is for: `iron_ingot`, `oak_log`,
//! `stone`, and so on all share this contract's storage and all of them move
//! through the same transfer methods.
//!
//! `near-contract-standards` 5.30.1 ships `fungible_token`, `non_fungible_token`,
//! `storage_management` and `upgrade` — there is no multi-token module — so this
//! is written by hand against nep-0245.md.
//!
//! Scope, stated plainly:
//!   * Implemented — the NEP-245 **core** interface and the **Enumeration**
//!     extension.
//!   * Not implemented — the **Approval Management** and **Metadata**
//!     extensions. The `approval`/`approvals` arguments are part of the core
//!     signatures, so they are accepted but **rejected when non-null** rather
//!     than silently ignored: a caller passing an approval means something by
//!     it, and quietly dropping it would be a lie about what happened.
//!     Metadata is redundant here because a token id *is* the material name.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, PanicOnDefault,
    PromiseError, PromiseOrValue,
};

mod events;
use events::{amount_strings, MtBurnLog, MtMintLog, MtTransferLog};

/// Gas reserved for our own `mt_resolve_transfer` callback.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(11);
/// Gas floor a `*_transfer_call` must be able to forward to the receiver.
const GAS_FOR_MT_ON_TRANSFER: Gas = Gas::from_tgas(25);

/// NEP-245 core token view. `owner_id` is `None` for fungible-style tokens,
/// which every NearCraft material is — stock is a shared supply, not a unique item.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

/// Balance key. Borsh-encoded as a pair, so one `LookupMap` covers every
/// (material, holder) pair without a nested collection.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[borsh(crate = "near_sdk::borsh")]
struct BalanceKey {
    token_id: String,
    account_id: AccountId,
}

#[ext_contract(ext_mt_receiver)]
#[allow(dead_code)]
trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128>;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait MultiTokenResolver {
    fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
    ) -> Vec<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Items {
    /// May mint and burn. Set once at init.
    owner_id: AccountId,
    balances: LookupMap<BalanceKey, u128>,
    /// Iterable so Enumeration can list the catalog without a second index.
    supply: IterableMap<String, u128>,
}

#[near]
impl Items {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            balances: LookupMap::new(b"b".to_vec()),
            supply: IterableMap::new(b"s".to_vec()),
        }
    }

    // ---------------------------------------------------------------- minting

    /// Mint `amount` of `token_id` to `receiver_id`. Owner-only.
    ///
    /// NEP-245 defines minting as an *event*, not a method, so the name and
    /// signature here are ours; only the emitted `mt_mint` event is standard.
    pub fn mt_mint(&mut self, token_id: String, amount: U128, receiver_id: AccountId) {
        self.assert_owner();
        let amount = amount.0;
        require!(amount > 0, "mint amount must be positive");
        require!(!token_id.is_empty(), "token_id must not be empty");

        let balance = self.internal_balance(&token_id, &receiver_id);
        self.set_balance(&token_id, &receiver_id, balance.checked_add(amount).expect("balance overflow"));
        let supply = self.supply.get(&token_id).copied().unwrap_or_default();
        self.supply.insert(token_id.clone(), supply.checked_add(amount).expect("supply overflow"));

        events::emit_mint(MtMintLog {
            owner_id: &receiver_id,
            token_ids: &[token_id],
            amounts: amount_strings(&[amount]),
            memo: None,
        });
    }

    /// Burn `amount` of `token_id` from the caller's own balance.
    #[payable]
    pub fn mt_burn(&mut self, token_id: String, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let amount = amount.0;
        require!(amount > 0, "burn amount must be positive");

        let balance = self.internal_balance(&token_id, &owner_id);
        require!(balance >= amount, "insufficient balance to burn");
        self.set_balance(&token_id, &owner_id, balance - amount);
        let supply = self.supply.get(&token_id).copied().unwrap_or_default();
        self.supply.insert(token_id.clone(), supply - amount);

        events::emit_burn(MtBurnLog {
            owner_id: &owner_id,
            authorized_id: None,
            token_ids: &[token_id],
            amounts: amount_strings(&[amount]),
            memo: memo.as_deref(),
        });
    }

    // -------------------------------------------------------------- transfers

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        Self::reject_approval(approval.is_some());
        let sender_id = env::predecessor_account_id();
        self.internal_transfer(&sender_id, &receiver_id, &token_id, amount.0);
        events::emit_transfer(MtTransferLog {
            authorized_id: None,
            old_owner_id: &sender_id,
            new_owner_id: &receiver_id,
            token_ids: &[token_id],
            amounts: amount_strings(&[amount.0]),
            memo: memo.as_deref(),
        });
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        Self::reject_approval(approvals.iter().flatten().any(|a| a.is_some()));
        require!(!token_ids.is_empty(), "token_ids must not be empty");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        if let Some(approvals) = &approvals {
            require!(approvals.len() == token_ids.len(), "approvals must match token_ids length");
        }
        let sender_id = env::predecessor_account_id();
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        for (token_id, amount) in token_ids.iter().zip(raw.iter()) {
            self.internal_transfer(&sender_id, &receiver_id, token_id, *amount);
        }
        events::emit_transfer(MtTransferLog {
            authorized_id: None,
            old_owner_id: &sender_id,
            new_owner_id: &receiver_id,
            token_ids: &token_ids,
            amounts: amount_strings(&raw),
            memo: memo.as_deref(),
        });
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        Self::reject_approval(approvals.iter().flatten().any(|a| a.is_some()));
        require!(!token_ids.is_empty(), "token_ids must not be empty");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        require!(
            env::prepaid_gas() >= GAS_FOR_MT_ON_TRANSFER.saturating_add(GAS_FOR_RESOLVE_TRANSFER),
            "not enough gas attached for a transfer_call"
        );

        let sender_id = env::predecessor_account_id();
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        for (token_id, amount) in token_ids.iter().zip(raw.iter()) {
            self.internal_transfer(&sender_id, &receiver_id, token_id, *amount);
        }
        events::emit_transfer(MtTransferLog {
            authorized_id: None,
            old_owner_id: &sender_id,
            new_owner_id: &receiver_id,
            token_ids: &token_ids,
            amounts: amount_strings(&raw),
            memo: memo.as_deref(),
        });

        let previous_owner_ids = vec![sender_id.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(env::prepaid_gas().saturating_sub(GAS_FOR_RESOLVE_TRANSFER.saturating_mul(2)))
            .mt_on_transfer(sender_id.clone(), previous_owner_ids, token_ids.clone(), amounts.clone(), msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .mt_resolve_transfer(sender_id, receiver_id, token_ids, amounts),
            )
            .into()
    }

    /// Private callback. Refunds whatever the receiver did not use.
    ///
    /// Deviation, disclosed: nep-0245.md's resolver signature omits `amounts`,
    /// but a resolver cannot compute a refund without knowing what was sent —
    /// and the spec text has acknowledged copy-paste errors in exactly this
    /// section. The resolver is a private callback, not an interop surface, and
    /// the spec permits renaming it, so taking `amounts` here is safe.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        #[callback_result] result: Result<Vec<U128>, PromiseError>,
    ) -> Vec<U128> {
        // Whatever the receiver says it kept, it can never be more than it was sent.
        let unused: Vec<u128> = match result {
            Ok(returned) => token_ids
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    let sent = amounts[i].0;
                    returned.get(i).map(|u| u.0.min(sent)).unwrap_or(0)
                })
                .collect(),
            // Receiver panicked or the call failed: refund everything.
            Err(_) => amounts.iter().map(|a| a.0).collect(),
        };

        let mut refunded = Vec::with_capacity(token_ids.len());
        let mut used = Vec::with_capacity(token_ids.len());
        for (i, token_id) in token_ids.iter().enumerate() {
            let sent = amounts[i].0;
            // Only refund what the receiver still actually holds.
            let available = self.internal_balance(token_id, &receiver_id);
            let refund = unused[i].min(available);
            if refund > 0 {
                self.set_balance(token_id, &receiver_id, available - refund);
                let sender_balance = self.internal_balance(token_id, &sender_id);
                self.set_balance(token_id, &sender_id, sender_balance.checked_add(refund).expect("refund overflow"));
                refunded.push((token_id.clone(), refund));
            }
            used.push(U128(sent - refund));
        }

        if !refunded.is_empty() {
            let ids: Vec<String> = refunded.iter().map(|(id, _)| id.clone()).collect();
            let amts: Vec<u128> = refunded.iter().map(|(_, a)| *a).collect();
            events::emit_transfer(MtTransferLog {
                authorized_id: None,
                old_owner_id: &receiver_id,
                new_owner_id: &sender_id,
                token_ids: &ids,
                amounts: amount_strings(&amts),
                memo: Some("refund of unused mt_transfer_call amount"),
            });
        }
        used
    }

    // ------------------------------------------------------------------ views

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|token_id| {
                self.supply
                    .get(&token_id)
                    .map(|_| Token { token_id, owner_id: None })
            })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.internal_balance(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.internal_balance(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.supply.get(t).map(|s| U128(*s))).collect()
    }

    // ------------------------------------------------ Enumeration extension

    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(u64::MAX) as usize;
        self.supply
            .keys()
            .skip(start)
            .take(limit)
            .map(|token_id| Token { token_id: token_id.clone(), owner_id: None })
            .collect()
    }

    /// Materials this account holds a non-zero balance of.
    ///
    /// Scans the catalog rather than keeping a per-owner index. NearCraft's
    /// material catalog is small and fixed, so this is bounded and cheap; it
    /// would need a real index for an open-ended catalog.
    pub fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(u64::MAX) as usize;
        self.supply
            .keys()
            .filter(|token_id| self.internal_balance(token_id, &account_id) > 0)
            .skip(start)
            .take(limit)
            .map(|token_id| Token { token_id: token_id.clone(), owner_id: Some(account_id.clone()) })
            .collect()
    }

    // --------------------------------------------------------------- internal

    fn internal_balance(&self, token_id: &str, account_id: &AccountId) -> u128 {
        self.balances
            .get(&BalanceKey { token_id: token_id.to_string(), account_id: account_id.clone() })
            .copied()
            .unwrap_or_default()
    }

    fn set_balance(&mut self, token_id: &str, account_id: &AccountId, value: u128) {
        let key = BalanceKey { token_id: token_id.to_string(), account_id: account_id.clone() };
        self.balances.insert(key, value);
    }

    fn internal_transfer(&mut self, sender_id: &AccountId, receiver_id: &AccountId, token_id: &str, amount: u128) {
        require!(amount > 0, "transfer amount must be positive");
        require!(sender_id != receiver_id, "sender and receiver must differ");
        require!(self.supply.contains_key(token_id), "unknown token_id");
        let from = self.internal_balance(token_id, sender_id);
        require!(from >= amount, "insufficient balance");
        self.set_balance(token_id, sender_id, from - amount);
        let to = self.internal_balance(token_id, receiver_id);
        self.set_balance(token_id, receiver_id, to.checked_add(amount).expect("balance overflow"));
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    /// Approval Management is not implemented, so a non-null approval is an
    /// error rather than something to ignore.
    fn reject_approval(present: bool) {
        require!(!present, "approval management is not implemented by this contract");
    }

    pub fn mt_owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const IRON: &str = "iron_ingot";
    const OAK: &str = "oak_log";

    /// accounts(0) = the contract owner / market, accounts(1..) = players.
    fn setup(predecessor: AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(100))
            .build());
    }

    fn stocked() -> Items {
        setup(accounts(0), 0);
        let mut c = Items::new(accounts(0));
        c.mt_mint(IRON.to_string(), U128(1_000), accounts(0));
        c.mt_mint(OAK.to_string(), U128(500), accounts(0));
        c
    }

    #[test]
    fn mint_credits_balance_and_supply_and_emits_event() {
        setup(accounts(0), 0);
        let mut c = Items::new(accounts(0));
        c.mt_mint(IRON.to_string(), U128(64), accounts(1));

        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(64));
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(64)));

        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("EVENT_JSON:"), "must use the NEP-297 prefix");
        assert!(logs[0].contains(r#""standard":"nep245""#));
        assert!(logs[0].contains(r#""version":"1.0.0""#));
        assert!(logs[0].contains(r#""event":"mt_mint""#));
        // Amounts cross JSON as base-10 strings, not numbers.
        assert!(logs[0].contains(r#""amounts":["64"]"#));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_may_mint() {
        setup(accounts(0), 0);
        let mut c = Items::new(accounts(0));
        setup(accounts(1), 0);
        c.mt_mint(IRON.to_string(), U128(1), accounts(1));
    }

    #[test]
    fn transfer_moves_balance_and_conserves_supply() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(40), None, Some("wages".into()));

        assert_eq!(c.mt_balance_of(accounts(0), IRON.to_string()), U128(960));
        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(40));
        // A transfer must never change total supply.
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(1_000)));

        let logs = get_logs();
        let last = logs.last().unwrap();
        assert!(last.contains(r#""event":"mt_transfer""#));
        assert!(last.contains(r#""old_owner_id":"alice""#) || last.contains("old_owner_id"));
        assert!(last.contains(r#""memo":"wages""#));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut c = stocked();
        setup(accounts(0), 0);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn cannot_transfer_more_than_held() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(1_001), None, None);
    }

    #[test]
    #[should_panic(expected = "sender and receiver must differ")]
    fn cannot_transfer_to_self() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(0), IRON.to_string(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "unknown token_id")]
    fn cannot_transfer_unknown_material() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), "unobtainium".to_string(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "transfer amount must be positive")]
    fn cannot_transfer_zero() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(0), None, None);
    }

    /// Approval Management is deliberately unimplemented. A caller passing an
    /// approval means something by it, so we refuse rather than ignore it.
    #[test]
    #[should_panic(expected = "approval management is not implemented")]
    fn approval_is_refused_not_ignored() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(1), Some((accounts(2), 7)), None);
    }

    #[test]
    fn batch_transfer_moves_every_material() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_batch_transfer(
            accounts(1),
            vec![IRON.to_string(), OAK.to_string()],
            vec![U128(10), U128(20)],
            None,
            None,
        );
        assert_eq!(
            c.mt_batch_balance_of(accounts(1), vec![IRON.to_string(), OAK.to_string()]),
            vec![U128(10), U128(20)]
        );
    }

    #[test]
    #[should_panic(expected = "token_ids and amounts must be the same length")]
    fn batch_transfer_rejects_length_mismatch() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_batch_transfer(accounts(1), vec![IRON.to_string()], vec![U128(1), U128(2)], None, None);
    }

    #[test]
    fn burn_reduces_supply_and_emits_event() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_burn(IRON.to_string(), U128(100), Some("smelted".into()));
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(900)));
        assert_eq!(c.mt_balance_of(accounts(0), IRON.to_string()), U128(900));
        assert!(get_logs().last().unwrap().contains(r#""event":"mt_burn""#));
    }

    #[test]
    fn views_report_unknown_materials_as_none() {
        let c = stocked();
        assert_eq!(c.mt_supply("unobtainium".to_string()), None);
        assert_eq!(c.mt_token(vec!["unobtainium".to_string()]), vec![None]);
        assert_eq!(c.mt_batch_supply(vec![IRON.to_string(), "nope".to_string()]), vec![Some(U128(1_000)), None]);
        // A balance for a material nobody holds is zero, not an error.
        assert_eq!(c.mt_balance_of(accounts(3), IRON.to_string()), U128(0));
    }

    #[test]
    fn mt_token_reports_fungible_materials_with_no_single_owner() {
        let c = stocked();
        let got = c.mt_token(vec![IRON.to_string()]);
        assert_eq!(got, vec![Some(Token { token_id: IRON.to_string(), owner_id: None })]);
    }

    #[test]
    fn enumeration_lists_catalog_and_holdings() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), OAK.to_string(), U128(5), None, None);

        let catalog: Vec<String> = c.mt_tokens(None, None).into_iter().map(|t| t.token_id).collect();
        assert_eq!(catalog.len(), 2);
        assert!(catalog.contains(&IRON.to_string()) && catalog.contains(&OAK.to_string()));

        // accounts(1) holds oak only, so iron must not appear.
        let held: Vec<String> =
            c.mt_tokens_for_owner(accounts(1), None, None).into_iter().map(|t| t.token_id).collect();
        assert_eq!(held, vec![OAK.to_string()]);

        assert_eq!(c.mt_tokens(None, Some(1)).len(), 1, "limit must be honoured");
        assert_eq!(c.mt_tokens(Some(U128(2)), None).len(), 0, "from_index past the end is empty");
    }

    /// A receiver that keeps part of the transfer: the rest is refunded.
    #[test]
    fn resolve_transfer_refunds_the_unused_remainder() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);

        // Receiver reports it used 60 of the 100 it was sent.
        let used = c.mt_resolve_transfer(
            accounts(0),
            accounts(1),
            vec![IRON.to_string()],
            vec![U128(100)],
            Ok(vec![U128(40)]),
        );
        assert_eq!(used, vec![U128(60)]);
        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(60));
        assert_eq!(c.mt_balance_of(accounts(0), IRON.to_string()), U128(940));
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(1_000)), "refund must conserve supply");
    }

    /// A receiver that panics: the whole amount comes back.
    #[test]
    fn resolve_transfer_refunds_everything_when_the_receiver_fails() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);

        let used = c.mt_resolve_transfer(
            accounts(0),
            accounts(1),
            vec![IRON.to_string()],
            vec![U128(100)],
            Err(PromiseError::Failed),
        );
        assert_eq!(used, vec![U128(0)]);
        assert_eq!(c.mt_balance_of(accounts(0), IRON.to_string()), U128(1_000));
        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(0));
    }

    /// A receiver cannot claim back more than it was sent, even if it lies.
    #[test]
    fn resolve_transfer_clamps_a_lying_receiver() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(10), None, None);

        // Receiver claims 9_999 unused out of 10 sent.
        let used = c.mt_resolve_transfer(
            accounts(0),
            accounts(1),
            vec![IRON.to_string()],
            vec![U128(10)],
            Ok(vec![U128(9_999)]),
        );
        assert_eq!(used, vec![U128(0)], "cannot refund more than was sent");
        assert_eq!(c.mt_balance_of(accounts(0), IRON.to_string()), U128(1_000));
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(1_000)));
    }

    /// If the receiver already moved the tokens on, we refund only what it still has.
    #[test]
    fn resolve_transfer_only_refunds_what_the_receiver_still_holds() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_transfer(accounts(2), IRON.to_string(), U128(90), None, None);

        // Receiver claims all 100 unused, but holds only 10.
        let used = c.mt_resolve_transfer(
            accounts(0),
            accounts(1),
            vec![IRON.to_string()],
            vec![U128(100)],
            Ok(vec![U128(100)]),
        );
        assert_eq!(used, vec![U128(90)], "90 is irrecoverably spent");
        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(0));
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(1_000)));
    }
}
