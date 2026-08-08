// Plan 2026-04-26-001 §U5 — cohort anchor regression test.
//
// Pins the small-state-bias fixes (A + B + C) at the cohort level so
// future construct edits can't silently re-introduce the inflation:
//   - U1 (Fix A): tiny states with shipping data but no tradeToGdp
//                 must NOT inflate logisticsSupply to ~95.
//   - U2 (Fix C): tiny peaceful states (GPI-only mode) must blend
//                 socialCohesion to ~80, not ~93.
//   - U3 (Fix B): non-SWF advanced economies must emit
//                 sovereignFiscalBuffer.score=0, coverage=0
//                 (dim-not-applicable, NOT score=0 cov=1.0
//                 substantive-absence). Score remains numeric per
//                 ResilienceDimensionScore.score:number contract.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreLogisticsSupply,
  scoreSocialCohesion,
  scoreSovereignFiscalBuffer,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const currentYear = new Date().getFullYear();
const DISPLACEMENT_KEY = `displacement:summary:v1:${currentYear}`;
const UNREST_KEY = 'unrest:events:v1';
const SWF_KEY = 'resilience:recovery:sovereign-wealth:v1';
const SHIPPING_KEY = 'supply_chain:shipping_stress:v1';
const TRANSIT_KEY = 'supply_chain:transit-summaries:v1';

interface AnchorFixture {
  iso2: string;
  gpi?: number;
  roadsPaved?: number;
  tradeToGdpPct?: number | null;
  shippingStress?: number | null;
  transitStress?: number | null;
  inDisplacementRegistry?: boolean;
  unrestEvents?: number;
  swf?: { totalEffectiveMonths: number; completeness: number } | 'not-in-manifest';
}

function buildReader(fx: AnchorFixture): ResilienceSeedReader {
  return async (key: string): Promise<unknown | null> => {
    if (key === `resilience:static:${fx.iso2}`) {
      const record: Record<string, unknown> = {};
      if (fx.gpi != null) record.gpi = { score: fx.gpi };
      if (fx.roadsPaved != null) {
        record.infrastructure = { indicators: { 'IS.ROD.PAVE.ZS': { value: fx.roadsPaved, year: 2025 } } };
      }
      if (fx.tradeToGdpPct != null) {
        record.tradeToGdp = { tradeToGdpPct: fx.tradeToGdpPct, year: 2023, source: 'worldbank' };
      }
      return Object.keys(record).length > 0 ? record : null;
    }
    if (key === DISPLACEMENT_KEY) {
      // Always return present-but-conditional — outage path tested elsewhere.
      const countries = fx.inDisplacementRegistry
        ? [{ code: fx.iso2, totalDisplaced: 5000 }]
        : [];
      return { summary: { countries } };
    }
    if (key === UNREST_KEY) {
      const events = (fx.unrestEvents ?? 0) > 0
        ? Array.from({ length: fx.unrestEvents ?? 0 }, () => ({ country: fx.iso2, type: 'protest', fatalities: 0 }))
        : [];
      return { events };
    }
    if (key === SHIPPING_KEY) {
      return fx.shippingStress != null ? { stressScore: fx.shippingStress } : null;
    }
    if (key === TRANSIT_KEY) {
      return fx.transitStress != null
        ? { summaries: { suez: { disruptionPct: fx.transitStress, incidentCount7d: 5 } } }
        : null;
    }
    if (key === SWF_KEY) {
      // Always returns payload present (Path 1 imputation tested elsewhere).
      // Path 2 vs Path 3 differentiated by whether the country is in `countries`.
      if (fx.swf === 'not-in-manifest' || fx.swf == null) {
        return { countries: {} };
      }
      return { countries: { [fx.iso2]: fx.swf } };
    }
    return null;
  };
}

// Anchor cohorts —
//   - Tiny peaceful island states (TV, PW, NR): GPI ~1.3, no
//     displacement registry entry, zero unrest events, no observed
//     trade-to-GDP, shipping data present (global average), no SWF.
//   - Advanced economies without SWFs (DE, JP): full data EVERYWHERE
//     except sovereign-wealth manifest (they hold reserves through
//     central-bank / treasury, not a dedicated SWF).
const TINY_PEACEFUL: AnchorFixture[] = [
  { iso2: 'TV', gpi: 1.3, roadsPaved: 70, tradeToGdpPct: null, shippingStress: 65, transitStress: 12, inDisplacementRegistry: false, unrestEvents: 0, swf: 'not-in-manifest' },
  { iso2: 'PW', gpi: 1.3, roadsPaved: 70, tradeToGdpPct: null, shippingStress: 65, transitStress: 12, inDisplacementRegistry: false, unrestEvents: 0, swf: 'not-in-manifest' },
  { iso2: 'NR', gpi: 1.4, roadsPaved: 60, tradeToGdpPct: null, shippingStress: 65, transitStress: 12, inDisplacementRegistry: false, unrestEvents: 0, swf: 'not-in-manifest' },
];

const NON_SWF_ADVANCED: AnchorFixture[] = [
  { iso2: 'DE', gpi: 1.5, roadsPaved: 100, tradeToGdpPct: 90, shippingStress: 65, transitStress: 12, inDisplacementRegistry: true, unrestEvents: 5, swf: 'not-in-manifest' },
  { iso2: 'JP', gpi: 1.3, roadsPaved: 100, tradeToGdpPct: 38, shippingStress: 65, transitStress: 12, inDisplacementRegistry: true, unrestEvents: 2, swf: 'not-in-manifest' },
];

