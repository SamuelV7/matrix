use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub(super) const MIN_ANNUAL_DAYS: i64 = 300;
pub(super) const MAX_ANNUAL_DAYS: i64 = 430;
pub(super) const MAX_COMPARATIVE_DURATION_DELTA_DAYS: i64 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    Revenue,
    CostOfRevenue,
    GrossProfit,
    ResearchAndDevelopment,
    SellingGeneralAndAdministrative,
    OperatingExpenses,
    OperatingIncome,
    InterestExpense,
    PretaxIncome,
    IncomeTax,
    NetIncome,
    EpsBasic,
    EpsDiluted,
    CashAndEquivalents,
    ShortTermInvestments,
    Receivables,
    Inventory,
    CurrentAssets,
    PropertyPlantEquipment,
    Goodwill,
    IntangibleAssets,
    TotalAssets,
    AccountsPayable,
    CurrentLiabilities,
    ShortTermDebt,
    CurrentLongTermDebt,
    LongTermDebt,
    TotalDebt,
    TotalLiabilities,
    StockholdersEquity,
    RetainedEarnings,
    OperatingCashFlow,
    DepreciationAmortization,
    StockBasedCompensation,
    Capex,
    Acquisitions,
    InvestingCashFlow,
    DividendsPaid,
    ShareRepurchases,
    StockIssuance,
    FinancingCashFlow,
    BasicShares,
    DilutedShares,
    Fcf,
    FcfPerShare,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub metric: Metric,
    pub tag: String,
    pub value: f64,
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub filed: NaiveDate,
    pub accession: String,
    pub fiscal_year: i32,
    pub fiscal_period: String,
    pub form: String,
    pub unit: String,
}

impl Fact {
    pub fn derive_fcf(operating_cash_flow: &Fact, capex: &Fact) -> Option<Fact> {
        if operating_cash_flow.metric != Metric::OperatingCashFlow
            || capex.metric != Metric::Capex
            || !operating_cash_flow.has_same_filing_context(capex)
            || operating_cash_flow.unit != capex.unit
            || operating_cash_flow.tag.split_once(':').map(|(ns, _)| ns)
                != capex.tag.split_once(':').map(|(ns, _)| ns)
            || !operating_cash_flow.tag.contains(':')
            || operating_cash_flow.unit.len() != 3
            || !operating_cash_flow
                .unit
                .bytes()
                .all(|byte| byte.is_ascii_uppercase())
            || !operating_cash_flow.value.is_finite()
            || !capex.value.is_finite()
            || capex.value < 0.0
            || !(operating_cash_flow.value - capex.value).is_finite()
        {
            return None;
        }

        Some(Fact {
            metric: Metric::Fcf,
            tag: format!("derived:{}-{}", operating_cash_flow.tag, capex.tag),
            value: operating_cash_flow.value - capex.value,
            start: operating_cash_flow.start,
            end: operating_cash_flow.end,
            filed: operating_cash_flow.filed,
            accession: operating_cash_flow.accession.clone(),
            fiscal_year: operating_cash_flow.fiscal_year,
            fiscal_period: operating_cash_flow.fiscal_period.clone(),
            form: operating_cash_flow.form.clone(),
            unit: operating_cash_flow.unit.clone(),
        })
    }

    pub fn derive_fcf_per_share(fcf: &Fact, diluted_shares: &Fact) -> Option<Fact> {
        if fcf.metric != Metric::Fcf
            || diluted_shares.metric != Metric::DilutedShares
            || !fcf.has_same_filing_context(diluted_shares)
            || diluted_shares.unit != "shares"
            || !diluted_shares.value.is_finite()
            || diluted_shares.value <= 0.0
            || !fcf.value.is_finite()
            || !(fcf.value / diluted_shares.value).is_finite()
        {
            return None;
        }

        Some(Fact {
            metric: Metric::FcfPerShare,
            tag: format!("derived:{}/{}", fcf.tag, diluted_shares.tag),
            value: fcf.value / diluted_shares.value,
            start: fcf.start,
            end: fcf.end,
            filed: fcf.filed,
            accession: fcf.accession.clone(),
            fiscal_year: fcf.fiscal_year,
            fiscal_period: fcf.fiscal_period.clone(),
            form: fcf.form.clone(),
            unit: format!("{}/share", fcf.unit),
        })
    }

