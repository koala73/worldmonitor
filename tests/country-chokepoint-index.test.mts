import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFlowWeightedExposures,
  computeFallbackExposures,
  vulnerabilityIndex,
  type CountryProduct,
  type ExposureEntry,
} from '../server/worldmonitor/supply-chain/v1/chokepoint-exposure-utils.js';

function makeProduct(hs4: string, exporterIso2: string, share: number, value = 1_000_000): CountryProduct {
  return {
    hs4,
    description: `Product ${hs4}`,
    totalValue: value,
    topExporters: [{ partnerCode: 0, partnerIso2: exporterIso2, value, share }],
    year: 2024,
  };
}

function scoreMap(entries: ExposureEntry[]): Map<string, number> {
  return new Map(entries.map(e => [e.chokepointId, e.exposureScore]));
}

describe('Flow-weighted chokepoint exposure (#2968)', () => {
  describe('Turkey (TR)', () => {
    it('Energy (HS2=27) from SA scores differently than Pharma (HS2=30) from DE', () => {
      const energyProducts = [makeProduct('2709', 'SA', 0.6), makeProduct('2711', 'SA', 0.4)];
      const pharmaProducts = [makeProduct('3004', 'DE', 0.5), makeProduct('3004', 'FR', 0.3)];

      const energyExposures = computeFlowWeightedExposures('TR', '27', energyProducts);
      const pharmaExposures = computeFlowWeightedExposures('TR', '30', pharmaProducts);

      assert.ok(energyExposures.length > 0, 'energy exposures should not be empty');
      assert.ok(pharmaExposures.length > 0, 'pharma exposures should not be empty');

      const energyScores = scoreMap(energyExposures);
      const pharmaScores = scoreMap(pharmaExposures);

      let hasDifference = false;
      for (const [cpId, eScore] of energyScores) {
        const pScore = pharmaScores.get(cpId) ?? 0;
        if (eScore !== pScore) { hasDifference = true; break; }
      }
      assert.ok(hasDifference, 'Energy and Pharma must have different chokepoint scores for Turkey');
    });

    it('Energy from SA should have higher Hormuz exposure than Pharma from DE', () => {
      const energyProducts = [makeProduct('2709', 'SA', 0.8)];
      const pharmaProducts = [makeProduct('3004', 'DE', 0.8)];

      const energyScores = scoreMap(computeFlowWeightedExposures('TR', '27', energyProducts));
      const pharmaScores = scoreMap(computeFlowWeightedExposures('TR', '30', pharmaProducts));

      const hormuzEnergy = energyScores.get('hormuz_strait') ?? 0;
      const hormuzPharma = pharmaScores.get('hormuz_strait') ?? 0;
      assert.ok(
        hormuzEnergy > hormuzPharma,
        `Hormuz energy (${hormuzEnergy}) should exceed Hormuz pharma (${hormuzPharma})`,
      );
    });
  });

  describe('United States (US)', () => {
    it('Electronics (HS2=85) from CN scores differently than Vehicles (HS2=87) from DE', () => {
      const electronicsProducts = [makeProduct('8542', 'CN', 0.6), makeProduct('8517', 'TW', 0.3)];
      const vehicleProducts = [makeProduct('8703', 'DE', 0.5), makeProduct('8708', 'JP', 0.3)];

      const elecExposures = computeFlowWeightedExposures('US', '85', electronicsProducts);
      const vehExposures = computeFlowWeightedExposures('US', '87', vehicleProducts);

      const elecScores = scoreMap(elecExposures);
      const vehScores = scoreMap(vehExposures);

      let hasDifference = false;
      for (const [cpId, eScore] of elecScores) {
        const vScore = vehScores.get(cpId) ?? 0;
        if (eScore !== vScore) { hasDifference = true; break; }
      }
      assert.ok(hasDifference, 'Electronics and Vehicles must have different scores for the US');
    });

    it('Top chokepoints differ between Energy (SA/QA suppliers) and Electronics (CN/TW suppliers)', () => {
      const energyProducts = [makeProduct('2709', 'SA', 0.5), makeProduct('2711', 'QA', 0.3)];
      const elecProducts = [makeProduct('8542', 'CN', 0.7), makeProduct('8517', 'TW', 0.2)];

      const energyExposures = computeFlowWeightedExposures('US', '27', energyProducts);
      const elecExposures = computeFlowWeightedExposures('US', '85', elecProducts);

      const energyTop = energyExposures[0]?.chokepointId;
      const elecTop = elecExposures[0]?.chokepointId;

      assert.ok(energyTop, 'Energy should have a top chokepoint');
      assert.ok(elecTop, 'Electronics should have a top chokepoint');
      assert.notEqual(energyTop, elecTop, `Top chokepoint should differ: energy=${energyTop}, elec=${elecTop}`);
    });
  });

  describe('Cross-country differentiation', () => {
    const testCountries = ['TR', 'US', 'CN', 'DE', 'JP', 'IN', 'BR', 'GB', 'FR', 'SA'];

    it('At least 8 of 10 test countries produce differentiated Energy vs Pharma scores', () => {
      let differentiated = 0;
      for (const iso2 of testCountries) {
        const energyProducts = [makeProduct('2709', 'SA', 0.5), makeProduct('2711', 'RU', 0.3)];
        const pharmaProducts = [makeProduct('3004', 'DE', 0.4), makeProduct('3004', 'IN', 0.3)];

        const energyScores = scoreMap(computeFlowWeightedExposures(iso2, '27', energyProducts));
        const pharmaScores = scoreMap(computeFlowWeightedExposures(iso2, '30', pharmaProducts));

        for (const [cpId, eScore] of energyScores) {
          if (eScore !== (pharmaScores.get(cpId) ?? 0)) { differentiated++; break; }
        }
      }
      assert.ok(
        differentiated >= 8,
        `Only ${differentiated}/10 countries showed differentiation (need ≥8)`,
      );
    });
  });

  describe('Edge cases', () => {
    it('Empty products list returns empty exposures', () => {
      const result = computeFlowWeightedExposures('TR', '27', []);
      assert.equal(result.length, 0);
    });

    it('Products with no matching HS2 return empty exposures', () => {
      const products = [makeProduct('8542', 'CN', 0.8)];
      const result = computeFlowWeightedExposures('TR', '27', products);
      assert.equal(result.length, 0, 'HS2=27 should not match HS4=8542');
    });

    it('Unknown exporter country falls back gracefully (no routes)', () => {
      const products = [makeProduct('2709', 'ZZ', 1.0)];
      const result = computeFlowWeightedExposures('TR', '27', products);
      assert.ok(result.length > 0, 'should still return entries even for unknown exporter');
    });

    it('Scores are capped at 100', () => {
      const heavyProducts = [
        makeProduct('2709', 'SA', 0.9, 10_000_000),
        makeProduct('2710', 'SA', 0.9, 10_000_000),
        makeProduct('2711', 'SA', 0.9, 10_000_000),
      ];
      const result = computeFlowWeightedExposures('TR', '27', heavyProducts);
      for (const e of result) {
        assert.ok(e.exposureScore <= 100, `${e.chokepointId} scored ${e.exposureScore} > 100`);
      }
    });
  });

  describe('Fallback scoring', () => {
    it('Produces identical scores for different HS2 (except energy boost)', () => {
      const routes = ['gulf-europe-oil', 'russia-med-oil'];
      const pharma = computeFallbackExposures(routes, '30');
      const textiles = computeFallbackExposures(routes, '62');

      const pharmaScores = scoreMap(pharma);
      const textileScores = scoreMap(textiles);

      for (const [cpId, pScore] of pharmaScores) {
        assert.equal(pScore, textileScores.get(cpId) ?? 0, `Fallback: ${cpId} should be identical across non-energy sectors`);
      }
    });

    it('Energy boost differentiates HS2=27 from others in fallback mode', () => {
      const routes = ['gulf-europe-oil', 'gulf-asia-oil'];
      const energy = computeFallbackExposures(routes, '27');
      const pharma = computeFallbackExposures(routes, '30');

      const energyScores = scoreMap(energy);
      const pharmaScores = scoreMap(pharma);

      let hasDifference = false;
      for (const [cpId, eScore] of energyScores) {
        if (eScore !== (pharmaScores.get(cpId) ?? 0)) { hasDifference = true; break; }
      }
      assert.ok(hasDifference, 'Energy fallback should differ from non-energy due to 1.5x boost');
    });
  });

  describe('Vulnerability index', () => {
    it('Computes weighted average of top 3 scores', () => {
      const entries: ExposureEntry[] = [
        { chokepointId: 'a', chokepointName: 'A', exposureScore: 100, coastSide: '', shockSupported: false },
        { chokepointId: 'b', chokepointName: 'B', exposureScore: 80, coastSide: '', shockSupported: false },
        { chokepointId: 'c', chokepointName: 'C', exposureScore: 60, coastSide: '', shockSupported: false },
      ];
      const result = vulnerabilityIndex(entries);
      const expected = Math.round((100 * 0.5 + 80 * 0.3 + 60 * 0.2) * 10) / 10;
      assert.equal(result, expected);
    });
  });
});
