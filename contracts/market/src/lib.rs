//! NearCraft merchants — stock-and-demand pricing, treasuries, settlement.
//!
//! Each merchant is a named NEAR account (`ironmonger.nearcraftmc.testnet`) with
//! its own treasury and its own shelf. Prices come from `pricing.rs` and nowhere
//! else.
//!
//! **Custody, stated plainly rather than glossed:** this contract is the
//! custodian of the shop-floor material pool. Per-merchant inventory is
//! attributed in *this* contract's state, and the NEP-245 balances backing it
//! sit against this contract's account in the items contract. Each merchant's
//! *earnings* are attributed to its own account and withdrawable only by it.
//! So merchants have their own accounts and their own treasuries, but they do
//! not independently hold their stock on-chain. That is a deliberate custody
//! split, not a missing feature: NEP-245 Approval Management **is** implemented
//! in `contracts/items` and is what the player sell path uses, but moving every
//! merchant's shelf into its own account is a larger change than the window
//! allowed and nothing needs it.
//!
//! Money is plain NEAR. Proceeds are credited as a withdrawable balance rather
//! than pushed, because a failed push would cost someone their goods.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub mod pricing;
use pricing::{buy_price, restock_plan, scarcity_band, unit_price, BPS};

const GAS_FOR_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_DELIVERY_CALLBACK: Gas = Gas::from_tgas(12);
/// A payout callback only restores a ledger entry, so it needs very little.
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(8);
const GAS_FOR_MT_MINT: Gas = Gas::from_tgas(15);
const GAS_FOR_RESTOCK_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_items)]
#[allow(dead_code)]
trait Items {
    /// Owner-only on the items contract, and this contract IS that owner — which
    /// is what lets a merchant restock without anyone minting for it by hand.
    fn mt_mint(&mut self, token_id: String, amount: U128, receiver_id: AccountId);
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait MarketCallbacks {
    fn on_items_delivered(
        &mut self,
        buyer_id: AccountId,
        merchant_id: AccountId,
        item: String,
        count: U128,
        paid: U128,
    );
    fn on_materials_pulled(
        &mut self,
        seller_id: AccountId,
        merchant_id: AccountId,
        item: String,
        count: U128,
        proceeds: U128,
    );
    fn on_restocked(&mut self, merchant_id: AccountId, item: String, units: U128, cost: U128);
    fn on_credit_paid(&mut self, who: AccountId, amount: U128);
    fn on_treasury_paid(&mut self, merchant_id: AccountId, amount: U128);
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Merchant {
    pub name: String,
    /// yoctoNEAR earned and withdrawable by this merchant's own account.
    pub treasury: U128,
    /// Below this the merchant stops bidding and reports closed.
    pub floor: U128,
}

/// One material on one merchant's shelf.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Listing {
    pub base_price: U128,
    pub stock: U128,
    pub demand_bps: U128,
    /// `env::block_timestamp` when demand was last touched, for decay.
    pub demand_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[borsh(crate = "near_sdk::borsh")]
struct ListingKey {
    merchant_id: AccountId,
    item: String,
}

/// What a merchant will do right now, and why. `reason` is what the in-game
/// tooltip renders verbatim — it is built from the same numbers the price used,
/// so it can never drift from the price.
#[near(serializers = [json])]
pub struct Quote {
    pub merchant_id: AccountId,
    pub merchant_name: String,
    pub item: String,
    pub count: u32,
    pub unit_price: U128,
    pub total: U128,
    /// What the merchant pays per unit, or `None` when it is closed.
    pub merchant_bid: Option<U128>,
    pub stock: U128,
    pub band: String,
    pub demand_bps: U128,
    pub closed: bool,
    pub reason: String,
}

/// Render yoctoNEAR as a human-readable NEAR amount, to three decimals.
///
/// The quote `reason` is shown to a player in an in-game tooltip, so it must not
/// contain raw 24-digit integers. Done with integer arithmetic — a contract has
/// no business doing floating point, and `f64` would lose precision above 2^53
/// anyway.
fn near_str(yocto: u128) -> String {
    let whole = yocto / 1_000_000_000_000_000_000_000_000;
    let milli = (yocto % 1_000_000_000_000_000_000_000_000) / 1_000_000_000_000_000_000_000;
    format!("{whole}.{milli:03}")
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner_id: AccountId,
    items_contract: AccountId,
    merchants: IterableMap<AccountId, Merchant>,
    listings: IterableMap<ListingKey, Listing>,
    /// Withdrawable proceeds, for players selling and for refunds.
    credits: IterableMap<AccountId, U128>,
}

#[near]
impl Market {
    #[init]
    pub fn new(owner_id: AccountId, items_contract: AccountId) -> Self {
        Self {
            owner_id,
            items_contract,
            merchants: IterableMap::new(b"m".to_vec()),
            listings: IterableMap::new(b"l".to_vec()),
            credits: IterableMap::new(b"c".to_vec()),
        }
    }

    // ------------------------------------------------------------ bootstrap

    pub fn register_merchant(&mut self, merchant_id: AccountId, name: String, floor: U128) {
        self.assert_owner();
        require!(!self.merchants.contains_key(&merchant_id), "merchant already registered");
        self.merchants.insert(merchant_id, Merchant { name, treasury: U128(0), floor });
    }

    /// Put a material on a merchant's shelf, or restock it.
    pub fn list_item(&mut self, merchant_id: AccountId, item: String, base_price: U128, stock: U128) {
        self.assert_owner();
        require!(self.merchants.contains_key(&merchant_id), "unknown merchant");
        require!(base_price.0 > 0, "base_price must be positive");
        let key = ListingKey { merchant_id, item };
        match self.listings.get(&key).cloned() {
            Some(existing) => {
                self.listings.insert(key, Listing { base_price, stock, ..existing });
            }
            None => {
                self.listings.insert(
                    key,
                    Listing { base_price, stock, demand_bps: U128(BPS), demand_at: env::block_timestamp() },
                );
            }
        }
    }

    /// Seed a merchant's treasury so it can bid. Owner-only, payable.
    #[payable]
    pub fn fund_merchant(&mut self, merchant_id: AccountId) {
        self.assert_owner();
        self.add_to_treasury(merchant_id, env::attached_deposit().as_yoctonear());
    }

    /// Put money into a merchant so it can trade again. Anyone may call this.
    ///
    /// The `games` prompt's own description of the economy ends: "If a merchant
    /// goes broke, it closes its shop **until someone invests in it**." This is
    /// that sentence. A merchant goes broke by buying more from players than it
    /// sells — its treasury falls to its floor and it stops posting bids — and
    /// anyone can reopen it by funding it.
    ///
    /// **What the investor gets back is the shop, not a dividend**, and that is
    /// a real incentive rather than altruism: a closed merchant will not buy
    /// from you. If the only merchant that deals in iron is broke, the player
    /// with iron to sell is exactly the person who wants it funded. The
    /// mechanic works because the interest is self-interest.
    ///
    /// A richer version — a tracked stake repaid out of the merchant's future
    /// margin — is designed in `docs/RECAPITALIZATION.md` and **is not built**.
    /// It needs per-stakeholder accounting and a cost basis per shelf, which is
    /// new contract state; this needs none, which is why it exists today. The
    /// note says which is which.
    ///
    /// Deliberately not restricted to closed merchants. A merchant one yocto
    /// above its floor is broke in every practical sense, and refusing money to
    /// it on a technicality would be a worse rule than accepting it.
    #[payable]
    pub fn invest(&mut self, merchant_id: AccountId) -> bool {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach something to invest");
        let was_closed = self.is_closed(merchant_id.clone());
        self.add_to_treasury(merchant_id.clone(), amount);
        let reopened = was_closed && !self.is_closed(merchant_id.clone());

        env::log_str(&format!(
            "{} invested {} NEAR in {merchant_id}{}",
            env::predecessor_account_id(),
            near_str(amount),
            if reopened {
                ", which reopened its shop"
            } else if was_closed {
                ", which is not yet enough to reopen its shop"
            } else {
                ""
            }
        ));
        reopened
    }

    /// Invest from a credited budget — the only path a scoped key can take.
    ///
    /// `invest` is `#[payable]`, and a function-call access key cannot attach
    /// NEAR at all. So without this method the mechanic the `games` prompt
    /// describes would be unreachable for exactly the players it is for: the
    /// ones holding a single scoped key and no seed phrase. The same reason
    /// `buy_with_credit` exists beside `buy`, and `sell` is non-payable.
    pub fn invest_with_credit(&mut self, merchant_id: AccountId, amount: U128) -> bool {
        require!(amount.0 > 0, "invest something");
        let who = env::predecessor_account_id();
        let budget = self.credits.get(&who).copied().unwrap_or(U128(0)).0;
        require!(budget >= amount.0, "insufficient credit to invest that much");

        let was_closed = self.is_closed(merchant_id.clone());
        self.credits.insert(who.clone(), U128(budget - amount.0));
        self.add_to_treasury(merchant_id.clone(), amount.0);
        let reopened = was_closed && !self.is_closed(merchant_id.clone());

        env::log_str(&format!(
            "{who} invested {} NEAR of credit in {merchant_id}{}",
            near_str(amount.0),
            if reopened { ", which reopened its shop" } else { "" }
        ));
        reopened
    }

    /// The one place a treasury grows from outside. Shared so the owner's
    /// genesis funding and a player's rescue cannot drift apart.
    fn add_to_treasury(&mut self, merchant_id: AccountId, amount: u128) {
        let mut merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        merchant.treasury = U128(merchant.treasury.0 + amount);
        self.merchants.insert(merchant_id, merchant);
    }

    // ---------------------------------------------------------------- views

    pub fn quote(&self, merchant_id: AccountId, item: String, count: u32) -> Quote {
        let merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        let listing = self
            .listings
            .get(&ListingKey { merchant_id: merchant_id.clone(), item: item.clone() })
            .cloned()
            .expect("this merchant does not deal in that material");
        self.build_quote(merchant_id, &merchant, &listing, item, count)
    }

    /// Every merchant's quote for one material — what the tooltip and the
    /// `npm run reads` script both use to show a player where to walk.
    pub fn quotes(&self, item: String, count: u32) -> Vec<Quote> {
        self.merchants
            .iter()
            .filter_map(|(merchant_id, merchant)| {
                self.listings
                    .get(&ListingKey { merchant_id: merchant_id.clone(), item: item.clone() })
                    .map(|listing| {
                        self.build_quote(merchant_id.clone(), merchant, listing, item.clone(), count)
                    })
            })
            .collect()
    }

    pub fn merchants(&self) -> Vec<(AccountId, Merchant)> {
        self.merchants.iter().map(|(id, m)| (id.clone(), m.clone())).collect()
    }

    pub fn merchant(&self, merchant_id: AccountId) -> Option<Merchant> {
        self.merchants.get(&merchant_id).cloned()
    }

    /// True when the merchant posts no buy price on anything it stocks: it keeps
    /// selling what it has, but it can no longer afford to buy. This is the
    /// "broke merchant closes" rule from GAME_LOOP.md.
    ///
    /// Note this is *not* simply `treasury <= floor`. A merchant only ever
    /// spends what sits above its floor, so its treasury approaches the floor
    /// without reaching it; the question that matters is whether it can still
    /// fund a single unit of anything. A rich merchant can also be closed for
    /// one expensive material while still bidding on a cheap one, which is why
    /// each `Quote` carries its own `closed` flag.
    pub fn is_closed(&self, merchant_id: AccountId) -> bool {
        let Some(merchant) = self.merchants.get(&merchant_id) else { return true };
        if Self::closed(merchant) {
            return true;
        }
        // A merchant with no shelves at all is closed.
        //
        // This used to return false — "not broke, just empty" — and that was
        // asserted deliberately. It was the wrong reading of the question this
        // method answers. `is_closed` is a routing signal, and `false` promises
        // "it will buy something from you"; a merchant stocking nothing will
        // refuse every sale, because `try_absorb` has no listing to absorb
        // into. Saying it is open sends a player to a shop that cannot trade.
        if !self.stocks_anything(&merchant_id) {
            return true;
        }
        let spare = merchant.treasury.0.saturating_sub(merchant.floor.0);
        for (key, listing) in self.listings.iter() {
            if key.merchant_id != merchant_id {
                continue;
            }
            let demand = self.current_demand(listing);
            if spare >= buy_price(listing.base_price.0, listing.stock.0, demand) {
                return false; // it can still fund a unit of this one
            }
        }
        true
    }

    /// Does this merchant have any shelf at all?
    ///
    /// Extracted because `is_closed` needs it and so will anything that has to
    /// distinguish "broke" from "has nothing to sell" — the two reach the same
    /// verdict here but for different reasons.
    fn stocks_anything(&self, merchant_id: &AccountId) -> bool {
        self.listings.iter().any(|(key, _)| &key.merchant_id == merchant_id)
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        self.credits.get(&account_id).copied().unwrap_or(U128(0))
    }

    /// Everything this contract owes: every merchant treasury plus every credit
    /// balance.
    ///
    /// Exists so solvency can be checked from outside — the contract's own NEAR
    /// balance must always cover this, or it is promising money it does not
    /// hold. A unit test cannot see that, because it has no account balance.
    ///
    /// O(state), and that is acceptable only because this economy is five
    /// merchants and a handful of players. Saying so rather than letting a
    /// reader assume it scales.
    pub fn ledger_total(&self) -> U128 {
        let treasuries: u128 = self.merchants.iter().map(|(_, m)| m.treasury.0).sum();
        let credits: u128 = self.credits.iter().map(|(_, c)| c.0).sum();
        U128(treasuries + credits)
    }

    pub fn items_contract(&self) -> AccountId {
        self.items_contract.clone()
    }

    // ------------------------------------------------------------------ buy

    /// Buy `count` of `item` from `merchant_id`, paying the quoted total.
    ///
    /// Stock and treasury move first, then the NEP-245 transfer goes out. If the
    /// transfer fails, `on_items_delivered` puts everything back and credits a
    /// refund — a payment never leaves a player without goods.
    #[payable]
    pub fn buy(&mut self, merchant_id: AccountId, item: String, count: u32) -> Promise {
        require!(count > 0, "count must be positive");
        let paid = env::attached_deposit().as_yoctonear();
        let buyer_id = env::predecessor_account_id();

        let merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.clone() };
        let listing = self.listings.get(&key).cloned().expect("this merchant does not deal in that material");

        let units = count as u128;
        require!(listing.stock.0 >= units, "merchant does not have that much in stock");

        let demand = self.current_demand(&listing);
        let total = unit_price(listing.base_price.0, listing.stock.0, demand).saturating_mul(units);
        require!(paid >= total, "attached deposit is below the quoted total");

        // Shelf down, demand up, treasury credited.
        self.listings.insert(
            key,
            Listing {
                stock: U128(listing.stock.0 - units),
                demand_bps: U128(pricing::bump_demand(demand, units)),
                demand_at: env::block_timestamp(),
                ..listing
            },
        );
        let mut merchant = merchant;
        merchant.treasury = U128(merchant.treasury.0 + total);
        self.merchants.insert(merchant_id.clone(), merchant);

        // Overpayment comes straight back as credit.
        if paid > total {
            self.credit(&buyer_id, paid - total);
        }

        self.deliver(buyer_id, merchant_id, item, units, total)
    }

    /// Roll the whole purchase back if delivery failed.
    #[private]
    pub fn on_items_delivered(
        &mut self,
        buyer_id: AccountId,
        merchant_id: AccountId,
        item: String,
        count: U128,
        paid: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let key = ListingKey { merchant_id: merchant_id.clone(), item };
        if let Some(listing) = self.listings.get(&key).cloned() {
            self.listings.insert(
                key,
                Listing {
                    stock: U128(listing.stock.0 + count.0),
                    demand_bps: U128(pricing::ease_demand(listing.demand_bps.0, count.0)),
                    demand_at: env::block_timestamp(),
                    ..listing
                },
            );
        }
        if let Some(mut merchant) = self.merchants.get(&merchant_id).cloned() {
            merchant.treasury = U128(merchant.treasury.0.saturating_sub(paid.0));
            self.merchants.insert(merchant_id, merchant);
        }
        self.credit(&buyer_id, paid.0);
        env::log_str(&format!(
            "delivery failed; purchase rolled back and {} yoctoNEAR credited to {}",
            paid.0, buyer_id
        ));
        false
    }

    /// Top up anyone's spend budget. Used to fund an agent before it shops.
    ///
    /// This exists because of a NEAR protocol rule that shapes the whole agent
    /// design: **a function-call access key cannot attach NEAR to a call.** An
    /// agent holding one therefore cannot call the payable `buy` at all. It
    /// spends from a budget credited here instead, which means its spending is
    /// bounded twice over — the key's `method_names` by the protocol, and this
    /// balance by the contract.
    #[payable]
    pub fn fund_credit(&mut self, account_id: AccountId) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach something to fund");
        self.credit(&account_id, amount);
    }

