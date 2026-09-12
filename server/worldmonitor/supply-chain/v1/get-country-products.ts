import type {
  ServerContext, GetCountryProductsRequest, GetCountryProductsResponse, CountryProduct,
  ProductExporter, ExporterScale,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { normalizeComtradeProducts, HS4_CODES, HS4_LABELS } from '../../../../scripts/shared/comtrade';
import { isCallerPremium } from '../../../_shared/premium-check';
import { getCachedJson, getLargeRawJson, logCacheReadError, readCachedJson } from '../../../_shared/redis';
import { lazyFetchBilateralHs4, lazyFetchHeading, UPSTREAM_GAP_MS } from './_bilateral-hs4-lazy';
import type { LazyFetchResult, PartnerRow, PartnersProduct } from './_bilateral-hs4-lazy';

// One budget for every provider request a single call can make: the catalogue
// attempt and the single-heading attempt after it. A heading request that
// cannot get MIN_HEADING_BUDGET_MS of it reads only what is cached.
const LAZY_BUDGET_MS = 9_000;
const MIN_HEADING_BUDGET_MS = 1_500;
// Retrieval route of a heading recovered on demand when nothing is stored.
const RECOVERY_SOURCE = 'UN Comtrade public preview (single-heading recovery)';

export interface BilateralHs4Payload {
  iso2: string;
  products: CountryProduct[];
  fetchedAt?: string;
  source?: string;
  requestedHs4s?: string[];
}

/** Sibling detail key (KTD1): the threshold origins the canonical key omits. */
interface BilateralHs4PartnersPayload {
  iso2: string;
  products: PartnersProduct[];
  fetchedAt?: string;
}

/**
 * One world-exports snapshot: every reporter's exports of each heading. The
 * producer writes `reporterCode` as a number, the same space as a canonical
 * row's `partnerCode`, which is what the join is keyed on.
 */
interface WorldExportsPayload {
  fetchedAt?: string;
  headings?: Record<string, {
    year?: number;
    exporters?: Array<{ reporterCode?: number; valueUsd?: number; netWeightKg?: number | null }>;
    unrankedReporterCount?: number;
  }>;
}

const PARTNERS_KEY = (iso2: string): string => `comtrade:bilateral-hs4-partners:${iso2}:v1`;
const WORLD_EXPORTS_KEY = 'comtrade:world-exports-hs4:v1';

// Matches the bulk seeder's 35-day health staleness window.
const MAX_PAYLOAD_AGE_MS = 35 * 86_400_000;
const isStale = (fetchedAt?: string): boolean => {
  const age = Date.now() - Date.parse(fetchedAt ?? '');
  return !Number.isFinite(age) || age < 0 || age > MAX_PAYLOAD_AGE_MS;
};

/**
 * Drop null and undefined entries. Every new field is proto3 `optional`, and an
 * unreported weight must be absent rather than 0 — "not reported" and "ships
 * nothing" are different claims and the brief renders them differently (KTD4).
 */
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)) as T;
}

const toExporter = (partner: PartnerRow): ProductExporter => defined({
  partnerCode: partner.partnerCode,
  partnerIso2: partner.partnerIso2,
  value: partner.value,
  share: partner.share,
  netWeightKg: partner.netWeightKg ?? undefined,
  // Only meaningful next to a weight: "estimated: false" with no weight would
  // read as a confirmed zero.
  netWeightEstimated: partner.netWeightKg != null ? partner.netWeightEstimated === true : undefined,
  quantity: partner.quantity ?? undefined,
  quantityUnitCode: partner.quantityUnitCode ?? undefined,
}) as ProductExporter;

/** A sibling-shaped heading as a response row: threshold origins with volume. */
const fromPartnersProduct = (product: PartnersProduct): CountryProduct => defined({
  hs4: product.hs4,
  description: HS4_LABELS[product.hs4] ?? product.hs4,
  totalValue: product.totalValue,
  topExporters: product.partners.map(toExporter),
  year: product.year,
  denominatorBasis: product.denominatorBasis,
  partnerBasis: 'share_threshold',
  omittedPartnerCount: product.omittedCount,
  omittedPartnerShare: product.omittedShare,
}) as CountryProduct;

/**
 * Threshold partner rows by heading, with the run time they were written at. An
 * unreadable or malformed sibling key is treated as absent, never as a cache
 * failure: it is supplementary evidence, so losing it degrades the row to the
 * canonical leading 5 rather than blanking the response the canonical key can
 * still answer.
 */
