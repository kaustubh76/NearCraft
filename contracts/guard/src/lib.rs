//! A shared blocklist that agents report to, with evidence attached.
//!
//! The AI Security & Defense track asks for "a shared blocklist that other
//! agents can report to, with evidence attached". On NEAR that should be a
//! contract rather than our database, for three reasons a database cannot give:
//! reports are **public**, they are **attributed** to the reporting account by
//! the runtime rather than by a self-declared field, and **we cannot delete
//! them**. A safety list the operator can quietly edit is not a safety list.
//!
//! ## What this deliberately does not do
//!
//! It does not decide anything. It stores who said what about whom, and counts
//! distinct reporters. The verdict — allow, warn or block — is computed by
//! `backend/near/counterparty.mjs`, which weighs these reports against signals
//! the chain cannot provide.
//!
//! **Anyone can report anyone.** That is unavoidable in a permissionless list
//! and it is the honest limitation: reports are sybil-reportable. The scoring
//! layer therefore never blocks on reports alone, and `blocked()` here is a
//! *suggestion* at a stated threshold of distinct reporters, not a verdict.

use near_sdk::json_types::U64;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

/// Distinct reporters before `blocked()` lists an account. Low enough to be
/// useful on a young network, high enough that one actor cannot do it alone.
pub const BLOCK_THRESHOLD: u32 = 3;

/// Reporting costs a deposit. Not revenue — it pays for the storage the report
/// occupies and makes mass false reporting cost something.
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);

/// Bounds so a single subject cannot be made unreadable by gas exhaustion.
const MAX_REPORTS_PER_SUBJECT: usize = 64;
const MAX_REASON: usize = 120;
const MAX_EVIDENCE: usize = 400;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Report {
    /// Set from `predecessor_account_id`, never from an argument — otherwise a
    /// caller could forge who is vouching for a claim.
    pub reporter: AccountId,
    pub reason: String,
    /// Free-form: a transaction hash, a URL, a description. Unverified by this
    /// contract, which is why `counterparty.mjs` weighs reporters rather than
    /// trusting evidence content.
    pub evidence: String,
    pub reported_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    reports: IterableMap<AccountId, Vec<Report>>,
}

#[near]
impl Guard {
    #[init]
    pub fn new() -> Self {
        Self { reports: IterableMap::new(b"r".to_vec()) }
    }

