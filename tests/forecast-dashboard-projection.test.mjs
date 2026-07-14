import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORECAST_DETAIL_FIELDS,
  compactForecastDashboardPayload,
} from '../scripts/_forecast-dashboard.mjs';
import {
  CANONICAL_KEY,
  DASHBOARD_KEY,
  FORECAST_EXTRA_KEYS,
  buildPublishedSeedPayload,
  patchPublishedForecastsWithSimDecorations,
  __setRedisStoreForTests,
} from '../scripts/seed-forecasts.mjs';
import { __testing__ as healthTesting } from '../api/health.js';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';
import { mergeCachedCaseFiles, needsCaseFileRefetch, shouldFetchCaseFile } from '../src/components/forecast-case-files.ts';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function feed(n = 15) {
  return {
    generatedAt: 1_700_000_000_000,
    predictions: Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      title: `Forecast ${i}`,
      probability: 0.4,
      signals: [{ kind: 'x' }],
      caseFile: {
        // The dossier: ~78% of the real payload.
        branches: Array.from({ length: 20 }, (_, b) => ({ label: `branch ${b}`, prose: 'x'.repeat(200) })),
        actors: Array.from({ length: 15 }, (_, a) => ({ name: `actor ${a}`, prose: 'y'.repeat(200) })),
        baseCase: 'z'.repeat(500),
      },
    })),
  };
}

test('strips the dossier from the dashboard list', () => {
  const full = feed();
  const compact = compactForecastDashboardPayload(full);

  for (const p of compact.predictions) {
    for (const field of FORECAST_DETAIL_FIELDS) {
      assert.equal(p[field], undefined, `${field} must not ride in the dashboard list`);
    }
  }
  assert.equal(compact.detailStripped, full.predictions.length);
});

// The whole point. caseFile is 78% of the real 188 KB key: ~19,000 words of prose
// shipped to every visitor, downloaded on every page load, and parsed into hidden
// DOM inside the LCP window — for content almost nobody expands (#5300).
test('the dashboard list is a fraction of the full feed', () => {
  const full = feed();
  const fullBytes = JSON.stringify(full).length;
  const compactBytes = JSON.stringify(compactForecastDashboardPayload(full)).length;

  assert.ok(
    compactBytes < fullBytes / 3,
    `dashboard list should be well under a third of the feed (full ${fullBytes} B, list ${compactBytes} B)`,
  );
});

test('everything the list view renders survives', () => {
  const full = feed();
  const compact = compactForecastDashboardPayload(full);

  assert.equal(compact.generatedAt, full.generatedAt);
  assert.equal(compact.predictions.length, full.predictions.length);
  for (const [i, p] of compact.predictions.entries()) {
    assert.equal(p.id, full.predictions[i].id);
    assert.equal(p.title, full.predictions[i].title);
    assert.equal(p.probability, full.predictions[i].probability);
    assert.deepEqual(p.signals, full.predictions[i].signals);
  }
});

test('flags that a dossier exists so the panel can lazily fetch it', () => {
  const compact = compactForecastDashboardPayload(feed(2));
  assert.ok(compact.predictions.every((p) => p.hasCaseFile === true));

  // A prediction that genuinely has no dossier is untouched and unflagged.
  const none = compactForecastDashboardPayload({ predictions: [{ id: 'a', title: 't' }] });
  assert.equal(none.predictions[0].hasCaseFile, undefined);
  assert.equal(none.detailStripped, 0);
});

test('tolerates malformed payloads rather than publishing garbage', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { predictions: 'not-an-array' }]) {
    assert.equal(compactForecastDashboardPayload(bad), bad);
  }
});

// The refresh is the expensive half. getHydratedData() is one-shot, so every 30-minute
// tick fell through to this RPC — and it had no CDN shield: ~17.5k uncached origin reads
// per day of a 188 KB payload. Shield the ONE unfiltered shape the dashboard sends.
test('the unfiltered forecast feed has a CDN-shielded public shape', () => {
  const base = 'https://api.worldmonitor.app/api/forecast/v1/get-forecasts';

  assert.equal(isPublicSharedRpcRequest(`${base}?public=1`, 'GET'), true);
  // Vercel's [rpc].ts router echoes the matched segment into the query (#5285) — the
  // classifier must see through it, or this 401s in production exactly as #5263 did.
  assert.equal(isPublicSharedRpcRequest(`${base}?public=1&rpc=get-forecasts`, 'GET'), true);

  // Not a bypass vector, and not widened:
  assert.equal(isPublicSharedRpcRequest(`${base}?public=1&rpc=bogus`, 'GET'), false);
  assert.equal(isPublicSharedRpcRequest(`${base}?domain=energy&public=1`, 'GET'), false, 'a filtered feed is caller-varying — it must stay credentialed');
  assert.equal(isPublicSharedRpcRequest(`${base}?region=eu&public=1`, 'GET'), false);
  assert.equal(isPublicSharedRpcRequest(base, 'GET'), false, 'no marker, no public path');
  assert.equal(isPublicSharedRpcRequest(`${base}?public=1`, 'POST'), false);
});

