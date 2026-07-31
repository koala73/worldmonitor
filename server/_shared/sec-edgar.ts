// Shared SEC EDGAR helpers for the corporate-intelligence endpoints (issue #5695).
//
// Attribution model: company identity always resolves through the SEC's own
// ticker/name registry (company_tickers.json, seeded to Redis) to a CIK, and all
// filing data is fetched per-CIK from data.sec.gov. No domain-slug or keyword
// guessing (the unsound heuristics removed in issues #3754/#3755).

// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../api/_sentry-edge.js';
import { sha256Hex } from './hash';
import { cachedFetchJson, getCachedJson } from './redis';
import { unwrapEnvelope } from './seed-envelope';

// SEC requires a declared User-Agent identifying the requester and rejects
// browser-spoofing UAs on data.sec.gov/efts.sec.gov. Matches the precedent in
// scripts/seed-regulatory-actions.mjs.
export const SEC_USER_AGENT = 'WorldMonitor/2.0 (monitor@worldmonitor.app)';

// Seeded by scripts/seed-sec-cik-map.mjs (slim {TICKER: {cik, name}} map).
export const SEC_CIK_MAP_KEY = 'intelligence:sec-cik-map:v1';
// Seeded by scripts/seed-sec-8k-stream.mjs ({events, fetchedAt}).
export const SEC_8K_STREAM_KEY = 'intelligence:sec-8k-stream:v1';

const SUBMISSIONS_TTL = 21_600; // 6h — recent-filings freshness vs. SEC load
const SEARCH_TTL = 900;
const NEGATIVE_TTL = 300;
const SEARCH_NEGATIVE_TTL = 120;
export const EDGAR_UPSTREAM_TIMEOUT_MS = 10_000;
const CIK_MAP_MEMO_MS = 60 * 60 * 1_000;
// The source-health contract for the daily registry. Redis TTL is deliberately
// longer (72h) for operational recovery, but request-time identity resolution
// must not treat that buffer as authoritative freshness.
export const SEC_CIK_MAP_MAX_STALE_MIN = 2880;
const CIK_MAP_SOURCE_MAX_STALE_MS = SEC_CIK_MAP_MAX_STALE_MIN * 60_000;
// Last-good serve after a failed refresh is capped so warm isolates cannot
// resolve against a ghost registry forever while cold isolates report unavailable.
const CIK_MAP_STALE_MAX_MS = 6 * 60 * 60 * 1_000;
const CIK_MAP_READ_TIMEOUT_MS = 6_000;
const CIK_MAP_RETRY_BACKOFF_MS = 30_000;
const MAX_SLIM_FILINGS = 200;
const EDGAR_SEARCH_SIZE = 25;

// Forms worth keeping from a filer's recent-submissions window. A high-volume
// filer's newest 200 filings are mostly ownership forms (Apple's most recent
// page is nearly all Form 4), so keeping the first 200 chronologically can
// push every 10-K/10-Q/8-K out of the slice entirely. Filter first, then cap.
const RELEVANT_FORM_PREFIXES = ['10-K', '10-Q', '8-K', '20-F', '6-K', 'S-1', 'DEF 14A', '40-F'];

export function isRelevantForm(form: string): boolean {
  return RELEVANT_FORM_PREFIXES.some(prefix => form === prefix || form.startsWith(`${prefix}/`));
}

