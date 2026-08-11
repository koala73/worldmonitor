# Integration Decisions

## D-0001 — Adopt a separate WorldMonitor mother workspace

**Decision:** Use `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated` as the only formal integration workspace.
**Reason:** The previous project is a non-Git React/Express/SQLite implementation, while the requested mother is the AGPL WorldMonitor fork. Combining their root manifests would violate the execution-book architecture decision and make upstream maintenance unsafe.
**Consequence:** The old project, database and desktop shortcut remain preserved until the new mother passes final acceptance.

## D-0002 — Preserve a local legacy checkpoint before mother work

**Decision:** Create a local source/data snapshot before creating the mother workspace.
**Reason:** The legacy project has no Git history and therefore no branch-based recovery point.
**Consequence:** The 1.828 GB checkpoint is excluded from Git and remains recoverable locally.

## D-0003 — Use sparse checkout during Phase 0

**Decision:** Use a Git-native sparse checkout with an isolated index for Phase 0 metadata and documentation.
**Reason:** Full clone/fetch exceeded the desktop tool's 64-second single-command limit; no force, reset, deletion of legacy files, or modification of `main` was used.
**Consequence:** Phase 1 must expand/finalize the official mother checkout before any code integration or baseline test claim. The sparse index is an implementation recovery detail, not evidence that source integration has started.

## D-0004 — Provider truth labels are contractual

**Decision:** Use the exact status model in `PROVIDER_MATRIX.md`; values and charts may not be displayed above their proven freshness/authorization level.
**Reason:** The execution book forbids fake K lines, historical-as-live data, cargo inference-as-fact, and causal overstatement.

## D-0005 — Legal gate before Phase 1 integration

**Decision:** Do not merge/synchronize/ship a WorldMonitor-derived integration until the user explicitly accepts AGPL-3.0-only network-distribution obligations and independent branding.
**Reason:** The execution book lists this as P0 manual approval. Local audit and Phase 0 preservation are safe; public or substantive mother integration requires the legal premise.

## D-0006 — Close Phase 0 with an auditable recovery probe

**Decision:** Treat Phase 0 as complete only after verifying the isolated-index worktree, source locks, a deterministic 20-file backup sample, and a three-file read-only restoration probe.
**Reason:** A backup directory and a prose statement alone are not sufficient recovery evidence.
**Consequence:** The closure output, SHA-256 values, exit codes, and the host-protected temporary cleanup limitation are retained in `evidence/phase0-closure.md`. The normal index remains unavailable because `.git/index.lock` is host-protected; source state is verified with the clean Git-native isolated index instead of deleting the lock or resetting the worktree.

## D-0007 — Do not substitute a cached or dirty old copy for the required upstream baseline

**Decision:** Leave Phase 1 blocked until `upstream/main` is fetched into the new workspace and its local graph proves the remote relationship.
**Reason:** GitHub HTTPS is currently unavailable from the machine. The legacy backup contains a nested WorldMonitor repository only at `0fca203...` and it has pre-existing generated-file modifications; it does not contain `ae0a0fe...`.
**Consequence:** Do not copy that tree into the formal mother workspace, create a synthetic `upstream/main`, run a build against it, or claim the 43 upstream commits were integrated. The verified remote comparison and failed local commands are recorded in `evidence/phase1-preflight-network.md`.

## D-0008 — Establish Phase 1 from the real fetched upstream baseline