    /// Buy using the caller's credited budget instead of an attached deposit.
    ///
    /// This is the only purchase path an agent can take, and the only market
    /// method an agent's function-call key is permitted to name.
    pub fn buy_with_credit(&mut self, merchant_id: AccountId, item: String, count: u32) -> Promise {
        let buyer_id = env::predecessor_account_id();
        let budget = self.credits.get(&buyer_id).copied().unwrap_or(U128(0)).0;
        let total = self.quote(merchant_id.clone(), item.clone(), count).total.0;
        require!(budget >= total, "insufficient credit for this purchase");
        self.credits.insert(buyer_id.clone(), U128(budget - total));
        self.settle_purchase(buyer_id, merchant_id, item, count, total)
    }

    /// Sell materials to a merchant using an approval granted at account setup.
    ///
    /// **Not payable, on purpose.** A player whose account holds only a
    /// function-call access key cannot attach a deposit, so they cannot call
    /// NEP-245's `mt_transfer_call` — it requires 1 yoctoNEAR. Here the market
    /// *pulls* the materials instead, attaching that yoctoNEAR from its own
    /// balance, which makes selling reachable by a scoped key and therefore
    /// gasless when relayed. See docs/GASLESS.md.
    ///
    /// Only as much is pulled as the merchant can actually pay for, so the
    /// seller keeps the remainder rather than having it pulled and refunded.
    pub fn sell(&mut self, merchant_id: AccountId, item: String, count: u32, approval_id: U64) -> Promise {
        require!(count > 0, "count must be positive");
        let seller_id = env::predecessor_account_id();
        let merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.clone() };
        let listing = self.listings.get(&key).cloned().expect("this merchant does not deal in that material");

        let demand = self.current_demand(&listing);
        let unit_bid = buy_price(listing.base_price.0, listing.stock.0, demand);
        let spare = merchant.treasury.0.saturating_sub(merchant.floor.0);
        let affordable = spare.checked_div(unit_bid).unwrap_or(0);
        let take = (count as u128).min(affordable);
        require!(take > 0, "this merchant cannot afford a single unit right now");
        let proceeds = unit_bid.saturating_mul(take);

