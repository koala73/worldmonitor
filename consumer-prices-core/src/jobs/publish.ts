/**
 * Publish job: builds compact WorldMonitor snapshot payloads and writes to Redis.
 * Runs as an independent Railway cron service (02:30 UTC daily) after aggregate.
 * This is the handoff point between consumer-prices-core and WorldMonitor.
 */
import {
  buildBasketSeriesSnapshot,
  buildCategoriesSnapshot,
  buildFreshnessSnapshot,
  buildMoversSnapshot,
  buildOverviewSnapshot,
  buildRetailerSpreadSnapshot,
} from '../snapshots/worldmonitor.js';
import { buildCoverageSnapshot } from '../snapshots/coverage.js';
import { loadAllBasketConfigs, loadAllRetailerConfigs } from '../config/loader.js';
import { closePool } from '../db/client.js';

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[publish] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[publish] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[publish] ${msg}`, ...args),
};

function makeKey(parts: string[]): string {
  return parts.join(':');
}

function recordCount(data: unknown): number {
  if (!data || typeof data !== 'object') return 1;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.risers) || Array.isArray(d.fallers)) {
    const risers = Array.isArray(d.risers) ? d.risers.length : 0;
    const fallers = Array.isArray(d.fallers) ? d.fallers.length : 0;
    // Movers is bipolar and a fully-flat window (risers=0, fallers=0) is still a
    // valid snapshot. advanceSeedMeta already gates writes on upstream freshness,
    // so floor at 1 here to prevent health from flagging EMPTY_DATA on quiet markets.
    return Math.max(1, risers + fallers);
  }
  const arr = d.retailers ?? d.essentialsSeries ?? d.categories;
  return Array.isArray(arr) ? arr.length : 1;
}

async function upstashCommand(url: string, token: string, command: unknown[]): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!resp.ok) throw new Error(`Upstash ${command[0]} failed: HTTP ${resp.status}`);
}

// Seed envelope shape — mirrored from scripts/_seed-envelope-source.mjs.
// consumer-prices-core is a standalone package so we inline the tiny helper
// rather than taking a cross-package dependency. Keep in lockstep with:
//   - scripts/_seed-envelope-source.mjs
//   - server/_shared/seed-envelope.ts
//   - api/_seed-envelope.js
// Any change to the envelope shape must update all four.
const SOURCE_VERSION = 'consumer-prices-core-publish-v1';
const SCHEMA_VERSION = 1;

function buildEnvelope(data: unknown, count: number): { _seed: Record<string, unknown>; data: unknown } {
  return {
    _seed: {
      fetchedAt: Date.now(),
      recordCount: count,
      sourceVersion: SOURCE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      state: count > 0 ? 'OK' : 'OK_ZERO',
    },
    data,
  };
}

async function writeSnapshot(
  url: string,
  token: string,
  key: string,
  data: unknown,
  ttlSeconds: number,
  advanceSeedMeta = true,
  coverage?: {
    status?: string;
    pagesOk: number;
    pagesFailed: number;
    rejectedCount: number;
    completionRatio?: number | null;
    failureReasons?: Record<string, number>;
    retailers?: unknown[];
  },
): Promise<void> {
  const count = recordCount(data);
  // Envelope the canonical payload. Legacy seed-meta:<key> is still written
  // below so unmigrated readers keep working during dual-write.
  const envelope = buildEnvelope(data, count);
  const json = JSON.stringify(envelope);
  await upstashCommand(url, token, ['SET', key, json, 'EX', ttlSeconds]);
  if (advanceSeedMeta) {
    const meta: Record<string, unknown> = { fetchedAt: Date.now(), recordCount: count };
    if (coverage) {
      const completionRatio = coverage.completionRatio ?? (coverage.pagesOk + coverage.pagesFailed > 0
        ? Number((coverage.pagesOk / (coverage.pagesOk + coverage.pagesFailed)).toFixed(4))
        : 0);
      meta.coverage = {
        ...(coverage.status ? { status: coverage.status } : {}),
        completedPages: coverage.pagesOk,
        failedPages: coverage.pagesFailed,
        completionRatio,
        rejectedCount: coverage.rejectedCount,
        ...(coverage.failureReasons ? { failureReasons: coverage.failureReasons } : {}),
        ...(coverage.retailers ? { retailers: coverage.retailers } : {}),
      };
    }
    await upstashCommand(url, token, [
      'SET',
      makeKey(['seed-meta', key]),
      JSON.stringify(meta),
      'EX',
      ttlSeconds * 2,
    ]);
  }
  logger.info(`  wrote ${key} (${json.length} bytes, records=${count}, ttl=${ttlSeconds}s, meta=${advanceSeedMeta})`);
}

// 26h TTL — longer than the 24h cron cadence to survive scheduling drift
const TTL = 93600;
// Freshness gate: at least one retailer scraped within this window advances seed-meta
const FRESH_DATA_THRESHOLD_MIN = 120;

export async function publishAll() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set');

  const retailers = loadAllRetailerConfigs().filter((r) => r.enabled);
  const markets = [...new Set(retailers.map((r) => r.marketCode))];
  const baskets = loadAllBasketConfigs();

  // Build freshness snapshots first — used both to gate seed-meta and as the written payload
  const marketFreshnessSnapshots: Record<string, Awaited<ReturnType<typeof buildFreshnessSnapshot>> | null> = {};
  for (const marketCode of markets) {
    try {
      marketFreshnessSnapshots[marketCode] = await buildFreshnessSnapshot(marketCode);
    } catch {
      marketFreshnessSnapshots[marketCode] = null;
    }
  }

  let totalPagesFailed = 0;
  for (const marketCode of markets) {
    const freshnessSnapshot = marketFreshnessSnapshots[marketCode];
    // hasFreshData = at least one retailer scraped within last 2 hours
    // NOTE: overallFreshnessMin is an average — using .some() to correctly check "any retailer is fresh"
    const advanceSeedMeta =
      freshnessSnapshot != null &&
      freshnessSnapshot.retailers.some(
        (r) => r.freshnessMin >= 0 && r.freshnessMin < FRESH_DATA_THRESHOLD_MIN,
      );
    logger.info(`Publishing snapshots for market: ${marketCode} (freshData=${advanceSeedMeta})`);

    let pagesOk = 0;
    let pagesFailed = 0;

    try {
      const coverage = await buildCoverageSnapshot(marketCode);
      await writeSnapshot(
        url,
        token,
        makeKey(['consumer-prices', 'coverage', marketCode]),
        coverage,
        TTL,
        advanceSeedMeta,
        {
          pagesOk: coverage.completedPages,
          pagesFailed: coverage.failedPages,
          rejectedCount: coverage.rejectedCount,
          completionRatio: coverage.completionRatio,
          status: coverage.status,
          failureReasons: coverage.failureReasons,
          retailers: coverage.retailers,
        },
      );
      pagesOk++;
    } catch (err) {
      pagesFailed++;
      logger.error(`coverage:${marketCode} failed: ${err}`);
    }

    try {
      const overview = await buildOverviewSnapshot(marketCode);
      await writeSnapshot(url, token, makeKey(['consumer-prices', 'overview', marketCode]), overview, TTL, advanceSeedMeta, { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 });
      pagesOk++;
    } catch (err) {
      pagesFailed++;
      logger.error(`overview:${marketCode} failed: ${err}`);
    }

    for (const days of [7, 30]) {
      try {
        const movers = await buildMoversSnapshot(marketCode, days);
        await writeSnapshot(url, token, makeKey(['consumer-prices', 'movers', marketCode, `${days}d`]), movers, TTL, advanceSeedMeta, { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 });
        pagesOk++;
      } catch (err) {
        pagesFailed++;
        logger.error(`movers:${marketCode}:${days}d failed: ${err}`);
      }
    }

    try {
      // Reuse already-built freshness snapshot — no second DB query
      if (freshnessSnapshot != null) {
        await writeSnapshot(url, token, makeKey(['consumer-prices', 'freshness', marketCode]), freshnessSnapshot, TTL, advanceSeedMeta, { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 });
        pagesOk++;
      }
    } catch (err) {
      pagesFailed++;
      logger.error(`freshness:${marketCode} failed: ${err}`);
    }

    for (const range of ['7d', '30d', '90d']) {
      try {
        const categories = await buildCategoriesSnapshot(marketCode, range);
        await writeSnapshot(url, token, makeKey(['consumer-prices', 'categories', marketCode, range]), categories, TTL, advanceSeedMeta, { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 });
        pagesOk++;
      } catch (err) {
        pagesFailed++;
        logger.error(`categories:${marketCode}:${range} failed: ${err}`);
      }
    }

    for (const basket of baskets.filter((b) => b.marketCode === marketCode)) {
      try {
        const spread = await buildRetailerSpreadSnapshot(marketCode, basket.slug);
        await writeSnapshot(
          url, token,
          makeKey(['consumer-prices', 'retailer-spread', marketCode, basket.slug]),
          spread,
          TTL,
          advanceSeedMeta,
          { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 },
        );
        pagesOk++;
      } catch (err) {
        pagesFailed++;
        logger.error(`spread:${marketCode}:${basket.slug} failed: ${err}`);
      }

      for (const range of ['7d', '30d', '90d']) {
        try {
          const series = await buildBasketSeriesSnapshot(marketCode, basket.slug, range);
          await writeSnapshot(
            url, token,
            makeKey(['consumer-prices', 'basket-series', marketCode, basket.slug, range]),
            series,
            TTL,
            advanceSeedMeta,
            { pagesOk: 1, pagesFailed: 0, rejectedCount: 0 },
          );
          pagesOk++;
        } catch (err) {
          pagesFailed++;
          logger.error(`basket-series:${marketCode}:${basket.slug}:${range} failed: ${err}`);
        }
      }
    }

    const totalSnapshots = pagesOk + pagesFailed;
    const completionRatio = totalSnapshots > 0 ? Number((pagesOk / totalSnapshots).toFixed(4)) : 0;
    logger.info(`  market ${marketCode} done: ${pagesOk}/${totalSnapshots} ok, ratio=${completionRatio}`);
    totalPagesFailed += pagesFailed;
  }

  if (totalPagesFailed > 0) {
    throw new Error(`${totalPagesFailed} snapshot publication${totalPagesFailed === 1 ? '' : 's'} failed`);
  }

  logger.info('Publish complete');
}

export async function runPublishCli(): Promise<void> {
  // Terminal success marker (format mirrors runSeed() in scripts/_seed-utils.mjs) so the crash
  // diagnostic can distinguish a clean run from a silent death. Emit it only after publication
  // resolves. Plain console.log, not the logger, so the marker survives whatever transport/format
  // the logger uses.
  const runStartedAt = Date.now();
  let failure: unknown;
  let failed = false;
  try {
    await publishAll();
    console.log(`\n=== Done (${Date.now() - runStartedAt}ms) ===`);
  } catch (err) {
    // Mirror scrape.ts: failed publishes must fail the cron, not exit 0.
    console.error(err);
    process.exitCode = 1;
    failure = err;
    failed = true;
  }

  try {
    await closePool();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
    if (!failed) failure = err;
    failed = true;
  }

  if (failed) throw failure;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runPublishCli().catch(() => {});
}
