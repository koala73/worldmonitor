import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTrafficAnomaly, THREAT_LEVEL } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';
import {
  CANONICAL_CHOKEPOINTS,
  corridorRiskNameToId,
} from '../server/worldmonitor/supply-chain/v1/_chokepoint-ids.ts';
import { CHOKEPOINTS } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';
import { CHOKEPOINT_THREAT_LEVELS } from '../shared/chokepoint-threat-levels.js';
import { CORRIDOR_RISK_NAME_MAP, deriveCorridorRiskLevel } from '../shared/corridor-risk.js';

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
  // The source-shape assertions that used to sit here were superseded by the
  // behavioural harness below, which runs the real seedTransitSummaries body
  // and asserts on the writes it produces. Per this suite's own note, those
  // regexes stayed green through the 2026-07 incident where the scheduler was
  // wired correctly and never populated Redis.


  it('is triggered after CorridorRisk seed completes', () => {
    const corridorBlock = relaySrc.match(/\[CorridorRisk\] Seeded[\s\S]{0,200}seedTransitSummaries/);
    assert.ok(corridorBlock, 'seedTransitSummaries should be called after CorridorRisk seed');
  });

  it('keeps the key TTL at least 6 seed intervals long (survives missed pings)', () => {
    // Evaluate both constants rather than pinning their digits: the invariant
    // is the RELATIONSHIP between them, so re-cadencing the loop without
    // lengthening the TTL is what has to fail. A `[3-9]\d{3}` style regex
    // passes for any four-digit TTL no matter what the interval became.
    const evalConst = (name) => {
      const m = relaySrc.match(new RegExp(`const ${name} = ([^;]+);`));
      assert.ok(m, `${name} not found in relay source`);
      return Number(new Function(`return (${m[1]})`)());
    };
    const intervalMs = evalConst('TRANSIT_SUMMARY_INTERVAL_MS');
    const ttlSeconds = evalConst('TRANSIT_SUMMARY_TTL');

    assert.ok(Number.isFinite(intervalMs) && intervalMs > 0, 'interval must be a positive number');
    assert.ok(
      ttlSeconds * 1000 >= intervalMs * 6,
      `TTL ${ttlSeconds}s must cover 6 intervals of ${intervalMs / 1000}s`,
    );
  });

  it('empty-portwatch early return is non-silent (logs key + reason, not a bare `return;`)', () => {
    // Regression guard for the 2026-07 incident: this early return fired on
    // every 10-min tick for 4d20h with zero log output (UPSTASH_ENABLED was
    // false in-container), so the dead scheduler was invisible until a live
    // audit caught it via the never-populated Redis key. A bare early
    // `return;` here must never come back.
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.doesNotMatch(fnBody, /length === 0\) return;/);
    assert.match(fnBody, /console\.warn\(`\[TransitSummary\] Skipped — \$\{PORTWATCH_REDIS_KEY\}/);
    // The logged reason must distinguish "Upstash disabled" from "read
    // failed" from "key genuinely empty" — three different root causes that
    // all look identical from the caller's perspective otherwise.
    assert.match(fnBody, /!UPSTASH_ENABLED/);
    assert.match(fnBody, /pwFailureReason/);
  });

  // ---------------------------------------------------------------------------
  // Behavioral seeding — runs the real seedTransitSummaries body (extracted
  // from source, not reimplemented) in a sandbox with mocked
  // envelopeRead/envelopeWrite/upstashSet. No network, no real Upstash. The
  // regex assertions above only prove the source SHAPE is wired correctly —
  // they still pass even if the scheduler silently never populates Redis
  // (the exact 2026-07 incident class). These tests actually invoke the
  // function and assert on the writes it produces.
  // ---------------------------------------------------------------------------

  function extractConstLine(name) {
    const m = relaySrc.match(new RegExp(`const ${name} = [^;]+;`));
    assert.ok(m, `${name} definition not found in relaySrc`);
    return m[0];
  }

  function extractObjectConst(name) {
    const m = relaySrc.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`));
    assert.ok(m, `${name} definition not found in relaySrc`);
    return m[0];
  }

  const seedFnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(seedFnBody, 'seedTransitSummaries body not found');

  // Assembled in dependency order from real extracted source snippets, not
  // hand-copied literals — a future rename/edit in ais-relay.cjs breaks this
  // extraction (loud) instead of silently testing stale duplicated code.
  //
  // `detectTrafficAnomaly` and `CHOKEPOINT_THREAT_LEVELS` are injected as the
  // real imported modules rather than sliced out of the relay: the relay now
  // requires both from shared/, so there is nothing to extract and nothing to
  // hold in sync.
  const seedHarnessSrc = [
    extractConstLine('PORTWATCH_REDIS_KEY'),
    extractConstLine('CORRIDOR_RISK_REDIS_KEY'),
    extractConstLine('TRANSIT_SUMMARY_REDIS_KEY'),
    extractConstLine('TRANSIT_SUMMARY_HISTORY_KEY_PREFIX'),
    extractConstLine('TRANSIT_SUMMARY_TTL'),
    extractConstLine('TRANSIT_WINDOW_MS'),
    extractObjectConst('RELAY_NAME_TO_ID'),
    'let latestCorridorRiskData = null;',
    `async function seedTransitSummaries() {${seedFnBody}\n}`,
    'return seedTransitSummaries;',
  ].join('\n');

  // Fresh sandbox per call — `latestCorridorRiskData` resets like a cold
  // relay restart instead of leaking state between tests.
  function buildSeedTransitSummaries({ envelopeRead, envelopeWrite, upstashSet, upstashEnabled = true, warn = () => {}, log = () => {} }) {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'envelopeRead', 'envelopeWrite', 'upstashSet', 'console', 'UPSTASH_ENABLED', 'chokepointCrossings',
      'detectTrafficAnomaly', 'CHOKEPOINT_THREAT_LEVELS',
      seedHarnessSrc,
    );
    return factory(
      envelopeRead, envelopeWrite, upstashSet, { warn, log }, upstashEnabled, new Map(),
      detectTrafficAnomaly, CHOKEPOINT_THREAT_LEVELS,
    );
  }

  const ALL_CANONICAL_IDS = [
    'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
    'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
    'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
  ];

  it('populated portwatch actually produces the compact summary key, all 13 per-id history keys, and a seed-meta write', async () => {
    const fakePortwatch = {
      suez: { history: makeDays(40, 120, 0), wowChangePct: 4.2 },
      hormuz_strait: { history: makeDays(3, 10, 0), wowChangePct: -1 },
    };
    const writes = [];
    const metaWrites = [];
    const warnings = [];
    const seed = buildSeedTransitSummaries({
      envelopeRead: async key => (key === 'supply_chain:portwatch:v1' ? fakePortwatch : null),
      envelopeWrite: async (key, data, ttlSeconds, meta) => { writes.push({ key, data, ttlSeconds, meta }); return true; },
      upstashSet: async (key, data, ttlSeconds) => { metaWrites.push({ key, data, ttlSeconds }); },
      warn: msg => warnings.push(msg),
    });

    await seed();

    const summaryWrites = writes.filter(w => w.key === 'supply_chain:transit-summaries:v1');
    assert.equal(summaryWrites.length, 1, 'expected exactly one write to the compact summary key');
    const { summaries } = summaryWrites[0].data;
    assert.deepEqual(Object.keys(summaries).sort(), [...ALL_CANONICAL_IDS].sort());
    assert.equal(summaries.suez.dataAvailable, true);
    assert.equal(summaries.hormuz_strait.dataAvailable, true);
    // Chokepoint missing from this cycle's portwatch payload still publishes
    // a zero-state row instead of vanishing (partial-coverage regression).
    assert.equal(summaries.panama.dataAvailable, false);
    assert.equal(summaries.panama.todayTotal, 0);
    assert.equal(summaryWrites[0].meta.recordCount, 2, 'recordCount must reflect pwCovered, not the always-13 shape');
    // The count alone is unattributable after the fact. On 2026-08-25 portwatch
    // dropped exactly two chokepoints for ~4.5 hours; every cycle logged an
    // identical `11/13` and named neither, and the upstream had recovered before
    // anyone could look. The shortfall warning must say WHICH.
    const shortfall = warnings.find((line) => line.includes('coverage shortfall'));
    assert.ok(shortfall, 'a partial portwatch cycle must warn');
    assert.match(shortfall, /2\/13/, 'the count is still reported');
    for (const missing of ALL_CANONICAL_IDS.filter((id) => id !== 'suez' && id !== 'hormuz_strait')) {
      assert.ok(
        shortfall.includes(missing),
        `the shortfall warning must name every missing chokepoint; ${missing} was absent from: ${shortfall}`,
      );
    }
    assert.ok(!shortfall.includes('suez'), 'a covered chokepoint must not be listed as missing');
    assert.equal(summaryWrites[0].ttlSeconds, 3600);

    const historyWrites = writes.filter(w => w.key.startsWith('supply_chain:transit-summaries:history:v1:'));
    assert.equal(historyWrites.length, 13, 'one history write per canonical chokepoint, covered or not');
    const suezHistory = historyWrites.find(w => w.key === 'supply_chain:transit-summaries:history:v1:suez');
    assert.deepEqual(suezHistory.data.history, fakePortwatch.suez.history);
    assert.equal(suezHistory.data.chokepointId, 'suez');
    const panamaHistory = historyWrites.find(w => w.key === 'supply_chain:transit-summaries:history:v1:panama');
    assert.deepEqual(panamaHistory.data.history, []);

    assert.equal(metaWrites.length, 1, 'seed-meta must actually be written so health checks see it');
    assert.equal(metaWrites[0].key, 'seed-meta:supply_chain:transit-summaries');
    assert.equal(metaWrites[0].data.recordCount, 2);
    assert.equal(metaWrites[0].ttlSeconds, 604800);
  });

  it('empty portwatch writes NOTHING to Redis — the exact "scheduler wired but keys never populate" failure class this suite must catch', async () => {
    const writes = [];
    const metaWrites = [];
    const warnings = [];
    const seed = buildSeedTransitSummaries({
      envelopeRead: async () => null,
      envelopeWrite: async (key, data, ttlSeconds, meta) => { writes.push({ key, data, ttlSeconds, meta }); return true; },
      upstashSet: async (key, data, ttlSeconds) => { metaWrites.push({ key, data, ttlSeconds }); },
      warn: msg => warnings.push(msg),
    });

    await seed();

    assert.equal(writes.length, 0, 'no Redis writes should occur when portwatch is empty');
    assert.equal(metaWrites.length, 0, 'no seed-meta write should occur when portwatch is empty');
    assert.equal(warnings.length, 1, 'the skip must log, not fail silently');
    assert.match(warnings[0], /\[TransitSummary\] Skipped — supply_chain:portwatch:v1 unavailable/);
    assert.match(warnings[0], /key empty or absent — upstream seeder has not written it yet/);
  });

  it('disabled Upstash skip reason is exercised behaviorally', async () => {
    const warnings = [];
    const seed = buildSeedTransitSummaries({
      envelopeRead: async () => null,
      envelopeWrite: async () => { throw new Error('must not write when portwatch is unavailable'); },
      upstashSet: async () => { throw new Error('must not write seed-meta when portwatch is unavailable'); },
      upstashEnabled: false,
      warn: msg => warnings.push(msg),
    });

    await seed();

    assert.equal(warnings.length, 1, 'the skip must log even when Redis is disabled');
    assert.match(warnings[0], /Upstash Redis disabled/);
    assert.match(warnings[0], /UPSTASH_REDIS_REST_URL\/UPSTASH_ALLOW_INSECURE_HTTP/);
  });

  it('portwatch read-failure skip reason is exercised behaviorally', async () => {
    const warnings = [];
    const seed = buildSeedTransitSummaries({
      envelopeRead: async (_key, onFailure) => {
        onFailure('HTTP 500 from redis-rest');
        return null;
      },
      envelopeWrite: async () => { throw new Error('must not write when portwatch read failed'); },
      upstashSet: async () => { throw new Error('must not write seed-meta when portwatch read failed'); },
      warn: msg => warnings.push(msg),
    });

    await seed();

    assert.equal(warnings.length, 1, 'the skip must log the read failure reason');
    assert.match(warnings[0], /read failed: HTTP 500 from redis-rest/);
  });
});

