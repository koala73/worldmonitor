import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTrafficAnomaly } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';
import {
  CANONICAL_CHOKEPOINTS,
  corridorRiskNameToId,
} from '../server/worldmonitor/supply-chain/v1/_chokepoint-ids.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');
const handlerSrc = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'), 'utf-8');

function makeDays(count, dailyTotal, startOffset) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker: 0,
      cargo: dailyTotal,
      other: 0,
      total: dailyTotal,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// 1. seedTransitSummaries relay source analysis
// ---------------------------------------------------------------------------
describe('seedTransitSummaries (relay)', () => {
  it('defines seedTransitSummaries function', () => {
    assert.match(relaySrc, /async function seedTransitSummaries\(\)/);
  });

  it('writes to supply_chain:transit-summaries:v1 Redis key', () => {
    assert.match(relaySrc, /supply_chain:transit-summaries:v1/);
  });

  it('writes seed-meta for transit-summaries', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:transit-summaries/);
  });

  it('summary object includes all required fields', () => {
    assert.match(relaySrc, /todayTotal:/);
    assert.match(relaySrc, /todayTanker:/);
    assert.match(relaySrc, /todayCargo:/);
    assert.match(relaySrc, /todayOther:/);
    assert.match(relaySrc, /wowChangePct:/);
    assert.match(relaySrc, /history:/);
    assert.match(relaySrc, /riskLevel:/);
    assert.match(relaySrc, /incidentCount7d:/);
    assert.match(relaySrc, /disruptionPct:/);
    assert.match(relaySrc, /anomaly/);
  });

  it('reads latestCorridorRiskData for riskLevel/incidentCount7d/disruptionPct', () => {
    assert.match(relaySrc, /latestCorridorRiskData\?\.\[cpId\]/);
    assert.match(relaySrc, /cr\?\.riskLevel/);
    assert.match(relaySrc, /cr\?\.incidentCount7d/);
    assert.match(relaySrc, /cr\?\.disruptionPct/);
  });

  it('reads pw from Redis for history and wowChangePct', () => {
    assert.match(relaySrc, /cpData\.history/);
    assert.match(relaySrc, /cpData\.wowChangePct/);
  });

  it('calls detectTrafficAnomalyRelay with history and threat level', () => {
    assert.match(relaySrc, /detectTrafficAnomalyRelay\(cpData\.history,\s*threatLevel\)/);
  });

  it('wraps summaries in { summaries, fetchedAt } envelope', () => {
    assert.match(relaySrc, /\{\s*summaries,\s*fetchedAt:\s*now\s*\}/);
  });

  it('PortWatch data is read directly from Redis each cycle', () => {
    assert.match(relaySrc, /const pw = await upstashGet\(PORTWATCH_REDIS_KEY\)/);
  });

  it('is triggered after CorridorRisk seed completes', () => {
    const corridorBlock = relaySrc.match(/\[CorridorRisk\] Seeded[\s\S]{0,200}seedTransitSummaries/);
    assert.ok(corridorBlock, 'seedTransitSummaries should be called after CorridorRisk seed');
  });

  it('runs on 10 minute interval', () => {
    assert.match(relaySrc, /TRANSIT_SUMMARY_INTERVAL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  });

  it('has TTL >= 6x seed interval (survives multiple missed pings)', () => {
    assert.match(relaySrc, /TRANSIT_SUMMARY_TTL\s*=\s*[3-9]\d{3}/);
  });
});

