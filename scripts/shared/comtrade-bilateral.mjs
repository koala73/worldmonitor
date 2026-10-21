import { recentPeriod } from './comtrade-period.mjs';

/** Row cap of the public preview route. A response this large may be truncated. */
export const PREVIEW_MAX_RECORDS = 500;

/**
 * A provider response that must not be published: `malformed` (unexpected
 * shape) or `incomplete` (capped, or partner rows exceed the reported World
 * total). Callers classify it with comtradeFailureState, never by message.
 */
export class ComtradeResponseError extends Error {
  /**
   * @param {'malformed' | 'incomplete'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'ComtradeResponseError';
    this.kind = kind;
  }
}

/**
 * Attempt state for a failed fetch. Only typed provider-response errors are
 * data defects; anything else (HTTP status, timeout, network, request budget)
 * is `unavailable`.
 * @param {unknown} error
 * @returns {'malformed' | 'incomplete' | 'unavailable'}
 */
export function comtradeFailureState(error) {
  const kind = error instanceof Error && error.name === 'ComtradeResponseError'
    ? /** @type {any} */ (error).kind
    : undefined;
  return kind === 'malformed' || kind === 'incomplete' ? kind : 'unavailable';
}

/** Smallest unrounded import share an origin needs to reach the brief. */
export const MIN_PARTNER_SHARE = 0.01;
/** Origins shown even when they fall below MIN_PARTNER_SHARE. */
export const MIN_PARTNERS = 5;
/** Hard ceiling on origins per heading, whatever their share. */
export const MAX_PARTNERS = 25;

/**
 * The origins a brief may name for one heading, and what it leaves out.
 *
 * Rank the product's partners by value, cap the list at `maxPartners`, keep the
 * ones holding at least `minShare` of the denominator, and pad back up to
 * `minPartners` so a heading with one dominant origin still gets context. What
 * is left of the ranked list becomes `omittedCount` and `omittedShare`, so the
 * brief can state how much of the trade it is not showing.
 *
 * Retention reads the unrounded ratio rather than the stored `share`: that
 * field is rounded to three decimals for display, and 0.96% rounds to 0.01,
 * which would promote exactly the origin the threshold exists to omit.
 *
 * @param {{totalValue?: number, partners?: Array<{value: number}>}} product
 * @param {{minShare?: number, minPartners?: number, maxPartners?: number}} [options]
 * @returns {{partners: Array<any>, omittedCount: number, omittedShare: number}}
 */
export function selectPartners(product, { minShare = MIN_PARTNER_SHARE, minPartners = MIN_PARTNERS, maxPartners = MAX_PARTNERS } = {}) {
  const ranked = (Array.isArray(product?.partners) ? [...product.partners] : [])
    .sort((a, b) => Number(b?.value) - Number(a?.value));
  const total = Number(product?.totalValue);
  const shareOf = (partner) => (total > 0 ? Number(partner?.value) / total : 0);

  // Ranking by value makes the retained set a prefix of the capped list, so
  // padding and the omitted tail are both plain slices.
  const capped = ranked.slice(0, maxPartners);
  const retained = capped.filter((partner) => shareOf(partner) >= minShare).length;
  const partners = capped.slice(0, Math.max(retained, minPartners));
  const omitted = ranked.slice(partners.length);
  return {
    partners,
    omittedCount: omitted.length,
    omittedShare: Math.round(omitted.reduce((sum, partner) => sum + shareOf(partner), 0) * 1000) / 1000,
  };
}

/** The leading `n` origins — the slice the canonical payload has always held. */
export function leadingExporters(product, n = 5) {
  return (Array.isArray(product?.topExporters) ? product.topExporters : []).slice(0, n);
}

/**
 * The canonical row: the leading five origins and nothing else. Three scorers
 * sum over every `topExporters` row and two bulk readers pull every canonical
 * key in one pipeline, so the partner list and World weight groupByProduct also
 * returns never reach it (KTD1). The seeder and the lazy fetch both write this
 * key, so both build the row here.
 *
 * @template {{topExporters: Array<any>}} T
 * @param {T & {partners?: unknown, worldNetWeightKg?: unknown}} product
 */
export function toCanonicalProduct(product) {
  const { partners: _partners, worldNetWeightKg: _worldNetWeightKg, ...canonical } = product;
  return { ...canonical, topExporters: leadingExporters(product) };
}

/**
 * The sibling row of `comtrade:bilateral-hs4-partners:{iso2}:v1`: the
 * threshold origins with weight and quantity, and what the threshold left out.
 * The seeder and the single-heading recovery both produce it, and the reader
 * merges either through one branch with no runtime validation, so both build
 * the row here.
 *
 * @param {{hs4: string, year: number, denominatorBasis?: string, totalValue: number, worldNetWeightKg?: number | null, partners?: Array<any>}} product
 */
export function toPartnersProduct(product) {
  const { partners, omittedCount, omittedShare } = selectPartners(product);
  return {
    hs4: product.hs4,
    year: product.year,
    denominatorBasis: product.denominatorBasis,
    totalValue: product.totalValue,
    worldNetWeightKg: product.worldNetWeightKg ?? null,
    partners,
    omittedCount,
    omittedShare,
  };
}

/**
 * The bilateral HS4 catalogue and its parsers, shared so the scheduled seeder
 * and the lazy fetch request the same headings and publish the same shape.
 * Parsers throw ComtradeResponseError rather than return a partial subset.
 */
export function createComtradeBilateralCatalogue(strategic, commodities, normalizeComtradePartner, quantityUnits) {
  // The pinned QuantityUnits reference. Without it no quantity is mappable, so
  // every parsed row reports `quantity: null` rather than an unlabelled number.
  const units = quantityUnits?.units ?? {};
  const labels = new Map();
  for (const p of strategic.products) {
    if (p.bilateralHs4Code) labels.set(p.bilateralHs4Code, p.bilateralLabel ?? p.label);
  }
  for (const c of commodities.commodities) {
    for (const hs4 of c.hs4) labels.set(hs4, c.basketLabel);
  }
  const HS4_CODES = [...labels.keys()];
  const HS4_LABELS = Object.fromEntries(labels);
  const MAX_HS4_CODES_PER_BATCH = 20;
  if (HS4_CODES.length > MAX_HS4_CODES_PER_BATCH * 2) throw new Error('Bilateral catalogue exceeds the two-request budget');
  const HS4_BATCHES = [HS4_CODES.slice(0, MAX_HS4_CODES_PER_BATCH), HS4_CODES.slice(MAX_HS4_CODES_PER_BATCH)]
    .filter(batch => batch.length > 0);

  /**
   * Weight and quantity are optional on every row and the provider writes 0 for
   * "not reported" (Qatar reports 0 t of its 2804 world exports), so only a
   * positive number is carried; a 0 that survived would read as "ships nothing".
   * A quantity is kept only with a unit code the pinned registry names, because
   * an unlabelled number cannot be rendered or compared.
   *
   * @param {unknown} data
   * @returns {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number, netWeightKg: number | null, netWeightEstimated: boolean, quantity: number | null, quantityUnitCode: number | null}>}
   */
  function parseRecords(data, maxRecords = Infinity) {
    const records = /** @type {any} */ (data)?.data;
    if (!Array.isArray(records)) throw new ComtradeResponseError('malformed', 'Malformed Comtrade data array');
    if (records.length >= maxRecords) throw new ComtradeResponseError('incomplete', 'Incomplete Comtrade response: record limit reached');
    return records.map(r => {
      const value = Number(r?.primaryValue);
      const year = Number(r?.period ?? r?.refYear);
      const partnerCode = String(r?.partnerCode ?? '');
      const cmdCode = String(r?.cmdCode ?? '');
      if (!r || r.primaryValue == null || !Number.isFinite(value) || value < 0
        || !/^\d{4}$/.test(cmdCode) || !/^\d{1,3}$/.test(partnerCode)
        || !Number.isInteger(year) || year < 1900 || year > 2100) {
        throw new ComtradeResponseError('malformed', 'Malformed Comtrade trade row');
      }
      const netWeightKg = Number(r.netWgt);
      const quantity = Number(r.qty);
      const quantityUnitCode = Number(r.qtyUnitCode);
      const reportedQuantity = Number.isFinite(quantity) && quantity > 0
        && Number.isFinite(quantityUnitCode) && units[String(quantityUnitCode)] != null;
      return {
        cmdCode,
        partnerCode,
        // Only a world-exports response (reporterCode omitted from the request)
        // varies the reporter across rows, so the field is carried only when the
        // provider sent one. An import row keeps the shape it has always had.
        ...(r.reporterCode != null && String(r.reporterCode) !== ''
          ? { reporterCode: String(r.reporterCode) }
          : {}),
        primaryValue: value,
        year,
        netWeightKg: Number.isFinite(netWeightKg) && netWeightKg > 0 ? netWeightKg : null,
        netWeightEstimated: r.isNetWgtEstimated === true,
        quantity: reportedQuantity ? quantity : null,
        quantityUnitCode: reportedQuantity ? quantityUnitCode : null,
      };
    }).filter(r => r.primaryValue > 0);
  }

  /**
   * `topExporters` is the canonical leading-5 contract every derived scorer sums
   * over, so it stays exactly as it was. `partners` is the same ranking without
   * the slice, carrying weight and quantity, for the brief's sibling key; no
   * canonical consumer reads it.
   *
   * @param {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number, netWeightKg?: number | null, netWeightEstimated?: boolean, quantity?: number | null, quantityUnitCode?: number | null}>} records
   * @param {number} [fallbackYear] year to report when no record carries a usable period/refYear
   * @returns {Array<{hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, partners: Array<{partnerCode: number, partnerIso2: string, value: number, share: number, netWeightKg: number | null, netWeightEstimated: boolean, quantity: number | null, quantityUnitCode: number | null}>, worldNetWeightKg: number | null, year: number}>}
   */
  function groupByProduct(records, fallbackYear = Number(recentPeriod())) {
    /** @type {Map<string, Map<string, {value: number, year: number, netWeightKg: number | null, netWeightEstimated: boolean, quantity: number | null, quantityUnitCode: number | null}>>} */
    const byCode = new Map();
    for (const r of records) {
      if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
      const partners = byCode.get(r.cmdCode);
      const existing = partners.get(r.partnerCode);
      // Newest year first, then largest value within it. With a single-period
      // response every r.year is equal, so this reduces to the previous
      // largest-value behaviour.
      if (!existing || r.year > existing.year
        || (r.year === existing.year && r.primaryValue > existing.value)) {
        partners.set(r.partnerCode, {
          value: r.primaryValue,
          year: r.year,
          // The winning row's own weight and quantity travel with its value, so
          // volume and value always describe the same observation.
          netWeightKg: r.netWeightKg ?? null,
          netWeightEstimated: r.netWeightEstimated === true,
          quantity: r.quantity ?? null,
          quantityUnitCode: r.quantityUnitCode ?? null,
        });
      }
    }

    const products = [];
    for (const [hs4, partners] of byCode) {
      const ranked = [...partners.entries()]
        .sort((a, b) => b[1].value - a[1].value)
        .filter(([pc]) => pc !== '0' && pc !== '000');

      // Collapse the product to ONE year before aggregating. Newest-year-per-
      // partner is not enough on the multi-year window: a partner that traded in
      // an older window year but not the newest would otherwise be summed into
      // totalValue and ranked into topExporters, so a lapsed relationship could
      // hold most of the share of a snapshot labelled a year it did not trade in.
      // A late filer is unaffected — all its rows sit at the same older year.
      const years = ranked.map(([, v]) => v.year).filter(y => y > 0);
      // Math.max(...[]) is -Infinity, which is TRUTHY — so `latestYear || fallback`
      // would return -Infinity and serialize as null, never reaching the fallback.
      const latestYear = years.length > 0 ? Math.max(...years) : 0;
      const sorted = latestYear > 0
        ? ranked.filter(([, v]) => v.year === latestYear)
        : ranked;

      const observedValue = sorted.reduce((s, [, v]) => s + v.value, 0);
      const world = partners.get('0') ?? partners.get('000');
      const hasWorld = world?.year === latestYear && world.value > 0;
      if (hasWorld && observedValue > world.value * 1.001) {
        throw new ComtradeResponseError('incomplete', 'Incomplete Comtrade response: partner values exceed World total');
      }
      const totalValue = hasWorld ? world.value : observedValue;
      if (totalValue <= 0) continue;
      const exporter = ([pc, v]) => ({
        partnerCode: Number(pc),
        partnerIso2: normalizeComtradePartner(pc).iso2,
        value: v.value,
        share: Math.round((v.value / totalValue) * 1000) / 1000,
      });
      const top5 = sorted.slice(0, 5);
      products.push({
        hs4,
        description: HS4_LABELS[hs4] ?? hs4,
        totalValue,
        denominatorBasis: hasWorld ? 'reported_world' : 'observed_partners',
        topExporters: top5.map(exporter),
        partners: sorted.map(entry => ({
          ...exporter(entry),
          netWeightKg: entry[1].netWeightKg,
          netWeightEstimated: entry[1].netWeightEstimated,
          quantity: entry[1].quantity,
          quantityUnitCode: entry[1].quantityUnitCode,
        })),
        // The World row's own weight, so the brief can state the tonnage the
        // shown origins are a share of. Only meaningful at the collapsed year.
        worldNetWeightKg: hasWorld ? world.netWeightKg ?? null : null,
        year: latestYear > 0 ? latestYear : fallbackYear,
      });
    }
    return products.sort((a, b) => b.totalValue - a.totalValue);
  }

  /**
   * World exports per heading, from a `flowCode=X&partnerCode=0` response with
   * `reporterCode` omitted: one row per reporter, each the reporter's total
   * exports of that heading to the World. The brief reads it to state a
   * supplier's absolute scale and its rank among world exporters, so the order
   * of `exporters` is itself the published fact — rank is its index plus one.
   *
   * Rows for a specific partner are ignored: they describe one corridor, and
   * ranking a reporter on one would understate every large exporter. The year
   * collapse mirrors groupByProduct — newest year per reporter, then the
   * heading keeps only the reporters that filed in its newest year — so a
   * lapsed exporter cannot be ranked into a year it did not trade in.
   *
   * Leaving a late filer out moves every exporter below it up one place, so a
   * rank is only a rank among that year's filers. `unrankedReporterCount`
   * counts the reporters left out — whose newest filing predates the heading
   * year — and the brief prints both counts beside the rank.
   *
   * @param {Array<{cmdCode: string, partnerCode: string, reporterCode?: string, primaryValue: number, year: number, netWeightKg?: number | null}>} records
   * @returns {Record<string, {year: number, exporters: Array<{reporterCode: number, iso2: string, valueUsd: number, netWeightKg: number | null}>, unrankedReporterCount: number}>}
   */
  function groupWorldExports(records) {
    /** @type {Map<string, Map<string, {value: number, year: number, netWeightKg: number | null}>>} */
    const byCode = new Map();
    for (const r of records) {
      if (r.partnerCode !== '0' && r.partnerCode !== '000') continue;
      const reporterCode = String(r.reporterCode ?? '');
      if (reporterCode === '') continue;
      if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
      const reporters = byCode.get(r.cmdCode);
      const existing = reporters.get(reporterCode);
      if (!existing || r.year > existing.year
        || (r.year === existing.year && r.primaryValue > existing.value)) {
        reporters.set(reporterCode, {
          value: r.primaryValue,
          year: r.year,
          netWeightKg: r.netWeightKg ?? null,
        });
      }
    }

    /** @type {Record<string, {year: number, exporters: Array<any>, unrankedReporterCount: number}>} */
    const headings = {};
    for (const [hs4, reporters] of byCode) {
      const rows = [...reporters.entries()];
      const years = rows.map(([, v]) => v.year).filter(y => y > 0);
      const latestYear = years.length > 0 ? Math.max(...years) : 0;
      const unrankedReporterCount = latestYear > 0 ? rows.filter(([, v]) => v.year < latestYear).length : 0;
      const exporters = (latestYear > 0 ? rows.filter(([, v]) => v.year === latestYear) : rows)
        .sort((a, b) => b[1].value - a[1].value)
        .map(([reporterCode, v]) => ({
          reporterCode: Number(reporterCode),
          iso2: normalizeComtradePartner(reporterCode).iso2,
          valueUsd: v.value,
          netWeightKg: v.netWeightKg,
        }));
      if (exporters.length === 0) continue;
      headings[hs4] = { year: latestYear, exporters, unrankedReporterCount };
    }
    return headings;
  }

  /**
   * The registry's abbreviation for a Comtrade quantity unit code, or null when
   * the code is unknown — including -1, which the provider uses for "no
   * quantity" and the pinned registry therefore omits.
   * @param {unknown} code
   * @returns {string | null}
   */
  function quantityUnitAbbr(code) {
    return units[String(code)]?.abbr ?? null;
  }

  return { HS4_CODES, HS4_LABELS, MAX_HS4_CODES_PER_BATCH, HS4_BATCHES, parseRecords, groupByProduct, groupWorldExports, quantityUnitAbbr };

}
