# Plugin parity acceptance matrix

Status: shared country view implemented; controlled local checks recorded below. Native acceptance and full parity remain open.

Compare the same country, tier and source snapshot. The website renderer is `CountryDeepDivePanel`. Derive section IDs from `BRIEF_SECTIONS`; ordinary countries render 23 of its 24 keys. China adds `china`. CII and resilience are separate summaries. Exclude unavailable measurements from factual comparisons while requiring their unavailable UI to match.

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
| C09 | Military | Military projection, defense-industrial service | Same activity scope and defense details; unavailable is not calm | Defense read and gate mounted; live flight/vessel projection missing |
| C10 | Sanctions | Pro section loader | Same entity count, active status and source scope | Shared renderer and server-authorized risk read; populated comparison open |
| C11 | Economics | IMF bundle and economic projection | Exact series, units, trends and native period labels | Shared IMF/stock projection; populated comparison open |
| C12 | Housing | Housing-cycle loader | Exact availability, periods and values | Shared renderer; BIS values and native quarterly period verified |
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
| C24 | Infrastructure | Related assets and disruption readers | Same assets and applicable current disruptions | Geometry/tables available; Atlas counts/detail actions incomplete |
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
| `get_market_data` | Market panels | Compare quote scope, timestamps, charts and filtering | Compact card; behavioral parity unaccepted |
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

Run focused existing behavior tests first. Browser changes also require `npm run typecheck` and `npm run lint:boundaries`; MCP/API changes require `npm run typecheck:api` and focused handler/quota tests. Add only regressions needed for the matrix failures. Preserve the existing 84 tool schemas and subscription behavior.

For each UI PR, attach inspected desktop/mobile screenshots at the tested commit and failure/recovery views when applicable. A local preview, template read, green CI, merge and deployment are distinct evidence states. Native acceptance begins after the exact asset/tool version is deployed and the installed plugin definitions are refreshed.

## Local verdict, 2026-10-01

The full non-built-output unit suite passes 33,963 tests, with 19 skips and no failures. The compiled country-view suite passes all three tests. The existing website US evidence/report and limited-country/China tests pass. All 2,213 MCP tests pass, including the new transport checks. All 1,686 DOM tests pass, including country switching, entitlement revocation and existing-panel initialization. The website build passes the unchanged bundle budget and all 1,932 built-output tests. Lazy military-card refresh is now covered by a runtime barrier test. The original text-only country prompt retains its executable risk, assessment and macro steps; the interactive view has a separate prompt. Browser/API typechecks, architectural boundaries, product inventory and source-attribution checks pass. Biome reports no errors; its existing repository warnings are outside this change.

These checks do not establish live source freshness, ordinary ChatGPT prompt routing or full parity. The open rows above remain delivery gates for that broader objective.
