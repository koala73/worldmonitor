/**
 * Display rules for Strategic Water Levels, shared by the panel, the map
 * popup and the three map renderers. Pure: callers pass the translator, the
 * locale and the clock, so the sort, filter and wording are unit-testable.
 *
 * Status semantics come from scripts/_reservoir-levels.mjs (classifyStatus).
 */
import type { ReservoirLevel, ReservoirLevelStatus } from '@/services/climate';
import { miniSparkline } from '@/utils/sparkline';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Attention first: records, then fast moves, then seasonal extremes, then the rest. */
export const RESERVOIR_STATUS_ORDER: readonly ReservoirLevelStatus[] = [
  'record_low', 'record_high', 'falling_fast', 'rising_fast', 'low', 'high', 'normal', 'insufficient_history', 'no_recent_data',
];

const CALM_STATUSES: ReadonlySet<ReservoirLevelStatus> = new Set(['normal', 'insufficient_history', 'no_recent_data']);

export type ReservoirFilter = 'all' | 'attention' | 'transboundary';
export const RESERVOIR_FILTERS: readonly ReservoirFilter[] = ['all', 'attention', 'transboundary'];

/** Colour family of a status; CSS and the map renderers key on this. */
export type ReservoirTone = 'record-low' | 'falling' | 'low' | 'rising' | 'normal' | 'muted';

/** Theme token each tone paints with (fills and markers; text uses the `-text` variant where one exists). */
export const RESERVOIR_TONE_TOKENS: Readonly<Record<ReservoirTone, string>> = {
  'record-low': '--semantic-critical',
  falling: '--semantic-high',
  low: '--semantic-elevated',
  rising: '--semantic-low',
  normal: '--text-dim',
  muted: '--text-muted',
};

/** Dark-theme values of the tokens above, for a renderer that cannot read CSS (tests, a detached canvas). */
const TONE_FALLBACK_HEX: Readonly<Record<ReservoirTone, string>> = {
  'record-low': '#ff4444',
  falling: '#ff8800',
  low: '#ffaa00',
  rising: '#3388ff',
  normal: '#888888',
  muted: '#838383',
};

export const RESERVOIR_SOURCE_URL = 'https://nsidc.org/data/atl13';
export const RESERVOIR_PROCESSING_URL = 'https://slideruleearth.io';

const DAY_MS = 86_400_000;
const MINUS = '−';

export function reservoirTone(status: ReservoirLevelStatus): ReservoirTone {
  switch (status) {
    case 'record_low': return 'record-low';
    case 'falling_fast': return 'falling';
    case 'low': return 'low';
    case 'record_high':
    case 'rising_fast':
    case 'high': return 'rising';
    case 'normal': return 'normal';
    default: return 'muted';
  }
}

/** True for the statuses an analyst should look at: not normal and not missing data. */
export function needsAttention(status: ReservoirLevelStatus): boolean {
  return !CALM_STATUSES.has(status);
}

export function isHollowStatus(status: ReservoirLevelStatus): boolean {
  return status === 'no_recent_data' || status === 'insufficient_history';
}

function statusRank(status: ReservoirLevelStatus): number {
  const i = RESERVOIR_STATUS_ORDER.indexOf(status);
  return i < 0 ? RESERVOIR_STATUS_ORDER.length : i;
}

/** Status order, then |seasonalZ| descending (missing last), then name. Returns a new array. */
export function sortReservoirs(list: readonly ReservoirLevel[]): ReservoirLevel[] {
  return [...list].sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    const za = a.seasonalZ == null ? -1 : Math.abs(a.seasonalZ);
    const zb = b.seasonalZ == null ? -1 : Math.abs(b.seasonalZ);
    if (za !== zb) return zb - za;
    return a.name.localeCompare(b.name, 'en');
  });
}

export function filterReservoirs(list: readonly ReservoirLevel[], filter: ReservoirFilter): ReservoirLevel[] {
  if (filter === 'attention') return list.filter((r) => needsAttention(r.status));
  if (filter === 'transboundary') return list.filter((r) => r.tags.includes('transboundary'));
  return [...list];
}

/** Whole days since the latest pass, from the client clock (the seeded ageDays ages between seeds). */
export function reservoirAgeDays(r: ReservoirLevel, nowMs: number): number | null {
  if (!r.latest) return null;
  return Math.max(0, Math.floor((nowMs - r.latest.observedAt.getTime()) / DAY_MS));
}

/** Signed metres with one decimal and a true minus sign: "+3.3 m", "−8.2 m", "0.0 m". */
export function formatSignedMetres(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit: 'meter', unitDisplay: 'short',
    minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero',
  }).format(value).replace('-', MINUS);
}