function readSiblingProducts(read: { status: string; value?: unknown }, iso2: string): { rows: Map<string, PartnersProduct>; fetchedAt?: string } {
  const rows = new Map<string, PartnersProduct>();
  const payload = (read.status === 'hit' ? read.value : null) as BilateralHs4PartnersPayload | null;
  if (!payload || payload.iso2 !== iso2 || !Array.isArray(payload.products)) return { rows };
  for (const product of payload.products) {
    if (product && typeof product.hs4 === 'string' && Array.isArray(product.partners)
      && product.partners.every(p => p && typeof p.partnerCode === 'number')) {
      rows.set(product.hs4, product);
    }
  }
  return { rows, fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : undefined };
}

/**
 * Whether a sibling written at `siblingFetchedAt` may describe a payload fetched
 * at `payloadFetchedAt`. The sibling is written by the scheduled run beside the
 * canonical key, so it is current only for that run or an older one: a warm
 * refresh that just replaced the served rows must not be overridden by detail
 * from a previous month, however similar the observation year.
 */
function siblingIsCurrent(siblingFetchedAt: string | undefined, payloadFetchedAt: string | undefined): boolean {
  const sibling = Date.parse(siblingFetchedAt ?? '');
  const payload = Date.parse(payloadFetchedAt ?? '');
  if (!Number.isFinite(sibling)) return false;
  return !Number.isFinite(payload) || sibling >= payload;
}

/**
 * World-export scale per heading, keyed by exporter code. The producer already
 * ranked `exporters` by value, so rank is the position in that list, and the
 * list's length is the number of reporters the rank is out of.
 *
 * A heading whose year is unusable is skipped: a supplier's world exports can
 * only be read against an import share of the same observation year, and a
 * scale labelled with a fabricated year would invite exactly that comparison.
 */
function readWorldExports(value: unknown): { fetchedAt?: string; byHeading: Map<string, Map<number, ExporterScale>> } {
  const payload = (value ?? null) as WorldExportsPayload | null;
  const byHeading = new Map<string, Map<number, ExporterScale>>();
  for (const [hs4, heading] of Object.entries(payload?.headings ?? {})) {
    const year = Number(heading?.year);
    if (!Array.isArray(heading?.exporters) || !Number.isInteger(year)) continue;
    const reporterCount = heading.exporters.length;
    // Reporters left out of the ranking because their newest filing is older.
    // Absent on a snapshot written before the count existed: unknown, not zero.
    const unranked = Number(heading.unrankedReporterCount);
    const unrankedReporterCount = Number.isInteger(unranked) && unranked >= 0 ? unranked : undefined;
    const byCode = new Map<number, ExporterScale>();
    heading.exporters.forEach((exporter, index) => {
      const code = Number(exporter?.reporterCode);
      const worldExportsUsd = Number(exporter?.valueUsd);
      if (!Number.isFinite(code) || !Number.isFinite(worldExportsUsd)) return;
      const worldExportsKg = Number(exporter?.netWeightKg);
      byCode.set(code, defined({
        worldExportsUsd,
        worldExportsKg: Number.isFinite(worldExportsKg) && worldExportsKg > 0 ? worldExportsKg : undefined,
        rank: index + 1,
        year,
        reporterCount,
        unrankedReporterCount,
      }) as ExporterScale);
    });
    byHeading.set(hs4, byCode);
  }
  return { fetchedAt: typeof payload?.fetchedAt === 'string' ? payload.fetchedAt : undefined, byHeading };
}

/**
 * One response row. The sibling's threshold origins replace the canonical
 * leading 5 only when they describe the same or a later observation year — an
 * older sibling would relabel the row with a year it no longer holds. When the
 * sibling wins, its own year, denominator and total travel with it, so the
 * shares and the denominator they were computed against always agree.
 */
function mergeProduct(canonical: CountryProduct, sibling?: PartnersProduct): CountryProduct {
  if (!sibling || !(Number(sibling.year) >= Number(canonical.year))) {
    return { ...canonical, partnerBasis: 'leading_5' };
  }
  return { ...fromPartnersProduct(sibling), description: canonical.description };
}

/**
 * Supplier scale for each shown origin; an origin the snapshot omits gets none.
 * The snapshot holds the newest year any reporter filed, so a late filer's row
 * can be a year behind it: a share and a rank from different years are not
 * attached to each other.
 */
