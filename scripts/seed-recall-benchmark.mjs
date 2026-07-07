#!/usr/bin/env node
/**
 * #4920 (c): external recall benchmark.
 *
 * Daily job (runs in the feed-validation GitHub Actions workflow, after
 * validation — no Railway slot): pulls the current top articles from
 * GDELT's public DOC API across broad news verticals, checks whether each
 * appears anywhere in the digest we actually ingested
 * (news:digest:v1:full:en), and publishes the recall percentage + the
 * missed headlines to news:recall-benchmark:v1.
 *
 * This is the pipeline's first ground-truth completeness number: "of the
 * stories a neutral external index considers top news today, what
 * fraction does WorldMonitor carry?" Misses are listed by lowest
 * similarity so coverage holes are actionable (add a feed / fix a
 * wrapper), not just a percentage.
 *
 * Exit policy: analysis job — any upstream failure logs and exits 0
 * (the workflow must not redden on GDELT jitter). Missing Redis creds
 * skip silently (local runs).
 */

import { fetchGdeltJson } from './_gdelt-fetch.mjs';
import { computeRecall } from './_recall-benchmark-core.mjs';
import { pathToFileURL } from 'node:url';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

const RECALL_KEY = 'news:recall-benchmark:v1';
const META_KEY = 'seed-meta:news:recall-benchmark';
const DIGEST_KEY = 'news:digest:v1:full:en';

// Broad verticals, not niche topics — the benchmark asks "are we carrying
// the big stories", so the reference set must be what a general reader
// would consider top news. maxrecords kept modest: 25×4 ≈ 100 external
// stories/day is plenty of signal without hammering GDELT.
const REFERENCE_QUERIES = [
  { label: 'conflict', q: '(conflict OR military OR war OR strike)' },
  { label: 'economy', q: '(economy OR markets OR inflation OR "central bank")' },
  { label: 'disaster', q: '(earthquake OR flood OR hurricane OR wildfire OR disaster)' },
  { label: 'diplomacy', q: '(summit OR sanctions OR treaty OR election)' },
];

export function gdeltUrl(query) {
  const params = new URLSearchParams({
    query: `${query} sourcelang:eng`,
    mode: 'ArtList',
    format: 'json',
    sort: 'HybridRel',
    timespan: '24h',
    maxrecords: '25',
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

export function unwrapEnvelope(parsed) {
  // Canonical keys may be stored as { data, fetchedAt, ... } envelopes or
  // bare payloads — same tolerance as scripts/seed-insights.mjs.
  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
    return parsed.data;
  }
  return parsed;
}

async function main() {
  const creds = getOptionalUpstashCreds();
  if (!creds) {
    console.log('recall-benchmark skipped (no UPSTASH_REDIS_REST_URL/TOKEN in env)');
    return;
  }

  // 1. Digest titles — what we actually ingested.
  const got = await upstashCommand(creds, ['GET', DIGEST_KEY]);
  if (typeof got?.result !== 'string' || got.result.length === 0) {
    console.warn(`WARN: ${DIGEST_KEY} missing/empty — cannot benchmark, skipping`);
    return;
  }
  const digest = unwrapEnvelope(JSON.parse(got.result));
  const digestTitles = Object.values(digest?.categories ?? {})
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .map((item) => item?.title)
    .filter((title) => typeof title === 'string' && title.length > 0);
  if (digestTitles.length === 0) {
    console.warn('WARN: digest carried zero titles — skipping');
    return;
  }

  // 2. External reference set from GDELT.
  const seenUrls = new Set();
  const externalItems = [];
  // #4929 external review: production retry defaults (3 retries × 10s
  // backoff + 5 proxy attempts, ×4 sequential queries) could consume much
  // of the 25-minute workflow. Benchmark-grade fast-fail limits + a shared
  // wall-clock deadline: partial reference sets are fine, a hung workflow
  // is not.
  const GDELT_DEADLINE_MS = 4 * 60 * 1000;
  const gdeltStartedAt = Date.now();
  for (const { label, q } of REFERENCE_QUERIES) {
    if (Date.now() - gdeltStartedAt > GDELT_DEADLINE_MS) {
      console.warn(`  [gdelt:${label}] skipped — shared 4-min GDELT deadline exhausted`);
      continue;
    }
    try {
      const json = await fetchGdeltJson(gdeltUrl(q), {
        label: `recall-${label}`,
        timeoutMs: 10_000,
        maxRetries: 1,
        retryBaseMs: 2_000,
        proxyMaxAttempts: 1,
      });
      const articles = Array.isArray(json?.articles) ? json.articles : [];
      for (const article of articles) {
        const title = article?.title;
        const url = article?.url;
        if (typeof title !== 'string' || title.length < 10) continue;
        if (url && seenUrls.has(url)) continue;
        if (url) seenUrls.add(url);
        externalItems.push({ title, url, vertical: label });
      }
      console.log(`  [gdelt:${label}] ${articles.length} articles`);
    } catch (err) {
      console.warn(`  [gdelt:${label}] failed: ${err.message} — continuing with remaining verticals`);
    }
  }
  if (externalItems.length < 20) {
    console.warn(`WARN: only ${externalItems.length} external articles — too thin to publish, skipping`);
    return;
  }

  // 3. Recall.
  const result = computeRecall(externalItems, digestTitles);
  console.log(
    `recall: ${result.recallPct}% (${result.matched}/${result.total} external stories present; ` +
      `${digestTitles.length} digest titles; ${result.unvectorizable} unvectorizable)`,
  );
  for (const miss of result.missed) {
    console.log(`  MISSED (best ${miss.bestScore}): ${miss.title}`);
  }

  // 4. Publish.
  const payload = {
    v: 1,
    checkedAt: Date.now(),
    recallPct: result.recallPct,
    matched: result.matched,
    total: result.total,
    digestTitleCount: digestTitles.length,
    threshold: result.threshold,
    // Untrusted external titles: clamp length so a hostile/broken GDELT
    // response cannot balloon the published payload.
    missed: result.missed.map((m) => ({
      ...m,
      title: String(m.title).slice(0, 200),
      // Only http(s) URLs, clamped — GDELT fields are untrusted input.
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url.slice(0, 300) : undefined,
    })),
  };
  await upstashCommand(creds, ['SET', RECALL_KEY, JSON.stringify(payload), 'EX', String(3 * 86400)]);
  await upstashCommand(creds, ['SET', META_KEY, JSON.stringify({
    fetchedAt: payload.checkedAt,
    recordCount: result.total,
    sourceVersion: 'recall-benchmark-v1',
  }), 'EX', String(7 * 86400)]);
  // Durable activation marker — NO TTL by design (#4927 re-review P1); see
  // validate-rss-feeds.mjs for the rationale.
  await upstashCommand(creds, ['SET', 'seed-activated:news:recall-benchmark', '1']);
  console.log(`published ${RECALL_KEY}`);
}

// Importable for tests; only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Analysis job: never redden the workflow on upstream jitter.
    console.warn(`recall-benchmark failed (non-fatal): ${err.message}`);
  });
}
