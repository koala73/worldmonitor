---
title: Barchart WAF challenge answers HTTP 202 and passes resp.ok, silently blanking S&P 500 breadth
date: 2026-09-05
category: integration-issues
module: seed-market-breadth
problem_type: integration_issue
component: background_job
symptoms:
  - "seed-market-breadth exits 75 on every Railway tick with 'All Barchart breadth fetches failed'"
  - "Log shows 'Barchart: 0/3 readings' and '20d=null | 50d=null | 200d=null' with no HTTP status warning before the retries"
  - "market:breadth-history:v1 stops advancing (last publish 2026-09-02) and seed-fear-greed shows N/A for % above 200 DMA"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - seed-fear-greed
tags: [barchart, aws-waf, http-202, resp-ok, market-breadth, tradingview-scanner, railway-seeder, scraper]
---

# Barchart WAF challenge answers HTTP 202 and passes resp.ok, silently blanking S&P 500 breadth

## Problem

`seed-market-breadth` scraped three Barchart quote pages (`$S5TW`, `$S5FI`, `$S5TH`) for the share of S&P 500 stocks above their 20, 50, and 200-day averages. From 2026-09-02 every page came back as an AWS WAF challenge shell, the scraper read it as a page with no price, and the seeder failed on every tick. The breadth chart froze on the 9/1 session and the Fear & Greed header lost its breadth reading.

## Symptoms

- Railway log per tick: `Barchart: 0/3 readings`, three retries, `FETCH FAILED: All Barchart breadth fetches failed`, `Failed gracefully`, exit 75.
- No `Barchart <label>: HTTP <status>` warning, which the scraper only printed for non-ok statuses.
- Production payload (`/api/bootstrap?tier=slow&public=1`, key `breadthHistory`) last updated 2026-09-02T02:04Z with a 2026-09-01 entry.

## What Didn't Work

- **Header spoofing.** The seeder's Chrome User-Agent plus a full set of browser client hints (`sec-ch-ua`, `Sec-Fetch-*`, `Accept-Language`) still receive the same 202 shell. It is a JavaScript challenge, not a User-Agent rule.
- **Barchart's JSON endpoint.** `/proxies/core-api/v1/quotes/get` answers 403 without the session and XSRF cookies that only a solved challenge grants.
- **TradingView's index copies of the series.** Symbol search lists `INDEX:S5TH`, `S5FI`, and `S5TW` (provider barchart, end-of-day only), but the scanner answers `symbol_not_exists` for them, so the index series cannot be read directly.
- **StockCharts** `j-sum` answers a 22-byte body, not a payload.

## Solution

Compute the three series from constituents instead of reading an index of them. One POST to TradingView's screener scan returns every S&P 500 member with its close and the three SMAs; the share of members closing above each average is the breadth reading. The module is `scripts/_sp500-breadth.mjs`; both `scripts/seed-market-breadth.mjs` and `scripts/seed-fear-greed.mjs` import it.

```js
const resp = await fetchImpl('https://scanner.tradingview.com/america/scan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': CHROME_UA },
  body: JSON.stringify({ symbols: { symbolset: ['SYML:SP;SPX'] }, columns: ['name', 'close', 'SMA20', 'SMA50', 'SMA200'] }),
  signal: AbortSignal.timeout(timeoutMs),
});
// Strict 200: a bot-challenge interstitial arrives as 202 and passes resp.ok.
if (resp.status !== 200) {
  const err = httpRetryError(resp);
  err.message = `TradingView scan HTTP ${resp.status}`;
  throw err;
}
```

Two guards carry the lesson. The status must be exactly 200 and the body must parse as scan rows, so an interstitial throws instead of passing as three nulls. A 202/4xx throw is `nonRetryable` so `runSeed`'s `withRetry` does not sleep through a challenge. A window with fewer than 450 valid rows (the index has about 503) reads as `null`, because a percentage of a partial universe is not S&P 500 breadth. Incomplete three-window readings fail the tick so last-good stays published. `seed-fear-greed` reads `current.pctAbove200d` from `market:breadth-history:v1` instead of posting a second scan.

Verification before merge: nine unit tests in `tests/sp500-breadth.test.mjs`, a live scan (503 constituents, 20d 35.39, 50d 46.92, 200d 64.07 against Barchart's 9/1 values of 31.8, 45.52, 62.62), and an end-to-end run of the seeder through the real `runSeed` against a local Upstash REST fake that answered GET with null, SET with OK, and EVAL with 1. That run walked lock, scan, validate, staging SET, canonical SET, seed-meta, lock release, exit 0.

## Why This Works

The old scraper's success gate was `resp.ok`, which is true for any 2xx. AWS WAF serves its challenge as HTTP 202 with a 2 KB HTML body (`window.awsWafCookieDomainList`, `window.gokuProps`), so the gate passed, the `__NEXT_DATA__` regex found nothing, and the function returned `null` as if the page had simply lacked a price. Three silent nulls per run looked like a layout change rather than a block, and the only log line was the count.

The replacement removes the dependence on a rendered page entirely. The scanner is a JSON API that returns the inputs to the metric, so the seeder owns the computation and the status gate is exact.

## Prevention

- **A scraper's success gate is `status === 200` plus a parse of the payload you expect.** `resp.ok` admits 202, 204, and 206. `tests/sp500-breadth.test.mjs` pins the 202-challenge, non-JSON, and non-2xx rejections; copy that trio for any new upstream fetcher.
- **Log the status on every non-200**, not only on non-ok, so a challenge shows up in the log as a number rather than as a missing value.
- **First diagnostic for "0/N readings" with no HTTP warning:** curl the URL with the seeder's exact `User-Agent` and `Accept` headers and print status, size, and the first 400 bytes. A 202 with a tiny HTML body naming `awsWafCookieDomainList` is a WAF interstitial, and no header change will get past it.
- **Prove a seeder end to end without touching production:** point `UPSTASH_REDIS_REST_URL` at a local HTTP fake (GET returns null, SET returns OK, EVAL returns 1, `/pipeline` maps the array) and run the script. `startFakeUpstash` in `tests/bundle-runner.test.mjs` is the reference shape. The seeder's `loadEnvFile` only reads the checkout's own `.env.local`, so a worktree without one cannot pick up production credentials.

## Related Issues

- PR #7723 (the fix).
- `docs/solutions/integration-issues/upstash-max-request-size-counts-one-command-and-answers-http-200.md`: another upstream that reports success on the status line while the body says otherwise.
- `seed-fear-greed.mjs` still scrapes `$CPC` (total put/call) from Barchart; the status gate is now `status !== 200` so a 202 logs as HTTP 202 instead of "price not found". It still degrades to null and needs its own source. TradingView lists `USI:PCC` but the scanner does not serve it.