    /// Report an account, with a reason and evidence.
    ///
    /// Re-reporting the same subject **replaces** your own earlier report rather
    /// than adding a second one, so distinct-reporter counts cannot be inflated
    /// by one account reporting repeatedly.
    #[payable]
    pub fn report(&mut self, account_id: AccountId, reason: String, evidence: String) {
        require!(
            env::attached_deposit() >= REPORT_DEPOSIT,
            "a report must attach at least 0.01 NEAR to cover its storage"
        );
        let reporter = env::predecessor_account_id();
        require!(reporter != account_id, "an account cannot report itself");
        require!(!reason.is_empty() && reason.len() <= MAX_REASON, "reason must be 1..=120 bytes");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence must be at most 400 bytes");

        let mut existing = self.reports.get(&account_id).cloned().unwrap_or_default();
        let entry = Report {
            reporter: reporter.clone(),
            reason,
            evidence,
            reported_at: U64(env::block_timestamp()),
        };
        match existing.iter().position(|r| r.reporter == reporter) {
            Some(at) => existing[at] = entry,
            None => {
                require!(existing.len() < MAX_REPORTS_PER_SUBJECT, "this account has too many reports");
                existing.push(entry);
            }
        }
        let distinct = existing.len() as u32;
        self.reports.insert(account_id.clone(), existing);

        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nearcraft-guard\",\"version\":\"1.0.0\",\"event\":\"report\",\
             \"data\":[{{\"subject\":\"{account_id}\",\"reporter\":\"{reporter}\",\"distinct_reporters\":{distinct}}}]}}"
        ));
    }

    /// Withdraw your own report. You may retract what you said; you cannot
    /// touch anyone else's.
    pub fn retract(&mut self, account_id: AccountId) {
        let reporter = env::predecessor_account_id();
        let mut existing = self.reports.get(&account_id).cloned().unwrap_or_default();
        let before = existing.len();
        existing.retain(|r| r.reporter != reporter);
        require!(existing.len() < before, "you have no report on that account");
        if existing.is_empty() {
            self.reports.remove(&account_id);
        } else {
            self.reports.insert(account_id, existing);
        }
    }

    // ------------------------------------------------------------------ views

    pub fn reports_for(&self, account_id: AccountId) -> Vec<Report> {
        self.reports.get(&account_id).cloned().unwrap_or_default()
    }

    /// Distinct reporters, which is the only count worth anything — one actor
    /// reporting ten times is one opinion.
    pub fn reporter_count(&self, account_id: AccountId) -> u32 {
        self.reports.get(&account_id).map(|r| r.len() as u32).unwrap_or(0)
    }

    pub fn is_reported(&self, account_id: AccountId) -> bool {
        self.reporter_count(account_id) > 0
    }

    /// Accounts at or above `BLOCK_THRESHOLD` distinct reporters.
    ///
    /// A *suggestion*, not a verdict: this contract cannot tell a real fraud
    /// from three colluding accounts. `counterparty.mjs` requires a
    /// corroborating signal before it will return `block`.
    pub fn blocked(&self, from_index: Option<U64>, limit: Option<u64>) -> Vec<AccountId> {
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(u64::MAX) as usize;
        self.reports
            .iter()
            .filter(|(_, reports)| reports.len() as u32 >= BLOCK_THRESHOLD)
            .skip(start)
            .take(limit)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Everything the scoring layer needs about one account, in a single view —
    /// one RPC round trip instead of three.
    pub fn summary(&self, account_id: AccountId) -> GuardSummary {
        let reports = self.reports_for(account_id);
        GuardSummary {
            distinct_reporters: reports.len() as u32,
            at_or_over_threshold: reports.len() as u32 >= BLOCK_THRESHOLD,
            threshold: BLOCK_THRESHOLD,
            reasons: reports.iter().map(|r| r.reason.clone()).collect(),
        }
    }

    pub fn threshold(&self) -> u32 {
        BLOCK_THRESHOLD
    }
}