**Decision:** After GitHub HTTPS recovery, fetch both remotes locally and create the dedicated integration branch from the real `upstream/main` commit `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`.
**Reason:** The Phase 1 requirement is a verifiable local object graph, not a cached copy, a synthetic ref, or an inference from the GitHub connector. Local HTTP/1.1 fetches now prove fork merge-base `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and upstream ahead/behind `0 43`.
**Consequence:** `integration/pokieticker-maritime-china-factory` is the only Phase 1 implementation branch. `main`, the preserved legacy project, and the backup branch remain untouched.

## D-0009 — Make provenance and independent identity executable contracts

**Decision:** Centralize the product identity in a source constant, render the exact AGPL attribution visibly in the application footer, retain PokieTicker's MIT license and source lock, and test these requirements in the repository.
**Reason:** A README-only promise can drift from the shipped UI. The user requires an independently branded product while the AGPL upstream attribution, PokieTicker provenance, and non-deceptive data boundaries must remain visible and auditable.
**Consequence:** Phase 1 does not copy PokieTicker source code or its historical SQLite data. It adds only the license/trace documents, branded UI metadata, and contract tests; live data, K-lines, AIS facts and Provider claims remain out of scope until their honest Phase 2+ adapters exist.

## D-0010 — Fail closed for market data until a licensed adapter exists

**Decision:** Establish the complete stock RPC/provenance contract before
connecting a Provider. The initial handler validates inputs but returns an
explicit `NOT_CONFIGURED` envelope and no value-bearing market payload.
**Reason:** A blank 200 response conceals configuration failure, while a shared
sample OHLC array would be a fake K line. The product must be able to distinguish
licensed real-time, delayed, historical, stale, degraded, unavailable and
unconfigured states in both code and UI before it can render a chart.
**Consequence:** Every future market adapter must use the Phase 2 symbol
validator, symbol-qualified cache key and bar invariant guard. A Provider key or
non-empty response cannot by itself upgrade the status to
`REALTIME_LICENSED`.

## D-0011 — Isolate authorized live market transport on the server and fail closed

**Decision:** Use Massive REST and WebSocket functionality only through a
server-side adapter/relay. The browser may subscribe to a same-origin SSE
endpoint but never receives an upstream credential. A missing key returns
`NOT_CONFIGURED`; a key without the explicitly confirmed display/rebroadcast
right remains `DELAYED_UNVERIFIED` and opens no upstream real-time stream.
**Reason:** A client-side key or a WebSocket opened merely because a key exists
would expose a secret and turn an unverified commercial capability into a false
real-time claim.
**Consequence:** All server transport requires symbol-qualified request/cache
keys and strict response matching. Provider failure returns unavailable empty
bars, never another symbol's series, a static sample or a historical fixture.

## D-0012 — Treat exchange session state and suspicious repeated bars as data-quality gates

**Decision:** Calculate US equity `MARKET_CLOSED` from a named-calendar and
early-close model rather than weekday alone, and reject six identical traded
OHLC bars after normal series validation.
**Reason:** Weekend-only logic mislabels holidays; a repeated static candle
sequence is a recognizable fake-K-line failure mode even when its OHLC values
are individually valid.
**Consequence:** The Phase 3 relay/adapter tests cover Sunday and Christmas
closures, distinct symbols/windows, and flatline rejection. Legitimate provider
data may be shown only when it passes those guards with its true status.

## D-0013 — Keep generated source attribution executable on Windows

**Decision:** Make the source-attribution script recognize its own Windows path
before invoking `main()`.
**Reason:** `process.argv[1]` contains backslashes on Windows; the previous
forward-slash-only suffix test silently skipped generation, leaving provider
provenance changes unrefreshed.
**Consequence:** `npm run sources:generate` now refreshes the checked-in
manifest and source document on this required desktop environment; the resulting
Massive entries remain `terms-review`, not a license assertion.

## D-0014 — Preserve commit gates in a partial-clone linked worktree

**Decision:** Repair the tracked `pre-commit` script with a portable `#!/bin/sh`
shebang and run the repository hook explicitly from the integration worktree.
When the host blocks removal of a stale worktree `index.lock`, build the
already-reviewed tree through a new Git-native isolated index and use the
locked backup Git **objects** as a read-only alternate object store.
**Reason:** The linked worktree's default hooks resolved under its Git metadata,
the original script had no executable format for Git for Windows, and partial
clone object hydration stalled during commit. Skipping the hook, deleting a
host-protected lock by a workaround, or copying the old project would weaken
the required audit trail.
**Consequence:** The Phase 3 implementation commit
`9cb8cb6efe2164891ea26cb6b2f51b6a3da086b0` was produced only after
`git write-tree` and cached-diff checks passed in an isolated index, and after
the actual staged-Unicode hook passed. The alternate store is lookup-only; it
does not make the legacy project a code or data source.

## D-0015 — Make the stock workspace own its scroll surface and fail closed visually

**Decision:** Give the native `.pokie-workspace` a bounded `height: 100vh` and
`overflow-y: auto`, because the enclosing dashboard deliberately disables
document scrolling. Render a dedicated empty chart and unavailable research
states whenever Market v1 does not return symbol-validated provider data.
**Reason:** A page that is visually taller than the viewport but cannot scroll
does not satisfy the stock-research workflow. Restoring scroll by filling the
space with a fixture, generic chart or another security's bars would be a more
serious false-data defect.
**Consequence:** Browser acceptance must prove real wheel scroll at desktop and
responsive mobile sizes, while live K-line acceptance remains blocked pending a
provider response and display/rebroadcast authorization. The UI may preserve
the component structure of PokieTicker but cannot elevate its historical
database or an empty no-key response into market facts.

## D-0016 — Separate event alignment, analysis, realized returns and causality

**Decision:** Represent source/time alignment, model assessment and realized
market returns as separate fields and render each only when its own evidence is
available. Use a named primary-exchange calendar rule; for the present US
implementation, after-hours/non-trading publications move to the next named
NYSE/Nasdaq trading date. Do not turn any of these correlations into a causal
statement.
**Reason:** A publication timestamp can establish only calendar alignment. A
model label is an attributed model output, while a T0/T1/T3/T5/T10 price change
is a price observation from validated bars. None independently proves that an
article caused the change; collapsing them would manufacture investment
evidence.
**Consequence:** No-key responses fail closed as `NOT_CONFIGURED` / unavailable,
and the UI cannot show neutral/positive/negative, relevance, categories,
returns or causal confidence as though measured. Future non-US instruments
must bring a primary-exchange calendar mapping, and a future model provider
must supply authorized, versioned output with server-only credentials.

## D-0017 - Bound AIS display to verified reports in the selected geography

**Decision:** The maritime workspace requests and displays AIS reports only for
an explicit, small chokepoint bounding box. Each rendered report requires a
valid nine-digit MMSI, finite coordinates inside that selected box and a
positive observation time; duplicate MMSIs retain only the latest report.

**Reason:** A global fixed vessel subset, a stale unscoped cache or a random
fallback would look like live tracking while being neither current nor tied to
the user’s requested geography. AIS absence must be visible absence, not a
reason to fill the map with plausible-looking ships.

**Consequence:** The no-provider UI renders zero vessel dots and an explicit
configuration state. PortWatch aggregates, official warnings and Shipping v2
model/registry routes are separate layers with their own unavailable states.
No component may infer cargo, origin, buyer, value, discharge or bill-of-lading
fact from AIS.
