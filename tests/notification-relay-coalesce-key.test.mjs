/**
 * Slot B regression tests: NWS event-family coalesce.
 *
 * Verifies the contract that adjacent-zone NWS alerts (same VTEC family)
 * collapse to one notification per user. Source-grep tests because the
 * relay scripts are runtime side-effect modules with no exports — the same
 * pattern used by tests/notification-relay-effective-sensitivity.test.mjs.
 *
 * The actual VTEC parser (deriveWeatherCoalesceKey in ais-relay.cjs) is
 * exercised here too via a minimal re-implementation extracted from the
 * source. If the source diverges, this test will fail and force an update.
 *
 * See docs/archive/plans/forbid-realtime-all-events.md "Out of scope: Slot B".
 *
 * Run: node --test tests/notification-relay-coalesce-key.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const relaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'), 'utf-8');
const aisRelaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'), 'utf-8');
const seedAviationSrc = readFileSync(resolve(__dirname, '..', 'scripts', 'seed-aviation.mjs'), 'utf-8');
const regionalAlertEmitterSrc = readFileSync(resolve(__dirname, '..', 'scripts', 'regional-snapshot', 'alert-emitter.mjs'), 'utf-8');
const notificationDedupSrc = readFileSync(resolve(__dirname, '..', 'scripts', 'shared', 'notification-dedup.cjs'), 'utf-8');
const notificationDedup = require('../scripts/shared/notification-dedup.cjs');

describe('notification-relay checkDedup — Slot B coalesce key', () => {
  it('checkDedup signature accepts an optional coalesceKey parameter', () => {
    assert.match(
      relaySrc,
      /async function checkDedup\(userId,\s*eventType,\s*title,\s*coalesceKey\)/,
      'checkDedup must take coalesceKey as the 4th parameter',
    );
  });

  it('checkDedup keys on coalesceKey when set, falls back to title hash otherwise', () => {
    // Both branches must be present: coalesce-key path and title-hash path.
    assert.match(
      relaySrc,
      /const keyMaterial = buildDedupMaterial\(eventType,\s*title,\s*coalesceKey\)/,
      'checkDedup must derive keyMaterial via the shared buildDedupMaterial helper',
    );
  });

  it('both checkDedup call sites pass event.payload?.coalesceKey through', () => {
    // The held-event path AND the realtime path must thread coalesceKey, otherwise
    // one branch silently misses the coalesce. (Half-defense regression.)
    const callSites = relaySrc.match(/checkDedup\(rule\.userId,\s*event\.eventType,\s*event\.payload\?\.title\s*\?\?\s*'',\s*coalesceKey\)/g);
    assert.ok(
      callSites && callSites.length >= 2,
      `expected ≥2 checkDedup call sites threading coalesceKey, found ${callSites?.length ?? 0}`,
    );
  });

  it('coalesceKey is type-guarded as string before threading', () => {
    // Defensive: never trust a raw payload field. typeof === 'string' guard
    // prevents a non-string coalesceKey from poisoning the dedup key.
    assert.match(
      relaySrc,
      /typeof event\.payload\?\.coalesceKey === 'string'\s*\?\s*event\.payload\.coalesceKey\s*:\s*undefined/,
      'coalesceKey must be string-guarded before being passed to checkDedup',
    );
  });
});

describe('notification-relay checkDedup — SETNX transport outcomes', () => {
  function loadRelayForUnitTest() {
    const relayPath = resolve(__dirname, '..', 'scripts', 'notification-relay.cjs');
    const previousEnv = {
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
      CONVEX_URL: process.env.CONVEX_URL,
      CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
      RELAY_SHARED_SECRET: process.env.RELAY_SHARED_SECRET,
    };
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.CONVEX_URL = 'https://example.convex.cloud';
    process.env.CONVEX_SITE_URL = 'https://example.convex.site';
    process.env.RELAY_SHARED_SECRET = 'secret';
    delete require.cache[require.resolve(relayPath)];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, ...rest) {
      if (request === 'resend') return { Resend: class {} };
      return originalLoad.call(this, request, parent, ...rest);
    };
    try {
      return require(relayPath);
    } finally {
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('exports checkDedup and maps SET NX OK/null/non-OK with a timeout-bound fetch', async () => {
    const relay = loadRelayForUnitTest();
    assert.equal(typeof relay.checkDedup, 'function');

    const originalFetch = globalThis.fetch;
    const results = ['OK', null];
    const seenSignals = [];
    try {
      globalThis.fetch = async (_url, init) => {
        seenSignals.push(init?.signal);
        const result = results.shift();
        return { ok: true, json: async () => ({ result }) };
      };
      assert.equal(await relay.checkDedup('user1', 'market_alert', 'Oil spike'), 'new');
      assert.equal(await relay.checkDedup('user1', 'market_alert', 'Oil spike'), 'duplicate');

      globalThis.fetch = async (_url, init) => {
        seenSignals.push(init?.signal);
        return { ok: false, status: 503, json: async () => ({}) };
      };
      assert.equal(await relay.checkDedup('user1', 'market_alert', 'Oil spike'), 'error');
      assert.ok(seenSignals.every(signal => signal instanceof AbortSignal));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('shared notification-dedup helper — buildDedupMaterial', () => {
  it('keys on coalesceKey when set, else falls back to eventType:title', () => {
    assert.match(
      notificationDedupSrc,
      /coalesceKey\s*\?\s*`coalesce:\$\{coalesceKey\}`\s*:\s*`\$\{eventType\}:\$\{title\s*\?\?\s*''\}`/,
      'buildDedupMaterial must use coalesceKey when set, else eventType:title',
    );
  });

  it('is exported for reuse by all publishers', () => {
    assert.equal(typeof notificationDedup.buildDedupMaterial, 'function', 'buildDedupMaterial must be exported');
  });

  it('all notification publishers import/require the shared helper (no re-inlined copies)', () => {
    assert.match(relaySrc, /require\('\.\/shared\/notification-dedup\.cjs'\)/, 'notification-relay.cjs must require the shared helper');
    assert.match(aisRelaySrc, /require\('\.\/shared\/notification-dedup\.cjs'\)/, 'ais-relay.cjs must require the shared helper');
    assert.match(seedAviationSrc, /from '\.\/shared\/notification-dedup\.cjs'/, 'seed-aviation.mjs must import the shared helper');
    assert.match(regionalAlertEmitterSrc, /from '\.\.\/shared\/notification-dedup\.cjs'/, 'regional alert emitter must import the shared helper');
  });
});

describe('shared notification-dedup helper — SETNX failure policy', () => {
  it('distinguishes new keys, genuine duplicate hits, disabled Redis, and Redis errors', () => {
    assert.equal(notificationDedup.classifySetNxResult('OK'), 'new');
    assert.equal(notificationDedup.classifySetNxResult(null), 'duplicate');
    assert.equal(notificationDedup.classifySetNxResult('disabled'), 'disabled');
    assert.equal(notificationDedup.classifySetNxResult(undefined), 'error');
    assert.equal(notificationDedup.classifySetNxResult('ERR'), 'error');
  });

  it('fails open only for high-priority notification severities on SETNX errors', () => {
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('new', 'low'), true);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('duplicate', 'critical'), false);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('disabled', 'critical'), false);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('error', 'critical'), true);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('error', 'high'), true);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('error', 'info'), false);
    assert.equal(notificationDedup.shouldPublishAfterDedupResult('error', undefined), true);
  });

  it('records the shared SETNX outcome branch and caps repeat fail-open publishes in-process', () => {
    const emitted = [];
    const fallbackKey = `unit:${Date.now()}:setnx-error`;
    const first = notificationDedup.recordDedupOutcome('error', {
      surface: 'notification-relay',
      eventType: 'market_alert',
      severity: 'critical',
      fallbackKey,
      fallbackTtlSeconds: 60,
      nowMs: 1_000,
      emitTelemetry: event => emitted.push(event),
    });
    assert.equal(first.shouldPublish, true);
    assert.equal(first.isDuplicate, false);
    assert.equal(first.action, 'fail_open');

    const second = notificationDedup.recordDedupOutcome('error', {
      surface: 'notification-relay',
      eventType: 'market_alert',
      severity: 'critical',
      fallbackKey,
      fallbackTtlSeconds: 60,
      nowMs: 2_000,
      emitTelemetry: event => emitted.push(event),
    });
    assert.equal(second.shouldPublish, false);
    assert.equal(second.isDuplicate, true);
    assert.equal(second.action, 'fallback_suppressed');
    assert.equal(emitted.length, 2);
  });

  it('keeps low-priority SETNX errors fail-closed through the shared outcome branch', () => {
    const decision = notificationDedup.recordDedupOutcome('error', {
      surface: 'notification-relay',
      eventType: 'market_alert',
      severity: 'low',
      fallbackKey: `unit:${Date.now()}:low`,
      fallbackTtlSeconds: 60,
      emitTelemetry: () => {},
    });
    assert.equal(decision.shouldPublish, false);
    assert.equal(decision.action, 'fail_closed');
  });

  it('emits a stable low-cardinality Sentry/metric marker for SETNX errors', () => {
    const line = notificationDedup.buildSetNxErrorTelemetryLine({
      surface: 'Notification Relay',
      eventType: 'market_alert',
      severity: 'critical',
      action: 'fail_open',
    });
    assert.equal(
      line,
      '[notifications] wm_notification_dedup_setnx_error count=1 surface=notification_relay event_type=market_alert severity=critical action=fail_open reason=setnx_error',
    );
    assert.ok(!line.includes('user'), 'telemetry marker must not include user identifiers');
    assert.ok(!line.includes('title'), 'telemetry marker must not include alert titles');
  });

  it('all notification publishers consume the shared SETNX classification helper', () => {
    assert.match(
      notificationDedupSrc,
      /module\.exports\s*=\s*\{[\s\S]*classifySetNxResult[\s\S]*recordDedupOutcome[\s\S]*\}/,
      'shared helper must export the SETNX classifier and outcome recorder',
    );
    assert.match(
      relaySrc,
      /classifySetNxResult[\s\S]*recordDedupOutcome/,
      'notification-relay.cjs must use the shared SETNX classifier and outcome recorder',
    );
    assert.match(
      aisRelaySrc,
      /classifySetNxResult[\s\S]*recordDedupOutcome/,
      'ais-relay.cjs must use the shared SETNX classifier and outcome recorder',
    );
    assert.match(
      seedAviationSrc,
      /classifySetNxResult[\s\S]*recordDedupOutcome/,
      'seed-aviation.mjs must use the shared SETNX classifier and outcome recorder',
    );
    assert.match(
      regionalAlertEmitterSrc,
      /classifySetNxResult[\s\S]*recordDedupOutcome/,
      'regional alert emitter must use the shared SETNX classifier and outcome recorder',
    );
  });

  it('ais-relay exposes SETNX error counters in /metrics rollups', () => {
    assert.match(
      aisRelaySrc,
      /notificationDedupSetNxErrors:\s*0/,
      'rolling metrics bucket must count notification SETNX errors',
    );
    assert.match(
      aisRelaySrc,
      /notifications:\s*\{[\s\S]*dedupSetNxErrors[\s\S]*dedupSetNxFailOpen[\s\S]*dedupSetNxFailClosed[\s\S]*\}/,
      '/metrics output must expose notification SETNX error counters',
    );
  });
});

describe('ais-relay publishNotificationEvent — Slot B publisher dedup', () => {
  it('publisher dedup key uses coalesceKey when set, else falls back to title', () => {
    assert.match(
      aisRelaySrc,
      /const dedupMaterial = buildDedupMaterial\(eventType,\s*payload\?\.title,\s*payload\?\.coalesceKey\)/,
      'publishNotificationEvent must derive dedupMaterial via the shared buildDedupMaterial helper',
    );
  });
});

describe('market alert producer — asset-family coalesce key', () => {
  it('defines a stable market alert coalesce helper', () => {
    assert.match(
      aisRelaySrc,
      /function marketAlertCoalesceKey\(assetClass,\s*identifier,\s*direction,\s*severity\)/,
      'market alerts must build hidden family keys rather than deduping on the rounded subject',
    );
    assert.match(
      aisRelaySrc,
      /return `market:\$\{assetClass\}:\$\{stableIdentifier\}:\$\{direction\}:\$\{severity\}`/,
      'market coalesce key must separate asset class, instrument, direction, and severity band',
    );
    // Lock the normalization line itself so a source change (dropping the
    // 'unknown' fallback or the trim/lowercase) is caught — the behavioral test
    // below re-derives this logic inline, so without this assertion the two
    // could drift together silently. PR #4985 review finding #4.
    assert.match(
      aisRelaySrc,
      /const stableIdentifier = String\(identifier \|\| 'unknown'\)\.trim\(\)\.toLowerCase\(\)/,
      'market coalesce key must normalize identifier: fallback to unknown, then trim + lowercase',
    );
  });

  it('all market_alert publishers pass coalesceKey through the payload', () => {
    const marketBlocks = [...aisRelaySrc.matchAll(/eventType:\s*'market_alert'[\s\S]*?dedupTtl:\s*3600,/g)].map(m => m[0]);
    assert.equal(marketBlocks.length, 3, 'expected equity, commodity, and crypto market_alert producers');
    for (const block of marketBlocks) {
      assert.match(
        block,
        /coalesceKey:\s*marketAlertCoalesceKey\(/,
        `market_alert block must pass coalesceKey:\n${block}`,
      );
    }
  });

  it('rounded percent changes within the same critical commodity surge collapse to one family', () => {
    const coalesce = (assetClass, identifier, direction, severity) =>
      `market:${assetClass}:${String(identifier || 'unknown').trim().toLowerCase()}:${direction}:${severity}`;
    const coffee11 = coalesce('commodity', 'KC=F', 'surge', 'critical');
    const coffee13 = coalesce('commodity', 'KC=F', 'surge', 'critical');
    assert.equal(coffee11, coffee13, 'Coffee +11% and +13% critical surge must share one dedup family');
    assert.notEqual(
      coffee11,
      coalesce('commodity', 'KC=F', 'surge', 'high'),
      'a high-to-critical threshold crossing may notify as a severity upgrade',
    );
  });
});

describe('seed-aviation publishNotificationEvent — Slot B publisher dedup', () => {
  it('publisher dedup key uses coalesceKey when set, else falls back to title', () => {
    assert.match(
      seedAviationSrc,
      /const dedupMaterial = buildDedupMaterial\(eventType,\s*payload\?\.title,\s*payload\?\.coalesceKey\)/,
      'seed-aviation publishNotificationEvent must derive dedupMaterial via the shared buildDedupMaterial helper',
    );
  });

  it('aviation and NOTAM notification payloads include coalesceKey', () => {
    assert.match(
      seedAviationSrc,
      /coalesceKey:\s*`aviation:closure:\$\{a\.iata\}:\$\{severity\}`/,
      'airport disruption notifications must coalesce by airport + severity band so a MAJOR->SEVERE escalation re-notifies',
    );
    assert.match(
      seedAviationSrc,
      /coalesceKey:\s*`notam:closure:\$\{icao\}`/,
      'NOTAM closure notifications must coalesce by ICAO closure family',
    );
  });

  it('aviation prev-state diff keys on airport + severity so escalations survive the upstream filter', () => {
    // P1 (PR #4985 review): the coalesce key is severity-aware, but the upstream
    // prevSet diff must use the SAME identity — else a MAJOR->SEVERE escalation
    // for an already-alerted airport is filtered by !prevSet.has(a.iata) BEFORE
    // the severity-aware coalesce key is ever reached, so the escalation never
    // publishes.
    assert.match(
      seedAviationSrc,
      /const aviationAlertKey = a => `\$\{a\.iata\}:\$\{aviationSeverityBand\(a\)\}`/,
      'aviation must build an airport+severity identity matching the coalesce key',
    );
    assert.match(
      seedAviationSrc,
      /const newAlerts = severeAlerts\.filter\(a => a\.iata && !prevSet\.has\(aviationAlertKey\(a\)\)\)/,
      'newAlerts must diff by airport+severity identity, not iata alone',
    );
    assert.match(
      seedAviationSrc,
      /new Set\(severeAlerts\.filter\(a => a\.iata\)\.map\(aviationAlertKey\)\)/,
      'persisted prev-state must store the same airport+severity identity for next tick',
    );
    assert.doesNotMatch(
      seedAviationSrc,
      /!prevSet\.has\(a\.iata\)\)/,
      'the airport-only prevSet filter (which drops escalations) must be gone',
    );
  });
});

describe('ais-relay deriveWeatherCoalesceKey — VTEC parser', () => {
  // Mini re-implementation that mirrors the source. If the parser shape changes,
  // both this test fixture and the source need updating in lockstep.
  function deriveWeatherCoalesceKey(vtec) {
    if (typeof vtec !== 'string') return undefined;
    const m = vtec.match(/\/[OTEX]\.[A-Z]+\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
    if (!m) return undefined;
    return `nws:${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  }

  it('parses a typical NEW Severe Thunderstorm Warning VTEC into a stable family key', () => {
    const vtec = '/O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/';
    assert.equal(deriveWeatherCoalesceKey(vtec), 'nws:KSGF.SV.W.0034');
  });

  it('two adjacent-zone alerts (same office/phenom/eventID, different action) collapse to the same key', () => {
    // Same storm, NEW for one zone and CON (continued) for another zone an hour later.
    // Both should produce the SAME coalesce key — that's the entire point.
    const vtecNew = '/O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/';
    const vtecCon = '/O.CON.KSGF.SV.W.0034.250427T1330Z-250427T1430Z/';
    assert.equal(deriveWeatherCoalesceKey(vtecNew), deriveWeatherCoalesceKey(vtecCon));
  });

  it('different event tracking numbers stay distinct', () => {
    // Two completely different storms from the same office should NOT collapse.
    const stormA = '/O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/';
    const stormB = '/O.NEW.KSGF.SV.W.0099.250427T1500Z-250427T1600Z/';
    assert.notEqual(deriveWeatherCoalesceKey(stormA), deriveWeatherCoalesceKey(stormB));
  });

  it('different phenomena stay distinct (tornado vs severe-thunderstorm with same eventID)', () => {
    const tornado = '/O.NEW.KSGF.TO.W.0034.250427T1257Z-250427T1330Z/';
    const tstorm = '/O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/';
    assert.notEqual(deriveWeatherCoalesceKey(tornado), deriveWeatherCoalesceKey(tstorm));
  });

  it('returns undefined for missing or malformed VTEC', () => {
    assert.equal(deriveWeatherCoalesceKey(undefined), undefined);
    assert.equal(deriveWeatherCoalesceKey(null), undefined);
    assert.equal(deriveWeatherCoalesceKey(''), undefined);
    assert.equal(deriveWeatherCoalesceKey('not a vtec string'), undefined);
    assert.equal(deriveWeatherCoalesceKey('/X.NEW.KSGF/'), undefined); // truncated
  });
});

describe('ais-relay weather publisher — coalesceKey threading', () => {
  it('captures VTEC from properties.parameters.VTEC[0] in the alert mapping', () => {
    assert.match(
      aisRelaySrc,
      /vtec\s*=\s*Array\.isArray\(p\?\.parameters\?\.VTEC\)\s*\?\s*p\.parameters\.VTEC\[0\]\s*:\s*undefined/,
      'alert mapping must capture VTEC from p.parameters.VTEC[0] when present',
    );
  });

  it('publishNotificationEvent call passes coalesceKey when derivable from VTEC', () => {
    // Spread-conditional: only includes the field when the parser returned a value,
    // so undefined isn't sent over the wire.
    assert.match(
      aisRelaySrc,
      /coalesceKey\s*=\s*deriveWeatherCoalesceKey\(a\.vtec\)/,
      'weather publisher must derive coalesceKey via deriveWeatherCoalesceKey(a.vtec)',
    );
    assert.match(
      aisRelaySrc,
      /\.\.\.\(coalesceKey\s*\?\s*\{\s*coalesceKey\s*\}\s*:\s*\{\}\)/,
      'weather publisher must spread coalesceKey into payload only when defined',
    );
  });

  it('selects 3 DISTINCT families before slicing — distinct families never lost (PR #3467 review P1)', () => {
    // Without this: if the first 3 raw alerts are 3 adjacent zones of one VTEC
    // family, publisher dedup collapses them to 1 notification AND a 4th
    // genuinely-distinct family at index 3+ is never considered. Net silent
    // loss of legit events. Fix: dedupe BY family key FIRST, then take top 3.
    assert.match(
      aisRelaySrc,
      /seenFamilyKeys\s*=\s*new Set\(\)/,
      'publisher must build a Set of seen family keys before publishing',
    );
    assert.match(
      aisRelaySrc,
      /distinctFamilyAlerts/,
      'publisher must accumulate distinct-family alerts (not raw .slice(0, 3))',
    );
    // The naive `for (const a of highSeverityAlerts.slice(0, 3))` ordering is the bug; assert it's gone.
    assert.doesNotMatch(
      aisRelaySrc,
      /for\s*\(const\s+a\s+of\s+highSeverityAlerts\.slice\(0,\s*3\)\)/,
      'publisher must NOT iterate highSeverityAlerts.slice(0, 3) directly — that loses distinct families',
    );
    // Family-key fallback uses a stable per-alert identity (NWS feature.id, then
    // headline/event) so VTEC-less alerts still dedupe against themselves.
    assert.match(
      aisRelaySrc,
      /deriveWeatherCoalesceKey\(a\.vtec\)\s*\n?\s*\?\?\s*`nws:fallback:\$\{a\.id/,
      'family-key fallback must include a stable per-alert identity (id || headline || event)',
    );
  });
});
