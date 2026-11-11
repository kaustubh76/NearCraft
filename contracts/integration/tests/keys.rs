//! The claim this whole submission rests on, proved against a real NEAR runtime.
//!
//!   cargo test --test keys -- --nocapture
//!
//! On EVM, bounding what an AI agent may spend cost the predecessor project
//! roughly 800 lines of our own security code. On NEAR it is a function-call
//! access key. The difference only matters if the protocol really enforces it,
//! so this test issues a genuine restricted key, signs with *that key*, and
//! checks what the runtime does — rather than taking our own policy layer's
//! word for it.
//!
//! No faucet, no testnet, no credentials: a local sandbox node.

mod common;

use common::{random_key, World, IRON};
use near_workspaces::types::{AccessKey, Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

/// The only method an agent's key is allowed to name.
const PERMITTED: &str = "buy_with_credit";

/// Gas attached to an agent call, matching `backend/near/signer.mjs`.
///
/// This figure matters more than it looks, and the mechanism is subtler than it
/// first appears. Measured in the sandbox, a function-call key's `allowance` is
/// checked as a **ceiling against prepaid gas** on every call, but only the gas
/// **actually burned** is deducted. So `max_gas()` (300 TGas) demands ~1 NEAR of
/// headroom per call and is refused outright by a 0.25 NEAR allowance, while
/// 60 TGas needs ~0.2 NEAR of headroom and costs ~0.025 NEAR a call. Attaching
/// realistic gas is therefore what makes a modest allowance usable at all.
const AGENT_GAS: Gas = Gas::from_tgas(60);

/// Everything an agent must not be able to reach, and why each would be bad.
const FORBIDDEN: &[(&str, &str)] = &[
    ("withdraw", "would let a compromised agent cash out its budget"),
    ("withdraw_treasury", "would let it drain a merchant's earnings"),
    ("register_merchant", "would let it invent a merchant it controls"),
    ("fund_credit", "would let it raise its own spending limit"),
    ("list_item", "would let it restock or reprice a shelf"),
    ("buy", "the payable path; must stay out of reach of a scoped key"),
];

/// A call can fail either at submission (the runtime refuses the key outright)
/// or during execution. Both are refusals; neither is a success.
fn describe_failure(outcome: Result<near_workspaces::result::ExecutionFinalResult, anyhow::Error>) -> String {
    match outcome {
        Err(e) => format!("rejected: {}", interesting(&format!("{e:#}"))),
        Ok(result) if result.is_failure() => {
            format!("execution failed: {}", first_line(&format!("{:?}", result.into_result().unwrap_err())))
        }
        Ok(_) => String::new(), // success — the caller treats an empty string as a failed assertion
    }
}

/// Pull the protocol's own error name out of a long chained message, so the log
/// says `MethodNameMismatch` rather than "unable to broadcast".
fn interesting(s: &str) -> String {
    for marker in ["InvalidAccessKeyError(", "InvalidTxError(", "ActionError"] {
        if let Some(at) = s.find(marker) {
            return s[at..].chars().take(120).collect::<String>().replace('\n', " ");
        }
    }
    s.lines().last().unwrap_or("").chars().take(120).collect()
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(140).collect()
}

#[tokio::test]
async fn a_function_call_key_can_buy_and_can_do_nothing_else() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let agent = world.agent("worker-1", NearToken::from_near(5)).await?;

    // Issue the restricted key on the agent's own account, scoped to the market
    // contract and to exactly one method.
    let restricted_key = random_key();
    let public_key = restricted_key.public_key();
    agent
        .batch(agent.id())
        .add_key(
            public_key.clone(),
            AccessKey::function_call_access(
                world.market.id(),
                &[PERMITTED],
                Some(NearToken::from_near(2)),
            ),
        )
        .transact()
        .await?
        .into_result()?;

    // Read the permission back from the chain. This is the protocol's own
    // account of what the key may do, not ours.
    let stored = agent.view_access_key(&public_key).await?;
    println!("\n--- the key, as the protocol reports it ---");
    println!("{:#?}\n", stored.permission);

    // From here on, sign as the agent using ONLY the restricted key.
    let scoped: Account = Account::from_secret_key(agent.id().clone(), restricted_key, &world.worker);

    // 1. The permitted method works.
    let before_stock = world.stock_of(IRON).await?;
    let before_credit = world.credit_of(&agent).await?;
    scoped
        .call(world.market.id(), PERMITTED)
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 8 }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;

    let after_stock = world.stock_of(IRON).await?;
    let after_credit = world.credit_of(&agent).await?;
    let delivered = world.balance_of(&agent, IRON).await?;
    println!("--- the permitted call ---");
    println!("  buy_with_credit(8 {IRON})  ALLOWED");
    println!("  shelf {before_stock} -> {after_stock}, agent now holds {delivered} {IRON}");
    println!("  budget spent: {} yoctoNEAR\n", before_credit - after_credit);

    assert_eq!(after_stock, before_stock - 8, "the shelf must fall by 8");
    assert_eq!(delivered, 8, "the agent must actually receive the materials");
    assert!(after_credit < before_credit, "the budget must be debited");

    // 2. Every other method on the same contract is refused by the runtime.
    println!("--- every other method, same contract, same key ---");
    for (method, why) in FORBIDDEN {
        let outcome = scoped
            .call(world.market.id(), method)
            .args_json(json!({}))
            .gas(AGENT_GAS)
            .transact()
            .await
            .map_err(anyhow::Error::from);
        let failure = describe_failure(outcome);
        assert!(!failure.is_empty(), "{method} SUCCEEDED with a key scoped to {PERMITTED} — {why}");
        println!("  {:<18} REFUSED  ({})", method, failure);
    }

    // 3. The key cannot move NEAR at all. This is not a method restriction —
    //    a function-call access key simply has no authority over Transfer
    //    actions, which is why the agent's spend budget had to live in the
    //    contract rather than in its account balance.
    println!("\n--- value transfer with the same key ---");
    let transfer = scoped
        .transfer_near(world.ironmonger.id(), NearToken::from_near(1))
        .await
        .map_err(anyhow::Error::from);
    let failure = describe_failure(transfer);
    assert!(!failure.is_empty(), "a function-call key must not be able to transfer NEAR");
    println!("  transfer 1 NEAR    REFUSED  ({failure})");

    // 4. Nor can it widen its own authority by adding a key.
    let add_key = scoped
        .batch(agent.id())
        .add_key(random_key().public_key(), AccessKey::full_access())
        .transact()
        .await
        .map_err(anyhow::Error::from);
    let failure = describe_failure(add_key);
    assert!(!failure.is_empty(), "a function-call key must not be able to add keys");
    println!("  add full-access key REFUSED  ({failure})\n");

    Ok(())
}

