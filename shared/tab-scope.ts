/**
 * Focus scope for a dashboard tab (#10453): the countries a tab watches, whether
 * to widen to their neighbours, and an optional calendar window (for a trip).
 *
 * Pure code with no Intl, DOM or Node APIs: both convex/ and src/ import it.
 * It must not import the adjacency table: the tab store loads it at first
 * paint. Neighbour expansion lives in shared/tab-scope-resolve.ts.
 */

export interface TabScope {
  countries: string[];
  neighbours: boolean;
  /** 'YYYY-MM-DD', inclusive. */
  start?: string;
  /** 'YYYY-MM-DD', inclusive. */
  end?: string;
}

export type ScopeStatus = 'open' | 'ended' | 'upcoming' | 'none';

/** Chosen countries only; neighbours added by resolveScope do not count. */
export const SCOPE_MAX_COUNTRIES = 12;

/**
 * The keys of shared/iso2-to-iso3.json, inlined because convex/tsconfig.json
 * does not enable resolveJsonModule. tests/tab-scope.test.mts pins the two
 * lists together.
 */
export const SCOPE_ISO2_CODES: readonly string[] = Object.freeze([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE',
  'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG', 'CH',
  'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GG', 'GH', 'GI', 'GL', 'GM',
  'GN', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO',
  'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
  'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM',
  'MN', 'MO', 'MP', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO',
  'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA',
  'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST',
  'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA',
  'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'ZA', 'ZM', 'ZW',
]);

const VALID_ISO2 = new Set(SCOPE_ISO2_CODES);

export function isValidScopeIso2(code: unknown): code is string {
  return typeof code === 'string' && VALID_ISO2.has(code);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= daysInMonth;
}

/**
 * Clean an untrusted scope. Returns null unless 1..SCOPE_MAX_COUNTRIES unique
 * valid codes remain after uppercasing and dropping invalid entries; a list
 * over the limit is rejected, never truncated. `neighbours` defaults to true.
 * Each date is kept only if it is a real calendar date; if both are present
 * and start > end, both are dropped.
 */
export function normalizeScope(raw: unknown): TabScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.countries)) return null;

  const countries: string[] = [];
  for (const entry of input.countries) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toUpperCase();
    if (isValidScopeIso2(code) && !countries.includes(code)) countries.push(code);
  }
  if (countries.length === 0 || countries.length > SCOPE_MAX_COUNTRIES) return null;

  const scope: TabScope = {
    countries,
    neighbours: typeof input.neighbours === 'boolean' ? input.neighbours : true,
  };
  const start = isCalendarDate(input.start) ? input.start : undefined;
  const end = isCalendarDate(input.end) ? input.end : undefined;
  if (!(start && end && start > end)) {
    if (start) scope.start = start;
    if (end) scope.end = end;
  }
  return scope;
}

function utcDay(now: Date): string | null {
  const t = now.getTime();
  if (!Number.isFinite(t)) return null;
  const y = String(now.getUTCFullYear()).padStart(4, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Where `now` (as a UTC calendar day) falls in the scope's window. Both ends
 * are inclusive. 'none' when the scope has no dates.
 */
export function scopeStatus(scope: TabScope, now: Date): ScopeStatus {
  if (!scope.start && !scope.end) return 'none';
  const today = utcDay(now);
  if (!today) return 'none';
  if (scope.start && today < scope.start) return 'upcoming';
  if (scope.end && today > scope.end) return 'ended';
  return 'open';
}

export function scopeEquals(a: TabScope | null | undefined, b: TabScope | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.neighbours === b.neighbours
    && (a.start ?? null) === (b.start ?? null)
    && (a.end ?? null) === (b.end ?? null)
    && a.countries.length === b.countries.length
    && a.countries.every((code, i) => code === b.countries[i]);
}