// 8-K item taxonomy (17 CFR 249.308). `high`/`medium` items are genuine
// intelligence signals; `routine` items (earnings boilerplate exhibits, Reg FD)
// are surfaced in filing lists but excluded from the material-events stream.
// The seeder keeps its own small material-code set — tests assert it matches
// the high+medium codes here.
export const MATERIAL_8K_ITEMS: Record<string, { description: string; materiality: 'high' | 'medium' | 'routine' }> = {
  '1.01': { description: 'Entry into a Material Definitive Agreement', materiality: 'high' },
  '1.02': { description: 'Termination of a Material Definitive Agreement', materiality: 'high' },
  '1.03': { description: 'Bankruptcy or Receivership', materiality: 'high' },
  '1.04': { description: 'Mine Safety — Reporting of Shutdowns and Patterns of Violations', materiality: 'medium' },
  '1.05': { description: 'Material Cybersecurity Incidents', materiality: 'high' },
  '2.01': { description: 'Completion of Acquisition or Disposition of Assets', materiality: 'high' },
  '2.02': { description: 'Results of Operations and Financial Condition', materiality: 'medium' },
  '2.03': { description: 'Creation of a Direct Financial Obligation', materiality: 'medium' },
  '2.04': { description: 'Triggering Events That Accelerate or Increase a Direct Financial Obligation', materiality: 'high' },
  '2.05': { description: 'Costs Associated with Exit or Disposal Activities', materiality: 'medium' },
  '2.06': { description: 'Material Impairments', materiality: 'high' },
  '3.01': { description: 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule', materiality: 'high' },
  '3.02': { description: 'Unregistered Sales of Equity Securities', materiality: 'medium' },
  '3.03': { description: 'Material Modification to Rights of Security Holders', materiality: 'medium' },
  '4.01': { description: 'Changes in Registrant’s Certifying Accountant', materiality: 'high' },
  '4.02': { description: 'Non-Reliance on Previously Issued Financial Statements', materiality: 'high' },
  '5.01': { description: 'Changes in Control of Registrant', materiality: 'high' },
  '5.02': { description: 'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers', materiality: 'high' },
  '5.03': { description: 'Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year', materiality: 'medium' },
  '5.05': { description: 'Amendments to the Registrant’s Code of Ethics', materiality: 'medium' },
  '5.07': { description: 'Submission of Matters to a Vote of Security Holders', materiality: 'routine' },
  '5.08': { description: 'Shareholder Director Nominations', materiality: 'medium' },
  '6.01': { description: 'ABS Informational and Computational Material', materiality: 'routine' },
  '7.01': { description: 'Regulation FD Disclosure', materiality: 'routine' },
  '8.01': { description: 'Other Events', materiality: 'routine' },
  '9.01': { description: 'Financial Statements and Exhibits', materiality: 'routine' },
};

export function materialItemCodes(): string[] {
  return Object.entries(MATERIAL_8K_ITEMS)
    .filter(([, v]) => v.materiality !== 'routine')
    .map(([code]) => code);
}

export function describeItemCodes(codes: string[]): string {
  return codes.map(code => MATERIAL_8K_ITEMS[code]?.description ?? `Item ${code}`).join('; ');
}

export interface CikMapEntry {
  cik: number;
  name: string;
}

export type CikMap = Record<string, CikMapEntry>;

export interface ResolvedCompany {
  cik: string; // zero-padded 10 digits
  ticker: string;
  name: string;
  // Which input produced the match. Both are authoritative: a ticker is an
  // exact registry key, and a name resolves only when it identifies exactly one
  // filer. There is deliberately no low-precision variant — see resolveCompany.
  matchedBy: 'ticker' | 'name';
}

/**
 * Resolution outcome. "Could not read the registry" and "no such company" are
 * different answers and must not share a representation: the first is an
 * infrastructure failure that callers surface as `unavailable` (and the gateway
 * refuses to cache), the second is a real, cacheable answer about the company.
 *
 * Returned by value rather than read from module state, because a serverless
 * instance serves concurrent requests and a shared status flag would let one
 * request's outcome overwrite another's.
 */
export type CompanyResolution =
  | { status: 'ok'; company: ResolvedCompany }
  | { status: 'not_found' }
  | { status: 'registry_unavailable' };

export interface SlimSecFiling {
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
  items: string[];
  acceptanceDateTime: string;
}

export interface SecCompanyProfile {
  name: string;
  sicDescription: string;
  website: string;
  tickers: string[];
  exchanges: string[];
  stateOfIncorporation: string;
  city: string;
  stateOrCountry: string;
  totalRecentFilings: number;
  filings: SlimSecFiling[];
  /** When data.sec.gov actually returned this cached profile. */
  fetchedAtMs: number;
}

export interface EdgarSearchHit {
  company: string;
  cik: string;
  form: string;
  fileDate: string;
  items: string[];
  url: string;
  accession: string;
}

export function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, '').padStart(10, '0');
}

