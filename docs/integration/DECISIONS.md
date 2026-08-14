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

## D-0018 - Separate cluster recognition from trade, port and shipment evidence

**Decision:** Store official industrial-cluster recognition, HS mapping,
country-level observed trade, modelled port potential and commercial B/L
records as separate evidence layers. A cluster can be visible with its source
even when it has no reviewed HS mapping; it must then be statistics-disabled.

**Reason:** An industrial-cluster title neither proves its product code nor
identifies a company's exports, town shipment, port, vessel, container, buyer
or cargo. Joining those layers without their own source would turn plausible
context into a fabricated trade or logistics fact.

**Consequence:** The initial registry retains 20 official MIIT reference
clusters without claiming HS/product statistics and permits observed national
trade only for reviewed HS mappings. Huidong and Putian footwear map to HS 64
but show no number unless a source-returned country-level record validates the
selected filters. Port ranking stays unavailable/modelled until its method and
lawful inputs exist; B/L remains empty until a contracted provider returns an
authorized, timestamped record.

## D-0019 - A layout toggle is not evidence of a live observation

**Decision:** Put market/stock work first in a fresh full layout while keeping
provider-dependent military and aviation panels as collapsed, low-priority
entries. Treat a user-saved panel order as user-owned. Render an aviation
observation badge only when a provider-attributed record has a valid,
non-future timestamp within the configured freshness window.

**Reason:** The requested economic priority should be visible without erasing
personal workspaces. Conversely, a map layer or a non-empty cache can be
enabled without a current authorized upstream observation; calling that `LIVE`
would create a misleading operational claim.

**Consequence:** Fresh full layouts lead with Markets and the native stock
workspace link, but old saved orders remain untouched. Military/aviation entry
points remain accessible below the core workspace and show Provider status,
freshness condition and non-secret actions. A stale, undated, blank-source or
future-dated position produces no observed/live indicator.

## D-0020 - An operational button is not a Provider request or Provider success

**Decision:** Create a native Provider Operations control surface whose retry
path executes no network request by default. It can only invoke a separately
registered protected executor after configuration readiness, a per-operation
lock, rate-limit window and minimum retry interval pass. Dashboard refresh
completion, executor success/failure and Provider provenance remain different
telemetry fields.

**Reason:** A UI retry button, scheduled callback or configured key cannot
prove that an authorized upstream request ran or that it returned data. Treating
one as another would turn a convenient control surface into false real-time,
queue, quota or market-data evidence. It would also risk calling an upstream
without the intended server-side authorization and audit boundary.

**Consequence:** Missing configuration/executors show explicit
`NOT_CONFIGURED` / `SERVER_MANAGED_UNKNOWN` states and audit the no-request
action. Last success is never erased by a later failure. `SELF_HOSTED_MODE=true`
forces the sidecar cloud fallback off while the existing `LOCAL_API_TOKEN`
default-deny gate remains required. Any future executor must return its own
source-bearing metrics before the UI can show health, freshness, vessel count,
trade value, queue depth, model metric or real-time market assertion.

## D-0021 - Deliver the new desktop shell as an installed Tauri application

**Decision:** Use the existing WorldMonitor Tauri 2 path with an NSIS
per-user installer, a branded native executable and a PowerShell 5-safe
desktop shortcut. The launcher resolves the installed artifact, installs it
only when missing and treats an exact matching running process as success.

**Reason:** The bare Rust release executable lacks the NSIS resource layout;
the old Express desktop entry is neither the new mother nor a valid fallback.
An installed native artifact is therefore required for repeatable opening,
Chinese path handling, self-contained frontend resources and local sidecar
supervision.

**Consequence:** The new desktop path never probes/starts the old `4000` or
`5173` services and never overwrites the preserved legacy launcher. An MSI is
optional distribution work; the verified NSIS artifact is the current desktop
delivery. Unsigned status remains explicit until the owner supplies a signing
certificate.

## D-0022 - Treat the bundled Node runtime as verified executable supply chain

