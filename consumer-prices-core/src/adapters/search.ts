/**
 * SearchAdapter — two-stage grocery price pipeline.
 *
 * Stage 1 (Exa): neural search on retailer domain → ranked product page URLs
 * Stage 2 (Firecrawl): structured LLM extraction from the confirmed URL → {price, currency, inStock}
 *
 * Pin path: if a matching pin exists in ctx.pinnedUrls, Exa is skipped and Firecrawl
 * is called directly on the stored URL. On failure, falls back to the normal Exa flow
 * in the same run so the basket item is never left uncovered.
 *
 * Replaces ExaSearchAdapter's fragile regex-on-AI-summary approach.
 * Firecrawl renders JS so dynamic prices (Noon, etc.) are visible.
 * Domain allowlist + title plausibility check prevent wrong-product and SSRF risks.
 */
import { z } from 'zod';
import { loadAllBasketConfigs } from '../config/loader.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { RetailerConfig } from '../config/types.js';
import type { AdapterContext, FetchResult, ParsedProduct, RetailerAdapter, Target } from './types.js';
import { MARKET_NAMES } from './market-names.js';
import { parseSize } from '../normalizers/size.js';

/** Packaging/container words that are not product identity tokens. */
const PACKAGING_WORDS = new Set(['pack', 'box', 'bag', 'container', 'bottle', 'can', 'jar', 'tin', 'set', 'kit', 'bundle']);

/**
 * Token overlap: ≥40% of canonical name identity words (>2 chars, non-packaging) must appear
 * in extracted productName.
 * Packaging words (Pack/Box/Bag/etc.) are stripped before comparison so "Eggs Fresh 12 Pack"
 * matches "Eggs x 15" on the "eggs" token alone.
 * Catches gross mismatches because category tokens like "tomatoes" differ from "tomato"
 * (stemming gap blocks seed/storage box false positives).
 */
/** Strip common English plural suffixes for basic stemming. */
function stem(w: string): string {
  return w.replace(/ies$/, 'y').replace(/es$/, '').replace(/s$/, '');
}

/** Non-food product indicator words — reject before token matching. */
const NON_FOOD_INDICATORS = new Set(['seeds', 'seed', 'seedling', 'seedlings', 'planting', 'fertilizer', 'fertiliser']);

export function isTitlePlausible(canonicalName: string, productName: string | undefined): boolean {
  if (!productName) return false;
  const titleWords = productName.toLowerCase().split(/\W+/);
  if (titleWords.some((w) => NON_FOOD_INDICATORS.has(w))) return false;
  const tokens = canonicalName
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !PACKAGING_WORDS.has(w));
  if (tokens.length === 0) return true;
  const extracted = productName.toLowerCase();
  const matches = tokens.filter((w) => {
    if (extracted.includes(w)) return true;
    const s = stem(w);
    return s.length >= 4 && s !== w && extracted.includes(s);
  });
  return matches.length >= Math.max(1, Math.ceil(tokens.length * 0.4));
}

/**
 * Build a size constraint hint from the canonical name for use in the Firecrawl prompt.
 * Returns a human-readable string like "1 gallon (approx. 3785ml)" or null if no size found.
 */
export function extractSizeHint(canonicalName: string): string | null {
  const parsed = parseSize(canonicalName);
  if (!parsed) return null;
  const { packCount, sizeValue, sizeUnit, baseQuantity, baseUnit } = parsed;
  if (packCount > 1) {
    return `${packCount} × ${sizeValue}${sizeUnit} (approx. ${Math.round(baseQuantity)}${baseUnit} total)`;
  }
  return `${sizeValue}${sizeUnit} (approx. ${Math.round(baseQuantity)}${baseUnit})`;
}

/**
 * Safe host boundary check. Prevents evilluluhypermarket.com from passing
 * when allowedHost is luluhypermarket.com.
 */
export function isAllowedHost(url: string, allowedHost: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && hostname === allowedHost;
  } catch {
    return false;
  }
}

interface ExtractedProduct {
  productName?: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
  sizeText?: string;
}

interface SearchPayload {
  extracted: ExtractedProduct;
  productUrl: string;
  canonicalName: string;
  basketSlug: string;
  itemCategory: string;
  direct?: boolean;
  pinnedProductId?: string;
  matchId?: string;
}

export class SearchAdapter implements RetailerAdapter {
  readonly key = 'search';

  constructor(
    private readonly exa: ExaProvider,
    private readonly firecrawl: FirecrawlProvider,
  ) {}

  async validateConfig(config: RetailerConfig): Promise<string[]> {
    const errors: string[] = [];
    if (!config.baseUrl) errors.push('baseUrl is required');
    return errors;
  }