// ---------------------------------------------------------------------------
// 2. CORRIDOR_RISK_NAME_MAP and seedCorridorRisk
// ---------------------------------------------------------------------------
describe('corridor risk feed adaptation', () => {
  // The relay, this suite, and the panel all read the same module now. The
  // banding used to be re-implemented inside the test and the name map pinned
  // entry-by-entry with regexes over relay source; neither could fail when the
  // relay changed.
  it('bands scores lower-inclusive so a boundary score never rounds down', () => {
    assert.equal(deriveCorridorRiskLevel(70), 'critical');
    assert.equal(deriveCorridorRiskLevel(69), 'high');
    assert.equal(deriveCorridorRiskLevel(50), 'high');
    assert.equal(deriveCorridorRiskLevel(49), 'elevated');
    assert.equal(deriveCorridorRiskLevel(30), 'elevated');
    assert.equal(deriveCorridorRiskLevel(29), 'normal');
  });

  it('bands the full score range', () => {
    assert.equal(deriveCorridorRiskLevel(100), 'critical');
    assert.equal(deriveCorridorRiskLevel(0), 'normal');
  });

  it('maps every corridor pattern onto a canonical chokepoint id', () => {
    const canonicalIds = new Set(CANONICAL_CHOKEPOINTS.map((c) => c.id));
    for (const { pattern, id } of CORRIDOR_RISK_NAME_MAP) {
      assert.ok(canonicalIds.has(id), `${pattern} maps to non-canonical id ${id}`);
    }
  });

  it('matches corridor names as lowercase substrings, first entry winning', () => {
    // Mirrors the relay's lookup so the ordering contract is exercised rather
    // than assumed: 'Red Sea / Bab-el-Mandeb' must resolve once, not twice.
    const resolve = (name) =>
      CORRIDOR_RISK_NAME_MAP.find((m) => name.toLowerCase().includes(m.pattern))?.id;

    assert.equal(resolve('Strait of Hormuz'), 'hormuz_strait');
    assert.equal(resolve('Bab-el-Mandeb Strait'), 'bab_el_mandeb');
    assert.equal(resolve('Red Sea Corridor'), 'bab_el_mandeb');
    assert.equal(resolve('Suez Canal'), 'suez');
    assert.equal(resolve('South China Sea'), 'taiwan_strait');
    assert.equal(resolve('Black Sea'), 'bosphorus');
    assert.equal(resolve('Panama Canal'), undefined, 'unmapped corridors must not resolve');
  });

  it('keeps every pattern lowercase, or the substring match can never fire', () => {
    for (const { pattern } of CORRIDOR_RISK_NAME_MAP) {
      assert.equal(pattern, pattern.toLowerCase());
    }
  });
});