**Decision:** Download the fixed Node.js Windows archive from its official
distribution URL, validate it against the official SHA-256 manifest, validate
the copied `node.exe`, package the upstream LICENSE, and ignore the generated
binary from source control.

**Reason:** The Tauri sidecar needs a runtime in a clean user installation.
Using ambient Node or an unverified archive would make the desktop result
non-reproducible and could incorrectly turn a missing local runtime into a
Provider failure.

**Consequence:** The packager verifies/refreshes the Windows runtime before
building. Runtime acquisition is license evidence, not a user-facing data
Provider or live-data source. A local sidecar process/listener proves only
first-party local service availability, never stock/AIS/news data freshness.

## D-0023 - Desktop incremental frontend resources must invalidate Rust embed output

**Decision:** Declare the Vite desktop entrypoints and assets as Cargo build
script rerun inputs.

**Reason:** A raw incremental Tauri build previously retained a web-only
resource map and launched with `asset not found: index.html`. Treating the
existence of an installer as proof would have hidden a real desktop defect.

**Consequence:** Desktop build evidence requires an actual installed launch.
The rejected missing-asset build remains documented; only the final installed
overview/sidecar proof is accepted for Phase 10.

## D-0024 - Screenshot readiness needs a loaded style and deterministic test-only source

**Decision:** The map E2E harness sets an explicit test marker before startup.
Only under that marker, DeckGLMap uses a local empty-source MapLibre style.
Harness readiness requires a loaded style; a canvas-only timeout fallback is
rejected.

**Reason:** External basemap availability and a WebGL canvas can produce a
blank image while appearing ready. A screenshot gate must prove deterministic
expected feature rendering without calling a fixture a production source.

**Consequence:** Production routes cannot enter this path and retain normal
basemap configuration. The marker/style proves only visual test infrastructure,
never a map observation, conflict fact, market fact, Provider relationship or
live-data status.

## D-0025 - Build variants replace the complete pre-paint branch

**Decision:** Build-time variant specialization owns the whole pre-paint
assignment/removal branch through a tested helper, rather than replacing only
the `if` arm.

**Reason:** Replacing only the true branch left the original `else` in Finance
output, yielding invalid JavaScript and preventing hydration before a
fail-closed panel state could render.

**Consequence:** Full retains runtime hostname selection; each fixed variant
uses syntactically valid fixed assignment. Seven focused tests parse every
non-Full emitted pre-paint script and protect unrelated HTML routes.

## D-0026 - Publish only to the owner fork as a non-force integration branch

**Decision:** Phase 12 targets
`daking32168-byte/worldmonitor:integration/pokieticker-maritime-china-factory`
with a normal tracked push and a Draft PR to that fork's `main`. It does not
push to upstream or change any `main` ref.

**Reason:** Connected GitHub metadata confirms owner-fork administrative/push
permission, while `koala73/worldmonitor` is a read-only AGPL-3.0 upstream. The
mixed local worktree also requires an explicit branch scope rather than a
blanket staging/publishing action.

**Consequence:** The Phase 11 commits and the Phase 12 documentation receipt
are the only commits released by this phase. A remote PR is a review artifact,
not a merge, deployment, Provider authorization or proof of live data.

## D-0027 - Reject a replacement remote commit while transport is blocked

**Decision:** Do not use GitHub's blob/tree/commit/ref APIs to synthesize a
replacement remote branch while normal local Git transport is unavailable.

**Reason:** The connected GitHub integration verifies write permission but does
not upload the existing local object pack. Rebuilding one fresh commit would
lose the 72 committed, reversible steps and invalidate the real SHAs already
recorded in Phase 0-12 evidence.

**Consequence:** Publication pauses honestly with no remote branch or PR until
HTTPS Git authentication/networking or an existing authorized SSH route is
restored. The only subsequent remote write remains a normal non-force push of
the named integration branch to the owner fork.

## D-0028 - Resume publication through a command-local official Git endpoint

