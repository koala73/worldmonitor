/**
 * Regression tests for #5359: CRITICAL alerts bypassed the Country Scope
 * filter across three publisher categories. A user scoped to Eastern Europe
 * (CZ, LV, LT, EE, PL, UA, XK, RS, BY, RU) received:
 *
 *   1. aviation_closure — GRU São Paulo / HKG Hong Kong / KUL Kuala Lumpur /
 *      CAN Guangzhou. The publisher (scripts/seed-aviation.mjs) attached NO
 *      country attribution even though the airport registry carries country
 *      names, so the relay treated the events as unattributed-permissive.
 *   2. market_alert — VIX surge. Market events are inherently global and were
 *      not in UNATTRIBUTED_GLOBAL_EVENT_TYPES, so they leaked to scoped rules.
 *   3. conflict_escalation — UCDP Sudan. The publisher DID look up a
 *      countryCode, but scripts/shared/country-name-to-iso2.cjs was a
 *      12-entry stub (Gulf + US/UK aliases): countryNameToIso2('Sudan')
 *      returned null, the attribution was dropped at publish time, and the
 *      relay fell into the same unattributed-permissive branch.
 *
 * These tests exercise the REAL eventMatchesCountryScope exported by
 * scripts/notification-relay.cjs (not a mirror) and the REAL shared
 * country-name normalizer, so a revert of any of the three fixes goes red.
 *
 * Run: npx tsx --test tests/notification-relay-country-scope-5359.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Stub env vars BEFORE requiring the relay module so the top-of-file
// validation block does not call process.exit(1).
process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.RELAY_SHARED_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

// The relay's runtime deps (`resend`, `convex/browser`) live in
// scripts/package.json and are only installed in the Railway container —
// stub them at the loader level (same pattern as
// tests/notification-relay-telegram-retry.test.mjs).
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const { countryNameToIso2 } = require('../scripts/shared/country-name-to-iso2.cjs');

let eventMatchesCountryScope;

before(() => {
  // The relay only starts its poll loop when require.main === module, so
  // requiring it from a test is a side-effect-free import.
  ({ eventMatchesCountryScope } = require(
    resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  ));
  assert.equal(
    typeof eventMatchesCountryScope,
    'function',
    'eventMatchesCountryScope export missing from notification-relay.cjs',
  );
});

// The reporter's exact configured scope.
const EASTERN_EUROPE_RULE = {
  countries: ['CZ', 'LV', 'LT', 'EE', 'PL', 'UA', 'XK', 'RS', 'BY', 'RU'],
  sensitivity: 'critical',
};

describe('#5359 — shared country-name map covers publisher-attributed names', () => {
  it('resolves the UCDP names from the report (previously null → attribution dropped)', () => {
    assert.equal(countryNameToIso2('Sudan'), 'SD');
    assert.equal(countryNameToIso2('South Sudan'), 'SS');
  });

  it('resolves the aviation registry country names for the reported airports', () => {
    assert.equal(countryNameToIso2('Brazil'), 'BR');    // GRU
    assert.equal(countryNameToIso2('China'), 'CN');     // HKG, CAN
    assert.equal(countryNameToIso2('Malaysia'), 'MY');  // KUL
  });

  it('resolves UCDP historical-parenthetical and hyphenated forms', () => {
    assert.equal(countryNameToIso2('Yemen (North Yemen)'), 'YE');
    assert.equal(countryNameToIso2('Myanmar (Burma)'), 'MM');
    assert.equal(countryNameToIso2('Russia (Soviet Union)'), 'RU');
    assert.equal(countryNameToIso2('Cambodia (Kampuchea)'), 'KH');
    assert.equal(countryNameToIso2('Bosnia-Herzegovina'), 'BA');
    assert.equal(countryNameToIso2("Côte d'Ivoire"), 'CI');
    assert.equal(countryNameToIso2('DR Congo (Zaire)'), 'CD');
  });

  it('keeps the pre-existing alias + ISO2 passthrough semantics', () => {
    assert.equal(countryNameToIso2('UK'), 'GB');            // alias beats ISO2 passthrough
    assert.equal(countryNameToIso2('USA'), 'US');
    assert.equal(countryNameToIso2('United Arab Emirates'), 'AE');
    assert.equal(countryNameToIso2('us'), 'US');            // ISO2 passthrough
    assert.equal(countryNameToIso2(''), null);
    assert.equal(countryNameToIso2('   '), null);
    assert.equal(countryNameToIso2('Atlantis Federation'), null);
  });
});

describe('#5359 — real eventMatchesCountryScope drops out-of-scope domain events', () => {
  it('aviation_closure GRU with countryCode BR → dropped for the Eastern-Europe rule', () => {
    const event = {
      eventType: 'aviation_closure',
      severity: 'critical',
      payload: {
        title: 'GRU (São Paulo): Airport closure / airspace restrictions',
        source: 'AviationStack',
        countryCode: 'BR',
      },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
    // A Brazil-scoped rule still receives it.
    assert.equal(eventMatchesCountryScope(event, { countries: ['BR'] }), true);
  });

  it('aviation_closure with MISSING attribution (publisher bug) → dropped, not leaked', () => {
    const event = {
      eventType: 'aviation_closure',
      severity: 'critical',
      payload: { title: 'HKG (Hong Kong): 87% flights cancelled', source: 'AviationStack' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('notam_closure with MISSING attribution → dropped for scoped rules', () => {
    const event = {
      eventType: 'notam_closure',
      severity: 'high',
      payload: { title: 'NOTAM: VHHH — Airport closure', source: 'ICAO NOTAM' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('market_alert (VIX surge, global) → dropped for scoped rules, kept for unscoped', () => {
    const event = {
      eventType: 'market_alert',
      severity: 'critical',
      payload: { title: 'VIX Volatility: +32% surge', source: 'Commodity Market' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
    assert.equal(eventMatchesCountryScope(event, { countries: [] }), true);
    assert.equal(eventMatchesCountryScope(event, {}), true);
  });

  it('conflict_escalation Sudan with resolved countryCode SD → dropped for Eastern-Europe scope', () => {
    const event = {
      eventType: 'conflict_escalation',
      severity: 'critical',
      payload: {
        title: 'Sudan: SFA vs Civilians — 76 casualties',
        source: 'UCDP',
        countryCode: countryNameToIso2('Sudan'),
      },
    };
    // Pre-fix, countryNameToIso2('Sudan') was null and the publisher omitted
    // countryCode entirely; the permissive branch then delivered it.
    assert.equal(event.payload.countryCode, 'SD');
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('conflict_escalation with UNRESOLVABLE country name → dropped, not leaked', () => {
    const event = {
      eventType: 'conflict_escalation',
      severity: 'critical',
      payload: { title: 'Unknown: A vs B — 20 casualties', source: 'UCDP' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('conflict_escalation Ukraine → still delivered to the Eastern-Europe rule', () => {
    const event = {
      eventType: 'conflict_escalation',
      severity: 'critical',
      payload: {
        title: 'Ukraine: forces — 40 casualties',
        source: 'UCDP',
        countryCode: 'UA',
      },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), true);
  });

  it('cyber_threat with no attribution → dropped for scoped rules', () => {
    const event = {
      eventType: 'cyber_threat',
      severity: 'critical',
      payload: { title: 'c2 server: 203.0.113.7 (QakBot)', source: 'feodo' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('rss_alert without attribution stays permissive (documented news semantics)', () => {
    const event = {
      eventType: 'rss_alert',
      severity: 'critical',
      payload: { title: 'Breaking: something keyword-relevant', source: 'rss' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), true);
  });
});

describe('#5359 — aviation publisher attaches countryCode (source-grep contract)', () => {
  const aviationSrc = readFileSync(
    resolve(__dirname, '..', 'scripts', 'seed-aviation.mjs'),
    'utf-8',
  );

  it('aviation_closure and notam_closure publish normalized countryCode', () => {
    assert.match(
      aviationSrc,
      /eventType:\s*'aviation_closure'[\s\S]{0,600}?countryCode/,
      'aviation_closure must include countryCode in its payload',
    );
    assert.match(
      aviationSrc,
      /eventType:\s*'notam_closure'[\s\S]{0,600}?countryCode/,
      'notam_closure must include countryCode in its payload',
    );
    assert.match(
      aviationSrc,
      /require\(['"]\.\/shared\/country-name-to-iso2\.cjs['"]\)|from\s+['"]\.\/shared\/country-name-to-iso2\.cjs['"]/,
      'seed-aviation must normalize through the shared country-name map',
    );
  });
});

describe('#5359 — browser-submitted origins stay deliverable to scoped users (allowlist contract)', () => {
  // Fail-closed default means a NEW browser origin added without country
  // attribution silently disappears for country-scoped users. This contract
  // makes that a red test instead: every origin in the BreakingAlert union
  // must either be in the relay's permissive allowlist or have countryCode
  // attached at its dispatch site.
  const alertsSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'services', 'breaking-news-alerts.ts'),
    'utf-8',
  );
  const relaySrc = readFileSync(
    resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
    'utf-8',
  );

  it('every BreakingAlert origin is allowlisted or attributed', () => {
    const unionMatch = alertsSrc.match(/origin:\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+');/);
    assert.ok(unionMatch, 'BreakingAlert origin union not found in breaking-news-alerts.ts');
    const origins = [...unionMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(origins.length >= 5, `expected ≥5 origins, parsed: ${origins.join(',')}`);

    const allowlistMatch = relaySrc.match(/PERMISSIVE_UNATTRIBUTED_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(allowlistMatch, 'PERMISSIVE_UNATTRIBUTED_EVENT_TYPES not found in relay');
    const allowlist = new Set([...allowlistMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

    for (const origin of origins) {
      if (allowlist.has(origin)) continue;
      // Not allowlisted → its dispatch object literal must carry countryCode
      // (e.g. oref_siren sets IL). Scan the object literal around the origin.
      const dispatchRe = new RegExp(`origin:\\s*'${origin}'[^}]*countryCode|countryCode[^}]*origin:\\s*'${origin}'`);
      assert.match(
        alertsSrc,
        dispatchRe,
        `browser origin '${origin}' is neither in PERMISSIVE_UNATTRIBUTED_EVENT_TYPES nor dispatched with countryCode — ` +
        'country-scoped users would silently never receive it. Either attach countryCode at the dispatch site ' +
        'or add it to the allowlist in scripts/notification-relay.cjs with a justification comment.',
      );
    }
  });
});

describe('#5359 — duplicate shared copies must stay byte-identical', () => {
  // scripts/shared/ and root shared/ both carry the country helper + data
  // (the relay container COPYs scripts/shared/; edge/server code reads root
  // shared/). Divergence would mean the relay and the rest of the platform
  // normalize the same country name differently.
  for (const file of ['country-name-to-iso2.cjs', 'country-names.json']) {
    it(`scripts/shared/${file} === shared/${file}`, () => {
      const a = readFileSync(resolve(__dirname, '..', 'scripts', 'shared', file), 'utf-8');
      const b = readFileSync(resolve(__dirname, '..', 'shared', file), 'utf-8');
      assert.equal(a, b, `scripts/shared/${file} and shared/${file} have diverged — sync them (they are duplicate copies, not independent files)`);
    });
  }
});

describe('#5359 — aviation registry country names all normalize', () => {
  // A registry row whose country name misses the map publishes unattributed
  // and becomes invisible to scoped users (the seeder warns at runtime; this
  // catches it at PR time instead).
  it('every AIRPORTS country name resolves to ISO2', () => {
    const src = readFileSync(resolve(__dirname, '..', 'scripts', 'seed-aviation.mjs'), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const names = [...new Set([...code.matchAll(/country:\s*'([^']+)'/g)].map((m) => m[1]))];
    assert.ok(names.length >= 50, `expected ≥50 registry country entries, parsed ${names.length}`);
    const misses = names.filter((n) => countryNameToIso2(n) === null);
    assert.deepEqual(misses, [], `aviation registry country names that fail to normalize: ${misses.join(', ')} — add them to shared/country-names.json`);
  });
});

describe('#5359 — region taxonomy parity between emitter and scope matcher', () => {
  it('iso2-to-region.json values ⊆ REGION_IDS; every region except global has members', async () => {
    const { REGION_IDS } = await import('../shared/geography.js');
    const regionMap = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'scripts', 'shared', 'iso2-to-region.json'), 'utf-8'),
    );
    const emitted = new Set(REGION_IDS);
    const mappedValues = new Set(Object.values(regionMap));
    const unknownRegions = [...mappedValues].filter((r) => !emitted.has(r));
    assert.deepEqual(unknownRegions, [], `iso2-to-region.json maps countries to regions the emitter never uses: ${unknownRegions.join(', ')}`);
    const memberless = REGION_IDS.filter((r) => r !== 'global' && !mappedValues.has(r));
    assert.deepEqual(memberless, [], `regions with zero member countries would drop for ALL scoped rules: ${memberless.join(', ')}`);
  });
});

describe('#5359 — regional_* events match through their region membership', () => {
  it('europe-region event reaches a rule scoped to European countries', () => {
    const event = {
      eventType: 'regional_regime_shift',
      severity: 'critical',
      payload: { title: 'Europe: regime pressure → confrontation', region_id: 'europe' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), true);
  });

  it('mena-region event is dropped for an Eastern-Europe-scoped rule', () => {
    const event = {
      eventType: 'regional_corridor_break',
      severity: 'critical',
      payload: { title: 'MENA: corridor degraded — hormuz', region_id: 'mena' },
    };
    assert.equal(eventMatchesCountryScope(event, EASTERN_EUROPE_RULE), false);
  });

  it('regional event with unknown/missing region_id is dropped for scoped rules', () => {
    const noRegion = {
      eventType: 'regional_buffer_failure',
      severity: 'high',
      payload: { title: 'buffer failure' },
    };
    const unknownRegion = {
      eventType: 'regional_trigger_activation',
      severity: 'high',
      payload: { title: 'trigger', region_id: 'atlantis' },
    };
    assert.equal(eventMatchesCountryScope(noRegion, EASTERN_EUROPE_RULE), false);
    assert.equal(eventMatchesCountryScope(unknownRegion, EASTERN_EUROPE_RULE), false);
    // Unscoped rules keep receiving regional events.
    assert.equal(eventMatchesCountryScope(noRegion, { countries: [] }), true);
  });
});
