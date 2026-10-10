/**
 * RPC: getUsImportDuty -- the current US duty on one product from one
 * country: the HTS rate columns plus the chapter 99 Section 301 and 232
 * duties.
 *
 * Two sources, both USITC's HTS REST service:
 *  - The product's lines come live from `exportList` (about 0.5 s) and are
 *    cached for a day.
 *  - Chapter 99 coverage is seeded by scripts/seed-supply-chain-trade.mjs
 *    (see scripts/shared/us-hts-chapter99.mjs): a catalog of measures and one
 *    coverage shard per HS chapter, keyed by HTS release. The coverage lives in
 *    5 MB of chapter 99 U.S. notes, too large to parse per request.
 *
 * Duties are classified rather than summed blindly:
 *  - APPLIES: listed for this provision and partner, nothing lifts it.
 *  - CONDITIONAL: depends on the goods or the entry (Section 232 origin deals
 *    and metal content, end-use exemptions, USMCA entry, a listing that names
 *    particular articles inside the line).
 *  - EXEMPT: an exemption heading lists the provision for this partner.
 *  - SCHEDULED: in the HTS but not yet in force.
 * `estimated_rate` adds only APPLIES duties, and `estimate_complete` says
 * whether anything was left out.
 *
 * IEEPA duties (9903.01.xx, 9903.02.xx) are still printed in the HTS but have
 * not been collected since 2026-02-24 (Learning Resources v. Trump), and the
 * Section 122 surcharge expired on 2026-07-23. Neither is reported.
 */
import type {
  ServerContext,
  GetUsImportDutyRequest,
  GetUsImportDutyResponse,
  UsTariffLine,
  UsAdditionalDuty,
  UsDutyBasis,
  UsDutyAuthority,
  UsAdditionalDutyStatus,
  UsImportDutyUnavailableReason,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { isCallerPremium } from '../../../_shared/premium-check';

export const HTS_REST_BASE = 'https://hts.usitc.gov/reststop';
export const US_IMPORT_DUTY_SOURCE = 'USITC Harmonized Tariff Schedule';

// Must match scripts/shared/us-hts-chapter99.mjs (pinned by a test).
export const US_HTS_CATALOG_KEY = 'trade:us-hts:catalog:v1';
export const US_HTS_COVERAGE_PREFIX = 'trade:us-hts:coverage:v1';
export const US_HTS_LINES_KEY_PREFIX = 'trade:us-hts:lines:v1';

const LINES_TTL_SECONDS = 24 * 3600;
const FAULT_TTL_SECONDS = 300;
const LINES_FETCH_TIMEOUT_MS = 8_000;

const HS = /^[0-9]{6}([0-9]{2}){0,2}$/;
const CODE3 = /^[0-9]{3}$/;

/** General note 3(b): column 2 countries. */
export const COLUMN_2_PARTNERS: ReadonlySet<string> = new Set(['112', '192', '408', '643']);

/**
 * General note 3(c)(i) programs a partner is party to, by UN M49. Programs
 * whose beneficiaries are designated by list (AGOA "D", CBERA "E", CBTPA "R",
 * Nepal "NP") or by end use (civil aircraft "C", pharmaceuticals "K", dyes
 * "L") are reported as unresolved. GSP ("A", "A*", "A+") has been lapsed
 * since 2021-01-01 and is ignored.
 */
export const PARTNER_PROGRAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '036': ['AU'],
  '048': ['BH'],
  '124': ['S', 'S+', 'B'],
  '152': ['CL'],
  '170': ['CO'],
  '188': ['P', 'P+'],
  '214': ['P', 'P+'],
  '222': ['P', 'P+'],
  '320': ['P', 'P+'],
  '340': ['P', 'P+'],
  '376': ['IL'],
  '392': ['JP'],
  '400': ['JO'],
  '410': ['KR'],
  '484': ['S', 'S+'],
  '504': ['MA'],
  '512': ['OM'],
  '558': ['P', 'P+'],
  '591': ['PA'],
  '604': ['PE'],
  '702': ['SG'],
});
const UNRESOLVED_PROGRAMS: ReadonlySet<string> = new Set(['C', 'D', 'E', 'E*', 'K', 'L', 'NP', 'R']);
const LAPSED_PROGRAMS: ReadonlySet<string> = new Set(['A', 'A*', 'A+']);

const BASIS = {
  none: 'US_DUTY_BASIS_UNSPECIFIED',
  mfn: 'US_DUTY_BASIS_MFN',
  preferential: 'US_DUTY_BASIS_PREFERENTIAL',
  column2: 'US_DUTY_BASIS_COLUMN_2',
} as const satisfies Record<string, UsDutyBasis>;

