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
import { getBasketItemId, upsertProductMatch } from '../db/queries/matches.js';

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
    `INSERT INTO retailers (slug, name, market_code, country_code, currency_code, adapter_key, base_url)
     VALUES ($1,$2,$3,$3,$4,$5,$6)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, adapter_key = EXCLUDED.adapter_key,
       base_url = EXCLUDED.base_url, updated_at = NOW()
     RETURNING id`,
    [slug, config.name, config.marketCode, config.currencyCode, config.adapter, config.baseUrl],
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

export async function scrapeRetailer(slug: string) {
  initProviders(process.env as Record<string, string>);

  const config = loadRetailerConfig(slug);
  if (!config.enabled) {
    logger.info(`${slug} is disabled, skipping`);
    return;
  }

  const retailerId = await getOrCreateRetailer(slug, config);
  const runId = await createScrapeRun(retailerId);

  logger.info(`Run ${runId} started for ${slug}`);

  const exaKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  const fcKey = process.env.FIRECRAWL_API_KEY ?? '';

  if (config.adapter === 'search') {
    if (!exaKey) throw new Error(`search adapter requires EXA_API_KEY / EXA_API_KEYS (retailer: ${slug})`);
    if (!fcKey) throw new Error(`search adapter requires FIRECRAWL_API_KEY (retailer: ${slug})`);
  }

  const adapter =
    config.adapter === 'search'
      ? new SearchAdapter(new ExaProvider(exaKey), new FirecrawlProvider(fcKey))
      : config.adapter === 'exa-search'
      ? new ExaSearchAdapter(exaKey, process.env.FIRECRAWL_API_KEY)
      : new GenericPlaywrightAdapter();
  const ctx: AdapterContext = { config, runId, logger };

  const targets = await adapter.discoverTargets(ctx);
  logger.info(`Discovered ${targets.length} targets`);

  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let errorsCount = 0;

  const delay = config.rateLimit?.delayBetweenRequestsMs ?? 2_000;

  for (const target of targets) {
    pagesAttempted++;
    try {
      const fetchResult = await adapter.fetchTarget(ctx, target);
      const products = await adapter.parseListing(ctx, fetchResult);

      if (products.length === 0) {
        logger.warn(`  [${target.id}] parsed 0 products — counting as error`);
        errorsCount++;
        continue;
      }
      logger.info(`  [${target.id}] parsed ${products.length} products`);

      for (const product of products) {
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

        // For search-based adapters: auto-create product → basket match since we
        // searched for a specific basket item (no ambiguity in what was scraped).
        if (
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

  await teardownAll();
}

export async function scrapeAll() {
  initProviders(process.env as Record<string, string>);
  const configs = loadAllRetailerConfigs().filter((c) => c.enabled);
  logger.info(`Scraping ${configs.length} retailers`);
  for (const c of configs) {
    await scrapeRetailer(c.slug);
  }
}

async function main() {
  try {
    if (process.argv[2]) {
      await scrapeRetailer(process.argv[2]);
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
