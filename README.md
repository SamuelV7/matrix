# Matrix

Financial intelligence, for everyone. Matrix is an agentic research workspace built from T3 Code, with a Rust SEC data service powered by stockpricer's existing financial extraction code.

## Run locally

Requires Node.js 24, Rust/Cargo, and [Vite+](https://viteplus.dev/guide/).

```sh
vp i
cp .env.example .env
```

Set `SEC_USER_AGENT` in `.env` to identify Matrix and your real contact email. SEC EDGAR requires an identifiable client; no SEC API key is needed. Then:

```sh
vp run dev
```

Open the pairing URL printed by the launcher. Matrix starts its Rust data daemon and the application together, using a random private daemon credential and loopback port. Application state defaults to a per-checkout directory under `~/.matrix/dev/`, separate from T3 Code; the SEC cache lives in this checkout's ignored `.matrix/sec-cache/`. Stop the launcher to stop both services.

`vp run dev:desktop` starts the inherited Electron development surface with the same data daemon. The financial research screen currently ships in the web/shared desktop renderer; the native mobile app retains the agent companion experience.

## Research a company

The home page opens `/research`. Enter a ticker such as `AAPL`, a numeric CIK, or `cik:320193`.

- **Guided** explains financial terms and keeps source tables collapsed.
- **Analyst** exposes exact period boundaries, filing accessions, and SEC taxonomy tags.
- Six initial reported metrics: revenue, net income, operating cash flow, capital expenditure, assets, and liabilities. Annual observations are charted with exact values and filing links available underneath.
- Recent filings link directly to SEC archive documents. Source retrieval timestamps and extraction limitations remain visible.
- **Ask an agent** opens a research prompt in the existing agent workspace. Configure an available provider in Settings first. The read-only MCP tool `matrix_sec_company` gives agents the same sourced company response; it does not require shell access to the data daemon.

These are historical disclosures, not live prices. This screen displays USD only, does not convert currencies, and does not invent quarterly, TTM, missing, or ambiguous values. It is not a trading or investment-advice service.

## Backend boundary

| Component                        | Responsibility                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Node/Effect application | Agent providers, sessions, authenticated client connections, HTTP/MCP access, and UI delivery.                                                                                                                  |
| `native/matrix-data`             | Rust daemon for SEC network access, rate spacing, validated success caching, company identity, filing links, and response assembly.                                                                             |
| `native/stockpricer-core`        | Actual stockpricer company model, SEC XBRL decoder, annual-statement extraction, and its existing domain regression tests, imported from `~/starforge/stockpricer/src/company/` and `src/sec/company_facts.rs`. |

The domain core does not depend on stockpricer's PostgreSQL database, HTTP server, authentication, or a sibling checkout at runtime. Matrix has no external path dependency on `~/starforge/stockpricer`. Its data adapter calls the imported engine rather than maintaining a second financial-normalization implementation.

SEC requests are spaced at least 250 ms apart within the daemon. Successful ticker data caches for 24 hours; company submissions and facts cache for 15 minutes. Failures never become substitute data. A 403/429 triggers a one-minute upstream cooldown. This is a per-daemon limiter: multiple instances sharing an egress IP must coordinate their combined SEC traffic.

`MATRIX_HOME` and `MATRIX_DATA_CACHE_DIR` override local storage. Keep application state outside Git checkouts: the agent backend intentionally disables project-free research workspaces inside a checkout to prevent inheriting its Git status and checkpoints. `MATRIX_DATA_BIN` selects a prebuilt data executable; otherwise the launcher builds it with Cargo. The browser talks only to the authenticated application endpoint `/api/matrix/sec/company`, not directly to the private daemon.

## Focused checks

```sh
vp run test:data
vp test run apps/web/src/matrix/annualTrend.test.ts
vp test run apps/server/src/mcp/toolkits/worktree/registration.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
```

Internal `@t3tools/*` package names and agent protocol identifiers remain implementation identifiers, not product branding. Matrix does not install official T3 Code updates; build this checkout instead. Fork-inherited deployment workflows are disabled on the Matrix GitHub repository.

## Attribution

Matrix is derived from [T3 Code](https://github.com/pingdotgg/t3code). Its original MIT copyright and license notices are retained in [LICENSE](LICENSE). The imported financial engine comes from the existing stockpricer project; its source modules and domain tests are retained, with Matrix's transport and UI kept outside that core.
