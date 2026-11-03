# Zapier event triggers: evidence, backtest and design

Date: 2026-10-17. Scope: redesign the WorldMonitor Zapier integration (`integrations/zapier/`, app 248027) around events users act on, backed by the existing push infrastructure. This document records the evidence (Phase 1) and the design that shipped (Phase 2). Production was read-only throughout: no Redis writes, no seeder runs, no Convex mutations, no Zapier push.

## Decision

Ship two instant (REST-hook) triggers on the existing Shipping v2 webhook path, keep the existing searches and the polling disease-outbreak trigger, and define every event once in a surface-neutral registry (`shared/event-triggers.json`) so the MCP Events extension (#9268) can expose the same events later.

| Trigger | Event | Id | Threshold and why | Cooldown | Fires/day (backtest) | Precision vs outside source | Known misses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New Chokepoint Disruption | `chokepoint.disruption`: `disruptionScore >= alertThreshold` (default 50, red band) and live signal (score minus standing threat level) `>= minLiveSignal` (default 15 in Zapier) | `X-WM-Delivery-Id` (`whd_` + 32 hex), minted once per upward crossing, kept across retries | 50 is the documented red band; the live floor exists because Hormuz and Kerch stand at 70 and would fire once at subscription and never again. 15 equals the in-app `chokepoint_disruption` rule, and every observed 2026 band change carried 15 or more live points (Suez 30 to 50, Dover 15 to 30, Malacca 10 to 20, Hormuz 70 to 85) | Hysteresis: with a live floor, re-arm when the score is 10 under the threshold or the live signal under 5, refire at most once per 12 h (the in-app rule's floors), with missing-source compensation | Weekly samples (9 editions, Aug 30 to Oct 12): 4 crossings over 13 chokepoints in 43 days, about 0.09/day across the fleet, median 0/day. Transit-drop component replayed daily over 175 days: Hormuz 22 signal days, Kerch 35, all other chokepoints 0 | 9 reconstructed events checked: 4 TP (Hormuz Oct 5 to 12 attack wave, UKMTO reports; Hormuz transit collapse Jun 1 and Jul 15 to 16; Kerch closure Jul 7 to 10), 1 TP on the wrong entity (the Sep 8 to 14 Houthi Red Sea offensive raised Suez to red while Bab el-Mandeb, where it happened, stayed at 40), 2 artifacts (Hormuz Aug 2 to 6 and Kerch Aug 8 to 10 re-fire a drop the 30-day baseline had not yet absorbed), 2 FP (Dover Sep 4, 7 warnings and no incident; Malacca Oct 12, transits normal). Strict 4 of 9, 5 of 9 counting the mis-attributed Suez fire | Bab el-Mandeb never left 40 during the Houthi blockade of Saudi shipping (from Jul 20), the Faize Noore Oliya sinking (Aug 4) and the Perim and Hanish seizures (Sep 11 to 14); Black Sea ships sunk off Bulgaria (Oct 6 and 13, no monitored chokepoint); Damietta LNG tanker strike (Jul 29, not a chokepoint) |
| New Country Risk Surge | `country.risk_surge`: Country Instability Index `dynamicScore` (24 h movement) `>= 15` while `combinedScore >= 70`, ignoring a tick whose `staticBaseline` changed | `X-WM-Delivery-Id`, once per surge per country | 10 points fired 2.9/day over 24 countries and tracked news-volume blips; 15 fired 0.9/day. The first tuning (floor 50) checked against wire reports gave 17 TP / 17 WEAK / 14 FP over 48 fires with every TP in the high band, so the floor moved to 70 (keeps 15 of 17 TP, drops 5 FP) and a baseline-change guard removes the Brazil and Mexico static re-levellings (4 non-events) | Re-arm when `dynamicScore < 5`; at most one delivery per country per 24 h; disarm on a baseline edit | Floor 70: 69 fires in 90 days before the baseline guard (0.77/day, median 1, p95 3, max 7); about 0.7/day after it | On the 48 checked fires re-scored to the shipped rule: 15 TP / 13 WEAK / 9 FP before the guard, about 14 / 11 / 7 after it (strict 44 percent, 78 percent counting minor incidents). Per country: Iran, Ukraine, Russia 15 TP / 10 WEAK / 1 FP; China, Turkey, Iraq, Syria, Afghanistan 0 TP / 2 WEAK / 6 FP | Houthi seizure of Mokha, Perim and Hanish (Sep 10 to 14, Yemen's index flat at 70); Houthi strike on Riyadh airport (Oct 10, Saudi Arabia flat at 50); Kohat bombing and Pakistani strikes into Afghanistan (Sep 18 to 30); Ukraine's mass drone attack on Moscow (Sep 20); Bucha depot strike (Aug 28, 37 killed); Kramatorsk bus strike (Oct 8, 33 killed); Myanmar Kyauktaw airstrike (Sep 28, no index movement) |

Dropped: airspace closure (no data), resilience jump (no movement), conflict activity burst (see below).

## Phase 1 evidence

### Who polls what (Axiom `wm_api_usage`, API keys, 2026-09-17 to 2026-10-17)

`auth_kind in ('user_api_key', 'enterprise_api_key')`, 30 days:

| Route | Requests | Customers | Median per customer per day | Max per customer per day |
| --- | --- | --- | --- | --- |
| `/api/supply-chain/v1/get-chokepoint-status` | 208,739 | 32 | 6.9 | 6,403 |
| `/api/supply-chain/v1/list-pipelines` | 192,423 | 13 | 0.2 | 6,403 |
| `/api/intelligence/v1/list-cross-source-signals` | 90,705 | 20 | 7.1 | 1,995 |
| `/api/economic/v1/get-economic-calendar` | 88,049 | 16 | 1.0 | 2,803 |
| `/api/news/v1/list-feed-digest` | 58,014 | 30 | 18.1 | 836 |
| `/api/intelligence/v1/get-country-risk` | 21,711 | 24 | 3.1 | 483 |
| `/api/conflict/v1/list-acled-events` | 11,952 | 26 | 1.4 | 144 |
| `/api/intelligence/v1/get-risk-scores` | 11,488 | 23 | 2.0 | 144 |
| `/api/conflict/v1/list-ucdp-events` | 8,663 | 23 | 0.5 | 144 |
| `/api/aviation/v1/list-airport-delays` | 2,308 | 11 | n/a | n/a |
| `/api/resilience/v1/get-resilience-score` | 1,224 | 8 | n/a | n/a |

Chokepoint status is the most polled API-key route by a wide margin, with one customer polling it every 13 seconds. Country risk and risk scores are polled by about 24 customers each. Airport delays and resilience draw little traffic.

### Where the data lives and what history exists

| Candidate | Current data | History available for a backtest | Push today |
| --- | --- | --- | --- |
| Chokepoint disruption | `supply_chain:chokepoints:v4`, computed by the RPC, warm-pinged every 30 min, 5-min cache | No score history. Reconstructed from: nine weekly `crawlable-live-pulse-*.json` editions in git (Aug 30 to Oct 12; score, status, warning count per chokepoint), 175 days of daily PortWatch transit counts (`supply_chain:transit-summaries:history:v1:*`), and the static threat tiers | Shipping v2 webhooks (`scripts/shipping-webhook-worker.mjs`, live since 2026-10-17, #9217) and the in-app `chokepoint_disruption` event |
| Airspace or airport closure | `aviation:notam:closures:v2` (60 airports, ICAO NOTAM Q-codes); no FIR-level or national airspace data exists anywhere in the codebase | Regional snapshots (`intelligence:snapshot-by-id:v1:*`, 5,754 snapshots, 8 regions, every 6 h since 2026-07-19) record `mobility.notam_closures`: empty in all 5,754. The closures key is empty today | `notam_closure` events on the relay bus |
| Country Instability Index | `risk:scores:sebuf:v8` (31 countries, every 8 min) with `dynamicScore` = 24 h movement | `risk:scores:sebuf:trend-history:v8:*`: 427 ten-minute buckets, 3 days. Regional snapshots record `cii_spike` evidence for countries at or above 50: 13,190 readings, 24 countries, 90 days at 6 h resolution | None |
| Resilience score | `resilience:score:v29:*`, every 6 h | `resilience:history:v23:*`: 198 countries, daily since 2026-10-08 (10 days; earlier versions hold only April to May). Monthly frozen editions in `docs/snapshots/` | None |
| High-severity conflict event | `conflict:acled:v1` is GDELT CAMEO 18x to 20x article events for 20 watchlist countries (about 456 rows/day), no fatality field; UCDP candidate events lag about six weeks (latest `dateStart` 2026-08-31 on 2026-10-17) | Convex `intelHistory` (domain `conflict`), 38,565 rows from 2026-07-29, pulled read-only with `npx convex run intelHistory:timeline` | `conflict_escalation` (UCDP deaths >= 10) on the relay bus |

### Push infrastructure

Two outbound systems exist. Shipping v2 webhooks are API-key authenticated (`POST /api/v2/shipping/webhooks`), return a subscriber id and HMAC secret, are delivered by an always-on Railway worker with per-subscriber threshold, hysteresis, fenced compare-and-set writes, a five-failure deactivation ceiling and `X-WM-Signature` / `X-WM-Event` / `X-WM-Delivery-Id` headers; they had no unsubscribe route, a 30-day TTL, and one event. The notification relay delivers in-app alert rules to Slack, Teams, Discord, email and one webhook per Clerk user, is Clerk-session only, and has no API-key CRUD. The Zapier triggers therefore reuse Shipping v2 and generalize it by event type rather than adding a third path.

### Zapier marketplace

No Zapier app offers triggers for geopolitical or conflict events, country-risk changes, sanctions, travel advisories, chokepoint or port disruption, vessel or AIS events, airspace or NOTAM, or severe-weather alerts (Weather by Zapier has none). Comparable risk vendors (Everstream, Resilinc, Interos, Riskline, Crisis24, Windward, MarineTraffic) have no listings; Dun and Bradstreet and Black Kite list no triggers. State-change triggers in the directory are phrased "New or Updated X" (PagerDuty, ilert) and carry scope selectors as dynamic dropdowns, not severity inputs. Zapier platform rules that shaped the design: REST-hook deliveries are not deduplicated by Zapier (check D010), so cooldown and idempotent ids are the sender's job; a hook trigger needs `performList` for samples (D006); `performSubscribe` receives `bundle.targetUrl` and its response becomes `bundle.subscribeData`; an `expiration_date` in that response makes Zapier re-subscribe before expiry. Sources: zapier.com app directory pages and docs.zapier.com/platform/build/hook-trigger, /deduplication, /trigger (fetched 2026-10-17).

## Candidate backtests

### Chokepoint disruption

Definition: fire when `disruptionScore >= alertThreshold` and `disruptionScore - standingThreatLevel >= minLiveSignal`; re-arm when the score is 10 under the threshold or the live signal under 5, and refire at most once per 12 h. The first version re-armed at the fire floors, and a review replay showed a warning count wobbling 3, 2, 3 refiring every step: one warning is 5 points, so the gap must exceed one step.

Backtest window: no score series is stored, so three reconstructions were used. Weekly pulse editions (9 samples, Aug 30 to Oct 12) show scores nearly static: Hormuz 70 then 85 on Oct 12 (3 warnings), Kerch 70 throughout, Bab el-Mandeb 40, Bosphorus 30, Suez 30, 35, 50 (Sep 9), then 35, Dover 15 then 30 from Sep 4 (7 warnings), Malacca 5, 15, 10, 20 (Oct 12), Taiwan 20 to 25, Panama 0 to 5, the rest flat. Band changes: 4 in 43 days. The transit-drop rule (`shared/chokepoint-traffic-anomaly.js`, 7-day transits at least 50 percent under the prior 30-day baseline at war-zone or critical tiers) replayed over 175 days of PortWatch counts fired on 22 Hormuz days (Jun 1, Jul 15 to 16, Aug 2 to 6 and others) and 35 Kerch days (Jul 7 to 9, Aug 8 to 10 and others), never elsewhere. The snapshot archive's own `hormuz_transit_drop` trigger stayed dormant in all 720 MENA snapshots.

Why the live floor: with only a score threshold, a threshold of 50 fires immediately for Hormuz and Kerch and then never, which is what the #9217 production acceptance showed with a threshold of 0 on Suez. Every observed band change carried at least 15 live points, so the floor loses none of them.

Caveats found in the data: the Hormuz PortWatch series has a median of 4 transits a day (Kerch 2), far below real traffic, so the transit-drop component rests on a thin subset of PortWatch calls and its percentages are noisy; the warning component has no history at all, so intra-week warning spikes between the weekly samples are invisible.

### Country risk surge

Definition as shipped: fire when `dynamicScore >= 15` and `combinedScore >= 70`, ignoring a tick whose `staticBaseline` changed; re-arm below 5; one delivery per country per 24 h. The backtest below was run on the first tuning (floor 50); the ground-truth section explains the move to 70 and the baseline guard.

Backtest window: 90 days (2026-07-19 to 2026-10-17) of 6-hourly regional snapshots, 24 countries, 11,054 steps; the 24 h movement was reconstructed as the rise over the minimum of the prior 24 h. Fires per day for the candidate thresholds, with a 24 h cooldown per country:

| Rise | Floor | Fires in 90 days | Per day | Median per day | p95 per day | Max per day | Top countries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 50 | 259 | 2.88 | 3 | 6 | 10 | UA 56, IR 44, RU 44, CN 24, TR 22 |
| 15 | 50 | 79 | 0.88 | 1 | 3 | 7 | RU 22, UA 14, IR 11, IQ 7, CN 5 |
| 20 | 50 | 28 | 0.31 | 0 | 1 | 4 | RU 7, IR 5, UA 4, BR 4, IL 3 |

Caveats: the snapshot evidence is censored at 50 (only countries at or above 50 are recorded), so crossings from below 50 are seen as a country appearing; the live feed carries every country, which is why the floor is part of the rule. BR, MX and PK show one-off 20-point steps (50 to 70) with a p95 step of 0: static-baseline edits, not events, which is why the rule reads `dynamicScore` from the live feed (baseline edits move it for 24 h at most) and the floor plus the re-arm rule keep a single step from re-firing. Twenty 6 h ticks had three or more countries rising 15 or more at once (2026-08-01, 08-05, 09-01, 10-01, 10-14): these are either real multi-theater escalations or ingestion effects and were checked below. The 3-day 10-minute series shows low-baseline countries (DE, FR, GB, JP, KR, PL, US, TW) swinging up to 14 points within 10 minutes and back; the floor of 50 keeps those out.

### Conflict activity burst (dropped)

Definition tested: 20 or more GDELT conflict events (CAMEO 18x to 20x) for a country in a 6 h window and at least 3 times the country's median 6 h count over the prior 7 days, 24 h cooldown.

Backtest window: 80 days (2026-07-29 to 2026-10-17), 38,565 rows. Fires: 66 (0.84/day, median 1, p95 3, max 4): YE 14, PS 12, SY 9, AF 8, UA 5, ET 5, NG 3. At 10 events it fires 1.97/day; at 30, 0.46/day.

Why dropped: the feed is article mentions for 20 countries with no fatality or severity field, so a burst is a media-volume spike, and the Country Instability Index already carries news activity and military activity for the countries customers poll. The outside-source check is recorded below for completeness; the trigger adds a second, noisier country-level signal on a smaller country set and was not built.

### Airspace closure (dropped)

No FIR-level or national airspace data exists. The only aviation closure data is airport-level ICAO NOTAM closures for 60 airports, and in 90 days of 6-hourly snapshots the `notam_closures` block was empty every time; the live key is empty today. There is nothing to backtest and nothing a Zap could act on. Note for a separate fix: the snapshots' `mobility.airports` "closed" status is derived from flight-delay severity (`FLIGHT_DELAY_SEVERITY_SEVERE`), not NOTAMs; Los Angeles reads "closed" in 621 snapshots.

### Resilience score jump (dropped)

198 countries, daily history since 2026-10-08 (1,766 day pairs): median absolute daily change 0.04, p95 0.61, maximum 2.11, no change of 3 or more. Earlier history versions (v10 to v13) cover April to May 2026 only. The index is structural by design; a jump trigger would fire only on methodology version bumps.

## Ground truth

Method: every fire was checked by a research pass against Wikipedia's Portal:Current events day and month pages for July to October 2026 (which link Reuters, AP, AFP, BBC and Al Jazeera), direct wire and shipping-press URLs, the IMF PortWatch Daily Chokepoints Data API (`services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query`), UKMTO and ReCAAP reports. A fire counts as a true positive when a clear escalation involving the entity was reported within 24 hours (day-level), WEAK when only a minor incident or background was found, and a false positive when nothing was found; the search index for August to October 2026 is thin, so "not found" verdicts are search-limited. Context for the window: the US and Iran war resumed on July 8, the US blockade of Iran was reinstated on July 14, and Hormuz has carried a fraction of its pre-war traffic since late February.

### Country risk surge (rise 15, floor 50, as first tuned): 17 TP / 17 WEAK / 14 FP over 48 fires

True positives: PK Jul 24 (Tank district checkpost attack, 27 killed); IR Jul 29 (IRGC missile attack on US forces, CENTCOM strikes); UA Jul 30 (hundreds of drones and missiles, 9 killed, Kh-101 into Poland); RU Aug 1 (Kyiv strike, Rosatom ship sunk); IR Aug 1 (Qatari LNG tanker hit in Hormuz, drones over Kuwait); IR, UA, RU Aug 5 (Minoan Pioneer struck in Hormuz; Kyiv-region strike, 17 killed); UA Sep 1 (Kyiv strike, 12 killed); IR Sep 1 (new US strikes on the IRGC, Hormuz mines and tanker attacks); RU Sep 1 (Kyiv strike; Germany closed the Bonn consulate over the Leipzig drone); UA Sep 8 (Kyiv strikes resumed, 5 killed); IR Sep 15 (Gulf states cancelled talks, El Gaia attacked in Hormuz); UA Sep 28 (Kyivstar HQ hit, Kyiv drone strikes); UA Oct 7 (mass strike, 28 killed); IR Oct 14 (four Hormuz attacks Oct 11, two ships sunk Oct 14); RU Oct 14 (drones sank a ship off Bulgaria, ambassador summoned).

False positives: CN Jul 20, BR Jul 21, TR Aug 4, TR Aug 5, IQ Aug 6, UA Aug 15, CN Aug 23, IQ Sep 1, TR Sep 1, SY Sep 1, AF Sep 5, BR Sep 13, IQ Oct 14, SY Oct 14. The Oct 1 six-country cluster (IR, IL, CN, UA, RU, SY) was six WEAK verdicts: minor items only.

Re-scored to the shipped rule (floor 70 plus the baseline guard): 15 of the 17 true positives survive (IR Jul 29 at 66 and IR Aug 1 at 66 drop), 9 of 14 false positives survive before the guard and about 7 after it (the Brazil re-levellings go), 13 of 17 WEAK survive before the guard and about 11 after it (Mexico). Strict precision about 44 percent, 78 percent counting minor incidents, at roughly 0.7 fires a day across all 24 countries. Per country group: Iran, Ukraine and Russia 15 TP / 10 WEAK / 1 FP; China, Turkey, Iraq, Syria and Afghanistan 0 TP / 2 WEAK / 6 FP. The trigger is therefore shipped with the per-country scope documented as the way to use it, and the calm-country noise is the known cost.

Misses: Houthi seizure of Mokha, Perim and Hanish (Sep 10 to 14; Yemen's index flat at 70); Houthi strike on Riyadh airport, 12 killed (Oct 10; Saudi Arabia flat at 50); drones from Iraq hit the Saudi East-West pipeline (Sep 10); Kohat mosque bombing and Pakistani strikes into Afghanistan (Sep 18 to 30); Ukraine's roughly 1,600-drone attack on Moscow (Sep 20); Bucha depot strike, 37 killed (Aug 28); Kramatorsk bus strike, 33 killed (Oct 8); Iranian strikes on bases in Kuwait and the UAE (Sep 3); Myanmar Kyauktaw market airstrike, 50 killed (Sep 28). Most misses are countries whose index did not move at all in the window (YE, SA, PK, MM, AE), which is a coverage property of the Country Instability Index, not of the threshold; the Moscow, Bucha and Kramatorsk misses are 24 h cooldowns and movements under 15 in countries already near the top of the scale.

### Chokepoint disruption: 4 TP / 1 mis-attributed / 2 artifacts / 2 FP over 9 reconstructed events

Hormuz Oct 5 to 12 (score 70 to 85): TP, UKMTO 152-26 and tanker attacks on Oct 5, 6, 9 and 11. Hormuz transit-drop Jun 1: TP, Iran announced a complete block and MSC Sariska was attacked. Hormuz transit-drop Jul 15 to 16: TP, PortWatch fell from 20 to 29 transits a day to 4 to 10 from Jul 9. Kerch transit-drop Jul 7 to 9: TP, slightly early; Russia stopped accepting Kerch passage requests on Jul 10. Suez Sep 8 to 9 (35 to 50, red): the Houthi Red Sea offensive was real (Sep 8 to 14) but happened at Bab el-Mandeb, whose score stayed at 40 while Suez carried the warnings; PortWatch transits stayed flat at both. Hormuz Aug 2 to 6 and Kerch Aug 8 to 10: artifacts of the 30-day baseline still holding pre-collapse traffic (Hormuz flat at about 5 a day, Kerch at 0 to 1). Dover Sep 4 (7 warnings, 15 to 30): nothing found, transits normal at 126 to 193 a day. Malacca Oct 12 (10 to 20): nothing found, transits normal at 209 to 251 a day.

The Hormuz feed matches PortWatch (0 to 10 transits a day, median about 4, August to October), so the thin series is real traffic after the collapse from about 140 a day before the war, not a broken feed.

Misses: Bab el-Mandeb at a flat 40 through the Houthi blockade of Saudi shipping (from Jul 20), the Faize Noore Oliya sinking (Aug 4) and the Perim and Hanish seizures (Sep 11 to 14); Black Sea ships sunk off Bulgaria (Oct 6 and 13; no monitored chokepoint covers the western Black Sea); Damietta LNG tanker strike (Jul 29; a port, not a chokepoint). The Bab el-Mandeb miss is a scoring issue (its warnings were matched to Suez) worth a separate fix; it is not addressed here.

### Conflict activity burst (dropped): 21 TP / 8 WEAK / 8 FP over 37 fires

True positives were real: all eleven Yemen fires (Houthi offensives, Mocha, Bab el-Mandeb, strikes on Saudi cities, Aden), the Benghazi car bomb (Aug 11), Israeli strikes on Abu al-Duhur (Aug 18), the Borgu attacks in Nigeria (Aug 22), the Kenscoff massacre in Haiti (Aug 24), Kyiv (Sep 1) and Pryluky (Oct 7), Pakistani strikes into Afghanistan (Sep 21, Oct 1), Tigray (Sep 23 to 25, one event over three fires), Rumbek (Oct 9). False positives clustered in countries with a near-zero median that barely cross the flat 20-event floor (Niger, Iraq, Somalia, Burkina Faso) and in high-baseline Nigeria. Misses were the decisive finding: Sudan had three mass-casualty drone and RSF attacks (Oct 2, Oct 8 to 9, Oct 16) and Myanmar the Kyauktaw airstrike (Sep 28) with zero fires, because GDELT volume for those countries is low, and the Niger coup attempt (Aug 29) and Islamic State attacks (Sep 24, 57 killed) did not fire either. A media-volume trigger that is blind to Sudan and Myanmar and fires on Niger's media noise was not built.

## Phase 2 design

- Registry: `shared/event-triggers.json` defines each event (key, label, description, source, input schema, threshold, cooldown, id construction, payload schema, sample); mirrored byte-for-byte at `scripts/shared/event-triggers.json` (Railway `rootDirectory=scripts`, pinned by `tests/scripts-shared-mirror.test.mjs`) and `integrations/zapier/event-triggers.json` (pinned by `integrations/zapier/test/event-registry.test.js`).
- Server: `RegisterWebhookRequest` gains `event_type`, `countries`, `min_live_signal`; `WebhookSummary` reports them; `DELETE /api/v2/shipping/webhooks/{subscriberId}` removes the record, both indexes and the worker state in one compare-and-delete. `scripts/shipping-webhook-worker.mjs` evaluates records by event type: the chokepoint state machine gains the live-signal floor, and `country.risk_surge` reads `risk:scores:sebuf:v8` (live, stale, then RPC) with its own per-country state in the same hash. Both events share signing, delivery, retries, the failure ceiling and health. The OpenAPI bundle keeps one `webhooks` entry (the signature contract scanners read) whose `X-WM-Event` enum names both events: the served `public/openapi.json` sits about 200 bytes under its 950,000-byte scanner budget, the dedup passes have no repeated structure left that would pay for a second 3 KB entry, and the registry plus the API page carry the risk-surge payload schema.
- Zapier 1.1.0: `chokepoint_disruption` and `country_risk_surge` REST-hook triggers (subscribe, unsubscribe, signature-verified `perform`, `performList` samples shaped like deliveries), a hidden `country_list` dropdown from the registry, existing searches and the polling outbreak trigger unchanged.

## Not verified and owner steps

- `zapier-platform push` and any Zapier account change were not run. Owner: `cd integrations/zapier && npm run validate && npx zapier-platform push` (needs `.zapierapprc` from #9260).
- `zapier-platform invoke` against production for `performList` (read-only) was run only where noted in the PR; `performSubscribe` writes a subscription and was not invoked.
- Zapier's `expiration_date` re-subscribe behaviour was not observed end to end; the 29-day value is documented as the mechanism that outlives the server's 30-day TTL.
- The worker change is live only after the Railway `shipping-webhook-worker` service redeploys from `main`; a `country.risk_surge` delivery in production has not yet been observed.
