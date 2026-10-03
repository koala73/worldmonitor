# Plugin parity acceptance matrix

Status: shared country view implemented; controlled local checks recorded below. Native acceptance and full parity remain open.

Compare the same country, tier and source snapshot. The website renderer is `CountryDeepDivePanel`. Derive section IDs from `BRIEF_SECTIONS`; ordinary countries render 23 of its 24 keys. China adds `china`. CII and resilience are separate summaries. Exclude unavailable measurements from factual comparisons while requiring their unavailable UI to match.

## Native Chrome check after the October 3 UTC reset

The check used the signed-in acceptance Chrome profile. The US website brief was refreshed at 00:00:04 UTC. The country request used **WorldMonitor MCP Acceptance**, connector `asdk_app_6abe6a56ddd08191b65e684c81dfed90`, in the acceptance chat. The tool succeeded with country US and topic all. Its iframe remained on “Connecting to WorldMonitor…”. Chrome requested `country-C1t3d1eZ.js`, which returned 404. The public current build and canonical MCP resource both referenced `country-Dqvrjg_F.js`, which returned 200. The exact deployment asset origin required authentication.

The browser used cached resource HTML from an earlier deployment. The cache-safe shell repair has controlled browser proof. Production acceptance remains blocked until this repair is merged, deployed and the acceptance connection discovers its v2 UI resources. Legacy resource reads remain aliases for existing descriptors; the obsolete raw cached HTML requires one connection refresh. New cached shells load the current panel document on each mount and show an interface retry on failure.

| Requested view | Refreshed website observation | Native ChatGPT observation | Difference and next proof |
|---|---|---|---|
| Country panel | 23 sections ready | Tool succeeded; iframe did not initialize | Repair asset delivery before comparing section values |
| CII | 43, Normal, falling, October 2 19:49 New York | No rendered value | Compare score and observation time after repair |
| Resilience | 59, interval 58–59, 87% coverage | No rendered value | Compare domains, confidence and entitlement |
| Five factors | Food 5, energy 4, demographics 4, technology 5, defense 5 | No rendered values | Compare underlying evidence |
| Signals | 3 critical news and 1 aviation; high, moderate and low counts 0 | Projection remains missing in plugin code | Separate implementation gap after delivery repair |
| Military | Own flights 0, foreign flights 0, naval 0; defense 3.4% in 2024; personnel 1,395,000 in 2020 | No rendered values | Compare same flight rights, dates and partial coverage |
| IMF | Growth 2.3%, inflation 3.2%, unemployment 4.4% | No rendered values | Compare same country and dataset observations |
| BIS | Residential 154.2 and commercial 187.3 in 2026 Q2; household DSR 8.0 in 2026 Q1 | No rendered values | Compare values, dates and missing-source notices |
| Atlas | No asset rows in this website snapshot | No rendered rows; PR #8799 remains unmerged | Recheck populated source coverage and original detail actions after merge |
| Usage | Website is a separate entitlement path | The opening tool succeeded; widget usage notice could not render | Controlled shell check uses one allocation; native accounting remains open |
| Installed cloud plugin | WorldMonitor version 2.10.1 visible as installed | Its headline starter redirected to Open ChatGPT Desktop | This is a separate installation path from the MCP Acceptance connection |

The website and acceptance connection's tiers have not been proved equal. These are captured observations, not a value-parity pass. News map markers, 2D and 3D interaction, host follow-up context and composer obstruction still need native production checks. Compact-panel parity remains open.

## Country data and sections

