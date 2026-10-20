use crate::company::{CompanyFacts, Fact, FinancialFact, Metric};
use chrono::NaiveDate;
use serde::Deserialize;
use std::collections::HashMap;
pub(crate) fn sec_tags(metric: Metric) -> &'static [&'static str] {
    match metric {
        Metric::Revenue => &[
            "us-gaap:Revenues",
            "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
            "us-gaap:SalesRevenueNet",
            "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
            "us-gaap:RevenuesNetOfInterestExpense",
            "ifrs-full:Revenue",
        ],
        Metric::CostOfRevenue => &[
            "us-gaap:CostOfRevenue",
            "us-gaap:CostOfGoodsAndServicesSold",
            "ifrs-full:CostOfSales",
        ],
        Metric::GrossProfit => &["us-gaap:GrossProfit", "ifrs-full:GrossProfit"],
        Metric::ResearchAndDevelopment => &[
            "us-gaap:ResearchAndDevelopmentExpense",
            "ifrs-full:ResearchAndDevelopmentExpense",
        ],
        Metric::SellingGeneralAndAdministrative => &[
            "us-gaap:SellingGeneralAndAdministrativeExpense",
            "ifrs-full:SellingGeneralAndAdministrativeExpense",
        ],
        Metric::OperatingExpenses => &["us-gaap:OperatingExpenses", "ifrs-full:OperatingExpense"],
        Metric::OperatingIncome => &[
            "us-gaap:OperatingIncomeLoss",
            "ifrs-full:ProfitLossFromOperatingActivities",
        ],
        Metric::InterestExpense => &[
            "us-gaap:InterestExpense",
            "us-gaap:InterestAndDebtExpense",
            "ifrs-full:InterestExpense",
        ],
        Metric::PretaxIncome => &[
            "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
            "ifrs-full:ProfitLossBeforeTax",
        ],
        Metric::IncomeTax => &[
            "us-gaap:IncomeTaxExpenseBenefit",
            "ifrs-full:IncomeTaxExpenseContinuingOperations",
        ],
        Metric::NetIncome => &[
            "us-gaap:NetIncomeLoss",
            "ifrs-full:ProfitLossAttributableToOwnersOfParent",
            "ifrs-full:ProfitLoss",
        ],
        Metric::EpsBasic => &[
            "us-gaap:EarningsPerShareBasic",
            "ifrs-full:BasicEarningsLossPerShare",
        ],
        Metric::EpsDiluted => &[
            "us-gaap:EarningsPerShareDiluted",
            "ifrs-full:DilutedEarningsLossPerShare",
        ],
        Metric::CashAndEquivalents => &[
            "us-gaap:CashAndCashEquivalentsAtCarryingValue",
            "ifrs-full:CashAndCashEquivalents",
        ],
        Metric::ShortTermInvestments => &[
            "us-gaap:ShortTermInvestments",
            "us-gaap:MarketableSecuritiesCurrent",
            "ifrs-full:CurrentInvestments",
        ],
        Metric::Receivables => &[
            "us-gaap:AccountsReceivableNetCurrent",
            "ifrs-full:CurrentTradeReceivables",
        ],
        Metric::Inventory => &["us-gaap:InventoryNet", "ifrs-full:Inventories"],
        Metric::CurrentAssets => &["us-gaap:AssetsCurrent", "ifrs-full:CurrentAssets"],
        Metric::PropertyPlantEquipment => &[
            "us-gaap:PropertyPlantAndEquipmentNet",
            "ifrs-full:PropertyPlantAndEquipment",
        ],
        Metric::Goodwill => &["us-gaap:Goodwill", "ifrs-full:Goodwill"],
        Metric::IntangibleAssets => &[
            "us-gaap:IntangibleAssetsNetExcludingGoodwill",
            "ifrs-full:IntangibleAssetsOtherThanGoodwill",
        ],
        Metric::TotalAssets => &["us-gaap:Assets", "ifrs-full:Assets"],
        Metric::AccountsPayable => &[
            "us-gaap:AccountsPayableCurrent",
            "ifrs-full:TradeAndOtherCurrentPayablesToTradeSuppliers",
        ],
        Metric::CurrentLiabilities => {
            &["us-gaap:LiabilitiesCurrent", "ifrs-full:CurrentLiabilities"]
        }
        Metric::ShortTermDebt => &[
            "us-gaap:ShortTermBorrowings",
            "ifrs-full:ShorttermBorrowings",
        ],
        Metric::CurrentLongTermDebt => &[
            "us-gaap:LongTermDebtCurrent",
            "us-gaap:LongTermDebtAndCapitalLeaseObligationsCurrent",
            "ifrs-full:CurrentPortionOfLongtermBorrowings",
        ],
        Metric::LongTermDebt => &[
            "us-gaap:LongTermDebtNoncurrent",
            "us-gaap:LongTermDebtAndCapitalLeaseObligations",
            "ifrs-full:LongtermBorrowings",
        ],
        Metric::TotalDebt => &[
            "us-gaap:DebtLongtermAndShorttermCombinedAmount",
            "ifrs-full:Borrowings",
        ],
        Metric::TotalLiabilities => &["us-gaap:Liabilities", "ifrs-full:Liabilities"],
        Metric::StockholdersEquity => &[
            "us-gaap:StockholdersEquity",
            "ifrs-full:EquityAttributableToOwnersOfParent",
        ],
        Metric::RetainedEarnings => &[
            "us-gaap:RetainedEarningsAccumulatedDeficit",
            "ifrs-full:RetainedEarnings",
        ],
        Metric::OperatingCashFlow => &[
            "us-gaap:NetCashProvidedByUsedInOperatingActivities",
            "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
            "ifrs-full:CashFlowsFromUsedInOperatingActivities",
        ],
        Metric::DepreciationAmortization => &[
            "us-gaap:DepreciationDepletionAndAmortization",
            "us-gaap:DepreciationAndAmortization",
            "ifrs-full:AdjustmentsForDepreciationAndAmortisationExpense",
        ],
        Metric::StockBasedCompensation => &[
            "us-gaap:ShareBasedCompensation",
            "ifrs-full:AdjustmentsForSharebasedPayments",
        ],
        Metric::Capex => &[
            "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
            "us-gaap:PaymentsToAcquireProductiveAssets",
            "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        ],
        Metric::Acquisitions => &[
            "us-gaap:PaymentsToAcquireBusinessesNetOfCashAcquired",
            "ifrs-full:CashFlowsUsedInObtainingControlOfSubsidiariesOrOtherBusinessesClassifiedAsInvestingActivities",
        ],
        Metric::InvestingCashFlow => &[
            "us-gaap:NetCashProvidedByUsedInInvestingActivities",
            "ifrs-full:CashFlowsFromUsedInInvestingActivities",
        ],
        Metric::DividendsPaid => &[
            "us-gaap:PaymentsOfDividends",
            "us-gaap:PaymentsOfDividendsCommonStock",
            "ifrs-full:DividendsPaid",
            "ifrs-full:DividendsPaidClassifiedAsFinancingActivities",
        ],
        Metric::ShareRepurchases => &[
            "us-gaap:PaymentsForRepurchaseOfCommonStock",
            "ifrs-full:PaymentsToAcquireOrRedeemEntitysShares",
        ],
        Metric::StockIssuance => &[
            "us-gaap:ProceedsFromIssuanceOfCommonStock",
            "ifrs-full:ProceedsFromIssuingShares",
        ],
        Metric::FinancingCashFlow => &[
            "us-gaap:NetCashProvidedByUsedInFinancingActivities",
            "ifrs-full:CashFlowsFromUsedInFinancingActivities",
        ],
        Metric::BasicShares => &[
            "us-gaap:WeightedAverageNumberOfSharesOutstandingBasic",
            "ifrs-full:WeightedAverageShares",
        ],
        Metric::DilutedShares => &[
            "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding",
            "ifrs-full:AdjustedWeightedAverageShares",
        ],
        Metric::Fcf | Metric::FcfPerShare => &[],
    }
}

#[derive(Debug, Deserialize)]
pub struct SecCompanyFacts {
    #[serde(deserialize_with = "deserialize_cik")]
    pub cik: u64,
    #[serde(rename = "entityName")]
    pub entity_name: String,
    facts: HashMap<String, HashMap<String, SecConcept>>,
}

fn deserialize_cik<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Identifier {
        Number(u64),
        Digits(String),
    }
    let value = match Identifier::deserialize(deserializer)? {
        Identifier::Number(value) => Some(value),
        Identifier::Digits(value)
            if !value.is_empty()
                && value.len() <= 10
                && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            value.parse().ok()
        }
        Identifier::Digits(_) => None,
    };
    value
        .filter(|value| (1..=9_999_999_999).contains(value))
        .ok_or_else(|| {
            serde::de::Error::custom("SEC CIK must contain one to ten digits and be positive")
        })
}

