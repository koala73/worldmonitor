// @ts-check
// Actor scoring extracts ActorState entries from forecast case files.
// Phase 0: lightweight extraction. Phase 1+ adds dedicated actor tracking.

import { clip, num } from './_helpers.mjs';
// Use scripts/shared mirror (not repo-root shared/): Railway service has
// rootDirectory=scripts so ../../shared/ escapes the deploy root.
import { REGIONS } from '../shared/geography.js';

const ALIASES = {
  iran: 'Iran', irgc: 'IRGC', tehran: 'Iran',
  russia: 'Russia', kremlin: 'Russia', moscow: 'Russia',
  china: 'China', prc: 'China', beijing: 'China',
  'united states': 'United States', usa: 'United States', us: 'United States', washington: 'United States',
  israel: 'Israel', idf: 'Israel',
  'saudi arabia': 'Saudi Arabia', riyadh: 'Saudi Arabia',
  nato: 'NATO',
  hezbollah: 'Hezbollah',
  hamas: 'Hamas',
  houthis: 'Houthis', houthi: 'Houthis', ansarallah: 'Houthis',
};

/**
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @returns {{ actors: import('../../shared/regions.types.js').ActorState[]; edges: import('../../shared/regions.types.js').LeverageEdge[] }}
 */
export function scoreActors(regionId, sources) {
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) return { actors: [], edges: [] };

  const fc = sources['forecast:predictions:v2'];
  const forecasts = Array.isArray(fc?.predictions) ? fc.predictions : [];
  const inRegion = forecasts.filter((f) => {
    const fRegion = String(f?.region ?? '').toLowerCase();
    return fRegion.includes(region.forecastLabel.toLowerCase());
  });

  const counts = new Map(); // canonical name -> { mentions, leverageDomains, evidenceIds }
  for (const f of inRegion) {
    const text = JSON.stringify(f?.caseFile ?? f?.signals ?? {}).toLowerCase();
    for (const [needle, canonical] of Object.entries(ALIASES)) {
      if (text.includes(needle)) {
        const entry = counts.get(canonical) ?? { mentions: 0, domains: new Set(), evidence: [] };
        entry.mentions += 1;
        if (/sanction|trade/.test(text)) entry.domains.add('economic');
        if (/naval|missile|strike|military|fleet/.test(text)) entry.domains.add('military');
        if (/oil|gas|pipeline|energy|opec/.test(text)) entry.domains.add('energy');
        if (/diplomat|alliance|treaty|summit/.test(text)) entry.domains.add('diplomatic');
        if (/strait|chokepoint|maritime|shipping|naval/.test(text)) entry.domains.add('maritime');
        if (entry.evidence.length < 5 && f?.id) entry.evidence.push(`forecast:${f.id}`);
        counts.set(canonical, entry);
      }
    }
  }

  /** @type {import('../../shared/regions.types.js').ActorState[]} */
  const actors = [];
  const totalMentions = [...counts.values()].reduce((s, e) => s + e.mentions, 0) || 1;
  for (const [name, entry] of counts.entries()) {
    const leverageScore = clip(entry.mentions / Math.max(5, totalMentions / 2), 0, 1);
    const role = inferRole(name, entry);
    actors.push({
      actor_id: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      role,
      leverage_domains: /** @type {import('../../shared/regions.types.js').ActorLeverageDomain[]} */ ([...entry.domains]),
      leverage_score: round(leverageScore),
      delta: 0, // No history in Phase 0
      evidence_ids: entry.evidence,
    });
  }

  // Phase 0: no leverage edges (requires actor pair detection across forecasts)
  return {
    actors: actors.sort((a, b) => b.leverage_score - a.leverage_score).slice(0, 10),
    edges: [],
  };
}

/**
 * @param {string} name
 * @param {{ domains: Set<string> }} entry
 * @returns {import('../../shared/regions.types.js').ActorRole}
 */
function inferRole(name, entry) {
  const aggressors = new Set(['Iran', 'IRGC', 'Russia', 'Houthis', 'Hamas', 'Hezbollah', 'China']);
  const stabilizers = new Set(['United States', 'NATO', 'Saudi Arabia']);
  if (aggressors.has(name) && entry.domains.has('military')) return 'aggressor';
  if (stabilizers.has(name)) return 'stabilizer';
  if (entry.domains.has('diplomatic')) return 'broker';
  return 'swing';
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