| ID | Surface | Existing data/render owner | Required proof | Current verdict |
|---|---|---|---|---|
| C01 | CII summary | Cached risk score, `CountryDeepDivePanel-cii` | Same score, components, band, trend, observation time; no zero on outage | Shared renderer and host risk read; outage fixture shows unavailable; live score comparison open |
| C02 | Resilience summary | `ResilienceWidget`, resilience service | Same domains, confidence, imputation/staleness and gate states | Shared widget and scoped source; denial fixture verified; live domain comparison open |
| C03 | Assessment | Country AI endpoint, `updateBrief` | Exact accepted assessment, citations and generation time; unsafe claims withheld | Shared assessment renderer; server quality risk remains open |
| C04 | Facts | `getCountryFacts`, `updateCountryFacts` | Same leadership, capital, population, area and source context | Shared renderer; US/UA facts, switching and lowercase input normalization verified with fixtures |
| C05 | Five factors | Scorecard service and renderer | All five factors and exact underlying measurements, keyboard tabs | Shared renderer; exact factor evidence fixture verified |
| C06 | Signals | Dashboard observations and signal projection | Same severity, counts, temporal scope and recent items | Explicit unavailable state; dashboard signal projection missing |
| C07 | Timeline | Country coverage/event projection, `CountryTimeline` | Same dated events and lanes, visible empty state | Shared timeline and host coverage; populated lane comparison open |
| C08 | News | Country coverage and news renderer | Same country relevance, deduplication, publisher roster and URLs | Shared news and host coverage; source-link fixture verified |
| C09 | Military | Military projection, defense-industrial service | Same activity scope and defense details; unavailable is not calm | Shared military projection and bounded flight/AIS/roster reads implemented; controlled desktop/mobile and failure checks; native comparison open. Redistributable flight coverage may differ from website display rights. The country read budget bounds flights to eight pages of 100; incomplete pagination shows unavailable counts. AIS uses one global relay snapshot, bounded to 1,500 candidate reports, then the shared country projection. Invalid report dates are excluded with a partial-coverage notice. |
| C10 | Sanctions | Pro section loader | Same entity count, active status and source scope | Shared renderer and server-authorized risk read; populated comparison open |
| C11 | Economics | IMF bundle and economic projection | Exact series, units, trends and native period labels | Native IMF read falsely returned locked; public single-key bootstrap repair verified locally; deployed comparison open |
| C12 | Housing | Housing-cycle loader | Exact availability, periods and values | Native BIS read falsely returned locked; public single-key bootstrap repair verified locally; deployed comparison open |
| C13 | Debt | National-debt loader | Debt ratio, debt amount, annual change and source | Shared loader/renderer; populated comparison open |
| C14 | Trade flows | Comtrade loader | Same partners, products, values and changes | Shared loader/renderer; populated comparison open |
| C15 | Tariffs | Tariff loader | Same current rate, historical series and direction | Shared loader/renderer; populated comparison open |
| C16 | Trade exposure | Chokepoint index and sector exposure | Same routes, sector weights and uncertainty | Shared projection/renderer; empty-state fixture verified |
| C17 | Scenario | Multi-sector cost shock | Same selected route/duration and calculated results | Shared calculator/source; no-exposure terminal state verified |
| C18 | Products | Country product imports | Exact products, suppliers, concentration and bypass details | Shared renderer/source; populated products/bypass comparison open |
| C19 | Prediction markets | Country markets | Same contracts, probability, provider and resolution links | Shared renderer and scoped markets source; populated comparison open |
| C20 | Energy | Country energy profile | Availability flags, mix, JODI, IEA and native dates preserved | Shared renderer/source; native observation comparison open |
| C21 | Maritime | Country port activity | Same port/cargo scope, trends, anomalies and dates | Shared renderer/source; populated port comparison open |
| C22 | Commodities | Country vulnerability loader | Same commodity dependencies and scenario inputs | Shared renderer/source; populated vulnerability comparison open |
| C23 | Food | Country and WORLD food stocks | Marketing years, stocks availability and global comparison preserved | Shared loader/renderer; stocks ratio and marketing-year fixture verified |
| C24 | Infrastructure | Related assets and disruption readers | Same assets and applicable current disruptions | Country Atlas counts and active shortage rows use fixed host readers. Original pipeline/storage/shortage drawers render details and sources; pipeline/storage timelines remain independent on outage. Country-bound asset identity, one allocation, agent actions, cancellation and desktop/mobile layout verified with compiled fixtures. Native comparison remains open. |
| C25 | Demographics | Demographics capability service/renderer | Same observations, imputation and unavailable values | Shared loader/renderer; populated/imputed comparison open |
| C26 | China conditional section | China decision signals | CN-only groups, provenance, translations, stale/unavailable states | Shared CN projection/renderer; website regression verified; native comparison open |

Shared rendering does not prove complete data or action parity. A populated observation comparison remains required wherever the verdict says open.

## Country actions and host behavior

