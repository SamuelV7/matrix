mod extraction;
mod model;

#[cfg(test)]
use crate::sec::{SecCompanyFacts, sec_tags};
pub(crate) use extraction::CompanyFacts;
pub use model::{CompanyProfile, FcfBasis, FcfSnapshot, FinancialPeriod};
pub(crate) use model::{Fact, FinancialFact, Metric};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn reported_value(
        value: f64,
        start: Option<&str>,
        filed: &str,
        accession: &str,
    ) -> serde_json::Value {
        let mut fact = serde_json::json!({
            "end": "2024-12-31", "val": value, "accn": accession,
            "fy": 2024, "fp": "FY", "form": "10-K", "filed": filed,
        });
        if let Some(start) = start {
            fact["start"] = start.into();
        }
        fact
    }

    fn periods_from_tags(tags: serde_json::Value) -> Vec<FinancialPeriod> {
        serde_json::from_value::<SecCompanyFacts>(serde_json::json!({
            "cik": 1, "entityName": "Test issuer", "facts": tags,
        }))
        .unwrap()
        .into_company_facts()
        .annual_financial_periods()
    }

    fn reported_metric(period: &FinancialPeriod, key: &str) -> Option<f64> {
        period
            .fundamentals
            .get(key)
            .and_then(Option::as_ref)
            .and_then(|fact| fact.value)
    }

    #[test]
    fn sec_identifiers_accept_numeric_or_digit_string_wire_values() {
        for cik in [serde_json::json!(2115436), serde_json::json!("0002115436")] {
            let report: SecCompanyFacts = serde_json::from_value(serde_json::json!({
                "cik": cik, "entityName": "Issuer", "facts": {}
            }))
            .unwrap();
            assert_eq!(report.cik, 2115436);
        }
        for cik in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(""),
            serde_json::json!("1e3"),
            serde_json::json!(" 123"),
            serde_json::json!("10000000000"),
            serde_json::json!(10000000000_u64),
        ] {
            assert!(
                serde_json::from_value::<SecCompanyFacts>(serde_json::json!({
                    "cik": cik, "entityName": "Issuer", "facts": {}
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn bank_income_and_balance_remain_available_without_capital_expenditures() {
        let duration = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "bank");
        let instant = |value| reported_value(value, None, "2025-02-15", "bank");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "RevenuesNetOfInterestExpense": {"units": {"USD": [duration(150.0)]}},
            "NetIncomeLoss": {"units": {"USD": [duration(45.0)]}},
            "Assets": {"units": {"USD": [instant(3000.0)]}},
            "Liabilities": {"units": {"USD": [instant(2700.0)]}},
            "StockholdersEquity": {"units": {"USD": [instant(300.0)]}},
        }}));
        let period = &periods[0];
        assert_eq!(reported_metric(period, "revenue"), Some(150.0));
        assert_eq!(reported_metric(period, "net_income"), Some(45.0));
        assert_eq!(reported_metric(period, "total_assets"), Some(3000.0));
        assert_eq!(reported_metric(period, "stockholders_equity"), Some(300.0));
        assert_eq!(reported_metric(period, "fcf"), None);
        assert_eq!(reported_metric(period, "capex"), None);
    }

    #[test]
    fn balance_candidates_cannot_cross_namespace_currency_or_instant_date() {
        let duration = reported_value(200.0, Some("2024-01-01"), "2025-02-15", "anchor");
        let instant = reported_value(500.0, None, "2025-02-15", "anchor");
        let mut prior = instant.clone();
        prior["end"] = "2023-12-31".into();
        let mut quarterly = instant.clone();
        quarterly["form"] = "10-Q".into();
        let mut tags = serde_json::json!({
            "us-gaap": {
                "Revenues": {"units": {"USD": [duration]}},
                "Assets": {"units": {"USD": [prior, quarterly], "EUR": [instant.clone()]}},
            },
            "ifrs-full": {"Assets": {"units": {"USD": [instant.clone()]}}}
        });
        assert_eq!(
            reported_metric(&periods_from_tags(tags.clone())[0], "total_assets"),
            None
        );
        tags["us-gaap"]["Assets"]["units"]["USD"]
            .as_array_mut()
            .unwrap()
            .push(instant);
        assert_eq!(
            reported_metric(&periods_from_tags(tags)[0], "total_assets"),
            Some(500.0)
        );
    }

    #[test]
    fn conflicting_reported_totals_cannot_be_replaced_with_derived_values() {
        let duration = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "anchor");
        let instant = |value| reported_value(value, None, "2025-02-15", "anchor");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [duration(200.0)]}},
            "CostOfRevenue": {"units": {"USD": [duration(80.0)]}},
            "GrossProfit": {"units": {"USD": [duration(120.0), duration(130.0)]}},
            "ShortTermBorrowings": {"units": {"USD": [instant(20.0)]}},
            "LongTermDebtCurrent": {"units": {"USD": [instant(10.0)]}},
            "LongTermDebtNoncurrent": {"units": {"USD": [instant(90.0)]}},
            "DebtLongtermAndShorttermCombinedAmount": {"units": {"USD": [instant(120.0), instant(130.0)]}},
        }}));
        assert_eq!(reported_metric(&periods[0], "gross_profit"), None);
        assert_eq!(reported_metric(&periods[0], "total_debt"), None);
    }

    #[test]
    fn income_only_statements_keep_instants_and_do_not_invent_fcf_eps_or_operating_expenses() {
        let duration = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "annual");
        let instant = |value| reported_value(value, None, "2025-02-15", "annual");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [duration(200.0)]}},
            "CostOfRevenue": {"units": {"USD": [duration(80.0)]}},
            "NetIncomeLoss": {"units": {"USD": [duration(40.0)]}},
            "SellingGeneralAndAdministrativeExpense": {"units": {"USD": [duration(20.0)]}},
            "ResearchAndDevelopmentExpense": {"units": {"USD": [duration(10.0)]}},
            "Assets": {"units": {"USD": [instant(500.0)]}},
        }}));
        let period = &periods[0];
        assert_eq!(reported_metric(period, "revenue"), Some(200.0));
        assert_eq!(reported_metric(period, "gross_profit"), Some(120.0));
        assert_eq!(reported_metric(period, "net_income"), Some(40.0));
        for missing in [
            "operating_expenses",
            "fcf",
            "eps_basic",
            "eps_diluted",
            "basic_shares",
            "diluted_shares",
            "fcf_per_share",
        ] {
            assert_eq!(reported_metric(period, missing), None);
        }
        let assets = period.fundamentals["total_assets"].as_ref().unwrap();
        assert_eq!(assets.value, Some(500.0));
        assert_eq!(assets.start, None);
        assert_eq!(assets.period_type, "instant");
        assert!(serde_json::to_value(assets).unwrap()["start"].is_null());
    }

    #[test]
    fn historical_balance_uses_available_annual_filing_not_three_year_duration_anchor() {
        let duration = reported_value(
            200.0,
            Some("2024-01-01"),
            "2027-02-15",
            "three-year-comparison",
        );
        let historical = reported_value(500.0, None, "2025-02-15", "original-balance");
        let newer = reported_value(550.0, None, "2026-02-15", "two-year-comparison");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [duration]}},
            "Assets": {"units": {"USD": [historical, newer]}},
        }}));
        let period = &periods[0];
        let assets = period.fundamentals["total_assets"].as_ref().unwrap();
        assert_eq!(assets.value, Some(550.0));
        assert_eq!(assets.accession, "two-year-comparison");
        assert_eq!(assets.start, None);
        assert_eq!(period.accession, "three-year-comparison");
    }

    #[test]
    fn balance_prefers_matching_filing_and_conflict_never_falls_back_to_older_values() {
        let revenue = reported_value(200.0, Some("2024-01-01"), "2025-02-15", "anchor");
        let matched = reported_value(500.0, None, "2025-02-15", "anchor");
        let later = reported_value(600.0, None, "2026-02-15", "later");
        let mut tags = serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [revenue]}},
            "Assets": {"units": {"USD": [matched.clone(), matched, later]}},
        }});
        assert_eq!(
            reported_metric(&periods_from_tags(tags.clone())[0], "total_assets"),
            Some(500.0)
        );
        tags["us-gaap"]["Assets"]["units"]["USD"]
            .as_array_mut()
            .unwrap()
            .push(reported_value(501.0, None, "2025-02-15", "anchor"));
        assert_eq!(
            reported_metric(&periods_from_tags(tags)[0], "total_assets"),
            None
        );
    }

    #[test]
    fn financial_duration_selection_isolates_namespace_currency_period_and_annual_form() {
        let anchor = annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "anchor",
            "10-K",
        );
        let revenue = annual_fact(
            Metric::Revenue,
            "us-gaap:Revenues",
            200.0,
            "2025-02-15",
            "anchor",
            "10-K",
        );
        let mut mismatches = vec![revenue; 5];
        mismatches[0].tag = "ifrs-full:Revenue".to_owned();
        mismatches[1].unit = "EUR".to_owned();
        mismatches[2].start = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
        mismatches[3].end = NaiveDate::from_ymd_opt(2024, 12, 30).unwrap();
        mismatches[4].form = "10-Q".to_owned();
        for mismatch in mismatches {
            let mut facts = CompanyFacts::new(sec_tags);
            facts.push(anchor.clone());
            facts.push(mismatch);
            let periods = facts.annual_financial_periods();
            let period = periods
                .iter()
                .find(|period| {
                    period.start == anchor.start
                        && period.end == anchor.end
                        && period.currency == "USD"
                })
                .unwrap();
            assert_eq!(reported_metric(period, "revenue"), None);
            assert_eq!(reported_metric(period, "operating_cash_flow"), Some(100.0));
        }
    }

    #[test]
    fn conflicting_preferred_income_blocks_lower_priority_tag_and_derived_gross_profit() {
        let source = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "anchor");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": [source(100.0)]}},
            "Revenues": {"units": {"USD": [source(200.0), source(201.0)]}},
            "SalesRevenueNet": {"units": {"USD": [source(200.0)]}},
            "CostOfRevenue": {"units": {"USD": [source(80.0)]}},
        }}));
        assert_eq!(reported_metric(&periods[0], "revenue"), None);
        assert_eq!(reported_metric(&periods[0], "gross_profit"), None);
    }

    #[test]
    fn debt_requires_complete_nonoverlapping_components_and_consistent_filings() {
        let duration = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "anchor");
        let instant = |value| reported_value(value, None, "2025-02-15", "anchor");
        let mut tags = serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [duration(200.0)]}},
            "LongTermDebtCurrent": {"units": {"USD": [instant(10.0)]}},
            "LongTermDebtNoncurrent": {"units": {"USD": [instant(90.0)]}},
            "DebtCurrent": {"units": {"USD": [instant(30.0)]}},
        }});
        assert_eq!(
            reported_metric(&periods_from_tags(tags.clone())[0], "total_debt"),
            None
        );
        tags["us-gaap"]["ShortTermBorrowings"] =
            serde_json::json!({"units": {"USD": [instant(20.0)]}});
        let complete = periods_from_tags(tags.clone());
        assert_eq!(reported_metric(&complete[0], "total_debt"), Some(120.0));
        assert_eq!(
            complete[0].fundamentals["total_debt"]
                .as_ref()
                .unwrap()
                .start,
            None
        );
        tags["us-gaap"]["ShortTermBorrowings"]["units"]["USD"][0]["accn"] = "other-filing".into();
        assert_eq!(
            reported_metric(&periods_from_tags(tags.clone())[0], "total_debt"),
            None
        );
        tags["us-gaap"]["DebtLongtermAndShorttermCombinedAmount"] =
            serde_json::json!({"units": {"USD": [instant(125.0)]}});
        assert_eq!(
            reported_metric(&periods_from_tags(tags)[0], "total_debt"),
            Some(125.0)
        );
    }

    #[test]
    fn duration_and_instant_aggregates_never_mix_filings_or_invent_balance_durations() {
        let duration = |value| reported_value(value, Some("2024-01-01"), "2025-02-15", "anchor");
        let periods = periods_from_tags(serde_json::json!({"us-gaap": {
            "Revenues": {"units": {"USD": [duration(200.0)]}},
            "CostOfRevenue": {"units": {"USD": [
                reported_value(80.0, Some("2024-01-01"), "2026-02-15", "later")
            ]}},
            "Assets": {"units": {"USD": [duration(500.0)]}},
        }}));
        assert_eq!(reported_metric(&periods[0], "cost_of_revenue"), Some(80.0));
        assert_eq!(reported_metric(&periods[0], "gross_profit"), None);
        assert_eq!(reported_metric(&periods[0], "total_assets"), None);
    }

    #[test]
    fn financial_report_preserves_latest_complete_fcf_bundle_against_newer_unpaired_facts() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        facts.push(annual_fact(
            Metric::Revenue,
            "us-gaap:Revenues",
            300.0,
            "2025-03-10",
            "newer",
            "10-K/A",
        ));
        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            150.0,
            "2025-03-10",
            "newer",
            "10-K/A",
        ));
        facts.push(annual_diluted_shares(12.0, "2025-03-10", "newer", "10-K/A"));
        let periods = facts.annual_financial_periods();
        let period = &periods[0];
        assert_eq!(reported_metric(period, "revenue"), Some(300.0));
        assert_eq!(reported_metric(period, "operating_cash_flow"), Some(120.0));
        assert_eq!(reported_metric(period, "capex"), Some(20.0));
        assert_eq!(reported_metric(period, "fcf"), Some(100.0));
        assert_eq!(reported_metric(period, "diluted_shares"), Some(10.0));
        assert_eq!(reported_metric(period, "fcf_per_share"), Some(10.0));
        assert_eq!(
            period.fundamentals["fcf"].as_ref().unwrap().accession,
            "annual-filing"
        );
    }

    #[test]
    fn ifrs_income_balance_and_eps_normalize_units_without_requiring_capex_or_shares() {
        let duration = |value| {
            let mut fact = reported_value(value, Some("2024-01-01"), "2025-04-15", "foreign");
            fact["form"] = "20-F/A".into();
            fact
        };
        let mut assets = reported_value(500.0, None, "2025-04-15", "foreign");
        assets["form"] = "20-F/A".into();
        let periods = periods_from_tags(serde_json::json!({"ifrs-full": {
            "Revenue": {"units": {"EUR": [duration(200.0)]}},
            "Assets": {"units": {"EUR": [assets]}},
            "BasicEarningsLossPerShare": {"units": {"EUR/shares": [duration(2.0)]}},
            "DilutedEarningsLossPerShare": {"units": {"USD/shares": [duration(1.9)]}},
        }}));
        let period = &periods[0];
        assert_eq!(reported_metric(period, "total_assets"), Some(500.0));
        assert_eq!(reported_metric(period, "eps_basic"), Some(2.0));
        assert_eq!(
            period.fundamentals["eps_basic"].as_ref().unwrap().unit,
            "EUR/share"
        );
        assert_eq!(reported_metric(period, "eps_diluted"), None);
        assert_eq!(reported_metric(period, "diluted_shares"), None);
        assert_eq!(reported_metric(period, "fcf"), None);
    }

    const OCF: &str = "us-gaap:NetCashProvidedByUsedInOperatingActivities";
    const OCF_FALLBACK: &str =
        "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
    const CAPEX: &str = "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment";
    const CAPEX_FALLBACK: &str = "us-gaap:PaymentsToAcquireProductiveAssets";
    const DILUTED_SHARES: &str = "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding";
    const IFRS_OCF: &str = "ifrs-full:CashFlowsFromUsedInOperatingActivities";
    const IFRS_CAPEX: &str =
        "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities";
    const IFRS_SHARES: &str = "ifrs-full:AdjustedWeightedAverageShares";

    struct FactSpec<'a> {
        metric: Metric,
        tag: &'a str,
        value: f64,
        start: &'a str,
        end: &'a str,
        filed: &'a str,
        accession: &'a str,
        form: &'a str,
        fiscal_period: &'a str,
    }

    fn fact(spec: FactSpec<'_>) -> Fact {
        Fact {
            metric: spec.metric,
            tag: spec.tag.to_string(),
            value: spec.value,
            start: NaiveDate::parse_from_str(spec.start, "%Y-%m-%d").unwrap(),
            end: NaiveDate::parse_from_str(spec.end, "%Y-%m-%d").unwrap(),
            filed: NaiveDate::parse_from_str(spec.filed, "%Y-%m-%d").unwrap(),
            accession: spec.accession.to_string(),
            fiscal_year: 2024,
            fiscal_period: spec.fiscal_period.to_string(),
            form: spec.form.to_string(),
            unit: "USD".to_string(),
        }
    }

    fn annual_fact(
        metric: Metric,
        tag: &str,
        value: f64,
        filed: &str,
        accession: &str,
        form: &str,
    ) -> Fact {
        fact(FactSpec {
            metric,
            tag,
            value,
            start: "2024-01-01",
            end: "2024-12-31",
            filed,
            accession,
            form,
            fiscal_period: "FY",
        })
    }

    fn annual_diluted_shares(value: f64, filed: &str, accession: &str, form: &str) -> Fact {
        let mut shares = annual_fact(
            Metric::DilutedShares,
            DILUTED_SHARES,
            value,
            filed,
            accession,
            form,
        );
        shares.unit = "shares".to_string();
        shares
    }

    #[allow(clippy::too_many_arguments)]
    fn push_fcf_context(
        facts: &mut CompanyFacts,
        start: &str,
        end: &str,
        filed: &str,
        accession: &str,
        form: &str,
        fiscal_period: &str,
        operating_cash_flow: f64,
        capex: f64,
        diluted_shares: f64,
    ) {
        facts.push(fact(FactSpec {
            metric: Metric::OperatingCashFlow,
            tag: OCF,
            value: operating_cash_flow,
            start,
            end,
            filed,
            accession,
            form,
            fiscal_period,
        }));
        facts.push(fact(FactSpec {
            metric: Metric::Capex,
            tag: CAPEX,
            value: capex,
            start,
            end,
            filed,
            accession,
            form,
            fiscal_period,
        }));
        let mut shares = fact(FactSpec {
            metric: Metric::DilutedShares,
            tag: DILUTED_SHARES,
            value: diluted_shares,
            start,
            end,
            filed,
            accession,
            form,
            fiscal_period,
        });
        shares.unit = "shares".to_string();
        facts.push(shares);
    }

    fn push_annual_fcf_context(facts: &mut CompanyFacts) {
        push_fcf_context(
            facts,
            "2024-01-01",
            "2024-12-31",
            "2025-02-15",
            "annual-filing",
            "10-K",
            "FY",
            120.0,
            20.0,
            10.0,
        );
    }

    #[test]
    fn derive_fcf_rejects_facts_from_different_filings() {
        let operating_cash_flow = annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        );
        let capex = annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        );

        assert!(Fact::derive_fcf(&operating_cash_flow, &capex).is_none());
    }

    #[test]
    fn annual_fcf_uses_latest_complete_same_filing_pair() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF_FALLBACK,
            105.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX_FALLBACK,
            22.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        ));

        let fcf = facts.annual_fcf();

        assert_eq!(fcf.len(), 1);
        assert_eq!(fcf[0].value, 83.0);
        assert_eq!(fcf[0].accession, "filing-b");
    }

    #[test]
    fn annual_fcf_per_share_uses_same_filing_diluted_shares() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_diluted_shares(
            10.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));

        let annual_fcf = facts.annual_fcf_with_per_share();

        assert_eq!(annual_fcf.len(), 1);
        assert_eq!(annual_fcf[0].fcf.value, 80.0);
        assert_eq!(annual_fcf[0].diluted_shares.value, 10.0);
        assert_eq!(annual_fcf[0].fcf_per_share.value, 8.0);
        assert_eq!(annual_fcf[0].fcf_per_share.unit, "USD/share");
    }

    #[test]
    fn annual_fcf_per_share_uses_latest_complete_three_fact_filing() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_diluted_shares(
            10.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            110.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        ));

        let annual_fcf = facts.annual_fcf_with_per_share();

        assert_eq!(annual_fcf.len(), 1);
        assert_eq!(annual_fcf[0].fcf.accession, "filing-a");
        assert_eq!(annual_fcf[0].fcf_per_share.value, 8.0);
    }

    #[test]
    fn annual_cash_flow_keeps_latest_restatement_without_shares() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        facts.push(annual_fact(
            Metric::Revenue,
            "us-gaap:Revenues",
            250.0,
            "2025-02-15",
            "annual-filing",
            "10-K",
        ));
        for (accession, value) in [("restatement-a", 130.0), ("restatement-z", 140.0)] {
            facts.push(annual_fact(
                Metric::OperatingCashFlow,
                OCF,
                value,
                "2025-03-10",
                accession,
                "10-K/A",
            ));
            facts.push(annual_fact(
                Metric::Capex,
                CAPEX,
                20.0,
                "2025-03-10",
                accession,
                "10-K/A",
            ));
        }
        let annual = facts.annual_cash_flows().pop().unwrap();
        assert_eq!(annual.fcf.accession, "restatement-z");
        assert_eq!(annual.fcf.value, 120.0);
        assert!(annual.diluted_shares.is_none());
        assert!(annual.fcf_per_share.is_none());
        assert!(annual.revenue.is_none());
        assert_eq!(
            facts.annual_fcf_with_per_share()[0].fcf.accession,
            "annual-filing"
        );
    }

    #[test]
    fn optional_fundamentals_preserve_fcf_when_preferred_facts_conflict() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        for (tag, value) in [
            ("us-gaap:Revenues", 250.0),
            ("us-gaap:Revenues", 260.0),
            ("us-gaap:SalesRevenueNet", 255.0),
        ] {
            facts.push(annual_fact(
                Metric::Revenue,
                tag,
                value,
                "2025-02-15",
                "annual-filing",
                "10-K",
            ));
        }
        facts.push(annual_fact(
            Metric::NetIncome,
            "us-gaap:NetIncomeLoss",
            -15.0,
            "2025-02-15",
            "annual-filing",
            "10-K",
        ));

        let annual = facts.annual_cash_flows().pop().unwrap();
        assert_eq!(annual.fcf.value, 100.0);
        assert_eq!(annual.fcf_per_share.as_ref().unwrap().value, 10.0);
        assert!(annual.revenue.is_none());
        assert_eq!(annual.net_income.as_ref().unwrap().value, -15.0);
        assert!(annual.gross_profit.is_none());
        assert!(annual.operating_income.is_none());
    }

    #[test]
    fn optional_fundamentals_require_same_filing_duration_currency_and_taxonomy() {
        let revenue = annual_fact(
            Metric::Revenue,
            "us-gaap:Revenues",
            250.0,
            "2025-02-15",
            "annual-filing",
            "10-K",
        );
        let mut mismatches = vec![revenue.clone(); 5];
        mismatches[0].tag = "ifrs-full:Revenue".to_string();
        mismatches[1].unit = "EUR".to_string();
        mismatches[2].start = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
        mismatches[3].accession = "different-filing".to_string();
        mismatches[4].value = f64::INFINITY;
        for mismatch in mismatches {
            let mut facts = CompanyFacts::new(sec_tags);
            push_annual_fcf_context(&mut facts);
            facts.push(mismatch);
            let annual = facts.annual_cash_flows().pop().unwrap();
            assert_eq!(annual.fcf.value, 100.0);
            assert!(annual.revenue.is_none());
        }

        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        facts.push(revenue);
        assert_eq!(
            facts.annual_cash_flows()[0].revenue.as_ref().unwrap().value,
            250.0
        );
    }

    #[test]
    fn annual_cash_flow_rejects_conflicting_preferred_tag_in_either_order() {
        for values in [[100.0, 110.0], [110.0, 100.0]] {
            let mut facts = CompanyFacts::new(sec_tags);
            for value in values {
                facts.push(annual_fact(
                    Metric::OperatingCashFlow,
                    OCF,
                    value,
                    "2025-02-15",
                    "filing-a",
                    "10-K",
                ));
            }
            facts.push(annual_fact(
                Metric::OperatingCashFlow,
                OCF_FALLBACK,
                105.0,
                "2025-02-15",
                "filing-a",
                "10-K",
            ));
            facts.push(annual_fact(
                Metric::Capex,
                CAPEX,
                20.0,
                "2025-02-15",
                "filing-a",
                "10-K",
            ));
            assert!(facts.annual_cash_flows().is_empty());
        }
    }

    #[test]
    fn annual_cash_flow_allows_identical_duplicates_but_not_conflicting_shares() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            120.0,
            "2025-02-15",
            "annual-filing",
            "10-K",
        ));
        facts.push(annual_diluted_shares(
            11.0,
            "2025-02-15",
            "annual-filing",
            "10-K",
        ));
        let annual = facts.annual_cash_flows().pop().unwrap();
        assert_eq!(annual.fcf.value, 100.0);
        assert!(annual.fcf_per_share.is_none());
    }

    #[test]
    fn annual_cash_flow_rejects_invalid_capex_without_absolutizing_or_clamping() {
        let ocf = annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        );
        for value in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut facts = CompanyFacts::new(sec_tags);
            facts.push(ocf.clone());
            facts.push(annual_fact(
                Metric::Capex,
                CAPEX,
                value,
                "2025-02-15",
                "filing-a",
                "10-K",
            ));
            assert!(facts.annual_cash_flows().is_empty());
        }
        for (value, expected) in [(0.0, 100.0), (200.0, -100.0)] {
            let capex = annual_fact(
                Metric::Capex,
                CAPEX,
                value,
                "2025-02-15",
                "filing-a",
                "10-K",
            );
            assert_eq!(Fact::derive_fcf(&ocf, &capex).unwrap().value, expected);
        }
        let mut extreme_ocf = ocf;
        extreme_ocf.value = -f64::MAX;
        let capex = annual_fact(
            Metric::Capex,
            CAPEX,
            f64::MAX,
            "2025-02-15",
            "filing-a",
            "10-K",
        );
        assert!(Fact::derive_fcf(&extreme_ocf, &capex).is_none());
    }

    #[test]
    fn annual_cash_flow_never_pairs_different_taxonomies_currencies_or_durations() {
        let ocf = annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        );
        let capex = annual_fact(Metric::Capex, CAPEX, 20.0, "2025-02-15", "filing-a", "10-K");
        let mut mismatches = vec![capex.clone(); 3];
        mismatches[0].tag = IFRS_CAPEX.to_string();
        mismatches[1].unit = "TWD".to_string();
        mismatches[2].start = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
        for mismatch in mismatches {
            let mut facts = CompanyFacts::new(sec_tags);
            facts.push(ocf.clone());
            facts.push(mismatch);
            assert!(facts.annual_cash_flows().is_empty());
        }
    }

    #[test]
    fn parses_ifrs_foreign_annual_forms_and_keeps_currency_and_share_provenance() {
        for form in ["20-F", "20-F/A", "40-F", "40-F/A"] {
            let reported = |value| {
                serde_json::json!({
                    "start": "2024-01-01", "end": "2024-12-31", "val": value,
                    "accn": "foreign-filing", "fy": 2024, "fp": "FY",
                    "form": form, "filed": "2025-04-17"
                })
            };
            let payload = serde_json::json!({
                "cik": 1046179, "entityName": "Foreign issuer",
                "facts": {"ifrs-full": {
                    "Revenue": {"units": {"TWD": [reported(3000.0)], "USD": [reported(100.0)]}},
                    "GrossProfit": {"units": {"TWD": [reported(1500.0)], "USD": [reported(50.0)]}},
                    "ProfitLossFromOperatingActivities": {"units": {"TWD": [reported(1200.0)], "USD": [reported(40.0)]}},
                    "ProfitLoss": {"units": {"TWD": [reported(600.0)], "USD": [reported(20.0)]}},
                    "CashFlowsFromUsedInOperatingActivities": {"units": {
                        "TWD": [reported(1800.0)], "USD": [reported(60.0)]
                    }},
                    "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities": {"units": {
                        "TWD": [reported(900.0)], "USD": [reported(30.0)]
                    }},
                    "AdjustedWeightedAverageShares": {"units": {"shares": [reported(10.0)]}}
                }}
            });
            let sec: SecCompanyFacts = serde_json::from_value(payload).unwrap();
            let annuals = sec.into_company_facts().annual_cash_flows();
            assert_eq!(annuals.len(), 2);
            for annual in annuals {
                let expected = if annual.fcf.unit == "TWD" {
                    900.0
                } else {
                    30.0
                };
                assert_eq!(annual.fcf.value, expected);
                assert_eq!(annual.operating_cash_flow.tag, IFRS_OCF);
                assert_eq!(annual.capex.tag, IFRS_CAPEX);
                assert_eq!(annual.diluted_shares.as_ref().unwrap().tag, IFRS_SHARES);
                assert_eq!(
                    annual.fcf_per_share.as_ref().unwrap().value,
                    expected / 10.0
                );
                for (input, expected_tag, usd_value) in [
                    (annual.revenue.as_ref(), "ifrs-full:Revenue", 100.0),
                    (annual.gross_profit.as_ref(), "ifrs-full:GrossProfit", 50.0),
                    (
                        annual.operating_income.as_ref(),
                        "ifrs-full:ProfitLossFromOperatingActivities",
                        40.0,
                    ),
                    (annual.net_income.as_ref(), "ifrs-full:ProfitLoss", 20.0),
                ] {
                    let input = input.unwrap();
                    assert_eq!(input.tag, expected_tag);
                    assert_eq!(input.unit, annual.fcf.unit);
                    assert!(input.has_same_filing_context(&annual.fcf));
                    assert_eq!(input.value, usd_value * (expected / 30.0));
                }
                let serialized = serde_json::to_value(annual).unwrap();
                assert_eq!(
                    serialized["operating_cash_flow"]["metric"],
                    "operating_cash_flow"
                );
            }
        }
    }

    #[test]
    fn annual_fcf_does_not_mix_an_unpaired_newer_filing() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            110.0,
            "2025-03-10",
            "filing-b",
            "10-K/A",
        ));

        let fcf = facts.annual_fcf();

        assert_eq!(fcf.len(), 1);
        assert_eq!(fcf[0].value, 80.0);
        assert_eq!(fcf[0].accession, "filing-a");
    }

    #[test]
    fn annual_fcf_prefers_primary_tag_within_a_filing() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(annual_fact(
            Metric::OperatingCashFlow,
            OCF,
            100.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX_FALLBACK,
            30.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));
        facts.push(annual_fact(
            Metric::Capex,
            CAPEX,
            20.0,
            "2025-02-15",
            "filing-a",
            "10-K",
        ));

        let fcf = facts.annual_fcf();

        assert_eq!(fcf.len(), 1);
        assert_eq!(fcf[0].value, 80.0);
        assert_eq!(fcf[0].tag, format!("derived:{OCF}-{CAPEX}"));
    }

    #[test]
    fn annual_fcf_keeps_matching_currency_series_separate() {
        let mut facts = CompanyFacts::new(sec_tags);

        for unit in ["USD", "EUR"] {
            let mut operating_cash_flow = annual_fact(
                Metric::OperatingCashFlow,
                OCF,
                100.0,
                "2025-02-15",
                "filing-a",
                "10-K",
            );
            operating_cash_flow.unit = unit.to_string();
            facts.push(operating_cash_flow);

            let mut capex =
                annual_fact(Metric::Capex, CAPEX, 20.0, "2025-02-15", "filing-a", "10-K");
            capex.unit = unit.to_string();
            facts.push(capex);
        }

        let fcf = facts.annual_fcf();

        assert_eq!(fcf.len(), 2);
        assert!(fcf.iter().any(|fact| fact.unit == "USD"));
        assert!(fcf.iter().any(|fact| fact.unit == "EUR"));
    }

    #[test]
    fn annual_fcf_ignores_quarterly_facts() {
        let mut facts = CompanyFacts::new(sec_tags);

        facts.push(fact(FactSpec {
            metric: Metric::OperatingCashFlow,
            tag: OCF,
            value: 30.0,
            start: "2024-01-01",
            end: "2024-03-31",
            filed: "2024-05-01",
            accession: "quarterly-filing",
            form: "10-Q",
            fiscal_period: "Q1",
        }));
        facts.push(fact(FactSpec {
            metric: Metric::Capex,
            tag: CAPEX,
            value: 5.0,
            start: "2024-01-01",
            end: "2024-03-31",
            filed: "2024-05-01",
            accession: "quarterly-filing",
            form: "10-Q",
            fiscal_period: "Q1",
        }));

        assert!(facts.annual_fcf().is_empty());
    }

    #[test]
    fn latest_fcf_uses_q2_ytd_bridge_and_share_day_weighting() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        push_fcf_context(
            &mut facts,
            "2025-01-01",
            "2025-06-30",
            "2025-08-01",
            "q2-filing",
            "10-Q",
            "Q2",
            70.0,
            10.0,
            12.0,
        );
        push_fcf_context(
            &mut facts,
            "2024-01-01",
            "2024-06-30",
            "2025-08-01",
            "q2-filing",
            "10-Q",
            "Q2",
            50.0,
            8.0,
            8.0,
        );

        let snapshot = facts.latest_fcf_with_per_share("USD").unwrap();
        let expected_shares = (10.0 * 366.0 + 12.0 * 181.0 - 8.0 * 182.0) / 365.0;

        assert_eq!(snapshot.start, NaiveDate::from_ymd_opt(2024, 7, 1).unwrap());
        assert_eq!(snapshot.end, NaiveDate::from_ymd_opt(2025, 6, 30).unwrap());
        assert_eq!(snapshot.as_of, NaiveDate::from_ymd_opt(2025, 8, 1).unwrap());
        assert_eq!(snapshot.fcf, 118.0);
        assert!((snapshot.diluted_shares - expected_shares).abs() < 1e-12);
        assert!((snapshot.fcf_per_share - 118.0 / expected_shares).abs() < 1e-12);
        assert_eq!(snapshot.unit, "USD");
        assert_eq!(
            snapshot.basis,
            FcfBasis::TtmBridge {
                annual_accession: "annual-filing".to_string(),
                quarter_accession: "q2-filing".to_string(),
            }
        );
        let serialized = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(serialized["basis"]["kind"], "ttm_bridge");
        assert_eq!(serialized["basis"]["annual_accession"], "annual-filing");
        assert_eq!(serialized["basis"]["quarter_accession"], "q2-filing");
    }

    #[test]
    fn latest_fcf_falls_back_to_latest_complete_annual() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);

        let snapshot = facts.latest_fcf_with_per_share("USD").unwrap();

        assert_eq!(snapshot.start, NaiveDate::from_ymd_opt(2024, 1, 1).unwrap());
        assert_eq!(snapshot.end, NaiveDate::from_ymd_opt(2024, 12, 31).unwrap());
        assert_eq!(snapshot.fcf, 100.0);
        assert_eq!(snapshot.diluted_shares, 10.0);
        assert_eq!(snapshot.fcf_per_share, 10.0);
        assert_eq!(
            snapshot.basis,
            FcfBasis::AnnualFallback {
                accession: "annual-filing".to_string(),
            }
        );
    }

    #[test]
    fn latest_fcf_rejects_mixed_accession_quarter_data() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);
        push_fcf_context(
            &mut facts,
            "2025-01-01",
            "2025-06-30",
            "2025-08-01",
            "q2-filing",
            "10-Q",
            "Q2",
            70.0,
            10.0,
            12.0,
        );
        facts.push(fact(FactSpec {
            metric: Metric::OperatingCashFlow,
            tag: OCF,
            value: 50.0,
            start: "2024-01-01",
            end: "2024-06-30",
            filed: "2025-08-01",
            accession: "q2-filing",
            form: "10-Q",
            fiscal_period: "Q2",
        }));
        facts.push(fact(FactSpec {
            metric: Metric::Capex,
            tag: CAPEX,
            value: 8.0,
            start: "2024-01-01",
            end: "2024-06-30",
            filed: "2025-08-02",
            accession: "different-filing",
            form: "10-Q",
            fiscal_period: "Q2",
        }));
        let mut prior_shares = fact(FactSpec {
            metric: Metric::DilutedShares,
            tag: DILUTED_SHARES,
            value: 8.0,
            start: "2024-01-01",
            end: "2024-06-30",
            filed: "2025-08-01",
            accession: "q2-filing",
            form: "10-Q",
            fiscal_period: "Q2",
        });
        prior_shares.unit = "shares".to_string();
        facts.push(prior_shares);

        let snapshot = facts.latest_fcf_with_per_share("USD").unwrap();

        assert!(matches!(snapshot.basis, FcfBasis::AnnualFallback { .. }));
        assert_eq!(snapshot.fcf, 100.0);
    }

    #[test]
    fn latest_fcf_uses_latest_complete_quarter_candidate() {
        let mut facts = CompanyFacts::new(sec_tags);
        push_annual_fcf_context(&mut facts);

        for (start, end, filed, accession, fiscal_period, current, prior) in [
            (
                "2025-01-01",
                "2025-03-31",
                "2025-05-01",
                "q1-filing",
                "Q1",
                (35.0, 5.0, 11.0),
                (25.0, 4.0, 9.0),
            ),
            (
                "2025-01-01",
                "2025-06-30",
                "2025-08-01",
                "q2-filing",
                "Q2",
                (70.0, 10.0, 12.0),
                (50.0, 8.0, 8.0),
            ),
        ] {
            push_fcf_context(
                &mut facts,
                start,
                end,
                filed,
                accession,
                "10-Q",
                fiscal_period,
                current.0,
                current.1,
                current.2,
            );
            let prior_end = if fiscal_period == "Q1" {
                "2024-03-31"
            } else {
                "2024-06-30"
            };
            push_fcf_context(
                &mut facts,
                "2024-01-01",
                prior_end,
                filed,
                accession,
                "10-Q",
                fiscal_period,
                prior.0,
                prior.1,
                prior.2,
            );
        }

        // A newer but incomplete Q3 candidate must not displace the complete Q2 bridge.
        facts.push(fact(FactSpec {
            metric: Metric::OperatingCashFlow,
            tag: OCF,
            value: 95.0,
            start: "2025-01-01",
            end: "2025-09-30",
            filed: "2025-11-01",
            accession: "q3-incomplete",
            form: "10-Q",
            fiscal_period: "Q3",
        }));
        facts.push(fact(FactSpec {
            metric: Metric::OperatingCashFlow,
            tag: OCF,
            value: 75.0,
            start: "2024-01-01",
            end: "2024-09-30",
            filed: "2025-11-01",
            accession: "q3-incomplete",
            form: "10-Q",
            fiscal_period: "Q3",
        }));

        let snapshot = facts.latest_fcf_with_per_share("USD").unwrap();

        assert_eq!(snapshot.end, NaiveDate::from_ymd_opt(2025, 6, 30).unwrap());
        assert!(matches!(
            snapshot.basis,
            FcfBasis::TtmBridge {
                quarter_accession,
                ..
            } if quarter_accession == "q2-filing"
        ));
    }

    #[test]
    fn parses_sec_company_facts_and_calculates_fcf_per_share() {
        let json = r#"
        {
          "cik": 1,
          "entityName": "Example Inc.",
          "facts": {
            "us-gaap": {
              "NetCashProvidedByUsedInOperatingActivities": {
                "units": {
                  "USD": [{
                    "start": "2024-01-01",
                    "end": "2024-12-31",
                    "val": 100,
                    "accn": "filing-a",
                    "fy": 2024,
                    "fp": "FY",
                    "form": "10-K",
                    "filed": "2025-02-15"
                  }]
                }
              },
              "PaymentsToAcquirePropertyPlantAndEquipment": {
                "units": {
                  "USD": [{
                    "start": "2024-01-01",
                    "end": "2024-12-31",
                    "val": 20,
                    "accn": "filing-a",
                    "fy": 2024,
                    "fp": "FY",
                    "form": "10-K",
                    "filed": "2025-02-15"
                  }]
                }
              },
              "WeightedAverageNumberOfDilutedSharesOutstanding": {
                "units": {
                  "shares": [{
                    "start": "2024-01-01",
                    "end": "2024-12-31",
                    "val": 10,
                    "accn": "filing-a",
                    "fy": 2024,
                    "fp": "FY",
                    "form": "10-K",
                    "filed": "2025-02-15"
                  }]
                }
              }
            }
          }
        }
        "#;

        let sec_facts: SecCompanyFacts = serde_json::from_str(json).unwrap();
        let annual_fcf = sec_facts.into_company_facts().annual_fcf_with_per_share();

        assert_eq!(annual_fcf.len(), 1);
        assert_eq!(annual_fcf[0].fcf.value, 80.0);
        assert_eq!(annual_fcf[0].fcf_per_share.value, 8.0);
        assert_eq!(annual_fcf[0].fcf_per_share.unit, "USD/share");
    }
}
