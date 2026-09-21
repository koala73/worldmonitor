/**
 * AI-era timeline visibility — shared by React seek + DeckGL paint.
 *
 * Missing ≠ 0: undated points are excluded from historical timeFocus frames.
 * Live (focusMs == null) uses today’s catalog rules.
 *
 * Growth layers with cited dates: datacenters (Epoch), accelerators (founded year),
 * techEvents (startDate). techHQs / startupHubs / cloudRegions have no cited open
 * dates — empty historically until a join exists.
 */

import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { ACCELERATORS } from '@/config/tech-geo';
import type { AIDataCenter } from '@/types';
import type { Accelerator } from '@/config/tech-geo';

export const AI_ERA_GROWTH_LAYER_KEYS = [
  'datacenters',
  'cloudRegions',
  'techHQs',
  'startupHubs',
  'accelerators',
  'techEvents',
] as const;

export type AiEraGrowthLayerKey = (typeof AI_ERA_GROWTH_LAYER_KEYS)[number];

/** Layers that can show historical growth (have or will have cited dates). */
export const AI_ERA_DATED_LAYER_KEYS: readonly AiEraGrowthLayerKey[] = [
  'datacenters',
  'accelerators',
  'techEvents',
];

/** Layers with no cited open dates — Live only. */
export const AI_ERA_LIVE_ONLY_LAYER_KEYS: readonly AiEraGrowthLayerKey[] = [
  'techHQs',
  'startupHubs',
  'cloudRegions',
];

export type TechEventLike = {
  startDate?: string | null;
};

export type EraVisibilityCatalogs = {
  datacenters?: readonly AIDataCenter[];
  accelerators?: readonly Accelerator[];
  techEvents?: readonly TechEventLike[];
};

export function yearToUtcMs(year: number): number {
  return Date.UTC(year, 0, 1, 0, 0, 0);
}

export function parseDateToUtcMs(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3] ?? 1);
    if (!Number.isFinite(y) || mo < 0 || mo > 11) return null;
    return Date.UTC(y, mo, d, 0, 0, 0);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Live: existing + planned (not decommissioned).
 * Historical: firstOperationalMs known and <= focus; planned out; undated out.
 */
export function datacenterVisibleAt(
  d: AIDataCenter,
  focusMs: number | null,
): boolean {
  if (d.status === 'decommissioned') return false;
  if (focusMs == null) {
    return d.status === 'existing' || d.status === 'planned';
  }
  if (d.status === 'planned') return false;
  if (d.firstOperationalMs == null) return false;
  return d.firstOperationalMs <= focusMs;
}

/** Live: all. Historical: founded year known and year-start <= focus. */
export function acceleratorVisibleAt(
  a: Pick<Accelerator, 'founded'>,
  focusMs: number | null,
): boolean {
  if (focusMs == null) return true;
  if (a.founded == null || !Number.isFinite(a.founded)) return false;
  return yearToUtcMs(a.founded) <= focusMs;
}

/** Live: all. Historical: startDate known and <= focus. */
export function techEventVisibleAt(
  e: TechEventLike,
  focusMs: number | null,
): boolean {
  if (focusMs == null) return true;
  const ms = parseDateToUtcMs(e.startDate ?? null);
  if (ms == null) return false;
  return ms <= focusMs;
}

export function layersVisibleAtFocus(
  focusMs: number | null,
  catalogs: EraVisibilityCatalogs = {},
): AiEraGrowthLayerKey[] {
  const dcs = catalogs.datacenters ?? AI_DATA_CENTERS;
  const acc = catalogs.accelerators ?? ACCELERATORS;
  const events = catalogs.techEvents ?? [];

  const out: AiEraGrowthLayerKey[] = [];

  if (focusMs == null) {
    // Live: enable every growth layer that can paint something from catalogs / fetch.
    if (dcs.some((d) => datacenterVisibleAt(d, null))) out.push('datacenters');
    if (acc.length > 0) out.push('accelerators');
    out.push('techHQs', 'startupHubs', 'cloudRegions', 'techEvents');
    return out;
  }

  if (dcs.some((d) => datacenterVisibleAt(d, focusMs))) out.push('datacenters');
  if (acc.some((a) => acceleratorVisibleAt(a, focusMs))) out.push('accelerators');
  if (events.some((e) => techEventVisibleAt(e, focusMs))) out.push('techEvents');
  // techHQs / startupHubs / cloudRegions: no cited dates → never historically
  return out;
}

/**
 * Full flag bag for era seek: everything off, then visible growth keys on.
 * Returns only growth-layer keys; caller merges into a full LayerMap / MapLayers.
 */
export function growthFlagsForEraSeek(
  focusMs: number | null,
  catalogs?: EraVisibilityCatalogs,
): Record<AiEraGrowthLayerKey, boolean> {
  const visible = new Set(layersVisibleAtFocus(focusMs, catalogs));
  const flags = {} as Record<AiEraGrowthLayerKey, boolean>;
  for (const key of AI_ERA_GROWTH_LAYER_KEYS) {
    flags[key] = visible.has(key);
  }
  return flags;
}