  async discoverTargets(ctx: AdapterContext): Promise<Target[]> {
    const baskets = loadAllBasketConfigs().filter((b) => b.marketCode === ctx.config.marketCode);
    const domain = new URL(ctx.config.baseUrl).hostname;
    const targets: Target[] = [];

    for (const basket of baskets) {
      for (const item of basket.items) {
        const pinKey = `${basket.slug}:${item.canonicalName}`;
        const pinned = ctx.pinnedUrls?.get(pinKey);

        if (pinned && isAllowedHost(pinned.sourceUrl, domain)) {
          targets.push({
            id: item.id,
            url: pinned.sourceUrl,
            category: item.category,
            metadata: {
              canonicalName: item.canonicalName,
              domain,
              basketSlug: basket.slug,
              currency: ctx.config.currencyCode,
              direct: true,
              pinnedProductId: pinned.productId,
              matchId: pinned.matchId,
            },
          });
        } else {
          if (pinned) {
            ctx.logger.warn(`  [pin] rejected stored URL for "${item.canonicalName}" (host mismatch): ${pinned.sourceUrl}`);
          }
          targets.push({
            id: item.id,
            url: ctx.config.baseUrl,
            category: item.category,
            metadata: {
              canonicalName: item.canonicalName,
              domain,
              basketSlug: basket.slug,
              currency: ctx.config.currencyCode,
              direct: false,
            },
          });
        }
      }
    }

    return targets;
  }

  private async _extractFromUrl(
    ctx: AdapterContext,
    url: string,
    canonicalName: string,
    currency: string,
  ): Promise<ExtractedProduct | null> {
    const sizeHint = extractSizeHint(canonicalName);
    const sizeClause = sizeHint
      ? ` You are looking for "${canonicalName}". The product MUST be ${sizeHint}. If the page shows a different size, pack count, or bulk case, return null for price.`
      : ` You are looking for "${canonicalName}".`;

    const extractSchema = {
      prompt: `Extract the retail price of THIS specific product from the main product section of the page.${sizeClause} The price may be displayed as two parts split across lines — like "3" and ".95" next to "${currency}" — combine them to get 3.95. ONLY extract the price shown for the main product itself. If the page shows "Out of Stock" and no price is displayed for the main product, return null for price — do NOT use prices from related products, recommendations, or carousels. Return the product name, the numeric price in ${currency} (null if not shown), the currency code, whether it is in stock, and the size or quantity shown on the page.`,
      fields: {
        productName: { type: 'string' as const, description: 'Name or title of the product' },
        price: { type: 'number' as const, description: `Retail price in ${currency} as a single number (e.g. 4.69)` },
        currency: { type: 'string' as const, description: `Currency code, should be ${currency}` },
        inStock: { type: 'boolean' as const, description: 'Whether the product is currently in stock and purchasable' },
        sizeText: { type: 'string' as const, description: 'Size or quantity shown on the page (e.g. "32 oz", "1 gallon", "24 pack")' },
      },
    };

    const result = await this.firecrawl.extract<ExtractedProduct>(url, extractSchema, { timeout: 30_000 });
    const data = result.data;
    const price = data?.price;

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    if (!isTitlePlausible(canonicalName, data.productName)) {
      return null;
    }

    // inStockFromPrice: some retailers (e.g. BigBasket) gate on delivery pincode, not product
    // availability. Firecrawl misreads the gate as out-of-stock. If price > 0, treat as in-stock.
    if (ctx.config.searchConfig?.inStockFromPrice && price > 0) {
      ctx.logger.info(`  [search:extract] ${canonicalName}: inStockFromPrice override (price=${price})`);
      data.inStock = true;
    }

    return data;
  }