**Decision:** After two resumed HTTPS push failures, use GitHub's official
`/meta` Git CIDR response to identify a reachable Git endpoint, verify it first
with `ls-remote`, and apply `http.curloptResolve` only to the individual Git
commands. Preserve the HTTPS URL and TLS host name `github.com`.

**Reason:** The authenticated GitHub integration and `api.github.com` were
healthy while this machine's locally resolved `github.com` address was not.
Using a reachable address from GitHub's own current Git range preserved native
Git object transfer and the complete reversible commit chain.

**Consequence:** The successful write remained a normal, non-force push of the
named integration ref. No hosts file, global Git setting, remote URL, main ref
or upstream ref changed. The two failures and the successful route are retained
as evidence rather than being erased.

## D-0029 - Draft publication does not promote unavailable data capabilities

**Decision:** Keep every missing Provider state disabled, remove unsupported
cargo-inference claims, keep the unprovisioned company-monitoring worker out of
public health, and classify 519 source-registry entries as `terms-review` even
after Draft PR creation.

**Reason:** A remote commit, passing gate or PR URL proves source-control
delivery, not a market observation, real-time entitlement, AIS cargo fact,
news cause, deployment or third-party licence.

**Consequence:** Draft PR #1 may be reviewed as code, but cannot be cited as
Provider activation or production evidence. Each data-bearing capability still
requires its own lawful source, timestamp, scope, freshness/delay and applicable
display/redistribution authorization.

## D-0030 - A zero-file lint invocation is a failed gate signal

**Decision:** Use cross-platform double-quoted glob arguments in the npm
Markdown lint script and require its output to show the intended non-zero file
count. When diagnosing a platform-specific invocation, also run explicit file
targets.

**Reason:** Windows `cmd` preserved the script's single quote characters, so
markdownlint matched no files and exited `0`. Ubuntu removed those quotes,
scanned 257 files and correctly exposed ten MD022 errors.

**Consequence:** Local `npm run lint:md` now scans the same 257 tracked Markdown
files on Windows and Linux for this tree. The retained failed run is valid
evidence; only a corrected-head rerun can supersede it for the final CI state.

## D-0031 - Unprovisioned seeders stay out of public health

**Decision:** Remove FRED seeder activation and rollout-grace state from public
`/api/health` until a real scheduled deployment and seed result exist. Preserve
the protected operator seed-health endpoint and strict unavailable/partial/
ready thresholds.

**Reason:** A committed seeder, Railway registry entry or planned schedule is
not a deployed capability. Advertising it publicly before its protected
coverage evidence exists creates a false availability claim.

**Consequence:** Public health reports 257 capabilities and no FRED seeder row.
Operators can still inspect and validate the genuine seed state without
exposing credentials or promoting missing data.

## D-0032 - A successful generator exit must mean the generator ran

**Decision:** Resolve direct-run main guards with native-path normalization and
`pathToFileURL`, and detect service protos with `basename` instead of a POSIX
slash suffix. Add Windows-regression coverage and retain generated diffs.

**Reason:** The previous guards exited `0` while silently doing no work on
Windows. That produced a false local freshness signal and allowed the real
39-file OpenAPI diff to appear only in Ubuntu CI.

**Consequence:** The regenerated 222-operation / 204-GET surface is committed,
both injectors pass `--check`, and a repeat generation is observable and
idempotent across platforms. A command that selects zero work is not accepted
merely because its process status is zero.

## D-0033 - Platform-limited full-suite failures remain failures

**Decision:** Retain the Windows `test:data` failure log and require fresh
GitHub Ubuntu workflows for corrected-head acceptance. Do not aggregate focused
passes into a claim that the full suite passed.

**Reason:** The run contains many Windows file-URL/path failures and may also
hide source defects among environment defects. Selectively discarding those
results would weaken the evidence chain.

**Consequence:** Local focused, OpenAPI, type and lint gates are recorded as
passes; the full Windows suite is recorded as 134 failures; Phase 12 remains
remote-CI pending until the new commit receives its own conclusions.

