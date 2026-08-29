// AALICE:OpenEYE — USA-vs-CHINA bloc alignment, client side (fork-side, AMD-003).
//
// Reads the daily artifact produced by scripts/seed-bloc-markets.mjs and turns
// it into map colours and panel rows. All the regression maths lives in the
// seeder (scripts/_bloc-math.mjs); nothing here re-fits anything.

import { matchCountryNamesInText } from '@/services/country-geometry';
import type { NewsItem } from '@/types';

export interface BlocCountry {
  iso2: string;
  name: string;
  symbol: string;
  /** OLS loading on the US leg, conditional on the China leg. */
  betaUs: number;
  /** OLS loading on the China leg, conditional on the US leg. */
  betaCn: number;
  /** -1 purely US-coupled … +1 purely China-coupled. */
  lean: number;
  /** Share of the country's variance the two legs jointly explain. */
  r2: number;
  obs: number;
  /** Stdev of the abnormal returns — the scale an AR is judged against. */
  arSigma: number;
  lastAr: number;
  lastArT: number;
  recentAr: Array<{ t: number; ar: number }>;
}

export interface BlocSnapshot {
  generatedAtMs: number;
  usLeg: string;
  cnLeg: string;
  range: string;
  windowSessions: number;
  countries: BlocCountry[];
}

export const BLOC_POLES: Record<string, 'us' | 'cn'> = { US: 'us', CN: 'cn' };

/** Abnormal move (in sigmas) past which a country counts as reacting. */
export const AR_ALERT_SIGMA = 1.5;

type RGBA = [number, number, number, number];

const US_RED: RGBA = [220, 38, 38, 210];
const CN_ORANGE: RGBA = [249, 115, 22, 210];
const NEUTRAL_GRAY: RGBA = [110, 118, 129, 38];
const UNSCORED_GRAY: RGBA = [80, 86, 94, 22];

/**
 * How saturated a country's tint gets. Two independent gates, multiplied:
 * how lopsided the coupling is, and how much of the country's variance the
 * legs actually explain. The R² gate is what stops a market like Vietnam —
 * lean −0.97 but R² 0.09, i.e. essentially unexplained — from rendering as
 * loud as Korea, whose −0.89 rests on an R² of 0.58.
 */
export function blocIntensity(lean: number, r2: number): number {
  const strength = Math.min(1, Math.abs(lean) / 0.6);
  const confidence = Math.min(1, Math.max(0, r2) / 0.5);
  return strength * confidence;
}

function lerp(a: RGBA, b: RGBA, t: number): RGBA {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

/**
 * Fill colour for one country polygon.
 * The two poles are fixed — the US is red and China is orange because they are
 * the legs, not because anything was measured about them. Everyone else starts
 * gray and is tinted toward whichever pole their market tracks.
 */
export function blocFillColor(
  iso2: string,
  byIso: Map<string, BlocCountry>,
): RGBA {
  if (iso2 === 'US') return US_RED;
  if (iso2 === 'CN') return CN_ORANGE;
  const row = byIso.get(iso2);
  if (!row) return UNSCORED_GRAY;
  const t = blocIntensity(row.lean, row.r2);
  return lerp(NEUTRAL_GRAY, row.lean < 0 ? US_RED : CN_ORANGE, t);
}

/**
 * Outline colour. A country gets a bright edge only when BOTH things are true:
 * today's move broke out of its own abnormal-return distribution, AND the
 * current feed actually mentions it. That conjunction is the whole point —
 * an unexplained market move with no story behind it is noise, and a story
 * about a country whose market did nothing is not a market relationship.
 */
export function blocLineColor(
  iso2: string,
  byIso: Map<string, BlocCountry>,
  newsActive: Set<string>,
): RGBA {
  if (!isReacting(iso2, byIso, newsActive)) return [0, 0, 0, 0];
  const row = byIso.get(iso2);
  return row && row.lastAr < 0 ? [255, 80, 80, 255] : [120, 255, 180, 255];
}

export function isReacting(
  iso2: string,
  byIso: Map<string, BlocCountry>,
  newsActive: Set<string>,
): boolean {
  const row = byIso.get(iso2);
  if (!row || !(row.arSigma > 0)) return false;
  if (!newsActive.has(iso2)) return false;
  return Math.abs(row.lastAr) / row.arSigma >= AR_ALERT_SIGMA;
}

/** Today's abnormal return expressed in sigmas. 0 when it can't be judged. */
export function arZScore(row: BlocCountry): number {
  if (!(row.arSigma > 0)) return 0;
  return row.lastAr / row.arSigma;
}

/**
 * Countries the current feed is actually talking about. Reuses the same
 * gazetteer the rest of the app matches country names with, so the map and
 * the news panels agree on what "mentioned" means.
 */
export function newsActiveCountries(news: NewsItem[], limit = 400): Set<string> {
  const active = new Set<string>();
  for (const item of news.slice(0, limit)) {
    const text = item.title ?? '';
    if (!text.trim()) continue;
    for (const code of matchCountryNamesInText(text)) active.add(code);
  }
  return active;
}

export function indexByIso(snapshot: BlocSnapshot | null): Map<string, BlocCountry> {
  const m = new Map<string, BlocCountry>();
  for (const c of snapshot?.countries ?? []) m.set(c.iso2, c);
  return m;
}

/**
 * Fetch the daily artifact. Served same-origin from the mounted `data-live`
 * volume, so no auth and no CORS; a miss is not an error worth throwing over,
 * the map simply renders every country gray.
 */
export async function loadBlocSnapshot(): Promise<BlocSnapshot | null> {
  try {
    const resp = await fetch('/live/bloc-lean.json', { cache: 'no-store' });
    if (!resp.ok) return null;
    const data = (await resp.json()) as BlocSnapshot;
    if (!Array.isArray(data?.countries) || data.countries.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}
