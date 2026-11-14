/**
 * Display rules for Strategic Water Levels, shared by the panel, the map
 * popup and the three map renderers. Pure: callers pass the translator, the
 * locale and the clock, so the sort, filter and wording are unit-testable.
 *
 * Status semantics come from scripts/_reservoir-levels.mjs (classifyStatus).
 */
import type { ReservoirLevel, ReservoirLevelStatus } from '@/services/climate';
import type { ReservoirNextPass } from '@/services/orbital/reservoir-next-pass';
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
export type ReservoirTone = 'record-low' | 'falling' | 'low' | 'rising' | 'normal' | 'muted' | 'beyond' | 'ok';

/** Theme token each tone paints with (fills and markers; text uses the `-text` variant where one exists). */
export const RESERVOIR_TONE_TOKENS: Readonly<Record<ReservoirTone, string>> = {
  'record-low': '--semantic-critical',
  falling: '--semantic-high',
  low: '--semantic-elevated',
  rising: '--semantic-low',
  normal: '--text-dim',
  muted: '--text-muted',
  beyond: '--semantic-elevated',
  ok: '--green',
};

/** Dark-theme values of the tokens above, for a renderer that cannot read CSS (tests, a detached canvas). */
const TONE_FALLBACK_HEX: Readonly<Record<ReservoirTone, string>> = {
  'record-low': '#ff4444',
  falling: '#ff8800',
  low: '#ffaa00',
  rising: '#3388ff',
  normal: '#888888',
  muted: '#838383',
  beyond: '#ffaa00',
  ok: '#44ff88',
};

export const RESERVOIR_SOURCE_URL = 'https://nsidc.org/data/atl13';
export const RESERVOIR_ATL06_SOURCE_URL = 'https://nsidc.org/data/atl06';
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

/**
 * Tone of a status chip in the panel row, the reservoir cards and the popups: amber for low or
 * high against the seasonal baseline, green for normal. Map markers keep `reservoirTone`.
 */
export function reservoirChipTone(status: ReservoirLevelStatus): ReservoirTone {
  switch (status) {
    case 'low':
    case 'high': return 'beyond';
    case 'normal': return 'ok';
    default: return reservoirTone(status);
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

/**
 * Low and high come from the seasonal z-score when a seasonal baseline exists,
 * else from the position in the record range (classifyStatus), so only the
 * first case may say "for season".
 */
export function statusLabel(r: Pick<ReservoirLevel, 'status' | 'seasonalZ'>, t: Translate): string {
  const inRange = (r.status === 'low' || r.status === 'high') && r.seasonalZ == null;
  return t(`components.reservoirLevels.status.${inRange ? `${r.status}InRange` : r.status}`);
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

/** "Measured 6 Sep · 66d ago": the card's compact form, with the narrow relative age. */
export function reservoirMeasuredShort(r: ReservoirLevel, ctx: ReservoirFormatContext): string {
  const { t, locale, nowMs } = ctx;
  const age = reservoirAgeDays(r, nowMs);
  if (!r.latest || age == null) return t('components.reservoirLevels.noPass');
  return t('components.reservoirLevels.card.measured', {
    date: formatPassDate(r.latest.observedAt, locale, nowMs),
    age: new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }).format(-age, 'day'),
  });
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
type TimedValue = { t: number; v: number };

function timed<P extends { date: string }>(points: readonly P[], pick: (p: P) => number | null | undefined): TimedValue[] {
  return points
    .map((p) => ({ t: Date.parse(p.date), v: pick(p) ?? Number.NaN }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

function timeGrid(pts: readonly TimedValue[], n: number): number[] | null {
  if (pts.length < 2 || n < 2) return null;
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  if (t1 === t0) return null;
  return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
}

/** Linear interpolation of `pts` at each grid time; null outside the span of `pts`. */
function interpolateAt(pts: readonly TimedValue[], grid: readonly number[]): Array<number | null> {
  let j = 0;
  return grid.map((t) => {
    if (pts.length === 0 || t < pts[0]!.t || t > pts[pts.length - 1]!.t) return null;
    if (pts.length === 1) return pts[0]!.v;
    while (j < pts.length - 2 && pts[j + 1]!.t < t) j++;
    const a = pts[j]!;
    const b = pts[j + 1]!;
    const f = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    return a.v + (b.v - a.v) * f;
  });
}

/**
 * Levels linearly interpolated onto `n` evenly spaced times between the first and last
 * reading. Satellite passes are irregular (days to months apart), and the shared sparkline
 * spaces values evenly, so plotting raw readings would stretch short gaps and squeeze long
 * ones. Readings with an unparseable date are skipped.
 */
export function resampleByTime(points: ReadonlyArray<{ date: string; levelM: number }>, n = SPARKLINE_SAMPLES): number[] {
  const pts = timed(points, (p) => p.levelM);
  const grid = timeGrid(pts, n);
  return grid ? interpolateAt(pts, grid) as number[] : pts.map((p) => p.v);
}

/**
 * The seeded seasonal baseline (`baselineM`, from seasonalBaseline in
 * scripts/_reservoir-levels.mjs) on the same time grid as `resampleByTime`, null where the
 * seeder had too few prior seasons. Empty when no point carries a baseline.
 */
export function resampleBaselineByTime(
  points: ReadonlyArray<{ date: string; levelM: number; baselineM?: number }>,
  n = SPARKLINE_SAMPLES,
): Array<number | null> {
  const base = timed(points, (p) => p.baselineM);
  if (base.length < 2) return [];
  const grid = timeGrid(timed(points, (p) => p.levelM), n);
  return grid ? interpolateAt(base, grid) : [];
}

/**
 * 36-month sparkline through the shared helper, on a time grid, with the seasonal baseline
 * as a dashed line where the snapshot carries one; empty string under two points.
 */
export function reservoirSparkline(r: ReservoirLevel, width = 72, height = 22): string {
  const values = resampleByTime(r.series);
  if (values.length < 2) return '';
  const trend = r.change365dM ?? r.change90dM ?? (values[values.length - 1]! - values[0]!);
  const baseline = resampleBaselineByTime(r.series);
  return miniSparkline(values, trend, width, height, baseline.length === values.length ? baseline : undefined);
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

/** Predicted ICESat-2 crossing, or the normal no-crossing answer, with the orbit data date. */
export function reservoirNextPassText(pass: ReservoirNextPass, t: Translate, locale: string): string {
  const day = (ms: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
  const epoch = day(pass.elementsEpochMs);
  return pass.status === 'pass'
    ? t('components.reservoirLevels.nextPass.at', { date: day(pass.timeMs), epoch })
    : t('components.reservoirLevels.nextPass.none', { date: day(pass.windowEndMs), epoch });
}

/** The card's short crossing value ("21 Nov, 03:14 UTC" or the no-crossing note); the full text goes in its tooltip. */
export function reservoirNextPassShort(pass: ReservoirNextPass, t: Translate, locale: string): string {
  if (pass.status !== 'pass') {
    const end = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(pass.windowEndMs));
    return t('components.reservoirLevels.card.noCrossing', { date: end });
  }
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(pass.timeMs));
}
