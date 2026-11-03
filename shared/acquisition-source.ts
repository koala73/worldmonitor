/**
 * First-touch acquisition source: where a browser first came from (UTM tags,
 * referrer host, landing page family), kept so a later checkout can stamp it
 * onto the payment-provider subscription as `wm_acq_*` metadata. With billing
 * country already on every Dodo subscription, that is enough to read
 * conversion and revenue by channel and country from the payment records
 * alone, without the client-side analytics that drop events.
 *
 * Separate from the other attribution modules on purpose:
 *   - content-attribution.ts tags our own blog/use-case handoffs for Umami;
 *   - mcp-attribution.ts is the allowlisted MCP campaign marker;
 *   - `ref` / `affonso_referral` are affiliate codes that drive payouts.
 * None of these values are ever copied into those fields.
 *
 * Pure functions plus an injected storage adapter, so the dashboard, /pro, the
 * create-checkout edge handler and Convex can all import it. No imports: it is
 * bundled into the Convex deploy and scanned as a leaf of the /pro bundle.
 */

export const ACQUISITION_COOKIE_NAME = 'wm-acq';
export const ACQUISITION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ACQUISITION_COOKIE_DOMAIN = 'worldmonitor.app';
const MAX_TOKEN_LENGTH = 64;
const DIRECT = 'direct';
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LANDING_FAMILIES = new Set([
  'homepage',
  'dashboard',
  'pricing',
  'documentation',
  'developer_mcp',
  'use-cases',
]);

export interface AcquisitionSource {
  source?: string;
  medium?: string;
  campaign?: string;
  /** Referrer hostname without `www.`, or `direct`. */
  referrer?: string;
  landing?: string;
  /** UTC day of the first visit, YYYY-MM-DD. */
  firstSeen?: string;
}

export interface AcquisitionVisit {
  search: string;
  pathname: string;
  referrer: string;
  now: number;
}

export interface AcquisitionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Lowercase kebab token, bounded; the same shape content-attribution uses. */
function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOKEN_LENGTH)
    .replace(/-+$/, '');
  return token || undefined;
}

/** Page family of the landing path, matching content-attribution's buckets. */
function landingFamily(pathname: string): string | undefined {
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (path === '/') return 'homepage';
  if (under('/dashboard')) return 'dashboard';
  if (under('/pro')) return 'pricing';
  if (under('/mcp') || under('/api')) return 'developer_mcp';
  if (under('/docs')) return 'documentation';
  if (under('/use-cases')) return 'use-cases';
  return undefined;
}

function normalizeReferrer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/^www\./, '');
  return host === DIRECT || HOST_PATTERN.test(host) ? host : undefined;
}

function normalizeDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : undefined;
}

/**
 * Validate an untrusted value into a source record. Unknown keys and malformed
 * values are dropped; returns null when nothing usable remains.
 */
export function normalizeAcquisitionSource(input: unknown): AcquisitionSource | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const landing = typeof raw.landing === 'string' && LANDING_FAMILIES.has(raw.landing) ? raw.landing : undefined;
  const fields: AcquisitionSource = {
    source: normalizeToken(raw.source),
    medium: normalizeToken(raw.medium),
    campaign: normalizeToken(raw.campaign),
    referrer: normalizeReferrer(raw.referrer),
    landing,
    firstSeen: normalizeDay(raw.firstSeen),
  };
  const result: AcquisitionSource = {};
  for (const [key, value] of Object.entries(fields) as [keyof AcquisitionSource, string | undefined][]) {
    if (value) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function referrerHost(referrer: string): string {
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DIRECT;
    return normalizeReferrer(url.hostname) ?? DIRECT;
  } catch {
    return DIRECT;
  }
}

/** Build the source record for the current page view. */
export function parseAcquisitionSource(visit: AcquisitionVisit): AcquisitionSource {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(visit.search.startsWith('?') ? visit.search.slice(1) : visit.search);
  } catch {
    params = new URLSearchParams();
  }
  return normalizeAcquisitionSource({
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
    referrer: referrerHost(visit.referrer),
    landing: landingFamily(visit.pathname),
    firstSeen: new Date(visit.now).toISOString().slice(0, 10),
  }) ?? { referrer: DIRECT };
}

/** Read the stored first-touch record, clearing it when stale or malformed. */
export function loadFirstTouchAcquisition(
  storage: AcquisitionStorage | null | undefined,
  now = Date.now(),
): AcquisitionSource | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACQUISITION_COOKIE_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { capturedAt?: unknown };
    const capturedAt = parsed?.capturedAt;
    const source = normalizeAcquisitionSource(parsed);
    if (!source || typeof capturedAt !== 'number' || now - capturedAt > ACQUISITION_TTL_MS || capturedAt > now + 60_000) {
      storage.removeItem(ACQUISITION_COOKIE_NAME);
      return null;
    }
    return source;
  } catch {
    try { storage.removeItem(ACQUISITION_COOKIE_NAME); } catch { /* storage unavailable */ }
    return null;
  }
}

