/**
 * Smoke test: SearchAdapter end-to-end against live Exa + Firecrawl APIs.
 * Tests 2 items on each of the 4 AE retailers.
 * Run with: EXA_API_KEYS=... FIRECRAWL_API_KEY=... npx tsx src/adapters/search.smoke.ts
 */
import { ExaProvider } from '../acquisition/exa.js';
import { FirecrawlProvider } from '../acquisition/firecrawl.js';
import { SearchAdapter } from './search.js';
import { loadRetailerConfig } from '../config/loader.js';
import type { AdapterContext } from './types.js';

const RETAILERS = ['carrefour_ae', 'spinneys_ae', 'lulu_ae', 'noon_grocery_ae'];
const ITEMS = [
  { id: 'eggs', canonicalName: 'Eggs Fresh 12 Pack', category: 'dairy-eggs' },
  { id: 'milk', canonicalName: 'Full Fat Fresh Milk 1L', category: 'dairy-eggs' },
  { id: 'tomatoes', canonicalName: 'Tomatoes Fresh 1kg', category: 'produce' },
];

const exaKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
const fcKey = process.env.FIRECRAWL_API_KEY ?? '';

if (!exaKey || !fcKey) {
  console.error('Missing EXA_API_KEYS or FIRECRAWL_API_KEY');
  process.exit(1);
}

const adapter = new SearchAdapter(new ExaProvider(exaKey), new FirecrawlProvider(fcKey));

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn('[WARN]', msg),
  error: (msg: string) => console.error('[ERR]', msg),
  debug: () => {},
};

let passed = 0;
let failed = 0;

for (const slug of RETAILERS) {
  const retailerCfg = loadRetailerConfig(slug);
  const domain = new URL(retailerCfg.baseUrl).hostname;

  const ctx: AdapterContext = {
    config: retailerCfg,
    logger,
    runId: `smoke-${slug}`,
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Retailer: ${retailerCfg.name} (${slug})`);
  console.log(`Domain: ${domain}`);
  console.log(`${'='.repeat(60)}`);

  for (const item of ITEMS) {
    const target = {
      id: item.id,
      url: retailerCfg.baseUrl,
      category: item.category,
      metadata: {
        canonicalName: item.canonicalName,
        domain,
        basketSlug: 'essentials_ae',
        currency: retailerCfg.currencyCode,
      },
    };

    process.stdout.write(`  ${item.canonicalName.padEnd(30)} `);
    try {
      const fetchResult = await adapter.fetchTarget(ctx, target);
      const products = await adapter.parseListing(ctx, fetchResult);
      if (products.length > 0 && products[0].price > 0) {
        console.log(`✓  ${products[0].price} ${retailerCfg.currencyCode}  "${products[0].rawTitle?.slice(0, 50)}"`);
        passed++;
      } else {
        console.log(`✗  parseListing returned empty/zero price`);
        failed++;
      }
    } catch (err) {
      console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    // Respect rate limits between items
    await new Promise((r) => setTimeout(r, 4000));
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
