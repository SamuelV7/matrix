use crate::ApiError;
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
pub(crate) use stockpricer_core::SecCompanyFacts as CompanyFacts;

const MAX_OBSERVATIONS: usize = 48;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Identifier {
    Ticker(String),
    Cik(u64),
}

impl Identifier {
    pub(crate) fn parse(input: &str) -> Result<Self, ApiError> {
        let input = input.trim();
        if input
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cik:"))
        {
            return parse_cik(&input[4..]).map(Self::Cik);
        }
        if !input.is_empty() && input.bytes().all(|byte| byte.is_ascii_digit()) {
            return parse_cik(input).map(Self::Cik);
        }
        normalize_ticker(input).map(Self::Ticker)
    }
}

fn parse_cik(input: &str) -> Result<u64, ApiError> {
    if input.is_empty() || input.len() > 10 || !input.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::invalid());
    }
    input
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(ApiError::invalid)
}

fn normalize_ticker(input: &str) -> Result<String, ApiError> {
    let bytes = input.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 20
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'-'))
    {
        return Err(ApiError::invalid());
    }
    Ok(input.to_ascii_uppercase())
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum SecNumber {
    Number(u64),
    Text(String),
}

impl SecNumber {
    pub(crate) fn value(&self) -> u64 {
        match self {
            Self::Number(value) => *value,
            Self::Text(text) => parse_cik(text).unwrap_or(0),
        }
    }

    fn text(self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::Text(text) => text,
        }
    }
}

pub(crate) trait SecPayload: serde::de::DeserializeOwned + Send + 'static {
    fn valid(&self, expected_cik: Option<u64>) -> bool;
}

#[derive(Debug, Deserialize)]
pub(crate) struct TickerEntry {
    pub(crate) cik_str: SecNumber,
    pub(crate) ticker: String,
}

pub(crate) type Tickers = HashMap<String, TickerEntry>;