| ID | Interaction | Acceptance check | Current verdict |
|---|---|---|---|
| A01 | Ordinary prompt | “USA country brief” opens the shared view in signed-in ChatGPT | View tool/skill/prompt implemented; native routing unverified |
| A02 | Follow-up | “Show energy exposure” changes topic and keeps the same country/revision in assistant context | Topic/context bridge implemented and fixture verified; native follow-up open |
| A03 | Country switch | US to JP with delayed US responses cannot repaint JP | Delayed US work cannot repaint UA in compiled iframe fixture |
| A04 | Topics/reading modes | Overview, full brief, topics and keyboard section navigation reuse website behavior | Shared topic/reading presentation; desktop/mobile fixture checks |
| A05 | Refresh/failure | One section failure preserves others and labels older successful data | Facts failure retains old observations and labels failure in fixture; lazy host refresh verified; assessment quota reused unless explicitly regenerated |
| A06 | Entitlement change | Server denies restricted reads; UI clears denied private data and shows a gate | Server denial and visible gate fixture verified; website revocation clears trade evidence and blocks cached reuse; live entitlement-change check open |
| A07 | Source links | Open valid source links through supported host actions without losing view | Host source-link fixture verified; native handoff open |
| A08 | Evidence export | Actual Markdown has matching evidence, sources and observation dates | Shared output mounted; actual evidence Markdown comparison open |
| A09 | Report/story | Actual downloaded output matches current country/sections and remains safe | Actual report HTML fixture inspected; story comparison open |
| A10 | Decision/commodity outputs | Inputs, calculations, evidence and actual outputs match website | Actual scenario JSON fixture inspected; commodity output comparison open |
| A11 | Account actions | Follow/notifications work inline under appropriate scope, or clearly disclose a website handoff | Explicit website handoff; inline mutation parity open |
| A12 | Responsive/native host | Desktop and mobile avoid overflow/composer obstruction; expand preserves conversation | Desktop/mobile fixture layout verified; native composer/expansion open |

## Other embedded surfaces

| UI tool | Website baseline to locate | Required next check | Current verdict |
|---|---|---|---|
| `get_country_risk` | Country CII/risk presentation | Compare all risk measures, times and outage states | Compact card; behavioral parity unaccepted |
| `get_world_brief` | World assessment presentation | Compare assessment, source coverage and relevant actions | Compact card; behavioral parity unaccepted |
| `get_market_data` | Market panels | Compare quote scope, timestamps, charts and filtering | PR #8813 restores loaded names, rows, charts and projection samples in controlled tests; deployed native parity unaccepted |
| `get_chokepoint_status` | Chokepoint/transit presentation | Compare routes, periods, risk and drill-down | Compact card; behavioral parity unaccepted |
| `get_news_intelligence` | News intelligence presentation | Compare sources, classifications and evidence actions | Compact card; behavioral parity unaccepted |
| `get_conflict_events` | Conflict map/presentation | Compare actual events, markers, dates and selection | Compact card; behavioral parity unaccepted |
| `get_natural_disasters` | Hazard map/presentation | Compare events, layers, dates and detail interactions | Compact card; behavioral parity unaccepted |
| `get_prediction_markets` | Prediction panels | Compare providers, contract links, probabilities and resolution | Compact card; behavioral parity unaccepted |
| `get_forecast_predictions` | Forecast presentation | Compare event definition, horizon, uncertainty and calibration | Compact card; behavioral parity unaccepted |
| `open_news_dashboard` | News panels and map | Complete 2D/3D, marker selection, layer/filter and country integration | Scoped real components; full acceptance incomplete |

Baseline owners must be located before promising feature-specific widget changes. A data-only utility can remain data-only. New UI tools should represent user workflows, not duplicate all 84 data tool names.

## Implemented unit checks

- `e2e/plugin-country-view.spec.ts` drives the actual compiled entry in an opaque sandbox. It checks the ordinary section mounts, host-only reads, source handoff, model context, desktop/mobile widths, retained facts after failure, delayed country switching, actual report HTML and scenario JSON downloads.
- `tests/country-brief-host-transport.test.mts` checks fixed routes, credential exclusion, country/section identity, cancellation, a three-call limit and generated-client zero-baseline serialization.
- `tests/mcp-country-view.test.mjs` checks reader validation, signed downstream access, access denial, billing/backoff handling, fixed-origin resource loading and CSP.
- Existing MCP regression suites cover caller contracts, policy, weights, quotas, resources and version inventory. Existing website country tests remain separate regression gates.

## Executed baseline checks

