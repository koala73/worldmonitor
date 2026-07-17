# U-K3 verify gate — KV vs Redis, decision evidence

**Decision: GO** — serve the public bootstrap tier from KV via the Worker (proceed to U-K4).

## Method

Two independently-measured server-side read latencies over one steady-state window,
joined **by geography** (the two sides use different vantage points on purpose):

- **KV candidate** — `bootstrap_kv_shadow` / `kv_duration_ms` (`kv_outcome=='kv'`), dimensioned by
  `cf_country` / `cf_colo`. The proposed path: a Cloudflare Worker reads the tier from a KV binding
  at the edge POP nearest the user (#5338 U-K2).
- **Redis incumbent** — `bootstrap_r2_shadow` / `redis_duration_ms`, dimensioned by Vercel
  `execution_region`. The current path: a Vercel Function reads Upstash Redis (#5339).

Budget = **1200 ms p95** (the mobile-client abort the whole epic is chasing). The single decision
metric is **share of reads that clear the budget**, which is automatically traffic-weighted.

> **Gate framing changed from the original plan.** The plan gated on "the worst APAC cohort
> (hkg1/syd1/bom1/sin1)." That was too narrow: APAC is a minority of the user base and Seoul never
> gathered enough traffic to judge (n≈14). Replaced with a **global, traffic-weighted** gate — where
> users actually are. The APAC per-metro table is retained as a diagnostic, not the gate.

## Result (window 2026-07-16 12:00 UTC → 2026-07-17 ~04:30 UTC, ~16 h; 49.8k KV / 1.67k Redis reads)

**Headline (all traffic, auto-weighted):**

| Store | p50 | p95 | p99 | **% clearing 1200 ms** |
|---|---|---|---|---|
| **KV** | 29 | 328 | 832 | **99.6 %** (~1 in 250 miss) |
| Redis | 538 | 1599 | 2069 | **82.4 %** (~1 in 6 miss) |

**By continent** (KV by user country · Redis by Vercel region):

| Continent | KV p95 / %ok | Redis p95 / %ok | Winner |
|---|---|---|---|
| N. America | 200 / 100 % | 469 / 100 % | KV (both fine) |
| Europe | 90 / 100 % | 696 / 99 % | KV |
| **Middle East** | **275 / 100 %** (n≈4.9k) | — **no Vercel region** | **KV** |
| **Africa** | 630 / **99 %** | 1990 / **32 %** | **KV** (Redis fails 2/3) |
| **Oceania** | 768 / **97 %** | 1732 / **30 %** | **KV** (Redis fails 2/3) |
| S. Asia | 656 / 99 % | 1698 / 69 % | KV |
| E/SE Asia | 377 / 99 % | 1732 / 68 % | KV |
| LatAm | 362 / 100 % | 919 / 99 % | KV |

**Only exception — Redis faster:** US-East metros `iad1` (Redis 48 ms vs KV 177 ms) and `cle1`
(123 vs 155) — where Upstash Redis is physically co-located, so the Vercel Function does a LAN read.
Both are trivially under budget; no mobile user perceives 177 ms vs 48 ms. US traffic is 100 %
under-budget on KV regardless. Non-issue.

**MENA (matters for this user base):** Vercel has no Middle East region, so MENA users hit European
Redis today. KV serves them locally at 275 ms p95 / 100 % under budget (Turkey specifically:
146 ms / 100 %, n≈922).

**Where traffic lives** (top by KV volume): US 9.5k · India 4.4k · Italy 3.1k · UK 1.8k · Australia
1.7k · Germany 1.6k · Japan 1.5k · France 1.5k · Singapore 1.4k · Canada 1.4k · Netherlands 1.3k ·
Turkey 0.9k · Indonesia · Pakistan. A true worldwide base — KV serves all at ~100 % under budget.
Italy (52 ms) is a ~13× win over the European-Redis path it uses today.

## Residual risk (not a blocker)

The 0.4 % of KV reads over budget concentrate in **low-traffic remote POPs** (Oceania secondaries
AKL/BNE/ADL/WLG/NOU, South-Asia fringe ISB, Pacific islands) that keep no hot KV replica, so reads
hop to a regional tier. **Even there KV beats Redis** (e.g. Jakarta 1341 < 2029), so cutover still
*reduces* aborts — nobody regresses. Lever for U-K4: a longer read `cacheTtl` keeps those POPs hot
at the cost of a little tier staleness; truly remote POPs (once per ~15 min) stay cold-ish regardless
and are still faster than Redis.

## Stability

The 99.6 % under-budget figure was identical between the 8 h and 16 h reads; every metro winner held;
Jakarta's p95 tightened as samples grew (1418→1341), confirming early over-budget numbers were
small-sample jitter. Clean-24 h confirmation (window close 2026-07-17 12:00 UTC) scheduled.

## Go/no-go

**GO.** KV clears the mobile budget for 99.6 % of a genuinely global user base vs Redis's 82.4 %,
wins every continent, and *rescues* Africa/Oceania where the incumbent fails a third of requests.
Cutover is a strict improvement everywhere (the sole Redis-faster spots are already under budget).
Proceed to U-K4 with the KTD3 origin-fallback + KTD4 staleness guard intact.