#[tokio::test]
async fn a_scoped_key_cannot_reach_a_different_contract() -> anyhow::Result<()> {
    let world = World::setup().await?;
    let agent = world.agent("worker-2", NearToken::from_near(5)).await?;

    let restricted_key = random_key();
    agent
        .batch(agent.id())
        .add_key(
            restricted_key.public_key(),
            AccessKey::function_call_access(world.market.id(), &[PERMITTED], None),
        )
        .transact()
        .await?
        .into_result()?;

    let scoped = Account::from_secret_key(agent.id().clone(), restricted_key, &world.worker);

    // The items contract holds the materials. A key scoped to the market must
    // not be able to move tokens directly, whatever method it names.
    let outcome = scoped
        .call(world.items.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": world.ironmonger.id(), "token_id": IRON, "amount": "1",
            "approval": null, "memo": null
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(AGENT_GAS)
        .transact()
        .await
        .map_err(anyhow::Error::from);

    let failure = describe_failure(outcome);
    assert!(!failure.is_empty(), "a market-scoped key reached the items contract");
    println!("\nmt_transfer on the items contract REFUSED ({failure})\n");
    Ok(())
}

/// The budget is the second bound. Even a perfectly scoped key, calling only its
/// permitted method, cannot spend past what it was given.
#[tokio::test]
async fn the_spend_budget_binds_even_with_a_valid_key() -> anyhow::Result<()> {
    let world = World::setup().await?;
    // Enough for roughly two units at the base price of 0.4 NEAR.
    let agent = world.agent("worker-3", NearToken::from_millinear(900)).await?;

    let restricted_key = random_key();
    agent
        .batch(agent.id())
        .add_key(
            restricted_key.public_key(),
            AccessKey::function_call_access(world.market.id(), &[PERMITTED], Some(NearToken::from_near(2))),
        )
        .transact()
        .await?
        .into_result()?;
    let scoped = Account::from_secret_key(agent.id().clone(), restricted_key, &world.worker);

    let mut bought = 0u32;
    for _ in 0..10 {
        let outcome = scoped
            .call(world.market.id(), PERMITTED)
            .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 1 }))
            .gas(AGENT_GAS)
            .transact()
            .await;
        match outcome {
            Ok(r) if r.is_success() => bought += 1,
            _ => break,
        }
    }

    let remaining = world.credit_of(&agent).await?;
    let held = world.balance_of(&agent, IRON).await?;
    println!("\nbudget 0.9 NEAR bought {bought} {IRON}; {remaining} yoctoNEAR left unspent");
    assert!(bought > 0, "a funded agent should manage at least one purchase");
    assert!(bought < 10, "the budget must bind before the loop does");
    assert_eq!(held as u32, bought, "it holds exactly what it paid for");
    Ok(())
}