- Public resource audit read all 11 linked UI resources successfully. Counts are from the saved production tools discovery. Template availability is not native rendering proof.
- Existing Chromium test `US brief keeps late evidence, metric design and report data connected` passed on reviewed main. It uses fixtures and checks source measurements, scorecard inputs, report download contents, CSP and mobile output layout. It does not test plugin OAuth or live source freshness.
- Existing compact-widget suite `tests/mcp-country-brief-app.test.mts` passed two tests. It verifies assessment/date/evidence rendering. Passing it demonstrates why the old test boundary cannot establish full country parity.
- The shared catalog extraction preserves the original exports. All three existing presentation regressions passed after that change. This proves the extraction preserves those behaviors; it does not prove full plugin parity.
- Signed-in Chrome session inspection timed out during baseline review. No native country-view pass is recorded. The compiled fixture view was manually inspected in the in-app browser.

## Delivery gates

### Signed-in acceptance checkpoint, 2026-10-02

Production deployment of the panel-metering merge succeeded at 15:22 UTC. The signed-in Chrome conversation `Open USA brief` shows the country view tool and the native news-and-map iframe. The latest news call returned HTTP 429 with the 50/day allowance exhausted. That response supplies no headline or marker evidence. It resets at 2026-10-03 00:00 UTC. Native acceptance remains incomplete.

| Website output | Observed ChatGPT output | Difference and repair status |
|---|---|---|
| IMF economics and BIS housing use public on-demand bootstrap data | Exact IMF and housing section calls returned `locked` despite an authorized connection | The MCP readers used the legacy authenticated multi-key URL. Fixed single-key public URLs preserve the existing bundle shape. Real bootstrap-handler integration verifies seven dataset reads consume one country allocation. Native retest awaits deployment and quota reset. |
| Complete data can be reused; missing datasets can recover | A partial bootstrap bundle could remain cached by the panel receipt and browser transport | Partial bundles are excluded from both caches. Recovery checks verify retries and subsequent reuse without an extra allocation. |
| Dashboard shows country signals and military observations | The inspected country context reported signals and military unavailable | The military projection now shares the website owner and has controlled activity/outage checks. Signals remain open. Fresh native comparison remains open. |
| News panels and map display current source data | A new call hit quota exhaustion; an existing expanded app renders populated news and 2D/3D markers | Loaded-snapshot rendering and local search were observed. Fresh request, usage notice, error delivery and recovery remain open. |

Further inspection of the existing expanded `WorldMonitor MCP Acceptance` app showed populated news panels and markers in both the 3D globe and the 2D WebGL map. Local search found the Afghanistan article and applied its Asia-Pacific category. This proves rendering and navigation of the loaded snapshot. It does not prove a fresh paid request or the receipt/usage notice. The host composer covers part of the expanded map. Chrome also lists a separate installed `WorldMonitor` cloud plugin at version 2.10.1; acceptance must identify which connection supplies each tool call.

Bootstrap recovery now preserves successful siblings when another dataset times out, fails or returns an invalid payload. The shared country renderer labels missing measurements as partial coverage and clears the notice after recovery. This warning is included in the model's rendered context and report capture. These checks remain controlled local evidence until the repair is deployed and tested natively.

Local integration, renderer fixtures, merged source, production deployment and native acceptance are separate verdicts. This checkpoint does not establish store readiness.

Run focused existing behavior tests first. Browser changes also require `npm run typecheck` and `npm run lint:boundaries`; MCP/API changes require `npm run typecheck:api` and focused handler/quota tests. Add only regressions needed for the matrix failures. Preserve the existing 84 tool schemas and subscription behavior.

For each UI PR, attach inspected desktop/mobile screenshots at the tested commit and failure/recovery views when applicable. A local preview, template read, green CI, merge and deployment are distinct evidence states. Native acceptance begins after the exact asset/tool version is deployed and the installed plugin definitions are refreshed.

## Local verdict, 2026-10-01

The full non-built-output unit suite passes 33,963 tests, with 19 skips and no failures. The compiled country-view suite passes all three tests. The existing website US evidence/report and limited-country/China tests pass. All 2,213 MCP tests pass, including the new transport checks. All 1,686 DOM tests pass, including country switching, entitlement revocation and existing-panel initialization. The website build passes the unchanged bundle budget and all 1,932 built-output tests. Lazy military-card refresh is now covered by a runtime barrier test. The original text-only country prompt retains its executable risk, assessment and macro steps; the interactive view has a separate prompt. Browser/API typechecks, architectural boundaries, product inventory and source-attribution checks pass. Biome reports no errors; its existing repository warnings are outside this change.

