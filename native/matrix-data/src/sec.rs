use crate::{
    ApiError,
    normalize::{CompanyFacts, SecPayload, Submissions, Tickers},
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
    time::Instant,
};

const TICKERS_URL: &str = "https://www.sec.gov/files/company_tickers.json";
const REQUEST_SPACING: Duration = Duration::from_millis(250);
const RATE_COOLDOWN: Duration = Duration::from_secs(60);
const TICKER_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const COMPANY_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = MAX_BODY_BYTES + 1024;

pub(crate) struct Fetched<T> {
    pub(crate) value: T,
    pub(crate) url: String,
    pub(crate) fetched_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    fetched_at: DateTime<Utc>,
    json: Box<RawValue>,
}

struct RequestClock {
    next_request: Instant,
    blocked: Option<(Instant, ApiError)>,
}

impl RequestClock {
    fn new() -> Self {
        Self {
            next_request: Instant::now() + REQUEST_SPACING,
            blocked: None,
        }
    }

    async fn wait(&mut self) -> Result<(), ApiError> {
        if let Some((until, error)) = &self.blocked {
            if *until > Instant::now() {
                return Err(error.clone());
            }
            self.blocked = None;
        }
        tokio::time::sleep_until(self.next_request).await;
        self.next_request = Instant::now() + REQUEST_SPACING;
        Ok(())
    }

    fn block(&mut self, error: ApiError) {
        self.blocked = Some((Instant::now() + RATE_COOLDOWN, error));
    }
}

pub(crate) struct SecClient {
    http: Client,
    cache_dir: PathBuf,
    // One gate deliberately serializes cache misses and the complete upstream
    // exchange. It prevents duplicate fetches and keeps all endpoints on one
    // SEC request clock; it is not a cross-process or deployment-wide limiter.
    requests: Mutex<RequestClock>,
}

impl SecClient {
    pub(crate) async fn new(
        user_agent: &str,
        cache_dir: PathBuf,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if !valid_user_agent(user_agent) {
            return Err("SEC_USER_AGENT must identify your application and a real contact email; example/placeholder contacts are not accepted".into());
        }
        fs::create_dir_all(&cache_dir).await?;
        let http = Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            http,
            cache_dir,
            requests: Mutex::new(RequestClock::new()),
        })
    }

    pub(crate) async fn tickers(&self) -> Result<Fetched<Tickers>, ApiError> {
        self.fetch(
            TICKERS_URL.to_owned(),
            "tickers.json".to_owned(),
            TICKER_TTL,
            None,
        )
        .await
    }

    pub(crate) async fn submissions(&self, cik: u64) -> Result<Fetched<Submissions>, ApiError> {
        self.fetch(
            format!("https://data.sec.gov/submissions/CIK{cik:010}.json"),
            format!("submissions-{cik:010}.json"),
            COMPANY_TTL,
            Some(cik),
        )
        .await
    }

    pub(crate) async fn facts(&self, cik: u64) -> Result<Fetched<CompanyFacts>, ApiError> {
        self.fetch(
            format!("https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010}.json"),
            format!("facts-{cik:010}.json"),
            COMPANY_TTL,
            Some(cik),
        )
        .await
    }

    async fn fetch<T: SecPayload>(
        &self,
        url: String,
        cache_key: String,
        ttl: Duration,
        expected_cik: Option<u64>,
    ) -> Result<Fetched<T>, ApiError> {
        let mut clock = self.requests.lock().await;
        let cache_path = self.cache_dir.join(cache_key);
        if let Some((value, fetched_at)) = cached::<T>(&cache_path, ttl, expected_cik).await? {
            return Ok(Fetched {
                value,
                fetched_at,
                url,
            });
        }
        clock.wait().await?;
        let mut response = self.http.get(&url).send().await.map_err(network_error)?;
        if let Some(error) = upstream_status(response.status()) {
            if matches!(
                response.status(),
                StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
            ) {
                clock.block(error.clone());
            }
            return Err(error);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
        {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "SEC_RESPONSE_TOO_LARGE",
                "SEC response exceeded the size limit.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if chunk.len() > MAX_BODY_BYTES - bytes.len() {
                return Err(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "SEC_RESPONSE_TOO_LARGE",
                    "SEC response exceeded the size limit.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let fetched_at = Utc::now();
        let (value, encoded) = tokio::task::spawn_blocking(move || {
            let value: T = serde_json::from_slice(&bytes).map_err(|_| ApiError::upstream())?;
            if !value.valid(expected_cik) {
                return Err(ApiError::upstream());
            }
            let entry = CacheEntry {
                fetched_at,
                json: serde_json::from_slice(&bytes).map_err(|_| ApiError::upstream())?,
            };
            let encoded = serde_json::to_vec(&entry).map_err(|_| ApiError::upstream())?;
            Ok((value, encoded))
        })
        .await
        .map_err(|_| ApiError::upstream())??;
        // Only validated, successful JSON reaches disk. A failed SEC request
        // never overwrites a successful entry, and expired data is not served as
        // an undisclosed fallback when SEC is unavailable.
        store(&cache_path, &encoded).await.map_err(storage_error)?;
        Ok(Fetched {
            value,
            fetched_at,
            url,
        })
    }
}

fn network_error(error: reqwest::Error) -> ApiError {
    eprintln!("SEC request failed: {error}");
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "SEC_UNAVAILABLE",
        "SEC could not be reached or the request timed out; retry later.",
    )
}

fn storage_error(error: io::Error) -> ApiError {
    eprintln!("SEC cache I/O failed: {error}");
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "SEC_CACHE_UNAVAILABLE",
        "The SEC data cache is unavailable.",
    )
}

