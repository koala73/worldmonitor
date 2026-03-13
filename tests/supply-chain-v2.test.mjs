/**
 * Tests for supply-chain v2/v3 changes:
 *
 * - Proto: ais_disruptions field added to ChokepointInfo (v2)
 * - Proto: directions field added to ChokepointInfo (v3)
 * - Proto: DirectionalDwt message + directional_dwt field on ChokepointInfo (v3)
 * - Cache keys bumped to v3 for chokepoints
 * - Chokepoint handler: Cape of Good Hope, Gibraltar, Bosphorus, Dardanelles added (v3)
 * - Chokepoint handler: directions + directionalDwt fields (v3)
 * - Chokepoint handler: description format, aisDisruptions output, rename, TTL
 * - Minerals handler: top-3 producers, Nickel/Copper removed, v2 cache
 * - Shipping handler: updated series names
 * - Gateway: new 'daily' cache tier, minerals moved to daily
 * - Service client: circuit breaker TTLs aligned
 * - SupplyChainPanel: unavailable banner logic, AIS disruption display, directions display
 * - Locale: tab labels updated
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. Proto: ais_disruptions field
// ========================================================================

describe('ChokepointInfo proto has ais_disruptions field', () => {
  const proto = readSrc('proto/worldmonitor/supply_chain/v1/supply_chain_data.proto');

  it('declares ais_disruptions as int32 at field 11', () => {
    assert.match(proto, /int32\s+ais_disruptions\s*=\s*11/,
      'ais_disruptions field should be int32 at field number 11');
  });

  it('still has all original ChokepointInfo fields', () => {
    assert.match(proto, /string id\s*=\s*1/);
    assert.match(proto, /string name\s*=\s*2/);
    assert.match(proto, /double lat\s*=\s*3/);
    assert.match(proto, /double lon\s*=\s*4/);
    assert.match(proto, /int32 disruption_score\s*=\s*5/);
    assert.match(proto, /string status\s*=\s*6/);
    assert.match(proto, /int32 active_warnings\s*=\s*7/);
    assert.match(proto, /string congestion_level\s*=\s*8/);
    assert.match(proto, /repeated string affected_routes\s*=\s*9/);
    assert.match(proto, /string description\s*=\s*10/);
  });

  it('declares directions as repeated string at field 12', () => {
    assert.match(proto, /repeated\s+string\s+directions\s*=\s*12/,
      'directions field should be repeated string at field number 12');
  });

  it('declares directional_dwt as repeated DirectionalDwt at field 13', () => {
    assert.match(proto, /repeated\s+DirectionalDwt\s+directional_dwt\s*=\s*13/,
      'directional_dwt field should be repeated DirectionalDwt at field number 13');
  });

  it('defines DirectionalDwt message with direction, dwt_thousand_tonnes, wow_change_pct', () => {
    assert.match(proto, /message\s+DirectionalDwt/);
    assert.match(proto, /string\s+direction\s*=\s*1/);
    assert.match(proto, /double\s+dwt_thousand_tonnes\s*=\s*2/);
    assert.match(proto, /double\s+wow_change_pct\s*=\s*3/);
  });
});

// ========================================================================
// 2. Generated types include aisDisruptions
// ========================================================================

describe('Generated types include aisDisruptions', () => {
  const clientSrc = readSrc('src/generated/client/worldmonitor/supply_chain/v1/service_client.ts');
  const serverSrc = readSrc('src/generated/server/worldmonitor/supply_chain/v1/service_server.ts');

  it('client ChokepointInfo has aisDisruptions: number', () => {
    assert.match(clientSrc, /aisDisruptions:\s*number/,
      'Client type must include aisDisruptions field');
  });

  it('server ChokepointInfo has aisDisruptions: number', () => {
    assert.match(serverSrc, /aisDisruptions:\s*number/,
      'Server type must include aisDisruptions field');
  });

  it('client ChokepointInfo has directions: string[]', () => {
    assert.match(clientSrc, /directions:\s*string\[\]/,
      'Client type must include directions field');
  });

  it('server ChokepointInfo has directions: string[]', () => {
    assert.match(serverSrc, /directions:\s*string\[\]/,
      'Server type must include directions field');
  });

  it('client ChokepointInfo has directionalDwt: DirectionalDwt[]', () => {
    assert.match(clientSrc, /directionalDwt:\s*DirectionalDwt\[\]/,
      'Client type must include directionalDwt field');
  });

  it('server ChokepointInfo has directionalDwt: DirectionalDwt[]', () => {
    assert.match(serverSrc, /directionalDwt:\s*DirectionalDwt\[\]/,
      'Server type must include directionalDwt field');
  });

  it('client defines DirectionalDwt interface', () => {
    assert.match(clientSrc, /interface\s+DirectionalDwt/);
    assert.match(clientSrc, /dwtThousandTonnes:\s*number/);
    assert.match(clientSrc, /wowChangePct:\s*number/);
  });

  it('server defines DirectionalDwt interface', () => {
    assert.match(serverSrc, /interface\s+DirectionalDwt/);
    assert.match(serverSrc, /dwtThousandTonnes:\s*number/);
    assert.match(serverSrc, /wowChangePct:\s*number/);
  });
});

// ========================================================================
// 3. OpenAPI spec includes aisDisruptions
// ========================================================================

describe('OpenAPI spec includes aisDisruptions', () => {
  const jsonSpec = readSrc('docs/api/SupplyChainService.openapi.json');
  const yamlSpec = readSrc('docs/api/SupplyChainService.openapi.yaml');

  it('JSON spec has aisDisruptions property on ChokepointInfo', () => {
    const parsed = JSON.parse(jsonSpec);
    const cpSchema = parsed.components.schemas.ChokepointInfo;
    assert.ok(cpSchema.properties.aisDisruptions, 'aisDisruptions missing from JSON spec');
    assert.equal(cpSchema.properties.aisDisruptions.type, 'integer');
    assert.equal(cpSchema.properties.aisDisruptions.format, 'int32');
  });

  it('YAML spec has aisDisruptions property', () => {
    assert.match(yamlSpec, /aisDisruptions:/, 'aisDisruptions missing from YAML spec');
    assert.match(yamlSpec, /aisDisruptions:\s*\n\s*type:\s*integer/, 'YAML aisDisruptions should be type integer');
  });

  it('JSON spec has directions property on ChokepointInfo', () => {
    const parsed = JSON.parse(jsonSpec);
    const cpSchema = parsed.components.schemas.ChokepointInfo;
    assert.ok(cpSchema.properties.directions, 'directions missing from JSON spec');
    assert.equal(cpSchema.properties.directions.type, 'array');
    assert.equal(cpSchema.properties.directions.items.type, 'string');
  });

  it('YAML spec has directions property', () => {
    assert.match(yamlSpec, /directions:/, 'directions missing from YAML spec');
  });

  it('JSON spec has directionalDwt property on ChokepointInfo', () => {
    const parsed = JSON.parse(jsonSpec);
    const cpSchema = parsed.components.schemas.ChokepointInfo;
    assert.ok(cpSchema.properties.directionalDwt, 'directionalDwt missing from JSON spec');
    assert.equal(cpSchema.properties.directionalDwt.type, 'array');
  });

  it('JSON spec defines DirectionalDwt schema', () => {
    const parsed = JSON.parse(jsonSpec);
    const dwtSchema = parsed.components.schemas.DirectionalDwt;
    assert.ok(dwtSchema, 'DirectionalDwt schema missing from JSON spec');
    assert.ok(dwtSchema.properties.direction);
    assert.ok(dwtSchema.properties.dwtThousandTonnes);
    assert.ok(dwtSchema.properties.wowChangePct);
  });

  it('YAML spec has DirectionalDwt schema', () => {
    assert.match(yamlSpec, /DirectionalDwt:/, 'DirectionalDwt schema missing from YAML spec');
    assert.match(yamlSpec, /dwtThousandTonnes:/, 'dwtThousandTonnes missing from YAML spec');
    assert.match(yamlSpec, /wowChangePct:/, 'wowChangePct missing from YAML spec');
  });
});

// ========================================================================
// 4. Cache keys bumped to v2
// ========================================================================

describe('Cache keys bumped to v2', () => {
  const bootstrapSrc = readSrc('api/bootstrap.js');
  const cacheKeysSrc = readSrc('server/_shared/cache-keys.ts');
  const chokepointSrc = readSrc('server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts');
  const mineralsSrc = readSrc('server/worldmonitor/supply-chain/v1/get-critical-minerals.ts');

  it('bootstrap.js chokepoints key is v2', () => {
    assert.match(bootstrapSrc, /chokepoints:\s*'supply_chain:chokepoints:v3'/);
  });

  it('bootstrap.js minerals key is v2', () => {
    assert.match(bootstrapSrc, /minerals:\s*'supply_chain:minerals:v2'/);
  });

  it('cache-keys.ts chokepoints key is v2', () => {
    assert.match(cacheKeysSrc, /chokepoints:\s*'supply_chain:chokepoints:v3'/);
  });

  it('cache-keys.ts minerals key is v2', () => {
    assert.match(cacheKeysSrc, /minerals:\s*'supply_chain:minerals:v2'/);
  });

  it('chokepoint handler uses v2 redis key', () => {
    assert.match(chokepointSrc, /REDIS_CACHE_KEY\s*=\s*'supply_chain:chokepoints:v3'/);
  });

  it('minerals handler uses v2 redis key', () => {
    assert.match(mineralsSrc, /REDIS_CACHE_KEY\s*=\s*'supply_chain:minerals:v2'/);
  });

  it('no v1 cache keys remain for chokepoints or minerals', () => {
    assert.doesNotMatch(bootstrapSrc, /supply_chain:chokepoints:v1/);
    assert.doesNotMatch(bootstrapSrc, /supply_chain:minerals:v1/);
    assert.doesNotMatch(cacheKeysSrc, /supply_chain:chokepoints:v1/);
    assert.doesNotMatch(cacheKeysSrc, /supply_chain:minerals:v1/);
  });
});

// ========================================================================
// 5. Chokepoint handler: description format, aisDisruptions, TTL, rename
// ========================================================================

describe('Chokepoint handler v2 changes', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts');

  it('uses 5-minute Redis TTL', () => {
    assert.match(src, /REDIS_CACHE_TTL\s*=\s*300/,
      'Chokepoint Redis TTL should be 300s (5 min)');
  });

  it('uses "Strait of Malacca" (not "Malacca Strait")', () => {
    assert.match(src, /Strait of Malacca/);
    assert.doesNotMatch(src, /name:\s*'Malacca Strait'/);
  });

  it('emits aisDisruptions in the response object', () => {
    assert.match(src, /aisDisruptions:\s*matchedDisruptions\.length/,
      'Should set aisDisruptions to matchedDisruptions.length');
  });

  it('description includes warning and disruption counts when present', () => {
    assert.match(src, /Navigational warnings:\s*\$\{matchedWarnings\.length\}/);
    assert.match(src, /AIS vessel disruptions:\s*\$\{matchedDisruptions\.length\}/);
  });

  it('description shows threatDescription when set', () => {
    assert.match(src, /cp\.threatDescription/,
      'Should use cp.threatDescription in description logic');
  });

  it('description does not use vague "AIS congestion detected" phrasing', () => {
    assert.doesNotMatch(src, /AIS congestion detected/,
      'Old vague description removed');
  });

  it('includes all 10 chokepoints', () => {
    assert.match(src, /id:\s*'suez'/);
    assert.match(src, /id:\s*'malacca'/);
    assert.match(src, /id:\s*'hormuz'/);
    assert.match(src, /id:\s*'bab_el_mandeb'/);
    assert.match(src, /id:\s*'panama'/);
    assert.match(src, /id:\s*'taiwan'/);
    assert.match(src, /id:\s*'cape_of_good_hope'/);
    assert.match(src, /id:\s*'gibraltar'/);
    assert.match(src, /id:\s*'bosphorus'/);
    assert.match(src, /id:\s*'dardanelles'/);
  });

  it('emits directions array in the response object', () => {
    assert.match(src, /directions:\s*cp\.directions/,
      'Should set directions from cp.directions');
  });

  it('emits directionalDwt array in the response object', () => {
    assert.match(src, /directionalDwt:/,
      'Should emit directionalDwt in the response');
  });
});

// ========================================================================
// 6. Minerals handler: top-3 producers, removed Nickel/Copper
// ========================================================================

describe('Minerals handler v2 changes', () => {
  const handlerSrc = readSrc('server/worldmonitor/supply-chain/v1/get-critical-minerals.ts');
  const dataSrc = readSrc('server/worldmonitor/supply-chain/v1/_minerals-data.ts');

  it('slices to top 3 producers (not 5)', () => {
    assert.match(handlerSrc, /\.slice\(0,\s*3\)/,
      'Should slice top producers to 3');
    assert.doesNotMatch(handlerSrc, /\.slice\(0,\s*5\)/,
      'Old slice(0,5) should be removed');
  });

  it('minerals data does not contain Nickel', () => {
    assert.doesNotMatch(dataSrc, /mineral:\s*'Nickel'/,
      'Nickel should be removed from minerals data');
  });

  it('minerals data does not contain Copper', () => {
    assert.doesNotMatch(dataSrc, /mineral:\s*'Copper'/,
      'Copper should be removed from minerals data');
  });

  it('minerals data still contains core weaponizable minerals', () => {
    assert.match(dataSrc, /mineral:\s*'Lithium'/);
    assert.match(dataSrc, /mineral:\s*'Cobalt'/);
    assert.match(dataSrc, /mineral:\s*'Rare Earths'/);
    assert.match(dataSrc, /mineral:\s*'Gallium'/);
    assert.match(dataSrc, /mineral:\s*'Germanium'/);
  });

  it('uses 86400s Redis TTL (24h)', () => {
    assert.match(handlerSrc, /REDIS_CACHE_TTL\s*=\s*86400/);
  });
});

// ========================================================================
// 7. Shipping handler: updated series names
// ========================================================================

describe('Shipping handler v2 changes', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/get-shipping-rates.ts');

  it('uses full name "Deep Sea Freight Producer Price Index"', () => {
    assert.match(src, /Deep Sea Freight Producer Price Index/);
    assert.doesNotMatch(src, /name:\s*'Deep Sea Freight PPI'/);
  });

  it('uses full name "Freight Transportation Services Index"', () => {
    assert.match(src, /Freight Transportation Services Index/);
    assert.doesNotMatch(src, /name:\s*'Freight Transportation Index'/);
  });

  it('still fetches series PCU483111483111 and TSIFRGHT', () => {
    assert.match(src, /PCU483111483111/);
    assert.match(src, /TSIFRGHT/);
  });
});

// ========================================================================
// 8. Gateway: 'daily' cache tier
// ========================================================================

describe('Gateway daily cache tier', () => {
  const src = readSrc('server/gateway.ts');

  it('CacheTier type includes daily', () => {
    assert.match(src, /'daily'/,
      'daily tier should be defined');
  });

  it('daily tier has 86400s s-maxage', () => {
    assert.match(src, /daily.*s-maxage=86400/,
      'daily tier should have s-maxage=86400');
  });

  it('critical minerals route uses daily tier', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-critical-minerals':\s*'daily'/);
  });

  it('critical minerals route does NOT use static tier', () => {
    assert.doesNotMatch(src, /\/api\/supply-chain\/v1\/get-critical-minerals':\s*'static'/);
  });

  it('chokepoint status route still uses medium tier', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-chokepoint-status':\s*'medium'/);
  });

  it('shipping rates route still uses static tier', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/get-shipping-rates':\s*'static'/);
  });
});

// ========================================================================
// 9. Client service: circuit breaker TTLs
// ========================================================================

describe('Client-side circuit breaker TTLs', () => {
  const src = readSrc('src/services/supply-chain/index.ts');

  it('shipping breaker uses 1 hour TTL', () => {
    assert.match(src, /name:\s*'Shipping Rates'.*cacheTtlMs:\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('chokepoint breaker uses 5 min TTL', () => {
    assert.match(src, /name:\s*'Chokepoint Status'.*cacheTtlMs:\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('minerals breaker uses 24 hour TTL', () => {
    assert.match(src, /name:\s*'Critical Minerals'.*cacheTtlMs:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

// ========================================================================
// 10. SupplyChainPanel: unavailable banner + AIS disruptions display
// ========================================================================

describe('SupplyChainPanel v2 changes', () => {
  const src = readSrc('src/components/SupplyChainPanel.ts');

  it('unavailable banner requires !activeHasData guard', () => {
    assert.match(src, /!activeHasData\s*&&\s*activeData\?\.upstreamUnavailable/,
      'Banner should only show when there is no data AND upstream is unavailable');
  });

  it('computes activeHasData for each tab', () => {
    assert.match(src, /activeHasData/);
    assert.match(src, /chokepointData\?\.chokepoints\?\.length/);
    assert.match(src, /shippingData\?\.indices\?\.length/);
    assert.match(src, /mineralsData\?\.minerals\?\.length/);
  });

  it('displays AIS disruption count per chokepoint via i18n', () => {
    assert.match(src, /aisDisruptions/);
    assert.match(src, /t\('components\.supplyChain\.aisDisruptions'\)/);
  });

  it('has fallback for aisDisruptions when absent (v1 cache compat)', () => {
    assert.match(src, /cp\.aisDisruptions\s*\?\?\s*\(/,
      'Should have nullish coalescing fallback for aisDisruptions');
  });

  it('displays directions when present', () => {
    assert.match(src, /cp\.directions/,
      'Should reference cp.directions in the chokepoint card');
  });

  it('displays directionalDwt when DWT data is present', () => {
    assert.match(src, /cp\.directionalDwt/,
      'Should reference cp.directionalDwt in the chokepoint card');
    assert.match(src, /dwtThousandTonnes/,
      'Should display DWT thousand tonnes');
    assert.match(src, /wowChangePct/,
      'Should display week-over-week change');
  });

  it('uses i18n key for DWT departures label', () => {
    assert.match(src, /t\('components\.supplyChain\.dwtDepartures'\)/);
  });
});

// ========================================================================
// 11. Locale strings updated
// ========================================================================

describe('Locale tab labels updated', () => {
  const en = readSrc('src/locales/en.json');
  const parsed = JSON.parse(en);
  const sc = parsed.components.supplyChain;

  it('shipping tab says "Shipping Rates"', () => {
    assert.equal(sc.shipping, 'Shipping Rates');
  });

  it('minerals tab says "Critical Minerals"', () => {
    assert.equal(sc.minerals, 'Critical Minerals');
  });

  it('chokepoints tab unchanged', () => {
    assert.equal(sc.chokepoints, 'Chokepoints');
  });
});

// ========================================================================
// 12. Minerals data: structural validation
// ========================================================================

describe('Minerals data structural integrity', () => {
  // Direct import of the .mjs-compatible scoring, then validate against data file
  const dataSrc = readSrc('server/worldmonitor/supply-chain/v1/_minerals-data.ts');

  it('every entry has required fields', () => {
    // Parse entries from the source to validate structure
    const entryPattern = /\{\s*mineral:\s*'([^']+)',\s*country:\s*'([^']+)',\s*countryCode:\s*'([A-Z]{2})',\s*productionTonnes:\s*(\d+),\s*unit:\s*'([^']+)'\s*\}/g;
    const entries = [];
    let m;
    while ((m = entryPattern.exec(dataSrc)) !== null) {
      entries.push({ mineral: m[1], country: m[2], countryCode: m[3], productionTonnes: Number(m[4]), unit: m[5] });
    }

    assert.ok(entries.length > 0, 'Should find mineral entries in data file');

    for (const entry of entries) {
      assert.ok(entry.mineral.length > 0, `mineral name should not be empty`);
      assert.ok(entry.country.length > 0, `country should not be empty for ${entry.mineral}`);
      assert.equal(entry.countryCode.length, 2, `countryCode should be ISO-2 for ${entry.country}`);
      assert.ok(entry.productionTonnes > 0, `productionTonnes should be positive for ${entry.mineral}/${entry.country}`);
      assert.ok(entry.unit.length > 0, `unit should not be empty for ${entry.mineral}`);
    }
  });

  it('has at least 4 distinct minerals', () => {
    const mineralPattern = /mineral:\s*'([^']+)'/g;
    const minerals = new Set();
    let m;
    while ((m = mineralPattern.exec(dataSrc)) !== null) {
      minerals.add(m[1]);
    }
    assert.ok(minerals.size >= 4, `Expected ≥4 distinct minerals, found ${minerals.size}: ${[...minerals].join(', ')}`);
  });

  it('each mineral has at least 2 producers', () => {
    const entryPattern = /mineral:\s*'([^']+)'/g;
    const counts = {};
    let m;
    while ((m = entryPattern.exec(dataSrc)) !== null) {
      counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    for (const [mineral, count] of Object.entries(counts)) {
      assert.ok(count >= 2, `${mineral} has only ${count} producer(s), expected ≥2`);
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
// 13c. DWT upstream module structure
// ========================================================================

describe('DWT upstream module', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/_dwt-upstream.ts');

  it('uses SP_GLOBAL_API_KEY env variable', () => {
    assert.match(src, /process\.env\.SP_GLOBAL_API_KEY/);
  });

  it('uses SP_GLOBAL_BASE_URL env variable with default', () => {
    assert.match(src, /process\.env\.SP_GLOBAL_BASE_URL/);
    assert.match(src, /api\.spglobal\.com\/maritime\/v1/);
  });

  it('uses Redis caching via cachedFetchJson', () => {
    assert.match(src, /cachedFetchJson/);
    assert.match(src, /supply_chain:dwt_departures:v1/);
  });

  it('returns null when API key is not configured', () => {
    assert.match(src, /if\s*\(\s*!SP_GLOBAL_API_KEY\s*\)\s*return\s*null/);
  });

  it('uses Bearer token authentication', () => {
    assert.match(src, /Authorization.*Bearer/);
  });

  it('has 15-second fetch timeout', () => {
    assert.match(src, /15[_]?000/);
  });

  it('exports getDwtDepartures function', () => {
    assert.match(src, /export\s+async\s+function\s+getDwtDepartures/);
  });

  it('exports ChokepointDwtData and DwtDataPoint types', () => {
    assert.match(src, /export\s+interface\s+ChokepointDwtData/);
    assert.match(src, /export\s+interface\s+DwtDataPoint/);
  });

  it('maps all 10 chokepoint IDs to S&P Global slugs', () => {
    assert.match(src, /suez:\s*'suez-canal'/);
    assert.match(src, /malacca:\s*'malacca-strait'/);
    assert.match(src, /hormuz:\s*'hormuz-strait'/);
    assert.match(src, /bab_el_mandeb:\s*'bab-el-mandeb'/);
    assert.match(src, /panama:\s*'panama-canal'/);
    assert.match(src, /taiwan:\s*'taiwan-strait'/);
    assert.match(src, /cape_of_good_hope:\s*'cape-good-hope'/);
    assert.match(src, /gibraltar:\s*'gibraltar-strait'/);
    assert.match(src, /bosphorus:\s*'bosphorus-strait'/);
    assert.match(src, /dardanelles:\s*'dardanelles-strait'/);
  });

  it('uses 1-hour Redis TTL', () => {
    assert.match(src, /REDIS_CACHE_TTL\s*=\s*3600/);
  });
});

// ========================================================================
// 13d. Chokepoint handler integrates DWT upstream
// ========================================================================

describe('Chokepoint handler DWT integration', () => {
  const src = readSrc('server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts');

  it('imports getDwtDepartures from _dwt-upstream', () => {
    assert.match(src, /import.*getDwtDepartures.*from.*_dwt-upstream/);
  });

  it('fetches DWT data in parallel with nav warnings and vessel snapshot', () => {
    assert.match(src, /getDwtDepartures\(\)/);
    assert.match(src, /Promise\.all\(/);
  });

  it('uses buildDirectionalDwt helper to merge upstream data', () => {
    assert.match(src, /buildDirectionalDwt/);
  });
});

// ========================================================================
// 14. Chokepoint threat config + expanded keywords (behavioural)
// ========================================================================

import { CHOKEPOINTS, THREAT_CONFIG_LAST_REVIEWED } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';

const cpById = Object.fromEntries(CHOKEPOINTS.map(cp => [cp.id, cp]));

describe('Chokepoint threat level config', () => {
  it('exports all 10 chokepoints', () => {
    assert.equal(CHOKEPOINTS.length, 10);
    assert.ok(cpById.suez);
    assert.ok(cpById.malacca);
    assert.ok(cpById.hormuz);
    assert.ok(cpById.bab_el_mandeb);
    assert.ok(cpById.panama);
    assert.ok(cpById.taiwan);
    assert.ok(cpById.cape_of_good_hope);
    assert.ok(cpById.gibraltar);
    assert.ok(cpById.bosphorus);
    assert.ok(cpById.dardanelles);
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
    assert.equal(cpById.hormuz.threatLevel, 'war_zone');
  });

  it('Bab el-Mandeb uses critical threat level', () => {
    assert.equal(cpById.bab_el_mandeb.threatLevel, 'critical');
  });

  it('Suez uses high threat level', () => {
    assert.equal(cpById.suez.threatLevel, 'high');
  });

  it('Taiwan, Bosphorus, and Dardanelles use elevated threat level', () => {
    assert.equal(cpById.taiwan.threatLevel, 'elevated');
    assert.equal(cpById.bosphorus.threatLevel, 'elevated');
    assert.equal(cpById.dardanelles.threatLevel, 'elevated');
  });

  it('Malacca, Panama, Cape of Good Hope, and Gibraltar use normal threat level', () => {
    assert.equal(cpById.malacca.threatLevel, 'normal');
    assert.equal(cpById.panama.threatLevel, 'normal');
    assert.equal(cpById.cape_of_good_hope.threatLevel, 'normal');
    assert.equal(cpById.gibraltar.threatLevel, 'normal');
  });

  it('Hormuz threatDescription mentions Iran-Israel war', () => {
    assert.ok(cpById.hormuz.threatDescription.includes('Iran-Israel'));
  });

  it('Bab el-Mandeb threatDescription mentions Houthi', () => {
    assert.ok(cpById.bab_el_mandeb.threatDescription.includes('Houthi'));
  });

  it('Malacca, Panama, Cape of Good Hope, and Gibraltar have empty threatDescription', () => {
    assert.equal(cpById.malacca.threatDescription, '');
    assert.equal(cpById.panama.threatDescription, '');
    assert.equal(cpById.cape_of_good_hope.threatDescription, '');
    assert.equal(cpById.gibraltar.threatDescription, '');
  });

  it('Bosphorus threatDescription mentions Montreux', () => {
    assert.ok(cpById.bosphorus.threatDescription.includes('Montreux'));
  });

  it('Dardanelles threatDescription mentions Montreux', () => {
    assert.ok(cpById.dardanelles.threatDescription.includes('Montreux'));
  });

  it('Bosphorus areaKeywords include istanbul and black sea', () => {
    assert.ok(cpById.bosphorus.areaKeywords.includes('istanbul'));
    assert.ok(cpById.bosphorus.areaKeywords.includes('black sea'));
  });

  it('Dardanelles areaKeywords include gallipoli and aegean', () => {
    assert.ok(cpById.dardanelles.areaKeywords.includes('gallipoli'));
    assert.ok(cpById.dardanelles.areaKeywords.includes('aegean'));
  });

  it('Bosphorus and Dardanelles use northbound/southbound', () => {
    assert.deepEqual(cpById.bosphorus.directions, ['northbound', 'southbound']);
    assert.deepEqual(cpById.dardanelles.directions, ['northbound', 'southbound']);
  });

  it('Hormuz areaKeywords include gulf of oman and strait of hormuz', () => {
    assert.ok(cpById.hormuz.areaKeywords.includes('gulf of oman'));
    assert.ok(cpById.hormuz.areaKeywords.includes('strait of hormuz'));
  });

  it('Bab el-Mandeb areaKeywords include houthi and yemen', () => {
    assert.ok(cpById.bab_el_mandeb.areaKeywords.includes('houthi'));
    assert.ok(cpById.bab_el_mandeb.areaKeywords.includes('yemen'));
  });

  it('Taiwan areaKeywords include south china sea', () => {
    assert.ok(cpById.taiwan.areaKeywords.includes('south china sea'));
  });

  it('descriptions reference JWC for listed areas', () => {
    const jwcEntries = CHOKEPOINTS.filter(cp => cp.threatDescription.includes('JWC Listed Area'));
    assert.ok(jwcEntries.length >= 2, 'Expected at least 2 JWC Listed Area entries');
  });

  it('THREAT_CONFIG_LAST_REVIEWED is a valid ISO date string', () => {
    assert.ok(THREAT_CONFIG_LAST_REVIEWED, 'THREAT_CONFIG_LAST_REVIEWED should be exported');
    assert.ok(!isNaN(Date.parse(THREAT_CONFIG_LAST_REVIEWED)),
      'THREAT_CONFIG_LAST_REVIEWED should be a valid date');
  });

  it('every chokepoint has a directions array', () => {
    for (const cp of CHOKEPOINTS) {
      assert.ok(Array.isArray(cp.directions), `${cp.id}: directions must be an array`);
      assert.ok(cp.directions.length >= 2, `${cp.id}: must have at least 2 directions`);
    }
  });

  it('Hormuz and Gibraltar use eastbound/westbound', () => {
    assert.deepEqual(cpById.hormuz.directions, ['eastbound', 'westbound']);
    assert.deepEqual(cpById.gibraltar.directions, ['eastbound', 'westbound']);
  });

  it('Cape of Good Hope uses eastbound/westbound', () => {
    assert.deepEqual(cpById.cape_of_good_hope.directions, ['eastbound', 'westbound']);
  });

  it('Suez and Panama use northbound/southbound', () => {
    assert.deepEqual(cpById.suez.directions, ['northbound', 'southbound']);
    assert.deepEqual(cpById.panama.directions, ['northbound', 'southbound']);
  });

  it('Malacca uses northbound/southbound', () => {
    assert.deepEqual(cpById.malacca.directions, ['northbound', 'southbound']);
  });

  it('Cape of Good Hope areaKeywords include cape town and south africa', () => {
    assert.ok(cpById.cape_of_good_hope.areaKeywords.includes('cape town'));
    assert.ok(cpById.cape_of_good_hope.areaKeywords.includes('south africa'));
  });

  it('Gibraltar areaKeywords include mediterranean and algeciras', () => {
    assert.ok(cpById.gibraltar.areaKeywords.includes('mediterranean'));
    assert.ok(cpById.gibraltar.areaKeywords.includes('algeciras'));
  });
});