impl SecCompanyFacts {
    pub fn into_company_facts(self) -> CompanyFacts {
        let mut company_facts = CompanyFacts::new(sec_tags);
        // Qualified tags preserve the SEC namespace; never infer one from labels.

        for metric in Metric::reported() {
            for tag in sec_tags(*metric) {
                let Some((namespace, name)) = tag.split_once(':') else {
                    continue;
                };
                let Some(concept) = self.facts.get(namespace).and_then(|facts| facts.get(name))
                else {
                    continue;
                };

                for (unit, facts) in &concept.units {
                    for fact in facts {
                        let (Some(fiscal_year), Some(fiscal_period)) =
                            (fact.fiscal_year, fact.fiscal_period.as_ref())
                        else {
                            continue;
                        };
                        if metric.is_instant() {
                            if fact.start.is_none() {
                                company_facts
                                    .instant_facts_by_tag
                                    .entry((*tag).to_owned())
                                    .or_default()
                                    .push(FinancialFact {
                                        metric: metric.key().to_owned(),
                                        tag: (*tag).to_owned(),
                                        value: fact.value.is_finite().then_some(fact.value),
                                        start: None,
                                        end: fact.end,
                                        filed: fact.filed,
                                        accession: fact.accession.clone(),
                                        fiscal_year,
                                        fiscal_period: fiscal_period.clone(),
                                        form: fact.form.clone(),
                                        unit: unit.clone(),
                                        period_type: "instant".to_owned(),
                                    });
                            }
                            continue;
                        }
                        let Some(start) = fact.start else { continue };

                        company_facts.push(Fact {
                            metric: *metric,
                            tag: (*tag).to_string(),
                            value: fact.value,
                            start,
                            end: fact.end,
                            filed: fact.filed,
                            accession: fact.accession.clone(),
                            fiscal_year,
                            fiscal_period: fiscal_period.clone(),
                            form: fact.form.clone(),
                            unit: unit.clone(),
                        });
                    }
                }
            }
        }

        company_facts
    }
}

#[derive(Debug, Deserialize)]
struct SecConcept {
    units: HashMap<String, Vec<SecFact>>,
}

#[derive(Debug, Deserialize)]
struct SecFact {
    start: Option<NaiveDate>,
    end: NaiveDate,
    #[serde(rename = "val")]
    value: f64,
    #[serde(rename = "accn")]
    accession: String,
    #[serde(rename = "fy")]
    fiscal_year: Option<i32>,
    #[serde(rename = "fp")]
    fiscal_period: Option<String>,
    form: String,
    filed: NaiveDate,
}

