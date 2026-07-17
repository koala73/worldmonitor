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

## Result (CLEAN 24 h window 2026-07-16 12:00 UTC → 2026-07-17 12:00 UTC; 77.5k KV / 2.48k Redis reads)

**Headline (all traffic, auto-weighted):**

| Store | p50 | p95 | p99 | **% clearing 1200 ms** |
|---|---|---|---|---|
| **KV** | 28 | 321 | 816 | **99.6 %** (~1 in 250 miss) |
| Redis | 507 | 1567 | 2029 | **84.4 %** (~1 in 6 miss) |

**By continent** (KV by user country · Redis by Vercel region):

| Continent | KV p95 / %ok | Redis p95 / %ok | Winner |
|---|---|---|---|
| N. America | 204 / 100 % | 469 / 100 % | KV (both fine) |
| Europe | 89 / 100 % | 669 / 99 % | KV |
| **Middle East** | **269 / 100 %** (n≈7.3k) | — **no Vercel region** | **KV** |
| **Africa** | 630 / **99 %** | 1990 / **40 %** | **KV** (Redis fails 3/5) |
| **Oceania** | 724 / **97 %** | 1698 / **39 %** | **KV** (Redis fails 3/5) |
| S. Asia | 583 / 99 % | 1664 / 74 % | KV |
| E/SE Asia | 362 / 100 % | 1698 / 71 % | KV |
| LatAm | 355 / 100 % | 919 / 99 % | KV |

**Only exception — Redis faster:** US-East metros `iad1` (Redis 48 ms vs KV 177 ms) and `cle1`
(123 vs 155) — where Upstash Redis is physically co-located, so the Vercel Function does a LAN read.
Both are trivially under budget; no mobile user perceives 177 ms vs 48 ms. US traffic is 100 %
under-budget on KV regardless. Non-issue.

**MENA (matters for this user base):** Vercel has no Middle East region, so MENA users hit European
Redis today. KV serves them locally at 269 ms p95 / 100 % under budget (UAE 249 ms / 100 %, n≈1.8k;
Turkey 140 ms / 100 %, n≈1.2k).

**Where traffic lives** (top by KV volume): US 12.8k · India 8.0k · Italy 4.2k · Australia 2.8k ·
Germany 2.7k · UK 2.7k · Japan 2.6k · France 2.5k · Singapore 2.3k · Netherlands 1.9k · Canada 1.9k ·
UAE 1.8k · Pakistan 1.6k · Indonesia 1.4k · Turkey 1.2k. A true worldwide base — KV serves all at
~100 % under budget. Italy (55 ms) is a ~12× win over the European-Redis path it uses today.

## Residual risk (not a blocker)

The 0.40 % of KV reads over budget (307 of 77.5k, only 9 Worker-cold) concentrate in **low-traffic
remote POPs** (Oceania secondaries AKL/BNE/ADL, Pacific islands PPT, East-Africa EBB/JIB, South-Asia
fringe LHE) that keep no hot KV replica, so reads hop to a regional tier. **Even there KV beats
Redis**, so cutover still *reduces* aborts — nobody regresses. Lever for U-K4: a longer read
`cacheTtl` keeps those POPs hot at the cost of a little tier staleness; truly remote POPs
(once per ~15 min) stay cold-ish regardless and are still faster than Redis.

## Stability — CONFIRMED at the clean 24 h window

The 99.6 % under-budget figure was **identical across the 8 h, 16 h and full 24 h reads** (99.60 % on
77.5k reads with peak captured); every continent still won; no high-traffic metro regressed. **Jakarta,
flagged over-budget at 16 h (1341 ms), now PASSES at 799 ms** as its samples fattened — confirming the
early number was small-sample jitter exactly as predicted. Pipeline health over the window: **99.90 %
valid `kv`, zero stale/miss/invalid** (the 0.10 % remainder is the shadow's 5 s probe-ceiling, not a
serving path); publisher still writing valid fast+slow envelopes at window close.

## Go/no-go

**GO — confirmed.** KV clears the mobile budget for 99.6 % of a genuinely global user base vs Redis's
84.4 %, wins every continent, and *rescues* Africa (Redis 40 % ok) / Oceania (39 %) where the incumbent
fails the majority of requests. Cutover is a strict improvement everywhere (the sole Redis-faster spots,
US-East `iad1`/`cle1`, are already trivially under budget). Proceed to U-K4 (implemented as PR #5357,
with the hedge + KTD3 origin-fallback + KTD4 staleness guard) — merge inert, then stage the flag flip.
