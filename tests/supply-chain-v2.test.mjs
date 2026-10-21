import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { MINERAL_PRODUCTION_2024 } from '../server/worldmonitor/supply-chain/v1/_minerals-data.ts';

// The v2 rollout assertions that used to open this file pinned proto field
// numbers, generated client types, OpenAPI paths, gateway tiers, panel markup
// and locale strings by regex. Every one of them restated a line of source, so
// they broke on rename and caught nothing; the shapes they described are
// enforced where they are actually load-bearing — generated types make a
// missing RPC a typecheck failure, and the dashboard boots in
// e2e/variant-live-smoke.spec.ts. What survives here is the scoring model and
// the minerals dataset, both of which are executable.

describe('supply-chain bootstrap cache keys', () => {
  it('serves chokepoints and minerals from their current key versions', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.chokepoints, 'supply_chain:chokepoints:v4');
    assert.equal(BOOTSTRAP_CACHE_KEYS.minerals, 'supply_chain:minerals:v2');
  });

  it('retires the superseded key versions from the registry', () => {
    const registry = JSON.stringify(BOOTSTRAP_CACHE_KEYS);
    assert.doesNotMatch(registry, /supply_chain:chokepoints:v1/);
    assert.doesNotMatch(registry, /supply_chain:minerals:v1/);
  });
});


describe('Minerals data structural integrity', () => {

  it('every entry has required fields', () => {
    assert.ok(MINERAL_PRODUCTION_2024.length > 0, 'dataset must not be empty');

    for (const entry of MINERAL_PRODUCTION_2024) {
      assert.ok(entry.mineral?.length > 0, 'mineral name should not be empty');
      assert.ok(entry.country?.length > 0, `country should not be empty for ${entry.mineral}`);
      assert.match(entry.countryCode ?? '', /^[A-Z]{2}$/, `countryCode should be ISO-2 for ${entry.country}`);
      assert.ok(
        Number.isFinite(entry.productionTonnes) && entry.productionTonnes > 0,
        `productionTonnes should be a positive number for ${entry.mineral}/${entry.country}`,
      );
      assert.ok(entry.unit?.length > 0, `unit should not be empty for ${entry.mineral}`);
    }
  });

  it('has at least 4 distinct minerals', () => {
    const minerals = new Set(MINERAL_PRODUCTION_2024.map((e) => e.mineral));
    assert.ok(minerals.size >= 4, `Expected ≥4 distinct minerals, found ${minerals.size}`);
  });

  it('each mineral has at least 2 producers', () => {
    const counts = new Map();
    for (const { mineral } of MINERAL_PRODUCTION_2024) {
      counts.set(mineral, (counts.get(mineral) ?? 0) + 1);
    }
    for (const [mineral, count] of counts) {
      assert.ok(count >= 2, `${mineral} has only ${count} producer(s), expected ≥2`);
    }
  });

  it('never lists the same producer country twice for one mineral', () => {
    // A duplicate would double-count that country's share and inflate the HHI
    // concentration score the panel renders.
    const seen = new Set();
    for (const { mineral, countryCode } of MINERAL_PRODUCTION_2024) {
      const key = `${mineral}:${countryCode}`;
      assert.ok(!seen.has(key), `duplicate producer ${countryCode} for ${mineral}`);
      seen.add(key);
    }
  });
});

// ========================================================================
// 13. Scoring module: verify integration with handler changes
// ========================================================================

import {
  computeDisruptionScore,
  scoreToStatus,
  computeHHI,
  riskRating,
  detectSpike,
  THREAT_LEVEL,
  warningComponent,
  aisComponent,
} from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

describe('Scoring integration with v2 minerals (top-3 slicing)', () => {
  it('HHI with 3 producers sums correctly', () => {
    const totalGallium = 600 + 10 + 8 + 5;
    const shares = [600, 10, 8].map(t => (t / totalGallium) * 100);
    const hhi = computeHHI(shares);
    assert.ok(hhi > 9000, `Gallium HHI should be >9000 (got ${hhi})`);
    assert.equal(riskRating(hhi), 'critical');
  });

  it('HHI with 3 balanced producers yields moderate', () => {
    const hhi = computeHHI([33.3, 33.3, 33.3]);
    assert.ok(hhi > 3000 && hhi < 3400, `Balanced 3-way HHI should be ~3333 (got ${hhi})`);
    assert.equal(riskRating(hhi), 'high');
  });
});