export function sanitizeTicker(raw: string): string {
  const t = (raw ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : '';
}

// Filing index page on sec.gov, e.g.
// https://www.sec.gov/Archives/edgar/data/320193/000032019326000012/0000320193-26-000012-index.htm
export function filingIndexUrl(cik: number | string, accession: string): string {
  const cikNum = String(Number(String(cik).replace(/\D/g, '') || '0'));
  const clean = accession.replace(/[^0-9-]/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${clean.replace(/-/g, '')}/${clean}-index.htm`;
}

// Direct document URL inside a filing, used for full-text search hits whose _id
// is "<accession>:<filename>". EDGAR filenames may carry one XSL subdirectory
// (e.g. "xslF345X06/form4.xml"), so slashes are legitimate — but dot-segments
// are not: they would let an upstream-supplied name walk out of the filing
// directory and emit a sec.gov URL pointing at unrelated content. Returns ''
// when nothing safe survives so callers fall back to filingIndexUrl.
export function filingDocumentUrl(cik: number | string, accession: string, filename: string): string {
  const cikNum = String(Number(String(cik).replace(/\D/g, '') || '0'));
  const accessionDigits = accession.replace(/[^0-9]/g, '');
  const safeName = filename
    .split('/')
    .map(segment => segment.replace(/[^A-Za-z0-9._-]/g, ''))
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .join('/');
  if (!accessionDigits || !safeName) return '';
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionDigits}/${safeName}`;
}

// Submissions `items` come as a comma-separated string like "2.02,9.01".
export function parseItemCodes(items: string | undefined): string[] {
  if (!items) return [];
  return items
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d+\.\d{2}$/.test(s));
}

// --- ticker/name → CIK resolution against the seeded SEC registry ------------

let cikMapMemo: { map: CikMap; loadedAt: number; sourceFetchedAt: number } | null = null;
// Single-flight: concurrent cold requests share one 650KB read instead of each
// issuing their own (the shared cachedFetchJson helper coalesces; this
// purpose-built reader has to do it itself).
let cikMapInFlight: Promise<CikMap | null> | null = null;
// After a failed read, stop re-attempting for a beat. Without this every
// request during a registry outage burns the full read timeout, and those
// seconds come out of the same budget as the SEC and Finnhub legs.
let cikMapRetryAfter = 0;

export function __resetCikMapMemoForTests(): void {
  cikMapMemo = null;
  cikMapInFlight = null;
  cikMapRetryAfter = 0;
}

export function __setCikMapMemoForTests(
  map: CikMap,
  loadedAt: number,
  sourceFetchedAt = loadedAt,
): void {
  cikMapMemo = { map, loadedAt, sourceFetchedAt };
}

/**
 * Reads the ticker registry with a longer deadline than the shared 1.5s Redis
 * op timeout. That budget protects per-request hot paths; this ~650KB value is
 * measured at ~0.8-1.6s and is loaded at most once per instance per hour
 * (see the memo below), so reading it through the shared helper would fail
 * most cold starts and report a healthy registry as unavailable.
 */
async function readCikRegistry(): Promise<{ data: unknown; sourceFetchedAt: number } | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  // No Upstash configured (local/dev or the sidecar runtime): fall back to the
  // shared reader, which knows about those modes.
  if (!url || !token) {
    const data = await getCachedJson(SEC_CIK_MAP_KEY, true);
    return data == null ? null : { data, sourceFetchedAt: Date.now() };
  }
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(SEC_CIK_MAP_KEY)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': SEC_USER_AGENT,
      },
      signal: AbortSignal.timeout(CIK_MAP_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string | null };
    if (typeof data.result !== 'string' || !data.result) return null;
    const unwrapped = unwrapEnvelope(JSON.parse(data.result));
    const sourceFetchedAt = unwrapped._seed?.fetchedAt ?? 0;
    if (!Number.isFinite(sourceFetchedAt)
      || sourceFetchedAt <= 0
      || Date.now() - sourceFetchedAt >= CIK_MAP_SOURCE_MAX_STALE_MS) {
      console.warn('[sec-edgar] CIK registry source snapshot is missing freshness or stale');
      return null;
    }
    return { data: unwrapped.data, sourceFetchedAt };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) console.error(`[REDIS-TIMEOUT] readCikRegistry key=${SEC_CIK_MAP_KEY} timeoutMs=${CIK_MAP_READ_TIMEOUT_MS}`);
    else console.warn('[sec-edgar] CIK registry read failed:', err instanceof Error ? err.message : String(err));
    // A failure here degrades every company lookup to "unavailable", so it must
    // reach Sentry rather than only the function log.
    captureSilentError(err, {
      tags: { surface: 'server', component: 'sec-edgar', stage: isTimeout ? 'cik-registry-timeout' : 'cik-registry-read' },
      fingerprint: ['sec-edgar', 'cik-registry-read', isTimeout ? 'timeout' : 'error'],
      level: 'warning',
    });
    return null;
  }
}