impl SecPayload for Tickers {
    fn valid(&self, _: Option<u64>) -> bool {
        // SEC includes directory-only symbols such as "NONE."; request grammar
        // must not reject an unrelated issuer's valid directory entry.
        !self.is_empty()
            && self
                .values()
                .all(|entry| (1..=9_999_999_999).contains(&entry.cik_str.value()))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Submissions {
    cik: SecNumber,
    name: String,
    #[serde(default)]
    tickers: Vec<String>,
    #[serde(default)]
    exchanges: Vec<String>,
    sic: Option<SecNumber>,
    sic_description: Option<String>,
    fiscal_year_end: Option<String>,
    #[serde(default)]
    filings: SubmissionFilings,
}

impl SecPayload for Submissions {
    fn valid(&self, expected_cik: Option<u64>) -> bool {
        expected_cik.is_some_and(|cik| cik == self.cik.value()) && !self.name.trim().is_empty()
    }
}

#[derive(Debug, Default, Deserialize)]
struct SubmissionFilings {
    #[serde(default)]
    recent: RecentFilings,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFilings {
    #[serde(default)]
    accession_number: Vec<String>,
    #[serde(default)]
    filing_date: Vec<String>,
    #[serde(default)]
    report_date: Vec<String>,
    #[serde(default)]
    form: Vec<String>,
    #[serde(default)]
    primary_document: Vec<String>,
}

// The decoder and financial statement selection are reused from stockpricer.

impl SecPayload for CompanyFacts {
    fn valid(&self, expected_cik: Option<u64>) -> bool {
        expected_cik.is_some_and(|cik| cik == self.cik)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanyResponse {
    company: Company,
    filings: Vec<Filing>,
    metrics: Vec<Metric>,
    sources: Vec<Source>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Company {
    cik: String,
    name: String,
    tickers: Vec<String>,
    exchanges: Vec<String>,
    sic: Option<String>,
    industry: Option<String>,
    fiscal_year_end: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Filing {
    form: String,
    filed: NaiveDate,
    report_date: Option<NaiveDate>,
    accession: String,
    document: String,
    url: String,
}

#[derive(Debug, Serialize)]
struct Metric {
    id: &'static str,
    label: &'static str,
    description: String,
    unit: &'static str,
    observations: Vec<Observation>,
}

#[derive(Debug, Serialize)]
struct Observation {
    start: Option<NaiveDate>,
    end: NaiveDate,
    value: f64,
    filed: NaiveDate,
    form: String,
    accession: String,
    tag: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    label: &'static str,
    url: String,
    fetched_at: String,
}

impl Source {
    pub(crate) fn new(label: &'static str, url: String, fetched_at: DateTime<Utc>) -> Self {
        Self {
            label,
            url,
            fetched_at: fetched_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        }
    }
}

struct MetricSpec {
    id: &'static str,
    label: &'static str,
    key: &'static str,
}

const METRICS: &[MetricSpec] = &[
    MetricSpec {
        id: "revenue",
        label: "Revenue",
        key: "revenue",
    },
    MetricSpec {
        id: "netIncome",
        label: "Net income",
        key: "net_income",
    },
    MetricSpec {
        id: "operatingCashFlow",
        label: "Operating cash flow",
        key: "operating_cash_flow",
    },
    MetricSpec {
        id: "capex",
        label: "Capital expenditures",
        key: "capex",
    },
    MetricSpec {
        id: "assets",
        label: "Assets",
        key: "total_assets",
    },
    MetricSpec {
        id: "liabilities",
        label: "Liabilities",
        key: "total_liabilities",
    },
];

fn valid_accession(accession: &str) -> bool {
    accession.len() == 20
        && accession.bytes().enumerate().all(|(index, byte)| {
            if index == 10 || index == 13 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

fn safe_document(document: &str) -> bool {
    !document.is_empty()
        && document.len() <= 255
        && document.as_bytes()[0].is_ascii_alphanumeric()
        && !document.contains("..")
        && document
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn filing_url(cik: u64, accession: &str, document: Option<&str>) -> Option<String> {
    if !(1..=9_999_999_999).contains(&cik) || !valid_accession(accession) {
        return None;
    }
    let directory: String = accession
        .chars()
        .filter(|character| *character != '-')
        .collect();
    let base = format!("https://www.sec.gov/Archives/edgar/data/{cik}/{directory}/");
    match document {
        Some(document) if safe_document(document) => Some(format!("{base}{document}")),
        Some(_) => None,
        None => Some(format!("{base}{accession}-index.html")),
    }
}

fn recent_filings(cik: u64, recent: RecentFilings, warnings: &mut Vec<String>) -> Vec<Filing> {
    let count = recent.accession_number.len();
    if [
        recent.filing_date.len(),
        recent.form.len(),
        recent.primary_document.len(),
    ]
    .into_iter()
    .any(|length| length != count)
        || (!recent.report_date.is_empty() && recent.report_date.len() != count)
    {
        warnings.push(
            "SEC recent filing arrays are inconsistent; unsafe or incomplete entries were omitted."
                .to_owned(),
        );
    }
    let mut indices: Vec<_> = (0..count).collect();
    indices.sort_unstable_by(|left, right| {
        (
            recent.filing_date.get(*right),
            &recent.accession_number[*right],
        )
            .cmp(&(
                recent.filing_date.get(*left),
                &recent.accession_number[*left],
            ))
    });
    let mut filings = Vec::with_capacity(30.min(count));
    let mut seen = HashSet::new();
    let mut skipped = false;
    for index in indices {
        let accession = &recent.accession_number[index];
        let entry = (|| {
            let document = recent.primary_document.get(index)?;
            let form = recent.form.get(index)?;
            let filed = recent.filing_date.get(index)?.parse::<NaiveDate>().ok()?;
            let report_date = match recent.report_date.get(index).map(String::as_str) {
                Some("") | None => None,
                Some(date) => Some(date.parse::<NaiveDate>().ok()?),
            };
            if form.trim().is_empty() {
                return None;
            }
            let url = filing_url(cik, accession, Some(document))?;
            Some(Filing {
                form: form.clone(),
                filed,
                report_date,
                accession: accession.clone(),
                document: document.clone(),
                url,
            })
        })();
        match entry {
            Some(filing) if seen.insert((accession, &recent.primary_document[index])) => {
                filings.push(filing)
            }
            Some(_) => {}
            None => skipped = true,
        }
        if filings.len() == 30 {
            break;
        }
    }
    if skipped {
        warnings.push("Some SEC filing entries had invalid dates, accessions or document names and were omitted.".to_owned());
    }
    if filings.is_empty() {
        warnings.push("No recent filings with safe SEC archive links were available.".to_owned());
    }
    filings
}

fn financial_metrics(cik: u64, facts: CompanyFacts, warnings: &mut Vec<String>) -> Vec<Metric> {
    let periods = stockpricer_core::annual_financial_periods(facts);
    let mut histories: [Vec<Observation>; 6] = std::array::from_fn(|_| Vec::new());
    let mut period_warnings = std::collections::BTreeSet::new();
    let mut other_currencies = false;
    for mut period in periods {
        if period.currency != "USD" {
            other_currencies = true;
            continue;
        }
        period_warnings.extend(period.warnings);
        for (index, spec) in METRICS.iter().enumerate() {
            let Some(fact) = period.fundamentals.remove(spec.key).flatten() else {
                continue;
            };
            let Some(value) = fact.value.filter(|value| value.is_finite()) else {
                continue;
            };
            // This first workspace shows reported values only, not stockpricer's derived totals.
            if fact.unit != "USD" || fact.tag.starts_with("derived:") {
                continue;
            }
            let Some(url) = filing_url(cik, &fact.accession, None) else {
                period_warnings.insert(
                    "An observation had an invalid filing accession and was omitted.".to_owned(),
                );
                continue;
            };
            histories[index].push(Observation {
                start: fact.start,
                end: fact.end,
                value,
                filed: fact.filed,
                form: fact.form,
                accession: fact.accession,
                tag: fact.tag,
                url,
            });
        }
    }
    warnings.extend(period_warnings);
    if other_currencies {
        warnings.push("Additional reporting currencies are available in the source facts; this workspace currently displays USD only and performs no FX conversion.".to_owned());
    }
    METRICS.iter().zip(histories).filter_map(|(spec, mut observations)| {
        observations.sort_by(|left, right| (left.end, left.filed, &left.accession).cmp(&(right.end, right.filed, &right.accession)));
        if observations.len() > MAX_OBSERVATIONS {
            observations.drain(..observations.len() - MAX_OBSERVATIONS);
            warnings.push(format!("{} history is limited to the {MAX_OBSERVATIONS} most recent annual periods.", spec.label));
        }
        if observations.is_empty() {
            warnings.push(format!("No supported unambiguous annual USD observations are available for {}. Missing values are not zero.", spec.label));
            return None;
        }
        Some(Metric {
            id: spec.id, label: spec.label, unit: "USD", observations,
            description: format!("Reported {} selected by stockpricer's filing-consistent annual statement engine. Each observation retains its exact SEC taxonomy tag and filing context. No FX conversion or derived values.", spec.label.to_lowercase()),
        })
    }).collect()
}

pub(crate) fn company_response(
    cik: u64,
    submissions: Submissions,
    facts: Option<CompanyFacts>,
    sources: Vec<Source>,
) -> Result<CompanyResponse, ApiError> {
    if !submissions.valid(Some(cik)) || facts.as_ref().is_some_and(|facts| !facts.valid(Some(cik)))
    {
        return Err(ApiError::upstream());
    }
    let mut warnings = vec![
        "SEC filings and XBRL company facts are reported historical disclosures, not live prices or investment advice; reporting can lag the present.".to_owned(),
        "Only supported standard-taxonomy USD annual facts are shown. Quarterly, trailing-twelve-month, issuer-extension and derived values are not inferred; missing values are omitted, not zero.".to_owned(),
        "Annual statement selection reuses stockpricer: latest supported filing contexts are selected per period, currency and taxonomy. Exact source tags remain attached to each fact; missing or ambiguous values are never zero. Numbers use JSON floating-point precision and SEC-reported signs.".to_owned(),
    ];
    let filings = recent_filings(cik, submissions.filings.recent, &mut warnings);
    let metrics = match facts {
        Some(facts) => financial_metrics(cik, facts, &mut warnings),
        None => {
            warnings.push("SEC company facts are unavailable for this CIK; no financial observations were invented.".to_owned());
            Vec::new()
        }
    };
    let sic = submissions.sic.map(SecNumber::text).and_then(|sic| {
        (!sic.is_empty()
            && sic.len() <= 4
            && sic.bytes().all(|byte| byte.is_ascii_digit())
            && sic.parse::<u16>().is_ok_and(|value| value > 0))
        .then(|| format!("{sic:0>4}"))
    });
    let fiscal_year_end = submissions.fiscal_year_end.filter(|value| {
        value.len() == 4 && NaiveDate::parse_from_str(&format!("2000{value}"), "%Y%m%d").is_ok()
    });
    let company = Company {
        cik: format!("{cik:010}"),
        name: submissions.name,
        tickers: submissions
            .tickers
            .into_iter()
            .filter_map(|ticker| normalize_ticker(&ticker).ok())
            .collect(),
        exchanges: submissions
            .exchanges
            .into_iter()
            .filter(|exchange| !exchange.trim().is_empty())
            .collect(),
        sic,
        industry: submissions
            .sic_description
            .filter(|value| !value.trim().is_empty()),
        fiscal_year_end,
    };
    Ok(CompanyResponse {
        company,
        filings,
        metrics,
        sources,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn date(value: &str) -> NaiveDate {
        value.parse().unwrap()
    }

    fn fact(value: f64, accession: &str) -> serde_json::Value {
        json!({"start":"2023-01-01", "end":"2023-12-31", "val":value, "accn":accession,
            "fy":2023, "fp":"FY", "form":"10-K", "filed":"2024-02-01"})
    }

    fn facts(revenue: Vec<serde_json::Value>) -> CompanyFacts {
        serde_json::from_value(
            json!({"cik":1,"entityName":"Example","facts":{"us-gaap":{"Revenues":{
                "description":"Reported revenue", "units":{"USD":revenue}
            }}}}),
        )
        .unwrap()
    }

    #[test]
    fn identifiers_are_bounded_and_canonical() {
        assert_eq!(
            Identifier::parse(" aapl ").unwrap(),
            Identifier::Ticker("AAPL".into())
        );
        assert_eq!(
            Identifier::parse("brk.b").unwrap(),
            Identifier::Ticker("BRK.B".into())
        );
        assert_eq!(
            Identifier::parse("CIK:0000320193").unwrap(),
            Identifier::Cik(320193)
        );
        assert_eq!(
            Identifier::parse("320193").unwrap(),
            Identifier::Cik(320193)
        );
        for invalid in [
            "",
            "0",
            "0000000000",
            "12345678901",
            "cik:-1",
            "cik:1/",
            "A/B",
            "é",
            "..",
            "-A",
            "A-",
            "https://sec.gov",
        ] {
            assert!(Identifier::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn unrelated_directory_ticker_formats_do_not_block_company_lookup() {
        let directory: Tickers = serde_json::from_value(json!({
            "0": {"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."},
            "1": {"cik_str":1347123,"ticker":"NONE.","title":"EBR Systems, Inc."}
        }))
        .unwrap();
        assert!(directory.valid(None));
        let apple = directory
            .values()
            .find(|entry| entry.ticker == "AAPL")
            .unwrap();
        assert_eq!(apple.cik_str.value(), 320193);
    }

    #[test]
    fn reused_engine_omits_conflicting_source_values() {
        let metrics = financial_metrics(
            1,
            facts(vec![
                fact(100.0, "0000000001-24-000001"),
                fact(999.0, "0000000001-24-000001"),
            ]),
            &mut Vec::new(),
        );
        assert!(metrics.is_empty());
    }

    #[test]
    fn annual_instant_balances_need_same_filing_year_end_evidence() {
        let revenue = fact(100.0, "0000000001-24-000001");
        let mut annual = revenue.clone();
        annual.as_object_mut().unwrap().remove("start");
        let mut quarterly = annual.clone();
        quarterly["end"] = json!("2023-09-30");
        let facts: CompanyFacts =
            serde_json::from_value(json!({"cik":1,"entityName":"Example","facts":{"us-gaap":{
                "Revenues":{"units":{"USD":[revenue]}},
                "Assets":{"units":{"USD":[annual,quarterly]}}
            }}}))
            .unwrap();
        let metrics = financial_metrics(1, facts, &mut Vec::new());
        let assets = metrics.iter().find(|metric| metric.id == "assets").unwrap();
        assert_eq!(assets.observations.len(), 1);
        assert_eq!(assets.observations[0].start, None);
        assert_eq!(assets.observations[0].end, date("2023-12-31"));
    }

    #[test]
    fn archive_urls_cannot_escape_sec_or_the_filing_directory() {
        let accession = "0000320193-24-000123";
        assert_eq!(
            filing_url(320193, accession, Some("aapl-20240928.htm")).unwrap(),
            "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm"
        );
        assert!(
            filing_url(320193, accession, None)
                .unwrap()
                .ends_with("0000320193-24-000123-index.html")
        );
        for document in [
            "../a.htm",
            "https://evil.test/a",
            "a/b.htm",
            "a%2fb.htm",
            "a\\b.htm",
            "a.htm?x",
            "a.htm#x",
            "",
            ".hidden",
        ] {
            assert!(
                filing_url(320193, accession, Some(document)).is_none(),
                "{document}"
            );
        }
        assert!(filing_url(320193, "0000320193/24/000123", None).is_none());
        assert!(filing_url(0, accession, None).is_none());
    }

    #[test]
    fn observation_history_is_bounded_recent_and_chronological() {
        let history = (1940..2020)
            .map(|year| {
                json!({"start":format!("{year}-01-01"), "end":format!("{year}-12-31"),
                "val":year, "accn":format!("0000000001-24-{year:06}"), "fy":year, "fp":"FY",
                "form":"10-K", "filed":format!("{}-02-01", year + 1)})
            })
            .collect();
        let mut warnings = Vec::new();
        let metrics = financial_metrics(1, facts(history), &mut warnings);
        let observations = &metrics[0].observations;
        assert_eq!(observations.len(), MAX_OBSERVATIONS);
        assert_eq!(observations.first().unwrap().end, date("1972-12-31"));
        assert_eq!(observations.last().unwrap().end, date("2019-12-31"));
    }

    #[test]
    fn recent_filings_limit_thirty_after_safe_url_selection() {
        let recent = RecentFilings {
            accession_number: (0..40)
                .map(|index| format!("0000000001-24-{index:06}"))
                .collect(),
            filing_date: vec!["2024-02-01".to_owned(); 40],
            report_date: vec![String::new(); 40],
            form: vec!["10-K".to_owned(); 40],
            primary_document: (0..40)
                .map(|index| {
                    if index == 39 {
                        "../unsafe.htm".to_owned()
                    } else {
                        format!("report-{index}.htm")
                    }
                })
                .collect(),
        };
        let mut warnings = Vec::new();
        let filings = recent_filings(1, recent, &mut warnings);
        assert_eq!(filings.len(), 30);
        assert_eq!(filings[0].accession, "0000000001-24-000038");
        assert!(filings.iter().all(|filing| filing.report_date.is_none()));
    }

    #[test]
    fn cik_mismatch_is_rejected_and_missing_values_stay_null_or_absent() {
        let submissions: Submissions =
            serde_json::from_value(json!({"cik":1,"name":"Example"})).unwrap();
        assert!(!submissions.valid(Some(2)));
        let response = company_response(1, submissions, None, Vec::new()).unwrap();
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["company"]["cik"], "0000000001");
        assert!(json["company"]["sic"].is_null());
        assert_eq!(json["metrics"], json!([]));
        assert!(!facts(Vec::new()).valid(Some(2)));
    }
}
