/**
 * Bounded content-to-product attribution shared by the blog, /pro, and
 * dashboard surfaces.
 *
 * This is intentionally separate from referral-capture.ts. `ref` and
 * `wm_referral` are affiliate codes; content handoffs use `wm_content_*` so
 * internal acquisition metadata can never be mistaken for a referral.
 */

export const CONTENT_ATTRIBUTION_STORAGE_KEY = 'wm-content-attribution-v1';
export const CONTENT_ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const CONTENT_ATTRIBUTION_MAX_VALUE_LENGTH = 100;

export const CONTENT_ATTRIBUTION_PARAMS = {
  source: 'wm_content_source',
  medium: 'wm_content_medium',
  campaign: 'wm_content_campaign',
  destination: 'wm_content_destination',
  placement: 'wm_content_placement',
} as const;

export const INBOUND_UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export type ContentDestination = 'dashboard' | 'pro' | 'api' | 'mcp' | 'unknown';
export type ContentLandingPageFamily =
  | 'homepage'
  | 'dashboard'
  | 'pricing'
  | 'documentation'
  | 'developer_mcp'
  | 'unknown';

export interface ContentAttribution {
  source: string;
  medium: string;
  campaign: string;
  destination: ContentDestination;
  placement: string;
  landingPageFamily: ContentLandingPageFamily;
  capturedAt?: number;
}

export interface ContentAttributionInput {
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  destination?: unknown;
  placement?: unknown;
  landingPageFamily?: unknown;
}

const UNKNOWN = 'unknown';
const CONTENT_DESTINATIONS = ['dashboard', 'pro', 'api', 'mcp'] as const;
const CONTENT_SOURCES = ['worldmonitor-blog'] as const;
const CONTENT_MEDIA = ['owned-content'] as const;
const CONTENT_PLACEMENTS = [
  'article-cta-dashboard',
  'article-cta-pro',
  'article-cta-api',
  'article-cta-mcp',
  'content-link',
  'footer-api',
  'footer-dashboard',
  'footer-mcp',
  'footer-pro',
  'header-dashboard',
  'header-primary',
  'header-pro',
  'product-link',
  'pro-dashboard-cta',
] as const;
const CONTENT_LANDING_PAGE_FAMILIES = [
  'homepage',
  'dashboard',
  'pricing',
  'documentation',
  'developer_mcp',
  'unknown',
] as const;
const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

/** Normalize a value without permitting an arbitrary analytics key. */
export function normalizeContentToken(value: unknown, fallback = UNKNOWN): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CONTENT_ATTRIBUTION_MAX_VALUE_LENGTH)
    .replace(/-+$/, '');

  return normalized && TOKEN_PATTERN.test(normalized) ? normalized : fallback;
}

function normalizeClosedValue<T extends string>(
  value: unknown,
  values: readonly T[],
): string {
  if (typeof value !== 'string') return UNKNOWN;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > CONTENT_ATTRIBUTION_MAX_VALUE_LENGTH
    || !TOKEN_PATTERN.test(normalized)
  ) return UNKNOWN;
  return isMember(values, normalized) ? normalized : UNKNOWN;
}

function normalizeContentCampaign(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > CONTENT_ATTRIBUTION_MAX_VALUE_LENGTH
    || !TOKEN_PATTERN.test(normalized)
  ) return UNKNOWN;
  return normalized;
}

export function normalizeContentDestination(value: unknown): ContentDestination {
  return normalizeClosedValue(value, CONTENT_DESTINATIONS) as ContentDestination;
}

export function normalizeContentLandingPageFamily(value: unknown): ContentLandingPageFamily {
  return normalizeClosedValue(value, CONTENT_LANDING_PAGE_FAMILIES) as ContentLandingPageFamily;
}

export function normalizeContentAttribution(
  input: ContentAttributionInput,
): ContentAttribution {
  return {
    source: normalizeClosedValue(input.source, CONTENT_SOURCES),
    medium: normalizeClosedValue(input.medium, CONTENT_MEDIA),
    campaign: normalizeContentCampaign(input.campaign),
    destination: normalizeContentDestination(input.destination),
    placement: normalizeClosedValue(input.placement, CONTENT_PLACEMENTS),
    landingPageFamily: normalizeContentLandingPageFamily(input.landingPageFamily),
  };
}

/** Map the stored record to the only content dimensions sent with product events. */
export function getContentAttributionAnalyticsFields(
  attribution: ContentAttribution,
): Record<string, string> {
  return {
    contentSource: attribution.source,
    contentMedium: attribution.medium,
    contentCampaign: attribution.campaign,
    contentDestination: attribution.destination,
    contentPlacement: attribution.placement,
    landingPageFamily: attribution.landingPageFamily,
  };
}

/** Add the bounded content dimensions to an existing event without overwriting it. */
export function withContentAttribution(
  data: Record<string, unknown> | undefined,
  attribution: ContentAttribution | null,
): Record<string, unknown> | undefined {
  if (!attribution) return data;
  return {
    ...data,
    ...getContentAttributionAnalyticsFields(attribution),
  };
}