function serveStaleMemo(now: number): CikMap | null {
  if (!cikMapMemo) return null;
  if (now - cikMapMemo.loadedAt >= CIK_MAP_STALE_MAX_MS
    || now - cikMapMemo.sourceFetchedAt >= CIK_MAP_SOURCE_MAX_STALE_MS) {
    cikMapMemo = null;
    return null;
  }
  return cikMapMemo.map;
}

async function loadCikMap(): Promise<CikMap | null> {
  const now = Date.now();
  if (cikMapMemo && now - cikMapMemo.sourceFetchedAt >= CIK_MAP_SOURCE_MAX_STALE_MS) {
    cikMapMemo = null;
  }
  if (cikMapMemo && now - cikMapMemo.loadedAt < CIK_MAP_MEMO_MS) return cikMapMemo.map;
  // During backoff after a failed refresh, keep serving last-good only while it
  // is younger than CIK_MAP_STALE_MAX_MS. Past that, all isolates converge on
  // registry_unavailable instead of warm/cold split-brain.
  if (now < cikMapRetryAfter) return serveStaleMemo(now);
  if (cikMapInFlight) return cikMapInFlight;

  cikMapInFlight = (async () => {
    const snapshot = await readCikRegistry();
    const raw = snapshot?.data;
    const map = raw && typeof raw === 'object'
      ? ((raw as { tickers?: CikMap }).tickers ?? null)
      : null;
    if (!snapshot || !map || typeof map !== 'object') {
      cikMapRetryAfter = Date.now() + CIK_MAP_RETRY_BACKOFF_MS;
      return serveStaleMemo(Date.now());
    }
    cikMapMemo = { map, loadedAt: Date.now(), sourceFetchedAt: snapshot.sourceFetchedAt };
    cikMapRetryAfter = 0;
    return map;
  })().finally(() => { cikMapInFlight = null; });

  return cikMapInFlight;
}

/**
 * Resolve a company reference to its SEC CIK via the seeded registry.
 * - ticker: exact match (authoritative).
 * - name: case-insensitive exact SEC title only, and only when that title maps
 *   to a single CIK. Unique *prefix* matching was removed: a short unique
 *   prefix (e.g. "delta") is still a guess, and uniqueness is not ownership
 *   (docs/solutions unique-match-is-not-identity). Prefer ticker when known.
 *
 * There is deliberately NO domain path. Matching a domain label against filer
 * names is a guess, and confirming that guess needs a domain the authority
 * publishes about the filer — but SEC submissions leave `website` empty in
 * practice (0 of 15 sampled filers populate it, Apple and NVIDIA included), so
 * no confirmation is available. Rather than ship an unconfirmable guess or a
 * guard that always refuses, the lookup key is not offered at all.
 */
export async function resolveCompany(query: { ticker?: string; name?: string }): Promise<CompanyResolution> {
  const map = await loadCikMap();
  if (!map) return { status: 'registry_unavailable' };

  const ticker = sanitizeTicker(query.ticker ?? '');
  if (ticker) {
    const entry = map[ticker];
    return entry
      ? { status: 'ok', company: { cik: padCik(entry.cik), ticker, name: entry.name, matchedBy: 'ticker' } }
      : { status: 'not_found' };
  }

  const name = (query.name ?? '').trim().toLowerCase();
  if (name) {
    const company = matchByName(map, name);
    return company ? { status: 'ok', company } : { status: 'not_found' };
  }

  return { status: 'not_found' };
}