These checks do not establish live source freshness, ordinary ChatGPT prompt routing or full parity. The open rows above remain delivery gates for that broader objective.

## Country Signals partial repair, 2026-10-03

| Website behavior | Embedded behavior in this unit | Verification and remaining difference |
|---|---|---|
| Military Signals count observations near the country, with separate counts inside its borders | Reuses the military panel's licensed observations and the same shared near/inside projector | Controlled country scope and precise negative geometry checks; no new host reader or data call. Live source and redistribution differences still require matching native observations. |
| Loaded country Signals persist while CII updates | Score-only updates preserve loaded counts and agent context | A score refresh with no Signals cannot erase them; existing website severity totals and recent evidence survive count refreshes together. |
| Signals sources and aggregate country-cluster details are independent inputs | Four military fields are observed or null. Other 24 fields and aggregate severity/recent details are explicitly unavailable | Nullable coverage prevents fabricated zero counts or severity totals. Full 28-field and 24-hour/1,000-observation aggregator parity remains open. |
| Country navigation reuses loaded observations | Topic navigation reuses Signals and military observations | Compiled opaque-iframe regression covers observed, source-outage retention, recovery and authorization loss, one allocation per refresh, navigation reuse and desktop/mobile layout. This is controlled local evidence; deployment and native acceptance remain pending. |

The website's existing severity and three-recent-item projection is now a shared pure function. Country selection, timestamps, pruning, global cap and targeted theater replacement remain with the existing aggregator. The embedded military subset does not claim to reconstruct that aggregator. No tool schema, allowance, host registry or provider changes are included.

## October 3 market chart checkpoint

[PR #8813](https://github.com/koala73/worldmonitor/pull/8813) restores chart inspection from the same loaded market series. This is controlled local proof and PR delivery; it does not establish deployed ChatGPT acceptance.

| Website behavior | Plugin baseline | Repair proof | Remaining acceptance |
|---|---|---|---|
| MarketPanel shows asset names and loaded quotes | Each class capped again at eight rows; names omitted | Every loaded or sampled quote, including summary/JMESPath projections; name-only sectors retained | Compare matching live source observations after deployment |
| Original intraday chart opens from loaded series | Series discarded | Shared miniSparkline and terminalChart; full chart created on first keyboard expansion and reused on reopen | Confirm live series availability and native host interaction |
| Missing measurements remain unknown | No chart coverage explanation | Missing series, null prices/changes and supplied source limits/dates remain explicit | Curated seed cannot explain arbitrary-symbol absence |
| Loaded inspection does not fetch again | Compact result only | Desktop/mobile opaque iframe sends no extra tool calls; remaining usage stays 47 | Verify native allocation, refresh accounting and notices |
| Account watchlist and requested-symbol lookup | No matching account write or arbitrary query | Outside this chart unit; no fake persistence or provider failure inference | Separate authenticated source and metering work |

Verification includes 198 focused market/chart/resource, anonymous conformance, usage and CI-inventory checks in Pacific/Auckland, browser/API types, plugin build, boundaries, safe HTML, docs/discovery and the actual pre-push gates. Two permanent desktop/mobile CI browser tests load the real Vite document, CSS and module through the resource bootstrap. Controlled screenshots show fourteen loaded rows versus ten before, with the chart available from eleven supplied series. Fourteen inspected UI images are attached to the PR, including six refreshed after review repairs. Remote CI, merge, deployment, source freshness and native acceptance remain separate verdicts.


Review repairs preserve same-country loaded military Signal counts on an unavailable refresh and label them as previously loaded, not fresh. Authorization loss clears the affected counts, and a successful observed zero replaces a prior positive count. A new country does not inherit old counts. An empty flight RPC remains unknown because the producer returns the same empty shape for source failures and the host registry explicitly rejects unconfirmed initial empties. AIS supplies a separate connected-snapshot coverage contract. Unknown temporal observations also leave initial aggregate severity unknown.

The initial DOM-test typecheck failed because a fixture used `Strike` instead of the typed `MILITARY` value. The repaired fixture and refresh regressions run through the actual DOM-test typecheck before delivery; the initial CI failure is not a passing validation result.