/**
 * Store this visit as the first touch unless an unexpired one exists. Returns
 * the stored record (new or existing), or null when storage is unavailable; a
 * write is read back so a silently dropped cookie reports null.
 */
export function captureFirstTouchAcquisition(
  storage: AcquisitionStorage | null | undefined,
  visit: AcquisitionVisit,
): AcquisitionSource | null {
  if (!storage) return null;
  const existing = loadFirstTouchAcquisition(storage, visit.now);
  if (existing) return existing;
  const source = parseAcquisitionSource(visit);
  try {
    storage.setItem(ACQUISITION_COOKIE_NAME, JSON.stringify({ ...source, capturedAt: visit.now }));
  } catch {
    return null;
  }
  return loadFirstTouchAcquisition(storage, visit.now);
}

/**
 * Cookie-backed storage holding only the acquisition record. A cookie on the
 * parent domain rather than localStorage, because the first visit and the
 * checkout can happen on different hosts (www vs finance., tech., ...).
 */
export function acquisitionCookieStorage(
  doc: { cookie: string },
  loc: { hostname: string; protocol: string },
): AcquisitionStorage {
  const hostname = typeof loc?.hostname === 'string' ? loc.hostname.toLowerCase() : '';
  const shared = hostname === ACQUISITION_COOKIE_DOMAIN || hostname.endsWith(`.${ACQUISITION_COOKIE_DOMAIN}`);
  const attributes = [
    'path=/',
    shared ? `domain=.${ACQUISITION_COOKIE_DOMAIN}` : null,
    'SameSite=Lax',
    loc?.protocol === 'https:' ? 'Secure' : null,
  ].filter(Boolean).join('; ');
  const write = (key: string, value: string, maxAgeSeconds: number) => {
    if (key !== ACQUISITION_COOKIE_NAME) return;
    try {
      doc.cookie = `${key}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; ${attributes}`;
    } catch { /* cookies blocked: no attribution */ }
  };
  return {
    getItem(key) {
      if (key !== ACQUISITION_COOKIE_NAME) return null;
      try {
        const prefix = `${key}=`;
        const match = String(doc.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        return match ? decodeURIComponent(match.slice(prefix.length)) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      write(key, value, Math.floor(ACQUISITION_TTL_MS / 1000));
    },
    removeItem(key) {
      write(key, '', 0);
    },
  };
}

/**
 * The page's document and location, read through globalThis because Convex
 * also compiles this file and has no DOM types. Null outside a browser.
 */
function browserPage(): {
  doc: { cookie: string; referrer: string };
  loc: { hostname: string; protocol: string; search: string; pathname: string };
} | null {
  const scope = globalThis as {
    document?: { cookie: string; referrer: string };
    location?: { hostname: string; protocol: string; search: string; pathname: string };
  };
  return scope.document && scope.location ? { doc: scope.document, loc: scope.location } : null;
}

/** The cookie storage for this page, or null outside a browser. */
export function browserAcquisitionStorage(): AcquisitionStorage | null {
  const page = browserPage();
  return page ? acquisitionCookieStorage(page.doc, page.loc) : null;
}

/** Capture the current page view as the first touch, if none is stored. */
export function captureFirstTouchAcquisitionFromPage(): AcquisitionSource | null {
  const page = browserPage();
  if (!page) return null;
  return captureFirstTouchAcquisition(acquisitionCookieStorage(page.doc, page.loc), {
    search: page.loc.search,
    pathname: page.loc.pathname,
    referrer: page.doc.referrer,
    now: Date.now(),
  });
}

/** The stored first-touch record to send with a checkout request. */
export function getFirstTouchAcquisitionForCheckout(): AcquisitionSource | undefined {
  return loadFirstTouchAcquisition(browserAcquisitionStorage()) ?? undefined;
}

const METADATA_KEYS: Record<keyof AcquisitionSource, string> = {
  source: 'wm_acq_source',
  medium: 'wm_acq_medium',
  campaign: 'wm_acq_campaign',
  referrer: 'wm_acq_referrer',
  landing: 'wm_acq_landing',
  firstSeen: 'wm_acq_first_seen',
};

/** Provider metadata entries for a (re-validated) source record. */
export function acquisitionCheckoutMetadata(input: unknown): Record<string, string> {
  const source = normalizeAcquisitionSource(input);
  const metadata: Record<string, string> = {};
  if (!source) return metadata;
  for (const [key, value] of Object.entries(source) as [keyof AcquisitionSource, string][]) {
    metadata[METADATA_KEYS[key]] = value;
  }
  return metadata;
}
