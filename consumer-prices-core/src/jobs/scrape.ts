/**
 * Scrape job: discovers targets and writes price observations to Postgres.
 * Respects per-retailer rate limits and acquisition provider config.
 */
import { query, closePool } from '../db/client.js';
import { insertObservation } from '../db/queries/observations.js';
import { upsertRetailerProduct } from '../db/queries/products.js';
import { parseSize, unitPrice as calcUnitPrice } from '../normalizers/size.js';
import { loadAllRetailerConfigs, loadRetailerConfig } from '../config/loader.js';
import { initProviders, teardownAll } from '../acquisition/registry.js';
import { GenericPlaywrightAdapter } from '../adapters/generic.js';
import { ExaSearchAdapter } from '../adapters/exa-search.js';
import { SearchAdapter } from '../adapters/search.js';
import { ExaProvider } from '../acquisition/exa.js';
import { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from '../adapters/types.js';
import { upsertCanonicalProduct } from '../db/queries/products.js';
import { getBasketItemId, getPinnedUrlsForRetailer, upsertProductMatch } from '../db/queries/matches.js';

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[scrape] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[scrape] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[scrape] ${msg}`, ...args),
};

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getOrCreateRetailer(slug: string, config: ReturnType<typeof loadRetailerConfig>) {
  const result = await query<{ id: string }>(
    `INSERT INTO retailers (slug, name, market_code, country_code, currency_code, adapter_key, base_url, active)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$7)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, adapter_key = EXCLUDED.adapter_key,
       base_url = EXCLUDED.base_url, active = EXCLUDED.active, updated_at = NOW()
     RETURNING id`,
    [slug, config.name, config.marketCode, config.currencyCode, config.adapter, config.baseUrl, config.enabled],
  );
  return result.rows[0].id;
}

async function createScrapeRun(retailerId: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO scrape_runs (retailer_id, started_at, status, trigger_type, pages_attempted, pages_succeeded, errors_count, config_version)
     VALUES ($1, NOW(), 'running', 'scheduled', 0, 0, 0, '1') RETURNING id`,
    [retailerId],
  );
  return result.rows[0].id;
}

async function updateScrapeRun(
  runId: string,
  status: string,
  pagesAttempted: number,
  pagesSucceeded: number,
  errorsCount: number,
) {
  await query(
    `UPDATE scrape_runs SET status=$2, finished_at=NOW(), pages_attempted=$3, pages_succeeded=$4, errors_count=$5 WHERE id=$1`,
    [runId, status, pagesAttempted, pagesSucceeded, errorsCount],
  );
}

async function handlePinError(productId: string, matchId: string, targetId: string) {
  const { rows } = await query<{ c: string }>(
    `UPDATE retailer_products SET pin_error_count = pin_error_count + 1
     WHERE id = $1 RETURNING pin_error_count AS c`,
    [productId],
  );
  const count = parseInt(rows[0]?.c ?? '0', 10);
  if (count >= 3) {
    await query(`UPDATE product_matches SET pin_disabled_at = NOW() WHERE id = $1`, [matchId]);
    logger.info(`  [pin] soft-disabled stale pin for ${targetId} (${count}x errors)`);
  }
}