// ========================================================================
// 13b. Decomposed chokepoint scoring model
// ========================================================================

describe('Threat level constants', () => {
  it('war_zone = 70, critical = 40, high = 30, elevated = 15, normal = 0', () => {
    assert.equal(THREAT_LEVEL.war_zone, 70);
    assert.equal(THREAT_LEVEL.critical, 40);
    assert.equal(THREAT_LEVEL.high, 30);
    assert.equal(THREAT_LEVEL.elevated, 15);
    assert.equal(THREAT_LEVEL.normal, 0);
  });
});

describe('Warning component (0-15)', () => {
  it('0 warnings → 0', () => assert.equal(warningComponent(0), 0));
  it('1 warning → 5', () => assert.equal(warningComponent(1), 5));
  it('2 warnings → 10', () => assert.equal(warningComponent(2), 10));
  it('3 warnings → 15 (cap)', () => assert.equal(warningComponent(3), 15));
  it('10 warnings → 15 (still capped)', () => assert.equal(warningComponent(10), 15));
});

describe('AIS component (0-15)', () => {
  it('severity 0 → 0', () => assert.equal(aisComponent(0), 0));
  it('severity 1 (low) → 5', () => assert.equal(aisComponent(1), 5));
  it('severity 2 (elevated) → 10', () => assert.equal(aisComponent(2), 10));
  it('severity 3 (high) → 15', () => assert.equal(aisComponent(3), 15));
});

describe('Composite disruption score', () => {
  it('normal threat + no data = 0 (green)', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.normal, 0, 0);
    assert.equal(score, 0);
    assert.equal(scoreToStatus(score), 'green');
  });

  it('normal threat + 1 warning = 5 (green)', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.normal, 1, 0);
    assert.equal(score, 5);
    assert.equal(scoreToStatus(score), 'green');
  });

  it('elevated threat + no data = 15 (green)', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.elevated, 0, 0);
    assert.equal(score, 15);
    assert.equal(scoreToStatus(score), 'green');
  });

  it('elevated threat + 1 warning = 20 (yellow)', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.elevated, 1, 0);
    assert.equal(score, 20);
    assert.equal(scoreToStatus(score), 'yellow');
  });

  it('high threat + no data = 30 (yellow) — Suez baseline', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.high, 0, 0);
    assert.equal(score, 30);
    assert.equal(scoreToStatus(score), 'yellow');
  });

  it('critical threat + no data = 40 (yellow) — Bab el-Mandeb baseline', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.critical, 0, 0);
    assert.equal(score, 40);
    assert.equal(scoreToStatus(score), 'yellow');
  });

  it('critical threat + 2 warnings = 50 (red)', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.critical, 2, 0);
    assert.equal(score, 50);
    assert.equal(scoreToStatus(score), 'red');
  });

  it('war_zone + no data = 70 (red) — Hormuz baseline', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.war_zone, 0, 0);
    assert.equal(score, 70);
    assert.equal(scoreToStatus(score), 'red');
  });

  it('war_zone + 2 warnings + elevated AIS = 90', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.war_zone, 2, 2);
    assert.equal(score, 90);  // 70 + 10 + 10
    assert.equal(scoreToStatus(score), 'red');
  });

  it('war_zone + max warnings + max AIS = 100', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.war_zone, 3, 3);
    assert.equal(score, 100);  // 70 + 15 + 15
  });

  it('overflow clamps at 100', () => {
    const score = computeDisruptionScore(THREAT_LEVEL.war_zone, 10, 3);
    assert.equal(score, 100);
  });
});

// ========================================================================
// 14. Chokepoint threat config + expanded keywords (behavioural)
// ========================================================================

import { CHOKEPOINTS, THREAT_CONFIG_LAST_REVIEWED } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';

const cpById = Object.fromEntries(CHOKEPOINTS.map(cp => [cp.id, cp]));