    pub(super) fn has_same_filing_context(&self, other: &Fact) -> bool {
        self.start == other.start
            && self.end == other.end
            && self.filed == other.filed
            && self.accession == other.accession
            && self.fiscal_year == other.fiscal_year
            && self.fiscal_period == other.fiscal_period
            && self.form == other.form
    }

    pub(super) fn is_annual(&self) -> bool {
        let duration_days = self.end.signed_duration_since(self.start).num_days();

        matches!(
            self.form.as_str(),
            "10-K" | "10-K/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
        ) && self.fiscal_period == "FY"
            && (MIN_ANNUAL_DAYS..=MAX_ANNUAL_DAYS).contains(&duration_days)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialFact {
    pub metric: String,
    pub tag: String,
    pub value: Option<f64>,
    pub start: Option<NaiveDate>,
    pub end: NaiveDate,
    pub filed: NaiveDate,
    pub accession: String,
    pub fiscal_year: i32,
    pub fiscal_period: String,
    pub form: String,
    pub unit: String,
    pub period_type: String,
}

impl From<&Fact> for FinancialFact {
    fn from(fact: &Fact) -> Self {
        Self {
            metric: fact.metric.key().to_owned(),
            tag: fact.tag.clone(),
            value: fact.value.is_finite().then_some(fact.value),
            start: Some(fact.start),
            end: fact.end,
            filed: fact.filed,
            accession: fact.accession.clone(),
            fiscal_year: fact.fiscal_year,
            fiscal_period: fact.fiscal_period.clone(),
            form: fact.form.clone(),
            unit: fact
                .unit
                .strip_suffix("/shares")
                .map_or_else(|| fact.unit.clone(), |currency| format!("{currency}/share")),
            period_type: "duration".to_owned(),
        }
    }
}

impl FinancialFact {
    fn same_context(&self, other: &Self) -> bool {
        self.start == other.start
            && self.end == other.end
            && self.filed == other.filed
            && self.accession == other.accession
            && self.fiscal_year == other.fiscal_year
            && self.fiscal_period == other.fiscal_period
            && self.form == other.form
            && self.unit == other.unit
            && self.period_type == other.period_type
            && self.tag.split_once(':').map(|(ns, _)| ns)
                == other.tag.split_once(':').map(|(ns, _)| ns)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialPeriod {
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub currency: String,
    pub fiscal_year: i32,
    pub form: String,
    pub filed: NaiveDate,
    pub accession: String,
    pub fundamentals: BTreeMap<String, Option<FinancialFact>>,
    pub metrics: BTreeMap<String, Option<f64>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompanyProfile {
    pub sic: Option<String>,
    pub industry: Option<String>,
    pub country: Option<String>,
    pub exchanges: Vec<String>,
    pub fiscal_year_end: Option<String>,
}

impl FinancialPeriod {
    pub(super) fn derive_totals(&mut self, blocked: &HashSet<Metric>) {
        for (metric, components, subtract) in [
            (
                Metric::GrossProfit,
                &["revenue", "cost_of_revenue"][..],
                true,
            ),
            (
                Metric::TotalDebt,
                &[
                    "short_term_debt",
                    "current_long_term_debt",
                    "long_term_debt",
                ][..],
                false,
            ),
        ] {
            if blocked.contains(&metric)
                || self
                    .fundamentals
                    .get(metric.key())
                    .and_then(Option::as_ref)
                    .is_some()
            {
                continue;
            }
            let inputs: Option<Vec<_>> = components
                .iter()
                .map(|key| self.fundamentals.get(*key)?.as_ref())
                .collect();
            let Some(inputs) = inputs else {
                continue;
            };
            let first = inputs[0];
            if inputs.iter().skip(1).any(|fact| !first.same_context(fact)) {
                continue;
            }
            if metric == Metric::TotalDebt {
                // Current maturities and noncurrent debt must have the same
                // finance-lease scope. A current aggregate is not short-term debt.
                if inputs
                    .iter()
                    .any(|fact| !fact.value.is_some_and(|v| v >= 0.0))
                    || inputs[1].tag.contains("CapitalLease")
                        != inputs[2].tag.contains("CapitalLease")
                {
                    continue;
                }
            }
            let Some(mut value) = first.value else {
                continue;
            };
            let mut available = true;
            for fact in inputs.iter().skip(1) {
                if let Some(next) = fact.value {
                    value += if subtract { -next } else { next };
                } else {
                    available = false;
                }
            }
            if !available || !value.is_finite() {
                continue;
            }
            let mut derived = first.clone();
            derived.metric = metric.key().to_owned();
            derived.tag = format!(
                "derived:{}",
                inputs
                    .iter()
                    .map(|fact| fact.tag.as_str())
                    .collect::<Vec<_>>()
                    .join(if subtract { "-" } else { "+" })
            );
            derived.value = Some(value);
            self.fundamentals
                .insert(metric.key().to_owned(), Some(derived));
        }
    }
}

pub(super) fn is_currency(unit: &str) -> bool {
    unit.len() == 3 && unit.bytes().all(|byte| byte.is_ascii_uppercase())
}

pub(super) fn is_annual_form(form: &str) -> bool {
    matches!(
        form,
        "10-K" | "10-K/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnnualCashFlow {
    pub fcf: Fact,
    pub operating_cash_flow: Fact,
    pub capex: Fact,
    #[serde(default)]
    pub revenue: Option<Fact>,
    #[serde(default)]
    pub gross_profit: Option<Fact>,
    #[serde(default)]
    pub operating_income: Option<Fact>,
    #[serde(default)]
    pub net_income: Option<Fact>,
    pub diluted_shares: Option<Fact>,
    pub fcf_per_share: Option<Fact>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnnualFcf {
    pub fcf: Fact,
    pub diluted_shares: Fact,
    pub fcf_per_share: Fact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FcfBasis {
    TtmBridge {
        annual_accession: String,
        quarter_accession: String,
    },
    AnnualFallback {
        accession: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FcfSnapshot {
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub as_of: NaiveDate,
    pub fcf: f64,
    pub diluted_shares: f64,
    pub fcf_per_share: f64,
    pub unit: String,
    pub basis: FcfBasis,
}
impl Metric {
    pub(crate) fn reported() -> &'static [Metric] {
        &[
            Self::Revenue,
            Self::CostOfRevenue,
            Self::GrossProfit,
            Self::ResearchAndDevelopment,
            Self::SellingGeneralAndAdministrative,
            Self::OperatingExpenses,
            Self::OperatingIncome,
            Self::InterestExpense,
            Self::PretaxIncome,
            Self::IncomeTax,
            Self::NetIncome,
            Self::EpsBasic,
            Self::EpsDiluted,
            Self::CashAndEquivalents,
            Self::ShortTermInvestments,
            Self::Receivables,
            Self::Inventory,
            Self::CurrentAssets,
            Self::PropertyPlantEquipment,
            Self::Goodwill,
            Self::IntangibleAssets,
            Self::TotalAssets,
            Self::AccountsPayable,
            Self::CurrentLiabilities,
            Self::ShortTermDebt,
            Self::CurrentLongTermDebt,
            Self::LongTermDebt,
            Self::TotalDebt,
            Self::TotalLiabilities,
            Self::StockholdersEquity,
            Self::RetainedEarnings,
            Self::OperatingCashFlow,
            Self::DepreciationAmortization,
            Self::StockBasedCompensation,
            Self::Capex,
            Self::Acquisitions,
            Self::InvestingCashFlow,
            Self::DividendsPaid,
            Self::ShareRepurchases,
            Self::StockIssuance,
            Self::FinancingCashFlow,
            Self::BasicShares,
            Self::DilutedShares,
        ]
    }

    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Revenue => "revenue",
            Self::CostOfRevenue => "cost_of_revenue",
            Self::GrossProfit => "gross_profit",
            Self::ResearchAndDevelopment => "research_and_development",
            Self::SellingGeneralAndAdministrative => "selling_general_and_administrative",
            Self::OperatingExpenses => "operating_expenses",
            Self::OperatingIncome => "operating_income",
            Self::InterestExpense => "interest_expense",
            Self::PretaxIncome => "pretax_income",
            Self::IncomeTax => "income_tax",
            Self::NetIncome => "net_income",
            Self::EpsBasic => "eps_basic",
            Self::EpsDiluted => "eps_diluted",
            Self::CashAndEquivalents => "cash_and_equivalents",
            Self::ShortTermInvestments => "short_term_investments",
            Self::Receivables => "receivables",
            Self::Inventory => "inventory",
            Self::CurrentAssets => "current_assets",
            Self::PropertyPlantEquipment => "property_plant_equipment",
            Self::Goodwill => "goodwill",
            Self::IntangibleAssets => "intangible_assets",
            Self::TotalAssets => "total_assets",
            Self::AccountsPayable => "accounts_payable",
            Self::CurrentLiabilities => "current_liabilities",
            Self::ShortTermDebt => "short_term_debt",
            Self::CurrentLongTermDebt => "current_long_term_debt",
            Self::LongTermDebt => "long_term_debt",
            Self::TotalDebt => "total_debt",
            Self::TotalLiabilities => "total_liabilities",
            Self::StockholdersEquity => "stockholders_equity",
            Self::RetainedEarnings => "retained_earnings",
            Self::OperatingCashFlow => "operating_cash_flow",
            Self::DepreciationAmortization => "depreciation_amortization",
            Self::StockBasedCompensation => "stock_based_compensation",
            Self::Capex => "capex",
            Self::Acquisitions => "acquisitions",
            Self::InvestingCashFlow => "investing_cash_flow",
            Self::DividendsPaid => "dividends_paid",
            Self::ShareRepurchases => "share_repurchases",
            Self::StockIssuance => "stock_issuance",
            Self::FinancingCashFlow => "financing_cash_flow",
            Self::BasicShares => "basic_shares",
            Self::DilutedShares => "diluted_shares",
            Self::Fcf => "fcf",
            Self::FcfPerShare => "fcf_per_share",
        }
    }

    pub(crate) fn is_instant(self) -> bool {
        matches!(
            self,
            Self::CashAndEquivalents
                | Self::ShortTermInvestments
                | Self::Receivables
                | Self::Inventory
                | Self::CurrentAssets
                | Self::PropertyPlantEquipment
                | Self::Goodwill
                | Self::IntangibleAssets
                | Self::TotalAssets
                | Self::AccountsPayable
                | Self::CurrentLiabilities
                | Self::ShortTermDebt
                | Self::CurrentLongTermDebt
                | Self::LongTermDebt
                | Self::TotalDebt
                | Self::TotalLiabilities
                | Self::StockholdersEquity
                | Self::RetainedEarnings
        )
    }

    pub(crate) fn accepts_unit(self, unit: &str, currency: &str) -> bool {
        match self {
            Self::BasicShares | Self::DilutedShares => unit == "shares",
            Self::EpsBasic | Self::EpsDiluted => unit
                .strip_prefix(currency)
                .is_some_and(|suffix| matches!(suffix, "/share" | "/shares")),
            _ => unit == currency,
        }
    }
}
