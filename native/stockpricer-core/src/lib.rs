pub mod company;
mod sec;

pub use company::FinancialPeriod;
pub use sec::SecCompanyFacts;

/// Uses stockpricer's filing-consistent annual statement extraction without its database or server.
pub fn annual_financial_periods(facts: SecCompanyFacts) -> Vec<FinancialPeriod> {
    facts.into_company_facts().annual_financial_periods()
}