/** Unsigned level in metres with one decimal: "1,045.3 m". */
export function formatMetres(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit: 'meter', unitDisplay: 'short', minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(value).replace('-', MINUS);
}

export function formatMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
}

/** Short pass date; the year appears only when it differs from the current one. */
export function formatPassDate(date: Date, locale: string, nowMs: number): string {
  const sameYear = date.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export function formatAge(days: number, locale: string): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
}

export function countryName(code: string, locale: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface ReservoirFormatContext {
  t: Translate;
  locale: string;
  nowMs: number;
}

/** "Ethiopia · Blue Nile". */
export function reservoirPlace(r: ReservoirLevel, locale: string): string {
  return [countryName(r.country, locale), r.river].filter(Boolean).join(' · ');
}

export function statusLabel(status: ReservoirLevelStatus, t: Translate): string {
  return t(`components.reservoirLevels.status.${status}`);
}

/**
 * The row's main number: the seasonal anomaly where one exists ("−8.2 m vs
 * usual for September"), else the 12-month change, else a plain note.
 */
export function reservoirHeadline(r: ReservoirLevel, ctx: ReservoirFormatContext): string {
  const { t, locale } = ctx;
  if (r.seasonalAnomalyM != null && r.latest) {
    return t('components.reservoirLevels.vsUsual', {
      value: formatSignedMetres(r.seasonalAnomalyM, locale),
      month: formatMonth(r.latest.observedAt, locale),
    });
  }
  if (r.change365dM != null) {
    return t('components.reservoirLevels.in12Months', { value: formatSignedMetres(r.change365dM, locale) });
  }
  return t('components.reservoirLevels.noComparison');
}

/**
 * "measured 6 Sep (66 days ago)", or the note for a water body with no usable
 * pass. `bare` drops the leading word where a label already says "Measured".
 */
export function reservoirMeasured(r: ReservoirLevel, ctx: ReservoirFormatContext, bare = false): string {
  const { t, locale, nowMs } = ctx;
  const age = reservoirAgeDays(r, nowMs);
  if (!r.latest || age == null) return t('components.reservoirLevels.noPass');
  const date = formatPassDate(r.latest.observedAt, locale, nowMs);
  const ageText = formatAge(age, locale);
  return bare ? `${date} (${ageText})` : t('components.reservoirLevels.measured', { date, age: ageText });
}

/** Secondary line: the 12-month change when the headline did not already use it, then the pass date. */
export function reservoirDetail(r: ReservoirLevel, ctx: ReservoirFormatContext): string {
  const parts: string[] = [];
  const headlineUsesAnomaly = r.seasonalAnomalyM != null && r.latest != null;
  if (headlineUsesAnomaly && r.change365dM != null) {
    parts.push(ctx.t('components.reservoirLevels.in12Months', { value: formatSignedMetres(r.change365dM, ctx.locale) }));
  }
  parts.push(reservoirMeasured(r, ctx));
  return parts.join(' · ');
}

const SPARKLINE_SAMPLES = 48;

/**
 * Levels linearly interpolated onto `n` evenly spaced times between the first and last
 * reading. Satellite passes are irregular (days to months apart), and the shared sparkline
 * spaces values evenly, so plotting raw readings would stretch short gaps and squeeze long
 * ones. Readings with an unparseable date are skipped.
 */
export function resampleByTime(points: ReadonlyArray<{ date: string; levelM: number }>, n = SPARKLINE_SAMPLES): number[] {
  const pts = points
    .map((p) => ({ t: Date.parse(p.date), v: p.levelM }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2 || n < 2) return pts.map((p) => p.v);
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  if (t1 === t0) return pts.map((p) => p.v);
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    while (j < pts.length - 2 && pts[j + 1]!.t < t) j++;
    const a = pts[j]!;
    const b = pts[j + 1]!;
    const f = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    out.push(a.v + (b.v - a.v) * f);
  }
  return out;
}

/** 36-month sparkline through the shared helper, on a time grid; empty string under two points. */
export function reservoirSparkline(r: ReservoirLevel, width = 72, height = 22): string {
  const values = resampleByTime(r.series);
  if (values.length < 2) return '';
  const trend = r.change365dM ?? r.change90dM ?? (values[values.length - 1]! - values[0]!);
  return miniSparkline(values, trend, width, height);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** RGB of a tone from the live theme token, falling back to the dark-theme value. */
export function reservoirToneRgb(tone: ReservoirTone, readToken?: (token: string) => string): [number, number, number] {
  const live = readToken ? hexToRgb(readToken(RESERVOIR_TONE_TOKENS[tone]) || '') : null;
  return live ?? hexToRgb(TONE_FALLBACK_HEX[tone])!;
}