// ---------------------------------------------------------------------------
// 2. CORRIDOR_RISK_NAME_MAP and seedCorridorRisk
// ---------------------------------------------------------------------------
describe('CORRIDOR_RISK_NAME_MAP (relay)', () => {
  it('defines CORRIDOR_RISK_NAME_MAP array', () => {
    assert.match(relaySrc, /const CORRIDOR_RISK_NAME_MAP\s*=\s*\[/);
  });

  it('maps hormuz to hormuz_strait', () => {
    assert.match(relaySrc, /pattern:\s*'hormuz'.*id:\s*'hormuz_strait'/);
  });

  it('maps bab-el-mandeb to bab_el_mandeb', () => {
    assert.match(relaySrc, /pattern:\s*'bab-el-mandeb'.*id:\s*'bab_el_mandeb'/);
  });

  it('maps red sea to bab_el_mandeb', () => {
    assert.match(relaySrc, /pattern:\s*'red sea'.*id:\s*'bab_el_mandeb'/);
  });

  it('maps suez to suez', () => {
    assert.match(relaySrc, /pattern:\s*'suez'.*id:\s*'suez'/);
  });

  it('maps south china sea to taiwan_strait', () => {
    assert.match(relaySrc, /pattern:\s*'south china sea'.*id:\s*'taiwan_strait'/);
  });

  it('maps black sea to bosphorus', () => {
    assert.match(relaySrc, /pattern:\s*'black sea'.*id:\s*'bosphorus'/);
  });

  it('has exactly 6 mapping entries', () => {
    const mapBlock = relaySrc.match(/CORRIDOR_RISK_NAME_MAP\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(mapBlock, 'CORRIDOR_RISK_NAME_MAP block not found');
    const patterns = [...mapBlock[1].matchAll(/pattern:\s*'/g)];
    assert.equal(patterns.length, 6);
  });
});

describe('seedCorridorRisk risk level derivation', () => {
  // Extract the risk-level derivation logic from relay source to test boundaries
  const riskLevelLine = relaySrc.match(/const riskLevel = score >= 70 \? 'critical' : score >= 50 \? 'high' : score >= 30 \? 'elevated' : 'normal'/);
  assert.ok(riskLevelLine, 'risk level derivation logic not found in relay');

  // Re-implement for direct boundary testing
  function deriveRiskLevel(score) {
    return score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'elevated' : 'normal';
  }

  it('score >= 70 is critical', () => {
    assert.equal(deriveRiskLevel(70), 'critical');
    assert.equal(deriveRiskLevel(100), 'critical');
  });

  it('score 50-69 is high', () => {
    assert.equal(deriveRiskLevel(50), 'high');
    assert.equal(deriveRiskLevel(69), 'high');
  });

  it('score 30-49 is elevated', () => {
    assert.equal(deriveRiskLevel(30), 'elevated');
    assert.equal(deriveRiskLevel(49), 'elevated');
  });

  it('score < 30 is normal', () => {
    assert.equal(deriveRiskLevel(0), 'normal');
    assert.equal(deriveRiskLevel(29), 'normal');
  });

  it('boundary: score 69 is high (not critical)', () => {
    assert.equal(deriveRiskLevel(69), 'high');
  });

  it('boundary: score 49 is elevated (not high)', () => {
    assert.equal(deriveRiskLevel(49), 'elevated');
  });

  it('boundary: score 29 is normal (not elevated)', () => {
    assert.equal(deriveRiskLevel(29), 'normal');
  });
});

describe('seedCorridorRisk output fields', () => {
  it('writes riskLevel to result', () => {
    assert.match(relaySrc, /riskLevel,/);
  });

  it('writes riskScore', () => {
    assert.match(relaySrc, /riskScore:\s*score/);
  });

  it('writes incidentCount7d from incident_count_7d', () => {
    assert.match(relaySrc, /incidentCount7d:\s*Number\(corridor\.incident_count_7d/);
  });

  it('writes disruptionPct from disruption_pct', () => {
    assert.match(relaySrc, /disruptionPct:\s*Number\(corridor\.disruption_pct/);
  });

  it('writes eventCount7d from event_count_7d', () => {
    assert.match(relaySrc, /eventCount7d:\s*Number\(corridor\.event_count_7d/);
  });

  it('writes vesselCount from vessel_count', () => {
    assert.match(relaySrc, /vesselCount:\s*Number\(corridor\.vessel_count/);
  });

  it('truncates riskSummary to 200 chars', () => {
    assert.match(relaySrc, /\.slice\(0,\s*200\)/);
  });

  it('stores result in latestCorridorRiskData for transit summary assembly', () => {
    assert.match(relaySrc, /latestCorridorRiskData\s*=\s*result/);
  });

  it('writes to corridor risk Redis key', () => {
    assert.match(relaySrc, /supply_chain:corridorrisk/);
  });

  it('writes seed-meta for corridor risk', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:corridorrisk/);
  });
});

// ---------------------------------------------------------------------------
// 3. Vercel handler consuming pre-built summaries
// ---------------------------------------------------------------------------
describe('get-chokepoint-status handler (source analysis)', () => {
  it('defines TRANSIT_SUMMARIES_KEY pointing to transit-summaries:v1', () => {
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY\s*=\s*'supply_chain:transit-summaries:v1'/);
  });

  it('reads transit summaries via getCachedJson', () => {
    assert.match(handlerSrc, /getCachedJson\(TRANSIT_SUMMARIES_KEY/);
  });

  it('imports PortWatchData for fallback assembly', () => {
    assert.match(handlerSrc, /import.*PortWatchData/);
  });

  it('does NOT import CorridorRiskData (uses local interface)', () => {
    assert.doesNotMatch(handlerSrc, /import.*CorridorRiskData/);
  });

  it('imports CANONICAL_CHOKEPOINTS for fallback relay-name mapping', () => {
    assert.match(handlerSrc, /import.*CANONICAL_CHOKEPOINTS/);
  });

  it('does NOT import portwatchNameToId or corridorRiskNameToId', () => {
    assert.doesNotMatch(handlerSrc, /import.*portwatchNameToId/);
    assert.doesNotMatch(handlerSrc, /import.*corridorRiskNameToId/);
  });

  it('defines PreBuiltTransitSummary interface with all required fields', () => {
    assert.match(handlerSrc, /interface PreBuiltTransitSummary/);
    assert.match(handlerSrc, /todayTotal:\s*number/);
    assert.match(handlerSrc, /todayTanker:\s*number/);
    assert.match(handlerSrc, /todayCargo:\s*number/);
    assert.match(handlerSrc, /todayOther:\s*number/);
    assert.match(handlerSrc, /wowChangePct:\s*number/);
    assert.match(handlerSrc, /riskLevel:\s*string/);
    assert.match(handlerSrc, /incidentCount7d:\s*number/);
    assert.match(handlerSrc, /disruptionPct:\s*number/);
    assert.match(handlerSrc, /anomaly:\s*\{\s*dropPct:\s*number;\s*signal:\s*boolean\s*\}/);
  });

  it('defines TransitSummariesPayload with summaries record and fetchedAt', () => {
    assert.match(handlerSrc, /interface TransitSummariesPayload/);
    assert.match(handlerSrc, /summaries:\s*Record<string,\s*PreBuiltTransitSummary>/);
    assert.match(handlerSrc, /fetchedAt:\s*number/);
  });

  it('maps transit summary data into ChokepointInfo.transitSummary', () => {
    assert.match(handlerSrc, /transitSummary:\s*ts\s*\?/);
  });

  it('provides zero-value fallback when no transit summary exists', () => {
    assert.match(handlerSrc, /todayTotal:\s*0,\s*todayTanker:\s*0/);
  });

  it('uses anomaly.signal for bonus scoring', () => {
    assert.match(handlerSrc, /anomalyBonus\s*=\s*anomaly\.signal\s*\?\s*10\s*:\s*0/);
  });

  it('includes anomaly drop description when signal is true', () => {
    assert.match(handlerSrc, /Traffic down.*dropPct.*baseline/);
  });
});

// ---------------------------------------------------------------------------
// 4. CORRIDOR_RISK_NAME_MAP alignment with _chokepoint-ids
// ---------------------------------------------------------------------------
describe('corridor risk name map alignment with canonical IDs', () => {
  const mapBlock = relaySrc.match(/CORRIDOR_RISK_NAME_MAP\s*=\s*\[([\s\S]*?)\];/);
  const entries = [...mapBlock[1].matchAll(/\{\s*pattern:\s*'([^']+)',\s*id:\s*'([^']+)'\s*\}/g)];

  it('all mapped IDs are valid canonical chokepoint IDs', () => {
    const canonicalIds = new Set(CANONICAL_CHOKEPOINTS.map(c => c.id));
    for (const [, , id] of entries) {
      assert.ok(canonicalIds.has(id), `${id} is not a canonical chokepoint ID`);
    }
  });

  it('corridorRiskNameToId covers chokepoints with non-null corridorRiskName', () => {
    const withCr = CANONICAL_CHOKEPOINTS.filter(c => c.corridorRiskName !== null);
    for (const cp of withCr) {
      assert.equal(corridorRiskNameToId(cp.corridorRiskName), cp.id,
        `corridorRiskNameToId('${cp.corridorRiskName}') should return '${cp.id}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. detectTrafficAnomalyRelay sync with _scoring.mjs version
// ---------------------------------------------------------------------------
describe('detectTrafficAnomalyRelay sync with _scoring.mjs', () => {
  // Extract the relay copy of detectTrafficAnomalyRelay
  const fnMatch = relaySrc.match(/function detectTrafficAnomalyRelay\(history, threatLevel\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'detectTrafficAnomalyRelay not found in relay source');
  const relayFn = new Function('history', 'threatLevel', fnMatch[1]);

  it('matches _scoring.mjs for war_zone with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for normal threat level', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'normal');
    const relayResult = relayFn(history, 'normal');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for insufficient history', () => {
    const history = makeDays(20, 100, 0);
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for low baseline', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for critical threat level', () => {
    const history = [...makeDays(7, 10, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'critical');
    const relayResult = relayFn(history, 'critical');
    assert.deepEqual(relayResult, scoringResult);
  });
});

// ---------------------------------------------------------------------------
// 6. detectTrafficAnomaly (_scoring.mjs) edge cases
// ---------------------------------------------------------------------------
describe('detectTrafficAnomaly edge cases (_scoring.mjs)', () => {
  it('null history returns no signal', () => {
    const result = detectTrafficAnomaly(null, 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('empty array returns no signal', () => {
    const result = detectTrafficAnomaly([], 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('exactly 37 days is sufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    assert.equal(history.length, 37);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal, 'should detect anomaly with exactly 37 days');
    assert.ok(result.dropPct >= 90);
  });

  it('36 days is insufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(29, 100, 7)];
    assert.equal(history.length, 36);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('equal traffic recent vs baseline yields dropPct 0, no signal', () => {
    const history = [...makeDays(7, 100, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 0);
    assert.equal(result.signal, false);
  });

  it('increased traffic yields negative dropPct, no signal', () => {
    const history = [...makeDays(7, 200, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 0, `expected negative dropPct, got ${result.dropPct}`);
    assert.equal(result.signal, false);
  });

  it('exactly 50% drop in war_zone triggers signal', () => {
    const history = [...makeDays(7, 50, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 50);
    assert.equal(result.signal, true);
  });

  it('49% drop in war_zone does NOT trigger signal', () => {
    const history = [...makeDays(7, 51, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 50);
    assert.equal(result.signal, false);
  });

  it('elevated threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'elevated');
    assert.equal(result.signal, false);
    assert.ok(result.dropPct >= 90);
  });

  it('high threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'high');
    assert.equal(result.signal, false);
  });

  it('unsorted history is handled correctly (sorted internally)', () => {
    const history = [...makeDays(30, 100, 7), ...makeDays(7, 5, 0)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal);
    assert.ok(result.dropPct >= 90);
  });

  it('baseline < 2 vessels/day avg (< 14 total over 7 days) returns no signal', () => {
    // baseline30 of 1/day -> baselineAvg7 = (30*1/30)*7 = 7 < 14
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('baseline of exactly 2 vessels/day (14/week) is accepted', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 2, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct > 0, 'should compute dropPct when baseline is 14/week');
  });
});

// ---------------------------------------------------------------------------
// 7. CHOKEPOINT_THREAT_LEVELS sync between relay and handler
// ---------------------------------------------------------------------------
describe('CHOKEPOINT_THREAT_LEVELS relay-handler sync', () => {
  const relayBlock = relaySrc.match(/CHOKEPOINT_THREAT_LEVELS\s*=\s*\{([^}]+)\}/)?.[1] || '';

  it('relay defines threat levels for all 13 canonical chokepoints', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      assert.match(relayBlock, new RegExp(`${cp.id}:\\s*'`),
        `Missing threat level for ${cp.id} in relay`);
    }
  });

  it('relay threat levels match handler CHOKEPOINTS config', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      const relayMatch = relayBlock.match(new RegExp(`${cp.id}:\\s*'(\\w+)'`));
      const handlerMatch = handlerSrc.match(new RegExp(`id:\\s*'${cp.id}'[^}]*threatLevel:\\s*'(\\w+)'`));
      if (relayMatch && handlerMatch) {
        assert.equal(relayMatch[1], handlerMatch[1],
          `Threat level mismatch for ${cp.id}: relay=${relayMatch[1]} handler=${handlerMatch[1]}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Handler reads pre-built summaries first, falls back to raw keys
// ---------------------------------------------------------------------------
describe('handler transit data strategy', () => {
  it('reads TRANSIT_SUMMARIES_KEY as primary source', () => {
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY/);
  });

  it('has fallback keys for portwatch, corridorrisk, and transit counts', () => {
    assert.match(handlerSrc, /PORTWATCH_FALLBACK_KEY/);
    assert.match(handlerSrc, /CORRIDORRISK_FALLBACK_KEY/);
    assert.match(handlerSrc, /TRANSIT_COUNTS_FALLBACK_KEY/);
  });

  it('fallback triggers only when pre-built summaries are empty', () => {
    assert.match(handlerSrc, /Object\.keys\(summaries\)\.length === 0/);
  });

  it('fallback builds summaries with detectTrafficAnomaly', () => {
    assert.match(handlerSrc, /buildFallbackSummaries/);
    assert.match(handlerSrc, /detectTrafficAnomaly/);
  });

  it('does NOT call getPortWatchTransits or fetchCorridorRisk (no upstream fetch)', () => {
    assert.doesNotMatch(handlerSrc, /getPortWatchTransits/);
    assert.doesNotMatch(handlerSrc, /fetchCorridorRisk/);
  });
});

describe('seedTransitSummaries Redis reads', () => {
  it('always reads PortWatch fresh from Redis (no in-memory cache guard)', () => {
    assert.doesNotMatch(relaySrc, /if\s*\(\s*!latestPortwatchData\s*\)/);
    assert.match(relaySrc, /upstashGet\(PORTWATCH_REDIS_KEY\)/);
  });

  it('reads CorridorRisk from Redis when latestCorridorRiskData is null', () => {
    assert.match(relaySrc, /if\s*\(\s*!latestCorridorRiskData\s*\)/);
    assert.match(relaySrc, /upstashGet\(CORRIDOR_RISK_REDIS_KEY\)/);
    assert.match(relaySrc, /Hydrated CorridorRisk from Redis/);
  });

  it('PortWatch Redis read is the first statement (before early return)', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const readPos = fnBody.indexOf('upstashGet(PORTWATCH_REDIS_KEY)');
    const earlyReturnPos = fnBody.indexOf('if (!pw ||');
    assert.ok(readPos > 0, 'upstashGet(PORTWATCH_REDIS_KEY) not found in function body');
    assert.ok(earlyReturnPos > 0, 'pw early return not found');
    assert.ok(readPos < earlyReturnPos, 'Redis read must come before the early return');
  });

  it('PortWatch data is assigned directly from Redis (no stale in-memory cache)', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(fnBody, /const pw = await upstashGet\(PORTWATCH_REDIS_KEY\)/);
  });

  it('assigns hydrated data back to latestCorridorRiskData', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(fnBody, /latestCorridorRiskData\s*=\s*persisted/);
  });
});
