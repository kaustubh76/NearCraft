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
//!   * Implemented — the NEP-245 **core** interface, the **Enumeration**
//!     extension and the **Approval Management** extension.
//!   * Not implemented — **Metadata**, which is redundant here because a token
//!     id *is* the material name (`iron_ingot`), and whose extension would
//!     force a non-optional `base_metadata_id` onto `Token`.
//!
//! Approval Management exists for one concrete reason: a player whose account
//! holds only a function-call access key cannot attach the 1 yoctoNEAR that
//! `mt_transfer_call` requires, so without approvals such a player can buy but
//! can never sell. With one approval granted at account setup, the market moves
//! the player's materials on their behalf and selling costs the player nothing.
//! See `docs/GASLESS.md` for the measurement that forced this.
//!
//! ## Three spec ambiguities, decided and disclosed
//!
//! 1. `approval_id` is typed `number` in the method signatures but `string` in
//!    the `Approval` struct. We use `U64` — a string over JSON — which is
//!    NEAR's normal convention for 64-bit values and avoids a float.
//! 2. The extension says transfers "must nullify approvals on success". For a
//!    *non-fungible* token that is unambiguous. For multi-token amounts it
//!    cannot mean "delete the whole allowance", because the owner still holds
//!    the remainder and a standing operator approval would be impossible — the
//!    very use case above. We **decrement by the amount transferred** and
//!    remove the entry when it reaches zero. The `Approval.amount` field exists
//!    precisely so there is something to decrement.
//! 3. `mt_is_approved`'s signature names **no owner**, which is not answerable
//!    for a multi-token: approvals are keyed per `(owner, token)`, so the
//!    question has no meaning until you say whose approval. We take `owner_id`
//!    as an extra, required argument. The alternative — reading
//!    `env::predecessor_account_id()` — is what the first implementation did,
//!    and it made the method a view that **no client could call at all**,
//!    because nearcore forbids that host function in a view context. Its unit
//!    tests passed the whole time. `contracts/integration/tests/views.rs` now
//!    calls every view method as a real view so that class of bug cannot
//!    return.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use std::collections::HashMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

mod events;
use events::{amount_strings, MtBurnLog, MtMintLog, MtTransferLog};

/// Gas reserved for our own `mt_resolve_transfer` callback.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(11);
/// Gas floor a `*_transfer_call` must be able to forward to the receiver.
const GAS_FOR_MT_ON_TRANSFER: Gas = Gas::from_tgas(25);
/// Fire-and-forget notification to a newly approved account.
const GAS_FOR_MT_ON_APPROVE: Gas = Gas::from_tgas(10);

/// How many distinct accounts one owner may have approved for one material.
///
/// Every transfer on that (material, owner) pair deserializes this whole list,
/// so an unbounded one is a balance that eventually cannot move. `guard` bounds
/// its per-subject reports for the same reason — see MAX_REPORTS_PER_SUBJECT —
/// and this is the same defence in the contract that was missing it.
const MAX_APPROVALS_PER_TOKEN: usize = 64;

/// NEP-245 core token view. `owner_id` is `None` for fungible-style tokens,
/// which every NearCraft material is — stock is a shared supply, not a unique item.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

/// One account's standing permission to move another's materials.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    /// How much of this token id the approved account may still move.
    pub amount: U128,
    /// Incremented on every grant, including a re-grant, so a stale id cannot
    /// be replayed after the owner has changed their mind.
    ///
    /// `U64`, so this serializes as a STRING on the way out, while
    /// `mt_transfer` and `mt_is_approved` both take an approval id as a plain
    /// number on the way in. That asymmetry is deliberate and is the lesser of
    /// two evils: the spec writes `number` everywhere, but a u64 above 2^53
    /// cannot survive a JSON number in a JavaScript client, which is the entire
    /// reason near-sdk has `U64`. Inputs are made conformant because a client
    /// sending a literal is in control of the value; an output is read by code
    /// that is not. A reader therefore has to parse this before passing it to a
    /// transfer, and saying so here is better than letting someone discover it.
    pub approval_id: U64,
}

/// Every account approved for one (owner, token id) pair.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TokenApproval {
    pub approval_owner_id: AccountId,
    pub approved_account_ids: HashMap<AccountId, Approval>,
}