const STATUS = {
  applies: 'US_ADDITIONAL_DUTY_STATUS_APPLIES',
  conditional: 'US_ADDITIONAL_DUTY_STATUS_CONDITIONAL',
  exempt: 'US_ADDITIONAL_DUTY_STATUS_EXEMPT',
  scheduled: 'US_ADDITIONAL_DUTY_STATUS_SCHEDULED',
} as const satisfies Record<string, UsAdditionalDutyStatus>;

const AUTHORITY: Record<string, UsDutyAuthority> = {
  SECTION_301: 'US_DUTY_AUTHORITY_SECTION_301',
  SECTION_232: 'US_DUTY_AUTHORITY_SECTION_232',
};

const REASON = {
  served: 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UNSPECIFIED',
  invalidRequest: 'US_IMPORT_DUTY_UNAVAILABLE_REASON_INVALID_REQUEST',
  notCovered: 'US_IMPORT_DUTY_UNAVAILABLE_REASON_NOT_COVERED',
  upstreamUnavailable: 'US_IMPORT_DUTY_UNAVAILABLE_REASON_UPSTREAM_UNAVAILABLE',
} as const satisfies Record<string, UsImportDutyUnavailableReason>;

// ---------------------------------------------------------------------------
// Seeded index shapes (written by scripts/shared/us-hts-chapter99.mjs)
// ---------------------------------------------------------------------------

export interface UsDutyMeasure {
  id: string;
  kind: 'duty' | 'exemption' | 'condition';
  heading: string;
  authority?: string;
  program?: string;
  partners: string[] | null;
  scope?: 'LISTED_PRODUCTS' | 'ALL_PRODUCTS';
  rateText?: string;
  addPct?: number | null;
  topUpTo?: number | null;
  mfnBand?: { below: boolean; pct: number } | null;
  effectiveFrom?: string;
  state?: 'IN_FORCE' | 'SCHEDULED';
  appliesTo?: string;
  chapters?: [number, number] | null;
  overlaps?: string;
  note: string;
  condition: string;
}

export interface UsDutyCatalog {
  schema: number;
  release: string;
  chapters: string[];
  measures: Record<string, UsDutyMeasure>;
}

/** Coverage shard: provision -> [measureId, role ('a' apply | 'x' exempt), partial?]. */
export type UsCoverageShard = Record<string, Array<[string, string, number?]>>;

export function usHtsCoverageKey(release: string, chapter: string): string {
  return `${US_HTS_COVERAGE_PREFIX}:${release}:${chapter}`;
}

// ---------------------------------------------------------------------------
// HTS lines
// ---------------------------------------------------------------------------

export interface HtsRow {
  htsno?: string;
  indent?: string | number;
  description?: string;
  general?: string | null;
  special?: string | null;
  other?: string | null;
}

export interface HtsLine {
  htsCode: string;
  description: string;
  general: string;
  special: string;
  other: string;
}

const LINE = /^(\d{4}\.\d{2}\.\d{2})(?:\.\d{2})?$/;

/** "870323" -> "8703.23"; "8703230140" -> "8703.23.01.40". */
export function dottedHts(code: string): string {
  const parts = [code.slice(0, 4), code.slice(4, 6), code.slice(6, 8), code.slice(8, 10)].filter(Boolean);
  return parts.join('.');
}

/**
 * exportList range for a code: everything from the code to its last possible
 * statistical number. A statistical number reads its whole 8-digit line,
 * because the rate sits on the line.
 */
export function exportListRange(code: string): { from: string; to: string } {
  const dotted = dottedHts(code.slice(0, 8));
  return { from: dotted, to: code.length === 6 ? `${dotted}.99.99` : `${dotted}.99` };
}

