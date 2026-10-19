# Optional SHFE notices

This module adds the Shanghai Futures Exchange's public notice listing to the existing full dashboard's Asia news category. It collects titles, official links and publication days; it does not collect article bodies, attachments, quotes or trading data. No new panel, database, queue or framework is required.

## Enable on a self-hosted deployment

1. Confirm the intended use against [SHFE's disclaimer](https://www.shfe.com.cn/disclaimer/). Public access is not a commercial redistribution licence. This initial adapter is intended for personal research and remains disabled by default.
2. Configure the existing `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` on your worker and API/digest runtime. Never expose these as Vite variables.
3. Set `CHINA_FUTURES_NEWS_ENABLED=1` on both runtimes. The original macro bundle includes the source at its tail, due every six hours. A single run fetches one fixed listing URL; the existing runner can retry failures within its 20-second fetch budget. Existing bundle admission limits still apply.
4. For an authorized initial seed, run `node scripts/seed-china-futures-notices.mjs` with Node 24. It uses the existing environment loader, lock, validator, envelope publisher and freshness metadata.
5. Build the browser with `VITE_ENABLE_CHINA_FUTURES_NEWS=1`. In the original source settings, select `SHFE (China)` and enable the existing Asia-Pacific panel if necessary. Chinese news is scheduled in the Chinese digest. Existing source limits and account permissions still apply.

Unset both flags and restart/rebuild to roll back. No user settings or layout migrations are performed. A persisted manual source choice remains in the original settings store.

## Data path

`SHFE listing → scripts/china-futures/ → original runSeed → Redis → existing RSS/digest → existing Asia NewsPanel`

| Contract | Value |
| --- | --- |
| Listing | `https://www.shfe.com.cn/publicnotice/notice/` |
| Source | `cn-shfe-notices` / `SHFE (China)` |
| Canonical key | `news:china-futures:shfe:notices:v1` |
| Seed metadata | `seed-meta:news:china-futures:shfe:notices` |
| Completion metadata | `seed-completion:news:china-futures:shfe:notices` (bundle-owned) |
| Health entry | `chinaFuturesNotices`, standalone and enabled only with the server flag |
| Reader | `GET /api/china-futures-news` (also HEAD) |
| Collection freshness limit | 24 hours |
| Newest-publication age limit | 30 days |
| Canonical retention | 7 days, with the original last-good extension on failed collection |

Each item preserves `publicationDate`, `datePrecision: day`, `publishedAt`, `sourceUrl`, `documentId` and `revision`. The publisher supplies a day rather than an intraday timestamp; RSS uses midnight Asia/Shanghai for that day. Re-fetching does not alter the publication date or identity. A title correction changes its content hash but retains the document identity.

Invalid/empty listings fail collection. They do not overwrite the last good snapshot or refresh its collection timestamp. Readers reject stale, missing or malformed data with HTTP 503 and `no-store`, rather than minting an empty fresh RSS response. Requests never trigger an upstream scrape. The digest reads the same Redis snapshot directly; it does not call the official WorldMonitor service or send internal paths to an RSS relay.

Worker and Edge contracts are mirrored because Railway builds from `scripts/` and legacy Edge handlers may only import same-directory helpers. A parity test enforces identical contract bytes.

## Verification

Use `npm run --silent agent:preflight -- --mode tests` first, then:

```sh
node scripts/run-data-tests.mjs tests/china-futures-shfe-notices.test.mjs tests/china-futures-notices-seed.test.mjs tests/china-futures-notices-registration.test.mjs tests/china-futures-news-wiring.test.mts
node --test api/china-futures-news.test.mjs
npm run typecheck
npm run typecheck:api
npm run lint:boundaries
npm run test:sidecar
npm run test:e2e:source-live-apply -- --project=chromium
VITE_ENABLE_CHINA_FUTURES_NEWS=1 npm run test:e2e:source-live-apply -- --project=chromium --grep 'SHFE opt-in'
```

Unit/integration tests use a captured minimal SHFE listing and controlled Redis responses. Browser checks use a labelled synthetic digest and the original settings/panels. They do not prove a deployed worker, live Redis freshness, Edge deployment, model responses, historical archival or publisher licensing. Those are separate acceptance gates. Chinese AI retrieval and commodity history are later modules.
