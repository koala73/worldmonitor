// @ts-check
// Builds the evidence chain for a snapshot. Each evidence item is attributed
// to a theater (and corridor where applicable) and is referenced by ID from
// balance drivers, narrative sections, and triggers.

import { num } from './_helpers.mjs';
// Use scripts/shared mirror (not repo-root shared/): Railway service has
// rootDirectory=scripts so ../../shared/ escapes the deploy root.
import { REGIONS } from '../shared/geography.js';

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

  // Cross-source signals
  const xss = sources['intelligence:cross-source-signals:v1']?.signals;
  if (Array.isArray(xss)) {
    for (const s of xss) {
      const theater = String(s?.theater ?? '').toLowerCase();
      if (!region.theaters.some((t) => theater.includes(t.replace(/-/g, ' ')))) continue;
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

  // Chokepoint status changes for region's corridors
  const cps = sources['supply_chain:chokepoints:v4']?.chokepoints;
  if (Array.isArray(cps)) {
    for (const cp of cps) {
      const threat = String(cp?.threatLevel ?? '').toLowerCase();
      if (threat === 'normal' || threat === '') continue;
      out.push({
        id: `chokepoint:${cp.id}`,
        type: 'chokepoint_status',
        source: 'supply-chain',
        summary: `${cp?.name ?? cp?.id}: ${threat}`,
        confidence: 0.95,
        observed_at: Date.now(),
        theater: '',
        corridor: String(cp?.id ?? ''),
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
