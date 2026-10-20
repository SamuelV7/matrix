mod normalize;
mod sec;

use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use normalize::{CompanyResponse, Identifier, Source};
use sec::SecClient;
use serde::{Deserialize, Serialize};
use std::{env, net::Ipv4Addr, path::PathBuf, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore};

#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    pub(crate) fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "INVALID_IDENTIFIER",
            "Use an SEC ticker, cik:NUMBER, or a positive CIK of at most ten digits.",
        )
    }

    pub(crate) fn upstream() -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "SEC_INVALID_RESPONSE",
            "SEC returned an invalid or unsupported response.",
        )
    }

    pub(crate) fn is_not_found(&self) -> bool {
        self.status == StatusCode::NOT_FOUND
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: &'static str,
            code: &'static str,
        }
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
                code: self.code,
            }),
        )
            .into_response()
    }
}

#[derive(Clone)]
struct AppState {
    sec: Arc<SecClient>,
    authorization: Arc<str>,
    requests: Arc<Semaphore>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompanyQuery {
    symbol: String,
}

async fn company(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<CompanyQuery>, QueryRejection>,
) -> Result<Json<CompanyResponse>, ApiError> {
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if supplied != Some(state.authorization.as_ref()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "A valid Matrix data bearer token is required.",
        ));
    }
    let Query(query) = query.map_err(|_| ApiError::invalid())?;
    let identifier = Identifier::parse(&query.symbol)?;
    let _permit = state.requests.try_acquire().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "DATA_BUSY",
            "Matrix data is busy; retry shortly.",
        )
    })?;
    tokio::time::timeout(
        Duration::from_secs(100),
        load_company(&state.sec, identifier),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SEC_UNAVAILABLE",
            "SEC data retrieval timed out; retry later.",
        )
    })?
    .map(Json)
}

async fn load_company(
    client: &SecClient,
    identifier: Identifier,
) -> Result<CompanyResponse, ApiError> {
    let mut sources = Vec::with_capacity(3);
    let cik = match identifier {
        Identifier::Cik(cik) => cik,
        Identifier::Ticker(symbol) => {
            let directory = client.tickers().await?;
            let cik = directory
                .value
                .values()
                .find(|entry| entry.ticker.eq_ignore_ascii_case(&symbol))
                .map(|entry| entry.cik_str.value())
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::NOT_FOUND,
                        "SEC_NOT_FOUND",
                        "Ticker was not found in the SEC company directory.",
                    )
                })?;
            sources.push(Source::new(
                "SEC company ticker directory",
                directory.url,
                directory.fetched_at,
            ));
            cik
        }
    };
    let submissions = client.submissions(cik).await?;
    sources.push(Source::new(
        "SEC company submissions",
        submissions.url,
        submissions.fetched_at,
    ));
    let facts = match client.facts(cik).await {
        Ok(facts) => {
            sources.push(Source::new(
                "SEC XBRL company facts",
                facts.url,
                facts.fetched_at,
            ));
            Some(facts.value)
        }
        Err(error) if error.is_not_found() => None,
        Err(error) => return Err(error),
    };
    tokio::task::spawn_blocking(move || {
        normalize::company_response(cik, submissions.value, facts, sources)
    })
    .await
    .map_err(|_| ApiError::upstream())?
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let user_agent = env::var("SEC_USER_AGENT")
        .map_err(|_| "SEC_USER_AGENT must identify your application and real contact email")?;
    let token = env::var("MATRIX_DATA_TOKEN").map_err(|_| "MATRIX_DATA_TOKEN is required")?;
    if token.len() < 32 || token.len() > 512 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(
            "MATRIX_DATA_TOKEN must contain 32 to 512 printable, non-whitespace ASCII characters"
                .into(),
        );
    }
    let port: u16 = env::var("MATRIX_DATA_PORT")
        .unwrap_or_else(|_| "0".to_owned())
        .parse()
        .map_err(|_| "MATRIX_DATA_PORT must be an integer from 0 to 65535")?;
    let cache_dir = env::var_os("MATRIX_DATA_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".matrix/sec-cache"));
    let sec = Arc::new(SecClient::new(&user_agent, cache_dir).await?);
    let state = AppState {
        sec,
        authorization: Arc::from(format!("Bearer {token}")),
        requests: Arc::new(Semaphore::new(8)),
    };
    let app = Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status": "ok", "service": "matrix-data"})) }),
        )
        .route("/sec/company", get(company))
        .fallback(|| async {
            ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Endpoint not found.")
        })
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD_NOT_ALLOWED",
                "Method not allowed.",
            )
        })
        .with_state(state);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({"url": format!("http://{address}")})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            },
            Err(error) => {
                eprintln!("Cannot install SIGTERM handler: {error}");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
