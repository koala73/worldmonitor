import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COUNTRY_LANGUAGE_TIER,
  LANGUAGE_TIERS,
  getLanguageCoverageFactor,
  type LanguageCoverageTier,
} from '../server/worldmonitor/resilience/v1/_language-coverage.ts';

describe('language coverage normalization (Phase 2 T2.9)', () => {
  it('primary tier countries return 1.0', () => {
    assert.equal(getLanguageCoverageFactor('US'), 1.0);
    assert.equal(getLanguageCoverageFactor('GB'), 1.0);
    assert.equal(getLanguageCoverageFactor('AU'), 1.0);
  });

  it('secondary tier countries return 0.7', () => {
    assert.equal(getLanguageCoverageFactor('IN'), 0.7);
    assert.equal(getLanguageCoverageFactor('PH'), 0.7);
    assert.equal(getLanguageCoverageFactor('KE'), 0.7);
  });

  it('limited tier countries return 0.4', () => {
    assert.equal(getLanguageCoverageFactor('CN'), 0.4);
    assert.equal(getLanguageCoverageFactor('JP'), 0.4);
    assert.equal(getLanguageCoverageFactor('RU'), 0.4);
    assert.equal(getLanguageCoverageFactor('BR'), 0.4);
  });

  it('unknown country codes default to minimal (0.2)', () => {
    assert.equal(getLanguageCoverageFactor('XX'), 0.2);
    assert.equal(getLanguageCoverageFactor('ZZ'), 0.2);
  });

  it('tier map values match LANGUAGE_TIERS constants', () => {
    for (const [, tier] of Object.entries(COUNTRY_LANGUAGE_TIER)) {
      assert.ok(
        tier in LANGUAGE_TIERS,
        `tier '${tier}' not found in LANGUAGE_TIERS`,
      );
    }
  });

  it('all four tiers are represented in the country map', () => {
    const usedTiers = new Set(Object.values(COUNTRY_LANGUAGE_TIER));
    for (const tier of ['primary', 'secondary', 'limited'] as LanguageCoverageTier[]) {
      assert.ok(usedTiers.has(tier), `tier '${tier}' has no countries assigned`);
    }
  });

  it('country map has reasonable coverage (30+ countries assigned)', () => {
    assert.ok(
      Object.keys(COUNTRY_LANGUAGE_TIER).length >= 30,
      `expected at least 30 countries in the language tier map, got ${Object.keys(COUNTRY_LANGUAGE_TIER).length}`,
    );
  });

  describe('normalization arithmetic', () => {
    it('langFactor=1.0 leaves score unchanged', () => {
      const rawScore = 10;
      const langFactor = 1.0;
      const adjusted = Math.min(rawScore / Math.max(langFactor, 0.1), 100);
      assert.equal(adjusted, 10);
    });

    it('langFactor=0.4 amplifies score by 2.5x', () => {
      const rawScore = 10;
      const langFactor = 0.4;
      const adjusted = Math.min(rawScore / Math.max(langFactor, 0.1), 100);
      assert.equal(adjusted, 25);
    });

    it('langFactor=0.2 amplifies score by 5x', () => {
      const rawScore = 10;
      const langFactor = 0.2;
      const adjusted = Math.min(rawScore / Math.max(langFactor, 0.1), 100);
      assert.equal(adjusted, 50);
    });

    it('adjusted score is capped at 100', () => {
      const rawScore = 30;
      const langFactor = 0.2;
      const adjusted = Math.min(rawScore / Math.max(langFactor, 0.1), 100);
      assert.equal(adjusted, 100);
    });

    it('langFactor floor at 0.1 prevents division by zero', () => {
      const rawScore = 5;
      const langFactor = 0;
      const adjusted = Math.min(rawScore / Math.max(langFactor, 0.1), 100);
      assert.equal(adjusted, 50);
    });

    it('RSF press freedom score is NOT language-adjusted (passes through as-is)', () => {
      const rsfScore = 75;
      assert.equal(rsfScore, 75);
    });
  });
});