function clean(text: unknown): string {
  return String(text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 8-digit lines under `code`. Rates sit on the 8-digit row, or on its only
 * statistical row when the line has one ("7208.10.15.00"); a row with empty
 * cells inherits from the nearest shallower row that has them.
 */
export function parseHtsLines(rows: unknown, code: string): HtsLine[] {
  if (!Array.isArray(rows)) return [];
  const prefix = dottedHts(code.slice(0, 8));
  const inherited: Array<{ general: string; special: string; other: string } | undefined> = [];
  const lines: HtsLine[] = [];
  const seen = new Set<string>();
  for (const raw of rows as HtsRow[]) {
    const indent = Number(raw?.indent ?? 0) || 0;
    const general = clean(raw?.general);
    const special = clean(raw?.special);
    const other = clean(raw?.other);
    inherited.length = indent + 1;
    if (general || other) inherited[indent] = { general, special, other };
    const m = LINE.exec(String(raw?.htsno ?? '').trim());
    if (!m || !m[1]!.startsWith(prefix) || seen.has(m[1]!)) continue;
    const rates = (general || other) ? { general, special, other } : inherited.slice(0, indent).reverse().find(Boolean);
    if (!rates) continue;
    seen.add(m[1]!);
    lines.push({ htsCode: m[1]!, description: clean(raw?.description), ...rates });
  }
  return lines;
}

async function fetchHtsLines(code: string): Promise<{ rows: HtsRow[] } | null> {
  const { from, to } = exportListRange(code);
  const url = `${HTS_REST_BASE}/exportList?from=${from}&to=${to}&format=JSON&styles=false`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(LINES_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[hts] exportList HTTP ${res.status}`);
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) ? { rows } : null;
  } catch (error) {
    console.warn(`[hts] exportList fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Ad valorem percent of a rate cell, or null for specific/compound rates. */
export function parseAdValorem(rate: string): number | null {
  const r = rate.trim();
  if (/^free\b/i.test(r)) return 0;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(r);
  return m ? Number(m[1]) : null;
}

/** "Free (A+,AU,...) 3.6% (KR)" -> [{ rate: 'Free', programs: [...] }, { rate: '3.6%', programs: ['KR'] }]. */
export function parseSpecialRates(special: string): Array<{ rate: string; programs: string[] }> {
  const out: Array<{ rate: string; programs: string[] }> = [];
  for (const m of special.matchAll(/([^()]+?)\s*\(([^)]*)\)/g)) {
    const rate = m[1]!.replace(/^[\s,;]+/, '').trim();
    const programs = m[2]!.split(',').map((p) => p.trim()).filter(Boolean);
    if (rate && programs.length) out.push({ rate, programs });
  }
  return out;
}

interface BaseRate {
  basis: UsDutyBasis;
  text: string;
  adValorem: number | null;
  program: string;
  unresolved: string[];
}

export function resolveBaseRate(line: HtsLine, partner: string): BaseRate {
  const groups = parseSpecialRates(line.special);
  const unresolved = [...new Set(groups.flatMap((g) => g.programs).filter((p) => UNRESOLVED_PROGRAMS.has(p)))];
  if (COLUMN_2_PARTNERS.has(partner)) {
    return { basis: BASIS.column2, text: line.other, adValorem: parseAdValorem(line.other), program: '', unresolved: [] };
  }
  const mine = new Set(PARTNER_PROGRAMS[partner] ?? []);
  let best: { rate: string; program: string; av: number | null } | null = null;
  for (const g of groups) {
    const program = g.programs.find((p) => mine.has(p) && !LAPSED_PROGRAMS.has(p));
    if (!program) continue;
    const av = parseAdValorem(g.rate);
    if (!best || (av !== null && (best.av === null || av < best.av))) best = { rate: g.rate, program, av };
  }
  const mfnAv = parseAdValorem(line.general);
  if (best && !(best.av !== null && mfnAv !== null && best.av >= mfnAv)) {
    return { basis: BASIS.preferential, text: best.rate, adValorem: best.av, program: best.program, unresolved };
  }
  return { basis: BASIS.mfn, text: line.general, adValorem: mfnAv, program: '', unresolved };
}

// ---------------------------------------------------------------------------
// Chapter 99 duties
// ---------------------------------------------------------------------------

interface CoverageHit { id: string; role: string; partial: boolean }

/**
 * Coverage entries touching an 8-digit line: entries for the line itself or
 * a parent heading/subheading cover all of it; entries for statistical
 * numbers under it cover part of it.
 */
export function coverageFor(shard: UsCoverageShard | null, htsCode: string): CoverageHit[] {
  if (!shard) return [];
  const hits: CoverageHit[] = [];
  for (const [code, entries] of Object.entries(shard)) {
    const parent = htsCode.startsWith(code);
    const child = !parent && code.startsWith(htsCode);
    if (!parent && !child) continue;
    for (const [id, role, partial] of entries) hits.push({ id, role, partial: child || partial === 1 });
  }
  return hits;
}

const covers = (m: UsDutyMeasure, partner: string) => !m.partners || m.partners.includes(partner);

function dutyFrom(m: UsDutyMeasure, status: UsAdditionalDutyStatus, condition: string): UsAdditionalDuty {
  return {
    heading: m.heading,
    authority: AUTHORITY[m.authority ?? ''] ?? 'US_DUTY_AUTHORITY_UNSPECIFIED',
    program: m.program ?? '',
    addedRate: typeof m.addPct === 'number' ? m.addPct : 0,
    topUpTo: typeof m.topUpTo === 'number' ? m.topUpTo : 0,
    status,
    condition,
    legalNote: m.note,
    effectiveFrom: m.effectiveFrom ?? '',
  };
}

/** Chapter 99 duties on one line for one partner, given its applied base rate. */
export function resolveAdditionalDuties(
  catalog: UsDutyCatalog,
  shard: UsCoverageShard | null,
  htsCode: string,
  partner: string,
  baseAdValorem: number | null,
): UsAdditionalDuty[] {
  const measures = catalog.measures;
  const hits = coverageFor(shard, htsCode);
  const chapter = Number(htsCode.slice(0, 2));

  // Candidate duties: listed ones that touch the line, plus every
  // country-wide one for this partner.
  const candidates = new Map<string, { m: UsDutyMeasure; partial: boolean }>();
  for (const h of hits) {
    const m = measures[h.id];
    if (!m || m.kind !== 'duty' || h.role !== 'a' || !covers(m, partner)) continue;
    const prev = candidates.get(m.id);
    candidates.set(m.id, { m, partial: prev ? prev.partial && h.partial : h.partial });
  }
  for (const m of Object.values(measures)) {
    if (m.kind === 'duty' && m.scope === 'ALL_PRODUCTS' && covers(m, partner)) candidates.set(m.id, { m, partial: false });
  }
  const has232 = [...candidates.values()].some(({ m }) => m.authority === 'SECTION_232');

  const duties: UsAdditionalDuty[] = [];
  for (const { m, partial } of candidates.values()) {
    // Paired headings split on the column 1 rate: keep the half that matches.
    if (m.mfnBand) {
      if (baseAdValorem === null) {
        if (!m.mfnBand.below) continue;
        duties.push(dutyFrom(m, STATUS.conditional, `Depends on the ad valorem equivalent of the column 1 rate (${m.note.replace(/\(.*$/, '')}(k)).`));
        continue;
      }
      if (m.mfnBand.below !== baseAdValorem < m.mfnBand.pct) continue;
    }
    if (m.state === 'SCHEDULED') {
      duties.push(dutyFrom(m, STATUS.scheduled, ''));
      continue;
    }
    let status: UsAdditionalDutyStatus = STATUS.applies;
    let condition = m.condition || '';
    if (partial) {
      status = STATUS.conditional;
      condition = `Covers only particular articles under this line (${m.note}).`;
    } else if (m.condition) {
      status = STATUS.conditional;
    }

    // Exemptions listed for this provision. One that covers the whole
    // provision unconditionally lifts the duty; one limited to particular
    // articles or to an end use leaves it applying, with the exemption named.
    const narrower: string[] = [];
    for (const h of hits) {
      const x = measures[h.id];
      if (!x || x.kind !== 'exemption' || h.role !== 'x' || !x.appliesTo || !m.id.startsWith(x.appliesTo)) continue;
      if (!covers(x, partner)) continue;
      if (!h.partial && !x.condition) {
        status = STATUS.exempt;
        condition = `Exempt under ${x.heading} (${x.note}).`;
        break;
      }
      narrower.push(h.partial
        ? `Particular articles are exempt under ${x.heading} (${x.note}).`
        : `Exempt under ${x.heading} (${x.note}): ${x.condition}`);
    }
    if (status !== STATUS.exempt && narrower.length) condition = [condition, ...narrower].filter(Boolean).join(' ');

    // Exemptions that turn on the entry or on another duty.
    if (status !== STATUS.exempt && status !== STATUS.conditional) {
      for (const c of Object.values(measures)) {
        if (c.kind !== 'condition' || !c.appliesTo || !m.id.startsWith(c.appliesTo) || !covers(c, partner)) continue;
        if (c.chapters && (chapter < c.chapters[0] || chapter > c.chapters[1])) continue;
        if (c.overlaps === 'SECTION_232' && !has232) continue;
        status = STATUS.conditional;
        condition = [`${c.condition.replace(/\.$/, '')} (${c.heading}, ${c.note}).`, ...narrower].join(' ');
        break;
      }
    }
    duties.push(dutyFrom(m, status, condition));
  }
  duties.sort((a, b) => a.heading.localeCompare(b.heading));
  return duties;
}

/** Base plus APPLIES duties; top-ups raise the running total to their floor. */
export function estimateRate(base: number | null, duties: UsAdditionalDuty[]): { rate: number; complete: boolean } {
  let complete = base !== null;
  let added = 0;
  let floor = 0;
  for (const d of duties) {
    if (d.status === STATUS.applies) {
      added += d.addedRate;
      if (d.topUpTo > 0) floor = Math.max(floor, d.topUpTo);
    } else if (d.status === STATUS.conditional || d.status === STATUS.scheduled) {
      complete = false;
    }
  }
  const b = base ?? 0;
  const rate = Math.max(b, floor) + added;
  return { rate: Math.round(rate * 1000) / 1000, complete };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function sourceUrl(code: string): string {
  return code ? `https://hts.usitc.gov/search?query=${dottedHts(code)}` : '';
}

function emptyResponse(
  hsCode: string,
  partnerCountry: string,
  reason: UsImportDutyUnavailableReason,
  upstreamUnavailable: boolean,
): GetUsImportDutyResponse {
  return {
    hsCode,
    partnerCountry,
    htsRelease: '',
    lines: [],
    additionalDutiesLoaded: false,
    source: US_IMPORT_DUTY_SOURCE,
    sourceUrl: HS.test(hsCode) ? sourceUrl(hsCode) : '',
    upstreamUnavailable,
    unavailableReason: reason,
  };
}

function isCatalog(value: unknown): value is UsDutyCatalog {
  const v = value as UsDutyCatalog | null;
  return !!v && typeof v.release === 'string' && !!v.release && Array.isArray(v.chapters)
    && !!v.measures && typeof v.measures === 'object';
}

async function readCatalogAndShard(chapter: string): Promise<{ catalog: UsDutyCatalog | null; shard: UsCoverageShard | null }> {
  try {
    const catalog = await getCachedJson(US_HTS_CATALOG_KEY, true);
    if (!isCatalog(catalog)) return { catalog: null, shard: null };
    // No shard for a chapter means no listed provision in it, not a fault.
    if (!catalog.chapters.includes(chapter)) return { catalog, shard: {} };
    const shard = await getCachedJson(usHtsCoverageKey(catalog.release, chapter), true);
    if (!shard || typeof shard !== 'object') return { catalog: null, shard: null };
    return { catalog, shard: shard as UsCoverageShard };
  } catch (error) {
    console.warn(`[hts] index read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { catalog: null, shard: null };
  }
}

export async function getUsImportDuty(
  ctx: ServerContext,
  req: GetUsImportDutyRequest,
): Promise<GetUsImportDutyResponse> {
  const hsCode = (req.hsCode ?? '').trim();
  const partner = (req.partnerCountry ?? '').trim();

  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return emptyResponse(hsCode, partner, REASON.served, true);
  if (!HS.test(hsCode) || !CODE3.test(partner)) return emptyResponse(hsCode, partner, REASON.invalidRequest, false);

  const chapter = hsCode.slice(0, 2);
  const [index, fetched] = await Promise.all([
    readCatalogAndShard(chapter),
    (async () => {
      try {
        return await cachedFetchJson(
          `${US_HTS_LINES_KEY_PREFIX}:${hsCode.length > 6 ? hsCode.slice(0, 8) : hsCode}`,
          LINES_TTL_SECONDS,
          () => fetchHtsLines(hsCode),
          FAULT_TTL_SECONDS,
        );
      } catch (error) {
        console.warn(`[hts] lines read failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    })(),
  ]);
  if (!fetched) return emptyResponse(hsCode, partner, REASON.upstreamUnavailable, true);

  const htsLines = parseHtsLines(fetched.rows, hsCode);
  if (htsLines.length === 0) return emptyResponse(hsCode, partner, REASON.notCovered, false);

  const { catalog, shard } = index;
  const lines: UsTariffLine[] = htsLines.map((line) => {
    const base = resolveBaseRate(line, partner);
    const duties = catalog ? resolveAdditionalDuties(catalog, shard, line.htsCode, partner, base.adValorem) : [];
    const estimate = estimateRate(base.adValorem, duties);
    return {
      htsCode: line.htsCode,
      description: line.description,
      generalRate: line.general,
      specialRate: line.special,
      column2Rate: line.other,
      basis: base.basis,
      baseRate: base.text,
      baseAdValorem: base.adValorem ?? 0,
      baseNonAdValorem: base.adValorem === null,
      preferenceProgram: base.program,
      unresolvedPrograms: base.unresolved,
      additionalDuties: duties,
      estimatedRate: estimate.rate,
      estimateComplete: estimate.complete && !!catalog,
    };
  });

  return {
    hsCode,
    partnerCountry: partner,
    htsRelease: catalog?.release ?? '',
    lines,
    additionalDutiesLoaded: !!catalog,
    source: US_IMPORT_DUTY_SOURCE,
    sourceUrl: sourceUrl(hsCode),
    upstreamUnavailable: false,
    unavailableReason: REASON.served,
  };
}