/// The gas allowance is a third bound, and the crisp half of it is a per-call
/// ceiling: the runtime refuses a call outright unless the key's remaining
/// allowance covers that call's **prepaid** gas, whatever the call goes on to
/// burn. So an allowance below one call's prepaid cost makes the key unusable
/// from the very first call.
///
/// Measured in this sandbox: 60 TGas needs ~0.2 NEAR of headroom and actually
/// burns ~0.007 NEAR, while `max_gas()` (300 TGas) demands ~1 NEAR of headroom.
/// The allowance therefore also drains, and a key eventually dies rather than
/// merely being restricted — which is why the NEAR docs warn that an account
/// holding *only* function-call keys can lock itself out. The drain rate depends
/// on nearcore's gas prices, so this test asserts the ceiling (deterministic)
/// rather than a call count (not).
#[tokio::test]
async fn an_allowance_below_one_call_makes_the_key_unusable() -> anyhow::Result<()> {
    let world = World::setup().await?;
    // A large spend budget, so the *allowance* is unambiguously what binds.
    let agent = world.agent("worker-4", NearToken::from_near(20)).await?;

    let restricted_key = random_key();
    agent
        .batch(agent.id())
        .add_key(
            restricted_key.public_key(),
            // Far below the ~0.2 NEAR of headroom a 60 TGas call demands.
            AccessKey::function_call_access(world.market.id(), &[PERMITTED], Some(NearToken::from_millinear(50))),
        )
        .transact()
        .await?
        .into_result()?;
    let scoped = Account::from_secret_key(agent.id().clone(), restricted_key, &world.worker);

    let outcome = scoped
        .call(world.market.id(), PERMITTED)
        .args_json(json!({ "merchant_id": world.ironmonger.id(), "item": IRON, "count": 1 }))
        .gas(AGENT_GAS)
        .transact()
        .await
        .map_err(anyhow::Error::from);

    let failure = describe_failure(outcome);
    println!("\n--- allowance below one call's prepaid gas ---");
    println!("  allowance 0.05 NEAR, call needs ~0.2 NEAR of headroom");
    println!("  {failure}");

    assert!(!failure.is_empty(), "an underfunded allowance must not permit the call");
    assert!(
        failure.contains("NotEnoughAllowance"),
        "expected NotEnoughAllowance, got: {failure}"
    );

    // The spend budget is untouched: the call never ran.
    assert_eq!(
        world.credit_of(&agent).await?,
        NearToken::from_near(20).as_yoctonear(),
        "a call refused on allowance must not debit the budget"
    );
    println!("  spend budget untouched — the call never executed\n");
    Ok(())
}