describe('corridorRiskNameToId', () => {
  it('resolves every chokepoint that declares a CorridorRisk name', () => {
    for (const cp of CANONICAL_CHOKEPOINTS.filter((c) => c.corridorRiskName !== null)) {
      assert.equal(corridorRiskNameToId(cp.corridorRiskName), cp.id);
    }
  });
});

// ---------------------------------------------------------------------------
// detectTrafficAnomaly (shared/chokepoint-traffic-anomaly.js) edge cases.
// The relay and the RPC handler both call this exact function now, so there is
// no second implementation left to hold in sync.
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
// Threat-level parity between shared/chokepoint-threat-levels.js and the
// handler's CHOKEPOINTS config is asserted in tests/chokepoint-id-mapping.test.mjs,
// which owns the canonical-registry contracts.

describe('handler transit data strategy', () => {
  it('reads only the compact summary key and makes no upstream call', () => {
    // Each removed fallback was a ~500KB secondary read stacked on the 1.5s
    // Redis budget, which is what made this handler time out. Absence is the
    // contract, and absence is the one thing no executable test can observe.
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY/);
    assert.doesNotMatch(
      handlerSrc,
      /PORTWATCH_FALLBACK_KEY|CORRIDORRISK_FALLBACK_KEY|TRANSIT_COUNTS_FALLBACK_KEY|buildFallbackSummaries/,
    );
    assert.doesNotMatch(handlerSrc, /getPortWatchTransits|fetchCorridorRisk/);
  });
});