fn upstream_status(status: StatusCode) -> Option<ApiError> {
    match status {
        StatusCode::OK => None,
        StatusCode::NOT_FOUND => Some(ApiError::new(
            StatusCode::NOT_FOUND,
            "SEC_NOT_FOUND",
            "SEC has no data at the requested company endpoint.",
        )),
        StatusCode::FORBIDDEN => Some(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SEC_FORBIDDEN",
            "SEC denied access. Verify SEC_USER_AGENT and SEC fair-access policy; retry after one minute.",
        )),
        StatusCode::TOO_MANY_REQUESTS => Some(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "SEC_RATE_LIMITED",
            "SEC rate limited requests; retry after one minute.",
        )),
        status if status.is_server_error() => Some(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "SEC_UPSTREAM_UNAVAILABLE",
            "SEC returned an upstream server error; retry later.",
        )),
        _ => Some(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "SEC_UPSTREAM_ERROR",
            "SEC returned an unexpected HTTP status; redirects are not followed.",
        )),
    }
}

async fn cached<T: SecPayload>(
    path: &Path,
    ttl: Duration,
    expected_cik: Option<u64>,
) -> Result<Option<(T, DateTime<Utc>)>, ApiError> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(storage_error(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CACHE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(storage_error)?;
    if bytes.len() > MAX_CACHE_BYTES {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        let entry: CacheEntry = match serde_json::from_slice(&bytes) {
            Ok(entry) => entry,
            Err(_) => return None,
        };
        let age = Utc::now()
            .signed_duration_since(entry.fetched_at)
            .to_std()
            .ok()?;
        if age >= ttl {
            return None;
        }
        let value: T = serde_json::from_str(entry.json.get()).ok()?;
        value
            .valid(expected_cik)
            .then_some((value, entry.fetched_at))
    })
    .await
    .map_err(|_| ApiError::upstream())
}

