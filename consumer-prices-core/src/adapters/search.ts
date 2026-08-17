/**
 * SearchAdapter — two-stage grocery price pipeline.
 *
 * Stage 1 (Exa): neural search on retailer domain → ranked product page URLs
 * Stage 2 (Firecrawl, with an opt-in bounded Exa fallback): structured LLM extraction
 * from the confirmed URL → {price, currency, inStock}
 *
 * Pin path: if a matching pin exists in ctx.pinnedUrls, discovery is skipped and the
 * configured extraction providers are called directly on the stored URL. On failure,
 * the adapter falls back to the normal Exa discovery flow in the same run so the basket
 * item is never left uncovered.
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
import { validateSearchHit, type ValidatorResult } from './validator.js';
import { priceEvidenceOnPage, type PriceEvidence } from './price-evidence.js';
import { ProviderCooldownGate } from './provider-cooldown.js';
import type { BasketItem } from '../config/types.js';
import type { AcquisitionProviderName, SearchOptions, SearchResult } from '../acquisition/types.js';

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

/** Merge the base host with configured aliases into a deduped, lowercased allowlist. */
export function normalizeAllowedHosts(baseHost: string | readonly string[], aliases: readonly string[] = []): string[] {
  const hosts = typeof baseHost === 'string' ? [baseHost, ...aliases] : [...baseHost, ...aliases];
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Safe host boundary check. Prevents evilluluhypermarket.com from passing
 * when allowedHost is luluhypermarket.com.
 */
export function isAllowedHost(url: string, allowedHost: string | readonly string[]): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    const allowedHosts = normalizeAllowedHosts(allowedHost);
    return (protocol === 'http:' || protocol === 'https:') && allowedHosts.includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Firecrawl occasionally returns a product quantity as the retail price when
 * a dynamic page exposes the size but not the currency-denominated price.
 * Reject only the unambiguous weighted-unit echo; count-based products and
 * ordinary prices remain untouched.
 */
export function looksLikeQuantityAsPrice(
  price: number,
  sizeText: string | undefined,
  item: Pick<BasketItem, 'baseUnit'>,
  fallbackSizeText?: string,
): boolean {
  if (item.baseUnit === 'ct' || !Number.isFinite(price) || price < 20) return false;
  // Fall back to the canonical size whenever the provider's sizeText does not
  // PARSE, not merely when it is absent: `??` would accept `''` or `'400 gm'`
  // (UNIT_MAP has no `gm`/`pack`) as a present size and silently skip the check.
  const parsed = parseSize(sizeText) ?? parseSize(fallbackSizeText);
  if (!parsed || parsed.baseUnit !== item.baseUnit || parsed.baseQuantity < 100) return false;
  return Math.abs(price - parsed.baseQuantity) < 0.005;
}

/**
 * Normalize urlPathContains config (string | string[] | undefined) into an
 * array. Empty array means "no path constraint" (any path passes).
 */
export function normalizePathFilters(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter((s) => s.length > 0) : [value];
}

/**
 * URL passes the path filter if filters list is empty OR any listed substring
 * appears in the URL. Multi-pattern support is required for retailers like
 * Carrefour BR that mix legacy `/produto/<slug>` URLs with VTEX `<slug>/p`
 * URLs — a single substring can't match both.
 */
export function matchesAnyPathFilter(url: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((p) => url.includes(p));
}

/**
 * AND-ed market scope, layered on top of `matchesAnyPathFilter`'s OR.
 *
 * A multi-market host serves several storefronts from one hostname — noon.com
 * fronts /saudi-en/, /uae-en/ and Egypt on both www.noon.com and
 * minutes.noon.com — so the host allowlist cannot separate them, and
 * `urlPathContains` cannot either: it is an OR, and on www.noon.com the locale
 * is the first path segment while the product route (`/p/`) is the last, so no
 * single substring spans both. Every listed segment must appear, and matching
 * is on `pathname` only so a locale echoed in a query string cannot satisfy it.
 * An unparseable URL fails closed.
 */
export function matchesRequiredPathSegments(url: string, segments: string[]): boolean {
  if (segments.length === 0) return true;
  try {
    const { pathname } = new URL(url);
    return segments.every((segment) => pathname.includes(segment));
  } catch {
    return false;
  }
}

/** Build the exact Exa discovery request shared by production and diagnostics. */
export function buildExaDiscoveryRequest(input: {
  searchConfig: RetailerConfig['searchConfig'];
  canonicalName: string;
  category: string;
  currency: string;
  marketName: string;
  includeDomains: string[];
}): { query: string; options: SearchOptions } {
  const { searchConfig, canonicalName, category, currency, marketName, includeDomains } = input;
  const query = searchConfig?.queryTemplate
    ? searchConfig.queryTemplate
        .replace('{canonicalName}', canonicalName)
        .replace('{category}', category)
        .replace('{currency}', currency)
        .replace('{market}', marketName)
        .trim()
    : `${canonicalName} grocery ${marketName} ${currency}`.trim();

  return {
    query,
    options: {
      numResults: searchConfig?.numResults ?? 3,
      includeDomains,
      // Omitted unless configured so retailers on the provider default are
      // untouched; ExaProvider.search falls back to neural on undefined.
      ...(searchConfig?.searchType ? { type: searchConfig.searchType } : {}),
      timeout: 30_000,
    },
  };
}

interface ExtractedProduct {
  productName?: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
  sizeText?: string;
}

export type ExtractionProviderName = Extract<AcquisitionProviderName, 'firecrawl' | 'exa'>;

export type ExtractionFailureReason =
  | 'provider-error'
  | 'provider-cooldown'
  | 'missing-price'
  | 'price-evidence-missing'
  | 'title-mismatch'
  | 'validator-rejected'
  | 'quantity-as-price'
  | 'currency-mismatch';

export interface ExtractionFailure {
  provider: ExtractionProviderName;
  reason: ExtractionFailureReason;
  detail?: string;
}

interface ExtractionSuccess {
  extracted: ExtractedProduct;
  validator: ValidatorResult;
  provider: ExtractionProviderName;
  /** Outcome of the on-page price verification for the accepted extraction.
   * 'no-content' means the gate could NOT run (provider returned no rendered
   * content) — persisted so an audit can tell a proven price from an
   * unproven one; a fleet-wide drift to 'no-content' is the gate silently
   * dying (#6182 review). */
  priceEvidence: PriceEvidence;
}

interface ExtractionAttempt {
  result: ExtractionSuccess | null;
  failures: ExtractionFailure[];
}

type ItemConstraints = Pick<BasketItem, 'baseUnit' | 'minBaseQty' | 'maxBaseQty' | 'negativeTokens' | 'substitutionGroup'>;

interface SearchPayload {
  extracted: ExtractedProduct;
  productUrl: string;
  canonicalName: string;
  basketSlug: string;
  itemCategory: string;
  itemConstraints?: ItemConstraints;
  validator?: ValidatorResult;
  extractionProvider?: ExtractionProviderName;
  priceEvidence?: PriceEvidence;
  direct?: boolean;
  pinnedProductId?: string;
  matchId?: string;
}

const REJECTION_FAILURES = new Set<ExtractionFailureReason>([
  'validator-rejected',
  'quantity-as-price',
  'currency-mismatch',
  'title-mismatch',
  'price-evidence-missing',
]);

export class SearchTargetError extends Error {
  constructor(
    message: string,
    readonly rejectedCount: number,
    readonly failures: readonly ExtractionFailure[] = [],
  ) {
    super(message);
    this.name = 'SearchTargetError';
  }
}

function formatExtractionFailures(failures: readonly ExtractionFailure[]): string {
  if (failures.length === 0) return 'unknown';
  return failures
    .map(({ provider, reason, detail }) => `${provider}:${reason}${detail ? `(${detail})` : ''}`)
    .join(',');
}

export class SearchAdapter implements RetailerAdapter {
  readonly key = 'search';

  // A provider outage should not multiply into one failed call per candidate
  // URL for the rest of a retailer's scrape. Two consecutive transport errors
  // open a per-scrape cooldown. The gate is HALF-OPEN (#6182): it skips a
  // bounded window of attempts and then lets one probe through, so a
  // transient blip costs a few pages instead of the whole retailer (Tesco GB
  // 2026-08-08: two Firecrawl 500s wiped 11/12 pages under the always-open
  // version of this cooldown).
  private firecrawlGate = new ProviderCooldownGate();
  private exaExtractionGate = new ProviderCooldownGate();
  private exaDiscoveryGate = new ProviderCooldownGate();

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
    this.firecrawlGate = new ProviderCooldownGate();
    this.exaExtractionGate = new ProviderCooldownGate();
    this.exaDiscoveryGate = new ProviderCooldownGate();

    const baskets = loadAllBasketConfigs().filter((b) => b.marketCode === ctx.config.marketCode);
    const domain = new URL(ctx.config.baseUrl).hostname;
    const allowedHosts = normalizeAllowedHosts(domain, ctx.config.searchConfig?.allowedHosts);
    // Pins outlive config changes, so a pin stored while a looser policy was
    // live would keep being scraped directly and bypass discovery entirely.
    // The market scope has to apply here too, not just to discovered URLs.
    const requiredSegments = ctx.config.searchConfig?.urlPathMustContain ?? [];
    const targets: Target[] = [];

    for (const basket of baskets) {
      for (const item of basket.items) {
        const pinKey = `${basket.slug}:${item.canonicalName}`;
        const pinned = ctx.pinnedUrls?.get(pinKey);
        const itemConstraints: ItemConstraints = {
          baseUnit: item.baseUnit,
          minBaseQty: item.minBaseQty,
          maxBaseQty: item.maxBaseQty,
          negativeTokens: item.negativeTokens,
          substitutionGroup: item.substitutionGroup,
        };

        if (
          pinned &&
          isAllowedHost(pinned.sourceUrl, allowedHosts) &&
          matchesRequiredPathSegments(pinned.sourceUrl, requiredSegments)
        ) {
          targets.push({
            id: item.id,
            url: pinned.sourceUrl,
            category: item.category,
            metadata: {
              canonicalName: item.canonicalName,
              domain,
              basketSlug: basket.slug,
              currency: ctx.config.currencyCode,
              itemConstraints,
              direct: true,
              pinnedProductId: pinned.productId,
              matchId: pinned.matchId,
            },
          });
        } else {
          if (pinned) {
            const pinReason = isAllowedHost(pinned.sourceUrl, allowedHosts) ? 'market scope' : 'host mismatch';
            ctx.logger.warn(
              `  [pin] rejected stored URL for "${item.canonicalName}" (${pinReason}): ${pinned.sourceUrl}`,
            );
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
              itemConstraints,
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
    itemConstraints?: ItemConstraints,
  ): Promise<ExtractionAttempt> {
    const sizeHint = extractSizeHint(canonicalName);
    const sizeClause = sizeHint
      ? ` You are looking for "${canonicalName}". The product MUST be ${sizeHint}. If the page shows a different size, pack count, or bulk case, return null for price.`
      : ` You are looking for "${canonicalName}".`;

    const extractSchema = {
      // No numeric example here, deliberately. A worked example ("combine them
      // to get 3.95") is an anchor the extractor emits VERBATIM when the page
      // has no price: varying only the example on a priceless page returned
      // 3.95, then 7.31, then 12.48, each with the canonical name echoed back
      // as the product name — a fabricated observation that clears the price,
      // currency, title and strict-validator gates alike. Describe the split
      // layout in words instead.
      prompt: `Extract the retail price of THIS specific product from the main product section of the page.${sizeClause} The price may be rendered split across separate elements, with the whole-currency part and the fractional part in different nodes; join them into one number. Never invent, estimate, or complete a price: read every digit off the page, and if no price for the main product itself is printed anywhere on the page return null for price. If a price IS printed for the main product, return it even when the product is out of stock, unavailable, or the page asks for a delivery location first — a printed price next to an "Out of Stock" notice is still the price; report availability through inStock instead of nulling the price. ONLY use the price of the main product itself — never prices from related products, recommendations, or carousels. If the page is an error, "not found", or empty-state page, return null for price. Return the product name EXACTLY as printed on the page (never restate the product you were asked to find), the numeric price in ${currency} (null if not shown), the currency code, whether it is in stock, and the size or quantity shown on the page.`,
      // Field descriptions are model-visible too: Exa appends them to the
      // summary query and Firecrawl sends them in the extraction schema. Keep
      // every description free of worked numeric examples for the same reason.
      fields: {
        productName: { type: 'string' as const, required: true, description: 'Name or title of the product' },
        price: {
          type: 'number' as const,
          required: true,
          nullable: true,
          description: `Retail price in ${currency}, expressed as one numeric value`,
        },
        currency: { type: 'string' as const, required: true, description: `Currency code, should be ${currency}` },
        inStock: {
          type: 'boolean' as const,
          // Required (#6182 review): the softened prompt now admits printed
          // prices on out-of-stock pages, and parseListing defaults a MISSING
          // inStock to true — so an extractor that omits availability would
          // record an OOS product as purchasable. Requiring the field makes
          // the extractor state it explicitly; the downstream default remains
          // as a last-resort for off-contract responses.
          required: true,
          description: 'Whether the product is currently in stock and purchasable',
        },
        sizeText: {
          type: 'string' as const,
          required: false,
          description: 'Size or quantity exactly as shown on the page',
        },
      },
    };

    const failures: ExtractionFailure[] = [];
    const providers: ExtractionProviderName[] = ['firecrawl'];
    if (ctx.config.searchConfig?.extractionFallback === 'exa') providers.push('exa');
    const strictMode = ctx.config.searchConfig?.requireStrictValidator === true;
    const validationConstraints: ItemConstraints = itemConstraints ?? { baseUnit: '' };

    for (const provider of providers) {
      const gate = provider === 'firecrawl' ? this.firecrawlGate : this.exaExtractionGate;
      if (gate.consumeSkip()) {
        failures.push({ provider, reason: 'provider-cooldown' });
        continue;
      }

      let data: ExtractedProduct;
      let pageContent: string | undefined;
      try {
        // renderWaitMs: late-hydrating storefronts (Carrefour MAF) capture as
        // a breadcrumb shell without a settle delay — Firecrawl only; the Exa
        // fallback reads Exa's own crawl and has no render to wait on.
        const result =
          provider === 'firecrawl'
            ? await this.firecrawl.extract<ExtractedProduct>(url, extractSchema, {
                timeout: 30_000,
                ...(ctx.config.searchConfig?.renderWaitMs ? { waitFor: ctx.config.searchConfig.renderWaitMs } : {}),
              })
            : await this.exa.extract<ExtractedProduct>(url, extractSchema, { timeout: 30_000 });
        data = result.data ?? {};
        pageContent = result.pageContent;
        // The open->closed transition deserves the same log visibility as the
        // opening warn: without it, "did the provider recover" is only
        // answerable by the absence of further warnings (#6182 review).
        if (gate.recordSuccess()) {
          ctx.logger.info(
            `  [search:provider-cooldown] ${ctx.config.slug}: ${provider === 'firecrawl' ? 'Firecrawl' : 'Exa'} extraction recovered — cooldown closed after a successful probe`,
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push({ provider, reason: 'provider-error', detail });
        if (gate.recordFailure()) {
          ctx.logger.warn(
            `  [search:provider-cooldown] ${ctx.config.slug}: ${provider === 'firecrawl' ? 'Firecrawl' : 'Exa'} extraction cooling down after consecutive errors — skipping a bounded window, then probing (last: ${detail})`,
          );
        }
        continue;
      }

      const price = data.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        failures.push({ provider, reason: 'missing-price' });
        continue;
      }

      // Anti-fabrication proof (#6182): an accepted price must be visible in
      // the rendered content the SAME provider call returned. This is what
      // makes the softer printed-price-wins prompt safe — a fabricated value
      // (the #6270 class) has no digits on the page and dies here regardless
      // of prompt wording. 'no-content' (provider returned no render) keeps
      // the historical accept-on-extract behavior rather than failing closed —
      // but it must never be SILENT: the abstention is logged per candidate
      // and stamped into the payload, because a fleet-wide drift to
      // 'no-content' (a provider quietly dropping rendered content from its
      // response) is this gate dying while every run still looks verified.
      const priceEvidence = priceEvidenceOnPage(price, pageContent);
      if (priceEvidence === 'unverified') {
        failures.push({ provider, reason: 'price-evidence-missing', detail: `${price} not found in page content` });
        // Escalates: the other provider renders the page independently and can
        // both re-read and re-evidence the price.
        continue;
      }
      if (priceEvidence === 'no-content') {
        ctx.logger.warn(
          `  [search:price-evidence] ${ctx.config.slug}/${canonicalName}: no page content from ${provider} — evidence gate skipped`,
        );
      }

      const extractedCurrency = data.currency?.trim();

      // The schema marks `currency` required and non-nullable, so an omission is
      // an off-contract response, not a normal one. Under strict mode that is a
      // rejection rather than a pass — for a multi-market host the currency is
      // the last market discriminator behind `urlPathMustContain`, and a silent
      // skip here stamps the retailer's configured currency on a foreign price.
      // The other provider may still report it, so this escalates.
      if (strictMode && !extractedCurrency) {
        failures.push({ provider, reason: 'currency-mismatch', detail: 'missing-currency' });
        continue;
      }

      if (extractedCurrency && extractedCurrency.toUpperCase() !== currency.toUpperCase()) {
        failures.push({ provider, reason: 'currency-mismatch', detail: `${extractedCurrency}≠${currency}` });
        // The PAGE is priced in another currency; a second extractor reading the
        // same page cannot change that, so stop escalating and try the next URL.
        break;
      }

      if (!isTitlePlausible(canonicalName, data.productName)) {
        failures.push({ provider, reason: 'title-mismatch', detail: data.productName ?? 'missing productName' });
        // Escalates: an extractor can misread the title (grabbing a carousel or
        // recommendation heading) on the correct product page.
        continue;
      }

      if (strictMode && !itemConstraints) {
        failures.push({ provider, reason: 'validator-rejected', detail: 'missing-item-constraints' });
        // A config/plumbing gap, not an extraction problem — retrying is pointless.
        break;
      }

      if (strictMode && looksLikeQuantityAsPrice(price, data.sizeText, validationConstraints, canonicalName)) {
        failures.push({ provider, reason: 'quantity-as-price', detail: `${price} for ${data.sizeText}` });
        continue;
      }

      if (
        strictMode &&
        itemConstraints &&
        (itemConstraints.minBaseQty != null || itemConstraints.maxBaseQty != null) &&
        !data.sizeText?.trim() &&
        !parseSize(canonicalName)
      ) {
        failures.push({ provider, reason: 'validator-rejected', detail: 'missing-size' });
        continue;
      }

      const validator = validateSearchHit({
        canonicalName,
        productName: data.productName,
        sizeText: data.sizeText,
        item: validationConstraints,
      });

      if (strictMode && !validator.ok) {
        failures.push({ provider, reason: 'validator-rejected', detail: validator.reasons.join(',') || 'unknown' });
        // The validator judged the PAGE's product/size wrong. Both extractors
        // read the same page, so escalating just doubles the paid call.
        break;
      }

      // Shadow-mode: the strict validator runs alongside the legacy boolean gate
      // but does NOT block a hit on its own for unaffected retailers. Priority
      // recovery retailers opt into the hard gate above.
      if (!validator.ok) {
        ctx.logger.warn(
          `  [search:shadow-reject] "${canonicalName}" would reject productName="${data.productName}" reasons=${validator.reasons.join(',')} score=${validator.score.toFixed(2)}`,
        );
      }

      // inStockFromPrice: some retailers (e.g. BigBasket) gate on delivery pincode, not product
      // availability. Firecrawl misreads the gate as out-of-stock. If price > 0, treat as in-stock.
      if (ctx.config.searchConfig?.inStockFromPrice && price > 0) {
        ctx.logger.info(`  [search:extract] ${ctx.config.slug}/${canonicalName}: inStockFromPrice override (price=${price})`);
        data.inStock = true;
      }

      return { result: { extracted: data, validator, provider, priceEvidence }, failures };
    }

    return { result: null, failures };
  }

  async fetchTarget(ctx: AdapterContext, target: Target): Promise<FetchResult> {
    const { canonicalName, domain, currency, basketSlug, itemConstraints, direct, pinnedProductId, matchId } = target.metadata as {
      canonicalName: string;
      domain: string;
      currency: string;
      basketSlug: string;
      itemConstraints?: ItemConstraints;
      direct: boolean;
      pinnedProductId?: string;
      matchId?: string;
    };
    const hostAllowlist = normalizeAllowedHosts(domain, ctx.config.searchConfig?.allowedHosts);
    const failures: ExtractionFailure[] = [];

    // Direct path: skip Exa discovery, call the configured extractor on the pinned URL.
    if (direct) {
      try {
        const attempt = await this._extractFromUrl(ctx, target.url, canonicalName, currency, itemConstraints);
        failures.push(...attempt.failures);
        if (attempt.result) {
          const result = attempt.result;
          ctx.logger.info(
            `  [search:pin] ${ctx.config.slug}/${canonicalName}: price=${result.extracted.price} ${result.extracted.currency} provider=${result.provider} from ${target.url}`,
          );
          return {
            url: target.url,
            html: JSON.stringify({
              extracted: result.extracted,
              productUrl: target.url,
              canonicalName,
              basketSlug,
              itemCategory: target.category,
              itemConstraints,
              validator: result.validator,
              extractionProvider: result.provider,
              priceEvidence: result.priceEvidence,
              direct: true,
              pinnedProductId,
              matchId,
            } satisfies SearchPayload),
            statusCode: 200,
            fetchedAt: new Date(),
          };
        }
        ctx.logger.warn(
          `  [search:pin] ${ctx.config.slug}/${canonicalName}: pin extraction failed (${formatExtractionFailures(attempt.failures)}), falling back to Exa`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push({ provider: 'firecrawl', reason: 'provider-error', detail });
        ctx.logger.warn(`  [search:pin] ${ctx.config.slug}/${canonicalName}: pin fetch error, falling back to Exa: ${err}`);
      }
    }

    // Half-open (#6182): while the skip window lasts, the target fails fast on
    // provider-cooldown; the attempt after the window proceeds as the recovery
    // probe (the probe call itself happens inside _extractFromUrl).
    if (ctx.config.searchConfig?.extractionFallback !== 'exa' && this.firecrawlGate.consumeSkip()) {
      throw new SearchTargetError(
        `Firecrawl extraction cooldown is open for "${canonicalName}"`,
        0,
        [{ provider: 'firecrawl', reason: 'provider-cooldown' }],
      );
    }

    // Only the DISCOVERY cooldown can abort the target: Exa is the sole URL
    // discovery provider, so without it there is nothing to extract from. An
    // Exa *extraction* cooldown must not abort — Firecrawl is the primary
    // extractor and is frequently healthy at that moment (its own streak resets
    // on every success), and `_extractFromUrl` already skips the cooled-down
    // provider per candidate. Aborting here would turn a fallback outage into
    // a whole-basket loss, which is the COVERAGE_PARTIAL this adapter exists
    // to prevent.
    if (this.exaDiscoveryGate.consumeSkip()) {
      throw new SearchTargetError(
        `Exa discovery cooldown is open for "${canonicalName}"`,
        0,
        [{ provider: 'exa', reason: 'provider-cooldown' }],
      );
    }

    const marketName = MARKET_NAMES[ctx.config.marketCode] ?? ctx.config.marketCode.toUpperCase();
    const cfg = ctx.config.searchConfig;
    const discoveryRequest = buildExaDiscoveryRequest({
      searchConfig: cfg,
      canonicalName,
      category: target.category,
      currency,
      marketName,
      includeDomains: hostAllowlist,
    });

    // Stage 1: Exa URL discovery
    let exaResults: SearchResult[];
    try {
      exaResults = await this.exa.search(discoveryRequest.query, discoveryRequest.options);
      if (this.exaDiscoveryGate.recordSuccess()) {
        ctx.logger.info(
          `  [search:provider-cooldown] ${ctx.config.slug}: Exa discovery recovered — cooldown closed after a successful probe`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (this.exaDiscoveryGate.recordFailure()) {
        ctx.logger.warn(
          `  [search:provider-cooldown] ${ctx.config.slug}: Exa discovery cooling down after consecutive errors — skipping a bounded window, then probing (last: ${detail})`,
        );
      }
      // Carry `detail` into the message: nothing downstream reads `.failures`,
      // so without it the log cannot tell an auth failure from a rate limit
      // from a timeout — the distinction the cooldown exists to surface.
      throw new SearchTargetError(`Exa search failed for "${canonicalName}": ${detail}`, 0, [
        { provider: 'exa', reason: 'provider-error', detail },
      ]);
    }

    const pathFilters = normalizePathFilters(cfg?.urlPathContains);
    const requiredSegments = cfg?.urlPathMustContain ?? [];
    const attemptedUrls = direct ? new Set([target.url]) : new Set<string>();
    const filterInPolicy = (results: SearchResult[]) =>
      results
        .map((r) => r.url)
        .filter(
          (url) =>
            !!url &&
            isAllowedHost(url, hostAllowlist) &&
            matchesAnyPathFilter(url, pathFilters) &&
            matchesRequiredPathSegments(url, requiredSegments),
        );
    let discoveredUrls = filterInPolicy(exaResults);
    let survivingUrls = [...new Set(discoveredUrls)].filter((url) => !attemptedUrls.has(url));

    // One bounded re-draw when a search round yields NOTHING extractable
    // (#6182). Exa's ranking for a domain+query is not stable run to run —
    // Pão de Açúcar's 2026-08-08 02:00 scrape drew store-flyer PDFs and
    // marketing pages for 7 of 11 items (0 in-policy URLs each) while the
    // identical query minutes later drew 4-5/5 live /produto/ pages. An EMPTY
    // first draw earns the same single retry as an out-of-policy one — a
    // transient zero is no more permanent than a transient bad ranking. A
    // single wider retry converts either into a normal page; a genuinely
    // empty index still fails after exactly one extra search call. The width
    // is clamped so a config with a large numResults cannot double into an
    // unbounded (and unusable — extraction is candidate-capped anyway) draw.
    if (survivingUrls.length === 0) {
      const retryOptions = {
        ...discoveryRequest.options,
        numResults: Math.min(Math.max((discoveryRequest.options.numResults ?? 3) * 2, 8), 20),
      };
      try {
        const retryResults = await this.exa.search(discoveryRequest.query, retryOptions);
        ctx.logger.info(
          `  [search:discovery-retry] ${ctx.config.slug}/${canonicalName}: ${exaResults.length === 0 ? 'empty first draw' : '0 in-policy URLs on first draw'}, retried wider (numResults=${retryOptions.numResults}) -> ${retryResults.length} results`,
        );
        exaResults = [...exaResults, ...retryResults];
        discoveredUrls = filterInPolicy(exaResults);
        survivingUrls = [...new Set(discoveredUrls)].filter((url) => !attemptedUrls.has(url));
      } catch (retryErr) {
        // The retry is best-effort on top of an already-answered search: a
        // failure here falls through to the normal zero-candidate error and
        // deliberately does not feed the discovery cooldown (the primary call
        // just succeeded, so the provider is not down).
        ctx.logger.warn(
          `  [search:discovery-retry] ${ctx.config.slug}/${canonicalName}: retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        );
      }
    }

    if (exaResults.length === 0) {
      throw new Error(`Exa: no pages found for "${canonicalName}" on ${domain}`);
    }
    // Discovery may legitimately need a wide net (a retailer whose live route
    // ranks low), but extraction cost must not scale with it — each extra
    // candidate is up to two more paid provider calls on a page that may never
    // price. Truncation happens AFTER host/path filtering so the bound spends
    // its budget on in-policy URLs, never on rejects.
    const candidateLimit = cfg?.maxExtractionCandidates;
    const safeUrls = candidateLimit ? survivingUrls.slice(0, candidateLimit) : survivingUrls;

    // Report the pre-truncation count and the bound separately. Logging only
    // the truncated number would read as "the filter rejected the rest",
    // hiding a deliberate cost bound behind what looks like a policy reject.
    ctx.logger.info(
      `  [search:discovery] ${ctx.config.slug}/${canonicalName}: ${exaResults.length} URLs from Exa, ${survivingUrls.length} passed host/path check` +
        (safeUrls.length < survivingUrls.length
          ? `, extracting from the first ${safeUrls.length} (maxExtractionCandidates=${candidateLimit})`
          : ''),
    );

    if (safeUrls.length === 0) {
      // Self-diagnostic: log the rejected URLs so a future config drift (Exa
      // returning new path patterns the YAML doesn't list, or hostname shift
      // to a subdomain) is debuggable from the log alone — without this, a
      // run goes from "0 passed domain check" straight to a thrown error
      // with no record of what Exa actually returned.
      const sample = exaResults.slice(0, 5).map((r) => r.url).filter(Boolean).join(' | ');
      const excludedPinnedUrl = attemptedUrls.size > 0 && discoveredUrls.some((url) => attemptedUrls.has(url));
      ctx.logger.warn(
        `  [search:discovery] ${ctx.config.slug}/${canonicalName}: 0 of ${exaResults.length} URLs passed filter (hosts=${hostAllowlist.join('|')}, path=${pathFilters.length ? pathFilters.join('|') : '<none>'}${requiredSegments.length ? `, required=${requiredSegments.join('+')}` : ''}${excludedPinnedUrl ? ', pinned URL already attempted' : ''}). Rejected: ${sample}`,
      );
      if (excludedPinnedUrl) {
        throw new Error(`Exa: all ${exaResults.length} results repeated the pinned URL already attempted for "${canonicalName}"`);
      }
      throw new Error(
        `Exa: all ${exaResults.length} results failed host/path check (expected hostnames: ${hostAllowlist.join('|')}${pathFilters.length ? `, path: *${pathFilters.join('|')}*` : ''}${requiredSegments.length ? `, required path: ${requiredSegments.join('+')}` : ''})`,
      );
    }

    // Stage 2: structured extraction — iterate safe URLs until one yields a valid price.
    // _extractFromUrl keeps the provider fallback bounded per candidate and records
    // the reason each provider/page was rejected for the scrape-run diagnostics.
    let picked: ExtractionSuccess | null = null;
    let usedUrl = safeUrls[0];

    for (const url of safeUrls) {
      try {
        const attempt = await this._extractFromUrl(ctx, url, canonicalName, currency, itemConstraints);
        failures.push(...attempt.failures);
        if (attempt.result) {
          picked = attempt.result;
          usedUrl = url;
          break;
        }
        ctx.logger.warn(
          `  [search:extract] ${ctx.config.slug}/${canonicalName}: rejected ${url} (${formatExtractionFailures(attempt.failures)}), trying next`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`  [search:extract] ${ctx.config.slug}/${canonicalName}: extraction error on ${url}: ${msg}`);
        failures.push({ provider: 'firecrawl', reason: 'provider-error', detail: msg });
      }
    }

    if (picked === null) {
      throw new SearchTargetError(
        `All ${safeUrls.length} URLs failed extraction for "${canonicalName}". Last: ${formatExtractionFailures(failures.slice(-3))}`,
        // Only retailers that opted into the strict validator contribute to
        // `rejected_count`. Before this adapter change the metric was
        // structurally always 0 for non-pin search targets, so emitting it
        // fleet-wide would put a step change on ~20 retailers this work does
        // not touch — and `rejected_count` is one of the signals used to judge
        // whether the recovery worked.
        ctx.config.searchConfig?.requireStrictValidator === true &&
        failures.some(({ reason }) => REJECTION_FAILURES.has(reason))
          ? 1
          : 0,
        failures,
      );
    }

    ctx.logger.info(
      `  [search:extract] ${ctx.config.slug}/${canonicalName}: price=${picked.extracted.price} ${picked.extracted.currency} provider=${picked.provider} from ${usedUrl}`,
    );

    return {
      url: usedUrl,
      html: JSON.stringify({
        extracted: picked.extracted,
        productUrl: usedUrl,
        canonicalName,
        basketSlug,
        itemCategory: target.category,
        itemConstraints,
        validator: picked.validator,
        extractionProvider: picked.provider,
        priceEvidence: picked.priceEvidence,
        direct: false,
      } satisfies SearchPayload),
      statusCode: 200,
      fetchedAt: new Date(),
    };
  }

  async parseListing(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct[]> {
    const { extracted, productUrl, canonicalName, basketSlug, itemCategory, itemConstraints, validator, extractionProvider, priceEvidence, direct, pinnedProductId, matchId } =
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

    // Require the structured extractor to return a real product name — using canonical name as rawTitle
    // silently poisons the DB with unverifiable matches (e.g. extraction failures, wrong pages).
    if (!extracted.productName) {
      ctx.logger.warn(
        `  [search] ${canonicalName}: no productName from ${extractionProvider ?? 'structured extractor'}, rejecting ${productUrl}`,
      );
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
        // inStock defaults to true when the structured extractor does not return the field.
        // This is a conservative assumption — monitor for out-of-stock false positives.
        inStock: extracted.inStock ?? true,
        rawPayload: { extracted, basketSlug, itemCategory, canonicalName, itemConstraints, validator, extractionProvider, priceEvidence, direct, pinnedProductId, matchId },
      },
    ];
  }

  async parseProduct(_ctx: AdapterContext, _result: FetchResult): Promise<ParsedProduct> {
    throw new Error('SearchAdapter does not support single-product parsing');
  }
}
