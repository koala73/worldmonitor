// Plan 2026-04-26-002 §U5 (combined PR 3+4+5) — pinning tests for the
// source-comprehensiveness flag.
//
// The flag discriminates which IMPUTE callers should fall back from the
// stable-absence anchor (85/0.6 or 88/0.7) to `unmonitored` (50/0.3) when
// the country is absent from a non-comprehensive source. These tests pin
// the registry's per-source classification AND the helper's lookup
// behavior so a future contributor can't silently flip a comprehensive
// flag without the test review surfacing the change.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INDICATOR_REGISTRY,
  isIndicatorComprehensive,
} from '../server/worldmonitor/resilience/v1/_indicator-registry';

describe('source-comprehensiveness flag (Plan 2026-04-26-002 §U5)', () => {
  it('every indicator entry carries an explicit `comprehensive` boolean', () => {
    for (const spec of INDICATOR_REGISTRY) {
      assert.equal(typeof spec.comprehensive, 'boolean',
        `indicator ${spec.id} must have comprehensive: boolean (got ${typeof spec.comprehensive})`);
    }
  });

  it('comprehensive=true pins canonical global-coverage sources', () => {
    // These ids MUST stay comprehensive=true. The plan's IMPUTE stable-
    // absence anchors (85/0.6, 88/0.7) only make sense if the source
    // really enumerates all UN-member countries.
    const mustBeComprehensive = [
      'ipcPeopleInCrisis',          // IPC food crisis
      'ipcPhase',                   // IPC phase
      'displacementTotal',          // UNHCR
      'displacementHosted',         // UNHCR
      'ucdpConflict',               // UCDP
      'fatfListingStatus',          // FATF (global registry)
      'recoveryConflictPressure',   // UCDP-derived
      'recoveryDisplacementVelocity', // UNHCR-derived
      'wgiVoiceAccountability',     // World Bank WGI
      'wgiPoliticalStability',
      'wgiGovernmentEffectiveness',
      'wgiRegulatoryQuality',
      'wgiRuleOfLaw',
      'wgiControlOfCorruption',
    ];
    for (const id of mustBeComprehensive) {
      assert.equal(isIndicatorComprehensive(id), true,
        `${id} must be comprehensive=true (canonical global-coverage source)`);
    }
  });

  it('comprehensive=false pins event-feed and curated-subset sources', () => {
    // These ids MUST stay comprehensive=false. They are event feeds,
    // English-biased social signals, or curated subsets where absence
    // does NOT mean "stable absence" — it means "we didn't measure this
    // country" (the unmonitored 50/0.3 anchor).
    const mustBeNonComprehensive = [
      'unrestEvents',               // GDELT-like event feed (load-bearing for §U5)
      'newsThreatScore',            // English-bias news summary
      'socialVelocity',             // Reddit (English-bias)
      'cyberThreats',               // event feed
      'internetOutages',            // event feed
      'gpsJamming',                 // event feed
      'shippingStress',             // real-time corridor monitor
      'transitDisruption',          // real-time corridor monitor
      'infraOutages',               // event feed
      'tradeRestrictions',          // WTO top-50 reporters
      'tradeBarriers',              // WTO top-50 reporters
      'householdDebtService',       // BIS DSR ~40 economies
      'fxVolatility',               // BIS EER ~64 economies
      'fxDeviation',                // BIS EER ~64 economies
      'bisLbsXborderPctGdp',        // BIS LBS by-parent reporters
      'financialCenterRedundancy',  // BIS LBS by-parent reporters
      'gasStorageStress',           // GIE AGSI+ EU+ subset
      'recoverySovereignWealthEffectiveMonths', // Wikipedia 8-fund manifest
      'recoveryFuelStockDays',      // RETIRED + IEA OECD-only
      'shortTermExternalDebtPctGni', // WB IDS LMIC-only (~125 countries); HIC absence is NOT a stable-absence signal
    ];
    for (const id of mustBeNonComprehensive) {
      assert.equal(isIndicatorComprehensive(id), false,
        `${id} must be comprehensive=false (event feed / curated subset / English-biased)`);
    }
  });

  it('isIndicatorComprehensive() returns false for unknown ids (conservative default)', () => {
    // Plan §risk-mitigation row: "when in doubt, mark `comprehensive: false`".
    // The helper applies the same conservative default for ids not in the
    // registry — falling back to `unmonitored` (50/0.3) is the safer error
    // mode if a typo/refactor breaks the lookup.
    assert.equal(isIndicatorComprehensive('thisIndicatorDoesNotExist'), false);
    assert.equal(isIndicatorComprehensive(''), false);
  });

  it('every comprehensive=true entry has coverage >= 100 (sanity gate)', () => {
    // A "comprehensive" source by definition enumerates most countries.
    // If a flag is true but coverage < 100, the flag is mis-tagged.
    for (const spec of INDICATOR_REGISTRY) {
      if (spec.comprehensive) {
        assert.ok(spec.coverage >= 100,
          `${spec.id}: comprehensive=true but coverage=${spec.coverage}. A truly comprehensive source should cover ≥100 countries; this is mis-tagged.`);
      }
    }
  });
});