export const __testing__ = {
  matchByName,
  serveStaleMemo,
  CIK_MAP_STALE_MAX_MS,
  CIK_MAP_MEMO_MS,
  CIK_MAP_SOURCE_MAX_STALE_MS,
};

/**
 * Exact title match only. If two distinct CIKs share the same lowercased legal
 * title, refuse rather than returning the first Object.entries hit.
 */
function matchByName(map: CikMap, needle: string): ResolvedCompany | null {
  let exactHit: ResolvedCompany | null = null;
  for (const [ticker, entry] of Object.entries(map)) {
    if (entry.name.toLowerCase() !== needle) continue;
    const cik = padCik(entry.cik);
    if (exactHit && exactHit.cik !== cik) return null;
    exactHit ??= { cik, ticker, name: entry.name, matchedBy: 'name' };
  }
  return exactHit;
}

// --- per-CIK submissions (profile + recent filings) --------------------------

interface RawSubmissions {
  name?: string;
  sicDescription?: string;
  website?: string;
  tickers?: string[];
  exchanges?: string[];
  stateOfIncorporationDescription?: string;
  addresses?: { business?: { city?: string; stateOrCountryDescription?: string } };
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      items?: string[];
      acceptanceDateTime?: string[];
    };
  };
}

export async function fetchSecSubmissions(cik10: string): Promise<SecCompanyProfile | null> {
  if (!/^\d{10}$/.test(cik10)) return null;
  try {
    return await cachedFetchJson<SecCompanyProfile>(
      // v3 adds fetchedAtMs; older payloads cannot truthfully report freshness.
      `intel:company:sec-submissions:v3:${cik10}`,
      SUBMISSIONS_TTL,
      async () => {
        try {
          const resp = await fetch(`https://data.sec.gov/submissions/CIK${cik10}.json`, {
            headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(EDGAR_UPSTREAM_TIMEOUT_MS),
          });
          if (!resp.ok) return null;
          const raw = (await resp.json()) as RawSubmissions;
          const recent = raw.filings?.recent;
          const total = recent?.form?.length ?? 0;
          const filings: SlimSecFiling[] = [];
          for (let i = 0; i < total && filings.length < MAX_SLIM_FILINGS; i++) {
            if (!isRelevantForm(recent?.form?.[i] ?? '')) continue;
            filings.push({
              form: recent?.form?.[i] ?? '',
              filingDate: recent?.filingDate?.[i] ?? '',
              accessionNumber: recent?.accessionNumber?.[i] ?? '',
              primaryDocument: recent?.primaryDocument?.[i] ?? '',
              items: parseItemCodes(recent?.items?.[i]),
              acceptanceDateTime: recent?.acceptanceDateTime?.[i] ?? '',
            });
          }
          return {
            name: raw.name ?? '',
            sicDescription: raw.sicDescription ?? '',
            website: raw.website ?? '',
            tickers: Array.isArray(raw.tickers) ? raw.tickers.slice(0, 8) : [],
            exchanges: Array.isArray(raw.exchanges) ? raw.exchanges.slice(0, 8) : [],
            stateOfIncorporation: raw.stateOfIncorporationDescription ?? '',
            city: raw.addresses?.business?.city ?? '',
            stateOrCountry: raw.addresses?.business?.stateOrCountryDescription ?? '',
            totalRecentFilings: total,
            filings,
            fetchedAtMs: Date.now(),
          };
        } catch {
          return null;
        }
      },
      NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}

// --- EDGAR full-text search ---------------------------------------------------

interface EftsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    display_names?: string[];
    form?: string;
    file_date?: string;
    items?: string[];
    adsh?: string;
  };
}

interface EftsResponse {
  hits?: { total?: { value?: number }; hits?: EftsHit[] };
}

export interface EdgarSearchResult {
  total: number;
  results: EdgarSearchHit[];
  // When EDGAR was actually queried. Persisted inside the cached value so a
  // cache hit reports real upstream freshness instead of the current time.
  fetchedAtMs: number;
}