  async fetchTarget(ctx: AdapterContext, target: Target): Promise<FetchResult> {
    const { canonicalName, domain, currency, basketSlug, direct, pinnedProductId, matchId } = target.metadata as {
      canonicalName: string;
      domain: string;
      currency: string;
      basketSlug: string;
      direct: boolean;
      pinnedProductId?: string;
      matchId?: string;
    };

    // Direct path: skip Exa, call Firecrawl on pinned URL
    if (direct) {
      try {
        const extracted = await this._extractFromUrl(ctx, target.url, canonicalName, currency);
        if (extracted) {
          ctx.logger.info(
            `  [search:pin] ${canonicalName}: price=${extracted.price} ${extracted.currency} from ${target.url}`,
          );
          return {
            url: target.url,
            html: JSON.stringify({
              extracted,
              productUrl: target.url,
              canonicalName,
              basketSlug,
              itemCategory: target.category,
              direct: true,
              pinnedProductId,
              matchId,
            } satisfies SearchPayload),
            statusCode: 200,
            fetchedAt: new Date(),
          };
        }
        ctx.logger.warn(`  [search:pin] ${canonicalName}: pin extraction failed, falling back to Exa`);
      } catch (err) {
        ctx.logger.warn(`  [search:pin] ${canonicalName}: pin fetch error, falling back to Exa: ${err}`);
      }
    }

    const marketName = MARKET_NAMES[ctx.config.marketCode] ?? ctx.config.marketCode.toUpperCase();
    const cfg = ctx.config.searchConfig;

    const searchQuery = cfg?.queryTemplate
      ? cfg.queryTemplate
          .replace('{canonicalName}', canonicalName)
          .replace('{category}', target.category)
          .replace('{currency}', currency)
          .replace('{market}', marketName)
          .trim()
      : `${canonicalName} grocery ${marketName} ${currency}`.trim();

    // Stage 1: Exa URL discovery
    const exaResults = await this.exa.search(searchQuery, {
      numResults: cfg?.numResults ?? 3,
      includeDomains: [domain],
    });

    if (exaResults.length === 0) {
      throw new Error(`Exa: no pages found for "${canonicalName}" on ${domain}`);
    }

    const pathFilter = cfg?.urlPathContains;
    const safeUrls = exaResults
      .map((r) => r.url)
      .filter((url) => !!url && isAllowedHost(url, domain) && (!pathFilter || url.includes(pathFilter)));

    ctx.logger.info(
      `  [search:discovery] ${canonicalName}: ${exaResults.length} URLs from Exa, ${safeUrls.length} passed domain check`,
    );

    if (safeUrls.length === 0) {
      throw new Error(`Exa: all ${exaResults.length} results failed domain check (expected hostname: ${domain}${pathFilter ? `, path: *${pathFilter}*` : ''})`);
    }

    // Stage 2: Firecrawl structured extraction — iterate safe URLs until one yields a valid price
    let extracted: ExtractedProduct | null = null;
    let usedUrl = safeUrls[0];
    const lastErrors: string[] = [];

    for (const url of safeUrls) {
      try {
        const result = await this._extractFromUrl(ctx, url, canonicalName, currency);
        if (result) {
          extracted = result;
          usedUrl = url;
          break;
        }
        ctx.logger.warn(`  [search:extract] ${canonicalName}: no price or title mismatch at ${url}, trying next`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`  [search:extract] ${canonicalName}: Firecrawl error on ${url}: ${msg}`);
        lastErrors.push(msg);
      }
    }

    if (extracted === null) {
      throw new Error(
        `All ${safeUrls.length} URLs failed extraction for "${canonicalName}".${lastErrors.length ? ` Last: ${lastErrors.at(-1)}` : ''}`,
      );
    }

    ctx.logger.info(
      `  [search:extract] ${canonicalName}: price=${extracted.price} ${extracted.currency} from ${usedUrl}`,
    );

    return {
      url: usedUrl,
      html: JSON.stringify({
        extracted,
        productUrl: usedUrl,
        canonicalName,
        basketSlug,
        itemCategory: target.category,
        direct: false,
      } satisfies SearchPayload),
      statusCode: 200,
      fetchedAt: new Date(),
    };
  }

  async parseListing(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct[]> {
    const { extracted, productUrl, canonicalName, basketSlug, itemCategory, direct, pinnedProductId, matchId } =
      JSON.parse(result.html) as SearchPayload;

    const priceResult = z.number().positive().finite().safeParse(extracted?.price);
    if (!priceResult.success) {
      ctx.logger.warn(`  [search] ${canonicalName}: invalid price "${extracted?.price}" from ${productUrl}`);
      return [];
    }

    if (extracted.currency && extracted.currency.toUpperCase() !== ctx.config.currencyCode) {
      ctx.logger.warn(
        `  [search] ${canonicalName}: currency mismatch ${extracted.currency} ≠ ${ctx.config.currencyCode} at ${productUrl}`,
      );
      return [];
    }

    // Require Firecrawl to return a real product name — using canonical name as rawTitle
    // silently poisons the DB with unverifiable matches (e.g. extraction failures, wrong pages).
    if (!extracted.productName) {
      ctx.logger.warn(`  [search] ${canonicalName}: no productName from Firecrawl, rejecting ${productUrl}`);
      return [];
    }

    return [
      {
        sourceUrl: productUrl,
        rawTitle: extracted.productName,
        rawBrand: null,
        rawSizeText: extracted.sizeText ?? null,
        imageUrl: null,
        categoryText: itemCategory,
        retailerSku: null,
        price: priceResult.data,
        listPrice: null,
        promoPrice: null,
        promoText: null,
        // inStock defaults to true when Firecrawl does not return the field.
        // This is a conservative assumption — monitor for out-of-stock false positives.
        inStock: extracted.inStock ?? true,
        rawPayload: { extracted, basketSlug, itemCategory, canonicalName, direct, pinnedProductId, matchId },
      },
    ];
  }

  async parseProduct(_ctx: AdapterContext, _result: FetchResult): Promise<ParsedProduct> {
    throw new Error('SearchAdapter does not support single-product parsing');
  }
}
