import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// REGRESSION GUARD: Internet Disruptions sat on "Loading..." for the whole
// session on tech.worldmonitor.app (production sweep, 2026-11-01).
//
// The panel is lazily mounted, and no hydration task was gated on it. Its data
// arrived only as a side effect of two other loaders:
//   - loadIntelligenceSignals, gated on cii / strategic-risk / ucdp-events /
//     ... panels that the tech variant does not have;
//   - loadOutages, run only for the `outages` map layer. Its cached branch
//     returned after updating the map and never reached the panel.
// Both wrote through `ctx.panels['internet-disruptions']?.setOutages(...)`,
// which is a silent no-op while the panel is still a deferred shell.
//
// `DataLoaderManager` cannot be constructed under the plain-Node harness, so the
// call sites are pinned by source slice, as in
// tests/one-shot-loader-panel-delivery.test.mts.

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

describe('internet-disruptions panel hydration', () => {
  it('schedules an outages load when the panel itself is near the viewport', async () => {
    const pass = extractMethod(await readFile(DATA_LOADER, 'utf8'), 'runLoadAllData');
    assert.match(
      pass,
      /if \(shouldLoad\('internet-disruptions'\)\)\s*\{?\s*tasks\.push\(\{ name: '[a-z-]+', task: \(\) => runGuarded\('[a-z-]+', \(\) => this\.loadOutages\(\)\) \}\)/,
      'the panel needs its own hydration task; mounting it re-runs the pass, and that task is what delivers',
    );
  });

  it('delivers cached outages to the panel, not only to the map', async () => {
    const body = extractMethod(await readFile(DATA_LOADER, 'utf8'), 'loadOutages');
    const cachedBranch = body.match(/if \(this\.ctx\.intelligenceCache\.outages\) \{[\s\S]*?\n {4}\}/);
    assert.ok(cachedBranch, 'could not slice the cached branch of loadOutages()');
    assert.match(cachedBranch[0], /this\.deliverOutagesToPanel\(outages\)/,
      'the cached branch runs on every remount after the first fetch, so it must feed the panel');
  });

  for (const method of ['loadOutages', 'loadIntelligenceSignals', 'deliverOutagesToPanel'] as const) {
    it(`never writes to the deferred panel directly in ${method}()`, async () => {
      const body = extractMethod(await readFile(DATA_LOADER, 'utf8'), method);
      assert.doesNotMatch(body, /panels\[\s*'internet-disruptions'\s*\]/,
        'a direct panels[key] call is dropped while the panel is a deferred shell; use this.callPanel()');
    });
  }

  it('lets only the newest delivery commit anomaly and DDoS results', async () => {
    const body = extractMethod(await readFile(DATA_LOADER, 'utf8'), 'deliverOutagesToPanel');
    assert.match(body, /const generation = \+\+this\.outageAuxGeneration;/);
    const guards = body.match(/if \(this\.ctx\.isDestroyed \|\| generation !== this\.outageAuxGeneration\) return;/g) ?? [];
    assert.equal(guards.length, 2, 'both callbacks must drop superseded results and anything resolving after teardown');
  });

  it('queues nothing for the panel after teardown', async () => {
    const source = await readFile(DATA_LOADER, 'utf8');
    const deliver = extractMethod(source, 'deliverOutagesToPanel');
    assert.match(deliver, /^\s*private deliverOutagesToPanel\([^)]*\): void \{\n\s*if \(this\.ctx\.isDestroyed\) return;\n\s*this\.callPanel\('internet-disruptions', 'setOutages'/,
      'teardown clears the shared pendingCalls queue; a later setOutages would replay into the next app instance');
    const loadOutages = extractMethod(source, 'loadOutages');
    assert.match(loadOutages, /catch \(error\) \{\n\s*if \(this\.ctx\.isDestroyed\) return;\n\s*this\.callPanel\('internet-disruptions', 'showError'\)/,
      'the error path must not queue showError after teardown');
  });

  it('refreshes outages on variants without the intelligence refresh', async () => {
    const app = await readFile(new URL('../src/App.ts', import.meta.url), 'utf8');
    const block = app.match(/if \(SITE_VARIANT === 'full'\) \{\s*this\.refreshScheduler\.scheduleRefresh\('intelligence'[\s\S]*?\n {4}\} else \{([\s\S]*?)\n {4}\}/);
    assert.ok(block, 'the intelligence refresh needs an else branch for the other variants');
    assert.match(block[1], /scheduleRefresh\('internet-disruptions'/);
    assert.match(block[1], /delete this\.state\.intelligenceCache\.outages;\s*return this\.dataLoader\.loadOutages\(\);/,
      'loadOutages serves intelligenceCache.outages, so the refresh must drop it first');
    assert.match(block[1], /this\.isPanelNearViewport\('internet-disruptions'\)/);
  });

  it('queues every panel update through callPanel', async () => {
    const body = extractMethod(await readFile(DATA_LOADER, 'utf8'), 'deliverOutagesToPanel');
    for (const method of ['setOutages', 'setAnomalies', 'setDdos']) {
      assert.match(body, new RegExp(`this\\.callPanel\\('internet-disruptions', '${method}',`),
        `${method} must be queued for a panel that mounts later`);
    }
  });
});