export async function scrapeRetailer(slug: string) {
  const config = loadRetailerConfig(slug);

  // Always sync active state from YAML to DB, even for disabled retailers.
  const retailerId = await getOrCreateRetailer(slug, config);

  if (!config.enabled) {
    logger.info(`${slug} is disabled, skipping`);
    return;
  }

  // Validate API keys before opening a scrape_run row — an early throw here
  // would otherwise leave the run stuck in status='running' forever.
  const exaKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  const fcKey = process.env.FIRECRAWL_API_KEY ?? '';

  if (config.adapter === 'search') {
    if (!exaKey) throw new Error(`search adapter requires EXA_API_KEY / EXA_API_KEYS (retailer: ${slug})`);
    if (!fcKey) throw new Error(`search adapter requires FIRECRAWL_API_KEY (retailer: ${slug})`);
  }

  const runId = await createScrapeRun(retailerId);
  logger.info(`Run ${runId} started for ${slug}`);

  const pinnedUrls = await getPinnedUrlsForRetailer(retailerId);
  logger.info(`${slug}: ${pinnedUrls.size} pins loaded`);

  const adapter =
    config.adapter === 'search'
      ? new SearchAdapter(new ExaProvider(exaKey), new FirecrawlProvider(fcKey))
      : config.adapter === 'exa-search'
      ? new ExaSearchAdapter(exaKey, process.env.FIRECRAWL_API_KEY)
      : new GenericPlaywrightAdapter();
  const ctx: AdapterContext = { config, runId, logger, retailerId, pinnedUrls };

  const targets = await adapter.discoverTargets(ctx);
  logger.info(`Discovered ${targets.length} targets`);

  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let errorsCount = 0;

  const delay = config.rateLimit?.delayBetweenRequestsMs ?? 2_000;

  for (const target of targets) {
    pagesAttempted++;
    const isDirect = target.metadata?.direct === true;
    const pinnedProductId = target.metadata?.pinnedProductId as string | undefined;
    const pinnedMatchId = target.metadata?.matchId as string | undefined;
    try {
      const fetchResult = await adapter.fetchTarget(ctx, target);
      const products = await adapter.parseListing(ctx, fetchResult);

      if (products.length === 0) {
        logger.warn(`  [${target.id}] parsed 0 products — counting as error`);
        errorsCount++;
        if (isDirect && pinnedProductId && pinnedMatchId) {
          await handlePinError(pinnedProductId, pinnedMatchId, target.id);
        }
        continue;
      }
      logger.info(`  [${target.id}] parsed ${products.length} products`);

      for (const product of products) {
        // wasDirectHit=true only when the pin URL itself was successfully used.
        // fetchTarget sets direct:false in the payload when it falls back to Exa,
        // so this correctly distinguishes "pin worked" from "pin failed, Exa used instead".
        const wasDirectHit = isDirect && product.rawPayload.direct === true;

        const productId = await upsertRetailerProduct({
          retailerId,
          retailerSku: product.retailerSku,
          sourceUrl: product.sourceUrl,
          rawTitle: product.rawTitle,
          rawBrand: product.rawBrand,
          rawSizeText: product.rawSizeText,
          imageUrl: product.imageUrl,
          categoryText: product.categoryText ?? target.category,
        });

        const parsed = parseSize(product.rawSizeText);
        const up = parsed ? calcUnitPrice(product.price, parsed) : null;

        await insertObservation({
          retailerProductId: productId,
          scrapeRunId: runId,
          price: product.price,
          listPrice: product.listPrice,
          promoPrice: product.promoPrice,
          currencyCode: config.currencyCode,
          unitPrice: up,
          unitBasisQty: parsed?.baseQuantity ?? null,
          unitBasisUnit: parsed?.baseUnit ?? null,
          inStock: product.inStock,
          promoText: product.promoText,
          rawPayloadJson: product.rawPayload,
        });

        // Stale-pin maintenance — only when the pin URL was actually used (not Exa fallback).
        if (wasDirectHit && pinnedProductId && pinnedMatchId) {
          if (product.inStock) {
            await query(
              `UPDATE retailer_products SET consecutive_out_of_stock = 0, pin_error_count = 0 WHERE id = $1`,
              [pinnedProductId],
            );
          } else {
            const { rows } = await query<{ c: string }>(
              `UPDATE retailer_products
               SET consecutive_out_of_stock = consecutive_out_of_stock + 1
               WHERE id = $1 RETURNING consecutive_out_of_stock AS c`,
              [pinnedProductId],
            );
            const count = parseInt(rows[0]?.c ?? '0', 10);
            if (count >= 3) {
              await query(`UPDATE product_matches SET pin_disabled_at = NOW() WHERE id = $1`, [pinnedMatchId]);
              logger.info(`  [pin] soft-disabled stale pin for ${target.id} (${count}x out-of-stock)`);
            }
          }
        }

        // When a pinned target fell back to Exa (isDirect but !wasDirectHit),
        // increment pin_error_count so the old broken pin eventually gets disabled.
        if (isDirect && !wasDirectHit && pinnedProductId && pinnedMatchId) {
          await handlePinError(pinnedProductId, pinnedMatchId, target.id);
        }

        // For search-based adapters: auto-create product → basket match.
        // Skip only when the pin URL was used directly — the match already exists.
        // Allow when this is a fresh Exa discovery (including Exa fallback from a broken pin).
        if (
          !wasDirectHit &&
          (config.adapter === 'exa-search' || config.adapter === 'search') &&
          product.rawPayload.basketSlug &&
          product.rawPayload.canonicalName
        ) {
          try {
            const canonicalId = await upsertCanonicalProduct({
              canonicalName: (product.rawPayload.canonicalName as string) || product.rawTitle,
              category: product.categoryText ?? target.category,
            });
            const basketItemId = await getBasketItemId(
              product.rawPayload.basketSlug as string,
              product.rawPayload.canonicalName as string,
            );
            if (basketItemId) {
              await upsertProductMatch({
                retailerProductId: productId,
                canonicalProductId: canonicalId,
                basketItemId,
                matchScore: 1.0,
                matchStatus: 'auto',
              });
            }
          } catch (matchErr) {
            logger.warn(`  [${target.id}] product match failed: ${matchErr}`);
          }
        }
      }

      pagesSucceeded++;
    } catch (err) {
      errorsCount++;
      logger.error(`  [${target.id}] failed: ${err}`);
      if (isDirect && pinnedProductId && pinnedMatchId) {
        await handlePinError(pinnedProductId, pinnedMatchId, target.id);
      }
    }

    if (pagesAttempted < targets.length) await sleep(delay);
  }

  const status = errorsCount === 0 ? 'completed' : pagesSucceeded > 0 ? 'partial' : 'failed';
  await updateScrapeRun(runId, status, pagesAttempted, pagesSucceeded, errorsCount);
  logger.info(`Run ${runId} finished: ${status} (${pagesSucceeded}/${pagesAttempted} pages)`);

  const parseSuccessRate = pagesAttempted > 0 ? (pagesSucceeded / pagesAttempted) * 100 : 0;
  const isSuccess = status === 'completed' || status === 'partial';
  await query(
    `INSERT INTO data_source_health
       (retailer_id, last_successful_run_at, last_run_status, parse_success_rate, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (retailer_id) DO UPDATE SET
       last_successful_run_at = COALESCE($2, data_source_health.last_successful_run_at),
       last_run_status    = EXCLUDED.last_run_status,
       parse_success_rate = EXCLUDED.parse_success_rate,
       updated_at         = NOW()`,
    [retailerId, isSuccess ? new Date() : null, status, Math.round(parseSuccessRate * 100) / 100],
  );

}