/// Approvals are stored per (token id, owner) so both lookup and enumeration
/// work from one collection — `mt_token_approval` has to list every approved
/// account, which a `LookupMap` alone cannot do.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[borsh(crate = "near_sdk::borsh")]
struct ApprovalsKey {
    token_id: String,
    owner_id: AccountId,
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

#[ext_contract(ext_mt_approval_receiver)]
#[allow(dead_code)]
trait MultiTokenApprovalReceiver {
    fn mt_on_approve(
        &mut self,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        owner_id: AccountId,
        approval_ids: Vec<U64>,
        msg: String,
    );
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

/// A pagination offset that cannot silently wrap.
///
/// `usize` is 32 bits on wasm32, so `from_index.0 as usize` truncates a u128:
/// an offset of 2^32 became 0 and handed back the FIRST page to a caller asking
/// for one far past the end. Saturating instead means an absurd offset skips
/// everything and returns empty, which is what was actually asked for.
fn clamp_index(from_index: Option<U128>) -> usize {
    from_index.map(|i| usize::try_from(i.0).unwrap_or(usize::MAX)).unwrap_or(0)
}

/// NEP-330 contract metadata.
///
/// `#[near]` emits `nep330` on its own and nothing else, so for as long as this
/// was left bare the chain reported `standards: [nep330]` for a contract that
/// implements NEP-245 and emits NEP-297 events. SourceScan, NearBlocks and any
/// indexer deciding how to read this contract all read that field, and it was
/// understating what is here.
///
/// The versions are the ones the specs name: nep-0245 pins its event envelope
/// at `1.0.0`, and NEP-297 is `1.0.0`.
#[near(contract_state, contract_metadata(
    standard(standard = "nep245", version = "1.0.0"),
    standard(standard = "nep297", version = "1.0.0"),
))]
#[derive(PanicOnDefault)]
pub struct Items {
    /// May mint and burn. Set once at init.
    owner_id: AccountId,
    balances: LookupMap<BalanceKey, u128>,
    /// Iterable so Enumeration can list the catalog without a second index.
    supply: IterableMap<String, u128>,
    /// (token id, owner) -> the accounts it has approved, with amount and id.
    approvals: IterableMap<ApprovalsKey, Vec<(AccountId, u128, u64)>>,
    /// Monotonic across the whole contract. A grant never reuses an id.
    next_approval_id: u64,
}

