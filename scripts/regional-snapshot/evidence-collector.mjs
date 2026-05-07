// @ts-check
// Builds the evidence chain for a snapshot. Each evidence item is attributed
// to a theater (and corridor where applicable) and is referenced by ID from
// balance drivers, narrative sections, and triggers.

import { num } from './_helpers.mjs';
// Use scripts/shared mirror (not repo-root shared/): Railway service has
// rootDirectory=scripts so ../../shared/ escapes the deploy root. See #2954.
import { REGIONS, getRegionCorridors, isSignalInRegion } from '../shared/geography.js';

const MAX_EVIDENCE_PER_SNAPSHOT = 30;

/**
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {import('../../shared/regions.types.js').EvidenceItem[]}
 */
export function collectEvidence(regionId, sources) {
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) return [];

  /** @type {import('../../shared/regions.types.js').EvidenceItem[]} */
  const out = [];

  // Cross-source signals. Match against both fine-grained theater IDs and
  // the broad display labels the seed emits ("Middle East", "Sub-Saharan
  // Africa") — see isSignalInRegion in shared/geography.js.
  const xss = sources['intelligence:cross-source-signals:v1']?.signals;
  if (Array.isArray(xss)) {
    for (const s of xss) {
      if (!isSignalInRegion(s?.theater, region)) continue;
      out.push({
        id: String(s?.id ?? `xss:${out.length}`),
        type: 'market_signal',
        source: 'cross-source',
        summary: String(s?.summary ?? s?.type ?? 'cross-source signal'),
        confidence: num(s?.severityScore, 50) / 100,
        observed_at: num(s?.detectedAt, Date.now()),
        theater: String(s?.theater ?? ''),
        corridor: '',
      });
    }
  }

  // CII spikes for region countries
  const cii = sources['risk:scores:sebuf:stale:v1']?.ciiScores;
  if (Array.isArray(cii)) {
    const regionCountries = new Set(region.keyCountries);
    for (const c of cii) {
      if (!regionCountries.has(String(c?.region ?? ''))) continue;
      if (num(c?.combinedScore) < 50) continue;
      out.push({
        id: `cii:${c.region}`,
        type: 'cii_spike',
        source: 'risk-scores',
        summary: `${c.region} CII ${num(c.combinedScore).toFixed(0)} (trend ${c.trend ?? 'STABLE'})`,
        confidence: 0.9,
        observed_at: num(c?.computedAt, Date.now()),
        theater: '',
        corridor: '',
      });
    }
  }

  // Chokepoint status changes — scoped to this region's corridors only.
  // Without this filter, Taiwan / Baltic / Panama events would leak into
  // MENA and SSA evidence chains.
  const regionChokepointIds = new Set(
    getRegionCorridors(regionId)
      .map((c) => c.chokepointId)
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const cps = sources['supply_chain:chokepoints:v4']?.chokepoints;
  if (Array.isArray(cps)) {
    for (const cp of cps) {
      const cpId = String(cp?.id ?? '');
      if (!regionChokepointIds.has(cpId)) continue;
      const threat = String(cp?.threatLevel ?? '').toLowerCase();
      if (threat === 'normal' || threat === '') continue;
      out.push({
        id: `chokepoint:${cpId}`,
        type: 'chokepoint_status',
        source: 'supply-chain',
        summary: `${cp?.name ?? cpId}: ${threat}`,
        confidence: 0.95,
        observed_at: Date.now(),
        theater: '',
        corridor: cpId,
      });
    }
  }

  // Forecasts in region
  const fc = sources['forecast:predictions:v2']?.predictions;
  if (Array.isArray(fc)) {
    for (const f of fc) {
      const fRegion = String(f?.region ?? '').toLowerCase();
      if (!fRegion.includes(region.forecastLabel.toLowerCase())) continue;
      if (num(f?.probability) < 0.3) continue;
      out.push({
        id: `forecast:${f.id}`,
        type: 'news_headline',
        source: 'forecast',
        summary: String(f?.title ?? 'forecast'),
        confidence: num(f?.confidence, 0.5),
        observed_at: num(f?.updatedAt, Date.now()),
        theater: '',
        corridor: '',
      });
    }
  }

  // Sort by recency, cap to limit
  return out
    .sort((a, b) => b.observed_at - a.observed_at)
    .slice(0, MAX_EVIDENCE_PER_SNAPSHOT);
}