// Exported so handlers reject malformed filters up front instead of silently
// dropping them (a dropped filter widens the result set).
// Requires at least one alphanumeric form token so "," / spaces-only cannot
// pass the regex then normalize to an empty (unfiltered) query.
const EDGAR_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EDGAR_FORMS_RE = /^(?=[A-Za-z0-9/, .\-]{1,40}$)(?=.*[A-Za-z0-9])[A-Za-z0-9/, .\-]+$/;

/** Shape plus calendar validity; Date.parse alone would normalize invalid days. */
export function isEdgarIsoDate(value: string): boolean {
  if (!EDGAR_ISO_DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** Normalize a forms filter; returns null when the input is present but empty after parse. */
export function normalizeEdgarForms(raw: string | undefined): string | null | '' {
  if (raw == null || raw === '') return '';
  if (!EDGAR_FORMS_RE.test(raw)) return null;
  const forms = raw.split(',').map(f => f.trim().toUpperCase()).filter(Boolean).join(',');
  // Non-empty input that normalizes to zero tokens would silently widen the search.
  if (!forms) return null;
  return forms;
}

export async function searchEdgarFullText(params: {
  query: string;
  forms?: string;
  startDate?: string;
  endDate?: string;
  /** Upstream page size (1–25). Defaults to EDGAR_SEARCH_SIZE. */
  size?: number;
}): Promise<EdgarSearchResult | null> {
  const query = params.query.trim().slice(0, 160);
  if (!query) return null;
  const formsNormalized = normalizeEdgarForms(params.forms);
  // Caller should have rejected null; treat as unfiltered only when forms omitted.
  const forms = formsNormalized === null ? '' : formsNormalized;
  const startDate = params.startDate && isEdgarIsoDate(params.startDate) ? params.startDate : '';
  const endDate = params.endDate && isEdgarIsoDate(params.endDate) ? params.endDate : '';
  const size = Math.max(1, Math.min(params.size ?? EDGAR_SEARCH_SIZE, EDGAR_SEARCH_SIZE));

  const search = new URLSearchParams({ q: `"${query.replace(/"/g, '')}"` });
  search.set('size', String(size));
  if (forms) search.set('forms', forms);
  if (startDate) search.set('startdt', startDate);
  if (endDate) search.set('enddt', endDate);

  // sha256, not a weak string hash: the key derives from user-controlled query
  // params, and a collision would serve one query's cached results for another.
  const cacheKey = `intel:company:edgar-fts:${(await sha256Hex(search.toString())).slice(0, 16)}`;
  try {
    return await cachedFetchJson<EdgarSearchResult>(
      cacheKey,
      SEARCH_TTL,
      async () => {
        try {
          const resp = await fetch(`https://efts.sec.gov/LATEST/search-index?${search.toString()}`, {
            headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(EDGAR_UPSTREAM_TIMEOUT_MS),
          });
          if (!resp.ok) return null;
          const raw = (await resp.json()) as EftsResponse;
          if (!raw.hits) return null;
          const results: EdgarSearchHit[] = (raw.hits.hits ?? []).slice(0, size).map(hit => {
            const src = hit._source ?? {};
            const cikRaw = src.ciks?.[0] ?? '';
            const accession = src.adsh ?? hit._id?.split(':')[0] ?? '';
            const filename = hit._id?.split(':')[1] ?? '';
            return {
              company: src.display_names?.[0] ?? '',
              cik: cikRaw ? padCik(cikRaw) : '',
              form: src.form ?? '',
              fileDate: src.file_date ?? '',
              items: Array.isArray(src.items) ? src.items.filter(i => /^\d+\.\d{2}$/.test(i)) : [],
              url: cikRaw && accession && filename
                ? filingDocumentUrl(cikRaw, accession, filename)
                : (cikRaw && accession ? filingIndexUrl(cikRaw, accession) : ''),
              accession,
            };
          });
          return { total: raw.hits.total?.value ?? results.length, results, fetchedAtMs: Date.now() };
        } catch {
          return null;
        }
      },
      SEARCH_NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}