function attachScale(product: CountryProduct, byCode?: Map<number, ExporterScale>): CountryProduct {
  if (!byCode?.size) return product;
  return {
    ...product,
    topExporters: product.topExporters.map(exporter => {
      const scale = byCode.get(exporter.partnerCode);
      return scale && scale.year === product.year ? { ...exporter, scale } : exporter;
    }),
  };
}

export async function getCountryProducts(
  ctx: ServerContext,
  req: GetCountryProductsRequest,
): Promise<GetCountryProductsResponse> {
  const iso2 = (req.iso2 ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }
  const hs4 = req.hs4?.trim();
  if (hs4 && !HS4_CODES.includes(hs4)) {
    throw new ValidationError([{ field: 'hs4', description: 'hs4 must be a supported four-digit heading' }]);
  }
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetCountryProductsResponse = { iso2, products: [], fetchedAt: '' };
  if (!isPro) return empty;

  const key = `comtrade:bilateral-hs4:${iso2}:v1`;
  // Status-aware reads for the two country keys so a read error stays
  // distinguishable from a miss; the canonical one decides cache_unavailable,
  // the sibling one only decides how deep the origins go.
  // The sibling detail and the world-exports snapshot are served only for a
  // requested heading, so a whole-catalogue caller (the deep-dive panel) does
  // not read them: the snapshot is a few hundred kilobytes (36 headings x ~140
  // reporters), past what the 1.5 s single-GET deadline is sized for, and the
  // large-value reader waits on the pipeline deadline instead.
  const [cached, siblingRead, worldExportsValue, meta] = await Promise.all([
    readCachedJson(key, true),
    hs4 ? readCachedJson(PARTNERS_KEY(iso2), true) : { status: 'miss' as const },
    hs4 ? getLargeRawJson(WORLD_EXPORTS_KEY).catch(() => null) : null,
    getCachedJson('seed-meta:comtrade:bilateral-hs4', true).catch(() => null) as Promise<{
      countryCoverage?: Record<string, { state?: string; attemptedAt?: string }>;
      preserveStreaks?: Record<string, number>;
    } | null>,
  ]);
  // A sibling read error degrades to the leading 5 silently for the caller, so
  // it is at least logged for the operator.
  if (siblingRead.status === 'error') logCacheReadError(PARTNERS_KEY(iso2), siblingRead.error);
  let cacheFailed = cached.status === 'error';
  let payload = (cached.status === 'hit' ? cached.value : null) as BilateralHs4Payload | null;
  let attempt = meta?.countryCoverage?.[iso2];
  if (payload && (!Array.isArray(payload.products) || payload.iso2 !== iso2
    || payload.products.some(p => !p || typeof p.hs4 !== 'string' || !Array.isArray(p.topExporters) || p.topExporters.some(e => !e || typeof e.partnerCode !== 'number')))) {
    cacheFailed = true;
    payload = null;
  }
  const sibling = readSiblingProducts(siblingRead, iso2);
  let recovered: PartnersProduct | undefined;
  let recoveredFetchedAt: string | undefined;
  let headingAttempted = false;

  // Every provider request this call can make shares one budget: the catalogue
  // attempt, then the heading attempt after it.
  const lazyDeadline = Date.now() + LAZY_BUDGET_MS;
  let refreshed: LazyFetchResult | null = null;
  // Cache read failure is not a cache miss. Do not overwrite unseen last-good data.
  if (!cacheFailed && (!payload || isStale(payload.fetchedAt))) {
    // Nothing stored, or the whole payload is past its freshness window: the
    // full catalogue is refetched, exactly as get-route-impact does.
    refreshed = await lazyFetchBilateralHs4(iso2, payload ?? undefined);
    attempt = { state: refreshed?.state ?? 'busy', attemptedAt: refreshed?.attemptedAt ?? '' };
    if (refreshed?.payload) payload = refreshed.payload;
  }
  // The requested heading gets its own bounded attempt whenever the stored
  // evidence does not answer for it: the row is absent, or the payload is still
  // past its freshness window after the catalogue attempt above. A large
  // importer's whole-catalogue fetch fills the preview route's row cap and ends
  // incomplete, so without this the heading users ask for would never recover.
  // The stored row's year, when there is one, arms the regression guard.
  const storedRow = hs4 ? payload?.products.find(p => p.hs4 === hs4) : undefined;
  // The catalogue attempt just asked the same route, for the same period, about
  // every catalogue heading. An empty answer, or an observed one without this
  // heading, already answers for it; asking for the heading alone cannot differ.
  const catalogueAnswered = refreshed?.state === 'no_records'
    || (refreshed?.state === 'observed' && hs4 != null && refreshed.payload?.requestedHs4s?.includes(hs4) === true);
  if (!cacheFailed && hs4 && (!storedRow || isStale(payload?.fetchedAt)) && !catalogueAnswered) {
    const storedYears = [storedRow?.year, sibling.rows.get(hs4)?.year].filter((y): y is number => Number.isInteger(y));
    // The heading request follows the catalogue request on the same
    // rate-limited route, so it waits out the gap after it. With too little of
    // the budget left it only reads what an earlier attempt cached.
    const notBefore = refreshed?.upstreamSettledAt != null ? refreshed.upstreamSettledAt + UPSTREAM_GAP_MS : 0;
    const cacheOnly = lazyDeadline - Math.max(Date.now(), notBefore) < MIN_HEADING_BUDGET_MS;
    const heading = await lazyFetchHeading(iso2, hs4, storedYears.length ? Math.max(...storedYears) : undefined,
      { notBefore, deadlineAt: lazyDeadline, cacheOnly });
    // A cache-only read that found nothing made no attempt; the catalogue's stands.
    if (heading || !cacheOnly) {
      headingAttempted = true;
      attempt = { state: heading?.state ?? 'busy', attemptedAt: heading?.attemptedAt ?? '' };
      recovered = heading?.product;
      recoveredFetchedAt = heading?.fetchedAt;
    }
  }

  const { fetchedAt: worldExportsFetchedAt, byHeading } = readWorldExports(worldExportsValue);
  // The sibling's threshold detail is served only for the heading the caller
  // asked for. Every other caller (the deep-dive panel, route workflows) keeps
  // the leading 5 it has always rendered. A sibling older than the payload now
  // served — a warm refresh just replaced the rows — is not current for it.
  const siblingFor = (product: CountryProduct): PartnersProduct | undefined =>
    hs4 === product.hs4 && siblingIsCurrent(sibling.fetchedAt, payload?.fetchedAt) ? sibling.rows.get(product.hs4) : undefined;
  const merged = (payload?.products ?? [])
    .filter(product => !(recovered && product.hs4 === recovered.hs4))
    .map(product => mergeProduct(product, siblingFor(product)));
  if (recovered) {
    // Appended rather than re-ranked: the stored order is the producing run's
    // ranking. A recovered heading replaces its stale stored row and carries its
    // own fetch time, because it is not the payload's.
    merged.push(defined({ ...fromPartnersProduct(recovered), fetchedAt: recoveredFetchedAt }));
  }
  const products = normalizeComtradeProducts(merged).map((p: CountryProduct) => attachScale(
    { ...p, description: HS4_LABELS[p.hs4] ?? p.description },
    byHeading.get(p.hs4),
  ));

  const fetchedAt = payload?.fetchedAt ?? '';
  const missingHs4s = HS4_CODES.filter(code => !products.some((p: CountryProduct) => p.hs4 === code));
  let state = 'observed';
  if (cacheFailed) state = 'cache_unavailable';
  // With nothing stored, a recovered heading is the whole answer: one heading of
  // the catalogue, from the recovery route, not the attempt state or a legacy cache.
  else if (!payload) state = recovered ? 'partial' : attempt?.state ?? 'missing';
  else if (isStale(fetchedAt)) state = 'stale_preserved';
  else if (missingHs4s.length) state = 'partial';
  return {
    iso2, products, fetchedAt,
    evidence: defined({
      state,
      source: payload?.source ?? (recovered ? RECOVERY_SOURCE : 'UN Comtrade bilateral HS4 (legacy cache; retrieval method unknown)'),
      // A single-heading attempt that came back empty requested exactly that
      // heading, so it reads as "requested and empty" rather than "coverage
      // unverified". A busy, rate-limited or failed attempt proves nothing
      // about the heading and must not claim it was asked and answered.
      requestedHs4s: headingAttempted
        ? (attempt?.state === 'no_records' ? [...new Set([...(payload?.requestedHs4s ?? []), hs4!])] : payload?.requestedHs4s ?? [])
        : attempt?.state === 'no_records' ? HS4_CODES : payload?.requestedHs4s ?? [],
      missingHs4s,
      lastAttemptAt: attempt?.attemptedAt ?? '',
      lastAttemptState: attempt?.state ?? (meta?.preserveStreaks?.[iso2] ? 'preserved_reason_unknown' : 'unknown'),
      recoveredHs4s: recovered ? [recovered.hs4] : [],
      worldExportsFetchedAt,
    }),
  };
}