export async function scrapeAll() {
  // initProviders is required for GenericPlaywrightAdapter (playwright/p0 adapters use the
  // registry via fetchWithFallback). SearchAdapter and ExaSearchAdapter construct their own
  // provider instances directly from env vars and bypass the registry.
  initProviders(process.env as Record<string, string>);
  // Iterate ALL configs (including disabled) so getOrCreateRetailer syncs active=false to DB.
  // scrapeRetailer() returns early after the upsert for disabled retailers.
  const configs = loadAllRetailerConfigs();
  logger.info(`Syncing ${configs.length} retailers (${configs.filter((c) => c.enabled).length} enabled)`);

  // Run retailers in parallel: each hits a different domain so rate limits don't conflict.
  // Cap at 5 concurrent to avoid saturating Firecrawl's global request limits.
  const CONCURRENCY = 5;
  const queue = [...configs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const cfg = queue.shift()!;
      try {
        await scrapeRetailer(cfg.slug);
      } catch (err) {
        logger.warn(`scrapeRetailer ${cfg.slug} failed: ${err}`);
      }
    }
  });
  await Promise.all(workers);

  await teardownAll();
}

async function main() {
  try {
    if (process.argv[2]) {
      initProviders(process.env as Record<string, string>);
      try {
        await scrapeRetailer(process.argv[2]);
      } finally {
        await teardownAll();
      }
    } else {
      await scrapeAll();
    }
  } catch (err) {
    console.error('[scrape] fatal:', err);
    process.exitCode = 1;
  } finally {
    // Race closePool against a 5s timeout — mirrors the teardown() fix in playwright.ts.
    // Without a bound, a hung pg pool would keep main() pending indefinitely,
    // delaying process.exit() and stalling the && chain (aggregate, publish).
    const poolTimeout = new Promise<void>(r => setTimeout(r, 5000));
    await Promise.race([closePool().catch(() => {}), poolTimeout]);
  }
}

// process.exit() is required to flush lingering Playwright/Chromium handles
// that would otherwise prevent the process from exiting naturally.
// process.exitCode preserves failure signaling set in the catch block above.
main().catch(() => { process.exitCode = 1; }).then(() => process.exit(process.exitCode ?? 0));
