# Development

## First checkout

Install [Vite+](https://viteplus.dev/guide/), Node 24, and Rust/Cargo. The Matrix launcher
builds and starts the Rust SEC daemon alongside the application. From the repository root:

```sh
vp i
cp .env.example .env
# Set SEC_USER_AGENT in .env to Matrix followed by your real contact email.
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for the data daemon, server, and web, or `vp run dev:desktop` for the
data daemon and Electron development client. `dev:server` includes the daemon;
`dev:web` starts only the renderer and expects a running application server.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/matrix-dev`.
Add `--browser` to open a browser automatically.

### State and ports

The Matrix launcher defaults to per-checkout application state under `~/.matrix/dev/<checkout-id>/`
and this checkout's ignored `.matrix/sec-cache`. `MATRIX_HOME` changes application state;
an explicit `--home-dir` takes precedence in both development and production `start` modes.
`MATRIX_DATA_CACHE_DIR` changes the SEC cache separately. Keep application state outside Git
checkouts: project-free agent workspaces are intentionally unavailable inside a repository.
Never point development at another running installation's state.
`MATRIX_DATA_BIN` selects a prebuilt data executable; otherwise Cargo builds the local daemon.
Daemon credentials are generated per launch and never sent to the renderer.
See [test data](../../AGENTS.md#test-data) before copying any existing application database.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Free-model demo preset

Install OpenCode on `PATH` (the demo uses OpenCode v2; Matrix also supports v1). The Matrix
launcher initializes `<home>/userdata/settings.json` before starting the application:

- **GLM 5.3 Flash (Free)** — `opencode/glm-5.3-flash-free`, the default for new chats and
  auxiliary text generation.
- **DeepSeek V4.1 Flash (Free)** — `opencode/deepseek-v4.1-flash-free`, selectable from the
  chat model picker. To change future chat or auxiliary defaults, choose it in the corresponding
  server settings. Explicit selections of either free model survive subsequent launches.

These two OpenCode free endpoints require **no API key or personal subscription**. Free
availability, capacity, and rate limits are controlled by the upstream service and may change.
If either endpoint is unavailable, Matrix reports the error rather than falling back to a paid
model. Other agent instances, including subscription-backed defaults, are disabled on launch;
the OpenCode provider enforces the exact two-model allowlist for catalogs and requests.
Existing threads are not rewritten: switch a thread with an old model selection to one of the
two free models before sending another message.

The preset preserves unrelated settings, an explicit OpenCode disable, custom binary paths,
and names for the two free models. It replaces incompatible model defaults and prevents
project overrides from re-enabling other agent instances. Invalid settings stop startup instead
of reverting to subscription-backed built-ins.

OpenCode configuration, credentials/data, cache, and state are isolated under `<home>/opencode/`;
the launcher does not modify personal `~/.config/opencode` or `~/.omp` state. Per-instance XDG
paths and empty inline authentication prevent inheriting personal OpenCode credentials.
The isolated native `config/opencode/opencode.json` sets the free chat/title model, disables
OpenCode self-updates, and denies every native provider except `opencode`. This is a native v2
provider policy, not the v1 provider whitelist that v2 ignores. External OpenCode server URLs
are cleared so the demo uses its locally spawned, isolated server.

To initialize an already-running Matrix home's settings without launching another server:

```sh
node scripts/lib/matrix-free-models.ts --home-dir /absolute/path/to/matrix-home
```

The initializer atomically updates settings for the existing settings-file watcher; it does not
write the application database. Do not send turns during the change. Restart the existing
Matrix process after applying it to retire any OpenCode subprocesses started with the old
environment. Normal future launches initialize the same selected home automatically.

Free does not mean private: prompts, retrieved data, tool output, and attached content sent
to these models leave the machine for OpenCode/upstream model services. Their current privacy
and retention terms apply; do not send confidential data without reviewing those terms.

### Interactive research answers

Choose **New research** with either free model and ask normally. For example:

- “Show me global corn output and how it has changed since 2000.”
- “Compare GDP growth and inflation in Brazil and the United States since 2010.”
- “Compare access to electricity and renewable electricity generation in India and Brazil.”
- “Show Microsoft's reported annual revenue and cash flow trends.”

No UI/tool incantation or project selection is required. `/research` starts the same normal
research-conversation workflow. The agent discovers source capabilities and chooses a useful
composition; the primary surface is a full research canvas, not a financial lookup or tabbed chat
card. Conversation remains available for ordinary follow-ups, approvals, errors and attachments.
Additional agent notes are collapsed rather than replacing the interface.

On a country/year answer, select a country on the map or through accessible search, compare up to
six entities, change the year or map measure, and inspect linked histories and exact values.
**World reset** restores the source aggregate. Tables sort and paginate all available rows; they
compare countries at the selected year, while annual history is shown in series charts. Scatter
points are paired countries at that same year, not historical years. Quantitative headings, units
and dates follow the actual view rather than an agent-authored caption.

Wait for **Saving view…** to finish before leaving or reloading. Acknowledged country/year/measure
focus and **Pin** survive reloads and server restarts. Guided/Analyst detail, readable/exact
precision and chart display are local controls. Use the answer selector to revisit saved research,
including answers outside loaded chat history. With an unsent draft or attachment, suggested
follow-ups are staged instead of silently sending or replacing that content.

After selecting Brazil in the corn workspace, ask “Compare that with drought conditions.”
The agent must inspect saved focus and revise the same answer. Check the displayed paired year
and source warnings: annual national SPEI is not crop-area-weighted exposure, current crop
conditions or proof of causation; World SPEI is unavailable. Missing 2024 drought values must not
be filled from 2023.

Available sources have explicit boundaries:

- FAO-only corn and wheat production, reported harvested area and yield through OWID, with
  history through 2024. Harvested area is a source series, not output divided by yield or unique
  cropland footprint. The displayed FAO/OWID license discrepancy requires review before reuse.
- Searchable World Bank source-2 indicators across economics, population, health, energy,
  environment and other available topics. Definitions, units, annual coverage and individual
  source rights come from metadata; missing observations are not zero.
- Historical national SPEI from World Bank source 75, with incomplete country/year coverage.
- Historical annual SEC USD observations and matching-period margin calculations, not live
  prices, a valuation feed or quarterly/TTM data. Company fiscal periods are not silently
  calendar-aligned. **All periods** expands actual evidence without filling missing years.

Narratives and qualitative diagrams are interpretation. Statistical co-movement does not establish
a cause, and a business diagram does not establish measured product/segment revenue shares.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

For direct HTTP access over Tailscale, set `MATRIX_WEB_HOST=0.0.0.0` in `.env.local`
and restart `vp run dev`. Use the machine's Tailscale IP and the printed web port.
This exposes the development web server on all interfaces, including LAN; restrict access
to trusted networks. Pairing remains required. The backend and Rust data daemon can stay
on loopback because Vite proxies API and WebSocket traffic through the browser's origin.
This bind-only setting does not pin HMR to `0.0.0.0` or change desktop development binding.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node.

TypeScript workspaces typecheck with tsc-rs, which has Effect diagnostics built in.
Keep `typescript`, `@effect/tsgo`, and the `effect-tsgo patch` prepare step: editors
still use them for Effect quick fixes and refactors. Keep `@effect/tsgo` on the
effect-tsgo version that tsc-rs ports (see the tsc-rs README), or the two disagree
on rule names.
Marketing keeps `astro check` for Astro files.

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
