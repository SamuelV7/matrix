use super::model::*;
use chrono::NaiveDate;
use std::collections::{BTreeMap, HashMap, HashSet, hash_map::Entry};

#[derive(Debug, Clone)]
struct MetricBridge {
    annual: Fact,
    current: Fact,
    prior: Fact,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DurationContext {
    start: NaiveDate,
    end: NaiveDate,
    filed: NaiveDate,
    accession: String,
    fiscal_year: i32,
    fiscal_period: String,
    form: String,
}

impl DurationContext {
    fn matches(&self, fact: &Fact) -> bool {
        self.start == fact.start
            && self.end == fact.end
            && self.fiscal_year == fact.fiscal_year
            && self.fiscal_period == fact.fiscal_period
            && self.matches_filing(fact)
    }

    fn matches_filing(&self, fact: &Fact) -> bool {
        self.filed == fact.filed && self.accession == fact.accession && self.form == fact.form
    }
}

impl From<&Fact> for DurationContext {
    fn from(fact: &Fact) -> Self {
        Self {
            start: fact.start,
            end: fact.end,
            filed: fact.filed,
            accession: fact.accession.clone(),
            fiscal_year: fact.fiscal_year,
            fiscal_period: fact.fiscal_period.clone(),
            form: fact.form.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FilingPeriodKey {
    context: DurationContext,
    unit: String,
    taxonomy: String,
}

impl From<&Fact> for FilingPeriodKey {
    fn from(fact: &Fact) -> Self {
        Self {
            context: DurationContext::from(fact),
            unit: fact.unit.clone(),
            taxonomy: fact
                .tag
                .split_once(':')
                .map_or("", |(ns, _)| ns)
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PeriodKey {
    start: NaiveDate,
    end: NaiveDate,
    unit: String,
}

impl From<&Fact> for PeriodKey {
    fn from(fact: &Fact) -> Self {
        Self {
            start: fact.start,
            end: fact.end,
            unit: fact.unit.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompanyFacts {
    pub(crate) facts_by_tag: HashMap<String, Vec<Fact>>,
    pub(crate) instant_facts_by_tag: HashMap<String, Vec<FinancialFact>>,
    metric_tags: fn(Metric) -> &'static [&'static str],
}

impl CompanyFacts {
    pub fn new(metric_tags: fn(Metric) -> &'static [&'static str]) -> Self {
        Self {
            facts_by_tag: HashMap::new(),
            instant_facts_by_tag: HashMap::new(),
            metric_tags,
        }
    }

    pub fn push(&mut self, fact: Fact) {
        self.facts_by_tag
            .entry(fact.tag.clone())
            .or_default()
            .push(fact);
    }

    pub fn annual_financial_periods(&self) -> Vec<FinancialPeriod> {
        // Income or CFO establishes a real annual duration. Capex and shares
        // never decide whether a company's financial statements exist.
        let mut anchors: HashMap<PeriodKey, (Fact, bool)> = HashMap::new();
        for metric in [Metric::OperatingCashFlow, Metric::Revenue] {
            for fact in self.select_annual_by_filing(metric).into_values() {
                if !fact.value.is_finite() || !is_currency(&fact.unit) || fact.filed < fact.end {
                    continue;
                }
                match anchors.entry(PeriodKey::from(&fact)) {
                    Entry::Vacant(entry) => {
                        entry.insert((fact, false));
                    }
                    Entry::Occupied(mut entry) => {
                        let (current, ambiguous) = entry.get_mut();
                        match (fact.filed, &fact.accession)
                            .cmp(&(current.filed, &current.accession))
                        {
                            std::cmp::Ordering::Greater => {
                                *current = fact;
                                *ambiguous = false;
                            }
                            std::cmp::Ordering::Equal => {
                                // CFO is the stable anchor when both statements
                                // share a filing; unrelated namespace revenue must
                                // not erase an otherwise valid cash-flow history.
                                if metric == current.metric {
                                    if !fact.has_same_filing_context(current)
                                        || fact.tag.split_once(':').map(|(ns, _)| ns)
                                            != current.tag.split_once(':').map(|(ns, _)| ns)
                                    {
                                        *ambiguous = true;
                                    }
                                } else if metric == Metric::OperatingCashFlow {
                                    *current = fact;
                                    *ambiguous = false;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        let mut cash_flows: HashMap<_, _> =
            Self::latest_annual_by_period(self.annual_cash_flows_by_filing())
                .into_iter()
                .map(|annual| (PeriodKey::from(&annual.fcf), annual))
                .collect();
        let mut periods = Vec::with_capacity(anchors.len());
        for (key, (anchor, ambiguous)) in anchors {
            if ambiguous {
                continue;
            }
            let mut period = FinancialPeriod {
                start: anchor.start,
                end: anchor.end,
                currency: anchor.unit.clone(),
                fiscal_year: anchor.fiscal_year,
                form: anchor.form.clone(),
                filed: anchor.filed,
                accession: anchor.accession.clone(),
                fundamentals: BTreeMap::new(),
                metrics: BTreeMap::new(),
                warnings: Vec::new(),
            };
            let mut blocked = HashSet::new();
            for &metric in Metric::reported() {
                let selected = match self.select_financial_fact(metric, &anchor) {
                    Ok(fact) => fact,
                    Err(()) => {
                        blocked.insert(metric);
                        period.warnings.push(format!(
                            "{} is unavailable: conflicting preferred-tag facts in the selected filing.",
                            metric.key(),
                        ));
                        None
                    }
                };
                if let Some(fact) = &selected
                    && (fact.accession != anchor.accession || fact.filed != anchor.filed)
                {
                    period.warnings.push(format!(
                        "{} uses annual filing {} ({}) for the same period; it is absent from anchor filing {}.",
                        metric.key(), fact.accession, fact.filed, anchor.accession,
                    ));
                }
                period
                    .fundamentals
                    .insert(metric.key().to_owned(), selected);
            }
            period.fundamentals.insert("fcf".to_owned(), None);
            period.fundamentals.insert("fcf_per_share".to_owned(), None);
            if let Some(annual) = cash_flows.remove(&key).filter(|annual| {
                annual
                    .operating_cash_flow
                    .tag
                    .split_once(':')
                    .map(|(ns, _)| ns)
                    == anchor.tag.split_once(':').map(|(ns, _)| ns)
            }) {
                if annual.fcf.accession != anchor.accession || annual.fcf.filed != anchor.filed {
                    period.warnings.push(format!(
                        "CFO, capex and FCF retain the latest complete same-filing pair from {} ({}), rather than mixing inputs from the newer anchor filing.",
                        annual.fcf.accession, annual.fcf.filed,
                    ));
                }
                for fact in [&annual.operating_cash_flow, &annual.capex, &annual.fcf] {
                    period
                        .fundamentals
                        .insert(fact.metric.key().to_owned(), Some(fact.into()));
                }
                if let Some(shares) = &annual.diluted_shares {
                    period
                        .fundamentals
                        .insert("diluted_shares".to_owned(), Some(shares.into()));
                }
                period.fundamentals.insert(
                    "fcf_per_share".to_owned(),
                    annual.fcf_per_share.as_ref().map(FinancialFact::from),
                );
                period.warnings.extend(annual.warnings);
            } else {
                period.warnings.push("FCF is unavailable: no unambiguous same-filing, same-duration, same-currency and same-taxonomy CFO/capex pair. Statement coverage does not imply cash-flow coverage.".to_owned());
            }
            period.derive_totals(&blocked);
            if period
                .fundamentals
                .get("total_debt")
                .and_then(Option::as_ref)
                .is_none()
            {
                period.warnings.push("Total debt is unavailable: no consolidated borrowing total or complete, non-overlapping same-filing components. Missing debt is not zero.".to_owned());
            }
            if period
                .fundamentals
                .values()
                .flatten()
                .any(|fact| fact.tag.contains("CapitalLease"))
            {
                period.warnings.push("Debt tags containing CapitalLease include finance/capital lease obligations. Separate operating lease liabilities are not added to borrowing debt.".to_owned());
            }
            if period
                .fundamentals
                .get("dividends_paid")
                .and_then(Option::as_ref)
                .is_some_and(|fact| fact.tag.ends_with("PaymentsOfDividendsCommonStock"))
            {
                period.warnings.push("Dividends paid covers common stock only; preferred dividends are not included in this reported tag.".to_owned());
            }
            for (key, tag, warning) in [
                (
                    "revenue",
                    "us-gaap:RevenuesNetOfInterestExpense",
                    "Revenue is reported net of interest expense, a financial-sector presentation; industrial revenue/margin comparisons may not be meaningful.",
                ),
                (
                    "revenue",
                    "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
                    "Revenue includes assessed taxes under the selected issuer tag.",
                ),
                (
                    "net_income",
                    "ifrs-full:ProfitLoss",
                    "Net income uses consolidated IFRS profit/loss, including noncontrolling interests; parent-attributable profit was unavailable.",
                ),
                (
                    "stock_issuance",
                    "us-gaap:ProceedsFromIssuanceOfCommonStock",
                    "Stock issuance covers reported common-stock proceeds; separately disclosed preferred stock and stock-plan proceeds are not assumed included.",
                ),
                (
                    "operating_expenses",
                    "ifrs-full:OperatingExpense",
                    "IFRS operating expense scope may include cost of sales; do not add it to cost of revenue without checking the filing.",
                ),
                (
                    "depreciation_amortization",
                    "us-gaap:DepreciationDepletionAndAmortization",
                    "Reported depreciation and amortization also includes depletion under this source tag.",
                ),
            ] {
                if period
                    .fundamentals
                    .get(key)
                    .and_then(Option::as_ref)
                    .is_some_and(|fact| fact.tag == tag)
                {
                    period.warnings.push(warning.to_owned());
                }
            }
            periods.push(period);
        }
        periods.sort_by(|left, right| {
            (left.end, left.start, &left.currency).cmp(&(right.end, right.start, &right.currency))
        });
        periods
    }

    fn select_financial_fact(
        &self,
        metric: Metric,
        anchor: &Fact,
    ) -> Result<Option<FinancialFact>, ()> {
        let taxonomy = anchor.tag.split_once(':').map(|(ns, _)| ns);
        let mut candidates = Vec::new();
        for &tag in (self.metric_tags)(metric) {
            if tag.split_once(':').map(|(ns, _)| ns) != taxonomy {
                continue;
            }
            if metric.is_instant() {
                if let Some(facts) = self.instant_facts_by_tag.get(tag) {
                    candidates.extend(
                        facts
                            .iter()
                            .filter(|fact| {
                                fact.end == anchor.end
                                    && fact.start.is_none()
                                    && fact.metric == metric.key()
                                    && metric.accepts_unit(&fact.unit, &anchor.unit)
                                    && is_annual_form(&fact.form)
                                    && fact.fiscal_period == "FY"
                                    && fact.filed >= fact.end
                            })
                            .cloned(),
                    );
                }
            } else if let Some(facts) = self.facts_by_tag.get(tag) {
                candidates.extend(
                    facts
                        .iter()
                        .filter(|fact| {
                            fact.metric == metric
                                && fact.start == anchor.start
                                && fact.end == anchor.end
                                && metric.accepts_unit(&fact.unit, &anchor.unit)
                                && fact.is_annual()
                                && fact.filed >= fact.end
                        })
                        .map(FinancialFact::from),
                );
            }
        }
        let preferred_filing = candidates.iter().any(|fact| {
            fact.accession == anchor.accession
                && fact.filed == anchor.filed
                && fact.form == anchor.form
        });
        let latest = if preferred_filing {
            Some((anchor.filed, anchor.accession.clone()))
        } else {
            candidates
                .iter()
                .map(|fact| (fact.filed, fact.accession.clone()))
                .max()
        };
        let Some((filed, accession)) = latest else {
            return Ok(None);
        };
        candidates.retain(|fact| fact.filed == filed && fact.accession == accession);
        // Input order is tag preference order. Ambiguity in that preferred
        // tag cannot be repaired by falling back to another tag or older filing.
        let Some(chosen) = candidates.first() else {
            return Ok(None);
        };
        if candidates
            .iter()
            .any(|fact| fact.tag == chosen.tag && fact != chosen)
        {
            return Err(());
        }
        if chosen.value.is_none() {
            return Err(());
        }
        Ok(Some(chosen.clone()))
    }

    #[cfg(test)]
    pub fn annual_fcf(&self) -> Vec<Fact> {
        self.annual_cash_flows()
            .into_iter()
            .map(|annual| annual.fcf)
            .collect()
    }

    #[cfg(test)]
    pub fn annual_cash_flows(&self) -> Vec<AnnualCashFlow> {
        let mut annuals = Self::latest_annual_by_period(self.annual_cash_flows_by_filing());
        if annuals.is_empty() {
            return annuals;
        }
        // Attach optional inputs only after choosing the cash-flow periods, so
        // their availability or ambiguity never changes FCF filing selection.
        let mut revenue = self.select_annual_by_filing(Metric::Revenue);
        let mut gross_profit = self.select_annual_by_filing(Metric::GrossProfit);
        let mut operating_income = self.select_annual_by_filing(Metric::OperatingIncome);
        let mut net_income = self.select_annual_by_filing(Metric::NetIncome);
        for annual in &mut annuals {
            let key = FilingPeriodKey::from(&annual.operating_cash_flow);
            annual.revenue = revenue.remove(&key).filter(|fact| fact.value.is_finite());
            annual.gross_profit = gross_profit
                .remove(&key)
                .filter(|fact| fact.value.is_finite());
            annual.operating_income = operating_income
                .remove(&key)
                .filter(|fact| fact.value.is_finite());
            annual.net_income = net_income
                .remove(&key)
                .filter(|fact| fact.value.is_finite());
        }
        annuals
    }

    pub fn annual_fcf_with_per_share(&self) -> Vec<AnnualFcf> {
        // Preserve the TTM contract: choose the latest complete three-fact
        // filing, while public financial statements never require shares.
        Self::latest_annual_by_period(
            self.annual_cash_flows_by_filing()
                .into_iter()
                .filter(|annual| annual.fcf_per_share.is_some()),
        )
        .into_iter()
        .filter_map(|annual| {
            Some(AnnualFcf {
                fcf: annual.fcf,
                diluted_shares: annual.diluted_shares?,
                fcf_per_share: annual.fcf_per_share?,
            })
        })
        .collect()
    }

    pub fn latest_fcf_with_per_share(&self, currency_unit: &str) -> Option<FcfSnapshot> {
        let annual = self
            .annual_fcf_with_per_share()
            .into_iter()
            .filter(|annual| annual.fcf.unit == currency_unit)
            .max_by(|left, right| {
                left.fcf
                    .end
                    .cmp(&right.fcf.end)
                    .then_with(|| left.fcf.filed.cmp(&right.fcf.filed))
                    .then_with(|| left.fcf.accession.cmp(&right.fcf.accession))
            })?;

        for quarter in self.quarter_contexts_after(&annual, currency_unit) {
            if let Some(snapshot) = self.ttm_snapshot(&annual, &quarter, currency_unit) {
                return Some(snapshot);
            }
        }

        Some(FcfSnapshot {
            start: annual.fcf.start,
            end: annual.fcf.end,
            as_of: annual.fcf.filed,
            fcf: annual.fcf.value,
            diluted_shares: annual.diluted_shares.value,
            fcf_per_share: annual.fcf_per_share.value,
            unit: annual.fcf.unit.clone(),
            basis: FcfBasis::AnnualFallback {
                accession: annual.fcf.accession,
            },
        })
    }

    fn quarter_contexts_after(
        &self,
        annual: &AnnualFcf,
        currency_unit: &str,
    ) -> Vec<DurationContext> {
        let Some(expected_start) = annual.fcf.end.succ_opt() else {
            return Vec::new();
        };
        let mut contexts = Vec::new();

        for tag in (self.metric_tags)(Metric::OperatingCashFlow) {
            let Some(facts) = self.facts_by_tag.get(*tag) else {
                continue;
            };

            contexts.extend(
                facts
                    .iter()
                    .filter(|fact| {
                        fact.metric == Metric::OperatingCashFlow
                            && fact.unit == currency_unit
                            && fact.start == expected_start
                            && fact.end > annual.fcf.end
                            && fact.filed >= annual.fcf.filed
                            && matches!(fact.form.as_str(), "10-Q" | "10-Q/A")
                            && matches!(fact.fiscal_period.as_str(), "Q1" | "Q2" | "Q3")
                    })
                    .map(DurationContext::from),
            );
        }

        contexts.sort_by(|left, right| {
            right
                .end
                .cmp(&left.end)
                .then_with(|| right.filed.cmp(&left.filed))
                .then_with(|| {
                    quarter_form_priority(&right.form).cmp(&quarter_form_priority(&left.form))
                })
                .then_with(|| right.accession.cmp(&left.accession))
        });
        let mut seen = HashSet::new();
        contexts.retain(|context| seen.insert(context.clone()));
        contexts
    }

    fn ttm_snapshot(
        &self,
        annual: &AnnualFcf,
        current_context: &DurationContext,
        currency_unit: &str,
    ) -> Option<FcfSnapshot> {
        let annual_context = DurationContext::from(&annual.fcf);
        let operating_cash_flow = self.select_operating_cash_flow_bridge(
            &annual_context,
            current_context,
            currency_unit,
        )?;
        let prior_context = DurationContext::from(&operating_cash_flow.prior);
        let capex = self.select_metric_bridge(
            Metric::Capex,
            &annual_context,
            current_context,
            &prior_context,
            currency_unit,
        )?;
        let diluted_shares = self.select_metric_bridge(
            Metric::DilutedShares,
            &annual_context,
            current_context,
            &prior_context,
            "shares",
        )?;

        let annual_days = inclusive_duration_days(annual_context.start, annual_context.end)?;
        let current_days = inclusive_duration_days(current_context.start, current_context.end)?;
        let prior_days = inclusive_duration_days(prior_context.start, prior_context.end)?;
        let ttm_days = annual_days
            .checked_add(current_days)?
            .checked_sub(prior_days)?;

        if !(MIN_ANNUAL_DAYS..=MAX_ANNUAL_DAYS).contains(&ttm_days)
            || [
                diluted_shares.annual.value,
                diluted_shares.current.value,
                diluted_shares.prior.value,
            ]
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return None;
        }

        let ttm_operating_cash_flow = operating_cash_flow.annual.value
            + operating_cash_flow.current.value
            - operating_cash_flow.prior.value;
        let ttm_capex = capex.annual.value + capex.current.value - capex.prior.value;
        let fcf = ttm_operating_cash_flow - ttm_capex;
        let weighted_share_days = diluted_shares.annual.value * annual_days as f64
            + diluted_shares.current.value * current_days as f64
            - diluted_shares.prior.value * prior_days as f64;
        let shares = weighted_share_days / ttm_days as f64;
        let fcf_per_share = fcf / shares;

        if !fcf.is_finite() || !shares.is_finite() || shares <= 0.0 || !fcf_per_share.is_finite() {
            return None;
        }

        Some(FcfSnapshot {
            start: prior_context.end.succ_opt()?,
            end: current_context.end,
            as_of: current_context.filed.max(annual.fcf.filed),
            fcf,
            diluted_shares: shares,
            fcf_per_share,
            unit: currency_unit.to_string(),
            basis: FcfBasis::TtmBridge {
                annual_accession: annual.fcf.accession.clone(),
                quarter_accession: current_context.accession.clone(),
            },
        })
    }

    fn select_operating_cash_flow_bridge(
        &self,
        annual_context: &DurationContext,
        current_context: &DurationContext,
        currency_unit: &str,
    ) -> Option<MetricBridge> {
        let annual_days = inclusive_duration_days(annual_context.start, annual_context.end)?;
        let current_days = inclusive_duration_days(current_context.start, current_context.end)?;

        if current_days >= annual_days {
            return None;
        }

        for tag in (self.metric_tags)(Metric::OperatingCashFlow) {
            let Some(annual) = self.unique_fact_in_context(
                Metric::OperatingCashFlow,
                tag,
                currency_unit,
                annual_context,
            ) else {
                continue;
            };
            let Some(current) = self.unique_fact_in_context(
                Metric::OperatingCashFlow,
                tag,
                currency_unit,
                current_context,
            ) else {
                continue;
            };
            let Some(prior) = self.unique_fact_matching(tag, |fact| {
                if fact.metric != Metric::OperatingCashFlow
                    || fact.unit != currency_unit
                    || fact.start != annual_context.start
                    || fact.end >= annual_context.end
                    || !current_context.matches_filing(fact)
                {
                    return false;
                }

                let Some(prior_days) = inclusive_duration_days(fact.start, fact.end) else {
                    return false;
                };
                let Some(ttm_days) = annual_days
                    .checked_add(current_days)
                    .and_then(|days| days.checked_sub(prior_days))
                else {
                    return false;
                };

                prior_days < annual_days
                    && (current_days - prior_days).abs() <= MAX_COMPARATIVE_DURATION_DELTA_DAYS
                    && (MIN_ANNUAL_DAYS..=MAX_ANNUAL_DAYS).contains(&ttm_days)
            }) else {
                continue;
            };

            if [annual.value, current.value, prior.value]
                .iter()
                .all(|value| value.is_finite())
            {
                return Some(MetricBridge {
                    annual,
                    current,
                    prior,
                });
            }
        }

        None
    }

    fn select_metric_bridge(
        &self,
        metric: Metric,
        annual_context: &DurationContext,
        current_context: &DurationContext,
        prior_context: &DurationContext,
        unit: &str,
    ) -> Option<MetricBridge> {
        for tag in (self.metric_tags)(metric) {
            let Some(annual) = self.unique_fact_in_context(metric, tag, unit, annual_context)
            else {
                continue;
            };
            let Some(current) = self.unique_fact_in_context(metric, tag, unit, current_context)
            else {
                continue;
            };
            let Some(prior) = self.unique_fact_in_context(metric, tag, unit, prior_context) else {
                continue;
            };

            if [annual.value, current.value, prior.value]
                .iter()
                .all(|value| value.is_finite())
            {
                return Some(MetricBridge {
                    annual,
                    current,
                    prior,
                });
            }
        }

        None
    }

    fn unique_fact_in_context(
        &self,
        metric: Metric,
        tag: &str,
        unit: &str,
        context: &DurationContext,
    ) -> Option<Fact> {
        self.unique_fact_matching(tag, |fact| {
            fact.metric == metric && fact.unit == unit && context.matches(fact)
        })
    }

    fn unique_fact_matching(
        &self,
        tag: &str,
        mut predicate: impl FnMut(&Fact) -> bool,
    ) -> Option<Fact> {
        let mut matching = self
            .facts_by_tag
            .get(tag)?
            .iter()
            .filter(|fact| predicate(fact));
        let fact = matching.next()?.clone();

        if matching.any(|candidate| candidate != &fact) {
            return None;
        }

        Some(fact)
    }

    fn annual_cash_flows_by_filing(&self) -> Vec<AnnualCashFlow> {
        let operating_cash_flow = self.select_annual_by_filing(Metric::OperatingCashFlow);
        let capex = self.select_annual_by_filing(Metric::Capex);
        let shares = self.select_annual_by_filing(Metric::DilutedShares);
        let mut annuals = Vec::new();

        for (mut key, operating_cash_flow) in operating_cash_flow {
            let Some(capex) = capex.get(&key) else {
                continue;
            };
            let Some(fcf) = Fact::derive_fcf(&operating_cash_flow, capex) else {
                continue;
            };
            key.unit = "shares".to_string();
            let diluted_shares = shares
                .get(&key)
                .filter(|fact| fact.value.is_finite() && fact.value > 0.0)
                .cloned();
            let fcf_per_share = diluted_shares
                .as_ref()
                .and_then(|shares| Fact::derive_fcf_per_share(&fcf, shares));
            let mut warnings = Vec::new();
            if operating_cash_flow.tag
                == "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
            {
                warnings.push("Operating cash flow covers continuing operations only, not total operating cash flow.".to_string());
            }
            if capex.tag == "us-gaap:PaymentsToAcquireProductiveAssets" {
                warnings.push("Capex uses productive assets, which can include software and intangible assets beyond property, plant and equipment.".to_string());
            }
            if fcf_per_share.is_none() {
                warnings.push("FCF per share is unavailable: no valid same-filing, same-duration diluted shares or finite per-share result.".to_string());
            }
            if matches!(fcf.form.as_str(), "20-F" | "20-F/A" | "40-F" | "40-F/A") {
                warnings.push("Diluted reported shares are not adjusted for ADR ratios; FCF per share is not FCF per ADR.".to_string());
            }
            annuals.push(AnnualCashFlow {
                fcf,
                operating_cash_flow,
                capex: capex.clone(),
                revenue: None,
                gross_profit: None,
                operating_income: None,
                net_income: None,
                diluted_shares,
                fcf_per_share,
                warnings,
            });
        }
        annuals
    }

    fn latest_annual_by_period(
        annuals: impl IntoIterator<Item = AnnualCashFlow>,
    ) -> Vec<AnnualCashFlow> {
        let mut latest: HashMap<PeriodKey, (AnnualCashFlow, bool)> = HashMap::new();
        for annual in annuals {
            match latest.entry(PeriodKey::from(&annual.fcf)) {
                Entry::Vacant(entry) => {
                    entry.insert((annual, false));
                }
                Entry::Occupied(mut entry) => {
                    let (current, ambiguous) = entry.get_mut();
                    match (annual.fcf.filed, &annual.fcf.accession)
                        .cmp(&(current.fcf.filed, &current.fcf.accession))
                    {
                        std::cmp::Ordering::Greater => {
                            *current = annual;
                            *ambiguous = false;
                        }
                        std::cmp::Ordering::Equal if annual != *current => {
                            *ambiguous = true;
                        }
                        _ => {}
                    }
                }
            }
        }
        let mut annuals: Vec<_> = latest
            .into_values()
            .filter_map(|(annual, ambiguous)| (!ambiguous).then_some(annual))
            .collect();
        annuals.sort_by(|left, right| {
            left.fcf
                .end
                .cmp(&right.fcf.end)
                .then_with(|| left.fcf.start.cmp(&right.fcf.start))
                .then_with(|| left.fcf.unit.cmp(&right.fcf.unit))
                .then_with(|| left.fcf.filed.cmp(&right.fcf.filed))
                .then_with(|| left.fcf.accession.cmp(&right.fcf.accession))
        });
        annuals
    }

    fn select_annual_by_filing(&self, metric: Metric) -> HashMap<FilingPeriodKey, Fact> {
        let mut selected: HashMap<FilingPeriodKey, (usize, Option<Fact>)> = HashMap::new();
        // Tags are ordered by economic preference. An ambiguous preferred tag
        // blocks the context instead of silently choosing a differing fallback.
        for (priority, tag) in (self.metric_tags)(metric).iter().enumerate() {
            let Some(facts) = self.facts_by_tag.get(*tag) else {
                continue;
            };
            for fact in facts
                .iter()
                .filter(|fact| fact.metric == metric && fact.is_annual())
            {
                match selected.entry(FilingPeriodKey::from(fact)) {
                    Entry::Vacant(entry) => {
                        entry.insert((priority, Some(fact.clone())));
                    }
                    Entry::Occupied(mut entry) => {
                        let (chosen_priority, chosen) = entry.get_mut();
                        if priority == *chosen_priority
                            && chosen.as_ref().is_some_and(|previous| previous != fact)
                        {
                            *chosen = None;
                        }
                    }
                }
            }
        }
        selected
            .into_iter()
            .filter_map(|(key, (_, fact))| fact.map(|fact| (key, fact)))
            .collect()
    }
}

fn inclusive_duration_days(start: NaiveDate, end: NaiveDate) -> Option<i64> {
    let days = end.signed_duration_since(start).num_days().checked_add(1)?;
    (days > 0).then_some(days)
}

fn quarter_form_priority(form: &str) -> u8 {
    u8::from(form == "10-Q/A")
}