async fn store(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = async {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        drop(file);
        fs::rename(&temporary, path).await
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
}

fn valid_user_agent(value: &str) -> bool {
    if value.len() > 256
        || value.split_whitespace().count() < 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        return false;
    }
    value.split_whitespace().any(|part| {
        let part = part.trim_matches(['<', '>', '(', ')', ',', ';']);
        let Some((local, domain)) = part.split_once('@') else {
            return false;
        };
        let domain = domain.to_ascii_lowercase();
        !local.is_empty()
            && local.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
            })
            && domain.contains('.')
            && domain.split('.').all(|label| {
                !label.is_empty()
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            && !["example.com", "example.org", "example.net", "localhost"]
                .iter()
                .any(|reserved| domain == *reserved || domain.ends_with(&format!(".{reserved}")))
            && !domain.ends_with(".invalid")
            && !domain.ends_with(".test")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::State, response::IntoResponse, routing::get};
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    const TICKERS: &str = r#"{"0":{"cik_str":1,"ticker":"TEST","title":"Test company"}}"#;

    #[derive(Clone)]
    struct Mock {
        calls: Arc<AtomicUsize>,
        status: StatusCode,
        body: &'static str,
    }

    async fn mock(
        status: StatusCode,
        body: &'static str,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = Mock {
            calls: calls.clone(),
            status,
            body,
        };
        let router = Router::new()
            .route(
                "/data",
                get(|State(state): State<Mock>| async move {
                    state.calls.fetch_add(1, Ordering::SeqCst);
                    (state.status, state.body).into_response()
                }),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/data", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (url, calls, task)
    }

    async fn client(path: &Path) -> SecClient {
        // No network contact is made to this syntactically valid test address.
        SecClient::new(
            "Matrix regression-tests <sec@matrix.tools>",
            path.to_owned(),
        )
        .await
        .unwrap()
    }

    #[test]
    fn contact_identification_is_required_without_placeholder_contacts() {
        assert!(valid_user_agent("Matrix Research/0.1 analyst@matrix.tools"));
        for invalid in [
            "",
            "Matrix",
            "analyst@matrix.tools",
            "Matrix you@example.com",
            "Matrix x@y",
            "Matrix test@demo.invalid",
            "Matrix sec@matrix.tools\r\nInjected: yes",
        ] {
            assert!(!valid_user_agent(invalid), "{invalid}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn all_requests_share_spacing_and_rate_cooldown() {
        let mut clock = RequestClock::new();
        let start = Instant::now();
        clock.wait().await.unwrap();
        assert!(Instant::now().duration_since(start) >= REQUEST_SPACING);
        let first = Instant::now();
        clock.wait().await.unwrap();
        assert!(Instant::now().duration_since(first) >= REQUEST_SPACING);
        let error = upstream_status(StatusCode::TOO_MANY_REQUESTS).unwrap();
        clock.block(error);
        assert_eq!(
            clock.wait().await.unwrap_err().status,
            StatusCode::TOO_MANY_REQUESTS
        );
        tokio::time::advance(RATE_COOLDOWN).await;
        clock.wait().await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_misses_and_restarted_client_reuse_persisted_success() {
        let directory = tempfile::tempdir().unwrap();
        let first = client(directory.path()).await;
        let (url, calls, task) = mock(StatusCode::OK, TICKERS).await;
        let (left, right) = tokio::join!(
            first.fetch::<Tickers>(url.clone(), "tickers.json".into(), TICKER_TTL, None),
            first.fetch::<Tickers>(url.clone(), "tickers.json".into(), TICKER_TTL, None),
        );
        assert_eq!(left.unwrap().fetched_at, right.unwrap().fetched_at);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let restarted = client(directory.path()).await;
        let cached = restarted
            .fetch::<Tickers>(url, "tickers.json".into(), TICKER_TTL, None)
            .await
            .unwrap();
        assert_eq!(cached.value.len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[tokio::test]
    async fn expired_corrupt_future_and_wrong_company_cache_entries_are_not_served() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cache.json");
        let write_entry = |fetched_at, body| {
            serde_json::to_vec(&json!({"fetched_at":fetched_at,"json":body})).unwrap()
        };
        for timestamp in [
            Utc::now() - chrono::Duration::days(2),
            Utc::now() + chrono::Duration::hours(1),
        ] {
            fs::write(
                &path,
                write_entry(
                    timestamp,
                    serde_json::from_str::<serde_json::Value>(TICKERS).unwrap(),
                ),
            )
            .await
            .unwrap();
            assert!(
                cached::<Tickers>(&path, TICKER_TTL, None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        fs::write(&path, b"not-json").await.unwrap();
        assert!(
            cached::<Tickers>(&path, TICKER_TTL, None)
                .await
                .unwrap()
                .is_none()
        );
        fs::write(
            &path,
            write_entry(Utc::now(), json!({"cik":2,"name":"Other issuer"})),
        )
        .await
        .unwrap();
        assert!(
            cached::<Submissions>(&path, COMPANY_TTL, Some(1))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn upstream_failures_are_explicit_and_never_cached() {
        for (status, expected) in [
            (StatusCode::FORBIDDEN, StatusCode::SERVICE_UNAVAILABLE),
            (StatusCode::TOO_MANY_REQUESTS, StatusCode::TOO_MANY_REQUESTS),
            (StatusCode::INTERNAL_SERVER_ERROR, StatusCode::BAD_GATEWAY),
            (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND),
            (StatusCode::FOUND, StatusCode::BAD_GATEWAY),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let client = client(directory.path()).await;
            let (url, calls, task) = mock(status, TICKERS).await;
            let error = client
                .fetch::<Tickers>(url.clone(), "tickers.json".into(), TICKER_TTL, None)
                .await
                .err()
                .unwrap();
            assert_eq!(error.status, expected);
            assert!(
                !fs::try_exists(directory.path().join("tickers.json"))
                    .await
                    .unwrap()
            );
            if matches!(
                status,
                StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
            ) {
                assert!(
                    client
                        .fetch::<Tickers>(url, "other.json".into(), TICKER_TTL, None)
                        .await
                        .is_err()
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
            task.abort();
        }
    }

    #[tokio::test]
    async fn malformed_json_and_wrong_response_cik_are_not_cached() {
        for body in ["not-json", r#"{"cik":2,"name":"Other issuer"}"#] {
            let directory = tempfile::tempdir().unwrap();
            let client = client(directory.path()).await;
            let (url, _, task) = mock(StatusCode::OK, body).await;
            let error = client
                .fetch::<Submissions>(url, "submissions.json".into(), COMPANY_TTL, Some(1))
                .await
                .err()
                .unwrap();
            assert_eq!(error.code, "SEC_INVALID_RESPONSE");
            assert!(
                !fs::try_exists(directory.path().join("submissions.json"))
                    .await
                    .unwrap()
            );
            task.abort();
        }
    }
    #[tokio::test]
    async fn redirects_are_not_followed_even_to_another_local_route() {
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path()).await;
        let redirected = Arc::new(AtomicUsize::new(0));
        let counter = redirected.clone();
        let router = Router::new()
            .route(
                "/data",
                get(|| async { axum::response::Redirect::temporary("/destination") }),
            )
            .route(
                "/destination",
                get(move || {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        TICKERS
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/data", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let error = client
            .fetch::<Tickers>(url, "redirect.json".into(), TICKER_TTL, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "SEC_UPSTREAM_ERROR");
        assert_eq!(redirected.load(Ordering::SeqCst), 0);
        task.abort();
    }

    #[tokio::test]
    async fn oversized_content_length_is_rejected_before_body_download() {
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/data", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_BODY_BYTES + 1,
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let error = client
            .fetch::<Tickers>(url, "oversized.json".into(), TICKER_TTL, None)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "SEC_RESPONSE_TOO_LARGE");
        assert!(
            !fs::try_exists(directory.path().join("oversized.json"))
                .await
                .unwrap()
        );
        server.await.unwrap();
    }
}
