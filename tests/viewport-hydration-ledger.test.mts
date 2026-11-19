import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ViewportHydrationLedger } from '../src/app/viewport-hydration-ledger.ts';

// Scrolling the panel grid fires a viewport loadAllData() pass every frame.
// Measured on a production build against live data: one scroll down and back
// after every panel had loaded still fired 34 API requests (PizzINT x10,
// temporal anomalies x10, ACLED, spending, CBR rates, forecasts, ...), and the
// re-processing pushed scroll frames past 100 ms at 4x CPU throttling.
// The ledger makes a viewport pass load only panels no pass has loaded yet.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DATA_LOADER_TS = readFileSync(resolve(REPO_ROOT, 'src/app/data-loader.ts'), 'utf8');
const APP_TS = readFileSync(resolve(REPO_ROOT, 'src/App.ts'), 'utf8');
const PANEL_LAYOUT_TS = readFileSync(resolve(REPO_ROOT, 'src/app/panel-layout.ts'), 'utf8');

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not locate ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `could not locate ${endMarker}`);
  return source.slice(start, end);
}

describe('ViewportHydrationLedger', () => {
  it('reports in-range panels until a pass marks them served', () => {
    const ledger = new ViewportHydrationLedger();
    const panels = { cii: {}, markets: {}, economic: {} };
    const near = new Set(['cii', 'markets']);
    ledger.beginPass(false);

    assert.deepEqual([...ledger.collectUnserved(panels, (id) => near.has(id))], ['cii', 'markets']);
    ledger.markServed(panels, ['cii', 'markets']);
    assert.equal(ledger.collectUnserved(panels, (id) => near.has(id)).size, 0);

    near.add('economic');
    assert.deepEqual([...ledger.collectUnserved(panels, (id) => near.has(id))], ['economic']);
  });

  it('skips the layout read for panels already served', () => {
    const ledger = new ViewportHydrationLedger();
    const panels = { cii: {}, markets: {} };
    ledger.beginPass(false);
    ledger.markServed(panels, ['cii']);
    const read: string[] = [];
    ledger.collectUnserved(panels, (id) => { read.push(id); return true; });
    assert.deepEqual(read, ['markets']);
  });

  it('treats a remounted panel instance as unloaded', () => {
    const ledger = new ViewportHydrationLedger();
    const panels: Record<string, object> = { crypto: {} };
    ledger.beginPass(false);
    ledger.markServed(panels, ['crypto']);
    assert.equal(ledger.collectUnserved(panels, () => true).size, 0);

    panels.crypto = {};
    assert.deepEqual([...ledger.collectUnserved(panels, () => true)], ['crypto']);
  });

  it('keeps entries across passes with the same context', () => {
    const ledger = new ViewportHydrationLedger();
    const panels = { cii: {} };
    ledger.beginPass(false);
    ledger.markServed(panels, ['cii']);
    assert.equal(ledger.claim('pizzint'), true);

    ledger.beginPass(false);
    assert.equal(ledger.collectUnserved(panels, () => true).size, 0);
    assert.equal(ledger.claim('pizzint'), false);
  });

  it('forgets every entry when the context changes, such as premium access', () => {
    const ledger = new ViewportHydrationLedger();
    const panels = { 'stock-analysis': {} };
    ledger.beginPass(false);
    ledger.markServed(panels, ['stock-analysis']);
    ledger.claim('premium-tail');

    ledger.beginPass(true);
    assert.deepEqual([...ledger.collectUnserved(panels, () => true)], ['stock-analysis']);
    assert.equal(ledger.claim('premium-tail'), true);
  });

  it('lets a served panel load again after the re-hydration window', () => {
    // Loaders swallow their own failures, so a pass cannot tell an empty panel
    // from a loaded one. Expiring the mark lets a failed first load retry on a
    // later scroll while a burst of scrolling still loads each panel once.
    let clock = 0;
    const ledger = new ViewportHydrationLedger({ rehydrateAfterMs: 60_000, now: () => clock });
    const panels = { economic: {} };
    ledger.beginPass(false);
    ledger.markServed(panels, ['economic']);
    clock = 59_999;
    assert.equal(ledger.collectUnserved(panels, () => true).size, 0);
    clock = 60_000;
    assert.deepEqual([...ledger.collectUnserved(panels, () => true)], ['economic']);
  });

  it('ignores ids with no mounted panel', () => {
    const ledger = new ViewportHydrationLedger();
    const panels: Record<string, object | undefined> = { cii: undefined };
    ledger.beginPass(false);
    ledger.markServed(panels, ['cii', 'missing']);
    assert.equal(ledger.collectUnserved(panels, () => true).size, 0);
  });
});

describe('viewport loadAllData wiring', () => {
  const runBody = sliceBetween(DATA_LOADER_TS, 'private async runLoadAllData(', 'async refreshTemporalBaseline(');

  it('a viewport pass returns before any loader when no unloaded panel is in range', () => {
    const collect = runBody.indexOf('this.viewportHydration.collectUnserved(');
    const earlyReturn = runBody.indexOf('if (unserved.size === 0) return;');
    const firstTask = runBody.indexOf('tasks.push(');
    assert.ok(collect >= 0, 'viewport passes must collect unloaded in-range panels');
    assert.ok(earlyReturn > collect && earlyReturn < firstTask, 'the empty viewport pass must return before queuing loaders');
  });

  it('a viewport pass gates loaders on unloaded panels only', () => {
    assert.match(runBody, /const shouldLoad = \(id: string\): boolean => forceAll \|\| \(unserved \? unserved\.has\(id\) : this\.isPanelNearViewport\(id\)\);/);
  });

  it('panel-independent loaders run once, not on every viewport pass', () => {
    assert.match(runBody, /this\.viewportHydration\.claim\('pizzint'\)/);
    assert.match(runBody, /runOncePerViewport\('cii-refresh'/);
    assert.match(runBody, /runOncePerViewport\('premium-briefs'/);
    assert.match(runBody, /runOncePerViewport\('temporal-baseline'/);
  });

  it('a queued full request is never downgraded to a viewport pass', () => {
    const loadAll = sliceBetween(DATA_LOADER_TS, 'async loadAllData(', 'private async runLoadAllData(');
    assert.match(loadAll, /this\.loadAllDataQueuedFullPass = this\.loadAllDataQueuedFullPass \|\| trigger === 'full';/);
    assert.match(loadAll, /const trigger: LoadAllDataTrigger = this\.loadAllDataQueuedFullPass \? 'full' : 'viewport';/);
  });

  it('scroll and panel-entry triggers ask for viewport passes; resize keeps a full pass', () => {
    const handler = sliceBetween(APP_TS, 'private readonly handleViewportPrime = (event?: Event): void => {', 'private readonly handleConnectivityChange');
    assert.match(handler, /event\?\.type === 'resize'/);
    assert.match(handler, /void this\.dataLoader\.loadAllData\(false, trigger\);/);
    const schedule = sliceBetween(PANEL_LAYOUT_TS, 'private scheduleLoadAllData(', 'private observePanelsForViewport(');
    assert.doesNotMatch(schedule, /this\.callbacks\.loadAllData\(\)/);
    assert.equal(schedule.match(/this\.callbacks\.loadAllData\(false, 'viewport'\)/g)?.length, 3);
  });
});
