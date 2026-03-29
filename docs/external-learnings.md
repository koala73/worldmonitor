# External Learnings: API Usage in the Wild

Observations from two open-source projects discovered using WorldMonitor APIs without authorization.
Sources: [aeris-AgentR](https://github.com/barbrickdesign/aeris-AgentR-) (Next.js travel app) and
[HOPEFX AI Trading](https://github.com/HACKLOVE340/HOPEFX-AI-TRADING/pull/26) (Python geopolitical risk system).

---

## 1. Layer Weighting as a Signal Hierarchy

HOPEFX assigned explicit weights to each WorldMonitor data source when computing their
geopolitical risk score:

| Data source | Their weight | What it means |
|---|---|---|
| `theater-posture` | 1.0 | Military positioning — highest financial signal |
| `acled` (conflict events) | 1.0 | Active armed conflict — highest financial signal |
| `country-intel` | 0.9 | Country-level risk + sanctions |
| `military` (flights) | 0.8 | Anomalous military air activity |
| `news-intel` | 0.7 | Contextual news signal |
| `outages` (internet) | 0.5 | Internet disruption as instability proxy |
| `firms-fires` (satellite) | 0.3 | Lowest signal for financial use cases |

These weights were arrived at independently by a financial developer, not guided by our docs.
They represent ground truth for what the **trading/finance use case** values most.

### Why this matters for seeder reliability

Not all seeds are equal. A seeder going stale should trigger different urgency levels
depending on the downstream signal loss. Using HOPEFX's weights as a proxy for importance:

**Priority 1 — weight ≥ 0.9 (full loss if stale)**

- `theater-posture:sebuf:v1` — `ais-relay.cjs` → `seedTheaterPosture`
- `acled:*` — `ais-relay.cjs` → ACLED loop, `seed-conflict-intel.mjs` backup
- `country-intel` / risk scores — `intelligence/v1/get-risk-scores`

**Priority 2 — weight 0.6–0.8 (partial degradation)**

- `military-flights:*` — `seed-military-flights.mjs`
- `gdelt-*` / news intel — `seed-insights.mjs`

**Priority 3 — weight < 0.6 (tolerable stale window)**

- `infra-outages:*` — `seed-infra.mjs`
- `firms-fire:*` — `seed-wildfire.mjs`

**Actionable:** When the health dashboard shows `STALE_SEED`, sort alerts by this priority
tier, not alphabetically. On-call should fix a stale `theater-posture` seed before a stale
`firms-fire` seed. This hierarchy should also inform `maxStaleMin` thresholds — Priority 1
seeds warrant tighter windows.

### Different use cases, different hierarchies

HOPEFX's hierarchy is for **financial risk**. Other use cases invert some weights:

| Signal | Finance | Humanitarian | Travel safety |
|---|---|---|---|
| Theater posture | 1.0 | 0.5 | 0.6 |
| Conflict events | 1.0 | 1.0 | 0.9 |
| Satellite fires | 0.3 | 0.8 | 0.4 |
| Outages | 0.5 | 0.7 | 0.3 |
| News intel | 0.7 | 0.6 | 0.8 |

When the composite risk score endpoint ships (see section 3), it should support a `preset`
parameter (`finance`, `humanitarian`, `travel`) that applies the appropriate weight profile.

---

## 2. Composite Risk Score as a PRO Endpoint

### What HOPEFX built manually

HOPEFX assembled a `WorldMonitorClient` Python class that calls 7 endpoints in parallel,
applies weights, and outputs a single `geopolitical_risk_score` (0–100) per country/region.
They wrote hundreds of lines of Python to reproduce something WM already does internally.

### What WM already has

`server/worldmonitor/intelligence/v1/get-risk-scores.ts` already computes a 18-signal
composite risk score per country using:

- **ACLED events** (protests, riots, battles, explosions, civilian violence, fatalities)
- **UCDP** armed conflict classification (`ucdpWar`, `ucdpMinor`)
- **Infrastructure outages** (total, major, partial counts)
- **GPS jamming** (high/medium counts)
- **Satellite fires** (`fireCount`)
- **Cyber threats** (`cyberCount`)
- **Iran strike activity** (`iranStrikes`, `highSeverityStrikes`, `orefAlertCount`)
- **Climate severity** (`climateSeverity`)
- **Displacement** (`totalDisplaced`)
- **News signal** (`newsScore`, `threatSummaryScore`)
- **Travel advisories** (`advisoryLevel`)

Each country also has a `BASELINE_RISK` (e.g. UA=50, KP=45, US=5) and a per-country
`EVENT_MULTIPLIER` that scales how much recent events move the score.

This is materially more sophisticated than what HOPEFX built. The gap is not the scoring
logic — it's that this endpoint is internal-only.

### What to expose

A PRO-gated endpoint `GET /api/intelligence/v1/get-geopolitical-risk?country=XX` (or
`country=XX,YY,ZZ` for batch) that returns:

```json
{
  "country": "IR",
  "score": 67,
  "tier": "high",
  "components": {
    "conflict": 0.82,
    "military": 0.71,
    "infrastructure": 0.34,
    "news": 0.59
  },
  "trend": "rising",
  "computedAt": "2026-03-29T12:00:00Z"
}
```

The `components` breakdown lets developers (like HOPEFX) apply their own weights downstream
without re-calling 7 endpoints. This is the one response they actually need.

### Seeding strategy

This should be **seeded and cached**, not computed on-demand — the same pattern as the
Economic Stress Composite Index (PR #2461). Railway seeds a Redis key
`geopolitical-risk:sebuf:v1` on a 30-minute cycle. Vercel reads it. The PRO gate
sits in the gateway's `PREMIUM_RPC_PATHS`.

---

## 3. Attribution as a Distribution Channel

aeris-AgentR shows severity badges with a "Data: WorldMonitor" deeplink back to
worldmonitor.app. They did this voluntarily — it was in their own interest to tell
users where the data came from.

When the developer API program launches, the Terms of Service should require attribution
for public-facing apps. Model it after OpenStreetMap's attribution requirement:

> Apps using WorldMonitor data must display "Data: WorldMonitor" with a link to
> worldmonitor.app in any user-facing interface that shows the data.

This turns every external integration into an organic referral source.

---

## 4. Python SDK Demand

HOPEFX independently built a `WorldMonitorClient` Python class with:

- Method-per-endpoint design (`get_conflicts()`, `get_country_intel()`, etc.)
- A `get_all_layers()` parallel batch method
- Docker deployment support
- Redis/Upstash caching integration

Nobody builds that unless the pain of raw HTTP calls is real. A first-party
`pip install worldmonitor` SDK, mirroring the MCP tool design, would be a
high-leverage developer API companion. The HOPEFX client is essentially the feature spec
for what the Python SDK should look like.

---

## 5. Aviation Response Shape Is Production-Ready

aeris-AgentR calls `/api/aviation/v1/list-airport-delays` and uses the response directly
with no transformation layer. They display `severity`, `delay_type`, `avg_delay_minutes`,
`ground_stop`, `departures_affected`, `arrivals_affected` as-is. This validates that the
aviation API contract is stable and clean enough for external consumers. No changes needed.

---

## 6. Cache Tiering Matches Real Usage Patterns

aeris caches aviation data at 5 minutes on their server. The WM `static` cache tier
sends `max-age=600` (10 min browser) and `CDN-Cache-Control: s-maxage=14400` (4h CDN).
Their 5-minute refresh is well within those bounds, confirming the existing tiering is
not too aggressive for this use case.

---

## Summary: Actions

| # | Action | Priority | Where |
|---|---|---|---|
| 1 | Sort health/stale alerts by signal priority tier | High | Health dashboard + `maxStaleMin` config |
| 2 | Expose `get-geopolitical-risk` as seeded PRO endpoint | High | `intelligence/v1`, Railway seed, `PREMIUM_RPC_PATHS` |
| 3 | Add attribution requirement to dev API ToS | Medium | Legal/ToS copy |
| 4 | Python SDK | Low (post dev-API launch) | Separate repo |
| 5 | Add `preset` param to risk score for use-case weighting | Low | `get-geopolitical-risk` endpoint |