#[near]
impl Items {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            balances: LookupMap::new(b"b".to_vec()),
            supply: IterableMap::new(b"s".to_vec()),
            approvals: IterableMap::new(b"a".to_vec()),
            next_approval_id: 1,
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
        let caller = env::predecessor_account_id();
        let on_behalf = approval.is_some();
        let source = self.resolve_source(&caller, approval, &token_id, amount.0);
        self.internal_transfer(&source, &receiver_id, &token_id, amount.0);
        events::emit_transfer(MtTransferLog {
            // The spec's `authorized_id` names who initiated a transfer when
            // that is not the owner — so it is set exactly when an approval was
            // used, and left out otherwise.
            authorized_id: if on_behalf { Some(&caller) } else { None },
            old_owner_id: &source,
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
        require!(!token_ids.is_empty(), "token_ids must not be empty");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        if let Some(approvals) = &approvals {
            require!(approvals.len() == token_ids.len(), "approvals must match token_ids length");
        }
        let caller = env::predecessor_account_id();
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        let (source, on_behalf) = self.resolve_batch_source(&caller, approvals, &token_ids, &raw);
        for (token_id, amount) in token_ids.iter().zip(raw.iter()) {
            self.internal_transfer(&source, &receiver_id, token_id, *amount);
        }
        events::emit_transfer(MtTransferLog {
            authorized_id: if on_behalf { Some(&caller) } else { None },
            old_owner_id: &source,
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
        require!(!token_ids.is_empty(), "token_ids must not be empty");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        require!(
            env::prepaid_gas() >= GAS_FOR_MT_ON_TRANSFER.saturating_add(GAS_FOR_RESOLVE_TRANSFER),
            "not enough gas attached for a transfer_call"
        );

        let caller = env::predecessor_account_id();
        let raw: Vec<u128> = amounts.iter().map(|a| a.0).collect();
        let (sender_id, on_behalf) = self.resolve_batch_source(&caller, approvals, &token_ids, &raw);
        for (token_id, amount) in token_ids.iter().zip(raw.iter()) {
            self.internal_transfer(&sender_id, &receiver_id, token_id, *amount);
        }
        events::emit_transfer(MtTransferLog {
            authorized_id: if on_behalf { Some(&caller) } else { None },
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
                    // A SHORT answer refunds. `unwrap_or(0)` here meant "the
                    // receiver kept everything", so a receiver returning fewer
                    // figures than it was sent — a bug or a choice — silently
                    // kept materials it never claimed. An over-long answer is
                    // clamped just below; the two directions are now
                    // symmetrical, and the default is the one that does not
                    // cost the sender.
                    returned.get(i).map(|u| u.0.min(sent)).unwrap_or(sent)
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

    // ------------------------------------- Approval Management extension

    /// Approve `account_id` to move up to `amounts` of `token_ids` on the
    /// caller's behalf.
    ///
    /// Payable: the deposit covers the storage each approval occupies. A
    /// re-grant **increments the approval id**, which is what makes a stale id
    /// unusable once an owner has changed their mind.
    #[payable]
    pub fn mt_approve(
        &mut self,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "mt_approve requires a deposit to cover approval storage"
        );
        require!(!token_ids.is_empty(), "token_ids must not be empty");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        let owner_id = env::predecessor_account_id();
        require!(owner_id != account_id, "approving yourself has no effect");

        let mut ids = Vec::with_capacity(token_ids.len());
        for (token_id, amount) in token_ids.iter().zip(amounts.iter()) {
            require!(self.supply.contains_key(token_id), "unknown token_id");
            require!(amount.0 > 0, "an approval of zero is a revocation; use mt_revoke");
            let approval_id = self.next_approval_id;
            self.next_approval_id += 1;
            ids.push(U64(approval_id));

            let key = ApprovalsKey { token_id: token_id.clone(), owner_id: owner_id.clone() };
            let mut entries = self.approvals.get(&key).cloned().unwrap_or_default();
            match entries.iter().position(|(who, _, _)| who == &account_id) {
                Some(at) => entries[at] = (account_id.clone(), amount.0, approval_id),
                None => {
                    // Bounded, the way `guard` bounds its reports.
                    //
                    // Re-approving the SAME spender replaces its entry above,
                    // so this list only grows with distinct spenders — and
                    // only the owner can grow their own, since `owner_id` is
                    // the predecessor. So this is self-inflicted rather than a
                    // way to attack someone else, and it is worth saying so
                    // rather than overstating it.
                    //
                    // It still needs a bound: every later transfer on this
                    // pair deserializes the whole vector, so an account could
                    // put its own materials permanently out of reach. A limit
                    // that refuses is better than a balance that cannot move.
                    require!(
                        entries.len() < MAX_APPROVALS_PER_TOKEN,
                        "too many approvals for this material; revoke one first"
                    );
                    entries.push((account_id.clone(), amount.0, approval_id));
                }
            }
            self.approvals.insert(key, entries);
        }

        // The spec requires notifying the approved account when `msg` is given.
        // Fire and forget: the grant stands whatever the receiver does with it.
        msg.map(|msg| {
            ext_mt_approval_receiver::ext(account_id.clone())
                .with_static_gas(GAS_FOR_MT_ON_APPROVE)
                .mt_on_approve(token_ids, amounts, owner_id, ids, msg)
        })
    }

    /// Withdraw one account's permission over the given materials.
    #[payable]
    pub fn mt_revoke(&mut self, token_ids: Vec<String>, account_id: AccountId) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        for token_id in token_ids {
            let key = ApprovalsKey { token_id, owner_id: owner_id.clone() };
            if let Some(mut entries) = self.approvals.get(&key).cloned() {
                entries.retain(|(who, _, _)| who != &account_id);
                if entries.is_empty() { self.approvals.remove(&key); } else { self.approvals.insert(key, entries); }
            }
        }
    }

    /// Withdraw every account's permission over the given materials.
    #[payable]
    pub fn mt_revoke_all(&mut self, token_ids: Vec<String>) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        for token_id in token_ids {
            self.approvals.remove(&ApprovalsKey { token_id, owner_id: owner_id.clone() });
        }
    }

    /// Whether `approved_account_id` may move at least `amounts` of each token
    /// id **on behalf of `owner_id`** — optionally pinned to specific approval
    /// ids.
    ///
    /// `owner_id` is a parameter, and that is a deliberate deviation from the
    /// NEP-245 signature, which names no owner. The third ambiguity we have had
    /// to decide (see the module header for the other two).
    ///
    /// The spec's signature is not answerable for a *multi*-token: balances and
    /// approvals are keyed per `(owner, token)`, so "is this approved?" has no
    /// meaning until you say whose approval. This method originally resolved
    /// that by reading `env::predecessor_account_id()` — which made it a view
    /// that **no client could call**, because nearcore forbids that host
    /// function in a view context and answers `HostError(ProhibitedInView)`.
    /// Its own unit tests passed throughout, since `testing_env!` always
    /// supplies a predecessor.
    ///
    /// Taking the owner explicitly also makes this consistent with its sibling
    /// `mt_token_approval`, which has always done so, and which is why that one
    /// worked as a view all along.
    pub fn mt_is_approved(
        &self,
        token_ids: Vec<String>,
        approved_account_id: AccountId,
        amounts: Vec<U128>,
        // `Vec<u64>`, not `Vec<U64>`: the spec writes `number[]|null`, and this
        // contract's own `mt_transfer` already takes an approval id as a plain
        // `u64` inside its `approval` tuple. Taking a STRING here meant the
        // same value was a number going in one method and a string going into
        // another — a spec-conformant client sending `[1]` failed
        // deserialization, and `npm run check:nep245` could not see it until it
        // learned to read signatures.
        approval_ids: Option<Vec<u64>>,
        owner_id: AccountId,
    ) -> bool {
        if token_ids.len() != amounts.len() {
            return false;
        }
        if let Some(ids) = &approval_ids {
            if ids.len() != token_ids.len() {
                return false;
            }
        }
        token_ids.iter().enumerate().all(|(i, token_id)| {
            match self.find_approval(&owner_id, &approved_account_id, token_id) {
                Some((amount, id)) => {
                    amount >= amounts[i].0
                        && approval_ids.as_ref().is_none_or(|ids| ids[i] == id)
                }
                None => false,
            }
        })
    }

    /// Every account the caller has approved for one material.
    pub fn mt_token_approval(&self, token_id: String, account_id: AccountId) -> TokenApproval {
        let entries = self
            .approvals
            .get(&ApprovalsKey { token_id, owner_id: account_id.clone() })
            .cloned()
            .unwrap_or_default();
        TokenApproval {
            approval_owner_id: account_id,
            approved_account_ids: entries
                .into_iter()
                .map(|(who, amount, id)| (who, Approval { amount: U128(amount), approval_id: U64(id) }))
                .collect(),
        }
    }

    /// Every owner's approvals for one material, paginated.
    ///
    /// The sixth method in nep-0245/ApprovalManagement.md, and the one this
    /// contract was missing. `mt_token_approval` answers for one named owner;
    /// this enumerates every owner who has approved anybody for the material,
    /// which an indexer cannot reconstruct from the singular form — it would
    /// have to already know the owners it is trying to discover.
    ///
    /// `npm run check:nep245` reported "approval management: 5/5 present"
    /// throughout, because its own list of required methods was missing this
    /// one too. The implementation was its own denominator.
    pub fn mt_token_approvals(
        &self,
        token_id: String,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<TokenApproval> {
        let start = clamp_index(from_index);
        let limit = limit.unwrap_or(u64::MAX) as usize;
        // Collected first because `mt_token_approval` borrows `self` again.
        let owners: Vec<AccountId> = self
            .approvals
            .keys()
            .filter(|key| key.token_id == token_id)
            .skip(start)
            .take(limit)
            .map(|key| key.owner_id.clone())
            .collect();
        owners
            .into_iter()
            .map(|owner_id| self.mt_token_approval(token_id.clone(), owner_id))
            .collect()
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
        let start = clamp_index(from_index);
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
        let start = clamp_index(from_index);
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

    /// A batch moves one account's materials, so either no approvals are given
    /// (the caller spends their own) or every approval names the same owner.
    /// Mixing owners in one batch would need an event per owner; refusing it is
    /// clearer than silently splitting, and nothing needs it.
    fn resolve_batch_source(
        &mut self,
        caller: &AccountId,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        token_ids: &[String],
        amounts: &[u128],
    ) -> (AccountId, bool) {
        let Some(approvals) = approvals else { return (caller.clone(), false) };
        if approvals.iter().all(|a| a.is_none()) {
            return (caller.clone(), false);
        }
        let owners: Vec<&AccountId> = approvals.iter().flatten().map(|(o, _)| o).collect();
        require!(
            approvals.iter().all(|a| a.is_some()),
            "a batch must give an approval for every token id, or none at all"
        );
        require!(
            owners.windows(2).all(|w| w[0] == w[1]),
            "every approval in a batch must name the same owner"
        );
        let mut source = caller.clone();
        for (i, token_id) in token_ids.iter().enumerate() {
            source = self.resolve_source(caller, approvals[i].clone(), token_id, amounts[i]);
        }
        (source, true)
    }

    fn find_approval(&self, owner_id: &AccountId, approved: &AccountId, token_id: &str) -> Option<(u128, u64)> {
        self.approvals
            .get(&ApprovalsKey { token_id: token_id.to_string(), owner_id: owner_id.clone() })?
            .iter()
            .find(|(who, _, _)| who == approved)
            .map(|(_, amount, id)| (*amount, *id))
    }

    /// Whose materials are moving, and may the caller move them?
    ///
    /// With no approval the caller spends their own. With one, the caller is
    /// acting for `owner` and the allowance is checked and then **decremented
    /// by the amount transferred** — see the note at the top of this file on
    /// why that is the reading of "nullify" we chose for fungible amounts.
    fn resolve_source(
        &mut self,
        caller: &AccountId,
        approval: Option<(AccountId, u64)>,
        token_id: &str,
        amount: u128,
    ) -> AccountId {
        let Some((owner_id, approval_id)) = approval else { return caller.clone() };
        require!(&owner_id != caller, "an approval naming yourself has no effect");
        let (allowed, current_id) = self
            .find_approval(&owner_id, caller, token_id)
            .unwrap_or_else(|| env::panic_str("no approval for this caller and material"));
        // A stale id means the owner re-granted or revoked since; refuse it.
        require!(current_id == approval_id, "approval_id does not match the current approval");
        require!(allowed >= amount, "the approved amount is lower than this transfer");

        let key = ApprovalsKey { token_id: token_id.to_string(), owner_id: owner_id.clone() };
        let mut entries = self.approvals.get(&key).cloned().unwrap_or_default();
        if let Some(at) = entries.iter().position(|(who, _, _)| who == caller) {
            let left = allowed - amount;
            if left == 0 { entries.remove(at); } else { entries[at].1 = left; }
        }
        if entries.is_empty() { self.approvals.remove(&key); } else { self.approvals.insert(key, entries); }
        owner_id
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
        // Strictly. This read `|| last.contains("old_owner_id")`, and the right
        // disjunct subsumes the left — so it passed for the WRONG owner, and
        // the strict half it was written to check never bound.
        assert!(last.contains(r#""old_owner_id":"alice""#), "the event must name the real old owner");
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

    // ------------------------------------- Approval Management extension
    //
    // This exists so a player whose account holds only a function-call access
    // key can sell: such a key cannot attach the 1 yoctoNEAR a transfer needs,
    // so the market moves their materials on their behalf instead. See
    // docs/GASLESS.md for the measurement that forced it.

    /// accounts(2) stands in for the market throughout.
    fn market() -> AccountId { accounts(2) }

    #[test]
    fn an_approved_account_can_move_the_owners_materials() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);

        // The owner approves the market once.
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(60)], market(), None);
        let id = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;

        // The market now moves the owner's materials without the owner signing.
        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(25), Some((accounts(1), id.0)), None);

        assert_eq!(c.mt_balance_of(accounts(1), IRON.to_string()), U128(75), "came out of the owner");
        assert_eq!(c.mt_balance_of(accounts(3), IRON.to_string()), U128(25));
        assert_eq!(c.mt_balance_of(market(), IRON.to_string()), U128(0), "the market never held them");
        assert_eq!(c.mt_supply(IRON.to_string()), Some(U128(1_000)));

        // The event names who acted, since it was not the owner.
        let last = get_logs().last().unwrap().clone();
        // Strictly, for the same reason as the `old_owner_id` one above: the
        // `|| contains("authorized_id")` this used to carry subsumed the real
        // check, so it passed whatever the id said.
        assert!(last.contains(r#""authorized_id":"charlie""#), "got: {last}");
    }

    /// Our reading of the spec's "nullify approvals on success" for fungible
    /// amounts: decrement, do not wipe. Otherwise a standing operator approval
    /// would be impossible, which is the whole use case.
    /// The sixth Approval Management method, which did not exist until the
    /// conformance checker was taught to ask for it.
    #[test]
    fn every_owner_s_approvals_for_one_material_can_be_enumerated() {
        let mut c = stocked();
        // Two different owners, each approving the market for the same material.
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        // accounts(3), not accounts(2) — market() IS accounts(2), and a
        // self-approval is refused.
        c.mt_transfer(accounts(3), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(30)], market(), None);
        setup(accounts(3), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(40)], market(), None);
        // And one on a DIFFERENT material, which must not show up.
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), OAK.to_string(), U128(10), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![OAK.to_string()], vec![U128(5)], market(), None);

        let all = c.mt_token_approvals(IRON.to_string(), None, None);
        assert_eq!(all.len(), 2, "both owners of the material, and only them");
        let mut owners: Vec<String> = all.iter().map(|a| a.approval_owner_id.to_string()).collect();
        owners.sort();
        assert_eq!(owners, vec![accounts(1).to_string(), accounts(3).to_string()]);
        for entry in &all {
            assert!(entry.approved_account_ids.contains_key(&market()));
        }

        // Pagination, which is what the signature exists for.
        assert_eq!(c.mt_token_approvals(IRON.to_string(), None, Some(1)).len(), 1);
        assert_eq!(c.mt_token_approvals(IRON.to_string(), Some(U128(1)), None).len(), 1);
        assert!(c.mt_token_approvals(IRON.to_string(), Some(U128(2)), None).is_empty());
        assert!(
            c.mt_token_approvals("nothing_like_this".to_string(), None, None).is_empty(),
            "a material nobody has approved anything for is empty, not an error"
        );
    }

    /// An offset past the end must return nothing, not wrap to the start.
    ///
    /// `from_index.0 as usize` truncates, and 2^32 is the offset that breaks it
    /// on wasm32 where `usize` is 32 bits. **This test used 2^32 first and
    /// passed either way** — unit tests run on the 64-bit host, where 2^32 fits
    /// in a `usize` and nothing truncates. A check that cannot fail, written
    /// while fixing checks that cannot fail.
    ///
    /// 2^64 discriminates on both targets: `as usize` makes it 0 on a 64-bit
    /// host, which is the first page, and `usize::try_from` refuses it. So this
    /// now fails against the old cast everywhere it can be run.
    #[test]
    fn an_absurd_pagination_offset_returns_nothing_rather_than_the_first_page() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(30)], market(), None);

        // `(1u128 << 64) as usize` is 0 on a 64-bit host and 0 on wasm32 too,
        // so this one offset catches the bug on either target.
        let wraps_to_zero = U128(1u128 << 64);
        assert!(c.mt_token_approvals(IRON.to_string(), Some(wraps_to_zero), None).is_empty(),
            "an offset of 2^64 must skip past the end, not wrap to the first page");
        assert!(c.mt_tokens(Some(wraps_to_zero), None).is_empty(), "same for mt_tokens");
        assert!(c.mt_tokens_for_owner(accounts(1), Some(wraps_to_zero), None).is_empty(),
            "and for mt_tokens_for_owner");
        // 2^32 is the offset that breaks wasm32 specifically. It cannot fail
        // here, and is asserted anyway so the wasm target is covered if these
        // ever run there.
        assert!(c.mt_token_approvals(IRON.to_string(), Some(U128(1u128 << 32)), None).is_empty());
    }

    #[test]
    fn an_approval_is_decremented_by_what_was_spent_and_removed_when_exhausted() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(30)], market(), None);
        let id = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;

        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(10), Some((accounts(1), id.0)), None);
        let left = c.mt_token_approval(IRON.to_string(), accounts(1));
        assert_eq!(left.approved_account_ids[&market()].amount, U128(20), "30 - 10");

        // Spend the rest; the entry goes away rather than lingering at zero.
        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(20), Some((accounts(1), id.0)), None);
        assert!(
            c.mt_token_approval(IRON.to_string(), accounts(1)).approved_account_ids.is_empty(),
            "an exhausted approval must not linger"
        );
    }

    #[test]
    #[should_panic(expected = "the approved amount is lower than this transfer")]
    fn a_transfer_beyond_the_approved_amount_is_refused() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(5)], market(), None);
        let id = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;
        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(6), Some((accounts(1), id.0)), None);
    }

    /// A re-grant must invalidate the old id, or an owner who reduced an
    /// allowance would still be exposed to the previous one.
    #[test]
    #[should_panic(expected = "approval_id does not match the current approval")]
    fn a_stale_approval_id_is_refused_after_a_re_grant() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(50)], market(), None);
        let first = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;

        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(10)], market(), None);
        let second = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;
        assert!(second.0 > first.0, "a re-grant must increment the id");

        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(5), Some((accounts(1), first.0)), None);
    }

    #[test]
    #[should_panic(expected = "no approval for this caller and material")]
    fn an_unapproved_caller_cannot_move_someone_elses_materials() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(market(), 1);
        c.mt_transfer(accounts(3), IRON.to_string(), U128(1), Some((accounts(1), 1)), None);
    }

    #[test]
    fn revoking_withdraws_one_account_and_revoke_all_withdraws_everyone() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(10)], market(), None);
        c.mt_approve(vec![IRON.to_string()], vec![U128(10)], accounts(4), None);
        assert_eq!(c.mt_token_approval(IRON.to_string(), accounts(1)).approved_account_ids.len(), 2);

        setup(accounts(1), 1);
        c.mt_revoke(vec![IRON.to_string()], market());
        let left = c.mt_token_approval(IRON.to_string(), accounts(1));
        assert_eq!(left.approved_account_ids.len(), 1);
        assert!(left.approved_account_ids.contains_key(&accounts(4)), "only the named one goes");

        setup(accounts(1), 1);
        c.mt_revoke_all(vec![IRON.to_string()]);
        assert!(c.mt_token_approval(IRON.to_string(), accounts(1)).approved_account_ids.is_empty());
    }

    #[test]
    fn mt_is_approved_checks_the_amount_and_the_id() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(100), None, None);
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(40)], market(), None);
        let id = c.mt_token_approval(IRON.to_string(), accounts(1))
            .approved_account_ids[&market()].approval_id;

        setup(accounts(1), 0);
        assert!(c.mt_is_approved(vec![IRON.to_string()], market(), vec![U128(40)], None, accounts(1)));
        assert!(c.mt_is_approved(vec![IRON.to_string()], market(), vec![U128(1)], Some(vec![id.0]), accounts(1)));
        assert!(!c.mt_is_approved(vec![IRON.to_string()], market(), vec![U128(41)], None, accounts(1)), "over the amount");
        assert!(!c.mt_is_approved(vec![IRON.to_string()], market(), vec![U128(1)], Some(vec![id.0 + 99]), accounts(1)), "wrong id");
        assert!(!c.mt_is_approved(vec![IRON.to_string()], accounts(4), vec![U128(1)], None, accounts(1)), "never approved");
        // Mismatched argument lengths are false rather than a panic: this is a
        // view a caller may probe with, not a state change.
        assert!(!c.mt_is_approved(vec![IRON.to_string()], market(), vec![], None, accounts(1)));

        // The owner argument is load-bearing, not decoration. accounts(0) never
        // approved anything, and asking about it must say so rather than
        // quietly answering for whoever happens to be calling — which is what
        // the predecessor-reading version did, and why it could not be a view.
        assert!(
            !c.mt_is_approved(vec![IRON.to_string()], market(), vec![U128(1)], None, accounts(0)),
            "a different owner's approvals must not be reported as this owner's"
        );
    }

    #[test]
    #[should_panic(expected = "approving yourself has no effect")]
    fn approving_yourself_is_refused() {
        let mut c = stocked();
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(1)], accounts(1), None);
    }

    #[test]
    #[should_panic(expected = "requires a deposit")]
    fn approving_for_free_is_refused() {
        let mut c = stocked();
        setup(accounts(1), 0);
        c.mt_approve(vec![IRON.to_string()], vec![U128(1)], market(), None);
    }

    #[test]
    #[should_panic(expected = "an approval of zero is a revocation")]
    fn approving_zero_is_refused_rather_than_silently_doing_nothing() {
        let mut c = stocked();
        setup(accounts(1), 1);
        c.mt_approve(vec![IRON.to_string()], vec![U128(0)], market(), None);
    }

    #[test]
    #[should_panic(expected = "every approval in a batch must name the same owner")]
    fn a_batch_must_not_mix_owners() {
        let mut c = stocked();
        setup(market(), 1);
        c.mt_batch_transfer(
            accounts(3),
            vec![IRON.to_string(), OAK.to_string()],
            vec![U128(1), U128(1)],
            Some(vec![Some((accounts(1), 1)), Some((accounts(4), 2))]),
            None,
        );
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

    /// The approvals list is bounded, and the bound is reached by a test
    /// rather than asserted in a comment.
    ///
    /// Every `mt_transfer` on a (material, owner) pair deserializes this whole
    /// vector, so an unbounded one is a balance that eventually cannot move.
    /// Only the owner can grow their own list — `mt_approve` takes `owner_id`
    /// from the predecessor — so this is self-inflicted rather than a way to
    /// attack somebody else. It is still worth refusing: a limit a caller can
    /// see beats materials nobody can shift.
    #[test]
    fn approvals_for_one_material_are_bounded() {
        let mut c = stocked();
        for i in 0..MAX_APPROVALS_PER_TOKEN {
            setup(accounts(0), 1);
            let spender: AccountId = format!("spender-{i}.near").parse().unwrap();
            c.mt_approve(vec![IRON.to_string()], vec![U128(10)], spender, None);
        }
        assert_eq!(
            c.mt_token_approval(IRON.to_string(), accounts(0)).approved_account_ids.len(),
            MAX_APPROVALS_PER_TOKEN,
            "the bound should be reachable, or this test proves nothing",
        );

        // One more is refused rather than silently appended.
        setup(accounts(0), 1);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.mt_approve(vec![IRON.to_string()], vec![U128(10)], accounts(2), None)
        }));
        assert!(result.is_err(), "the 65th distinct approval must be refused");

        // And re-approving someone already on the list still works, because
        // that replaces an entry instead of growing the vector.
        setup(accounts(0), 1);
        let existing: AccountId = "spender-0.near".parse().unwrap();
        c.mt_approve(vec![IRON.to_string()], vec![U128(99)], existing, None);
    }

    /// A receiver that answers with too FEW entries must not keep the rest.
    ///
    /// `mt_on_transfer` returns one "unused" figure per token id. An over-long
    /// claim is clamped — `resolve_transfer_clamps_a_lying_receiver` covers
    /// that — but a SHORT answer was read as zero unused, which means "the
    /// receiver kept everything". So a receiver that returned fewer entries
    /// than it was sent, whether through a bug or on purpose, silently kept
    /// materials it never claimed.
    ///
    /// Zero is the wrong default in the one direction that costs the sender.
    /// A missing answer is not a claim; it refunds.
    #[test]
    fn a_short_answer_from_a_receiver_refunds_rather_than_forfeits() {
        let mut c = stocked();
        setup(accounts(0), 1);
        c.mt_transfer(accounts(1), IRON.to_string(), U128(10), None, None);
        c.mt_transfer(accounts(1), OAK.to_string(), U128(200), None, None);

        // Two tokens sent, ONE figure returned. Nothing is said about OAK.
        let used = c.mt_resolve_transfer(
            accounts(0),
            accounts(1),
            vec![IRON.to_string(), OAK.to_string()],
            vec![U128(10), U128(200)],
            Ok(vec![U128(4)]),
        );

        assert_eq!(used[0], U128(6), "the figure that WAS given is honoured: 4 of 10 refunded");
        assert_eq!(
            used[1], U128(0),
            "and the one that was not given refunds in full rather than being kept"
        );
        assert_eq!(c.mt_balance_of(accounts(1), OAK.to_string()), U128(0), "the oak came back");
        assert_eq!(c.mt_balance_of(accounts(0), OAK.to_string()), U128(500));
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
