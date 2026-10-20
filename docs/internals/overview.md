# Architecture

Matrix keeps agent execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Financial data boundary

The existing Node/Effect backend remains the agent control plane. Matrix uses a private loopback
Rust daemon for SEC retrieval and validated success caching; rewriting agent orchestration in Rust
would duplicate an existing working boundary without helping this data workflow.

Financial decoding and annual statement selection are imported from stockpricer into
`native/stockpricer-core`. Matrix's `native/matrix-data` adapts that engine rather than maintaining
a second normalization algorithm. PostgreSQL, stockpricer authentication, and its web server are
not dependencies. SEC annual period and taxonomy choices remain the stockpricer engine's choices;
the Matrix adapter preserves exact source tags and omits missing, ambiguous, and derived values
from the initial reported-figures workspace.

The authenticated HTTP endpoint and `matrix_sec_company` MCP tool call the same application
service. Browser cookies and provider credentials never go to SEC; the daemon receives only its
own private credential and a configured SEC contact identity. Request spacing is per daemon,
not a claim of cross-process or deployment-wide SEC rate enforcement.

## Agent-composed research canvas

The Node/Effect control plane also owns bounded country/year research adapters: FAO crop history
through OWID, historical World Bank SPEI, and dynamically discovered source-2 World Development
Indicators across economics, population, health, energy and environment. WDI is a searchable
provider catalog, not a GDP whitelist. The Rust/stockpricer boundary above remains responsible for
SEC evidence; these public statistical adapters do not require a second orchestration daemon.

Agents discover capabilities with `matrix_research_catalog`, inspect evidence with
`matrix_research_data({ query })`, and compose a question-specific document through
`matrix_present_answer`. Queries reference supported source identifiers; agents never supply
numerical arrays, map coordinates or executable UI. The server hydrates bounded typed datasets
with definitions, units, timestamps, rights and coverage. Compact tool inspections expose at most
32 annual rows per focused entity and ten ranked countries; `historyCoverage` reports the full
focused history bounds, row counts and whether rows were omitted. The saved dataset retains the
full requested history. Inspect an omitted exact range before claiming full-period extrema or statistics.

Reusable map, annual-series, selected-value, country-table and paired-country scatter components
work across these sources. Country tables and scatters describe the selected year, not temporal
rows or historical-year points. Quantitative headings are application-owned and follow the actual
measure and frame; authors control section grouping instead of supplying potentially stale data
captions. Maps use shared, attributed Natural Earth geometry, not invented shapes or crop-field
boundaries. Source World aggregates are never recomputed by summing countries.

Providers join on source country identifiers and exact calendar years, never parallel array
positions. Missing values remain unavailable; uncoded SPEI territories are not merged into one
empty identity. Growth uses the exact preceding year. Percentage-valued differences are percentage
points, not another percentage level. SPEI is historical national annual climate information, not
crop-area-weighted exposure, current conditions or causal evidence. FAO/OWID's conflicting license
metadata is preserved rather than silently declaring commercial clearance.

SEC widgets retain exact annual reporting periods, source tags and filing accessions; supported
margins require matching observations. Qualitative explanations and diagrams remain model
interpretation, not validated causal findings or measured segment allocations.

Each answer is a `matrix_answer` turn item in the existing event log and projection. Updates use
an answer ID and expected revision, preserve the original storage anchor and pin state, and reject
stale or cross-thread writes. `lastPresentedRunId` identifies the run presenting the current
revision; metadata-only pin/view updates must not change it, the composition or the evidence.
Bounded snapshots must include that run's answer even when its original ordinal is outside the
window. MCP presentation requires a live caller; workspace reads require orchestration-read and
pin/view mutations require orchestration-operate. Subscriptions capture the replay cursor before
their snapshot.

The web's primary surface is the full research canvas; conversation is a secondary control column.
All authored sections remain visible and grids respond to their actual container width. Progress
notes are collapsed separately from messages, attachments, errors and approvals. Web and mobile
render the same typed document with platform-native controls, never generated HTML or scripts.
Country/year/measure focus is server-owned, serialized with pin changes and saved using CAS.
Valid saved views survive both same-run enrichment and normal follow-up runs. `researchFocus`
records the latest reader geography; new data panes inherit those countries while retaining their
own authored year/measure. Only an explicit new-run `viewPolicy: "authored"` resets saved views.
The first map's declared measure seeds a new pane's controls ahead of the generic query measure;
acknowledged reader selections remain authoritative.
Follow-ups inspect this focus and revise the same answer. Only visible dataset blocks receive control panels; auxiliary evidence does not create an
unrelated dashboard.

Evidence inspection also defaults to the thread's latest saved reader geography, rather than letting
an authored query silently widen a contextual question. An explicit inspection `viewPolicy: "authored"`
can inspect another geography without mutating the saved view.

Guided/Analyst detail, readable/exact precision, chart display and table sorting remain local.
SEC `periods: 1..20` windows each company's exact periods independently; **All periods** never
fabricates missing observations. Follow-up controls use their exact visible prompt and the normal
guarded message lifecycle; an existing draft or attachment is not silently overwritten or sent.
Workspace data and acknowledged focus remain available independently of loaded chat history.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Web, desktop, mobile, and environments upgrade independently. Negotiate linking through the
environment descriptor, never through a client version or an assumed coordinated release:

| Environment capability                | Client behavior                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `threadPullRequests: true`            | Use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread lookup.                         |
| Only `threadPullRequestLinking: true` | Use `linkedPullRequest` and the existing `thread.meta.update` single-link operation. Do not call multi-link RPCs. |
| Neither flag                          | Hide linking actions; existing branch-discovered PR display remains available.                                    |

New environments continue advertising the legacy flag, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field for older clients. That hostless field includes only
links in the thread project's own repository; cross-host and cross-repository links require the
multi-link protocol. New clients accept snapshots that
omit `pullRequests`. Retain the legacy wire fields, projection column, and replay support; this feature
does not schedule their removal. Missing new capabilities must also override cached multi-link data
after an environment downgrade.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
