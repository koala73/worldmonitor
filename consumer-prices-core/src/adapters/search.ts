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
import type { BasketItem } from '../config/types.js';
import type { AcquisitionProviderName } from '../acquisition/types.js';

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
  direct?: boolean;
  pinnedProductId?: string;
  matchId?: string;
}

const REJECTION_FAILURES = new Set<ExtractionFailureReason>([
  'validator-rejected',
  'quantity-as-price',
  'currency-mismatch',
  'title-mismatch',
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
  // open a per-scrape cooldown; an explicitly configured fallback can still
  // make one bounded attempt per candidate.
  private firecrawlFailureStreak = 0;
  private firecrawlCooldownOpen = false;
  private exaExtractionFailureStreak = 0;
  private exaExtractionCooldownOpen = false;
  private exaDiscoveryFailureStreak = 0;
  private exaDiscoveryCooldownOpen = false;

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
    this.firecrawlFailureStreak = 0;
    this.firecrawlCooldownOpen = false;
    this.exaExtractionFailureStreak = 0;
    this.exaExtractionCooldownOpen = false;
    this.exaDiscoveryFailureStreak = 0;
    this.exaDiscoveryCooldownOpen = false;

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
      prompt: `Extract the retail price of THIS specific product from the main product section of the page.${sizeClause} The price may be displayed as two parts split across lines — like "3" and ".95" next to "${currency}" — combine them to get 3.95. ONLY extract the price shown for the main product itself. If the page shows "Out of Stock" and no price is displayed for the main product, return null for price — do NOT use prices from related products, recommendations, or carousels. Return the product name, the numeric price in ${currency} (null if not shown), the currency code, whether it is in stock, and the size or quantity shown on the page.`,
      fields: {
        productName: { type: 'string' as const, required: true, description: 'Name or title of the product' },
        price: {
          type: 'number' as const,
          required: true,
          nullable: true,
          description: `Retail price in ${currency} as a single number (e.g. 4.69)`,
        },
        currency: { type: 'string' as const, required: true, description: `Currency code, should be ${currency}` },
        inStock: {
          type: 'boolean' as const,
          required: false,
          description: 'Whether the product is currently in stock and purchasable',
        },
        sizeText: {
          type: 'string' as const,
          required: false,
          description: 'Size or quantity shown on the page (e.g. "32 oz", "1 gallon", "24 pack")',
        },
      },
    };

    const failures: ExtractionFailure[] = [];
    const providers: ExtractionProviderName[] = ['firecrawl'];
    if (ctx.config.searchConfig?.extractionFallback === 'exa') providers.push('exa');
    const strictMode = ctx.config.searchConfig?.requireStrictValidator === true;
    const validationConstraints: ItemConstraints = itemConstraints ?? { baseUnit: '' };

    for (const provider of providers) {
      if (provider === 'firecrawl' && this.firecrawlCooldownOpen) {
        failures.push({ provider, reason: 'provider-cooldown' });
        continue;
      }
      if (provider === 'exa' && this.exaExtractionCooldownOpen) {
        failures.push({ provider, reason: 'provider-cooldown' });
        continue;
      }

      let data: ExtractedProduct;
      try {
        const result =
          provider === 'firecrawl'
            ? await this.firecrawl.extract<ExtractedProduct>(url, extractSchema, { timeout: 30_000 })
            : await this.exa.extract<ExtractedProduct>(url, extractSchema, { timeout: 30_000 });
        data = result.data ?? {};
        if (provider === 'firecrawl') this.firecrawlFailureStreak = 0;
        if (provider === 'exa') this.exaExtractionFailureStreak = 0;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push({ provider, reason: 'provider-error', detail });
        if (provider === 'firecrawl') {
          this.firecrawlFailureStreak++;
          if (this.firecrawlFailureStreak >= 2) {
            this.firecrawlCooldownOpen = true;
            ctx.logger.warn(
              `  [search:provider-cooldown] ${ctx.config.slug}: Firecrawl disabled for the remainder of this scrape after ${this.firecrawlFailureStreak} consecutive errors`,
            );
          }
        }
        if (provider === 'exa') {
          this.exaExtractionFailureStreak++;
          if (this.exaExtractionFailureStreak >= 2) {
            this.exaExtractionCooldownOpen = true;
            ctx.logger.warn(
              `  [search:provider-cooldown] ${ctx.config.slug}: Exa extraction disabled for the remainder of this scrape after ${this.exaExtractionFailureStreak} consecutive errors`,
            );
          }
        }
        continue;
      }

      const price = data.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        failures.push({ provider, reason: 'missing-price' });
        continue;
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

      return { result: { extracted: data, validator, provider }, failures };
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

    // Direct path: skip Exa discovery, call the configured extractor on the pinned URL.
    if (direct) {
      try {
        const attempt = await this._extractFromUrl(ctx, target.url, canonicalName, currency, itemConstraints);
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
        ctx.logger.warn(`  [search:pin] ${ctx.config.slug}/${canonicalName}: pin fetch error, falling back to Exa: ${err}`);
      }
    }

    if (this.firecrawlCooldownOpen && ctx.config.searchConfig?.extractionFallback !== 'exa') {
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
    if (this.exaDiscoveryCooldownOpen) {
      throw new SearchTargetError(
        `Exa discovery cooldown is open for "${canonicalName}"`,
        0,
        [{ provider: 'exa', reason: 'provider-cooldown' }],
      );
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
    let exaResults;
    try {
      exaResults = await this.exa.search(searchQuery, {
        numResults: cfg?.numResults ?? 3,
        includeDomains: hostAllowlist,
        timeout: 30_000,
      });
      this.exaDiscoveryFailureStreak = 0;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.exaDiscoveryFailureStreak++;
      if (this.exaDiscoveryFailureStreak >= 2) {
        this.exaDiscoveryCooldownOpen = true;
        ctx.logger.warn(
          `  [search:provider-cooldown] ${ctx.config.slug}: Exa discovery disabled for the remainder of this scrape after ${this.exaDiscoveryFailureStreak} consecutive errors (last: ${detail})`,
        );
      }
      // Carry `detail` into the message: nothing downstream reads `.failures`,
      // so without it the log cannot tell an auth failure from a rate limit
      // from a timeout — the distinction the cooldown exists to surface.
      throw new SearchTargetError(`Exa search failed for "${canonicalName}": ${detail}`, 0, [
        { provider: 'exa', reason: 'provider-error', detail },
      ]);
    }

    if (exaResults.length === 0) {
      throw new Error(`Exa: no pages found for "${canonicalName}" on ${domain}`);
    }

    const pathFilters = normalizePathFilters(cfg?.urlPathContains);
    const requiredSegments = cfg?.urlPathMustContain ?? [];
    const attemptedUrls = direct ? new Set([target.url]) : new Set<string>();
    const discoveredUrls = exaResults
      .map((r) => r.url)
      .filter(
        (url) =>
          !!url &&
          isAllowedHost(url, hostAllowlist) &&
          matchesAnyPathFilter(url, pathFilters) &&
          matchesRequiredPathSegments(url, requiredSegments),
      );
    const safeUrls = [...new Set(discoveredUrls)].filter((url) => !attemptedUrls.has(url));

    ctx.logger.info(
      `  [search:discovery] ${ctx.config.slug}/${canonicalName}: ${exaResults.length} URLs from Exa, ${safeUrls.length} passed host/path check`,
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
    const failures: ExtractionFailure[] = [];

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
        direct: false,
      } satisfies SearchPayload),
      statusCode: 200,
      fetchedAt: new Date(),
    };
  }

  async parseListing(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct[]> {
    const { extracted, productUrl, canonicalName, basketSlug, itemCategory, itemConstraints, validator, extractionProvider, direct, pinnedProductId, matchId } =
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
        rawPayload: { extracted, basketSlug, itemCategory, canonicalName, itemConstraints, validator, extractionProvider, direct, pinnedProductId, matchId },
      },
    ];
  }

  async parseProduct(_ctx: AdapterContext, _result: FetchResult): Promise<ParsedProduct> {
    throw new Error('SearchAdapter does not support single-product parsing');
  }
}
