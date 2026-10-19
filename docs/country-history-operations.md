---
title: "Activate daily country history"
noindex: true
---

# Activate daily country history

The repository registers `seed-country-history` as planned. Creating or deploying its Railway service requires operator approval.

1. Use the existing scripts-root Nixpacks pattern with root directory `scripts`.
2. Set the start command to `node seed-country-history.mjs`.
3. Set the cron schedule to `30 0 * * *` in UTC.
4. Attach `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` explicitly. Railway shared variables do not auto-inherit.
5. Deploy the reviewed commit only after approval.
6. Verify `[country-history] published=196 date=YYYY-MM-DD` after the natural scheduled run.
7. Verify `seed-meta:history:country`, `history:country:index` and the permanent activation marker belong to that publication.
8. Read anonymous, Pro and API windows. Check the `effectiveDays`, `allowedDays`, source versions and no-store headers.

The worker reads `risk:scores:sebuf:stale:v11`, `resilience:ranking:v29` and `news:digest:v1:full:en`.
Update these source keys when their publishers change namespace. Fixture tests verify the current source-key wiring.
It accepts CII and news at most 30 minutes old, and resilience ranking at most 12 hours old.
Unavailable inputs fail the run without advancing the archive heartbeat.

The archive retains 365 UTC calendar days, including the capture date.
It stores selected title/link/source/category records, without full article text.
No historical write or backfill runs during PR verification.

For the first 48 hours after activation, the operator checks the archive health entry after each scheduled run.
Healthy publication reports 196 countries and one record per captured country/date.
A missed run over 36 hours reports `STALE_SEED`. A write error or count below 196 requires inspection of the source caches and worker log.
Disable the cron if writes corrupt data or the worker repeatedly fails. Preserve existing history and its last successful health timestamp while investigating.
Do not delete the activation marker as a recovery action.

Natural accumulation remains an acceptance gate. After N successful UTC capture dates, confirm N points for Tier-1 countries within each caller's allowed window.
Code tests, mergeability and deployment status do not prove this observation.
