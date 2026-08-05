---
title: "China Stock Connect: northbound net flow no longer exists, and the four SSE/SZSE endpoints that do"
date: 2026-08-05
category: tooling-decisions
module: china-market-data
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Adding any China A-share market-data series (Stock Connect, margin, sector, CGB)"
  - "An issue or panel asks for northbound 'flows', 'net buy', or 'foreign inflow'"
  - "Choosing between SSE/SZSE direct and BaoStock / AKShare / EastMoney"
  - "Discovering undocumented endpoints on a JS-driven exchange site"
related_components: [background_job, documentation]
tags: [china, sse, szse, stock-connect, northbound, margin, market-data, endpoint-discovery, railway-seeders]
---

# China Stock Connect: the net-flow series is gone, and where the real data lives

## Context

WorldMonitor's China equity coverage was two Yahoo symbols. Issue #6155 asked for
"Stock Connect northbound flows + margin balance", naming northbound net flow as
"arguably the single most valuable China market series we don't have".

Two things had to be settled before any code: whether that series still exists
(it does not), and where the data that *does* exist actually lives (four
endpoints, none of them documented).

## Guidance

### 1. Northbound NET flow has not existed since 2024-08-16

Both exchanges stopped publishing the northbound buy/sell split on that date.
Only **gross turnover** (buy + sell, one combined number) survives. There is no
primary source for net inflow — any vendor advertising it post-2024 is modelling
or reconstructing it.

The exchanges say so themselves. SZSE's own `SGT_SGTJYRB` report footer links a
separate archive for the pre-cutoff series:

```
备注：查看2024年08月16日前的数据，请点击此处  ->  CATALOGID=SGT_SGTJYRB_BEFORE
```

**This is the load-bearing fact.** Turnover is two-way trading activity. Labelling
it "flows" tells a reader that ¥296bn entered the mainland market when it means
¥296bn changed hands in both directions. Ship it as turnover, and say in the
payload that net flow is unavailable rather than leaving the reader to assume:

```js
// scripts/china-stock-connect/adapters.mjs
export const NORTHBOUND_NET_FLOW_DISCONTINUED_ON = '2024-08-16';
export const NORTHBOUND_NET_FLOW_UNAVAILABLE_REASON =
  'EXCHANGE_STOPPED_PUBLISHING_BUY_SELL_SPLIT';
```

The seeder's publish gate rejects any snapshot that drops the marker, so the
caveat cannot be lost by a later refactor.

### 2. The four endpoints (verified live 2026-08-05)

All on hosts already covered by the existing `china-corporate-disclosures` terms
review — no new vendor, no new terms question.

| Series | Endpoint |
|---|---|
| SSE northbound turnover | `https://query.sse.com.cn/commonSoaQuery.do?sqlId=FW_HGTZL_HGTSCSJ_HGTCJGK_MRTJ&tradeDate=` |
| SSE margin balance | `https://query.sse.com.cn/marketdata/tradedata/queryMargin.do?isPagination=true&pageHelp.pageSize=N&...` |
| SZSE northbound turnover | `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=SGT_SGTJYRB&TABKEY=tab1&txtDate=YYYY-MM-DD` |
| SZSE margin balance | `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1837_xxpl&TABKEY=tab1&txtDate=YYYY-MM-DD` |
| SZSE trading calendar | `https://www.szse.cn/api/report/exchange/onepersistenthour/monthList?month=YYYY-MM` |

Both require `Referer` (`https://www.sse.com.cn/` / `https://www.szse.cn/`) and a
User-Agent. Publication timing: northbound lands after each session closes;
margin is **T+1** on both exchanges.

### 3. Units are inconsistent — one endpoint breaks the pattern

| Field | Unit | Convert |
|---|---|---|
| SSE `totalAmount`, `etfTotalAmount` | 亿元 | × 1e8 |
| SSE `totalVolume` | **万笔 — a trade COUNT, not shares** | × 1e4 |
| SSE margin `rzye`, `rqylje`, `rzrqjyzl` | **元 already** | × 1 |
| SZSE everything (`jrrzye`, totals) | 亿元 / 万笔 | × 1e8 / × 1e4 |

SSE's margin endpoint is the only one quoting yuan. Getting this wrong is a
100× error that still looks plausible. Two invariants catch a slipped mapping:
each exchange's own `total = financing + lending`, and A-share margin balance
sits around ¥2.5tn — a number three orders out is obviously wrong.

### 4. Endpoint discovery: read the network tab, not the HTML

Both sites are JS-driven; the endpoints appear in no HTML and no public docs.
Fetching the page and grepping for `sqlId` returns nothing. What works:

