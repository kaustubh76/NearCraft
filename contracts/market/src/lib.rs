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
//! not independently hold their stock on-chain — that would need the NEP-245
//! Approval Management extension, which did not fit the hackathon window.
//!
//! Money is plain NEAR. Proceeds are credited as a withdrawable balance rather
//! than pushed, because a failed push would cost someone their goods.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub mod pricing;
use pricing::{buy_price, scarcity_band, unit_price, BPS};

const GAS_FOR_MT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_DELIVERY_CALLBACK: Gas = Gas::from_tgas(12);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_items)]
#[allow(dead_code)]
trait Items {
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
        let mut merchant = self.merchants.get(&merchant_id).cloned().expect("unknown merchant");
        merchant.treasury = U128(merchant.treasury.0 + env::attached_deposit().as_yoctonear());
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

    /// True when the merchant's treasury has fallen to its floor: it keeps
    /// selling what it has, but it stops buying. This is the "broke merchant
    /// closes" rule from GAME_LOOP.md.
    pub fn is_closed(&self, merchant_id: AccountId) -> bool {
        self.merchants.get(&merchant_id).map(Self::closed).unwrap_or(true)
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        self.credits.get(&account_id).copied().unwrap_or(U128(0))
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
        let proceeds = buy_price(listing.base_price.0, listing.stock.0, demand).saturating_mul(units);
        // A merchant can only buy what it can pay for without breaching its floor.
        if merchant.treasury.0.saturating_sub(proceeds) < merchant.floor.0 {
            return units;
        }

        self.listings.insert(
            key,
            Listing {
                stock: U128(listing.stock.0 + units),
                demand_bps: U128(pricing::ease_demand(demand, units)),
                demand_at: env::block_timestamp(),
                ..listing
            },
        );
        let mut merchant = merchant;
        merchant.treasury = U128(merchant.treasury.0 - proceeds);
        self.merchants.insert(merchant_id.clone(), merchant);
        self.credit(seller_id, proceeds);
        0
    }

    // ------------------------------------------------------------- withdraw

    /// Take your credited proceeds. Players and merchants both use this; a
    /// merchant's treasury is separate and only it can withdraw it.
    pub fn withdraw(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.credits.get(&who).copied().unwrap_or(U128(0)).0;
        require!(amount > 0, "nothing to withdraw");
        self.credits.insert(who.clone(), U128(0));
        Promise::new(who).transfer(NearToken::from_yoctonear(amount))
    }

    /// A merchant withdrawing its own earnings, down to its floor.
    pub fn withdraw_treasury(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let mut merchant = self.merchants.get(&who).cloned().expect("caller is not a merchant");
        let withdrawable = merchant.treasury.0.saturating_sub(merchant.floor.0);
        require!(withdrawable > 0, "treasury is at or below its floor");
        merchant.treasury = U128(merchant.treasury.0 - withdrawable);
        self.merchants.insert(who.clone(), merchant);
        Promise::new(who).transfer(NearToken::from_yoctonear(withdrawable))
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
        let closed = Self::closed(merchant);
        let band = scarcity_band(listing.stock.0);
        let reason = if closed {
            format!(
                "{} holds {} ({}) and is closed to buying: its treasury is at its floor.",
                merchant.name, listing.stock.0, band
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
            merchant_bid: if closed {
                None
            } else {
                Some(U128(buy_price(listing.base_price.0, listing.stock.0, demand)))
            },
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

    #[test]
    fn a_merchant_refuses_a_sale_it_cannot_fund_without_breaching_its_floor() {
        ctx(owner(), 0);
        let mut m = Market::new(owner(), items());
        m.register_merchant(ironmonger(), "Ironmonger".into(), U128(BASE));
        m.list_item(ironmonger(), IRON.to_string(), U128(BASE), U128(256));
        ctx(owner(), BASE * 3); // floor BASE, so ~2 NEAR of headroom
        m.fund_merchant(ironmonger());

        ctx(items(), 0);
        // 100 units at ~0.8 NEAR each would blow straight through the floor.
        let unused = m.mt_on_transfer(
            player(), vec![player()], vec![IRON.to_string()], vec![U128(100)], ironmonger().to_string(),
        );
        assert_eq!(unused, vec![U128(100)], "refused rather than overdrawn");
        assert!(m.merchant(ironmonger()).unwrap().treasury.0 >= BASE, "floor intact");
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

}
