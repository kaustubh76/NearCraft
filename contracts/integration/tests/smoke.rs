//! Does a local NEAR sandbox actually start on this machine?
//!
//! Everything else in this directory depends on the answer, so it gets its own
//! test. near-sandbox downloads and caches a node binary on first run, so this
//! needs network once and nothing thereafter — but never a faucet, an account
//! or any credential.

#[tokio::test]
async fn a_local_sandbox_starts_and_funds_an_account() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let account = worker.dev_create_account().await?;
    let balance = account.view_account().await?.balance;

    println!("sandbox up: {} holds {}", account.id(), balance);
    assert!(balance.as_yoctonear() > 0, "a sandbox dev account should be funded");

    // Sub-accounts work without any faucet, which is what unblocks the whole plan.
    let sub = account
        .create_subaccount("market")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    println!("sub-account created: {}", sub.id());
    assert!(sub.id().as_str().starts_with("market."));
    Ok(())
}