```bash
chrome-devtools-axi open 'https://www.sse.com.cn/services/hkexsc/hgtscsj/hgtcjgk/'
chrome-devtools-axi eval 'performance.getEntriesByType("resource").map(e=>e.name).filter(n=>/query\.sse/.test(n)).join("\n")'
```

That prints the `sqlId`s directly. Two traps:

- **`commonQuery.do` fails open.** An unknown `sqlId` returns HTTP 200 with
  `result: null` — indistinguishable from "no data" unless you check for the
  null. The northbound endpoints are on `commonSoaQuery.do`, a different path.
- **Southbound looks like northbound.** SSE publishes 港股通 (southbound,
  mainland money into HK) far more prominently. Northbound is 沪股通 under
  `/services/hkexsc/hgtscsj/`, southbound is 港股通 under `/ggtscsj/`. Southbound
  *does* still carry `BUY_AMOUNT`/`SELL_AMOUNT`, which makes it very easy to grab
  the wrong series and think net flow is still available.

### 5. SZSE reports are date-keyed and dump everything without a date

Omitting `txtDate` returns the entire series since 2010 (~438 KiB observed for
margin). Always pin the date, and set a response ceiling so a regression fails
loudly instead of parsing:

```js
const EXCHANGE_MAX_RESPONSE_BYTES = 65_536;
url.searchParams.set('txtDate', tradeDate);   // never optional
```

Because the date is required, the seeder must *find* a published date: fetch the
exchange trading calendar (`monthList`, `jybz: "1"` = trading day) and probe back
a bounded number of trading days. An empty `data: []` with a blank `subname` is
SZSE saying "not published yet" — normal for margin before the T+1 release, and
distinct from a malformed payload, which must be reported separately or an
upstream schema change reads as a market holiday.

### 6. Do not reach for BaoStock / AKShare / EastMoney

- **BaoStock and AKShare are Python libraries, not APIs.** The seeder fleet is
  Node ESM; the only `.py` under `scripts/` is a one-off converter. Adding a
  Python runtime to the Railway containers is a real cost for data reachable
  another way.
- **EastMoney is undocumented private JSON with no published terms.** That breaks
  a bar this repo already holds for Chinese sources specifically:
  `scripts/china-macro/source-contracts.mjs` checks robots.txt for NBS/SAFE/PBOC/GACC,
  and `scripts/china-corporate-disclosures/adapters.mjs` carries a `termsUrl` for
  SSE/SZSE/HKEX. EastMoney would be the first Chinese source with neither.

## Why This Matters

The 2024-08-16 fact is the expensive one. Without it, the obvious reading of
"Stock Connect flows" leads to either building a panel from a series that no
longer exists, or — worse — shipping gross turnover under a "net flow" label,
which is not a missing feature but a wrong number presented confidently.

The endpoint list is the second-most expensive: none of it is documented, and
the browser network-capture step is the only reliable way to find it.

## When to Apply

Reach for this before adding any China A-share market series, and immediately
when an issue, panel, or stakeholder asks for northbound "flows", "net buy", or
"foreign inflow" — the answer is that the series was discontinued, and the
honest substitutes are gross turnover (participation intensity) and margin
balance (leverage / risk appetite).

## Examples

Live values on 2026-08-05, as a sanity anchor for a future integration:

```
northbound turnover  2026-08-04   SSE ¥135.449bn + SZSE ¥160.909bn = ¥296.358bn
margin balance       2026-08-03   SSE ¥1.337tn  + SZSE ¥1.257tn    = ¥2.594tn
```

Reachability differs sharply by environment, which is why the direct → proxy
ladder in `scripts/_china-exchange-transport.mjs` is load-bearing rather than
defensive:

| Host | From a workstation | From Railway |
|---|---|---|
| `query.sse.com.cn` | direct, always | direct **and** proxy |
| `www.szse.cn` | direct, always | **never direct** — proxy |

A seeder that only did direct fetches would pass every local check and fail in
production. Verify China-source reachability against the Railway decision log of
an existing seeder on the same host, not against a laptop.

The ladder stops at the proxy deliberately. A seeder fetches upstream data and
writes it to Redis; the web tier reads Redis and serves it. Routing an exchange
fetch through an edge function to borrow its egress inverts that — the web tier
becomes a hop in data acquisition. A sibling seeder does have such a hop, added
as defence in depth for an outage that its own change record says had already
recovered without it; in production it is the hop that answers with a gateway
error while the proxy works.

## Related

- `docs/china-data-coverage.mdx` — the source table, terms, and unit rules (EN + zh)
- `docs/solutions/integration-issues/merged-is-not-ran-long-cron-seeders.md` — a merged seeder is not live until its cron fires
- `docs/solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md` — the registry is documentation; live watch paths are separate
- Shipped in PR #6190 (`Closes #6155`), unmerged as of this writing