## D-0034 - Independent metadata must not borrow upstream identity

**Decision:** Keep the independent full dashboard on an origin-relative
canonical with no official-upstream hreflang cluster, pricing, founder,
organization, domain or social-account claim. Preserve official metadata only
on the separately declared upstream variant/document surfaces.

**Reason:** Rebranding visible title text while leaving official structured
data and social metadata behind would still present the independent build as
the upstream service and its paid offering.

**Consequence:** The full shell identifies Global Intelligence Earth
contributors, uses relative media/canonical URLs and conservative
source-availability descriptions. CSP hashes are exact across Vercel and both
nginx configurations; deployment/SEO/CSP regression tests pass 192/192.

## D-0035 - Independent and official discovery metadata are generated separately

**Decision:** Require the independent base document to contain zero
official-upstream `hreflang` alternates. When building a separately declared
official variant, insert exactly x-default and English links at that variant's
self-canonical URL. Guard both counts at build time.

**Reason:** Reusing upstream discovery links in the independent shell would
misstate identity, while requiring those links to pre-exist made the official
variant build depend on metadata that the independent shell is forbidden to
publish.

**Consequence:** The independent surface stays origin-relative and
independently branded; each official variant owns its discovery metadata; any
unexpected base alternate or anchor-count drift fails the production build.

## D-0036 - Generated documentation statistics are a commit gate

**Decision:** After a public capability is added or removed, regenerate and
commit `docs/generated/stats.json`; do not treat source tests alone as proof
that tracked documentation is current.

**Reason:** GitHub Test run `31795261786` correctly detected that the public
health implementation had changed from 258 to 257 capabilities while the
tracked generated statistic still contained the old value.

**Consequence:** The regenerated 257 total is included with the source fix,
and the remote docs-stats job remains authoritative for Linux freshness. A
generated count remains documentation, never Provider availability evidence.

## D-0037 - Reuse only complete byte-identical OpenAPI property schemas

**Decision:** Keep the public machine OpenAPI artifact under its fixed 950,000-
character scanner budget by hoisting only complete, direct component-property
schemas that are byte-identical and have positive measured net savings. Keep
2xx responses inline and prove losslessness by expanding every generated ref
and deep-comparing the whole document with the source.

**Reason:** Required stock field/query descriptions correctly increased the
artifact above budget. Removing descriptions or raising the budget would hide
the contract defect instead of preserving both documentation and scanner
compatibility.

**Consequence:** The corrected artifact is 932,903 characters; 68 shared
schemas serve 283 references with 19,317 measured bytes saved. The transform
cannot merge merely similar schemas, and any semantic drift fails the 14-test
round-trip suite.

## D-0038 - Arbitrary-symbol REST operations are not falsely mapped to fixed-universe MCP tools

**Decision:** Classify six arbitrary-symbol stock reads as
`fetch-on-miss: high-cardinality-input` and the disabled forecast/similar reads
as `deferred-to-future-tool` until a truthful dedicated MCP contract exists.

**Reason:** Attaching them to a fixed-universe market-data tool would make the
parity count green while misrepresenting symbol coverage and runtime support.

**Consequence:** MCP parity is complete and explicit without claiming that a
tool, cache, model, Provider or live response exists where it does not.

## D-0039 - Normalize paths only at cross-platform namespace boundaries

**Decision:** Preserve native absolute paths for Windows host process launch
and filesystem access, normalize repository-relative dependency namespaces to
forward slashes for policy comparison, and convert fixture paths to POSIX form
only when crossing into Git-for-Windows Bash.

**Reason:** A global path rewrite would break Windows executables, while raw
backslashes make POSIX route/ownership comparisons and shell fixtures report
false failures. The edge import graph should compare exact resolved paths,
not a platform-dependent string suffix.

**Consequence:** Railway targeted tests pass 82/82, deployment/edge targeted
tests pass 9/9 and the complete pre-push gate passes on Windows without
weakening deployment, ownership, import or truth-boundary assertions.