#[near(serializers = [json])]
pub struct GuardSummary {
    pub distinct_reporters: u32,
    pub at_or_over_threshold: bool,
    pub threshold: u32,
    pub reasons: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .attached_deposit(deposit)
            .block_timestamp(1_700_000_000_000_000_000)
            .build());
    }

    fn guard() -> Guard {
        ctx(accounts(0), NearToken::from_near(0));
        Guard::new()
    }

    /// accounts(5) is the account being reported throughout.
    fn subject() -> AccountId {
        accounts(5)
    }

    #[test]
    fn a_report_is_attributed_to_its_sender_not_to_an_argument() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "drained an agent".into(), "tx:abc123".into());

        let reports = g.reports_for(subject());
        assert_eq!(reports.len(), 1);
        // The reporter comes from predecessor_account_id. There is no argument
        // for it, so it cannot be forged.
        assert_eq!(reports[0].reporter, accounts(1));
        assert_eq!(reports[0].reason, "drained an agent");
        assert_eq!(reports[0].evidence, "tx:abc123");
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"report\"")));
    }

    #[test]
    #[should_panic(expected = "must attach at least 0.01 NEAR")]
    fn reporting_for_free_is_refused() {
        let mut g = guard();
        ctx(accounts(1), NearToken::from_yoctonear(0));
        g.report(subject(), "spam".into(), String::new());
    }

    #[test]
    #[should_panic(expected = "cannot report itself")]
    fn an_account_cannot_report_itself() {
        let mut g = guard();
        ctx(subject(), REPORT_DEPOSIT);
        g.report(subject(), "self".into(), String::new());
    }

    /// The property that makes the count mean something.
    #[test]
    fn one_reporter_reporting_twice_is_still_one_opinion() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "first".into(), "e1".into());
        g.report(subject(), "second".into(), "e2".into());

        assert_eq!(g.reporter_count(subject()), 1, "a repeat must replace, not accumulate");
        let reports = g.reports_for(subject());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].reason, "second", "the latest report wins");
    }

    #[test]
    fn distinct_reporters_accumulate_and_cross_the_threshold() {
        let mut g = guard();
        assert_eq!(g.threshold(), BLOCK_THRESHOLD);
        for i in 1..=3u32 {
            ctx(accounts(i as usize), REPORT_DEPOSIT);
            g.report(subject(), format!("report {i}"), String::new());
            let summary = g.summary(subject());
            assert_eq!(summary.distinct_reporters, i);
            assert_eq!(summary.at_or_over_threshold, i >= BLOCK_THRESHOLD);
        }
        assert_eq!(g.blocked(None, None), vec![subject()]);
    }

    #[test]
    fn below_the_threshold_an_account_is_reported_but_not_listed() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "one voice".into(), String::new());

        assert!(g.is_reported(subject()), "the report is visible");
        assert_eq!(g.reporter_count(subject()), 1);
        assert!(g.blocked(None, None).is_empty(), "one voice must not list an account");
        // This is the sybil limitation made concrete: a single reporter moves
        // the needle to `warn` in the scoring layer, never to `block`.
    }

    #[test]
    fn a_reporter_can_retract_only_their_own_report() {
        let mut g = guard();
        for i in 1..=2usize {
            ctx(accounts(i), REPORT_DEPOSIT);
            g.report(subject(), format!("from {i}"), String::new());
        }
        assert_eq!(g.reporter_count(subject()), 2);

        ctx(accounts(1), NearToken::from_near(0));
        g.retract(subject());
        let left = g.reports_for(subject());
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].reporter, accounts(2), "the other report is untouched");
    }

    #[test]
    #[should_panic(expected = "you have no report on that account")]
    fn retracting_a_report_you_never_made_is_refused() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "mine".into(), String::new());
        ctx(accounts(2), NearToken::from_near(0));
        g.retract(subject());
    }

    #[test]
    fn retracting_the_last_report_clears_the_account_entirely() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "mine".into(), String::new());
        ctx(accounts(1), NearToken::from_near(0));
        g.retract(subject());
        assert!(!g.is_reported(subject()));
        assert_eq!(g.reports_for(subject()).len(), 0);
    }

    #[test]
    #[should_panic(expected = "reason must be 1..=120 bytes")]
    fn an_empty_reason_is_refused() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), String::new(), "e".into());
    }

    #[test]
    #[should_panic(expected = "evidence must be at most 400 bytes")]
    fn oversized_evidence_is_refused() {
        let mut g = guard();
        ctx(accounts(1), REPORT_DEPOSIT);
        g.report(subject(), "r".into(), "x".repeat(401));
    }

    #[test]
    fn views_on_an_unreported_account_are_empty_not_errors() {
        let g = guard();
        assert_eq!(g.reporter_count(accounts(4)), 0);
        assert!(!g.is_reported(accounts(4)));
        assert_eq!(g.reports_for(accounts(4)).len(), 0);
        let s = g.summary(accounts(4));
        assert_eq!(s.distinct_reporters, 0);
        assert!(!s.at_or_over_threshold);
        assert!(s.reasons.is_empty());
    }

    #[test]
    fn blocked_paginates() {
        let mut g = guard();
        // Three subjects, each reported by three distinct accounts.
        for s in 3..=5usize {
            for r in 0..=2usize {
                ctx(accounts(r), REPORT_DEPOSIT);
                g.report(accounts(s), format!("bad {s}"), String::new());
            }
        }
        assert_eq!(g.blocked(None, None).len(), 3);
        assert_eq!(g.blocked(None, Some(2)).len(), 2);
        assert_eq!(g.blocked(Some(U64(2)), None).len(), 1);
        assert_eq!(g.blocked(Some(U64(9)), None).len(), 0);
    }
}
