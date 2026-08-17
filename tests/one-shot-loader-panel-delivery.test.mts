import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { enqueuePanelCall, replayPendingCalls, clearAllPendingCalls } from '../src/app/pending-panel-data.ts';

// REGRESSION GUARD for the "deferred panel keeps its constructor empty state
// forever" class (mobile report, 2026-08-13).
//
// Why only loadNews is guarded here. Every other loader in `loadAllData` is
// re-entrant: `runGuarded` dedupes CONCURRENT runs via `ctx.inFlight` and
// releases in `finally`, so it never remembers a COMPLETED run. Mounting a
// panel calls `afterPanelMounted` → `primeVisiblePanelData()` +
// `scheduleLoadAllData('near')`, and `isPanelNearViewport` reads
// `ctx.panels[key]` (the Panel object, not the shell), so a panel's gate flips
// true exactly when it mounts and its loader re-delivers on that pass. A push
// dropped by an unmounted panel therefore self-heals on the next pass.
//
// `loadNews` is the sole exception: `shouldHydrateNews` skips it once
// `loadedNewsSignature` matches the current work-list. Its deliveries are
// one-shot, so anything it hands to a deferred panel is lost permanently —
// which is exactly how Threat Timeline, AI Insights, and the Monitors results
// area came to sit blank for a whole session. News panels already carry a
// mount-time backfill for this reason (panel-layout.ts, #5376); this test keeps
// the rest of loadNews's fan-out honest.
//
// The queue behaviour is proven behaviourally below; the call sites are pinned
// by source slice because `DataLoaderManager` cannot be constructed under the
// plain-Node harness (Vite-only resolution, ~160-module graph). Same split, and
// same rationale, as tests/hub-activity-hydration.test.mts.

describe('pending panel-call queue', () => {
  it('delivers the newest queued call to a panel that mounts later', async () => {
    clearAllPendingCalls();
    const received: unknown[][] = [];
    const panel = { refresh: (...args: unknown[]) => { received.push(args); } };

    enqueuePanelCall('threat-timeline', 'refresh', [['stale']]);
    enqueuePanelCall('threat-timeline', 'refresh', [['fresh']]);
    await replayPendingCalls('threat-timeline', panel);

    assert.deepEqual(received, [[['fresh']]], 'the latest args must win, and must be delivered exactly once');
  });

  it('does not replay a second time for the same key', async () => {
    clearAllPendingCalls();
    let calls = 0;
    const panel = { refresh: () => { calls++; } };

    enqueuePanelCall('threat-timeline', 'refresh', [[]]);
    await replayPendingCalls('threat-timeline', panel);
    await replayPendingCalls('threat-timeline', panel);

    assert.equal(calls, 1);
  });
});

const DATA_LOADER = new URL('../src/app/data-loader.ts', import.meta.url);

/** Body of a top-level method of `DataLoaderManager`, closing brace included. */
function extractMethod(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^  (?:private |public |protected )?(?:async )?${name}\\s*\\(`).test(l));
  assert.ok(start >= 0, `could not locate ${name}() in data-loader.ts`);
  const end = lines.findIndex((l, i) => i > start && l === '  }');
  assert.ok(end > start, `could not find the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Panel keys allowed to appear as a direct `ctx.panels[key]` lookup inside a
 * one-shot loader, each with the mount-time recovery that makes it safe.
 * Adding a key here is a claim that must be true in panel-layout.ts.
 */
const DIRECT_LOOKUP_ALLOWLIST: Record<string, string> = {
  'geo-hubs': 'GeoHubsPanel pulls ctx.latestClusters in its lazy factory, gated on clustersSettled',
  'tech-hubs': 'TechHubsPanel pulls ctx.latestClusters in its lazy factory (deferred tech-geo chunk, #4404)',
};

describe('one-shot loader panel delivery', () => {
  it('keeps loadNews the only loader with a completion latch', async () => {
    const source = await readFile(DATA_LOADER, 'utf8');

    // runGuarded must stay concurrency-only: an `inFlight` add with a `finally`
    // delete. If it ever remembers completed runs, every loader becomes one-shot
    // and this whole guard is scoped to the wrong method.
    const guarded = source.slice(source.indexOf('const runGuarded ='));
    assert.match(guarded.slice(0, 400), /inFlight\.add\(name\)[\s\S]*?finally\s*\{[\s\S]*?inFlight\.delete\(name\)/,
      'runGuarded must dedupe concurrent runs only — never remember completed ones');

    // The news signature is the one completion latch. If a second field like it
    // appears, its loader's fan-out needs the same treatment as loadNews.
    const latches = [...source.matchAll(/^ {2}private (loaded[A-Za-z]*Signature)\b/gm)].map((m) => m[1]);
    assert.deepEqual(latches, ['loadedNewsSignature'],
      'a new completion latch makes its loader one-shot — extend this guard to cover its panel fan-out');
  });

  for (const method of ['loadNews', 'updateMonitorResults'] as const) {
    it(`routes every panel delivery in ${method}() through callPanel`, async () => {
      const source = await readFile(DATA_LOADER, 'utf8');
      const body = extractMethod(source, method);

      const direct = [...body.matchAll(/panels\[\s*'([a-z0-9-]+)'\s*\]/g)].map((m) => m[1]);
      const offenders = direct.filter((key) => !(key in DIRECT_LOOKUP_ALLOWLIST));

      assert.deepEqual(offenders, [],
        `${method}() runs once per work-list, so a direct panels[key] lookup is lost forever for a `
        + `panel that is still a deferred shell. Route it through this.callPanel(), or add the key to `
        + `DIRECT_LOOKUP_ALLOWLIST with the mount-time pull that makes it safe. Offending: ${offenders.join(', ')}`);
    });
  }

  it('queues the cluster fan-out in both arms of the clustering try/catch', async () => {
    const source = await readFile(DATA_LOADER, 'utf8');
    const loadNews = extractMethod(source, 'loadNews');

    // Slice each arm: a whole-method match passes with the queued call wired
    // into only one of them, and the catch arm is where a regression hides —
    // it runs only when clustering throws.
    const tryArm = loadNews.match(/this\.ctx\.clustersSettled = true;[\s\S]*?hydrateGeoHubPanelFromClusters\(/);
    const catchArm = loadNews.match(/console\.error\('\[App\] Clustering failed[\s\S]*?\n {4}\}/);
    assert.ok(tryArm, 'could not slice the try arm of the clustering pass');
    assert.ok(catchArm, 'could not slice the catch arm of the clustering pass');

    for (const [name, arm] of [['try', tryArm[0]], ['catch', catchArm[0]]] as const) {
      assert.match(arm, /this\.callPanel\('insights', 'updateInsights',/,
        `the ${name} arm must queue the insights fan-out`);
      assert.match(arm, /isPanelInVariantDefaults\('threat-timeline'\)[\s\S]*?this\.callPanel\('threat-timeline', 'refresh',/,
        `the ${name} arm must queue the threat-timeline fan-out, behind the variant-defaults gate`);
    }
  });

  it('keeps the allowlisted panels' + " backed by a real mount-time pull", async () => {
    const layout = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
    for (const key of Object.keys(DIRECT_LOOKUP_ALLOWLIST)) {
      const factory = layout.match(new RegExp(`this\\.lazyImportedPanel\\('${key}'[\\s\\S]*?\\n {4}\\}\\);`));
      assert.ok(factory, `no lazyImportedPanel factory for '${key}' — the allowlist rationale is stale`);
      assert.match(factory[0], /this\.ctx\.latestClusters/,
        `'${key}' is allowlisted because its factory backfills from retained clusters; it no longer does`);
    }
  });
});