        // Bookkeeping first, then the pull; `on_materials_pulled` unwinds it if
        // the pull fails, the same shape as `buy`.
        self.listings.insert(
            key,
            Listing {
                stock: U128(listing.stock.0 + take),
                demand_bps: U128(pricing::ease_demand(demand, take)),
                demand_at: env::block_timestamp(),
                ..listing
            },
        );
        let mut merchant = merchant;
        merchant.treasury = U128(merchant.treasury.0 - proceeds);
        self.merchants.insert(merchant_id.clone(), merchant);
        self.credit(&seller_id, proceeds);

        ext_items::ext(self.items_contract.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_MT_TRANSFER)
            .mt_transfer(
                env::current_account_id(),
                item.clone(),
                U128(take),
                // The approval the player granted once, at account setup.
                Some((seller_id.clone(), approval_id.0)),
                Some("nearcraft sale".into()),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_DELIVERY_CALLBACK)
                    .on_materials_pulled(seller_id, merchant_id, item, U128(take), U128(proceeds)),
            )
    }

    /// Unwind the sale if the materials could not be pulled — a missing,
    /// stale or exhausted approval, or a seller who no longer holds them.
    #[private]
    pub fn on_materials_pulled(
        &mut self,
        seller_id: AccountId,
        merchant_id: AccountId,
        item: String,
        count: U128,
        proceeds: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let key = ListingKey { merchant_id: merchant_id.clone(), item };
        if let Some(listing) = self.listings.get(&key).cloned() {
            self.listings.insert(
                key,
                Listing {
                    stock: U128(listing.stock.0.saturating_sub(count.0)),
                    demand_bps: U128(pricing::bump_demand(listing.demand_bps.0, count.0)),
                    demand_at: env::block_timestamp(),
                    ..listing
                },
            );
        }
        if let Some(mut merchant) = self.merchants.get(&merchant_id).cloned() {
            merchant.treasury = U128(merchant.treasury.0 + proceeds.0);
            self.merchants.insert(merchant_id, merchant);
        }
        // Take the credit back: nothing was actually sold.
        let held = self.credits.get(&seller_id).copied().unwrap_or(U128(0)).0;
        self.credits.insert(seller_id.clone(), U128(held.saturating_sub(proceeds.0)));
        env::log_str(&format!(
            "could not pull materials from {seller_id}; sale unwound (approval missing, stale or exhausted?)"
        ));
        false
    }

    // ----------------------------------------------------------------- sell

    /// NEP-245 receiver hook. A player sells by calling `mt_transfer_call` on
    /// the items contract with `msg` set to the merchant account id.
    ///
    /// Returns the unused amount per NEP-245: zero when the sale is accepted,
    /// the full amount when it is refused, which makes the items contract
    /// refund the player automatically.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        // Only our own items contract may call this.
        require!(
            env::predecessor_account_id() == self.items_contract,
            "only the registered items contract may deliver materials"
        );
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must be the same length");
        let _ = previous_owner_ids;

        let merchant_id: AccountId = match msg.parse() {
            Ok(id) => id,
            Err(_) => return amounts, // unparseable target: refuse everything
        };

        let mut unused = Vec::with_capacity(token_ids.len());
        for (item, amount) in token_ids.iter().zip(amounts.iter()) {
            unused.push(U128(self.try_absorb(&sender_id, &merchant_id, item, amount.0)));
        }
        unused
    }

    /// Returns the amount refused (0 when fully absorbed).
    fn try_absorb(&mut self, seller_id: &AccountId, merchant_id: &AccountId, item: &str, units: u128) -> u128 {
        if units == 0 {
            return 0;
        }
        let Some(merchant) = self.merchants.get(merchant_id).cloned() else { return units };
        if Self::closed(&merchant) {
            return units; // a closed merchant does not buy
        }
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.to_string() };
        let Some(listing) = self.listings.get(&key).cloned() else { return units };

        let demand = self.current_demand(&listing);
        let unit_bid = buy_price(listing.base_price.0, listing.stock.0, demand);

        // Spend only what sits above the floor, and take only as many units as
        // that will actually pay for. NEP-245 lets us return the remainder, so a
        // merchant that can afford three of your four buys three — rather than
        // refusing the lot and leaving its treasury stranded just above the
        // floor, which is what made "a broke merchant closes" unreachable.
        let spare = merchant.treasury.0.saturating_sub(merchant.floor.0);
        let affordable = spare.checked_div(unit_bid).unwrap_or(0);
        let take = units.min(affordable);
        if take == 0 {
            return units; // closed for this material: it cannot afford one unit
        }
        let proceeds = unit_bid.saturating_mul(take);

        self.listings.insert(
            key,
            Listing {
                stock: U128(listing.stock.0 + take),
                demand_bps: U128(pricing::ease_demand(demand, take)),
                demand_at: env::block_timestamp(),
                ..listing
            },
        );
        let mut merchant = merchant;
        merchant.treasury = U128(merchant.treasury.0 - proceeds);
        self.merchants.insert(merchant_id.clone(), merchant);
        self.credit(seller_id, proceeds);
        units - take
    }

    // ------------------------------------------------------------- withdraw

    /// Take your credited proceeds. Players and merchants both use this; a
    /// merchant's treasury is separate and only it can withdraw it.
    /// Restock a thin shelf out of the merchant's own treasury.
    ///
    /// **Permissionless and non-payable, deliberately.** The `games` track asks
    /// for "economies that evolve without a dev patch", and until this existed
    /// the only way to put goods back on a shelf was the contract owner calling
    /// `list_item` — which is precisely a dev patch. Anyone may now poke a thin
    /// merchant, and a function-call key can do it because nothing is attached.
    ///
    /// Why it is not a griefing vector: the trigger is self-limiting. After one
    /// restock the shelf sits at `RESTOCK_TARGET_STOCK`, and nobody can re-arm
    /// it without *buying* the stock back down at a rising price. Repeated
    /// poking is a no-op, and the merchant comes out ahead in cash each time —
    /// see the arithmetic on `restock_plan`.
    ///
    /// Why it is not inside `buy` or `sell`: those paths already make a
    /// cross-contract call with a rollback, and adding a second, independent
    /// money movement to a path that has to unwind atomically is how an economy
    /// starts leaking. Keeping it separate keeps both rollbacks simple.
    pub fn restock(&mut self, merchant_id: AccountId, item: String) -> Promise {
        let merchant = self.merchants.get(&merchant_id).cloned().expect("no such merchant");
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.clone() };
        let listing = self.listings.get(&key).cloned().expect("this merchant does not deal in that material");

        let demand = self.current_demand(&listing);
        let spare = merchant.treasury.0.saturating_sub(merchant.floor.0);
        let (units, cost_per_unit) = restock_plan(listing.base_price.0, listing.stock.0, demand, spare);

        require!(
            listing.stock.0 < pricing::RESTOCK_TRIGGER_STOCK,
            "this shelf does not need restocking"
        );
        require!(units > 0, "this merchant cannot afford a single unit right now");

        let cost = cost_per_unit * units;

        // Books first, mint second, and the callback unwinds all of it if the
        // mint fails — the same shape as every other cross-contract path here.
        self.listings.insert(
            key,
            Listing { stock: U128(listing.stock.0 + units), ..listing },
        );
        let mut merchant = merchant;
        merchant.treasury = U128(merchant.treasury.0 - cost);
        self.merchants.insert(merchant_id.clone(), merchant);
        // The wholesaler is the house: the spend leaves the merchant and lands
        // as the owner's withdrawable credit, so it is a pure internal transfer
        // and the ledger total does not move.
        let owner = self.owner_id.clone();
        self.credit(&owner, cost);

        env::log_str(&format!(
            "{merchant_id} restocked {units} {item} at {} NEAR each, paying {} NEAR",
            near_str(cost_per_unit),
            near_str(cost)
        ));

        // Minting is what makes the shelf real. Raising `stock` without it would
        // attribute goods this contract does not hold, and the next purchase
        // would fail its delivery and roll back — the bug economy.rs exercises
        // deliberately with an unbacked shelf.
        ext_items::ext(self.items_contract.clone())
            .with_static_gas(GAS_FOR_MT_MINT)
            .mt_mint(item.clone(), U128(units), env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESTOCK_CALLBACK)
                    .on_restocked(merchant_id, item, U128(units), U128(cost)),
            )
    }

    /// Unwind a restock whose mint failed.
    #[private]
    pub fn on_restocked(
        &mut self,
        merchant_id: AccountId,
        item: String,
        units: U128,
        cost: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.clone() };
        if let Some(listing) = self.listings.get(&key).cloned() {
            self.listings.insert(
                key,
                Listing { stock: U128(listing.stock.0.saturating_sub(units.0)), ..listing },
            );
        }
        if let Some(merchant) = self.merchants.get(&merchant_id).cloned() {
            self.merchants.insert(
                merchant_id.clone(),
                Merchant { treasury: U128(merchant.treasury.0 + cost.0), ..merchant },
            );
        }
        // Take the owner's credit back too, or the restock would have paid the
        // house for goods that never arrived.
        let owner = self.owner_id.clone();
        let held = self.credits.get(&owner).copied().unwrap_or(U128(0)).0;
        self.credits.insert(owner, U128(held.saturating_sub(cost.0)));
        env::log_str(&format!(
            "{merchant_id} could not mint {} {item}; the restock was unwound",
            units.0
        ));
        false
    }

    pub fn withdraw(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.credits.get(&who).copied().unwrap_or(U128(0)).0;
        require!(amount > 0, "nothing to withdraw");
        // Zero the ledger first, then pay. If the payment fails the callback
        // puts it back — without that, the entry was gone and the NEAR was
        // refunded to this contract, so the claim simply evaporated and the
        // market quietly kept money it no longer accounted for.
        self.credits.insert(who.clone(), U128(0));
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_credit_paid(who, U128(amount)),
            )
    }

    /// Put a credit back if its payout failed.
    ///
    /// Reachable in practice, not theoretically: a transfer to an account that
    /// exists essentially cannot fail, but `NotEnoughBalance` can, because a
    /// slice of this contract's balance is locked as storage stake while the
    /// ledger total is free to approach it.
    #[private]
    pub fn on_credit_paid(
        &mut self,
        who: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        self.credit(&who, amount.0);
        env::log_str(&format!(
            "payout of {} NEAR to {who} failed; the credit has been restored",
            near_str(amount.0)
        ));
        false
    }

    /// A merchant withdrawing its own earnings, down to its floor.
    pub fn withdraw_treasury(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let mut merchant = self.merchants.get(&who).cloned().expect("caller is not a merchant");
        let withdrawable = merchant.treasury.0.saturating_sub(merchant.floor.0);
        require!(withdrawable > 0, "treasury is at or below its floor");
        merchant.treasury = U128(merchant.treasury.0 - withdrawable);
        self.merchants.insert(who.clone(), merchant);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(withdrawable))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_treasury_paid(who, U128(withdrawable)),
            )
    }

    /// Put a treasury back if its payout failed.
    ///
    /// Restores the *treasury* rather than crediting the merchant, which is not
    /// interchangeable: the floor is measured against the treasury, so paying a
    /// failed withdrawal back as credit would leave the merchant sitting at its
    /// floor and reporting closed while its money was somewhere else.
    #[private]
    pub fn on_treasury_paid(
        &mut self,
        merchant_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        if let Some(merchant) = self.merchants.get(&merchant_id).cloned() {
            self.merchants.insert(
                merchant_id.clone(),
                Merchant { treasury: U128(merchant.treasury.0 + amount.0), ..merchant },
            );
        }
        env::log_str(&format!(
            "treasury payout of {} NEAR to {merchant_id} failed; the treasury has been restored",
            near_str(amount.0)
        ));
        false
    }

    // ------------------------------------------------------------- internal

    /// Move the shelf and the treasury, then send the materials. Shared by the
    /// deposit path (`buy`) and the agent credit path (`buy_with_credit`).
    fn settle_purchase(
        &mut self,
        buyer_id: AccountId,
        merchant_id: AccountId,
        item: String,
        count: u32,
        total: u128,
    ) -> Promise {
        require!(count > 0, "count must be positive");
        let units = count as u128;
        let key = ListingKey { merchant_id: merchant_id.clone(), item: item.clone() };
        let listing = self.listings.get(&key).cloned().expect("this merchant does not deal in that material");
        require!(listing.stock.0 >= units, "merchant does not have that much in stock");
        let demand = self.current_demand(&listing);

        self.listings.insert(
            key,
            Listing {
                stock: U128(listing.stock.0 - units),
                demand_bps: U128(pricing::bump_demand(demand, units)),
                demand_at: env::block_timestamp(),
                ..listing
            },
        );
        let mut merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        merchant.treasury = U128(merchant.treasury.0 + total);
        self.merchants.insert(merchant_id.clone(), merchant);

        self.deliver(buyer_id, merchant_id, item, units, total)
    }

    fn deliver(
        &mut self,
        buyer_id: AccountId,
        merchant_id: AccountId,
        item: String,
        units: u128,
        total: u128,
    ) -> Promise {
        ext_items::ext(self.items_contract.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_MT_TRANSFER)
            .mt_transfer(buyer_id.clone(), item.clone(), U128(units), None, Some("nearcraft purchase".into()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_DELIVERY_CALLBACK)
                    .on_items_delivered(buyer_id, merchant_id, item, U128(units), U128(total)),
            )
    }

    fn build_quote(
        &self,
        merchant_id: AccountId,
        merchant: &Merchant,
        listing: &Listing,
        item: String,
        count: u32,
    ) -> Quote {
        let demand = self.current_demand(listing);
        let unit = unit_price(listing.base_price.0, listing.stock.0, demand);
        let unit_bid = buy_price(listing.base_price.0, listing.stock.0, demand);
        let spare = merchant.treasury.0.saturating_sub(merchant.floor.0);
        // Closed for *this* material when it cannot fund even one unit of it.
        // Treasury alone is not the whole story: a rich merchant can still be
        // priced out of an expensive material.
        let closed = Self::closed(merchant) || spare < unit_bid;
        let band = scarcity_band(listing.stock.0);
        let reason = if Self::closed(merchant) {
            format!(
                "{} holds {} ({}) and is closed to buying: its treasury is down to its floor.",
                merchant.name, listing.stock.0, band
            )
        } else if closed {
            format!(
                "{} holds {} ({}) but will not buy more: it has {} NEAR left to spend and one costs {}.",
                merchant.name, listing.stock.0, band, near_str(spare), near_str(unit_bid)
            )
        } else if demand > BPS {
            format!(
                "{} holds {} ({}), and recent buying has pushed demand to {:.2}x.",
                merchant.name,
                listing.stock.0,
                band,
                demand as f64 / BPS as f64
            )
        } else {
            format!("{} holds {} ({}); demand is quiet.", merchant.name, listing.stock.0, band)
        };
        Quote {
            merchant_id,
            merchant_name: merchant.name.clone(),
            item,
            count,
            unit_price: U128(unit),
            total: U128(unit.saturating_mul(count as u128)),
            merchant_bid: if closed { None } else { Some(U128(unit_bid)) },
            stock: listing.stock,
            band: band.to_string(),
            demand_bps: U128(demand),
            closed,
            reason,
        }
    }

    /// Demand decayed to now. Views and calls must agree, so both go through here.
    fn current_demand(&self, listing: &Listing) -> u128 {
        pricing::decay_demand(
            listing.demand_bps.0,
            env::block_timestamp().saturating_sub(listing.demand_at),
        )
    }

    fn closed(merchant: &Merchant) -> bool {
        merchant.treasury.0 <= merchant.floor.0
    }

    fn credit(&mut self, who: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let current = self.credits.get(who).copied().unwrap_or(U128(0)).0;
        self.credits.insert(who.clone(), U128(current + amount));
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-only convenience: the merchant's treasury as a plain integer.
    impl Market {
        fn merchant_treasury_for(&self, id: AccountId) -> u128 {
            self.merchant(id).unwrap().treasury.0
        }
    }
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const IRON: &str = "iron_ingot";
    /// One NEAR, as a readable base price.
    const BASE: u128 = 1_000_000_000_000_000_000_000_000;

    fn owner() -> AccountId { accounts(0) }
    fn items() -> AccountId { "items.test.near".parse().unwrap() }
    fn ironmonger() -> AccountId { "ironmonger.test.near".parse().unwrap() }
    fn player() -> AccountId { accounts(1) }

    fn ctx(predecessor: AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("market.test.near".parse().unwrap())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(100))
            .block_timestamp(1_000_000_000_000)
            .build());
    }

    /// A merchant with 256 iron (the reference band) and a funded treasury.
    fn market() -> Market {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE * 100);
        m.fund_merchant(ironmonger());
        m
    }

    #[test]
    fn quote_reports_price_stock_band_and_a_reason() {
        let m = market();
        let q = m.quote(ironmonger(), IRON.to_string(), 8);
        assert_eq!(q.stock, U128(256));
        assert_eq!(q.band, "normally stocked");
        assert_eq!(q.unit_price, U128(BASE), "the reference band quotes base price");
        assert_eq!(q.total, U128(BASE * 8));
        assert!(!q.closed);
        assert!(q.merchant_bid.unwrap().0 < q.unit_price.0, "the bid sits below the ask");
        assert!(q.reason.contains("Ironmonger") && q.reason.contains("256"));
        assert!(q.reason.contains("demand is quiet"));
    }

    #[test]
    #[should_panic(expected = "this merchant does not deal in that material")]
    fn quote_refuses_a_material_the_merchant_does_not_stock() {
        let m = market();
        m.quote(ironmonger(), "unobtainium".to_string(), 1);
    }

    #[test]
    fn buying_takes_stock_credits_treasury_and_raises_demand() {
        let mut m = market();
        let before = m.merchant(ironmonger()).unwrap().treasury.0;
        let total = m.quote(ironmonger(), IRON.to_string(), 10).total.0;

        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 10);

        let q = m.quote(ironmonger(), IRON.to_string(), 1);
        assert_eq!(q.stock, U128(246), "stock must fall by what was bought");
        assert_eq!(m.merchant(ironmonger()).unwrap().treasury.0, before + total);
        assert!(q.demand_bps.0 > BPS, "a purchase must push demand up");
        assert!(q.unit_price.0 > BASE, "and the next quote must be dearer");
        assert!(q.reason.contains("demand"));
    }

    #[test]
    fn overpayment_is_credited_back_not_kept() {
        let mut m = market();
        let total = m.quote(ironmonger(), IRON.to_string(), 2).total.0;
        ctx(player(), total + 777);
        let _ = m.buy(ironmonger(), IRON.to_string(), 2);
        assert_eq!(m.credit_of(player()), U128(777));
    }

    #[test]
    #[should_panic(expected = "attached deposit is below the quoted total")]
    fn underpaying_is_refused() {
        let mut m = market();
        let total = m.quote(ironmonger(), IRON.to_string(), 4).total.0;
        ctx(player(), total - 1);
        let _ = m.buy(ironmonger(), IRON.to_string(), 4);
    }

    #[test]
    #[should_panic(expected = "merchant does not have that much in stock")]
    fn cannot_buy_more_than_the_shelf_holds() {
        let mut m = market();
        ctx(player(), BASE * 10_000);
        let _ = m.buy(ironmonger(), IRON.to_string(), 257);
    }

    /// The whole purchase unwinds if the NEP-245 delivery fails.
    // ------------------------------------------------- the money invariant

    /// Everything this contract owes, as the test sees it.
    fn ledger(m: &Market) -> u128 {
        m.ledger_total().0
    }

    /// The identity, asserted at a named step so a failure says where.
    fn conserved(m: &Market, deposited: u128, paid_out: u128, step: &str) {
        let held = ledger(m);
        let expected = deposited - paid_out;
        assert_eq!(
            held, expected,
            "the ledger drifted {step}: it holds {held}, but {deposited} deposited \
             minus {paid_out} paid out is {expected}"
        );
    }

    /// Every yoctoNEAR that enters this contract is still accounted for.
    ///
    ///   sum(treasuries) + sum(credits) == deposited - paid out
    ///
    /// `docs/RECAPITALIZATION.md` calls this the gate and it did not exist until
    /// now, which matters because the contract has fourteen money-moving paths
    /// and three of them were added the same day as this test.
    ///
    /// The point is the step-by-step assertion. Checking only at the end would
    /// let two errors cancel; checking after every call says which one broke it.
    /// Four payable entry points add, two withdrawals remove, and **everything
    /// else must net to exactly zero** — a credit out and a treasury in, or the
    /// reverse. Each rollback has to put back precisely what its forward path
    /// took.
    #[test]
    fn every_yocto_is_accounted_for() {
        let mut deposited: u128 = 0;
        let mut paid_out: u128 = 0;

        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        conserved(&m, deposited, paid_out, "on a fresh contract");

        // Registering and listing move no money at all.
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        conserved(&m, deposited, paid_out, "after registering and listing");

        // ── in: the owner funds a treasury ──────────────────────────────────
        ctx(owner(), BASE * 100);
        m.fund_merchant(ironmonger());
        deposited += BASE * 100;
        conserved(&m, deposited, paid_out, "after fund_merchant");

        // ── in: anyone funds a spend budget ─────────────────────────────────
        ctx(player(), BASE * 50);
        m.fund_credit(player());
        deposited += BASE * 50;
        conserved(&m, deposited, paid_out, "after fund_credit");

        // ── in: a payable purchase, paid exactly ────────────────────────────
        let total = m.quote(ironmonger(), IRON.to_string(), 4).total.0;
        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 4);
        deposited += total;
        conserved(&m, deposited, paid_out, "after an exact buy");

        // ── in: a purchase that overpays. The excess must stay inside, as
        //       buyer credit, not vanish into the contract's pocket.
        let total = m.quote(ironmonger(), IRON.to_string(), 4).total.0;
        ctx(player(), total + BASE * 3);
        let _ = m.buy(ironmonger(), IRON.to_string(), 4);
        deposited += total + BASE * 3;
        conserved(&m, deposited, paid_out, "after an overpaid buy");

        // ── internal: a failed delivery rolls the purchase back ─────────────
        ctx("market.test.near".parse().unwrap(), 0);
        m.on_items_delivered(
            player(), ironmonger(), IRON.to_string(), U128(4), U128(total),
            Err(PromiseError::Failed),
        );
        conserved(&m, deposited, paid_out, "after a delivery rollback");

        // ── internal: the agent path spends a budget ────────────────────────
        ctx(player(), 0);
        let _ = m.buy_with_credit(ironmonger(), IRON.to_string(), 2);
        conserved(&m, deposited, paid_out, "after buy_with_credit");

        // ── internal: a sale pulled under an approval ───────────────────────
        ctx(player(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 2, U64(1));
        conserved(&m, deposited, paid_out, "after sell");

        // ── internal: and its rollback ──────────────────────────────────────
        let proceeds = m.quote(ironmonger(), IRON.to_string(), 2).merchant_bid.unwrap().0 * 2;
        ctx("market.test.near".parse().unwrap(), 0);
        m.on_materials_pulled(
            player(), ironmonger(), IRON.to_string(), U128(2), U128(proceeds),
            Err(PromiseError::Failed),
        );
        conserved(&m, deposited, paid_out, "after a sale rollback");

        // ── internal: the push path, including a partial fill ───────────────
        ctx(items(), 0);
        m.mt_on_transfer(
            player(), vec![player()], vec![IRON.to_string()], vec![U128(6)],
            ironmonger().to_string(),
        );
        conserved(&m, deposited, paid_out, "after mt_on_transfer");

        // ── internal: a restock pays the house out of the treasury ──────────
        ctx(owner(), 0);
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(8));
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
        conserved(&m, deposited, paid_out, "after a restock");

        // ── internal: and its rollback ──────────────────────────────────────
        ctx("market.test.near".parse().unwrap(), 0);
        m.on_restocked(ironmonger(), IRON.to_string(), U128(1), U128(BASE), Err(PromiseError::Failed));
        conserved(&m, deposited, paid_out, "after a restock rollback");

        // ── in: a payable investment ────────────────────────────────────────
        ctx(player(), BASE * 7);
        let _ = m.invest(ironmonger());
        deposited += BASE * 7;
        conserved(&m, deposited, paid_out, "after invest");

        // ── internal: investing from credit ─────────────────────────────────
        ctx(player(), 0);
        let _ = m.invest_with_credit(ironmonger(), U128(BASE * 2));
        conserved(&m, deposited, paid_out, "after invest_with_credit");

        // ── out: a credit withdrawal ────────────────────────────────────────
        let owed = m.credit_of(player()).0;
        ctx(player(), 0);
        let _ = m.withdraw();
        paid_out += owed;
        conserved(&m, deposited, paid_out, "after withdraw");

        // ── back in: the payout failed, so the claim returns ────────────────
        ctx("market.test.near".parse().unwrap(), 0);
        m.on_credit_paid(player(), U128(owed), Err(PromiseError::Failed));
        paid_out -= owed;
        conserved(&m, deposited, paid_out, "after a failed credit payout");

        // ── out: a treasury withdrawal ──────────────────────────────────────
        let merchant = m.merchant(ironmonger()).unwrap();
        let withdrawable = merchant.treasury.0 - merchant.floor.0;
        ctx(ironmonger(), 0);
        let _ = m.withdraw_treasury();
        paid_out += withdrawable;
        conserved(&m, deposited, paid_out, "after withdraw_treasury");

        // ── back in: that payout failed too ─────────────────────────────────
        ctx("market.test.near".parse().unwrap(), 0);
        m.on_treasury_paid(ironmonger(), U128(withdrawable), Err(PromiseError::Failed));
        paid_out -= withdrawable;
        conserved(&m, deposited, paid_out, "after a failed treasury payout");

        // Fourteen paths, and not one yoctoNEAR unaccounted for.
        assert!(deposited > 0 && ledger(&m) > 0, "the walk actually moved money");
    }

    // -------------------------------------------------------------- investing

    /// A merchant flooded until its treasury sits at its floor: closed to
    /// buying, which is the state the prompt describes.
    fn broke_market() -> Market {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        // Treasury at the floor exactly: nothing spare, so no bid.
        ctx(owner(), BASE);
        m.fund_merchant(ironmonger());
        m
    }

    #[test]
    fn a_player_can_reopen_a_broke_merchant() {
        let mut m = broke_market();
        assert!(m.is_closed(ironmonger()), "it starts closed, with no spare to bid with");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid, None);

        // Anyone — this is a player, not the owner. That is the whole point.
        ctx(player(), BASE * 10);
        let reopened = m.invest(ironmonger());

        assert!(reopened, "invest reports that it reopened the shop");
        assert!(!m.is_closed(ironmonger()), "and it is open");
        assert!(
            m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.is_some(),
            "a reopened merchant posts a bid again, which is what a seller cares about"
        );
        assert!(get_logs().iter().any(|l| l.contains("which reopened its shop")));
    }

    #[test]
    fn investing_too_little_says_so_rather_than_claiming_success() {
        let mut m = broke_market();
        ctx(player(), 1); // one yoctoNEAR: nowhere near a unit's bid
        let reopened = m.invest(ironmonger());
        assert!(!reopened, "it did not reopen, and must not pretend otherwise");
        assert!(m.is_closed(ironmonger()));
        assert!(get_logs().iter().any(|l| l.contains("not yet enough to reopen")));
    }

    #[test]
    fn investing_credits_the_treasury_exactly() {
        let mut m = broke_market();
        let before = m.merchant_treasury_for(ironmonger());
        ctx(player(), BASE * 3);
        let _ = m.invest(ironmonger());
        assert_eq!(
            m.merchant_treasury_for(ironmonger()) - before,
            BASE * 3,
            "every yocto attached reaches the treasury"
        );
    }

    #[test]
    #[should_panic(expected = "attach something to invest")]
    fn investing_nothing_is_refused() {
        let mut m = broke_market();
        ctx(player(), 0);
        let _ = m.invest(ironmonger());
    }

    #[test]
    #[should_panic(expected = "unknown merchant")]
    fn investing_in_a_merchant_that_does_not_exist_is_refused() {
        let mut m = broke_market();
        ctx(player(), BASE);
        let _ = m.invest("nobody.test.near".parse().unwrap());
    }

    #[test]
    fn the_owners_genesis_funding_still_works_and_shares_one_implementation() {
        // fund_merchant and invest differ in who may call and why, never in what
        // they do to the books — they go through the same internal.
        let mut m = broke_market();
        let before = m.merchant_treasury_for(ironmonger());
        ctx(owner(), BASE * 2);
        m.fund_merchant(ironmonger());
        assert_eq!(m.merchant_treasury_for(ironmonger()) - before, BASE * 2);
    }

    #[test]
    fn a_scoped_key_player_can_invest_from_credit() {
        let mut m = broke_market();
        // Fund the player's budget the way deploy does.
        ctx(player(), BASE * 10);
        m.fund_credit(player());

        assert!(m.is_closed(ironmonger()));
        // Non-payable: no deposit attached, which is the only thing a
        // function-call key can do.
        ctx(player(), 0);
        let reopened = m.invest_with_credit(ironmonger(), U128(BASE * 5));

        assert!(reopened, "the shop reopened");
        assert_eq!(m.credit_of(player()), U128(BASE * 5), "the budget paid for it");
        assert_eq!(m.merchant_treasury_for(ironmonger()), BASE + BASE * 5);
    }

    #[test]
    #[should_panic(expected = "insufficient credit to invest")]
    fn investing_more_credit_than_you_have_is_refused() {
        let mut m = broke_market();
        ctx(player(), BASE);
        m.fund_credit(player());
        ctx(player(), 0);
        let _ = m.invest_with_credit(ironmonger(), U128(BASE * 100));
    }

    #[test]
    fn investing_from_credit_leaves_the_ledger_total_unchanged() {
        // Credit out, treasury in: a pure internal transfer, like restocking.
        let mut m = broke_market();
        ctx(player(), BASE * 4);
        m.fund_credit(player());
        let total_before = m.credit_of(player()).0 + m.merchant_treasury_for(ironmonger());
        ctx(player(), 0);
        let _ = m.invest_with_credit(ironmonger(), U128(BASE * 2));
        let total_after = m.credit_of(player()).0 + m.merchant_treasury_for(ironmonger());
        assert_eq!(total_before, total_after);
    }

    // ------------------------------------------------------------- restocking

    /// A market whose iron shelf is thin enough to restock.
    fn thin_market() -> Market {
        let mut m = market();
        ctx(owner(), 0);
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(10));
        m
    }

    #[test]
    fn restocking_moves_stock_treasury_and_the_house_credit_together() {
        let mut m = thin_market();
        let treasury_before = m.merchant_treasury_for(ironmonger());
        let house_before = m.credit_of(owner()).0;
        let demand_before = m.quote(ironmonger(), IRON.to_string(), 1).demand_bps;

        // Anyone may poke it — this is called as a player, not as the owner.
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());

        let after = m.quote(ironmonger(), IRON.to_string(), 1);
        assert_eq!(after.stock, U128(128), "filled to the reference band");

        let spent = treasury_before - m.merchant_treasury_for(ironmonger());
        assert!(spent > 0, "the merchant paid for it");
        assert_eq!(
            m.credit_of(owner()).0 - house_before,
            spent,
            "the wholesaler is the house: every yocto the merchant spent landed as owner credit"
        );
        assert_eq!(
            after.demand_bps, demand_before,
            "a restock is not a player buying or selling, so demand must not move"
        );
    }

    #[test]
    #[should_panic(expected = "this shelf does not need restocking")]
    fn a_well_stocked_shelf_refuses_to_restock() {
        let mut m = market(); // 256 iron, far above the trigger
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
    }

    #[test]
    #[should_panic(expected = "cannot afford a single unit")]
    fn a_merchant_at_its_floor_cannot_restock() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(5));
        // No treasury at all, so no spare.
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
    }

    #[test]
    fn restocking_never_spends_into_the_floor() {
        let mut m = thin_market();
        let floor = m.merchant(ironmonger()).unwrap().floor.0;
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
        assert!(
            m.merchant_treasury_for(ironmonger()) >= floor,
            "the floor is the one line a merchant never crosses"
        );
    }

    #[test]
    fn a_failed_mint_unwinds_the_whole_restock() {
        let mut m = thin_market();
        let treasury_before = m.merchant_treasury_for(ironmonger());
        let house_before = m.credit_of(owner()).0;

        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
        let spent = treasury_before - m.merchant_treasury_for(ironmonger());
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(128));

        // The mint failed: the shelf must not claim goods this contract does not
        // hold, or the next purchase would fail its delivery instead.
        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_restocked(
            ironmonger(), IRON.to_string(), U128(118), U128(spent),
            Err(PromiseError::Failed),
        );

        assert!(!ok);
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(10), "shelf restored");
        assert_eq!(m.merchant_treasury_for(ironmonger()), treasury_before, "treasury restored");
        assert_eq!(m.credit_of(owner()).0, house_before, "the house was not paid for goods that never arrived");
        assert!(get_logs().iter().any(|l| l.contains("restock was unwound")));
    }

    #[test]
    fn a_successful_mint_unwinds_nothing() {
        let mut m = thin_market();
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
        let treasury = m.merchant_treasury_for(ironmonger());

        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_restocked(ironmonger(), IRON.to_string(), U128(118), U128(1), Ok(()));

        assert!(ok);
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(128), "shelf kept");
        assert_eq!(m.merchant_treasury_for(ironmonger()), treasury, "treasury kept");
    }

    #[test]
    fn restocking_leaves_the_ledger_total_unchanged() {
        // A restock moves money from a treasury to the house credit and nowhere
        // else, so the contract's total obligations must not budge. This is the
        // money invariant in miniature.
        let mut m = thin_market();
        let total_before = m.merchant_treasury_for(ironmonger()) + m.credit_of(owner()).0;
        ctx(player(), 0);
        let _ = m.restock(ironmonger(), IRON.to_string());
        let total_after = m.merchant_treasury_for(ironmonger()) + m.credit_of(owner()).0;
        assert_eq!(total_before, total_after, "a restock must be a pure internal transfer");
    }

    #[test]
    fn a_failed_credit_payout_puts_the_credit_back() {
        let mut m = market();
        ctx(player(), 5_000_000_000_000_000_000_000_000);
        m.fund_credit(player());
        let owed = m.credit_of(player()).0;
        assert!(owed > 0);

        ctx(player(), 0);
        let _ = m.withdraw();
        assert_eq!(m.credit_of(player()), U128(0), "zeroed before paying, by design");

        // The transfer failed, so the claim must come back. Without the
        // callback the entry was gone and the NEAR was refunded to this
        // contract: the market kept money it no longer accounted for.
        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_credit_paid(player(), U128(owed), Err(PromiseError::Failed));

        assert!(!ok);
        assert_eq!(m.credit_of(player()), U128(owed), "credit restored in full");
        assert!(get_logs().iter().any(|l| l.contains("credit has been restored")));
    }

    #[test]
    fn a_successful_credit_payout_restores_nothing() {
        let mut m = market();
        ctx(player(), 5_000_000_000_000_000_000_000_000);
        m.fund_credit(player());
        let owed = m.credit_of(player()).0;

        ctx(player(), 0);
        let _ = m.withdraw();

        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_credit_paid(player(), U128(owed), Ok(()));

        assert!(ok);
        assert_eq!(m.credit_of(player()), U128(0), "paid out means paid out");
    }

    #[test]
    fn a_failed_treasury_payout_restores_the_treasury_not_a_credit() {
        let mut m = market();
        let before = m.merchant_treasury_for(ironmonger());
        let floor = m.merchant(ironmonger()).unwrap().floor.0;
        let withdrawable = before - floor;
        assert!(withdrawable > 0);

        ctx(ironmonger(), 0);
        let _ = m.withdraw_treasury();
        assert_eq!(m.merchant_treasury_for(ironmonger()), floor, "left at the floor");
        assert!(m.is_closed(ironmonger()), "and therefore closed");

        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_treasury_paid(ironmonger(), U128(withdrawable), Err(PromiseError::Failed));

        assert!(!ok);
        assert_eq!(m.merchant_treasury_for(ironmonger()), before, "treasury restored");
        assert!(!m.is_closed(ironmonger()), "and open again");
        // Restoring it as credit instead would leave the merchant at its floor,
        // reporting closed, with its money somewhere else. The floor is
        // measured against the treasury, so the two are not interchangeable.
        assert_eq!(m.credit_of(ironmonger()), U128(0), "not paid back as credit");
        assert!(get_logs().iter().any(|l| l.contains("treasury has been restored")));
    }

    #[test]
    fn failed_delivery_rolls_the_purchase_back_and_refunds() {
        let mut m = market();
        let treasury_before = m.merchant(ironmonger()).unwrap().treasury.0;
        let total = m.quote(ironmonger(), IRON.to_string(), 10).total.0;

        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 10);
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(246));

        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_items_delivered(
            player(), ironmonger(), IRON.to_string(), U128(10), U128(total),
            Err(PromiseError::Failed),
        );

        assert!(!ok);
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(256), "stock restored");
        assert_eq!(m.merchant(ironmonger()).unwrap().treasury.0, treasury_before, "treasury restored");
        assert_eq!(m.credit_of(player()), U128(total), "player made whole");
        assert!(get_logs().iter().any(|l| l.contains("rolled back")));
    }

    #[test]
    fn successful_delivery_keeps_the_purchase() {
        let mut m = market();
        let total = m.quote(ironmonger(), IRON.to_string(), 5).total.0;
        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 5);
        ctx("market.test.near".parse().unwrap(), 0);
        assert!(m.on_items_delivered(player(), ironmonger(), IRON.to_string(), U128(5), U128(total), Ok(())));
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(251));
        assert_eq!(m.credit_of(player()), U128(0));
    }

    // ------------------------------------------------------------ selling

    #[test]
    fn selling_into_a_merchant_pays_the_seller_and_grows_its_stock() {
        let mut m = market();
        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;
        let treasury_before = m.merchant(ironmonger()).unwrap().treasury.0;

        ctx(items(), 0);
        let unused = m.mt_on_transfer(
            player(), vec![player()], vec![IRON.to_string()], vec![U128(10)],
            ironmonger().to_string(),
        );

        assert_eq!(unused, vec![U128(0)], "the sale was accepted in full");
        assert_eq!(m.credit_of(player()), U128(bid * 10));
        assert_eq!(m.merchant(ironmonger()).unwrap().treasury.0, treasury_before - bid * 10);
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(266));
    }

    #[test]
    fn selling_eases_demand_so_a_flooded_market_gets_cheaper() {
        let mut m = market();
        let total = m.quote(ironmonger(), IRON.to_string(), 20).total.0;
        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 20);
        let hot = m.quote(ironmonger(), IRON.to_string(), 1).demand_bps.0;

        ctx(items(), 0);
        m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(20)], ironmonger().to_string());

        assert!(m.quote(ironmonger(), IRON.to_string(), 1).demand_bps.0 < hot, "selling cools the market");
    }

    /// The "broke merchant closes" rule: it stops buying, keeps selling.
    #[test]
    fn a_merchant_at_its_floor_is_closed_and_refuses_to_buy() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        // Funded to exactly its floor, so it has nothing to bid with.
        ctx(owner(), BASE);
        m.fund_merchant(ironmonger());

        assert!(m.is_closed(ironmonger()));
        let q = m.quote(ironmonger(), IRON.to_string(), 1);
        assert!(q.closed);
        assert_eq!(q.merchant_bid, None, "a closed merchant posts no bid");
        assert!(q.reason.contains("closed"));
        assert!(q.unit_price.0 > 0, "but it still sells what it has");

        ctx(items(), 0);
        let unused = m.mt_on_transfer(
            player(), vec![player()], vec![IRON.to_string()], vec![U128(5)], ironmonger().to_string(),
        );
        assert_eq!(unused, vec![U128(5)], "the whole lot is refused, so items refunds it");
        assert_eq!(m.credit_of(player()), U128(0));
    }

    /// A merchant buys as much as its spare treasury covers and hands the rest
    /// back. NEP-245's unused-amount return exists for exactly this, and it is
    /// what lets a treasury actually reach its floor instead of stalling just
    /// above it.
    #[test]
    fn a_merchant_buys_what_it_can_afford_and_refuses_the_rest() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE * 3); // floor BASE, so 2 BASE of spare
        m.fund_merchant(ironmonger());

        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;
        let affordable = (BASE * 2) / bid;
        assert!(affordable > 0 && affordable < 100, "the test needs a partial fill, got {affordable}");

        ctx(items(), 0);
        let unused = m.mt_on_transfer(
            player(), vec![player()], vec![IRON.to_string()], vec![U128(100)], ironmonger().to_string(),
        );

        assert_eq!(unused, vec![U128(100 - affordable)], "the unaffordable remainder comes back");
        assert_eq!(m.credit_of(player()), U128(bid * affordable), "paid for what it took");
        assert!(m.merchant(ironmonger()).unwrap().treasury.0 >= BASE, "floor intact");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock.0, 256 + affordable);
    }

    /// Spent down far enough, it stops posting a bid at all — the "broke
    /// merchant closes" rule, reached by trading rather than by withdrawal.
    #[test]
    fn a_merchant_spent_below_one_unit_posts_no_bid() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        // Spare is a fraction of one unit's bid from the outset.
        ctx(owner(), BASE / 10);
        m.fund_merchant(ironmonger());

        let q = m.quote(ironmonger(), IRON.to_string(), 1);
        assert_eq!(q.merchant_bid, None, "it cannot fund a single unit, so it posts no bid");
        assert!(q.closed);
        assert!(q.unit_price.0 > 0, "but it still sells the stock it has");

        ctx(items(), 0);
        assert_eq!(
            m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(5)], ironmonger().to_string()),
            vec![U128(5)],
            "and it refuses the whole lot"
        );
    }

    #[test]
    #[should_panic(expected = "only the registered items contract may deliver materials")]
    fn only_the_items_contract_may_call_the_receiver_hook() {
        let mut m = market();
        ctx(player(), 0); // a player forging a delivery
        m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(10)], ironmonger().to_string());
    }

    #[test]
    fn an_unparseable_or_unknown_merchant_target_refuses_the_whole_lot() {
        let mut m = market();
        ctx(items(), 0);
        assert_eq!(
            m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(7)], "NOT an account".into()),
            vec![U128(7)]
        );
        assert_eq!(
            m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(7)], "ghost.test.near".into()),
            vec![U128(7)]
        );
        assert_eq!(m.credit_of(player()), U128(0));
    }

    // ----------------------------------------------------------- withdrawal

    #[test]
    fn a_seller_can_withdraw_credited_proceeds_once() {
        let mut m = market();
        ctx(items(), 0);
        m.mt_on_transfer(player(), vec![player()], vec![IRON.to_string()], vec![U128(4)], ironmonger().to_string());
        assert!(m.credit_of(player()).0 > 0);

        ctx(player(), 0);
        let _ = m.withdraw();
        assert_eq!(m.credit_of(player()), U128(0), "credit is cleared before the transfer goes out");
    }

    #[test]
    #[should_panic(expected = "nothing to withdraw")]
    fn withdrawing_nothing_is_refused() {
        let mut m = market();
        ctx(player(), 0);
        let _ = m.withdraw();
    }

    #[test]
    fn a_merchant_withdraws_only_down_to_its_floor() {
        let mut m = market();
        let treasury = m.merchant(ironmonger()).unwrap().treasury.0;
        ctx(ironmonger(), 0);
        let _ = m.withdraw_treasury();
        let left = m.merchant(ironmonger()).unwrap().treasury.0;
        assert_eq!(left, BASE, "a merchant cannot strip itself below its floor");
        assert!(treasury > left);
        assert!(m.is_closed(ironmonger()), "and having done so it is closed");
    }

    #[test]
    #[should_panic(expected = "caller is not a merchant")]
    fn a_player_cannot_withdraw_a_treasury() {
        let mut m = market();
        ctx(player(), 0);
        let _ = m.withdraw_treasury();
    }

    // ------------------------------------------------------------ authority

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_the_owner_registers_merchants() {
        let mut m = market();
        ctx(player(), 0);
        m.register_merchant(accounts(2), "Impostor".into(), U128(0));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_the_owner_lists_items() {
        let mut m = market();
        ctx(player(), 0);
        m.list_item(ironmonger(), "gold_ingot".into(), U128(BASE), U128(10));
    }

    #[test]
    fn restocking_preserves_accumulated_demand() {
        let mut m = market();
        let total = m.quote(ironmonger(), IRON.to_string(), 20).total.0;
        ctx(player(), total);
        let _ = m.buy(ironmonger(), IRON.to_string(), 20);
        let hot = m.quote(ironmonger(), IRON.to_string(), 1).demand_bps.0;
        assert!(hot > BPS);

        ctx(owner(), 0);
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(500));
        let q = m.quote(ironmonger(), IRON.to_string(), 1);
        assert_eq!(q.stock, U128(500));
        assert_eq!(q.demand_bps.0, hot, "a restock must not secretly reset the market");
    }

    #[test]
    fn quotes_lists_every_merchant_that_deals_in_a_material() {
        let mut m = market();
        ctx(owner(), 0);
        let timber: AccountId = "timberwright.test.near".parse().unwrap();
        m.register_merchant(timber.clone(), "Timberwright".into(), U128(BASE));
        m.list_item(timber.clone(), IRON.to_string(), U128(BASE), U128(1_024));

        let all = m.quotes(IRON.to_string(), 1);
        assert_eq!(all.len(), 2);
        // Different stock, therefore genuinely different prices — the reason to walk.
        let cheap = all.iter().find(|q| q.merchant_id == timber).unwrap();
        let dear = all.iter().find(|q| q.merchant_id == ironmonger()).unwrap();
        assert!(cheap.unit_price.0 < dear.unit_price.0);
        assert_eq!(cheap.band, "well stocked");
    }
    // ------------------------------------------- the agent spend path
    //
    // A function-call access key cannot attach NEAR, so an agent can never call
    // the payable `buy`. It spends a budget credited in advance, which is the
    // second of two independent bounds on it — the first being the key's
    // `method_names`, enforced by the protocol rather than by this contract.

    fn worker() -> AccountId { "worker-1.test.near".parse().unwrap() }

    #[test]
    fn funding_an_agent_gives_it_a_spend_budget() {
        let mut m = market();
        ctx(owner(), BASE * 5);
        m.fund_credit(worker());
        assert_eq!(m.credit_of(worker()), U128(BASE * 5));
    }

    #[test]
    #[should_panic(expected = "attach something to fund")]
    fn funding_nothing_is_refused() {
        let mut m = market();
        ctx(owner(), 0);
        m.fund_credit(worker());
    }

    /// The path an agent actually takes: no deposit attached at all.
    #[test]
    fn an_agent_buys_from_its_budget_with_no_deposit_attached() {
        let mut m = market();
        ctx(owner(), BASE * 10);
        m.fund_credit(worker());
        let total = m.quote(ironmonger(), IRON.to_string(), 6).total.0;
        let treasury_before = m.merchant(ironmonger()).unwrap().treasury.0;

        ctx(worker(), 0); // zero deposit, exactly as a function-call key must
        let _ = m.buy_with_credit(ironmonger(), IRON.to_string(), 6);

        assert_eq!(m.credit_of(worker()), U128(BASE * 10 - total), "budget debited");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(250));
        assert_eq!(m.merchant(ironmonger()).unwrap().treasury.0, treasury_before + total);
    }

    #[test]
    #[should_panic(expected = "insufficient credit for this purchase")]
    fn an_agent_cannot_spend_past_its_budget() {
        let mut m = market();
        ctx(owner(), BASE); // one NEAR of budget
        m.fund_credit(worker());
        ctx(worker(), 0);
        let _ = m.buy_with_credit(ironmonger(), IRON.to_string(), 50); // needs ~50
    }

    #[test]
    #[should_panic(expected = "insufficient credit for this purchase")]
    fn an_unfunded_agent_cannot_buy_anything() {
        let mut m = market();
        ctx(worker(), 0);
        let _ = m.buy_with_credit(ironmonger(), IRON.to_string(), 1);
    }

    /// The budget is a hard ceiling across a whole shopping session, not per call.
    #[test]
    fn a_budget_is_a_ceiling_across_many_purchases() {
        let mut m = market();
        ctx(owner(), BASE * 4);
        m.fund_credit(worker());

        let mut bought = 0u32;
        for _ in 0..10 {
            let total = m.quote(ironmonger(), IRON.to_string(), 1).total.0;
            if m.credit_of(worker()).0 < total { break; }
            ctx(worker(), 0);
            let _ = m.buy_with_credit(ironmonger(), IRON.to_string(), 1);
            bought += 1;
        }

        assert!(bought > 0 && bought < 10, "the budget must bind before the loop does, got {bought}");
        let spent = BASE * 4 - m.credit_of(worker()).0;
        assert!(spent <= BASE * 4, "an agent can never spend more than it was given");
    }

    /// An agent paid in proceeds could otherwise recycle them. It can — but only
    /// into more purchases, never out of the contract, because `withdraw` is not
    /// a method its key is allowed to name.
    #[test]
    fn agent_proceeds_land_in_the_same_bounded_budget() {
        let mut m = market();
        ctx(items(), 0);
        m.mt_on_transfer(worker(), vec![worker()], vec![IRON.to_string()], vec![U128(3)], ironmonger().to_string());
        assert!(m.credit_of(worker()).0 > 0, "selling credits the agent's budget");
    }

    /// `is_closed` asks a real question now — "can it fund a unit of anything?" —
    /// so it needs its own coverage. A merchant can be priced out of one
    /// material while still bidding on a cheaper one, and that is not closed.
    #[test]
    fn closed_means_it_can_fund_nothing_not_merely_that_one_thing_is_dear() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        // One dear material and one cheap one.
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        m.list_item(ironmonger(), "stone".into(), U128(BASE / 100), U128(256));

        // Enough for a unit of stone, nowhere near a unit of iron.
        ctx(owner(), BASE / 50);
        m.fund_merchant(ironmonger());

        assert!(!m.is_closed(ironmonger()), "it can still fund stone, so it is open");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid, None, "priced out of iron");
        assert!(m.quote(ironmonger(), "stone".into(), 1).merchant_bid.is_some(), "still bidding on stone");
        // The tooltip must say which of the two reasons applies.
        let dear = m.quote(ironmonger(), IRON.to_string(), 1);
        assert!(dear.reason.contains("will not buy more"), "got: {}", dear.reason);
        assert!(!dear.reason.contains("down to its floor"), "that would be untrue here");

        // Drop it below a unit of even the cheap material and it is closed.
        ctx(owner(), 0);
        let mut broke = Market::new(owner(), items());
        broke.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        broke.list_item(ironmonger(), "stone".into(), U128(BASE), U128(256));
        assert!(broke.is_closed(ironmonger()), "an unfunded merchant funds nothing");

        // A merchant stocking nothing at all is closed.
        //
        // This test previously asserted the opposite — "no shelves is not the
        // same as broke" — and the earlier reading was wrong. The two states do
        // differ in cause, but `is_closed` answers "will this merchant trade
        // with me", and an empty one will refuse every sale. Kept as a
        // correction rather than quietly rewritten.
        ctx(owner(), 0);
        let mut empty = Market::new(owner(), items());
        empty.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        ctx(owner(), BASE);
        empty.fund_merchant(ironmonger());
        assert!(
            empty.is_closed(ironmonger()),
            "a merchant with nothing on its shelves cannot trade, so it is not open"
        );
    }

    /// The reason string reaches a player's screen, so it must not leak raw
    /// yoctoNEAR integers.
    #[test]
    fn tooltip_amounts_are_human_readable() {
        assert_eq!(near_str(0), "0.000");
        assert_eq!(near_str(BASE), "1.000");
        assert_eq!(near_str(BASE / 2), "0.500");
        assert_eq!(near_str(220_000_000_000_000_000_000_000), "0.220");
        assert_eq!(near_str(BASE * 1234 + BASE / 4), "1234.250");

        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE / 5);
        m.fund_merchant(ironmonger());

        let reason = m.quote(ironmonger(), IRON.to_string(), 1).reason;
        assert!(reason.contains("0.200 NEAR left to spend"), "got: {reason}");
        // No 24-digit integer anywhere in player-visible text.
        assert!(!reason.chars().collect::<Vec<_>>().windows(18).any(|w| w.iter().all(|c| c.is_ascii_digit())),
            "a long raw integer leaked into the tooltip: {reason}");
    }

    // ------------------------------------- selling via an approval (pull)
    //
    // The push path (mt_transfer_call -> mt_on_transfer) needs 1 yoctoNEAR,
    // which a function-call access key cannot attach. These cover the pull
    // path, which is what makes selling reachable for a key-less player.

    fn seller() -> AccountId { accounts(3) }

    #[test]
    fn selling_via_an_approval_pays_the_seller_and_grows_the_shelf() {
        let mut m = market();
        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;
        let treasury_before = m.merchant_treasury_for(ironmonger());

        ctx(seller(), 0); // zero deposit: the whole point
        let _ = m.sell(ironmonger(), IRON.to_string(), 8, U64(7));

        assert_eq!(m.credit_of(seller()), U128(bid * 8), "paid at the posted bid");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(264));
        assert_eq!(m.merchant_treasury_for(ironmonger()), treasury_before - bid * 8);
    }

    /// Only as much is pulled as the merchant can pay for, so the seller keeps
    /// the rest instead of having it pulled and handed back.
    #[test]
    fn selling_takes_only_what_the_merchant_can_afford() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE * 3); // 2 BASE of spare
        m.fund_merchant(ironmonger());

        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;
        let affordable = (BASE * 2) / bid;
        assert!(affordable > 0 && affordable < 100, "need a partial case, got {affordable}");

        ctx(seller(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 100, U64(1));
        assert_eq!(m.credit_of(seller()), U128(bid * affordable), "paid only for what it took");
        assert!(m.merchant(ironmonger()).unwrap().treasury.0 >= BASE, "floor intact");
    }

    #[test]
    #[should_panic(expected = "cannot afford a single unit")]
    fn a_merchant_that_cannot_afford_one_unit_refuses_the_sale() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(0));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE / 10);
        m.fund_merchant(ironmonger());
        ctx(seller(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 1, U64(1));
    }

    /// A missing, stale or exhausted approval means the pull fails. The sale
    /// must unwind completely — otherwise a seller would be credited for
    /// materials that never moved.
    #[test]
    fn a_failed_pull_unwinds_the_sale_completely() {
        let mut m = market();
        let treasury_before = m.merchant_treasury_for(ironmonger());
        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;

        ctx(seller(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 8, U64(7));
        assert_eq!(m.credit_of(seller()), U128(bid * 8));
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(264));

        ctx("market.test.near".parse().unwrap(), 0);
        let ok = m.on_materials_pulled(
            seller(), ironmonger(), IRON.to_string(), U128(8), U128(bid * 8),
            Err(PromiseError::Failed),
        );

        assert!(!ok);
        assert_eq!(m.credit_of(seller()), U128(0), "the credit is taken back");
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(256), "shelf restored");
        assert_eq!(m.merchant_treasury_for(ironmonger()), treasury_before, "treasury restored");
        assert!(get_logs().iter().any(|l| l.contains("sale unwound")));
    }

    #[test]
    fn a_successful_pull_keeps_the_sale() {
        let mut m = market();
        let bid = m.quote(ironmonger(), IRON.to_string(), 1).merchant_bid.unwrap().0;
        ctx(seller(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 4, U64(7));
        ctx("market.test.near".parse().unwrap(), 0);
        assert!(m.on_materials_pulled(seller(), ironmonger(), IRON.to_string(), U128(4), U128(bid * 4), Ok(())));
        assert_eq!(m.credit_of(seller()), U128(bid * 4));
        assert_eq!(m.quote(ironmonger(), IRON.to_string(), 1).stock, U128(260));
    }

    #[test]
    #[should_panic(expected = "count must be positive")]
    fn selling_nothing_is_refused() {
        let mut m = market();
        ctx(seller(), 0);
        let _ = m.sell(ironmonger(), IRON.to_string(), 0, U64(1));
    }

}