test('health monitors the dashboard list the fast tier actually serves', () => {
  const { BOOTSTRAP_KEYS, SEED_META } = healthTesting;

  assert.equal(BOOTSTRAP_KEYS.forecastsBootstrap, 'forecast:predictions-bootstrap:v1');
  assert.equal(SEED_META.forecastsBootstrap.key, 'seed-meta:forecast:predictions-bootstrap');
  // The canonical key stays monitored: it still feeds the RPC, MCP and chat-analyst.
  assert.equal(BOOTSTRAP_KEYS.forecasts, 'forecast:predictions:v2');
});

test('a not-yet-published dashboard list warns, it does not CRIT', () => {
  // Absent for one cron interval after deploy. EMPTY scores as crit and would flip
  // /api/health to DEGRADED on a false alarm — the trap #5263 hit on round two.
  const { classifyKey, BOOTSTRAP_KEYS } = healthTesting;
  const NOW = 1_700_000_000_000;
  const verdict = classifyKey(
    'forecastsBootstrap',
    BOOTSTRAP_KEYS.forecastsBootstrap,
    { allowOnDemand: false },
    {
      keyStrens: new Map([[BOOTSTRAP_KEYS.forecastsBootstrap, 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map(),
      keyMetaErrors: new Map(),
      now: NOW,
    },
  );
  assert.equal(verdict.status, 'STALE_SEED');
});

test('the fast tier hydrates from the dashboard list', () => {
  assert.equal(BOOTSTRAP_CACHE_KEYS.forecasts, 'forecast:predictions-bootstrap:v1');
});

// Regression guard. runSeed writes extraKeys during publish and calls afterPublish
// (where the sim patch runs) afterwards, so the dashboard list is written BEFORE the
// decorations exist. The panel's LIST ROWS render all three sim fields — the sim bar,
// the sim chip, and the demoted row-dimming — so patching only the canonical key left
// the panel showing pre-patch simulation state: exactly the bug the patch was written
// to prevent, one key over.
test('simulation decorations reach BOTH published keys, not just the canonical one', async () => {
  const GENERATED_AT = 1_700_000_000_000;
  const prediction = () => ({
    id: 'f1',
    title: 'Forecast 1',
    simulationAdjustment: 0,
    simPathConfidence: 0,
    demotedBySimulation: false,
  });
  const store = {
    [CANONICAL_KEY]: { generatedAt: GENERATED_AT, predictions: [{ ...prediction(), caseFile: { baseCase: 'prose' } }] },
    [DASHBOARD_KEY]: { generatedAt: GENERATED_AT, predictions: [prediction()] },
  };
  const decorations = {
    f1: { simulationAdjustment: -0.12, simPathConfidence: 0.8, demotedBySimulation: true },
  };

  __setRedisStoreForTests(store);
  try {
    await patchPublishedForecastsWithSimDecorations(decorations, GENERATED_AT);
  } finally {
    __setRedisStoreForTests(null);
  }

  for (const key of [CANONICAL_KEY, DASHBOARD_KEY]) {
    const patched = store[key].predictions[0];
    assert.equal(patched.simulationAdjustment, -0.12, `${key}: sim bar reads this`);
    assert.equal(patched.simPathConfidence, 0.8, `${key}: sim chip reads this`);
    assert.equal(patched.demotedBySimulation, true, `${key}: row-dimming reads this`);
  }
  // The projection stays a projection: patching must not smuggle the dossier back in.
  assert.equal(store[DASHBOARD_KEY].predictions[0].caseFile, undefined);
});

test('a failed canonical patch does not skip the dashboard projection patch', async () => {
  const GENERATED_AT = 1_700_000_000_000;
  const prediction = () => ({ id: 'f1', simulationAdjustment: 0, simPathConfidence: 0, demotedBySimulation: false });
  const store = {
    [CANONICAL_KEY]: { generatedAt: GENERATED_AT, predictions: [prediction()] },
    [DASHBOARD_KEY]: { generatedAt: GENERATED_AT, predictions: [prediction()] },
  };

  __setRedisStoreForTests(store, { failPatchKeys: [CANONICAL_KEY] });
  try {
    await patchPublishedForecastsWithSimDecorations({
      f1: { simulationAdjustment: -0.12, simPathConfidence: 0.8, demotedBySimulation: true },
    }, GENERATED_AT);
  } finally {
    __setRedisStoreForTests(null);
  }

  assert.equal(store[CANONICAL_KEY].predictions[0].simulationAdjustment, 0, 'the injected canonical failure leaves its key untouched');
  assert.equal(store[DASHBOARD_KEY].predictions[0].simulationAdjustment, -0.12, 'the dashboard key is patched independently');
});

// ─── The 11.5 MB incident ──────────────────────────────────────────────────────
// runSeed feeds `publishTransform(data)` to the CANONICAL key but feeds RAW `data`
// to every extraKey transform (scripts/_seed-utils.mjs: `publishData` at the canonical
// write vs `ekData` in the extraKeys loop). For seed-forecasts, raw `data` is the full
// internal pipeline state — fullRunPredictions, inputs, publishSelectionPool,
// situationClusters, stateUnits, telemetry — and the original transform SPREAD it
// (`{...payload}`), stripping only caseFile. It published an 11.5 MB dashboard key:
// 66x LARGER than the 172 KB canonical key it was supposed to compact, with every
// bootstrap origin miss pulling all of it.
//
// These exercise the REAL transform the seeder registers, not a reimplementation.

/** A seeder `data` object shaped like the real one: a small list buried in a big trace. */
function rawPipelineData() {
  const bulk = (n) => Array.from({ length: n }, (_, i) => ({ i, blob: 'x'.repeat(400) }));
  return {
    generatedAt: 1_700_000_000_000,
    predictions: [
      { id: 'f1', title: 'Forecast 1', probability: 0.4, caseFile: { baseCase: 'prose'.repeat(50) } },
      { id: 'f2', title: 'Forecast 2', probability: 0.6, caseFile: { baseCase: 'prose'.repeat(50) } },
    ],
    // Everything below is internal trace that must NEVER reach the dashboard key.
    fullRunPredictions: bulk(60),
    inputs: bulk(40),
    publishSelectionPool: bulk(40),
    situationClusters: bulk(30),
    situationFamilies: bulk(30),
    stateUnits: bulk(30),
    fullRunSituationClusters: bulk(30),
    fullRunSituationFamilies: bulk(30),
    fullRunStateUnits: bulk(30),
    enrichmentMeta: bulk(20),
    publishTelemetry: bulk(20),
    selectionWorldSignals: bulk(20),
    selectionMarketTransmission: bulk(20),
  };
}

const dashboardExtraKey = () => {
  const entry = FORECAST_EXTRA_KEYS.find((ek) => ek.key === DASHBOARD_KEY);
  assert.ok(entry, 'seed-forecasts must register the dashboard key as an extra key');
  return entry;
};

test('the dashboard key never carries the seeder internal pipeline trace', () => {
  const raw = rawPipelineData();
  const published = dashboardExtraKey().transform(raw);

  for (const leaked of [
    'fullRunPredictions', 'inputs', 'publishSelectionPool', 'situationClusters',
    'situationFamilies', 'stateUnits', 'fullRunSituationClusters', 'fullRunSituationFamilies',
    'fullRunStateUnits', 'enrichmentMeta', 'publishTelemetry', 'selectionWorldSignals',
    'selectionMarketTransmission',
  ]) {
    assert.equal(published[leaked], undefined, `${leaked} must not reach the dashboard key`);
  }
});

test('the dashboard key is SMALLER than the canonical key it compacts', () => {
  // The invariant that was violated in production: 11.5 MB vs 172 KB. A projection
  // that is bigger than its source is not a projection.
  const raw = rawPipelineData();
  const canonical = buildPublishedSeedPayload(raw);
  const dashboard = dashboardExtraKey().transform(raw);

  const canonicalBytes = JSON.stringify(canonical).length;
  const dashboardBytes = JSON.stringify(dashboard).length;
  assert.ok(
    dashboardBytes < canonicalBytes,
    `dashboard key (${dashboardBytes} B) must be smaller than canonical (${canonicalBytes} B)`,
  );
  // And drastically smaller than the raw pipeline object it is transformed FROM.
  assert.ok(dashboardBytes * 10 < JSON.stringify(raw).length);
});

test('the dashboard key holds no top-level field the canonical key lacks', () => {
  const raw = rawPipelineData();
  const canonicalKeys = new Set(Object.keys(buildPublishedSeedPayload(raw)));
  canonicalKeys.add('detailStripped'); // the one marker the projection adds

  for (const key of Object.keys(dashboardExtraKey().transform(raw))) {
    assert.ok(canonicalKeys.has(key), `dashboard key must not introduce top-level '${key}'`);
  }
});

// ─── Panel lifecycle across refresh ticks ──────────────────────────────────────
// Lazy-loading the dossiers makes the panel stateful, and the state only misbehaves
// ~30 minutes in — when a refresh tick re-hydrates from the bootstrap feed. These
// guard the three ways that goes wrong.

test('a refresh tick does not wipe the dossier the user has open', () => {
  // The tick re-hydrates from the bootstrap feed, which carries NO caseFile. Without
  // the merge, this.forecasts loses the dossier, the pane re-renders empty, and the
  // fetch latch is already spent — so it never comes back.
  const cached = new Map([['f1', { baseCase: 'prose' }]]);
  const refreshed = [{ id: 'f1', title: 'Forecast 1' }, { id: 'f2', title: 'Forecast 2' }];

  const merged = mergeCachedCaseFiles(refreshed, cached);
  assert.deepEqual(merged[0].caseFile, { baseCase: 'prose' }, 'the open dossier survives the tick');
  assert.equal(merged[1].caseFile, undefined, 'a forecast we never fetched stays bare');
});

test('a server-sent dossier always wins over the cached one', () => {
  const cached = new Map([['f1', { baseCase: 'stale' }]]);
  const merged = mergeCachedCaseFiles([{ id: 'f1', caseFile: { baseCase: 'fresh' } }], cached);
  assert.deepEqual(merged[0].caseFile, { baseCase: 'fresh' });
});

test('nothing cached means nothing to merge', () => {
  const forecasts = [{ id: 'f1' }];
  assert.equal(mergeCachedCaseFiles(forecasts, new Map()), forecasts, 'pre-fetch path allocates nothing');
});

test('a forecast that no completed fetch covered re-arms the fetch', () => {
  // Otherwise its expand resolves instantly against the spent promise → pane empty forever.
  const fetched = new Set(['f1']);
  assert.equal(needsCaseFileRefetch([{ id: 'f1' }, { id: 'f2' }], fetched, true), true);
});

test('a forecast with genuinely no dossier does NOT re-arm the fetch', () => {
  // It has no caseFile and never will — but the fetch DID cover it. Keying off the
  // missing caseFile instead of the covered-id set would refetch the entire 188 KB
  // feed on every single click of that pane.
  const fetched = new Set(['f1', 'f2']);
  assert.equal(needsCaseFileRefetch([{ id: 'f1' }, { id: 'f2' }], fetched, true), false);
});

test('only a stripped row marked with hasCaseFile triggers the dossier fetch', () => {
  assert.equal(shouldFetchCaseFile({ id: 'f1', hasCaseFile: true }, true, true), true);
  assert.equal(shouldFetchCaseFile({ id: 'f1' }, true, true), false, 'a forecast without a dossier must not load the full feed');
  assert.equal(shouldFetchCaseFile({ id: 'f1', hasCaseFile: true }, false, true), false);
  assert.equal(shouldFetchCaseFile({ id: 'f1', hasCaseFile: true }, true, false), false);
});

test('a refresh mid-fetch never cancels the in-flight one', () => {
  // settled=false: the fetch is still running and has not populated the covered-id set
  // yet, so every id looks uncovered. Re-arming here would just duplicate the fetch.
  assert.equal(needsCaseFileRefetch([{ id: 'f1' }], new Set(), false), false);
});

// The panel's primary source needs the canonical key's durability. The other extra
// keys use 2h; at 2h, two missed hourly crons expire this one and the panel goes
// blank — the canonical it used to read (6h) would have survived. 6h also outlives
// the 90min seed-meta staleness gate, so a stopped writer surfaces as STALE_SEED
// instead of the key vanishing into EMPTY (the #5309 class of bug).
test('the dashboard list outlives a missed cron and its own staleness gate', () => {
  const seeder = readFileSync(join(root, 'scripts', 'seed-forecasts.mjs'), 'utf-8');
  const entry = seeder.slice(seeder.indexOf('export const FORECAST_EXTRA_KEYS'));
  const dashboardEntry = entry.slice(entry.indexOf('key: DASHBOARD_KEY'), entry.indexOf('key: PRIOR_KEY'));
  assert.match(dashboardEntry, /ttl:\s*TTL_SECONDS/, 'dashboard list must inherit the canonical 6h TTL');

  const ttlSeconds = Number(seeder.match(/const TTL_SECONDS = (\d+)/)[1]);
  const maxStaleMin = healthTesting.SEED_META.forecastsBootstrap.maxStaleMin;
  assert.ok(
    ttlSeconds > maxStaleMin * 60,
    `TTL (${ttlSeconds}s) must outlive the staleness gate (${maxStaleMin}min) or health reports EMPTY instead of STALE_SEED`,
  );
});
