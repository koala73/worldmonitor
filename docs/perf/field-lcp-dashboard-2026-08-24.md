# The August field-LCP climb on /dashboard — verdict, 2026-08-24 (#7113)

**Verdict: a real field regression. The traffic-mix hypothesis is refuted.**

#7113 observed CrUX field LCP p75 rising every day for 16 days (origin +19%, `/dashboard`
+31%) while lab LCP stayed flat at 440–520 ms, and proposed that a traffic-mix shift — more
cold-cache visitors from the crawlable-corpus expansion — was the likely explanation. It is
not. Four independent controls hold the mix constant and the rise survives all four.

Two things drive it, and the larger one is invisible to synthetic monitoring by
construction. A third finding changes what to expect next: this is a **step that landed in
early August**, not an ongoing daily slide, so the CrUX series will plateau rather than keep
climbing.

## Instruments

| Instrument | What it gives | Endpoint |
|---|---|---|
| CrUX History API | 25 weekly windows of p75 + histograms, per form factor, unsampled | `POST chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=$GOOGLE_API_KEY` |
| DebugBear RUM | first-party page views with the LCP element selector | `GET www.debugbear.com/api/v1/project/103025/rumPageViews` |
| DebugBear RUM | aggregated series, `groupBy` / `groupByTime` | `GET .../project/103025/rumMetrics` |
| DebugBear lab | daily synthetic runs, page weight, and a **daily** `crux.url.lcp.p75` | `GET www.debugbear.com/api/v1/page/693053/metrics` |