describe('Chokepoint threat level config', () => {
  it('exports all 13 chokepoints', () => {
    assert.equal(CHOKEPOINTS.length, 13);
    assert.ok(cpById.suez);
    assert.ok(cpById.malacca_strait);
    assert.ok(cpById.hormuz_strait);
    assert.ok(cpById.bab_el_mandeb);
    assert.ok(cpById.panama);
    assert.ok(cpById.korea_strait);
    assert.ok(cpById.dover_strait);
    assert.ok(cpById.kerch_strait);
    assert.ok(cpById.lombok_strait);
    assert.ok(cpById.taiwan_strait);
    assert.ok(cpById.cape_of_good_hope);
    assert.ok(cpById.gibraltar);
    assert.ok(cpById.bosphorus);
  });

  it('every entry has required fields', () => {
    for (const cp of CHOKEPOINTS) {
      assert.ok(cp.id, 'missing id');
      assert.ok(cp.name, 'missing name');
      assert.ok(typeof cp.lat === 'number', 'lat must be number');
      assert.ok(typeof cp.lon === 'number', 'lon must be number');
      assert.ok(cp.areaKeywords.length > 0, `${cp.id}: no areaKeywords`);
      assert.ok(cp.routes.length > 0, `${cp.id}: no routes`);
      assert.ok(['war_zone', 'critical', 'high', 'elevated', 'normal'].includes(cp.threatLevel),
        `${cp.id}: invalid threatLevel "${cp.threatLevel}"`);
    }
  });

  it('Hormuz uses war_zone threat level', () => {
    assert.equal(cpById.hormuz_strait.threatLevel, 'war_zone');
  });

  it('Bab el-Mandeb uses critical threat level', () => {
    assert.equal(cpById.bab_el_mandeb.threatLevel, 'critical');
  });

  it('Suez uses high threat level', () => {
    assert.equal(cpById.suez.threatLevel, 'high');
  });

  it('Taiwan uses elevated threat level', () => {
    assert.equal(cpById.taiwan_strait.threatLevel, 'elevated');
  });

  it('Malacca and Panama use normal threat level', () => {
    assert.equal(cpById.malacca_strait.threatLevel, 'normal');
    assert.equal(cpById.panama.threatLevel, 'normal');
  });

  it('Hormuz threatDescription mentions Iran-Israel war', () => {
    assert.ok(cpById.hormuz_strait.threatDescription.includes('Iran-Israel'));
  });

  it('Bab el-Mandeb threatDescription mentions Houthi', () => {
    assert.ok(cpById.bab_el_mandeb.threatDescription.includes('Houthi'));
  });

  it('Malacca and Panama have empty threatDescription', () => {
    assert.equal(cpById.malacca_strait.threatDescription, '');
    assert.equal(cpById.panama.threatDescription, '');
  });

  it('Hormuz areaKeywords include gulf of oman and strait of hormuz', () => {
    assert.ok(cpById.hormuz_strait.areaKeywords.includes('gulf of oman'));
    assert.ok(cpById.hormuz_strait.areaKeywords.includes('strait of hormuz'));
  });

  it('Bab el-Mandeb areaKeywords include houthi and yemen', () => {
    assert.ok(cpById.bab_el_mandeb.areaKeywords.includes('houthi'));
    assert.ok(cpById.bab_el_mandeb.areaKeywords.includes('yemen'));
  });

  it('Taiwan areaKeywords include south china sea', () => {
    assert.ok(cpById.taiwan_strait.areaKeywords.includes('south china sea'));
  });

  it('descriptions reference JWC for listed areas', () => {
    const jwcEntries = CHOKEPOINTS.filter(cp => cp.threatDescription.includes('JWC Listed Area'));
    assert.ok(jwcEntries.length >= 2, 'Expected at least 2 JWC Listed Area entries');
  });

  it('THREAT_CONFIG_LAST_REVIEWED is a valid ISO date string', () => {
    assert.ok(THREAT_CONFIG_LAST_REVIEWED, 'THREAT_CONFIG_LAST_REVIEWED should be exported');
    assert.ok(!Number.isNaN(Date.parse(THREAT_CONFIG_LAST_REVIEWED)),
      'THREAT_CONFIG_LAST_REVIEWED should be a valid date');
  });
});