describe('seedTransitSummaries Redis reads', () => {
  it('always reads PortWatch fresh from Redis (no in-memory cache guard)', () => {
    assert.doesNotMatch(relaySrc, /if\s*\(\s*!latestPortwatchData\s*\)/);
    assert.match(relaySrc, /envelopeRead\(PORTWATCH_REDIS_KEY[,)]/);
  });

  it('reads CorridorRisk from Redis when latestCorridorRiskData is null', () => {
    assert.match(relaySrc, /if\s*\(\s*!latestCorridorRiskData\s*\)/);
    assert.match(relaySrc, /envelopeRead\(CORRIDOR_RISK_REDIS_KEY\)/);
    assert.match(relaySrc, /Hydrated CorridorRisk from Redis/);
  });

  it('PortWatch Redis read unwraps contract-mode envelope (reader parity with producer)', () => {
    // Regression guard: PR #3097 migrated producers to {_seed, data}. A raw
    // upstashGet iterates those wrapper keys as chokepoint IDs and silently
    // zeroes the transit chart for every chokepoint.
    assert.doesNotMatch(relaySrc, /const pw = await upstashGet\(PORTWATCH_REDIS_KEY\)/);
    assert.doesNotMatch(relaySrc, /const persisted = await upstashGet\(CORRIDOR_RISK_REDIS_KEY\)/);
  });

  it('loadWsbTickerSet reads market:stocks-bootstrap:v1 via envelopeRead', () => {
    // Regression guard (Greptile review PR #3139): market:stocks-bootstrap:v1 is
    // written via envelopeWrite at lines 1867 + dual-write elsewhere. Reading raw
    // left data.quotes undefined, silently disabling WSB ticker matching.
    assert.match(relaySrc, /envelopeRead\('market:stocks-bootstrap:v1'\)/);
    assert.doesNotMatch(relaySrc, /upstashGet\('market:stocks-bootstrap:v1'\)/);
  });

  it('OREF bootstrap reads OREF_REDIS_KEY via envelopeRead (parity with orefPersistHistory)', () => {
    // Regression guard (Greptile review PR #3139): orefPersistHistory() writes via
    // envelopeWrite. Reading raw left cached.history undefined, so OREF history
    // was never restored across relay restarts — every cold start hit the
    // upstream API unnecessarily.
    assert.match(relaySrc, /const cached = await envelopeRead\(OREF_REDIS_KEY\)/);
    assert.doesNotMatch(relaySrc, /const cached = await upstashGet\(OREF_REDIS_KEY\)/);
  });

  it('PortWatch Redis read is the first statement (before early return)', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const readPos = fnBody.indexOf('envelopeRead(PORTWATCH_REDIS_KEY');
    const earlyReturnPos = fnBody.indexOf('if (!pw ||');
    assert.ok(readPos > 0, 'envelopeRead(PORTWATCH_REDIS_KEY not found in function body');
    assert.ok(earlyReturnPos > 0, 'pw early return not found');
    assert.ok(readPos < earlyReturnPos, 'Redis read must come before the early return');
  });

  it('PortWatch data is assigned directly from Redis (no stale in-memory cache)', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(fnBody, /const pw = await envelopeRead\(PORTWATCH_REDIS_KEY[,)]/);
  });

  it('assigns hydrated data back to latestCorridorRiskData', () => {
    const fnBody = relaySrc.match(/async function seedTransitSummaries\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(fnBody, /latestCorridorRiskData\s*=\s*persisted/);
  });
});