Two of these were new to this repo. See [Traps](#traps-worth-recording) before reusing them.

## Why it is not traffic mix

### 1. The rise is inside every device cohort

CrUX p75 LCP, first window (2026-07-05..08-01) → last window (2026-07-26..08-22):

| | all | phone | desktop | tablet |
|---|---|---|---|---|
| origin | 1308 → 1600 (**+22%**) | 1314 → 1636 (+25%) | 1304 → 1538 (+18%) | 1579 → 1895 (+20%) |
| `/dashboard` | 1153 → 1573 (**+36%**) | 946 → 1326 (+40%) | 1343 → 1759 (+31%) | 1270 → 1717 (+35%) |

A device-mix shift moves the pooled number while the cohorts stay flat. Every cohort moved,
by roughly the same amount. Device mix is not the cause. CrUX `form_factors` confirms the
shares barely moved (origin desktop 0.504 → 0.431, phone 0.467 → 0.529).

### 2. TTFB, FCP, and RTT did not move

Same windows, same CrUX pull, p75:

| | TTFB | FCP | RTT | LCP |
|---|---|---|---|---|
| origin | 482 → 463 | 946 → 938 | 168 → 162 | 1308 → **1600** |
| `/dashboard` | 337 → 304 | 717 → 684 | 168 → 165 | 1153 → **1573** |

More visitors on slower networks, slower devices, or cold caches raises all four. Three of
the four are flat or improving. `round_trip_time` in particular is a direct control on the
network and geography mix, and it did not move.

### 3. Standardization on every other mix dimension leaves the rise intact

First-party RUM, `/dashboard` desktop, comparing 2026-07-09..07-23 (n = 24,828 LCP
observations) against 2026-08-15..08-24 (n = 12,479). Each row reweights one period's
within-cohort distributions to the other period's cohort shares:

| Cohort held constant | Aug at Jul mix | Jul at Aug mix |
|---|---|---|
| *(observed)* | **2352** | **1508** |
| country | 2316 | 1496 |
| navigation type | 2368 | 1456 |
| viewport bucket | 2388 | 1548 |
| **LCP element** | **1808** | **2032** |

Country, navigation type, and viewport absorb nothing. Only the LCP-element cohort absorbs
any of the gap, and that cohort is a property of our markup, not of our traffic.

### 4. The URL-level series cannot have a page mix

`/dashboard` is one URL. "The SEO expansion added new cold pages to the origin aggregate"
cannot apply to it, and it is the series that rose **faster** (+36% vs +22%). `/dashboard`
is 70.3% of first-party RUM page views, so it also carries most of the origin move.

## What it actually is

### Part one (~⅔): the LCP element changed identity

`/dashboard` desktop, share of LCP attributions and each cohort's own p75:

| LCP element | Jul share | Jul p75 | Aug share | Aug p75 |
|---|---|---|---|---|
| bootstrap skeleton copy | 64.6% | 648 ms | 48.9% | 828 ms |
| **insights world brief** | **23.9%** | **3136 ms** | **38.1%** | **3506 ms** |
| other content | 7.4% | 4600 ms | 8.6% | 3868 ms |
| unattributed | 4.1% | 798 ms | 4.5% | 1704 ms |

The world brief paints at p75 ≈ 3.5 s. The static skeleton copy in `index.html` paints at
p75 ≈ 0.8 s. Over the window the brief displaced the skeleton as the winning LCP candidate
on an extra 14 points of desktop traffic, and each converted page view swaps a 0.8 s
measurement for a 3.5 s one.

Measured live on `https://www.worldmonitor.app/dashboard` at 1680×910 (buffered
`PerformanceObserver`, `largest-contentful-paint`):

- winning skeleton LCP entry: **16,824 px²**, at 1008 ms
- `#insightsContent div.brief-para`: 282×142 = **40,148 px²**

Once the brief paints inside the viewport it always outsizes the shell, so its paint time
becomes the page's LCP. Nothing about the brief itself got slower (3136 → 3506 ms); it
simply wins more often.

The daily brief share climbs monotonically across both sampled periods — 5.5% on 2026-07-09,
22.0% on 07-20, 28.7% on 08-15, 40.4% on 08-24 — which is the same monotone shape #7113 saw
in CrUX.

### Part two (~⅓): a genuine bootstrap slowdown

The residual after holding the element mix constant, `/dashboard` desktop:

| | Jul 09–23 | Aug 15–24 |
|---|---|---|
| FCP p75 | 592 ms | 744 ms (+26%) |
| TTFB p75 | 282 ms | 334 ms (+18%) |
| skeleton-copy LCP p75 | 648 ms | 828 ms (+28%) |

DebugBear lab, same page, `pageWeight.script`: **1,314,042 B (2026-07-09) → 1,523,963 B
(2026-08-24)**, +209,921 B / **+16.0%**. That is the growth #7111 reports and that no CI
gate can see. It is the most plausible cause of this half and the reason to land #7111's
gate.

## Why the lab is blind to part one

On `/dashboard` desktop, **64 of 65** lab runs between 2026-06-30 and 2026-08-24 report
`performance.largestContentfulPaint` exactly equal to `performance.firstContentfulPaint`.
The synthetic run's LCP is always the skeleton. The run settles long before the world brief
renders at ~3.5 s, so the lab never observes the element substitution that drives two thirds
of the field regression. A flat lab LCP is not evidence that field LCP is stable — here the
two metrics are measuring different elements.

## It is a step, not a slide

`crux.url.lcp.p75` is carried on every DebugBear lab run, which gives the 28-day rolling
CrUX p75 at **daily** resolution:

| date | `/dashboard` rolling p75 |
|---|---|
| 2026-07-24 | 1306 (floor) |
| 2026-08-05 | 1343 |
| 2026-08-12 | 1403 |
| 2026-08-19 | 1552 |
| 2026-08-24 | 1759 |

The floor is 2026-07-24 and the series is flat until 2026-08-06. First-party RUM daily p75
for `/dashboard` is ~1150 ms across 07-09..07-23 and ~2100 ms across 08-15..08-24, and it is
**flat to slightly improving inside August** (2340 on 08-15, 2088 on 08-24). So the field
took a step in early August and has been stable since.

"16 consecutive days of rise" is the 28-day rolling window digesting that step, not 16 days
of fresh degradation. Expect the CrUX series to plateau near the current daily field level —
roughly 2.0–2.1 s on `/dashboard` — around early September, and do not read the intervening
daily rises as new regressions.

CrUX cannot date the step more precisely than "early August" and neither can we: first-party
RUM has no data between 2026-07-24 and 2026-08-14, because the 100%-sampled collector
exhausted the DebugBear RUM monthly quota (`src/bootstrap/debugbear-rum.ts` now samples at
10%).

## What to do

1. **Reduce the world brief's time to paint.** It is real content that real users wait ~3.5 s
   for, so LCP is telling the truth. The fix is to make it arrive sooner, not to make it
   ineligible as an LCP candidate — hiding it would improve the metric and not the user.
2. **Land the #7111 bundle gate.** +210 KB of script in five weeks with no CI gate is the
   best explanation for the other third, and it is unbounded until a gate exists.
3. **Do not re-open this as a traffic-mix question.** Four controls refute it; the tables
   above are the evidence.

## Traps worth recording

- **`rumPageViews` rows mostly have no `lcpValue`.** 3,583 of 5,000 rows in one sample had a
  null `lcpSelector`, and only 113 of those had an LCP at all. Computing element shares over
  raw row counts inflates the "unattributed" bucket to 70%+ and inverts the standardization.
  Filter to rows with a non-null `lcpValue` first.
- **`count=5000` returns the most recent 5,000 rows, not a sample of the range.** A request
  spanning two weeks silently collapses to the last day. Request one day at a time.
- **The DebugBear API host is `www.debugbear.com`, not `api.debugbear.com`.** The latter does
  not resolve. Cloudflare answers `error code: 1010` to a default user agent; send a browser
  `User-Agent`.
- **`metrics` must be a repeated query parameter.** `metrics=lcp,fcp` returns
  `{"error":"Invalid metric requested"}`; `metrics=lcp&metrics=fcp` works.
- **Do not compare a p75 across the 2026-07-24 sampling change without saying so.** The
  10% sample is uniform (`Math.random() * 100 >= 10`), so it is unbiased, but the two periods
  are otherwise a 100% census and a 10% sample.

## Refs

#7113 (this verdict) · #7111 (bundle growth, unbounded) · #7112 (dashboard DOM size) ·
[Reading field Web Vitals](reading-field-web-vitals.md) ·
[dashboard LCP critical payload](dashboard-lcp-critical-payload-2026-06-29.md)