function serializeUrl(original: string, parsed: URL): string {
  if (ABSOLUTE_URL_PATTERN.test(original)) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Add content metadata to a destination URL while preserving its other query parameters. */
export function appendContentAttributionToUrl(
  url: string,
  input: ContentAttributionInput,
): string {
  try {
    const parsed = new URL(url, 'https://www.worldmonitor.app');
    const attribution = normalizeContentAttribution(input);
    parsed.searchParams.set(CONTENT_ATTRIBUTION_PARAMS.source, attribution.source);
    parsed.searchParams.set(CONTENT_ATTRIBUTION_PARAMS.medium, attribution.medium);
    parsed.searchParams.set(CONTENT_ATTRIBUTION_PARAMS.campaign, attribution.campaign);
    parsed.searchParams.set(CONTENT_ATTRIBUTION_PARAMS.destination, attribution.destination);
    parsed.searchParams.set(CONTENT_ATTRIBUTION_PARAMS.placement, attribution.placement);
    return serializeUrl(url, parsed);
  } catch {
    return url;
  }
}

/**
 * Copy only inbound UTM parameters to a handoff URL. Existing destination
 * values win, repeated input values collapse to the first value, and `ref` /
 * `wm_referral` are deliberately not copied here.
 */
export function appendInboundUtmParams(url: string, incomingSearch: string): string {
  try {
    const parsed = new URL(url, 'https://www.worldmonitor.app');
    const incoming = new URLSearchParams(incomingSearch);
    for (const name of INBOUND_UTM_PARAMS) {
      if (parsed.searchParams.has(name)) continue;
      const value = incoming.get(name);
      if (value !== null) {
        parsed.searchParams.set(name, value.slice(0, CONTENT_ATTRIBUTION_MAX_VALUE_LENGTH));
      }
    }
    return serializeUrl(url, parsed);
  } catch {
    return url;
  }
}

/** Read a content attribution record from a query string without touching browser state. */
export function parseContentAttribution(
  search: string,
  pathname: string,
): ContentAttribution | null {
  const params = new URLSearchParams(search);
  const hasContentSignal = Object.values(CONTENT_ATTRIBUTION_PARAMS)
    .some((name) => params.has(name));
  if (!hasContentSignal) return null;

  return normalizeContentAttribution({
    source: params.get(CONTENT_ATTRIBUTION_PARAMS.source),
    medium: params.get(CONTENT_ATTRIBUTION_PARAMS.medium),
    campaign: params.get(CONTENT_ATTRIBUTION_PARAMS.campaign),
    destination: params.get(CONTENT_ATTRIBUTION_PARAMS.destination),
    placement: params.get(CONTENT_ATTRIBUTION_PARAMS.placement),
    landingPageFamily: inferLandingPageFamily(pathname),
  });
}

/** Keep scorecard page-family values closed even for crafted destination URLs. */
export function inferLandingPageFamily(pathname: string): ContentLandingPageFamily {
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (path === '/') return 'homepage';
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return 'dashboard';
  if (path === '/pro' || path.startsWith('/pro/')) return 'pricing';
  if (path === '/mcp' || path.startsWith('/mcp/') || path === '/api' || path.startsWith('/api/')) {
    return 'developer_mcp';
  }
  if (path === '/docs' || path.startsWith('/docs/')) return 'documentation';
  return 'unknown';
}

function readStoredContentAttribution(): ContentAttribution | null {
  try {
    const raw = window.sessionStorage.getItem(CONTENT_ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ContentAttributionInput & { capturedAt?: unknown };
    const capturedAt = typeof parsed.capturedAt === 'number' ? parsed.capturedAt : NaN;
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > CONTENT_ATTRIBUTION_TTL_MS) {
      window.sessionStorage.removeItem(CONTENT_ATTRIBUTION_STORAGE_KEY);
      return null;
    }
    return { ...normalizeContentAttribution(parsed), capturedAt };
  } catch {
    try { window.sessionStorage.removeItem(CONTENT_ATTRIBUTION_STORAGE_KEY); } catch { /* no-op */ }
    return null;
  }
}

/** Return the active bounded content record, if the browser has one. */
export function getContentAttributionForAnalytics(): ContentAttribution | null {
  if (typeof window === 'undefined') return null;
  return readStoredContentAttribution();
}

/**
 * Capture the current handoff once, remove only `wm_content_*` from the
 * visible URL, and keep inbound UTM/referral parameters intact.
 *
 * Returns only a newly captured record. Callers can use this to fire one
 * landing event without repeating it on every reload.
 */
export function captureContentAttributionFromUrl(): ContentAttribution | null {
  if (typeof window === 'undefined') return null;

  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }

  const attribution = parseContentAttribution(url.search, url.pathname);
  if (!attribution) return null;

  for (const name of Object.values(CONTENT_ATTRIBUTION_PARAMS)) {
    url.searchParams.delete(name);
  }
  try {
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ''}${url.hash}`,
    );
  } catch {
    // The record is still useful when history is unavailable in an embed.
  }

  const record: ContentAttribution = { ...attribution, capturedAt: Date.now() };
  try {
    window.sessionStorage.setItem(CONTENT_ATTRIBUTION_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Analytics remains best-effort when browser storage is unavailable.
  }
  return record;
}

/** Add the active record to a same-origin handoff and preserve inbound UTMs. */
export function appendStoredContentAttributionToUrl(
  url: string,
  overrides: Pick<ContentAttributionInput, 'destination' | 'placement'>,
): string {
  if (typeof window === 'undefined') return url;
  const attribution = getContentAttributionForAnalytics();
  if (!attribution) return url;
  const withContent = appendContentAttributionToUrl(url, {
    ...attribution,
    ...overrides,
  });
  return appendInboundUtmParams(withContent, window.location.search);
}