// ---------------------------------------------------------------------------
// envelopeRead helper — runtime behavior (regression guard for PR #3097 drift)
// ---------------------------------------------------------------------------
describe('envelopeRead helper', () => {
  // Extract and eval the helper — it is pure aside from upstashGet, which we stub.
  const helperSrc = relaySrc.match(/async function envelopeRead\([\s\S]*?\n\}/)?.[0];

  it('is defined in ais-relay.cjs next to envelopeWrite', () => {
    assert.ok(helperSrc, 'envelopeRead not found in ais-relay.cjs');
  });

  function buildEnvelopeRead(stub) {
    // eslint-disable-next-line no-new-func
    return new Function('upstashGet', `${helperSrc}\nreturn envelopeRead;`)(stub);
  }

  it('unwraps contract-mode envelope {_seed, data} -> data', async () => {
    const stub = async () => ({ _seed: { fetchedAt: 1 }, data: { hormuz_strait: { history: [1, 2, 3] } } });
    const read = buildEnvelopeRead(stub);
    const out = await read('supply_chain:portwatch:v1');
    assert.deepEqual(out, { hormuz_strait: { history: [1, 2, 3] } });
  });

  it('passes legacy raw shape through unchanged', async () => {
    const stub = async () => ({ hormuz_strait: { history: [1] }, suez: { history: [] } });
    const read = buildEnvelopeRead(stub);
    const out = await read('legacy:key');
    assert.deepEqual(out, { hormuz_strait: { history: [1] }, suez: { history: [] } });
  });

  it('returns null when Redis returns null', async () => {
    const stub = async () => null;
    const read = buildEnvelopeRead(stub);
    assert.equal(await read('missing:key'), null);
  });

  it('does NOT unwrap arrays that happen to have _seed/data indices', async () => {
    const stub = async () => [1, 2, 3];
    const read = buildEnvelopeRead(stub);
    assert.deepEqual(await read('array:key'), [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Upstash Redis client selection — runtime behavior for the insecure-http
// opt-in (regression guard for the incident where the https-only gate
// silently no-oped every seed loop against http://redis-rest:80 for 4+ days).
// UPSTASH_ALLOW_INSECURE_HTTP + UPSTASH_HTTP_MODULE decide both whether
// Redis writes are enabled at all and which Node client (http vs https)
// upstashGet/Set/etc. use. The source-scan tests above only assert the
// scheduler shape; these actually eval the init block + upstashGet in a
// sandbox with mocked http/https clients (no network, no real Upstash) so a
// future edit that regresses the opt-in gate fails a test, not silence.
// ---------------------------------------------------------------------------
describe('Upstash Redis client selection (insecure-http opt-in)', () => {
  // The relay can't be require()'d directly in a test — it process.exit(1)s
  // without AISSTREAM_API_KEY and otherwise boots a live server on import.
  // Slice the init block (UPSTASH_REDIS_REST_URL ... end of upstashGet)
  // straight out of the relay source and eval it in a sandbox instead.
  const initStart = relaySrc.indexOf("const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';");
  const initEnd = relaySrc.indexOf('function upstashSet(key, value, ttlSeconds) {');
  assert.ok(initStart > 0 && initEnd > initStart, 'Upstash init block (through upstashGet) not found');
  const initAndGetSrc = relaySrc.slice(initStart, initEnd);

  function makeMockClient(name) {
    return {
      name,
      requestCalls: [],
      request(url, opts) {
        this.requestCalls.push({ url, opts });
        // No response callback is ever invoked — these tests only assert
        // which client received the call, so the resulting (intentionally
        // never-settling) promise must not be awaited.
        return { on() {}, end() {} };
      },
    };
  }

  function buildUpstashInit(env, httpClient, httpsClient) {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'process', 'http', 'https',
      `${initAndGetSrc}\nreturn { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet };`,
    );
    return fn({ env }, httpClient, httpsClient);
  }

  it('https:// URL enables Upstash and routes upstashGet through the https client', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'https://real-upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ENABLED, true);
    assert.equal(UPSTASH_HTTP_MODULE, httpsClient);
    upstashGet('some:key');
    assert.equal(httpsClient.requestCalls.length, 1);
    assert.equal(httpClient.requestCalls.length, 0);
  });

  it('http:// URL WITHOUT UPSTASH_ALLOW_INSECURE_HTTP disables Upstash entirely (never calls Redis) — the regressed state that silently disabled every seed loop for 4+ days', async () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, false);
    assert.equal(UPSTASH_ENABLED, false);
    // Resolves null synchronously via the !UPSTASH_ENABLED guard — safe to
    // await, and proves no request is ever attempted on either client.
    assert.equal(await upstashGet('some:key'), null);
    assert.equal(httpClient.requestCalls.length, 0);
    assert.equal(httpsClient.requestCalls.length, 0);
  });

  it('http:// URL WITH UPSTASH_ALLOW_INSECURE_HTTP=true enables Upstash and routes upstashGet through the http client (the scheduler fix)', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok', UPSTASH_ALLOW_INSECURE_HTTP: 'true' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, true);
    assert.equal(UPSTASH_ENABLED, true);
    assert.equal(UPSTASH_HTTP_MODULE, httpClient);
    upstashGet('some:key');
    assert.equal(httpClient.requestCalls.length, 1);
    assert.equal(httpsClient.requestCalls.length, 0);
  });

  it('UPSTASH_ALLOW_INSECURE_HTTP is a strict "true" match — "TRUE"/"1" do not opt in', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok', UPSTASH_ALLOW_INSECURE_HTTP: 'TRUE' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, false);
    assert.equal(UPSTASH_ENABLED, false);
  });

  it('missing UPSTASH_REDIS_REST_TOKEN disables Upstash even over https', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ENABLED } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'https://real-upstash.io' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ENABLED, false);
  });
});