describe('resilience cohort bias anchors (Plan 2026-04-26-001 §U5)', () => {
  describe('U1 (Fix A) — tiny states with no tradeToGdp must NOT inflate logisticsSupply', () => {
    for (const fx of TINY_PEACEFUL) {
      it(`${fx.iso2}: logisticsSupply <= 80 (no shipping/transit inflation)`, async () => {
        const reader = buildReader(fx);
        const result = await scoreLogisticsSupply(fx.iso2, reader);
        // Only roadsPaved contributes (shipping + transit drop because
        // tradeExposure is null without observed tradeToGdp).
        // roadsPaved=70 → normalizeHigherBetter(70,0,100) = 70.
        assert.ok(result.score <= 80,
          `${fx.iso2} logisticsSupply must be <= 80 (got ${result.score}); v14 ~95 inflated by tradeExposure=0.5 default`);
        assert.equal(result.coverage, 0.5,
          `${fx.iso2} cov must drop to 0.5 when shipping+transit are excluded for missing tradeExposure`);
      });
    }
  });

  describe('U2 (Fix C) — tiny peaceful states (GPI-only mode) must NOT inflate socialCohesion', () => {
    for (const fx of TINY_PEACEFUL) {
      it(`${fx.iso2}: socialCohesion <= 80 (gated GPI-only impute + §U5 unrest fallback pull blend down)`, async () => {
        const reader = buildReader(fx);
        const result = await scoreSocialCohesion(fx.iso2, reader);
        // GPI 1.3 → norm(1.3, 1.0, 3.6) ≈ 88; displacement imputed at 70
        // (UNHCR comprehensive=true, GPI-only mode), unrest imputed at 50
        // (plan 002 §U5: unrest:events:v1 is non-comprehensive → fall back
        // to unmonitored 50/0.3) → blended ≈ 76.
        assert.ok(result.score <= 80,
          `${fx.iso2} socialCohesion must be <= 80 (got ${result.score}); v14 ~93 collapsed to GPI alone, plan 002 §U5 lowered ceiling 83 → 80`);
        assert.ok(result.score >= 70,
          `${fx.iso2} socialCohesion must remain plausible (>=70) — over-correction would punish genuinely peaceful tiny states`);
        // Dim-level imputationClass MUST be null because GPI is observed.
        assert.equal(result.imputationClass, null,
          `${fx.iso2} dim-level imputationClass must be null when GPI is observed (per-row imputation does not bubble up)`);
      });
    }
  });

  describe('U3 (Fix B) — non-SWF advanced economies must emit dim-not-applicable signature', () => {
    for (const fx of NON_SWF_ADVANCED) {
      it(`${fx.iso2}: sovereignFiscalBuffer score=0, coverage=0, observedWeight=0`, async () => {
        const reader = buildReader(fx);
        const result = await scoreSovereignFiscalBuffer(fx.iso2, reader);
        assert.equal(result.score, 0, `${fx.iso2} sovereignFiscalBuffer score must be 0 (numeric, not null) per ResilienceDimensionScore.score:number contract`);
        assert.equal(result.coverage, 0, `${fx.iso2} sovereignFiscalBuffer coverage must be 0 (dim-not-applicable; was 1.0 in v14)`);
        assert.equal(result.observedWeight, 0, `${fx.iso2} sovereignFiscalBuffer observedWeight must be 0 — the dim contributes nothing to the recovery-domain coverage-weighted mean`);
        assert.equal(result.imputedWeight, 0);
        assert.equal(result.imputationClass, 'not-applicable',
          `${fx.iso2} sovereignFiscalBuffer imputationClass must be 'not-applicable' (plan 2026-04-26-001 §U3 + review fixup) — the proto's structurally-not-applicable sentinel, distinct from null (any-observed-data) and source-failure`);
      });
    }
  });

  describe('Aggregate sanity — DE recovery-domain composition reflects Fix B reframing', () => {
    it('DE sovereignFiscalBuffer no longer drags recovery domain down with a false zero', async () => {
      // The directional check: under v14, DE.sovereignFiscalBuffer
      // contributed score=0 with full coverage=1.0, dragging the
      // recovery-domain coverage-weighted mean down. Under v15, the
      // same scorer returns score=0/cov=0, contributing 0 weight to
      // the mean, so DE's recovery-domain score is determined by the
      // OTHER recovery dims only.
      //
      // We can't compute the full recovery domain in isolation here
      // (requires all recovery scorers + their seed payloads); the
      // per-dim assertion above + the existing release-gate test
      // covering aggregate behavior already exercise the integration.
      // This describe block exists to anchor the construct intent in
      // a single, future-proof place: if a maintainer accidentally
      // reverts U3 to score=0/cov=1.0, the per-dim test in U3
      // describes WHY this matters in cohort terms.
      const fx = NON_SWF_ADVANCED[0]; // DE
      const reader = buildReader(fx);
      const result = await scoreSovereignFiscalBuffer(fx.iso2, reader);
      assert.equal(result.score, 0);
      assert.equal(result.coverage, 0);
    });
  });
});
